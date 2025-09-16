/// <reference lib="webworker" />
import { Agent, type Connection, type ConnectionContext } from "agents";
import type { Env, ChatMessage } from "../worker-configuration";
import {
  getWeather,
  getWeatherToolSchema,
  type WeatherArgs,
  type WeatherResult,
} from "./tools/getWeather";
import {
  captureScreenshot,
  type ScreenshotArgs,
  type ScreenshotResult,
} from "./tools/captureScreenshot";
import {
  convertToPdf,
  type PdfArgs,
  type PdfResult,
} from "./tools/convertToPdf";

// ---------------- System behavior (one source of truth) ---------------------
const SYSTEM_BEHAVIOR = `
You are an AI agent that can optionally call tools. Your available tools are:

1) getWeather(location, days?)
   - Fetches forecast via Open-Meteo for a specific city/region/coords (and optional number of days).
   - Use ONLY when the user explicitly asks about weather/forecast/temperature/precipitation for a concrete place and timeframe.
   - If the request lacks a clear location, ask one brief clarifying question rather than guessing.

2) captureScreenshot(url, fullPage?, viewport?, waitUntil?, timeoutMs?)
   - Takes a page screenshot using Cloudflare Browser Rendering.
   - Use ONLY when the user explicitly asks for a screenshot (or an image of a page) and provides a concrete URL or domain.
   - Do not invent URLs or parameters. If URL is missing, ask once for it. Do not promise a capture without running the tool.

3) convertToPdf(url, pdf?, waitUntil?, timeoutMs?, viewport?)
   - Renders a page to PDF using Cloudflare Browser Rendering.
   - Use ONLY when the user explicitly asks to export/convert a page to PDF and provides a concrete URL or domain.
   - Do not invent URLs or parameters. If URL is missing, ask once for it.

General rules:
- NEVER call tools when the user is asking ABOUT your capabilities (e.g., "What tools can you use?"). In that case, answer with a concise list/descriptions of the tools above and DO NOT call any tool.
- Do not fabricate tools, APIs, parameters, locations, or URLs. If required inputs are missing, ask one concise follow-up.
- When a tool was run, the UI already displays links/previews. In summaries, do NOT repeat links; briefly note the outcome in 1–3 sentences.
- Keep answers factual and concise. If a tool was not run, do not imply you ran it.
`.trim();

/** One chat line stored in SQLite and mirrored in state */
type Msg = { role: "user" | "assistant" | "tool"; content: string; ts: number };

/** Agent state mirrored to clients on connect */
type State = {
  model: string;
  messages: Msg[];
  createdAt: number;
  expiresAt: number;
};

type WeatherToolEvent =
  | { type: "tool"; tool: "getWeather"; status: "started"; message?: string }
  | { type: "tool"; tool: "getWeather"; status: "step";    message?: string }
  | { type: "tool"; tool: "getWeather"; status: "done";    message?: string; result: WeatherResult }
  | { type: "tool"; tool: "getWeather"; status: "error";   message: string };

function emitWeatherTool(conn: Connection, evt: WeatherToolEvent): void {
  conn.send(JSON.stringify(evt));
}

type ToolEvent = {
  type: "tool";
  tool: "getWeather" | "screenshot" | "convertToPdf" | string;
  status?: "started" | "step" | "done" | "error";
  message?: string;
  result?: unknown;
};
function emitTool(conn: Connection, evt: ToolEvent): void {
  conn.send(JSON.stringify(evt));
}


const DAY = 86_400_000;
const DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** Narrow helpers */
function isReadableStream(x: unknown): x is ReadableStream<Uint8Array> {
  return typeof x === "object" && x !== null &&
    typeof (x as ReadableStream<Uint8Array>).getReader === "function";
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
/** Type guard: keep only user/assistant rows for model history */
type UA = { role: "user" | "assistant"; content: string; ts: number };
function isUserOrAssistant(m: Msg): m is UA {
  return m.role === "user" || m.role === "assistant";
}

/** Types for tool-calling response */
type AiToolCall = {
  id?: string;
  type?: string; // "function"
  function?: { name?: string; arguments?: unknown };
};
type AiPlanResponse = {
  response?: string;
  tool_calls?: AiToolCall[];
};

// --- Agentic summary helper (safe, non-streaming) --------------------------
async function summarizeToolOutcome(
  env: Env,
  modelId: string | undefined,
  userQuery: string,
  tool: "screenshot" | "convertToPdf",
  result: unknown
): Promise<string> {
  // Deterministic fallback if AI isn't available or call fails
  const fallback = () => {
    try {
      const r: any = result;
      if (r?.ok) {
        if (tool === "screenshot") {
          const dims = r.width && r.height ? ` (${r.width}×${r.height})` : "";
          const title = r.title || (r.sourceUrl ? new URL(r.sourceUrl).hostname : "page");
          return `Captured “${title}”${dims}. Use the link above to open or download.`;
        } else {
          const title = r.title || (r.sourceUrl ? new URL(r.sourceUrl).hostname : "page");
          return `Rendered “${title}” to PDF. Use the link above to open or download.`;
        }
      } else {
        const code = r?.code ? ` (${r.code})` : "";
        return `The ${tool === "screenshot" ? "screenshot" : "PDF"} step failed${code}. You can retry with a longer timeout or a different URL.`;
      }
    } catch {}
    return "Done.";
  };

  const mid = (typeof modelId === "string" && modelId) || "";
  if (!mid) return fallback();

  try {
    const messages = [
      {
        role: "system",
        content:
          "Explain the outcome of a web capture tool (screenshot or PDF) in 1–3 sentences. " +
          "Be factual and concise. If navigation timed out or required a fallback (e.g., used 'load' instead of 'networkidle0'), or redirected, mention it briefly. " +
          "Offer one concrete suggestion if helpful (e.g., adjust viewport, increase timeout). The link is already shown; don't repeat it.",
      },
      {
        role: "user",
        content:
          `User request:\n${userQuery}\n\n` +
          `Tool: ${tool}\n\n` +
          `Result JSON (truncated):\n${JSON.stringify(result).slice(0, 1800)}`
      }
    ];

    const out: any = await env.AI.run(mid, { messages, temperature: 0.2, max_tokens: 150 });
    if (typeof out === "string") return out;
    if (out && typeof out === "object") {
      const txt = out.response || out.output || out.text || "";
      if (typeof txt === "string" && txt.trim()) return txt.trim();
    }
    return fallback();
  } catch {
    return fallback();
  }
}

// ---------------------------------------------------------------------------

export default class AIAgent extends Agent<Env, State> {
  declare env: Env;

  initialState: State = {
    model: DEFAULT_MODEL,
    messages: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + DAY,
  };

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    console.log("[agent] connect", { name: this.name, url: ctx.request.url });
    await this.#schema();

    if (!this.state.messages?.length) {
      const rows = await this.sql<Msg>`SELECT role, content, ts FROM messages ORDER BY ts ASC`;
      this.setState({
        ...this.state,
        messages: rows,
        expiresAt: Date.now() + DAY,
      });
    }
    conn.send(JSON.stringify({ type: "ready", state: this.state }));
  }

  async onMessage(conn: Connection, message: string | ArrayBuffer | ArrayBufferView) {
    if (typeof message !== "string") return;
    let data: { type?: "chat" | "reset" | "model"; text?: string; model?: string } | null = null;
    try { data = JSON.parse(message); } catch { /* ignore */ }
    if (!data?.type) return;

    if (data.type === "model" && data.model) {
      this.setState({ ...this.state, model: data.model, expiresAt: Date.now() + DAY });
      console.log("[agent] model set", { model: data.model });
      return;
    }

    if (data.type === "reset") {
      await this.sql`DELETE FROM messages`;
      this.setState({
        model: this.state.model || DEFAULT_MODEL,
        messages: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + DAY,
      });
      conn.send(JSON.stringify({ type: "cleared" }));
      return;
    }

    if (data.type === "chat") {
      const userText = (data.text || "").trim();
      if (!userText) return;

      const now = Date.now();
      await this.sql`INSERT INTO messages (role, content, ts) VALUES ('user', ${userText}, ${now})`;
      const userMsg: Msg = { role: "user", content: userText, ts: now };

      this.setState({
        ...this.state,
        messages: [...this.state.messages, userMsg],
        expiresAt: Date.now() + DAY,
      });

      // Build short history for planning + chat (filter out tool rows)
      const recentUA = this.state.messages.slice(-40).filter(isUserOrAssistant);
      const history: ChatMessage[] = recentUA.map(({ role, content }) => ({ role, content }));

      // --- 1) PLANNER PASS (tool-calling) -----------------------------------
      const planned = await this.#tryPlanTool(history, userText);
      if (planned?.tool === "getWeather") {
        const args = planned.args as Partial<WeatherArgs>;

        // small “I’m on it” assistant message (streamed + persisted)
        const pre = `Sure — I’ll check the forecast for ${args.location ?? "that location"} using getWeather…`;
        conn.send(JSON.stringify({ type: "delta", text: pre }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, pre);

        // progress events (ephemeral)
        emitWeatherTool(conn, { type: "tool", tool: "getWeather", status: "started", message: "Planning weather lookup…" });
        emitWeatherTool(conn, { type: "tool", tool: "getWeather", status: "step",    message: "Fetching forecast from Open-Meteo…" });

        // actual call
        const res = await getWeather(args);

        if (!res.ok) {
          emitWeatherTool(conn, { type: "tool", tool: "getWeather", status: "error", message: res.error });
          await this.#saveAssistant(conn, `I couldn't fetch the weather: ${res.error}`);
          return;
        }

        // progress done (ephemeral for immediate UI)
        emitWeatherTool(conn, { type: "tool", tool: "getWeather", status: "done", message: "Forecast ready", result: res });

        // persist final tool result so it survives refresh
        const toolRow: Msg = {
          role: "tool",
          content: JSON.stringify({ type: "tool_result", tool: "getWeather", result: res }),
          ts: Date.now(),
        };
        await this.sql`INSERT INTO messages (role, content, ts) VALUES ('tool', ${toolRow.content}, ${toolRow.ts})`;
        this.setState({ ...this.state, messages: [...this.state.messages, toolRow], expiresAt: Date.now() + DAY });

        // agentic summary (same model) — streamed + persisted
        await this.#streamSummary(conn, userText, res);
        return;
      }

      // ---- SCREENSHOT (rule-of-thumb trigger) --------------------------------
      const ssMatch = /\b(screenshot|capture\b.*(page|site|screen)|image of)\b/i.test(userText);
      if (ssMatch) {
        // Extract a URL-ish token (very simple heuristic)
        const m = userText.match(/\bhttps?:\/\/\S+|(?:\b[\w-]+\.)+\w{2,}(?:\/\S*)?/i);
        const target = m?.[0] ?? "";
        const args: ScreenshotArgs = { url: target || "https://example.com", fullPage: true };

  const pre = `Okay — I’ll capture a full-page screenshot of ${target || "that page"}…`;
  conn.send(JSON.stringify({ type: "delta", text: pre }));
  conn.send(JSON.stringify({ type: "done" }));
  await this.#saveAssistant(conn, pre);

  emitTool(conn, { type: "tool", tool: "screenshot", status: "started", message: "Planning capture…" });
  const sid = this.name; // your Agent name is the session id
  const res: import("./tools/captureScreenshot").ScreenshotResult = await captureScreenshot(this.env, sid, args, (msg) =>
    emitTool(conn, { type: "tool", tool: "screenshot", status: "step", message: msg })
  );

  if (!res.ok) {
    emitTool(conn, { type: "tool", tool: "screenshot", status: "error", message: res.error, result: res });
  
    // Agentic summary (safe; falls back deterministically if AI fails)
    const summary = await summarizeToolOutcome(
      this.env,
      (this.state?.model as string | undefined),
      userText,
      "screenshot",
      res
    );
    conn.send(JSON.stringify({ type: "delta", text: summary }));
    conn.send(JSON.stringify({ type: "done" }));
    await this.#saveAssistant(conn, summary);
    return;
  }

  emitTool(conn, { type: "tool", tool: "screenshot", status: "done", message: "Screenshot ready", result: res });

  // persist tool row
  const toolRow: Msg = {
    role: "tool",
    content: JSON.stringify({ type: "tool_result", tool: "screenshot", result: res }),
    ts: Date.now(),
  };
  await this.sql`INSERT INTO messages (role, content, ts) VALUES ('tool', ${toolRow.content}, ${toolRow.ts})`;
  this.setState({ ...this.state, messages: [...this.state.messages, toolRow], expiresAt: Date.now() + DAY });

  // agentic summary (keeps everything else the same)
  const summary = await summarizeToolOutcome(
    this.env,
    (this.state?.model as string | undefined),
    userText,
    "screenshot",
    res
  );
  conn.send(JSON.stringify({ type: "delta", text: summary }));
  conn.send(JSON.stringify({ type: "done" }));
  await this.#saveAssistant(conn, summary);
  return;
      }

      // ---- PDF (rule-of-thumb trigger) ---------------------------------------
      const pdfMatch = /\b(pdf|export to pdf|save as pdf|render .* pdf)\b/i.test(userText);
      if (pdfMatch) {
        const m = userText.match(/\bhttps?:\/\/\S+|(?:\b[\w-]+\.)+\w{2,}(?:\/\S*)?/i);
        const target = m?.[0] ?? "";
        const args: PdfArgs = { url: target || "https://example.com", pdf: { format: "A4", scale: 1 } };

        const pre = `Got it — I’ll render a PDF of ${target || "that page"}…`;
        conn.send(JSON.stringify({ type: "delta", text: pre }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, pre);

        emitTool(conn, { type: "tool", tool: "convertToPdf", status: "started", message: "Planning PDF…" });
        const sid = this.name;
        const res: import("./tools/convertToPdf").PdfResult = await convertToPdf(this.env, sid, args, (msg) =>
          emitTool(conn, { type: "tool", tool: "convertToPdf", status: "step", message: msg })
        );

        if (!res.ok) {
          emitTool(conn, { type: "tool", tool: "convertToPdf", status: "error", message: res.error, result: res });
        
          const summary = await summarizeToolOutcome(
            this.env,
            (this.state?.model as string | undefined),
            userText,
            "convertToPdf",
            res
          );
          conn.send(JSON.stringify({ type: "delta", text: summary }));
          conn.send(JSON.stringify({ type: "done" }));
          await this.#saveAssistant(conn, summary);
          return;
        }

        emitTool(conn, { type: "tool", tool: "convertToPdf", status: "done", message: "PDF ready", result: res });

        // persist tool row
        const toolRow: Msg = {
          role: "tool",
          content: JSON.stringify({ type: "tool_result", tool: "convertToPdf", result: res }),
          ts: Date.now(),
        };
        await this.sql`INSERT INTO messages (role, content, ts) VALUES ('tool', ${toolRow.content}, ${toolRow.ts})`;
        this.setState({ ...this.state, messages: [...this.state.messages, toolRow], expiresAt: Date.now() + DAY });

        const summary = await summarizeToolOutcome(
          this.env,
          (this.state?.model as string | undefined),
          userText,
          "convertToPdf",
          res
        );
        conn.send(JSON.stringify({ type: "delta", text: summary }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, summary);
        return;
      }

      // --- 2) FALLBACK: plain streaming chat --------------------------------
      await this.#streamAssistant(conn, history);
    }
  }

  // ---------------------- Streaming chat fallback ---------------------------

  async #streamAssistant(conn: Connection, history: ChatMessage[]) {
    let full = "";
    try {
      const out = await this.env.AI.run(this.state.model || DEFAULT_MODEL, {
        messages: [
          { role: "system", content: SYSTEM_BEHAVIOR },
          ...history,
        ],
        stream: true,
      });

      const stream = isReadableStream(out) ? out : null;
      if (!stream) {
        const fallbackText = typeof out === "string" ? out : "[no response]";
        await this.#saveAssistant(conn, fallbackText);
        return;
      }

      const reader = stream.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          for (const line of frame.replace(/\r\n/g, "\n").split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trimStart();
            if (!payload || payload === "[DONE]") continue;

            try {
              const json = JSON.parse(payload) as { response?: string };
              const piece = typeof json?.response === "string" ? json.response : "";
              if (piece) {
                full += piece;
                conn.send(JSON.stringify({ type: "delta", text: piece }));
              }
            } catch {
              full += payload;
              conn.send(JSON.stringify({ type: "delta", text: payload }));
            }
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log("[agent] stream error:", msg);
      full = full || "_(stream error)_";
    } finally {
      conn.send(JSON.stringify({ type: "done" }));
    }

    await this.#saveAssistant(conn, full);
  }

    // ---------------------- Post-tool agentic summary -------------------------
    async #streamSummary(conn: Connection, userText: string, result: WeatherResult) {
      if (!result.ok) {
        await this.#saveAssistant(conn, `I couldn't summarize the weather: ${result.error}`);
        return;
      }
  
      const days = result.daily.slice(0, Math.min(7, result.daily.length));
      if (!days.length) {
        await this.#saveAssistant(conn, "I couldn't find a daily forecast for that range.");
        return;
      }
  
      // Compute weekly high/low + wettest day by precip probability
      let weeklyHigh = Number.NEGATIVE_INFINITY;
      let weeklyLow  = Number.POSITIVE_INFINITY;
      let maxPop = -1;
      let wetIdx = -1;
  
      for (let i = 0; i < days.length; i++) {
        const d = days[i];
        if (Number.isFinite(d.tMax) && d.tMax > weeklyHigh) weeklyHigh = d.tMax;
        if (Number.isFinite(d.tMin) && d.tMin < weeklyLow)  weeklyLow  = d.tMin;
        if (Number.isFinite(d.pop)  && d.pop  > maxPop) { maxPop = d.pop; wetIdx = i; }
      }
  
      const hi = Number.isFinite(weeklyHigh) ? Math.round(weeklyHigh) : null;
      const lo = Number.isFinite(weeklyLow)  ? Math.round(weeklyLow)  : null;
      const pop = maxPop >= 0 ? Math.round(maxPop) : null;
  
      const unitT = result.units.temp; // "°C" | "°F"
      const placeName = [result.place.name, result.place.region, result.place.country].filter(Boolean).join(", ");
  
      const wetISO = wetIdx >= 0 ? days[wetIdx].date : "";
      const wetPretty =
        wetISO
          ? new Date(wetISO + "T00:00:00").toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })
          : null;
  
      // Build a short, actionable summary with guaranteed numbers
      const parts: string[] = [];
  
      // Line 1: Overall temps
      if (hi !== null && lo !== null) {
        parts.push(`Next week in ${placeName}, expect highs around ${hi}${unitT} and lows near ${lo}${unitT}.`);
      } else if (hi !== null) {
        parts.push(`Next week in ${placeName}, expect highs around ${hi}${unitT}.`);
      } else if (lo !== null) {
        parts.push(`Next week in ${placeName}, expect lows near ${lo}${unitT}.`);
      } else {
        parts.push(`Next week in ${placeName}, temperatures vary through the week.`);
      }
  
      // Line 2: Precipitation / wettest day
      if (pop !== null && pop > 0) {
        parts.push(
          wetPretty
            ? `Peak chance of precipitation is about ${pop}% on ${wetPretty}.`
            : `Peak chance of precipitation is about ${pop}%.`
        );
      } else {
        parts.push(`Rain risk looks low overall.`);
      }
  
      // Line 3: Packing note
      if (hi !== null && lo !== null) {
        const range = hi - lo;
        if (pop !== null && pop >= 40) {
          parts.push(`Pack layers and bring a small umbrella or rain jacket just in case.`);
        } else if (range >= 10) {
          parts.push(`Pack layers (mornings/evenings cooler than afternoons).`);
        } else {
          parts.push(`Light layers should be fine for most of the week.`);
        }
      } else {
        parts.push(`Pack flexible layers to handle changes through the week.`);
      }
  
      const summary = parts.join(" ");
  
      // Stream as one message for simplicity
      conn.send(JSON.stringify({ type: "delta", text: summary }));
      conn.send(JSON.stringify({ type: "done" }));
      await this.#saveAssistant(conn, summary);
    }
  

  

  // ---------------------- Planning / Tool selection -------------------------

  async #tryPlanTool(history: ChatMessage[], userText: string): Promise<{ tool: "getWeather"; args: WeatherArgs } | null> {
    const system =
      SYSTEM_BEHAVIOR +
      "\n\nPlanner instructions: Return a tool call ONLY when the user explicitly requests a weather forecast with a concrete location/timeframe. " +
      "Otherwise, do not return any tool call.";

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ];

    // Build the planning payload as a *variable* (not an object literal) so
    // we can carry extra fields without triggering excess-property checks.
    const plannerInput: { messages: ChatMessage[] } & Record<string, unknown> = { messages };
    plannerInput.tools = [getWeatherToolSchema];
    plannerInput.temperature = 0.2;
    plannerInput.max_tokens = 200;

    try {
      const out = await this.env.AI.run(this.state.model || DEFAULT_MODEL, plannerInput);
      const obj = isRecord(out) ? (out as unknown as AiPlanResponse) : undefined;
      const calls = obj?.tool_calls;
      if (!Array.isArray(calls) || !calls.length) return null;

      const call = calls[0];
      const fn = call?.function?.name;
      if (fn !== "getWeather") return null;

      const parsedArgs = this.#parseToolArgs(call?.function?.arguments);
      return { tool: "getWeather", args: parsedArgs };
    } catch (e) {
      console.log("[agent] planner error:", e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  #parseToolArgs(raw: unknown): WeatherArgs {
    if (isRecord(raw)) return raw as WeatherArgs;
    if (typeof raw === "string") {
      try {
        const j = JSON.parse(raw);
        if (isRecord(j)) return j as WeatherArgs;
      } catch { /* ignore */ }
    }
    return {};
  }

  // ---------------------- Persistence helpers -------------------------------

  async #saveAssistant(_conn: Connection, text: string) {
    const ts = Date.now();
    await this.sql`INSERT INTO messages (role, content, ts) VALUES ('assistant', ${text}, ${ts})`;
    this.setState({
      ...this.state,
      messages: [...this.state.messages, { role: "assistant", content: text, ts }],
      expiresAt: Date.now() + DAY,
    });
  }

  async #schema() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        role    TEXT    NOT NULL,
        content TEXT    NOT NULL,
        ts      INTEGER NOT NULL
      )`;
  }
}
