// src/agent/wsClient.ts
export type AgentState = { model: string; messages: Msg[]; createdAt: number; expiresAt: number };

type ReadyMsg   = { type: "ready";   state: AgentState };
type DeltaMsg   = { type: "delta";   text: string };
type DoneMsg    = { type: "done" };
type ClearedMsg = { type: "cleared" };
type Msg = { role: "user" | "assistant" | "tool"; content: string; ts: number };
type ToolMsg = {
  type: "tool";
  tool: string;
  status?: "started" | "step" | "done" | "error";
  message?: string;
  result?: unknown;
};
type ServerMsg  = ReadyMsg | DeltaMsg | DoneMsg | ClearedMsg | ToolMsg;

function getSessionId(): string {
  const k = "sessionId";
  let v = localStorage.getItem(k);
  if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v); }
  return v;
}

export class AgentClient {
  private ws?: WebSocket;
  private sid = getSessionId();
  private connecting = false;

  onReady?:   (s: AgentState) => void;
  onDelta?:   (t: string) => void;
  onDone?:    () => void;
  onCleared?: () => void;
  onTool?: (evt: ToolMsg) => void;
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.isOpen() || this.connecting) return; // StrictMode guard
    this.connecting = true;

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url   = `${proto}://${location.host}/agents/ai-agent/${this.sid}`;
    console.log("[ws] connecting", { url, sessionId: this.sid });

    this.ws = new WebSocket(url);

    await new Promise<void>((resolve) => {
      if (!this.ws) { this.connecting = false; return resolve(); }
      this.ws.onopen = () => { console.log("[ws] open"); this.connecting = false; resolve(); };
      this.ws.onerror = (e) => { console.log("[ws] error", e); /* don't reject in dev */ };
      this.ws.onclose = (e) => { console.log("[ws] close", e.code, e.reason); this.connecting = false; };
      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "ready")   this.onReady?.(msg.state);
          else if (msg.type === "delta")   this.onDelta?.(msg.text);
          else if (msg.type === "done")    this.onDone?.();
          else if (msg.type === "cleared") this.onCleared?.();
          else if (msg.type === "tool")    this.onTool?.(msg as ToolMsg);
        } catch {
          console.log("[ws] non-JSON", ev.data);
        }
      };
    });
  }

  setModel(model: string) { this.#send({ type: "model", model }); }
  reset()                 { this.#send({ type: "reset" }); }
  chat(text: string)      { this.#send({ type: "chat", text }); }
  close()                 { this.ws?.close(); }

  #send(obj: unknown) {
    const s = this.ws;
    if (!s || s.readyState !== WebSocket.OPEN) { console.log("[ws] not open"); return; }
    s.send(JSON.stringify(obj));
  }
}

// --- Singleton (prevents multiple sockets in StrictMode) ---
let __client: AgentClient | null = null;
export function getAgentClient(): AgentClient {
  if (!__client) __client = new AgentClient();
  return __client;
}
