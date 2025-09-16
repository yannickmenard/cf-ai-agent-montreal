/// <reference lib="webworker" />

/**
 * Open-Meteo geocoding + forecast wrapper used by the agent.
 * No external deps; small runtime validation; typed throughout.
 */

export type WeatherArgs = {
    location?: string;
    latitude?: number;
    longitude?: number;
    startDate?: string; // YYYY-MM-DD
    endDate?: string;   // YYYY-MM-DD
    days?: number;      // 1..16 (used if no start/end)
    units?: "auto" | "metric" | "imperial";
  };
  
  export type WeatherDay = {
    date: string;     // YYYY-MM-DD
    code: number;     // weathercode
    tMax: number;     // daily max
    tMin: number;     // daily min
    precipMm: number; // precipitation_sum mm
    pop: number;      // precipitation_probability_max %
  };
  
  export type WeatherResult =
    | {
        ok: true;
        place: {
          name: string;
          region?: string;
          country?: string;
          lat: number;
          lon: number;
          timezone: string;
        };
        units: { temp: "°C" | "°F"; precip: "mm" | "in" };
        daily: WeatherDay[];
        notes?: string;
      }
    | {
        ok: false;
        error: string;
      };
  
  /** --- Open-Meteo response types --- */
  type OMGeoResponse = {
    results?: Array<{
      latitude: number;
      longitude: number;
      name: string;
      admin1?: string;
      country?: string;
    }>;
  };
  
  type OMForecastDaily = {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    precipitation_sum?: number[];
    weathercode?: number[];
  };
  
  type OMForecastResponse = {
    timezone?: string;
    daily?: OMForecastDaily;
  };
  /** ---------------------------------- */
  
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  
  /** Resolve lat/lon via Open-Meteo geocoder if needed */
  async function geocodeIfNeeded(
    args: WeatherArgs
  ): Promise<{ lat: number; lon: number; name: string; region?: string; country?: string } | null> {
    if (typeof args.latitude === "number" && typeof args.longitude === "number") {
      return { lat: args.latitude, lon: args.longitude, name: args.location ?? "location" };
    }
    const q = (args.location ?? "").trim();
    if (!q) return null;
  
    const u = new URL("https://geocoding-api.open-meteo.com/v1/search");
    u.searchParams.set("name", q);
    u.searchParams.set("count", "1");
    u.searchParams.set("language", "en");
    u.searchParams.set("format", "json");
  
    const r = await fetch(u.toString());
    if (!r.ok) return null;
  
    const j = (await r.json()) as OMGeoResponse; // ✅ correct type
    const top = (j.results && j.results[0]) || null;
    if (!top) return null;
  
    return { lat: top.latitude, lon: top.longitude, name: top.name, region: top.admin1, country: top.country };
  }
  
  /** Build daily forecast URL */
  function buildForecastUrl(p: {
    lat: number;
    lon: number;
    days?: number;
    start?: string;
    end?: string;
    units?: WeatherArgs["units"];
  }) {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", String(p.lat));
    u.searchParams.set("longitude", String(p.lon));
    u.searchParams.set(
      "daily",
      [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
        "precipitation_probability_max",
        "weathercode",
      ].join(",")
    );
    u.searchParams.set("timezone", "auto");
  
    if (p.start && p.end) {
      u.searchParams.set("start_date", p.start);
      u.searchParams.set("end_date", p.end);
    } else {
      const d = clamp(p.days ?? 7, 1, 16);
      u.searchParams.set("forecast_days", String(d));
    }
  
    // Units: Open-Meteo supports some unit toggles; keep “auto/metric/imperial” simple here
    if (p.units === "imperial") {
      u.searchParams.set("temperature_unit", "fahrenheit");
      u.searchParams.set("precipitation_unit", "inch");
      // u.searchParams.set("wind_speed_unit","mph") // add later if you include wind
    } // else: default C + mm
  
    return u;
  }
  
  function asISODate(s?: string): string | undefined {
    if (!s) return undefined;
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined; // very light check
  }
  
  function unitLabels(units: WeatherArgs["units"]): { temp: "°C" | "°F"; precip: "mm" | "in" } {
    if (units === "imperial") return { temp: "°F", precip: "in" };
    return { temp: "°C", precip: "mm" };
  }
  
  export async function getWeather(args: WeatherArgs): Promise<WeatherResult> {
    try {
      // 1) Resolve coords
      const place = await geocodeIfNeeded(args);
      if (!place) return { ok: false, error: "Please provide a city/location I can find." };
  
      // 2) Build request
      const start = asISODate(args.startDate);
      const end = asISODate(args.endDate);
      const url = buildForecastUrl({ lat: place.lat, lon: place.lon, start, end, days: args.days, units: args.units });
  
      // 3) Fetch forecast
      const r = await fetch(url.toString());
      if (!r.ok) return { ok: false, error: `Weather API error (${r.status})` };
  
      const j = (await r.json()) as OMForecastResponse; // ✅ correct type, parsed once
  
      // 4) Shape out daily rows
      const dates: string[] = Array.isArray(j?.daily?.time) ? j.daily!.time! : [];
      const tMaxs: number[] = Array.isArray(j?.daily?.temperature_2m_max) ? j.daily!.temperature_2m_max! : [];
      const tMins: number[] = Array.isArray(j?.daily?.temperature_2m_min) ? j.daily!.temperature_2m_min! : [];
      const pops: number[] = Array.isArray(j?.daily?.precipitation_probability_max)
        ? j.daily!.precipitation_probability_max!
        : [];
      const precs: number[] = Array.isArray(j?.daily?.precipitation_sum) ? j.daily!.precipitation_sum! : [];
      const codes: number[] = Array.isArray(j?.daily?.weathercode) ? j.daily!.weathercode! : [];
  
      const n = dates.length;
      const daily: WeatherDay[] = [];
      for (let i = 0; i < n; i++) {
        daily.push({
          date: String(dates[i]),
          code: Number(codes[i] ?? 0),
          tMax: Number(tMaxs[i] ?? NaN),
          tMin: Number(tMins[i] ?? NaN),
          precipMm: Number(precs[i] ?? 0),
          pop: Number(pops[i] ?? 0),
        });
      }
  
      const res: WeatherResult = {
        ok: true,
        place: {
          name: place.name,
          region: place.region,
          country: place.country,
          lat: place.lat,
          lon: place.lon,
          timezone: String(j?.timezone ?? "auto"),
        },
        units: unitLabels(args.units ?? "auto"),
        daily,
        notes: start && end ? `Forecast ${start} → ${end}` : `Forecast next ${daily.length} day(s)`,
      };
  
      return res;
    } catch (e) {
      return { ok: false, error: (e as Error).message || "Unknown error" };
    }
  }
  
  /** Tool schema we’ll show the model (keep in agent code too) */
  export const getWeatherToolSchema = {
    type: "function",
    function: {
      name: "getWeather",
      description: "Get a short-range weather forecast (up to ~16 days) for a place or lat/lon.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City or place name, e.g. 'Austin' or 'Los Angeles, CA'." },
          latitude: { type: "number", description: "Latitude in decimal degrees" },
          longitude: { type: "number", description: "Longitude in decimal degrees" },
          startDate: { type: "string", description: "YYYY-MM-DD (optional)" },
          endDate: { type: "string", description: "YYYY-MM-DD (optional)" },
          days: { type: "integer", description: "Fallback if no start/end; 1–16, defaults to 7" },
          units: { type: "string", enum: ["auto", "metric", "imperial"], description: "Defaults to auto" },
        },
        additionalProperties: false,
      },
    },
  } as const;
  