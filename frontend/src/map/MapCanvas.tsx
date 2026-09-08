/* The Explorer's map. MapLibre only.
 *
 * deck.gl used to sit over the top of this for the track, the district
 * choropleth, the swath polygons and the storm label. It is gone, for two
 * reasons.
 *
 * The first is correctness. Its ScatterplotLayer drew no per-fix markers at
 * all and, on any track with a sharp reversal, rendered a single enormous
 * wedge fanning off the current position across a quarter of the map. The loop
 * Amphan made in the central Bay triggered it on a featured case. Bisecting
 * the layer's props showed the geometry and the data were clean and the
 * artifact followed the fill colour, so the fault was in that layer's
 * instanced rendering in this build rather than in the inputs.
 *
 * The second is weight. Three overlays were costing 263 kB gzipped, on a
 * product that has to open over conference wifi. MapLibre draws all four
 * things natively: lines and circles from GeoJSON sources, a choropleth from
 * a match expression over the fourteen districts the risk table actually
 * names, and the label as a positioned DOM element, which the basemap needs
 * anyway because it ships no glyph endpoint and MapLibre cannot render text
 * without one.
 *
 * Four behaviours here are requirements rather than choices.
 *
 * Each raster layer's tile URL carries the scrubber time, so the server
 * resolves that layer's own most recent granule at or before it. Nothing is
 * interpolated across granules to smooth playback.
 *
 * Layer insertion order comes from the store's fixed class ordering, and every
 * raster is inserted beneath the coastline. The coastline is the most
 * important line on this map, because it is where the regime changes and the
 * track keeps going, so it is never buried under an image.
 *
 * The track is split at the scrubber position: solid for the part the replay
 * has reached, faint for the part it has not. That is an observed-versus-not-
 * yet-reached distinction, and it is deliberately not called a forecast,
 * because it is best-track the replay has simply not played yet.
 *
 * A watermark is drawn whenever any class D layer is on, and it is part of the
 * canvas rather than an overlay that could be scrolled away from.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { api, REGIME_COLOR, RISK_COLOR, mapTransformRequest } from "../api/client";
import type { DistrictRisk, StormState, StormSummary, Track } from "../api/types";
import { useStore } from "../state/store";

interface Props {
  track: Track | null;
  state: StormState | null;
  risk: DistrictRisk | null;
  onProbe: (lat: number, lon: number) => void;
  /** Cursor position, so the shell can show a coordinate readout. */
  onHover?: (lat: number, lon: number) => void;
  /** Other storms drawn alongside the selected one, for the overview. Their
   *  tracks are dimmed and unlabelled by colour, so the selected storm stays
   *  the subject of the map. */
  others?: { summary: StormSummary; track: Track }[];
  /** Scenario corridor half-width in km, or null. Explicitly not a forecast
   *  and drawn dashed so it cannot be mistaken for one. */
  scenarioKm?: number | null;
  onSelectStorm?: (id: string) => void;
}

/* The regime palette as a MapLibre match expression, built from the same table
   the panels, the legend and the timeline read, so the map cannot drift from
   its own key. */
const regimeMatch = (fallback: string): any => {
  const out: any[] = ["match", ["get", "regime"]];
  for (const [k, v] of Object.entries(REGIME_COLOR)) out.push(k, v);
  out.push(fallback);
  return out;
};

const EMPTY: any = { type: "FeatureCollection", features: [] };
/* A filter that matches nothing, for a layer that is present but should
   draw no features yet. Comparing against a named sentinel rather than
   against a literal blank: the blank here was a NUL byte, which matched
   nothing correctly but made the whole file read as binary to grep, diff
   and every review tool. */
const NONE: any = ["==", ["get", "district_id"], "__match_nothing__"];

/* Colours for the overview tracks. Distinguishable from each other and from
   the regime palette, so an overview line is never mistaken for a phase on the
   selected storm's own track. */
const OVERVIEW_COLOURS = [
  "#7dd3fc", "#c4b5fd", "#fda4af", "#86efac", "#fcd34d", "#f0abfc",
  "#a5b4fc", "#5eead4",
];

function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

/** A corridor of a given half-width around a polyline.
 *
 * Each vertex is offset perpendicular to the local direction of travel and the
 * two offset lines are joined into a ring. This is a simple offset rather than
 * a true geometric buffer: it does not round the outside of sharp bends and it
 * can pinch on a hairpin. Cyclone-track curvature is gentle at these widths so
 * the difference is not visible, and the alternative is carrying a geometry
 * library in order to draw an illustration.
 *
 * Kilometres per degree of longitude change with latitude, so the offset is
 * recomputed at every vertex rather than once for the line.
 */
function corridorRing(pts: [number, number][], km: number): [number, number][] {
  if (pts.length < 2) return [];
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, pts.length - 1)];
    const [lon, lat] = pts[i];
    const kmLon = 111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
    const dx = (b[0] - a[0]) * kmLon;
    const dy = (b[1] - a[1]) * 110.57;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    left.push([lon + (nx * km) / kmLon, lat + (ny * km) / 110.57]);
    right.push([lon - (nx * km) / kmLon, lat - (ny * km) / 110.57]);
  }
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]);
  return ring;
}


export default function MapCanvas({ track, state, risk, onProbe, onHover,
                                    others = [], scenarioKm = null,
                                    onSelectStorm }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const labelEl = useRef<HTMLDivElement>(null);
  // Map readiness is state, not a ref, and that distinction is a bug fix.
  //
  // A ref does not re-run effects, so with a ref there was a race between the
  // map becoming usable and the store hydrating from the URL: the sync ran
  // through the closure from the first render, where the storm and the
  // scrubber time were still null, so it returned early and never ran again.
  // The result was a map with a coastline and a track and no imagery at all.
  const [ready, setReady] = useState(false);

  /* The map's listeners are registered once, at mount, and a listener
     registered once captures the props from that render forever. `onProbe`
     closes over the selected storm and the scrubber time, both null on the
     first render, so every click for the rest of the session probed with no
     storm and no time, and the API answered about a different storm on a
     different date. The indirection through a ref keeps them current. */
  const onProbeRef = useRef(onProbe);
  onProbeRef.current = onProbe;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const stateRef = useRef(state);
  stateRef.current = state;

  const s = useStore();
  const ordered = useStore((z) => z.visibleOrdered)();
  const derivedActive = ordered.some((l) => l.class === "D");

  /* ---------------------------------------------------------- init */
  useEffect(() => {
    if (!holder.current || map.current) return;
    const m = new maplibregl.Map({
      container: holder.current,
      style: "/api/basemap/style.json",
      // Sends the style document and the sources named inside it to the
      // API rather than to this page's origin. Without it a split
      // deployment loads no basemap at all.
      transformRequest: mapTransformRequest,
      center: [s.lon, s.lat],
      zoom: s.zoom,
      bearing: s.bearing,
      pitch: s.pitch,
      attributionControl: false,
      // The basemap is served locally and has no glyph endpoint, so label
      // rendering is off by design rather than by omission.
      maxZoom: 11,
      minZoom: 2.2,
      dragRotate: true,
      hash: false,
    });
    map.current = m;
    // A handle on the map in development. Debugging a layer-ordering or
    // paint-property problem from the outside means guessing; being able to
    // ask the map what its layer order actually is turns that into one query.
    if (import.meta.env.DEV) (window as any).__trinetraMap = m;

    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }),
                 "bottom-right");
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }),
                 "bottom-left");

    /* Readiness is "the style's layers exist", not "the style is loaded".
     *
     * `load` alone is unreliable: it fires once, and a StrictMode remount can
     * attach the listener after it has already gone. Listening to `styledata`
     * as well fixes that half. The predicate was the other half and was the
     * actual fault: `isStyleLoaded()` was observed sitting at false
     * indefinitely on this style while the basemap drew perfectly well,
     * because it also waits on every source settling and this style carries a
     * 1.4 MB district collection. Nothing errored. The symptom was a map with
     * a coastline and nothing else on it: no track, no rasters, no overlays.
     *
     * What the overlay setup below actually needs is a layer to insert itself
     * before. Testing for that directly, rather than for a proxy that happens
     * to imply it, removes the dependency on sources ever settling. */
    const markReady = () => {
      if (m.getLayer("boundary-coast")) setReady(true);
    };
    m.on("load", markReady);
    m.on("styledata", markReady);
    m.on("idle", markReady);
    markReady();

    // Camera into the store, so the permalink always reflects what is on screen.
    const commit = () => {
      const c = m.getCenter();
      useStore.getState().set({
        lon: c.lng, lat: c.lat, zoom: m.getZoom(),
        bearing: m.getBearing(), pitch: m.getPitch(),
      });
    };
    m.on("moveend", commit);
    m.on("zoomend", commit);
    m.on("rotateend", commit);
    m.on("pitchend", commit);

    /* The label follows the projection rather than the React tree. Repositioning
       on `move` writes a transform on one element, which is far cheaper than a
       render, and it stays pinned during an inertial pan. */
    const place = () => {
      const el = labelEl.current;
      const st = stateRef.current;
      if (!el) return;
      if (!st) { el.style.opacity = "0"; return; }
      const p = m.project([st.centre.lon, st.centre.lat]);
      el.style.transform = `translate(-50%, -100%) translate(${p.x}px, ${p.y - 34}px)`;
      el.style.opacity = "1";
    };
    m.on("move", place);
    m.on("render", place);

    m.on("click", (e) => onProbeRef.current(e.lngLat.lat, e.lngLat.lng));
    m.on("mousemove", (e) => onHoverRef.current?.(e.lngLat.lat, e.lngLat.lng));
    m.getCanvas().style.cursor = "crosshair";

    return () => {
      m.remove();
      map.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------- camera */

  /* The first camera application is a jump, not an ease. The map is built with
     whatever the store holds at mount, and whether that is the permalink's
     viewport or the defaults depends on which finished first. Rather than
     reason about that ordering, the camera is snapped once the style is ready:
     a permalink should open on its view, not fly to it. */
  const pinned = useRef(false);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || pinned.current) return;
    pinned.current = true;
    m.jumpTo({ center: [s.lon, s.lat], zoom: s.zoom, bearing: s.bearing,
               pitch: s.pitch });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !pinned.current) return;
    const c = m.getCenter();
    const moved =
      Math.abs(c.lng - s.lon) > 1e-4 ||
      Math.abs(c.lat - s.lat) > 1e-4 ||
      Math.abs(m.getZoom() - s.zoom) > 1e-3;
    if (moved) {
      m.easeTo({ center: [s.lon, s.lat], zoom: s.zoom, bearing: s.bearing,
                 pitch: s.pitch, duration: 760,
                 easing: (t) => 1 - Math.pow(1 - t, 3) });
    }
  }, [ready, s.lon, s.lat, s.zoom, s.bearing, s.pitch]);

  /* ------------------------------------------------ the overlay layers
   *
   * Created once, empty, so every later update is a `setData` or a paint
   * property on an existing layer rather than an add-and-remove cycle. Adding
   * and removing layers on every scrubber step is what makes a map flicker.
   */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getStyle() || m.getSource("trk")) return;

    /* District rainfall risk, on the district source the basemap already
       loads. Categorical bands, never a continuous field, because the
       underlying accuracy does not support one. It sits below the coastline
       so the coast stays readable over it. */
    const beforeCoast = m.getLayer("boundary-coast") ? "boundary-coast" : undefined;
    m.addLayer({
      id: "risk-fill", type: "fill", source: "districts",
      layout: { visibility: "none" },
      paint: { "fill-color": "#334155", "fill-opacity": 0 },
      filter: NONE,
    }, beforeCoast);
    // Transitions are honoured at runtime but are not part of the paint type,
    // so they are set through setPaintProperty afterwards.
    m.setPaintProperty("risk-fill", "fill-opacity-transition", { duration: 420 });
    m.addLayer({
      id: "risk-line", type: "line", source: "districts",
      layout: { visibility: "none" },
      paint: { "line-color": "#e6f0fa", "line-width": 1, "line-opacity": 0.75 },
      filter: NONE,
    }, beforeCoast);

    /* Sensor footprint history. Makes the availability mask a visible object:
       where nothing has passed over, there is no polygon. */
    m.addSource("swaths", { type: "geojson", data: EMPTY });
    m.addLayer({
      id: "swath-fill", type: "fill", source: "swaths",
      paint: {
        "fill-color": ["match", ["get", "instrument"], "pmw", "#a78bfa", "#38bdf8"],
        "fill-opacity": 0.07,
      },
    }, beforeCoast);
    m.addLayer({
      id: "swath-line", type: "line", source: "swaths",
      paint: {
        "line-color": ["match", ["get", "instrument"], "pmw", "#a78bfa", "#38bdf8"],
        "line-width": 1, "line-opacity": 0.5, "line-dasharray": [3, 2],
      },
    }, beforeCoast);

    /* The track, above everything. */
    m.addSource("trk", { type: "geojson", data: EMPTY });
    m.addSource("trk-fix", { type: "geojson", data: EMPTY });
    m.addSource("trk-now", { type: "geojson", data: EMPTY });

    // Wide, low-alpha pass first: it reads as a glow at every zoom without a
    // shader, and it is what keeps a 3 px line legible over bright infrared.
    m.addLayer({
      id: "trk-glow", type: "line", source: "trk",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": regimeMatch("#38bdf8"),
        "line-width": 10,
        "line-blur": 5,
        "line-opacity": ["case", ["get", "reached"], 0.32, 0.08],
      },
    });
    m.addLayer({
      id: "trk-line", type: "line", source: "trk",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": regimeMatch("#38bdf8"),
        "line-width": 2.6,
        "line-opacity": ["case", ["get", "reached"], 0.95, 0.3],
      },
    });
    // One circle per best-track fix, sized by intensity. Intensity is drawn
    // along the track and never painted as a field, because a scalar has no
    // value at an arbitrary grid point.
    m.addLayer({
      id: "trk-fix", type: "circle", source: "trk-fix",
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["get", "vmax"],
          0, 2.2, 40, 3.4, 90, 5, 140, 6.6,
        ],
        "circle-color": regimeMatch("#38bdf8"),
        "circle-opacity": ["case", ["get", "reached"], 0.92, 0.26],
        "circle-stroke-width": 0.9,
        "circle-stroke-color": "#05080c",
        "circle-stroke-opacity": ["case", ["get", "reached"], 0.85, 0.2],
      },
    });
    // The current fix: a soft beacon, a ring whose thickness is the method
    // spread, and a white centre. Disagreement is shown on the map exactly
    // where it is genuinely spatial, and nowhere else.
    m.addLayer({
      id: "now-beacon", type: "circle", source: "trk-now",
      paint: {
        "circle-radius": 28,
        "circle-color": ["case", ["get", "flagged"], "#f87171", "#4fe0cf"],
        "circle-opacity": 0.13,
        "circle-blur": 0.7,
      },
    });
    m.addLayer({
      id: "now-ring", type: "circle", source: "trk-now",
      paint: {
        "circle-radius": 13,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-width": ["get", "ring"],
        "circle-stroke-color": ["case", ["get", "flagged"], "#f87171", "#8ff5e6"],
        "circle-stroke-opacity": 0.92,
      },
    });
    m.addLayer({
      id: "now-dot", type: "circle", source: "trk-now",
      paint: {
        "circle-radius": 4.5,
        "circle-color": "#f2fbfd",
        "circle-stroke-width": 1.2,
        "circle-stroke-color": "#05080c",
      },
    });

    /* Scenario corridor. Dashed and warm-toned, deliberately unlike anything
       the model produces, because it illustrates how far a track can shift and
       is not an uncertainty the system has verified. Below the selected track
       so it never obscures it. */
    m.addSource("corridor", { type: "geojson", data: EMPTY });
    m.addLayer({
      id: "corridor-fill", type: "fill", source: "corridor",
      paint: { "fill-color": "#fbbf24", "fill-opacity": 0.11 },
    }, "trk-glow");
    m.addLayer({
      id: "corridor-line", type: "line", source: "corridor",
      paint: {
        "line-color": "#fcd34d", "line-width": 1.7, "line-opacity": 0.8,
        "line-dasharray": [3, 2.2],
      },
    }, "trk-glow");

    /* Other storms, for the overview. One dim line each, beneath the selected
       storm's track so the subject of the map stays obvious, plus a clickable
       dot at each last recorded position. */
    m.addSource("others", { type: "geojson", data: EMPTY });
    m.addSource("others-end", { type: "geojson", data: EMPTY });
    m.addLayer({
      id: "others-line", type: "line", source: "others",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "colour"], "line-width": 1.4,
               "line-opacity": 0.4 },
    }, "corridor-fill");
    m.addLayer({
      id: "others-end", type: "circle", source: "others-end",
      paint: {
        "circle-radius": 5,
        "circle-color": ["get", "colour"],
        "circle-opacity": 0.8,
        "circle-stroke-width": 1.2,
        "circle-stroke-color": "#05080c",
      },
    }, "corridor-fill");
  }, [ready]);

  /* Feed the scenario corridor. */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getSource("corridor")) return;
    const src = m.getSource("corridor") as maplibregl.GeoJSONSource;
    if (!scenarioKm || !track || track.points.length < 2) {
      src.setData(EMPTY);
      return;
    }
    const ring = corridorRing(
      track.points.map((p) => [p.lon, p.lat] as [number, number]), scenarioKm);
    src.setData({
      type: "FeatureCollection",
      features: ring.length
        ? [{ type: "Feature", properties: { km: scenarioKm },
             geometry: { type: "Polygon", coordinates: [ring] } }]
        : [],
    } as any);
  }, [ready, scenarioKm, track]);

  /* Feed the overview storms. */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getSource("others")) return;
    const lineSrc = m.getSource("others") as maplibregl.GeoJSONSource;
    const endSrc = m.getSource("others-end") as maplibregl.GeoJSONSource;

    const lines: any[] = [];
    const ends: any[] = [];
    for (const o of others) {
      if (!o.track?.points?.length) continue;
      const coords = o.track.points.map((p) => [p.lon, p.lat]);
      // Colour derived from the id, so a storm keeps the same colour across
      // renders and across scope changes.
      const colour = OVERVIEW_COLOURS[
        Math.abs(hashCode(o.summary.storm_id)) % OVERVIEW_COLOURS.length];
      const props = { colour, storm_id: o.summary.storm_id,
                      name: o.summary.name };
      lines.push({ type: "Feature", properties: props,
                   geometry: { type: "LineString", coordinates: coords } });
      ends.push({ type: "Feature", properties: props,
                  geometry: { type: "Point",
                              coordinates: coords[coords.length - 1] } });
    }
    lineSrc.setData({ type: "FeatureCollection", features: lines } as any);
    endSrc.setData({ type: "FeatureCollection", features: ends } as any);
  }, [ready, others]);

  /* Clicking another storm's end dot selects it. */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getLayer("others-end")) return;
    const onClick = (e: any) => {
      const id = e.features?.[0]?.properties?.storm_id;
      if (id && onSelectStorm) onSelectStorm(id);
    };
    const enter = () => { m.getCanvas().style.cursor = "pointer"; };
    const leave = () => { m.getCanvas().style.cursor = "crosshair"; };
    m.on("click", "others-end", onClick);
    m.on("mouseenter", "others-end", enter);
    m.on("mouseleave", "others-end", leave);
    return () => {
      m.off("click", "others-end", onClick);
      m.off("mouseenter", "others-end", enter);
      m.off("mouseleave", "others-end", leave);
    };
  }, [ready, onSelectStorm]);

  /* Feed the track layers. */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getSource("trk")) return;
    const cutoff = s.at ? new Date(s.at).getTime() : Infinity;
    const reached = (t: string) => new Date(t).getTime() <= cutoff;

    const show = s.active.includes("tri_regime_segments") ||
      s.active.includes("tri_track_intensity");

    const lines = (show && track)
      ? {
          type: "FeatureCollection",
          features: track.regime_segments.map((seg) => ({
            type: "Feature",
            properties: { regime: seg.regime, reached: reached(seg.start_time) },
            geometry: { type: "LineString", coordinates: seg.points },
          })),
        }
      : EMPTY;

    const fixes = (show && track)
      ? {
          type: "FeatureCollection",
          features: track.points.map((p) => ({
            type: "Feature",
            properties: {
              regime: p.regime, vmax: p.vmax_kt ?? 0,
              reached: reached(p.valid_time),
            },
            geometry: { type: "Point", coordinates: [p.lon, p.lat] },
          })),
        }
      : EMPTY;

    (m.getSource("trk") as maplibregl.GeoJSONSource).setData(lines as any);
    (m.getSource("trk-fix") as maplibregl.GeoJSONSource).setData(fixes as any);
  }, [ready, track, s.at, s.active]);

  /* Feed the current-fix marker. */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getSource("trk-now")) return;
    const spread = state?.disagreement.spread_kt ?? 0;
    const data = state
      ? {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: {
              flagged: Boolean(state.disagreement.above_threshold),
              ring: Math.min(1.2 + spread * 0.5, 7),
            },
            geometry: {
              type: "Point",
              coordinates: [state.centre.lon, state.centre.lat],
            },
          }],
        }
      : EMPTY;
    (m.getSource("trk-now") as maplibregl.GeoJSONSource).setData(data as any);
  }, [ready, state]);

  /* District risk: a match expression over the districts the risk table names,
     which is a corridor of a dozen or so rather than all 735. */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getLayer("risk-fill")) return;
    const on = s.active.includes("tri_district_risk") &&
      Boolean(risk?.districts.length);

    m.setLayoutProperty("risk-fill", "visibility", on ? "visible" : "none");
    m.setLayoutProperty("risk-line", "visibility", on ? "visible" : "none");
    if (!on || !risk) return;

    const colour: any[] = ["match", ["get", "district_id"]];
    const ids: string[] = [];
    for (const d of risk.districts) {
      colour.push(d.district_id, RISK_COLOR[d.risk_band] ?? "#334155");
      ids.push(d.district_id);
    }
    colour.push("#334155");

    const filter: any = ["in", ["get", "district_id"], ["literal", ids]];
    m.setFilter("risk-fill", filter);
    m.setFilter("risk-line", filter);
    m.setPaintProperty("risk-fill", "fill-color", colour);
    m.setPaintProperty("risk-fill", "fill-opacity", 0.58);
  }, [ready, risk, s.active]);

  /* Swath history. MapLibre fetches the URL itself, so a scrubber move is one
     request and no client-side parsing. */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getSource("swaths")) return;
    const on = s.active.includes("tri_swath_history") && s.stormId && s.at;
    const src = m.getSource("swaths") as maplibregl.GeoJSONSource;
    src.setData(on
      ? (api.vectorUrl("tri_swath_history", s.stormId!, s.at!) as any)
      : EMPTY);
  }, [ready, s.active, s.stormId, s.at]);

  /* ---------------------------------------------------------- raster layers */
  const rasterKey = useMemo(
    () => JSON.stringify({
      ids: ordered.filter((l) => l.render === "raster").map((l) => l.id),
      at: s.at, storm: s.stormId,
      op: ordered.map((l) => s.opacity[l.id] ?? 1),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ordered, s.at, s.stormId, s.opacity],
  );

  const syncRasters = () => {
    const m = map.current;
    if (!m || !ready || !s.stormId || !s.at) return;

    // A removed map keeps answering method calls but has no style, so
    // `getStyle()` returns undefined and every read off it throws. That
    // happens for real: an effect scheduled before a remount runs after the
    // cleanup has torn the map down. Bail rather than throw.
    const style = m.getStyle();
    if (!style) return;

    const wanted = ordered.filter((l) => l.render === "raster");
    const wantedIds = new Set(wanted.map((l) => `tri-${l.id}`));

    for (const layer of style.layers ?? []) {
      if (layer.id.startsWith("tri-") && !wantedIds.has(layer.id)) {
        if (m.getLayer(layer.id)) m.removeLayer(layer.id);
        if (m.getSource(layer.id)) m.removeSource(layer.id);
      }
    }

    // Rasters go beneath the district risk, and therefore beneath the
    // coastline and the track too.
    const before = m.getLayer("risk-fill")
      ? "risk-fill"
      : (m.getLayer("boundary-coast") ? "boundary-coast" : undefined);

    for (const l of wanted) {
      const id = `tri-${l.id}`;
      const url = api.tileUrl(l.id, s.stormId, s.at);
      const existing = m.getSource(id) as maplibregl.RasterTileSource | undefined;

      if (!existing) {
        m.addSource(id, {
          type: "raster", tiles: [url], tileSize: 256, minzoom: 0, maxzoom: 11,
          // No attribution string: the provenance lives in the layer panel and
          // the legend, where it carries the instrument, product and age.
        });
        m.addLayer(
          { id, type: "raster", source: id,
            paint: { "raster-opacity": s.opacity[l.id] ?? l.default_opacity,
                     "raster-fade-duration": 220,
                     "raster-resampling": "linear" } },
          before,
        );
        m.setPaintProperty(id, "raster-opacity-transition", { duration: 260 });
      } else {
        // Changing the tile URL is how a scrubber move propagates. setTiles
        // keeps the source and re-requests, far cheaper than removing and
        // re-adding the layer, and it avoids a flash of empty map.
        existing.setTiles([url]);
        m.setPaintProperty(id, "raster-opacity",
                           s.opacity[l.id] ?? l.default_opacity);
      }
    }

    for (const l of wanted) {
      const id = `tri-${l.id}`;
      if (m.getLayer(id) && before) m.moveLayer(id, before);
    }
  };

  useEffect(syncRasters, [rasterKey, ready]);

  /* ---------------------------------------------------------- follow mode */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !s.follow || !state) return;
    m.easeTo({ center: [state.centre.lon, state.centre.lat], duration: 760,
               easing: (t) => 1 - Math.pow(1 - t, 3) });
  }, [ready, s.follow, state?.centre.lat, state?.centre.lon]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={holder} style={{ position: "absolute", inset: 0 }} />

      {/* The storm label. A DOM element rather than a map symbol, because the
          basemap ships no glyph endpoint; it also renders in the real UI font
          instead of a texture atlas, which is sharper at every zoom. */}
      <div
        ref={labelEl}
        aria-hidden
        style={{
          position: "absolute", top: 0, left: 0, pointerEvents: "none",
          opacity: 0, whiteSpace: "nowrap",
          fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em",
          color: "#ecf6fa",
          textShadow:
            "0 0 4px rgba(4,6,10,0.95), 0 1px 3px rgba(4,6,10,0.95)",
          transition: "opacity var(--t) var(--ease-out)",
        }}
      >
        {state
          ? `${state.name.toUpperCase()}  ${
              state.intensity.vmax_kt?.toFixed(0) ?? "--"} KT`
          : ""}
      </div>

      {/* A vignette, so the floating panels have a darker ground to sit on at
          the edges without the middle of the map being dimmed. */}
      <div
        aria-hidden
        style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          background:
            "radial-gradient(ellipse 76% 72% at 50% 46%, transparent 44%, " +
            "rgba(3,5,8,0.62) 100%)",
        }}
      />

      {/* Persistent watermark whenever any derived layer is active. Part of the
          map, always visible, and not dismissible. */}
      {derivedActive && (
        <div
          className="fade"
          style={{
            position: "absolute", right: 16, bottom: 96, pointerEvents: "none",
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.18em",
            color: "var(--class-d)", opacity: 0.55, textAlign: "right",
            textShadow: "0 1px 3px rgba(0,0,0,0.9)",
          }}
        >
          <div style={{ fontSize: 13, letterSpacing: "0.26em" }}>TRINETRA</div>
          <div>DERIVED LAYER ACTIVE</div>
        </div>
      )}
    </div>
  );
}
