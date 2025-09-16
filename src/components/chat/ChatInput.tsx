import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { SendHorizontal } from "lucide-react";
import type { ModelId } from "./ModelPicker";

type Props = {
  onSend: (text: string) => void;
  disabled?: boolean;
  model: ModelId;
  onModelChange: (m: ModelId) => void;
};

export function ChatInput({
  onSend,
  disabled,
  model,
  onModelChange,
}: Props) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // autosize textarea (simple)
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    const next = Math.min(el.scrollHeight, 160); // ~6 lines
    el.style.height = next + "px";
  }, [text]);

  function submit() {
    const v = text.trim();
    if (!v || disabled) return;
    onSend(v);
    setText("");
  }

  return (
    <form
  onSubmit={(e) => { e.preventDefault(); submit(); }}
  className="chat-input flex items-end gap-2 rounded-2xl p-2"
>
  <label className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-300">
    Model
    <select
      value={model}
      onChange={(e) => onModelChange(e.target.value as ModelId)}
      className="bg-transparent outline-none"
    >
      <option value="@cf/meta/llama-4-scout-17b-16e-instruct">Llama 4 Scout 17B</option>
      <option value="@hf/nousresearch/hermes-2-pro-mistral-7b">Hermes 2 Pro 7B</option>
    </select>
  </label>

  <textarea
    ref={taRef}
    className="min-h-[40px] max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-500"
    placeholder="Send a message…"
    value={text}
    onChange={(e) => setText(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    }}
  />

  <Button
    type="submit"
    size="md"
    aria-label="send"
    disabled={disabled || !text.trim()}
    className="shrink-0"
    title="Send"
  >
    <SendHorizontal className="h-4 w-4" />
  </Button>
</form>

  );
}
