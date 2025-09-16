// src/components/chat/WeatherWidget.tsx
import { Card } from "../ui/card";
import { Sun, Cloud, CloudSun, CloudRain, CloudSnow, CloudDrizzle, CloudLightning } from "lucide-react";
import type { WeatherResult } from "../../../worker/tools/getWeather";

function codeToIcon(code: number) {
  // Open-Meteo weathercode buckets (simplified)
  if (code === 0) return <Sun className="h-5 w-5" />;
  if (code >= 1 && code <= 3) return <CloudSun className="h-5 w-5" />;
  if (code === 45 || code === 48) return <Cloud className="h-5 w-5" />;
  if (code >= 51 && code <= 57) return <CloudDrizzle className="h-5 w-5" />;
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return <CloudRain className="h-5 w-5" />;
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return <CloudSnow className="h-5 w-5" />;
  if (code >= 95) return <CloudLightning className="h-5 w-5" />;
  return <Cloud className="h-5 w-5" />;
}

export function WeatherWidget({ result }: { result: WeatherResult }) {
  if (!result.ok) {
    return (
      <Card className="max-w-md border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-200">
        Weather error: {result.error}
      </Card>
    );
  }

  const { place, units, daily } = result;
  const days = daily.slice(0, 5);
  const title = [place.name, place.region, place.country].filter(Boolean).join(", ") || "Weather";

  return (
    <Card className="max-w-md border-neutral-200 bg-white/80 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
      <div className="mb-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">{title}</div>
      <div className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">{place.timezone}</div>

      <div className="grid grid-cols-5 gap-2 text-center">
        {days.map((d) => (
          <div key={d.date} className="rounded-xl border border-neutral-200 bg-white/70 p-2 dark:border-neutral-800 dark:bg-neutral-900/40">
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">{d.date.slice(5)}</div>
            <div className="my-1 flex items-center justify-center">{codeToIcon(d.code)}</div>
            <div className="text-xs font-medium text-neutral-800 dark:text-neutral-100">
              {Number.isFinite(d.tMax) ? Math.round(d.tMax) : "–"}
              {units.temp}
            </div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {Number.isFinite(d.tMin) ? Math.round(d.tMin) : "–"}
              {units.temp}
            </div>
            <div className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              {Number.isFinite(d.pop) ? `${d.pop}%` : "–"}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
