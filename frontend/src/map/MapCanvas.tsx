/* The Explorer's map.
 *
 * MapLibre draws the basemap, the raster tiles and the track; deck.gl draws
 * the two things MapLibre cannot do here, which are the district choropleth
 * driven by a live join and the storm label, since the basemap ships no glyph
 * endpoint and MapLibre therefore cannot render text at all.
 *
 * The track used to be a set of deck.gl layers. It is MapLibre now, and that
 * is a bug fix rather than a preference: deck.gl's ScatterplotLayer rendered
 * the per-fix markers as one enormous wedge fanning off the current position
 * and across a quarter of the map on any track with a sharp reversal — the
 * loop Amphan made in the central Bay is the clearest case in this archive —
 * and drew no markers at all. MapLibre's circle and line layers take the same
 * GeoJSON, style it from data-driven expressions, and are the part of the
 * stack every map on the web exercises.
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
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, TextLayer } from "@deck.gl/layers";

import { api, REGIME_COLOR, RISK_COLOR } from "../api/client";
import type { DistrictRisk, StormState, Track } from "../api/types";
import { useStore } from "../state/store";

interface Props {
  track: Track | null;
  state: StormState | null;
  risk: DistrictRisk | null;
  onProbe: (lat: number, lon: number) => void;
  /** Cursor position, so the shell can show a coordinate readout. */
  onHover?: (lat: number, lon: number) => void;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/* The regime palette as a MapLibre match expression, built from the same table
   the panels and the timeline read, so the map cannot drift from the legend. */
const regimeMatch = (fallback: string): any => {
  const out: any[] = ["match", ["get", "regime"]];
  for (const [k, v] of Object.entries(REGIME_COLOR)) out.push(k, v);
  out.push(fallback);
  return out;
};

const EMPTY: any = { type: "FeatureCollection", features: [] };

export default function MapCanvas({ track, state, risk, onProbe, onHover }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
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

  const s = useStore();
  const ordered = useStore((z) => z.visibleOrdered)();
  const derivedActive = ordered.some((l) => l.class === "D");

  /* ---------------------------------------------------------- init */
  useEffect(() => {
    if (!holder.current || map.current) return;
    const m = new maplibregl.Map({
      container: holder.current,
      style: "/api/basemap/style.json",
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

    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }),
                 "bottom-right");
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }),
                 "bottom-left");

    const od = new MapboxOverlay({ interleaved: false, layers: [] });
    m.addControl(od as unknown as maplibregl.IControl);
    overlay.current = od;

    /* `load` alone is not reliable here: it requires every source in the style
       to have finished, and a remount under StrictMode can land the listener
       after that has already happened. `styledata` fires whenever the style
       settles, so readiness is derived from the style rather than from a
       one-shot event that may have been missed. */
    const markReady = () => { if (m.isStyleLoaded()) setReady(true); };
    m.on("load", markReady);
    m.on("styledata", markReady);
    m.on("idle", markReady);

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

  /* ------------------------------------------------ the track's own layers
   *
   * Created once, empty, so every later update is a `setData` on an existing
   * source rather than an add/remove cycle. Adding and removing layers on
   * every scrubber step is what makes a map flicker.
   */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getStyle() || m.getSource("trk")) return;

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
  }, [ready]);

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

    // Rasters go beneath the coastline, and therefore beneath the track too.
    const before = m.getLayer("boundary-coast") ? "boundary-coast" : undefined;
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

  /* ------------------------------------------------------ deck.gl overlays
   *
   * Only what MapLibre cannot do here: a choropleth joined to a live risk
   * table, the swath polygons, and text, since the basemap ships no glyphs.
   */
  useEffect(() => {
    const od = overlay.current;
    if (!od) return;

    const layers: any[] = [];
    const activeIds = new Set(s.active);

    /* District rainfall risk. Categorical bands, never a continuous field. */
    if (activeIds.has("tri_district_risk") && risk && risk.districts.length) {
      const byId = new Map(risk.districts.map((d) => [d.district_id, d]));
      layers.push(
        new GeoJsonLayer({
          id: "district-risk",
          data: "/api/basemap/districts.geojson",
          pickable: true,
          stroked: true,
          filled: true,
          getFillColor: (f: any) => {
            const d = byId.get(f.properties.district_id);
            if (!d) return [0, 0, 0, 0];
            const c = hexToRgb(RISK_COLOR[d.risk_band] ?? "#334155");
            return [c[0], c[1], c[2], 150];
          },
          getLineColor: (f: any) =>
            byId.has(f.properties.district_id) ? [230, 240, 250, 190] : [0, 0, 0, 0],
          getLineWidth: 1,
          lineWidthUnits: "pixels",
          updateTriggers: {
            getFillColor: [risk.valid_time], getLineColor: [risk.valid_time],
          },
          transitions: { getFillColor: 420 },
        }),
      );
    }

    /* Sensor footprint history. Makes the availability mask a visible object. */
    if (activeIds.has("tri_swath_history") && s.stormId && s.at) {
      layers.push(
        new GeoJsonLayer({
          id: "swath-history",
          data: api.vectorUrl("tri_swath_history", s.stormId, s.at),
          stroked: true,
          filled: true,
          pickable: true,
          getFillColor: (f: any) =>
            f.properties.instrument === "pmw" ? [167, 139, 250, 16] : [56, 189, 248, 16],
          getLineColor: (f: any) =>
            f.properties.instrument === "pmw" ? [167, 139, 250, 130] : [56, 189, 248, 130],
          lineWidthUnits: "pixels",
          getLineWidth: 1,
        }),
      );
    }

    /* The label. deck.gl draws it because the basemap has no glyph endpoint,
       so MapLibre cannot render text at all. */
    if (state) {
      layers.push(
        new TextLayer({
          id: "storm-label",
          data: [state],
          getPosition: (d: StormState) => [d.centre.lon, d.centre.lat],
          getText: (d: StormState) =>
            `${d.name.toUpperCase()}  ${d.intensity.vmax_kt?.toFixed(0) ?? "--"} KT`,
          getSize: 11,
          getColor: [236, 246, 250, 240],
          getPixelOffset: [0, -34],
          fontFamily: "ui-monospace, monospace",
          characterSet: "auto",
          getTextAnchor: "middle",
          outlineWidth: 4,
          outlineColor: [4, 6, 10, 255],
          fontSettings: { sdf: true },
          transitions: { getPosition: 420 },
        }),
      );
    }

    od.setProps({ layers });
  }, [state, risk, s.active, s.at, s.stormId]);

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
