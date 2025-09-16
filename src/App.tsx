import { useEffect, useMemo, useRef, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { MessageBubble } from "./components/chat/MessageBubble";
import { ToolCard, type ToolUI } from "./components/chat/ToolCard";
import { WeatherWidget } from "./components/chat/WeatherWidget";
import { Button } from "./components/ui/button";
import { SuggestionChips } from "./components/chat/SuggestionChips";
import { useTheme } from "./theme/useTheme";
import type { ModelId } from "./components/chat/ModelPicker";
import { ChatInput } from "./components/chat/ChatInput";
import { AgentClient, type AgentState } from "./agent/wsClient";

export type ChatMessage =
  | { id: string; role: "user" | "assistant"; content: string }
  | { id: string; role: "tool"; toolUI: ToolUI };

export default function App() {
  const hydratedRef = useRef(false);
  const { theme, setTheme } = useTheme();
  const [model, setModel] = useState<ModelId>("@cf/meta/llama-4-scout-17b-16e-instruct");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const clientRef = useRef<AgentClient | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  function isToolMessage(m: ChatMessage): m is Extract<ChatMessage, { role: "tool" }> {
    return m.role === "tool";
  }

  // --- Weather UI helpers ---------------------------------------------------

  // Build a WeatherWidget message (ToolCard stays progress-only)
  function uiFromWeather(
    result: import("../worker/tools/getWeather").WeatherResult
  ): ToolUI {
    if (!result.ok) {
      return { kind: "generic", title: "Weather", subtitle: `Error: ${result.error}` };
    }
    const { place, daily } = result;
    const title = [place.name, place.region, place.country].filter(Boolean).join(", ") || "Weather";
    const subtitle = `Forecast (${daily.length} day${daily.length > 1 ? "s" : ""}) — ${place.timezone}`;
    return { kind: "weather", title, subtitle, data: result };
  }

  // Progress helpers for getWeather
  function initialWeatherProgress(): ToolUI {
    return {
      kind: "progress",
      title: "Weather",
      subtitle: "Planning request…",
      progress: {
        tool: "getWeather",
        phase: "running",
        steps: [
          { key: "plan",  label: "Planning",            state: "active" as const },
          { key: "fetch", label: "Fetching Open-Meteo", state: "idle"   as const },
          { key: "parse", label: "Parsing",             state: "idle"   as const },
          { key: "final", label: "Finalizing",          state: "idle"   as const },
        ],
      },
    };
  }
  function setStepState(ui: ToolUI, key: string, state: "idle" | "active" | "done" | "error"): ToolUI {
    if (ui.kind !== "progress" || !ui.progress) return ui;
    const steps = ui.progress.steps.map((s) => (s.key === key ? { ...s, state } : s));
    return { ...ui, progress: { ...ui.progress, steps } };
  }
  function markSequence(ui: ToolUI, activate: string, doneKeys: string[]): ToolUI {
    let next = ui;
    for (const k of doneKeys) next = setStepState(next, k, "done");
    next = setStepState(next, activate, "active");
    return next;
  }
  function finalizeProgress(ui: ToolUI): ToolUI {
    if (ui.kind !== "progress" || !ui.progress) return ui;
    const steps = ui.progress.steps.map((s) => (s.state === "done" ? s : { ...s, state: "done" as const }));
    return { ...ui, progress: { ...ui.progress, phase: "done", steps } };
  }
  function errorProgress(ui: ToolUI, msg: string): ToolUI {
    if (ui.kind !== "progress" || !ui.progress) return ui;
    return { ...ui, progress: { ...ui.progress, phase: "error", error: msg, steps: ui.progress.steps } };
  }

  // Maintain the latest PROGRESS card for getWeather
  function upsertWeatherProgress(mutator: (prev?: ToolUI) => ToolUI) {
    setMessages((prev) => {
      const next = [...prev];
      const revIdx = [...next].reverse().findIndex((m) => {
        if (m.role !== "tool") return false;
        const ui = m.toolUI;
        return ui.kind === "progress" && ui.progress?.tool === "getWeather";
      });
      const idx = revIdx === -1 ? -1 : next.length - 1 - revIdx;

      if (idx === -1) {
        next.push({ id: crypto.randomUUID(), role: "tool", toolUI: mutator(undefined) });
      } else {
        const prevMsg = next[idx];
        if (prevMsg.role === "tool") {
          next[idx] = { id: prevMsg.id, role: "tool", toolUI: mutator(prevMsg.toolUI) };
        }
      }
      return next;
    });
  }

  // Append a WeatherWidget message (separate from progress card)
  function appendWeatherWidget(result: import("../worker/tools/getWeather").WeatherResult) {
    const ui = uiFromWeather(result);
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "tool", toolUI: ui }]);
  }

  // -------- Screenshot progress helpers --------------------------------------
function initialScreenshotProgress(target: string): ToolUI {
  return {
    kind: "progress",
    title: "Screenshot",
    subtitle: target,
    progress: {
      tool: "screenshot",
      phase: "running",
      steps: [
        { key: "normalize", label: "Normalize URL", state: "active" },
        { key: "navigate",  label: "Open page",     state: "idle" },
        { key: "settle",    label: "Settle",        state: "idle" },
        { key: "capture",   label: "Capture",       state: "idle" },
        { key: "upload",    label: "Upload",        state: "idle" },
      ],
    },
  };
}

function tickScreenshotProgress(prev?: ToolUI, msg?: string): ToolUI {
  if (!prev || prev.kind !== "progress" || prev.progress?.tool !== "screenshot") return prev ?? initialScreenshotProgress("page");
  const p = prev.progress!;
  const steps = [...p.steps];

  const advance = (keyFrom: string, keyTo: string) => {
    const iFrom = steps.findIndex(s => s.key === keyFrom);
    const iTo   = steps.findIndex(s => s.key === keyTo);
    if (iFrom >= 0) steps[iFrom] = { ...steps[iFrom], state: "done" };
    if (iTo >= 0 && steps[iTo].state !== "done") steps[iTo] = { ...steps[iTo], state: "active" };
  };

  // Heuristic mapping from tool step messages to step transitions
  const text = (msg ?? "").toLowerCase();
  if (text.includes("launching browser")) advance("normalize", "navigate");
  else if (text.startsWith("navigating") || text.includes("retrying with www")) advance("normalize", "navigate");
  else if (text.includes("settling")) advance("navigate", "settle");
  else if (text.includes("capturing")) advance("settle", "capture");
  else if (text.includes("uploading")) advance("capture", "upload");

  return { ...prev, progress: { ...p, steps } };
}

function finalizeScreenshotProgress(prev?: ToolUI, url?: string, dims?: { w?: number; h?: number }): ToolUI {
  if (!prev || prev.kind !== "progress" || prev.progress?.tool !== "screenshot") return prev!;
  const doneSteps = prev.progress!.steps.map(s => ({ ...s, state: "done" as const }));
  return {
    ...prev,
    subtitle: dims?.w && dims?.h ? `${dims.w}×${dims.h}` : prev.subtitle,
    progress: { ...prev.progress!, phase: "done", steps: doneSteps },
    media: url ? { type: "image", url } : prev.media,
    downloadUrl: url ?? prev.downloadUrl,
  };
}

function errorScreenshotProgress(prev?: ToolUI, err?: string): ToolUI {
  if (!prev || prev.kind !== "progress" || prev.progress?.tool !== "screenshot") return prev!;
  return {
    ...prev,
    progress: { ...prev.progress!, phase: "error", error: err ?? "Screenshot failed." },
  };
}

// -------- PDF progress helpers ---------------------------------------------
function initialPdfProgress(target: string): ToolUI {
  return {
    kind: "progress",
    title: "PDF",
    subtitle: target,
    progress: {
      tool: "convertToPdf",
      phase: "running",
      steps: [
        { key: "normalize", label: "Normalize URL", state: "active" },
        { key: "navigate",  label: "Open page",     state: "idle" },
        { key: "settle",    label: "Settle",        state: "idle" },
        { key: "render",    label: "Render PDF",    state: "idle" },
        { key: "upload",    label: "Upload",        state: "idle" },
      ],
    },
  };
}

function tickPdfProgress(prev?: ToolUI, msg?: string): ToolUI {
  if (!prev || prev.kind !== "progress" || prev.progress?.tool !== "convertToPdf") return prev ?? initialPdfProgress("page");
  const p = prev.progress!;
  const steps = [...p.steps];

  const advance = (keyFrom: string, keyTo: string) => {
    const iFrom = steps.findIndex(s => s.key === keyFrom);
    const iTo   = steps.findIndex(s => s.key === keyTo);
    if (iFrom >= 0) steps[iFrom] = { ...steps[iFrom], state: "done" };
    if (iTo >= 0 && steps[iTo].state !== "done") steps[iTo] = { ...steps[iTo], state: "active" };
  };

  const text = (msg ?? "").toLowerCase();
  if (text.includes("launching browser")) advance("normalize", "navigate");
  else if (text.startsWith("navigating") || text.includes("retrying with www")) advance("normalize", "navigate");
  else if (text.includes("settling")) advance("navigate", "settle");
  else if (text.includes("rendering pdf")) advance("settle", "render");
  else if (text.includes("uploading")) advance("render", "upload");

  return { ...prev, progress: { ...p, steps } };
}

function finalizePdfProgress(prev?: ToolUI, url?: string): ToolUI {
  if (!prev || prev.kind !== "progress" || prev.progress?.tool !== "convertToPdf") return prev!;
  const doneSteps = prev.progress!.steps.map(s => ({ ...s, state: "done" as const }));
  return {
    ...prev,
    progress: { ...prev.progress!, phase: "done", steps: doneSteps },
    media: url ? { type: "pdf", url } : prev.media,
    downloadUrl: url ?? prev.downloadUrl,
  };
}

function errorPdfProgress(prev?: ToolUI, err?: string): ToolUI {
  if (!prev || prev.kind !== "progress" || prev.progress?.tool !== "convertToPdf") return prev!;
  return { ...prev, progress: { ...prev.progress!, phase: "error", error: err ?? "PDF failed." } };
}

// -------- Upsert helpers for screenshot/pdf ---------------------------------
function upsertProgress(tool: "screenshot" | "convertToPdf", mutator: (prev?: ToolUI) => ToolUI) {
  setMessages((prev) => {
    const next = [...prev];
    const revIdx = [...next].reverse().findIndex((m) => m.role === "tool" && m.toolUI.kind === "progress" && m.toolUI.progress?.tool === tool);
    if (revIdx === -1) {
      // nothing to update
      next.push({ id: crypto.randomUUID(), role: "tool", toolUI: mutator(undefined) });
      return next;
    }
    const idx = next.length - 1 - revIdx;
    const cur = next[idx]!.toolUI;
    next[idx] = { ...next[idx]!, toolUI: mutator(cur) };
    return next;
  });
}


  useEffect(() => {
    // Align cookie with the WS/session sid from localStorage
    const sid = localStorage.getItem("sessionId");
    const url = sid ? `/api/session?sid=${encodeURIComponent(sid)}` : `/api/session`;
    fetch(url, { method: "GET", credentials: "include" }).catch(() => {});
  }, []);

  // --- Autoscroll -----------------------------------------------------------
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  // --- Connect once ---------------------------------------------------------
  useEffect(() => {
    if (!clientRef.current) clientRef.current = new AgentClient();
    const client = clientRef.current;

    client.onReady = (s: AgentState) => {
      console.log("[ui] ready", s);
      setModel(s.model as ModelId);

      // Hydrate chat from server exactly once
      if (!hydratedRef.current) {
        const msgs = Array.isArray(s.messages) ? s.messages : [];
        if (msgs.length) {
          const restored: ChatMessage[] = [];
          for (const m of msgs) {
            if (m.role === "tool") {
              try {
                const parsed = JSON.parse(m.content) as {
                  type?: string;
                  tool?: string;
                  result?: unknown;
                };
            
                // All persisted tool rows have shape: { type: "tool_result", tool, result }
                if (parsed?.type === "tool_result") {
                  if (parsed.tool === "getWeather" && parsed.result) {
                    const wx = parsed.result as import("../worker/tools/getWeather").WeatherResult;
                    restored.push({
                      id: crypto.randomUUID(),
                      role: "tool",
                      toolUI: finalizeProgress(initialWeatherProgress()),
                    });
                    restored.push({
                      id: crypto.randomUUID(),
                      role: "tool",
                      toolUI: uiFromWeather(wx),
                    });
                    continue;
                  }
            
                  if (parsed.tool === "screenshot" && (parsed.result as any)?.ok) {
                    const r = parsed.result as { url: string; width?: number; height?: number; sourceUrl?: string };
                    restored.push({
                      id: crypto.randomUUID(),
                      role: "tool",
                      toolUI: finalizeScreenshotProgress(
                        initialScreenshotProgress(r.sourceUrl ?? "Screenshot"),
                        r.url,
                        { w: r.width, h: r.height }
                      ),
                    });
                    continue;
                  }
            
                  if (parsed.tool === "convertToPdf" && (parsed.result as any)?.ok) {
                    const r = parsed.result as { url: string; sourceUrl?: string };
                    restored.push({
                      id: crypto.randomUUID(),
                      role: "tool",
                      toolUI: finalizePdfProgress(
                        initialPdfProgress(r.sourceUrl ?? "PDF"),
                        r.url
                      ),
                    });
                    continue;
                  }
                }
              } catch { /* ignore */ }
            
              // Unknown tool → neutral card so users still see "a tool ran"
              restored.push({
                id: crypto.randomUUID(),
                role: "tool",
                toolUI: { kind: "generic", title: "Tool", subtitle: "Result available" },
              });
            } else {
              restored.push({
                id: crypto.randomUUID(),
                role: m.role,
                content: m.content,
              });
            }
          }
          setMessages(restored);
        }
        hydratedRef.current = true;
      }
    };

    client.onDelta = (t) => {
      setPending(true);
      setMessages((m) => {
        const last = m[m.length - 1];
        if (!last || last.role !== "assistant") {
          return [...m, { id: crypto.randomUUID(), role: "assistant", content: t }];
        }
        const updated = [...m];
        updated[updated.length - 1] = { ...last, content: last.content + t };
        return updated;
      });
    };

    client.onTool = (evt) => {
      // ---- getWeather (unchanged) ---------------------------------------------
      if (evt.tool === "getWeather") {
        if (evt.status === "started") {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "tool", toolUI: initialWeatherProgress() },
          ]);
        } else if (evt.status === "step") {
          const msg = (evt.message ?? "").toLowerCase();
          upsertWeatherProgress((prev) => {
            const base = prev && prev.kind === "progress" ? prev : initialWeatherProgress();
            if (msg.includes("fetch")) return markSequence(base, "fetch", ["plan"]);
            if (msg.includes("pars"))  return markSequence(base, "parse", ["plan", "fetch"]);
            if (msg.includes("final")) return markSequence(base, "final", ["plan", "fetch", "parse"]);
            return base;
          });
        } else if (evt.status === "done") {
          upsertWeatherProgress((prev) => finalizeProgress(prev ?? initialWeatherProgress()));
          appendWeatherWidget(evt.result as import("../worker/tools/getWeather").WeatherResult);
        } else if (evt.status === "error") {
          upsertWeatherProgress((prev) =>
            errorProgress(prev ?? initialWeatherProgress(), evt.message ?? "Something went wrong")
          );
        }
        return;
      }
    
      // ---- screenshot ----------------------------------------------------------
      if (evt.tool === "screenshot") {
        if (evt.status === "started") {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "tool", toolUI: initialScreenshotProgress("page") },
          ]);
          return;
        }
        if (evt.status === "step") {
          upsertProgress("screenshot", (prev) => tickScreenshotProgress(prev, evt.message));
          return;
        }
        if (evt.status === "error") {
          upsertProgress("screenshot", (prev) => errorScreenshotProgress(prev, evt.message));
          return;
        }
        if (evt.status === "done") {
          const r = evt.result as { ok?: boolean; url?: string; width?: number; height?: number } | undefined;
          if (r && (r as any).ok) {
            upsertProgress("screenshot", (prev) =>
              finalizeScreenshotProgress(prev, r!.url, { w: r!.width, h: r!.height })
            );
          } else {
            upsertProgress("screenshot", (prev) => errorScreenshotProgress(prev, "Failed to capture."));
          }
          return;
        }
      }
    
      // ---- convertToPdf --------------------------------------------------------
      if (evt.tool === "convertToPdf") {
        if (evt.status === "started") {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "tool", toolUI: initialPdfProgress("page") },
          ]);
          return;
        }
        if (evt.status === "step") {
          upsertProgress("convertToPdf", (prev) => tickPdfProgress(prev, evt.message));
          return;
        }
        if (evt.status === "error") {
          upsertProgress("convertToPdf", (prev) => errorPdfProgress(prev, evt.message));
          return;
        }
        if (evt.status === "done") {
          const r = evt.result as { ok?: boolean; url?: string } | undefined;
          if (r && (r as any).ok) {
            upsertProgress("convertToPdf", (prev) => finalizePdfProgress(prev, r!.url));
          } else {
            upsertProgress("convertToPdf", (prev) => errorPdfProgress(prev, "Failed to render PDF."));
          }
          return;
        }
      }
    
      // other tools → ignore for now
    };
    

    client.onDone = () => setPending(false);
    client.onCleared = () => {
      hydratedRef.current = false;
      setMessages([]);
    };

    const maybeConnect = async () => {
      // @ts-expect-error tiny helper may not be typed on your AgentClient
      if (client.isOpen?.() || client.isConnecting?.()) return;
      try {
        await client.connect();
        // @ts-expect-error flag on the instance to avoid duplicate “model set”
        if (!client._initialModelSent) {
          client.setModel(model);
          // @ts-expect-error flag
          client._initialModelSent = true;
        }
      } catch (e) {
        console.log("[ws] connect suppressed (dev)", e);
      }
    };

    void maybeConnect();
    return () => { /* keep socket open during dev strict mode */ };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- actions --------------------------------------------------------------
  function send(text: string) {
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: text }]);
    setPending(true);
    clientRef.current?.chat(text);
  }
  function changeModel(next: ModelId) {
    setModel(next);
    clientRef.current?.setModel(next);
  }
  function resetChat() {
    clientRef.current?.reset();
    setMessages([]);
  }
  const canReset = useMemo(() => messages.length > 0, [messages]);

  // --- render ---------------------------------------------------------------
  return (
    <div className="bg-app min-h-svh">
      <div className="mx-auto grid min-h-svh w-full place-items-center p-4">
        <div className="w-full max-w-3xl">
          <header className="mb-3 flex items-center justify-between gap-3">
            <div className="text-lg font-semibold">AI Agent Template</div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                aria-label="toggle theme"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                title="Toggle theme"
              >
                {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </Button>
              <Button variant="outline" onClick={resetChat} disabled={!canReset} title="Reset chat">
                Reset
              </Button>
            </div>
          </header>

          <section className="card-surface h-[min(84svh,900px)] p-3">
            <div className="flex h-full flex-col">
              <div ref={scrollRef} className="chat-scroll flex-1 overflow-y-auto px-1 py-2">
                {messages.length === 0 ? (
                  <div className="grid h-full place-items-center">
                    <div className="max-w-md text-center">
                      <h2 className="mb-2 text-2xl font-medium">Agent Starter Template</h2>
                      <p className="mb-4 text-neutral-600 dark:text-neutral-300">
                        This AI Agent template is fully customizable. Swap models, add tools, and theme the UI.
                      </p>
                      <div className="mb-6 text-sm text-neutral-600 dark:text-neutral-300">
                        <div className="mb-1 font-semibold text-neutral-800 dark:text-neutral-200">Available tools:</div>
                        <ul className="list-disc pl-5 text-left">
                          <li>Get Weather Forecast</li>
                          <li>Browse/Screenshot</li>
                          <li>Convert to PDF</li>
                        </ul>
                      </div>
                      <SuggestionChips onPick={send} />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {messages.map((m) =>
                      isToolMessage(m) ? (
                        <div key={m.id} className="px-1">
                          {m.toolUI.kind === "weather" ? (
                            <WeatherWidget
                              result={m.toolUI.data as import("../worker/tools/getWeather").WeatherResult}
                            />
                          ) : (
                            <ToolCard ui={m.toolUI} />
                          )}
                        </div>
                      ) : (
                        <div key={m.id} className="px-1">
                          <MessageBubble role={m.role}>{m.content}</MessageBubble>
                        </div>
                      )
                    )}
                    {(() => {
                      const last = messages[messages.length - 1];
                      const showPending = pending && (!last || last.role !== "assistant");
                      return showPending ? <MessageBubble role="assistant" pending /> : null;
                    })()}
                  </div>
                )}
              </div>

              <div className="mt-2">
                <ChatInput onSend={send} disabled={pending} model={model} onModelChange={changeModel} />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
