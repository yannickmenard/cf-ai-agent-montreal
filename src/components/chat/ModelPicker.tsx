import { useId } from "react";


export type ModelId = "@cf/meta/llama-4-scout-17b-16e-instruct" | "@hf/nousresearch/hermes-2-pro-mistral-7b";


export function ModelPicker({ value, onChange }: { value: ModelId; onChange: (m: ModelId) => void }) {
const id = useId();
return (
<label htmlFor={id} className="inline-flex items-center gap-2 text-sm text-neutral-400">
Model
<select
id={id}
value={value}
onChange={(e) => onChange(e.target.value as ModelId)}
className="rounded-xl border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-neutral-100"
>
<option value="@cf/meta/llama-4-scout-17b-16e-instruct">Llama 4 Scout 17B</option>
<option value="@hf/nousresearch/hermes-2-pro-mistral-7b">Hermes 2 Pro 7B</option>
</select>
</label>
);
}