/* Response shapes, mirroring the backend contracts in Part VI.
 *
 * These are written out rather than inferred because the layer manifest drives
 * the rendering: if `class` were loosely typed, a component could compare it
 * against a string literal that no longer exists and silently stop hatching a
 * derived layer. `ProvenanceClass` being a union is what makes that a compile
 * error instead.
 */

export type ProvenanceClass = "O" | "R" | "D";
export type Mode = "live" | "replay";

/** The three ways a value can be absent. They render differently. */
export type ValueStatus =
  | "ok"
  | "stale"
  | "expired"
  | "no_coverage"
  | "no_data"
  | "instrument_unavailable"
  | "out_of_domain";

export interface LegendStop {
  value: number;
  rgb: [number, number, number];
}

export interface Layer {
  id: string;
  label: string;
  class: ProvenanceClass;
  source: string;
  render: "raster" | "vector" | "barbs";
  palette: string | null;
  instrument: string | null;
  native_resolution_km: number | null;
  cadence_minutes: number | null;
  units: string | null;
  available_live: boolean;
  staleness_amber_minutes: number | null;
  staleness_expire_minutes: number | null;
  /** Non-null is mandatory when class is D. Enforced by the backend manifest. */
  uncertainty_layer: string | null;
  produced_by: string[];
  disclaimer: string | null;
  synthetic: boolean;
  group: "observed" | "reanalysis" | "derived" | "boundaries";
  default_on: boolean;
  default_opacity: number;
  daylight_only: boolean;
  notes: string | null;
  legend?: LegendStop[];
}

export interface ClassSpec {
  label: string;
  meaning: string;
  chip: string;
  ramp: string;
  hatched: boolean;
  requires_uncertainty_companion?: boolean;
  watermark_when_active?: boolean;
}

export interface Manifest {
  mode: Mode;
  classes: Record<ProvenanceClass, ClassSpec>;
  groups: string[];
  class_order: string[];
  layers: Layer[];
}

export interface StormSummary {
  storm_id: string;
  name: string;
  season: number;
  basin: string;
  start_time: string;
  end_time: string;
  n_fixes: number;
  peak_vmax_kt: number;
  peak_category: string | null;
  made_landfall: boolean;
  featured_slug: string | null;
}

export interface SensorMode {
  present: string[];
  absent: string[];
  ages_minutes: Record<string, number>;
  confidence: "high" | "medium" | "low" | "insufficient";
}

export interface Abstention {
  head: string;
  reason: string;
}

export interface Disagreement {
  trinetra_kt: number | null;
  baseline_kt: number | null;
  baseline_name: string;
  imd_kt: number | null;
  spread_kt: number | null;
  threshold_kt: number;
  above_threshold: boolean;
  driver: string | null;
}

export interface StormState {
  storm_id: string;
  name: string;
  valid_time: string;
  requested_time: string;
  mode: Mode;
  tier: string;
  centre: {
    lat: number;
    lon: number;
    sigma_km: number | null;
    source: string;
    first_guess_lat?: number;
    first_guess_lon?: number;
  };
  intensity: {
    vmax_kt: number | null;
    ci_kt: number | null;
    pmin_hpa: number | null;
    pmin_ci: number | null;
    observed_vmax_kt: number | null;
    observed_pmin_hpa: number | null;
    label_agency: string;
  };
  classification: {
    dvorak_scene: string | null;
    dvorak_conf: number | null;
    dvorak_status: string;
    imd_category: string | null;
    imd_category_label: string | null;
    imd_conf: number | null;
    observed_category: string | null;
    detection: string | null;
    detection_conf: number | null;
  };
  regime: { label: string; conf: number | null; source: string;
            probabilities?: Record<string, number> };
  /** `issued` is separate from `p24` so the API can carry a probability the UI
   *  is instructed not to display. */
  ri: {
    p24: number | null;
    issued: boolean;
    threshold: number;
    above_threshold?: boolean;
    missing_inputs?: string[];
    reason?: string;
    calibration?: string;
  };
  sensor_mode: SensorMode;
  ood: { score: number; threshold: number; in_distribution: boolean;
         ratio: number | null } | null;
  abstentions: Abstention[];
  disagreement: Disagreement;
  environment: Record<string, number | null>;
  environment_provenance: Record<string, string>;
  provenance: {
    model_version: string;
    inference_id: string;
    synthetic_imagery: boolean;
    label_source: string;
    grid: string;
  };
  index: number;
  n_fixes: number;
}

export interface TrackPoint {
  valid_time: string;
  lat: number;
  lon: number;
  vmax_kt: number | null;
  pmin_hpa: number | null;
  category: string | null;
  regime: string;
  dist2land_km: number | null;
  over_land: boolean;
  storm_speed_kt: number | null;
  storm_dir_deg: number | null;
  index: number;
}

export interface RegimeSegment {
  regime: string;
  start_time: string;
  end_time: string;
  points: [number, number][];
}

export interface Track {
  storm_id: string;
  name: string | null;
  points: TrackPoint[];
  regime_segments: RegimeSegment[];
  source: string;
  landfall_index: number | null;
  bulletin_times: string[];
}

export interface FreshnessChannel {
  channel: string;
  units: string;
  present: boolean;
  age_minutes: number | null;
  status: ValueStatus;
  reason: string | null;
  amber_minutes: number;
  expire_minutes: number;
}

export interface Freshness {
  mode: Mode;
  tier: string;
  storm_id: string;
  valid_time: string;
  channels: FreshnessChannel[];
  sensor_mode: SensorMode;
  synthetic_imagery: boolean;
  tier_note: string;
}

export interface ProbeValue {
  layer: string;
  channel?: string;
  class: ProvenanceClass;
  units: string | null;
  value: number | null;
  status: ValueStatus;
  /** A null value always carries a reason. This is the contract. */
  reason?: string | null;
  granule_time: string;
  age_minutes?: number | null;
}

export interface SounderProfile {
  levels_hpa: number[];
  temperature_c: number[];
  rh_percent: number[];
  stability_index: number;
  midlevel_moisture: number;
  granule_time: string;
  age_minutes: number;
  source: string;
  note: string;
}

export interface Probe {
  lat: number;
  lon: number;
  valid_time: string;
  requested_time: string;
  storm_id: string;
  in_domain: boolean;
  land_fraction: number;
  district: { name: string; district_id: string } | null;
  values: ProbeValue[];
  sounder_profile: SounderProfile | null;
  reanalysis: { layer: string; class: "R"; value: number; units: string;
                valid_time: string; note: string }[];
  derived: { layer: string; class: "D"; value: number | null;
             spread: number | null; sensor_mode: string; disclaimer: string }[];
  nearest_system: { id: string; name: string; distance_km: number;
                    bearing: number } | null;
  synthetic_imagery: boolean;
}

export interface EvidenceBar {
  id: string;
  label: string;
  why: string;
  available: boolean;
  channels_present?: string[];
  delta_vmax_kt: number | null;
  delta_sigma_kt: number | null;
  delta_ri: number | null;
  bar: number;
  note?: string;
}

export interface Evidence {
  available: boolean;
  reason?: string;
  method?: string;
  explanation?: string;
  baseline?: { vmax_kt: number; sigma_kt: number; ri_p24: number };
  bars: EvidenceBar[];
  sensor_mode?: SensorMode;
  saliency_url?: string;
  valid_time?: string;
}

export interface Analogue {
  sid: string;
  name: string;
  season: number;
  valid_time: string;
  vmax_kt: number;
  category: string | null;
  regime: string;
  subsequently_ri: boolean | null;
  dv_24h_kt: number | null;
  similarity: number;
}

export interface DistrictRisk {
  storm_id: string;
  valid_time: string;
  regime: string;
  active: boolean;
  corridor_km: number;
  accumulation_window_hours: number;
  bands: { index: number; band: string; label: string; min_mm: number }[];
  districts: {
    district_id: string;
    name: string;
    qpe_accum_mm: number;
    distance_to_track_km: number;
    in_corridor: boolean;
    risk_band: string;
    band_index: number;
    confidence: number | null;
    granules_sampled: number;
  }[];
  provenance_class: "D";
  disclaimer: string;
}

export interface ModeInfo {
  mode: Mode;
  server_clock: string;
  simulated_clock: string;
  replay_storms: StormSummary[];
  n_replay_storms: number;
  model_loaded: boolean;
  model_version: string;
  capabilities: Record<string, unknown>;
  warnings: string[];
  disclaimer: string;
}
