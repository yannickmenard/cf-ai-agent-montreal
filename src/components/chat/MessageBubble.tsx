import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";

export function MessageBubble({
  role,
  children,
  pending,
}: { role: "user" | "assistant"; children?: React.ReactNode; pending?: boolean }) {
  return (
    <div className={cn("flex w-full", role === "user" ? "justify-end" : "justify-start")}>
      <div className={cn("bubble", role === "user" ? "bubble-user" : "bubble-assistant")}>
        {pending ? (
          <span className="inline-flex gap-1">
            <span className="animate-pulse">●</span>
            <span className="animate-pulse [animation-delay:120ms]">●</span>
            <span className="animate-pulse [animation-delay:240ms]">●</span>
          </span>
        ) : (
          <div className="prose-chat">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {String(children ?? "")}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
