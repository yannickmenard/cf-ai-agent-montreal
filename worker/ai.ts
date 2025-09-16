/// <reference lib="webworker" />
import type { AIBinding, ChatMessage } from "../worker-configuration";

/** Stream Workers AI SSE, emitting deltas and returning the final text. */
export async function streamAI(
  AI: AIBinding,
  model: string,
  messages: ChatMessage[],
  onDelta: (t: string) => void
): Promise<string> {
  const s = (await AI.run(model, { messages, stream: true })) as ReadableStream<Uint8Array>;
  const reader = s.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return full;

      try {
        const j = JSON.parse(payload) as {
          delta?: { content?: string };
          response?: Array<{ content?: Array<{ text?: string }> }>;
          output_text?: string;
          text?: string;
        };
        const delta =
          j.delta?.content ??
          j.response?.[0]?.content?.[0]?.text ??
          j.output_text ??
          j.text ??
          "";
        if (delta) { onDelta(delta); full += delta; }
      } catch {
        onDelta(payload); full += payload;
      }
    }
  }
  return full;
}
