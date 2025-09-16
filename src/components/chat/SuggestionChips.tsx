import { Button } from "../ui/button";


export function SuggestionChips({ onPick }: { onPick: (text: string) => void }) {
    const suggestions = [
        "What tools can you use?",
        "Take a screenshot of example.com",
        "What is the weather in Toronto?",
        "Convert developers.cloudflare.com to PDF"
    ];
    return (
        <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
                <Button key={s} variant="outline" size="sm" onClick={() => onPick(s)}>{s}</Button>
            ))}
        </div>
    )
}