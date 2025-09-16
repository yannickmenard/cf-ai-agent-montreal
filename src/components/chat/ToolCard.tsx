import { Card, CardDescription, CardTitle } from "../ui/card";
import { Check, Loader2, X } from "lucide-react";

export type StepState = "idle" | "active" | "done" | "error";
export type ToolProgress = {
  tool: "getWeather" | "screenshot" | "convertToPdf" | string;
  phase: "running" | "done" | "error";
  steps: Array<{ key: string; label: string; state: StepState; note?: string }>;
  error?: string;
};

export type ToolUI = {
  // add "pdf"
  kind: "progress" | "screenshot" | "pdf" | "generic" | "weather";
  title?: string;
  subtitle?: string;
  // allow "pdf" preview
  media?: { type: "image" | "pdf" | "json" | "text"; url?: string; bytesBase64?: string };
  metrics?: Array<{ label: string; value: string }>;
  sourceUrl?: string;
  downloadUrl?: string;
  progress?: ToolProgress;
  data?: unknown;
};

function StepDot({ state }: { state: StepState }) {
  if (state === "active") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (state === "done") return <Check className="h-4 w-4" />;
  if (state === "error") return <X className="h-4 w-4" />;
  return <div className="h-2 w-2 rounded-full bg-neutral-400" />;
}

export function ToolCard({ ui }: { ui: ToolUI }) {
  // 1) PROGRESS (agnostic, compact) + tiny preview when done
  if (ui.kind === "progress") {
    const steps = ui.progress?.steps ?? [];
    const phase = ui.progress?.phase ?? "running";
    const isError = phase === "error";
    const isDone = phase === "done";

    return (
      <Card className="max-w-md border-neutral-200 bg-white/80 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
        {ui.title && <CardTitle className="text-base">{ui.title}</CardTitle>}
        {ui.subtitle && <CardDescription className="mb-2">{ui.subtitle}</CardDescription>}

        <ol className="space-y-2">
          {steps.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-sm">
              <StepDot state={s.state} />
              <span className="text-neutral-800 dark:text-neutral-200">{s.label}</span>
              {s.note && <span className="text-neutral-500 dark:text-neutral-400">— {s.note}</span>}
            </li>
          ))}
        </ol>

        {isError && ui.progress?.error && (
          <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-200">
            {ui.progress.error}
          </div>
        )}

        {/* Compact preview under the steps when finished */}
        {isDone && ui.media?.url && (
          <div className="mt-3">
            {ui.media.type === "image" ? (
              <a
                href={ui.downloadUrl ?? ui.media.url}
                target="_blank"
                rel="noreferrer"
                download
                className="block overflow-hidden rounded-xl border border-neutral-300 dark:border-neutral-700"
              >
                <img
                  src={ui.media.url}
                  alt={ui.title ?? "Screenshot"}
                  className="block h-40 w-full object-cover"
                  loading="lazy"
                />
              </a>
            ) : ui.media.type === "pdf" ? (
              <a
                href={ui.downloadUrl ?? ui.media.url}
                target="_blank"
                rel="noreferrer"
                download
                className="block overflow-hidden rounded-xl border border-neutral-300 dark:border-neutral-700"
                title="Open PDF"
              >
                <object
                  data={ui.media.url}
                  type="application/pdf"
                  width="100%"
                  height="180"
                >
                  <span className="block p-2 text-xs text-neutral-600 dark:text-neutral-300">
                    Preview unavailable — click to download
                  </span>
                </object>
              </a>
            ) : null}
          </div>
        )}
      </Card>
    );
  }

  // 2) SCREENSHOT (optional standalone card; kept as-is)
  if (ui.kind === "screenshot") {
    return (
      <Card className="max-w-md border-neutral-200 bg-white/80 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
        {ui.title && <CardTitle className="mb-1 text-base">{ui.title}</CardTitle>}
        {ui.media?.url && (
          <a
            href={ui.downloadUrl ?? ui.media.url}
            target="_blank"
            rel="noreferrer"
            download
            className="block overflow-hidden rounded-2xl border border-neutral-300 dark:border-neutral-700"
          >
            <img src={ui.media.url} alt={ui.title ?? "Screenshot"} className="w-full object-cover" />
          </a>
        )}
        {ui.subtitle && <CardDescription className="mt-2">{ui.subtitle}</CardDescription>}
      </Card>
    );
  }

  // 3) PDF (optional standalone card)
  if (ui.kind === "pdf") {
    return (
      <Card className="max-w-md border-neutral-200 bg-white/80 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
        {ui.title && <CardTitle className="mb-1 text-base">{ui.title}</CardTitle>}
        {ui.media?.url && (
          <a
            href={ui.downloadUrl ?? ui.media.url}
            target="_blank"
            rel="noreferrer"
            download
            className="block overflow-hidden rounded-2xl border border-neutral-300 dark:border-neutral-700"
          >
            <object data={ui.media.url} type="application/pdf" width="100%" height="200" />
          </a>
        )}
        {ui.subtitle && <CardDescription className="mt-2">{ui.subtitle}</CardDescription>}
      </Card>
    );
  }

  // 4) GENERIC
  return (
    <Card className="max-w-md border-neutral-200 bg-white/80 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
      {ui.title && <CardTitle className="text-base">{ui.title}</CardTitle>}
      {ui.subtitle && <CardDescription>{ui.subtitle}</CardDescription>}
    </Card>
  );
}
