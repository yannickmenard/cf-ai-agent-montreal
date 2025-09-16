/// <reference lib="webworker" />
import puppeteer, { type Page } from "@cloudflare/puppeteer";
import type { Env } from "../../worker-configuration";

export type ScreenshotArgs = {
  url: string;
  fullPage?: boolean; // default true
  viewport?: { width: number; height: number }; // default 1280x800
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; // default "networkidle0"
  timeoutMs?: number; // default 20000
};

type ToolErrorCode = "BAD_URL" | "NAV_TIMEOUT" | "NAV_FAIL" | "CAPTURE_FAIL" | "UPLOAD_FAIL";

const SS_TAG = "[screenshot]";

export type ScreenshotResult =
  | {
      ok: true;
      kind: "screenshot";
      url: string;                 // /files/<sid>/<uuid>.png
      r2Key: string;               // files/<sid>/<uuid>.png
      contentType: "image/png";
      bytes: number;
      width: number;
      height: number;
      sourceUrl: string;           // final navigated URL
      viewport: { width: number; height: number };
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

export async function captureScreenshot(
  env: Env,
  sid: string,
  args: ScreenshotArgs,
  emit?: (msg: string) => void
): Promise<ScreenshotResult> {
  const url0 = normalizeUrl(args.url);
  if (!url0) return { ok: false, error: "Invalid URL", code: "BAD_URL" };

  const fullPage = args.fullPage ?? true;
  const wantWait = args.waitUntil ?? "networkidle0";
  const timeout = Math.max(1000, Math.min(60000, args.timeoutMs ?? 20000));
  const viewport = args.viewport ?? { width: 1280, height: 800 };

  // Logging context
  const reqUrlForLogs = String(args?.url ?? "");
  console.log(SS_TAG, "start", {
    sid,
    url: reqUrlForLogs,
    fullPage,
    viewport,
    waitUntil: wantWait,
    timeoutMs: timeout,
  });

  emit?.("Launching browser…");
  const t0 = Date.now();
  const browser = await puppeteer.launch(env.BROWSER);
  console.log(SS_TAG, "launching browser…", { t0 });

  // Timings
  let navMs = 0;
  let settleMs = 0;
  let captureMs = 0;
  let uploadMs = 0;

  // Track each nav attempt
  const navAttempts: Array<{ waitUntil: string; ms: number; outcome: "ok" | "timeout" | "fail" }> = [];

  async function tryGo(page: Page, dest: URL, wait: ScreenshotArgs["waitUntil"]): Promise<true | "timeout" | "fail"> {
    const tic = Date.now();
    console.log(SS_TAG, "navigating", { to: dest.toString(), waitUntil: wait, timeout });
    try {
      await page.goto(dest.toString(), { waitUntil: wait, timeout });
      const ms = Date.now() - tic;
      navAttempts.push({ waitUntil: String(wait), ms, outcome: "ok" });
      console.log(SS_TAG, "navigate ok", { waitUntil: wait, ms, finalUrl: (page as any).url?.() ?? "unknown" });
      return true;
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      const outcome: "timeout" | "fail" = msg.toLowerCase().includes("timeout") ? "timeout" : "fail";
      const ms = Date.now() - tic;
      navAttempts.push({ waitUntil: String(wait), ms, outcome });
      console.log(SS_TAG, `navigate ${outcome}`, { waitUntil: wait, ms, msg });
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
    page.on("console", (m) => console.log(SS_TAG, "page.console", m.type(), m.text()));
    page.on("pageerror", (e) => console.log(SS_TAG, "pageerror", e.message));
    page.on("requestfailed", (r) => console.log(SS_TAG, "requestfailed", r.url(), r.failure()?.errorText));

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
      console.log(SS_TAG, "navigation failed", { code, attempts: navAttempts });
      return { ok: false, error: code === "NAV_TIMEOUT" ? "Navigation timed out" : "Navigation failed", code };
    }

    navMs = navAttempts.reduce((a, b) => a + b.ms, 0);

    emit?.("Settling…");
    const settleStart = Date.now();
    // (Do not use `document` here to avoid DOM lib issues)
    // Just a small extra pause to let SPAs paint:
    await new Promise((r) => setTimeout(r, 1200));
    settleMs = Date.now() - settleStart;

    const finalUrl = (page as any).url?.() ?? page.url();
    const redirected = String(finalUrl).replace(/\/+$/, "") !== url0.toString().replace(/\/+$/, "");
    let title: string | undefined;
    try { title = await page.title(); } catch {
      // ignore
    }
    console.log(SS_TAG, "settled", { ms: settleMs, finalUrl, redirected, title });

    emit?.("Capturing screenshot…");
    const capStart = Date.now();
    const ab = (await page.screenshot({
      type: "png",
      fullPage,
      captureBeyondViewport: true,
    })) as unknown as ArrayBuffer;
    captureMs = Date.now() - capStart;
    console.log(SS_TAG, "capture ok", { bytes: ab.byteLength, ms: captureMs });

    const key = `files/${sid}/${crypto.randomUUID()}.png`;
    emit?.("Uploading…");
    const upStart = Date.now();
    try {
      await env.agent_browser_uploads.put(key, ab, { httpMetadata: { contentType: "image/png" } });
    } catch {
      console.log(SS_TAG, "upload failed", { key });
      return { ok: false, error: "Upload failed", code: "UPLOAD_FAIL" };
    }
    uploadMs = Date.now() - upStart;
    console.log(SS_TAG, "upload ok", { key, ms: uploadMs });

    const totalMs = Date.now() - t0;
    console.log(SS_TAG, "done", {
      totalMs,
      navMs,
      settleMs,
      captureMs,
      uploadMs,
      attempts: navAttempts,
      finalUrl,
    });

    const result: ScreenshotResult = {
      ok: true,
      kind: "screenshot",
      url: `/${key}`,
      r2Key: key,
      contentType: "image/png",
      bytes: ab.byteLength,
      width: viewport.width,
      height: viewport.height,
      sourceUrl: finalUrl,
      viewport,
    };
    return result;
  } catch (e) {
    const msg = (e as Error)?.message || "Capture error";
    console.log(SS_TAG, "error", msg);
    const code: ToolErrorCode = msg.toLowerCase().includes("nav") ? "NAV_FAIL" : "CAPTURE_FAIL";
    return { ok: false, error: code === "NAV_FAIL" ? "Navigation failed" : "Capture failed", code };
  } finally {
    console.log(SS_TAG, "closing browser");
    try { await browser.close(); } catch { /* ignore */ }
  }
}
