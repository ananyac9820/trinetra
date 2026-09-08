/* API client.
 *
 * Two things here are not boilerplate.
 *
 * `tileUrl` builds the raster template MapLibre consumes, and every layer's
 * URL carries the storm and the scrubber time. That is what makes each layer
 * snap independently to its own most recent granule: the server resolves the
 * time per layer and reports what it actually used in X-Granule-Time, so the
 * client never has to interpolate and never has to guess.
 *
 * `readGranuleTime` exists because a tile's real observation time only arrives
 * as a response header. The age indicator needs it, and fetching the tile again
 * as JSON to find out would double the traffic, so the client issues a single
 * HEAD per layer per scrubber position instead.
 */

import type {
  Changes, DistrictRisk, Evidence, Freshness, Hazard, HazardTimeline,
  LocationImpact, Manifest, ModeInfo, Probe, StormState, StormSummary, Track,
  Analogue,
} from "./types";

const BASE = import.meta.env.VITE_API_BASE ?? "";

class ApiError extends Error {
  constructor(public status: number, public path: string, message: string) {
    super(`${status} on ${path}: ${message}`);
  }
}

async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new ApiError(res.status, path, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

export const api = {
  mode: () => get<ModeInfo>("/api/mode"),
  layers: () => get<Manifest>("/api/layers"),
  storms: () => get<{ mode: string; storms: StormSummary[] }>("/api/storms"),
  freshness: (stormId?: string, at?: string) =>
    get<Freshness>("/api/freshness", { storm_id: stormId, at }),
  state: (stormId: string, at?: string) =>
    get<StormState>(`/api/storms/${encodeURIComponent(stormId)}/state`, { at }),
  track: (stormId: string, upto?: string) =>
    get<Track>(`/api/storms/${encodeURIComponent(stormId)}/track`, { upto }),
  evidence: (stormId: string, at?: string) =>
    get<Evidence>(`/api/storms/${encodeURIComponent(stormId)}/evidence`, { at }),
  disagreement: (stormId: string) =>
    get<any>(`/api/storms/${encodeURIComponent(stormId)}/disagreement`),
  analogues: (stormId: string, at?: string, k = 5) =>
    get<{ available: boolean; reason?: string; analogues: Analogue[]; note?: string }>(
      `/api/storms/${encodeURIComponent(stormId)}/analogues`, { at, k }),
  probe: (lat: number, lon: number, stormId?: string, at?: string) =>
    get<Probe>("/api/probe", { lat, lon, storm_id: stormId, at }),
  districtRisk: (stormId?: string, at?: string) =>
    get<DistrictRisk>("/api/districts/risk", { storm_id: stormId, at }),
  /* ---- Impact Mode.
   *
   * The hazard call is a rule set over the model's outputs rather than a
   * second model, and every response carries the `basis` string that says so.
   * The UI renders it. */
  hazard: (stormId: string, at?: string) =>
    get<Hazard>(`/api/storms/${encodeURIComponent(stormId)}/hazard`, { at }),
  hazardTimeline: (stormId: string, maxPoints = 60) =>
    get<HazardTimeline>(
      `/api/storms/${encodeURIComponent(stormId)}/hazard/timeline`,
      { max_points: maxPoints }),
  changes: (stormId: string, at?: string, hours = 6) =>
    get<Changes>(`/api/storms/${encodeURIComponent(stormId)}/changes`,
                 { at, hours }),
  impact: (lat: number, lon: number, stormId: string, at?: string) =>
    get<LocationImpact>("/api/impact", { lat, lon, storm_id: stormId, at }),

  methods: () => get<any>("/api/methods"),
  capabilities: () => get<any>("/api/capabilities"),
  presets: () => get<{ presets: Record<string, { label: string; bbox: number[] }> }>(
    "/api/basemap/presets"),

  /** Raster tile template for MapLibre. */
  tileUrl(layerId: string, stormId: string, at: string, opacity = 1): string {
    const q = new URLSearchParams({ storm_id: stormId, at });
    if (opacity < 1) q.set("opacity", String(opacity));
    return `${BASE}/api/tiles/${layerId}/{z}/{x}/{y}.png?${q.toString()}`;
  },

  vectorUrl(layerId: string, stormId: string, at: string): string {
    const q = new URLSearchParams({ storm_id: stormId, at });
    return `${BASE}/api/vector/${layerId}.geojson?${q.toString()}`;
  },

  legendUrl(layerId: string): string {
    return `${BASE}/api/legend/${layerId}.png`;
  },

  /** The observation time and status a layer actually resolved to.
   *
   *  A HEAD request, because the answer is in the headers. This is what lets a
   *  layer chip display its own age against the scrubber position without the
   *  client interpolating anything.
   */
  async readGranuleTime(layerId: string, stormId: string, at: string) {
    const url = `${BASE}/api/tiles/${layerId}/4/11/6.png?storm_id=${encodeURIComponent(
      stormId)}&at=${encodeURIComponent(at)}`;
    try {
      const res = await fetch(url, { method: "HEAD" });
      return {
        granuleTime: res.headers.get("x-granule-time") ?? null,
        status: res.headers.get("x-status") ?? (res.ok ? "ok" : "no-data"),
        reason: res.headers.get("x-reason"),
        provenanceClass: res.headers.get("x-provenance-class"),
        synthetic: res.headers.get("x-synthetic") === "true",
        empty: res.status === 204,
      };
    } catch {
      return { granuleTime: null, status: "error", reason: "request failed",
               provenanceClass: null, synthetic: false, empty: true };
    }
  },

  reportUrl(stormId: string, fmt: string, at?: string): string {
    const q = new URLSearchParams(at ? { at } : {});
    return `${BASE}/api/storms/${encodeURIComponent(stormId)}/report/${fmt}?${q}`;
  },

  async upload(file: File, declaredInstrument: string, channelMap?: Record<string, string>) {
    const body = new FormData();
    body.append("file", file);
    const q = new URLSearchParams({ declared_instrument: declaredInstrument });
    if (channelMap && Object.keys(channelMap).length) {
      q.set("channel_map", JSON.stringify(channelMap));
    }
    const res = await fetch(`${BASE}/api/upload?${q}`, { method: "POST", body });
    return await res.json();
  },

  liveSocket(): WebSocket {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return new WebSocket(`${proto}://${window.location.host}/ws/live`);
  },
};

export { ApiError };

/* ---------------------------------------------------------------- formatting
 *
 * Age formatting lives here rather than in components because the age strip,
 * the layer chips and the probe all have to agree. Two components disagreeing
 * about whether 190 minutes reads as "3h 10m" or "190m" looks like a bug in the
 * data.
 */

export function formatAge(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !isFinite(minutes)) return "--";
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h${String(r).padStart(2, "0")}m` : `${h}h`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return h ? `${d}d${h}h` : `${d}d`;
}

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "--";
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  if (isNaN(d.getTime())) return "--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function formatUtcShort(iso: string | null | undefined): string {
  if (!iso) return "--";
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  if (isNaN(d.getTime())) return "--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes())}Z`;
}

/** A number, or an em-dash-free placeholder. Never a zero standing in for
 *  "unknown", which is the confusion this whole product exists to prevent. */
export function num(v: number | null | undefined, digits = 0, unit = ""): string {
  if (v === null || v === undefined || !isFinite(v)) return "--";
  return `${v.toFixed(digits)}${unit ? " " + unit : ""}`;
}

export const REGIME_LABEL: Record<string, string> = {
  maritime_mature: "Maritime mature",
  sheared: "Sheared",
  post_landfall_remnant: "Post-landfall remnant",
  over_land: "Over land",
};

export const REGIME_COLOR: Record<string, string> = {
  maritime_mature: "#38bdf8",
  sheared: "#a78bfa",
  post_landfall_remnant: "#fb923c",
  over_land: "#f87171",
};

/** Risk band colours. Three levels only, because the inputs do not support a
 *  finer scale and a five-stop ramp would imply precision that is not there. */
export const BAND_COLOR: Record<string, string> = {
  low: "#4ade80",
  moderate: "#fbbf24",
  high: "#f87171",
};

export const BAND_LABEL: Record<string, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
};

export const CONFIDENCE_LABEL: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  insufficient: "Not enough data",
};

export const RISK_COLOR: Record<string, string> = {
  none: "#334155",
  low: "#0e7490",
  moderate: "#ca8a04",
  high: "#ea580c",
  very_high: "#b91c1c",
};
