/// <reference lib="webworker" />
import puppeteer, { type Page } from "@cloudflare/puppeteer";
import type { Env } from "../../worker-configuration";

export type PdfArgs = {
  url: string;
  viewport?: { width: number; height: number }; // optional for stability
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; // default "networkidle0"
  timeoutMs?: number; // default 20000
  pdf?: { format?: "A4" | "Letter" | "Legal" | "Tabloid" | "A3" | "A5"; landscape?: boolean; scale?: number };
};

type ToolErrorCode = "BAD_URL" | "NAV_TIMEOUT" | "NAV_FAIL" | "CAPTURE_FAIL" | "UPLOAD_FAIL";

const PDF_TAG = "[pdf]";

export type PdfResult =
  | {
      ok: true;
      kind: "pdf";
      url: string;                 // /files/<sid>/<uuid>.pdf
      r2Key: string;               // files/<sid>/<uuid>.pdf
      contentType: "application/pdf";
      bytes: number;
      sourceUrl: string;
    }
  | {
      ok: false;
      error: string;
      code: "BAD_URL" | "NAV_TIMEOUT" | "NAV_FAIL" | "CAPTURE_FAIL" | "UPLOAD_FAIL";
    };

function normalizeUrl(input: string): URL | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.protocol) throw new Error("no scheme");
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    try {
      const u = new URL(`https://${raw}`);
      if (u.protocol !== "https:") return null;
      return u;
    } catch { return null; }
  }
}

function withWww(u: URL): URL | null {
  try {
    if (!u.hostname.startsWith("www.")) {
      const copy = new URL(u.toString());
      copy.hostname = `www.${u.hostname}`;
      return copy;
    }
    return null;
  } catch { return null; }
}

export async function convertToPdf(
  env: Env,
  sid: string,
  args: PdfArgs,
  emit?: (msg: string) => void
): Promise<PdfResult> {
  const url0 = normalizeUrl(args.url);
  if (!url0) return { ok: false, error: "Invalid URL", code: "BAD_URL" };

  const wantWait = args.waitUntil ?? "networkidle0";
  const timeout = Math.max(1000, Math.min(60000, args.timeoutMs ?? 20000));
  const viewport = args.viewport ?? { width: 1280, height: 800 };
  const pdfOpts = {
    format: args.pdf?.format ?? "A4",
    landscape: args.pdf?.landscape ?? false,
    scale: args.pdf?.scale ?? 1.0,
    printBackground: true,
  } as const;

  console.log(PDF_TAG, "start", {
    sid,
    url: String(args?.url ?? ""),
    viewport,
    waitUntil: wantWait,
    timeoutMs: timeout,
    pdf: pdfOpts,
  });

  emit?.("Launching browser…");
  const t0 = Date.now();
  const browser = await puppeteer.launch(env.BROWSER);
  console.log(PDF_TAG, "launching browser…", { t0 });

  // Timings
  let navMs = 0;
  let settleMs = 0;
  let renderMs = 0;
  let uploadMs = 0;

  const navAttempts: Array<{ waitUntil: string; ms: number; outcome: "ok" | "timeout" | "fail" }> = [];

  async function tryGo(page: Page, dest: URL, wait: NonNullable<PdfArgs["waitUntil"]>): Promise<true | "timeout" | "fail"> {
    const tic = Date.now();
    console.log(PDF_TAG, "navigating", { to: dest.toString(), waitUntil: wait, timeout });
    try {
      await page.goto(dest.toString(), { waitUntil: wait, timeout });
      const ms = Date.now() - tic;
      navAttempts.push({ waitUntil: String(wait), ms, outcome: "ok" });
      console.log(PDF_TAG, "navigate ok", { waitUntil: wait, ms, finalUrl: (page as any).url?.() ?? "unknown" });
      return true;
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      const outcome: "timeout" | "fail" = msg.toLowerCase().includes("timeout") ? "timeout" : "fail";
      const ms = Date.now() - tic;
      navAttempts.push({ waitUntil: String(wait), ms, outcome });
      console.log(PDF_TAG, `navigate ${outcome}`, { waitUntil: wait, ms, msg });
      return outcome;
    }
  }

  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.setBypassCSP(true);
    page.setDefaultNavigationTimeout(timeout);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Page diagnostics
    page.on("console", (m) => console.log(PDF_TAG, "page.console", m.type(), m.text()));
    page.on("pageerror", (e) => console.log(PDF_TAG, "pageerror", e.message));
    page.on("requestfailed", (r) => console.log(PDF_TAG, "requestfailed", r.url(), r.failure()?.errorText));

    emit?.(`Navigating (${wantWait})…`);

    let url = url0;
    let ok = await tryGo(page, url, wantWait);
    if (ok !== true) {
      if (ok === "timeout") ok = await tryGo(page, url, "load");
      if (ok !== true) ok = await tryGo(page, url, "domcontentloaded");
      if (ok !== true) {
        const ww = withWww(url);
        if (ww) {
          emit?.("Retrying with www…");
          url = ww;
          ok = await tryGo(page, url, wantWait);
          if (ok !== true) ok = await tryGo(page, url, "load");
          if (ok !== true) ok = await tryGo(page, url, "domcontentloaded");
        }
      }
    }
    if (ok !== true) {
      const code = ok === "timeout" ? "NAV_TIMEOUT" : "NAV_FAIL";
      emit?.(`Navigation failed (${code})`);
      console.log(PDF_TAG, "navigation failed", { code, attempts: navAttempts });
      return { ok: false, error: code === "NAV_TIMEOUT" ? "Navigation timed out" : "Navigation failed", code };
    }

    navMs = navAttempts.reduce((a, b) => a + b.ms, 0);

    emit?.("Settling…");
    const settleStart = Date.now();
    await new Promise((r) => setTimeout(r, 1200));
    settleMs = Date.now() - settleStart;

    const finalUrl = (page as any).url?.() ?? page.url();
    const redirected = String(finalUrl).replace(/\/+$/, "") !== url0.toString().replace(/\/+$/, "");
    let title: string | undefined;
    try { title = await page.title(); } catch { /* ignore */ }
    console.log(PDF_TAG, "settled", { ms: settleMs, finalUrl, redirected, title });

    emit?.("Rendering PDF…");
    const renderStart = Date.now();
    const pdfBuf = (await page.pdf({
      format: pdfOpts.format,
      landscape: pdfOpts.landscape,
      scale: pdfOpts.scale,
      printBackground: true,
      timeout,
    })) as unknown as ArrayBuffer;
    renderMs = Date.now() - renderStart;
    console.log(PDF_TAG, "render ok", { bytes: pdfBuf.byteLength, ms: renderMs });

    const key = `files/${sid}/${crypto.randomUUID()}.pdf`;
    emit?.("Uploading…");
    const upStart = Date.now();
    try {
      await env.agent_browser_uploads.put(key, pdfBuf, { httpMetadata: { contentType: "application/pdf" } });
    } catch {
      console.log(PDF_TAG, "upload failed", { key });
      return { ok: false, error: "Upload failed", code: "UPLOAD_FAIL" };
    }
    uploadMs = Date.now() - upStart;
    console.log(PDF_TAG, "upload ok", { key, ms: uploadMs });

    const totalMs = Date.now() - t0;
    console.log(PDF_TAG, "done", {
      totalMs,
      navMs,
      settleMs,
      renderMs,
      uploadMs,
      attempts: navAttempts,
      finalUrl,
    });

    return {
      ok: true,
      kind: "pdf",
      url: `/${key}`,
      r2Key: key,
      contentType: "application/pdf",
      bytes: pdfBuf.byteLength,
      sourceUrl: finalUrl,
    };
  } catch (e) {
    const msg = (e as Error)?.message || "Capture error";
    console.log(PDF_TAG, "error", msg);
    const code: ToolErrorCode = msg.toLowerCase().includes("nav") ? "NAV_FAIL" : "CAPTURE_FAIL";
    return { ok: false, error: code === "NAV_FAIL" ? "Navigation failed" : "Capture failed", code };
  } finally {
    console.log(PDF_TAG, "closing browser");
    try { await browser.close(); } catch { /* ignore */ }
  }
}
