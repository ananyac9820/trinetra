/* The Explorer's map.
 *
 * MapLibre for the basemap and raster tiles, deck.gl over the top for the
 * vector overlays, which is the split the tech stack calls for: MapLibre
 * handles tiles and camera, deck.gl handles large scatterometer barb fields and
 * swath polygons at interactive frame rates.
 *
 * Four behaviours here are requirements rather than choices.
 *
 * Each raster layer's tile URL carries the scrubber time, so the server resolves
 * that layer's own most recent granule at or before it. Nothing is interpolated
 * across granules to smooth playback, and nothing is resampled in time on the
 * client.
 *
 * Layer insertion order comes from the store's fixed class ordering, and every
 * data layer is inserted beneath the `boundary-coast` layer by id. The coastline
 * is the most important line on this map, because it is where the regime changes
 * and the track keeps going, so it is never buried under a raster.
 *
 * The track is split at the scrubber position: the part the replay has reached
 * is drawn solid, the part it has not is drawn faint. That is an observed-
 * versus-not-yet-reached distinction and it is deliberately not called a
 * forecast, because it is best-track the replay has simply not played yet.
 *
 * A watermark is drawn whenever any class D layer is on, and it is part of the
 * canvas rather than an overlay that could be scrolled away from.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";

import { api, REGIME_COLOR, RISK_COLOR } from "../api/client";
import type { DistrictRisk, StormState, Track, TrackPoint } from "../api/types";
import { useStore } from "../state/store";

interface Props {
  track: Track | null;
  state: StormState | null;
  risk: DistrictRisk | null;
  onProbe: (lat: number, lon: number) => void;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export default function MapCanvas({ track, state, risk, onProbe }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  // Map readiness is state, not a ref, and that distinction is a bug fix.
  //
  // A ref does not re-run effects, so with a ref there was a race between the
  // map becoming usable and the store hydrating from the URL: the handler
  // called syncRasters through the closure from the first render, where the
  // storm and the scrubber time were still null, so it returned early, and
  // rasterKey never changed again. The result was a map with a coastline and a
  // track and no raster layers at all.
  const [ready, setReady] = useState(false);

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

    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-left");

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

    m.on("click", (e) => onProbe(e.lngLat.lat, e.lngLat.lng));
    m.getCanvas().style.cursor = "crosshair";

    return () => {
      m.remove();
      map.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------- camera from store */

  /* The first camera application is a jump, not an ease.
   *
   * The map is constructed with whatever the store holds at mount time, and
   * whether that is the permalink's viewport or the defaults depends on
   * whether hydration finished first. Rather than reason about that ordering,
   * the camera is snapped to the store once the style is ready. A jump rather
   * than an ease because a permalink should open on its view, not fly to it. */
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
                 pitch: s.pitch, duration: 720,
                 easing: (t) => 1 - Math.pow(1 - t, 3) });
    }
  }, [ready, s.lon, s.lat, s.zoom, s.bearing, s.pitch]);

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

    const wanted = ordered.filter((l) => l.render === "raster");
    const wantedIds = new Set(wanted.map((l) => `tri-${l.id}`));

    // Remove what is no longer wanted.
    for (const layer of m.getStyle().layers ?? []) {
      if (layer.id.startsWith("tri-") && !wantedIds.has(layer.id)) {
        if (m.getLayer(layer.id)) m.removeLayer(layer.id);
        if (m.getSource(layer.id)) m.removeSource(layer.id);
      }
    }

    // Add or update, in the store's order, always beneath the coastline.
    const before = m.getLayer("boundary-coast") ? "boundary-coast" : undefined;
    for (const l of wanted) {
      const id = `tri-${l.id}`;
      const url = api.tileUrl(l.id, s.stormId, s.at);
      const existing = m.getSource(id) as maplibregl.RasterTileSource | undefined;

      if (!existing) {
        m.addSource(id, {
          type: "raster", tiles: [url], tileSize: 256,
          minzoom: 0, maxzoom: 11,
          // No attribution string: the provenance lives in the layer panel and
          // the legend, where it carries the instrument, product and age rather
          // than a single credit line.
        });
        m.addLayer(
          { id, type: "raster", source: id,
            paint: { "raster-opacity": s.opacity[l.id] ?? l.default_opacity,
                     "raster-fade-duration": 220,
                     "raster-resampling": "linear" } },
          before,
        );
        // Opacity transitions are honoured at runtime but are not part of the
        // paint type, so they are set through setPaintProperty afterwards.
        m.setPaintProperty(id, "raster-opacity-transition", { duration: 260 });
      } else {
        // Changing the tile URL is how a scrubber move propagates. setTiles
        // keeps the source and re-requests, which is far cheaper than removing
        // and re-adding the layer and avoids a flash of empty map.
        existing.setTiles([url]);
        m.setPaintProperty(id, "raster-opacity", s.opacity[l.id] ?? l.default_opacity);
      }
    }

    // Reassert ordering, since sources added at different times do not stack in
    // the order the store wants.
    for (const l of wanted) {
      const id = `tri-${l.id}`;
      if (m.getLayer(id) && before) m.moveLayer(id, before);
    }
  };

  // `ready` is in the dependency list so the layers are added once the style
  // has loaded, whichever of the two finishes first.
  useEffect(syncRasters, [rasterKey, ready]);

  /* ---------------------------------------------------------- vector overlays */
  useEffect(() => {
    const od = overlay.current;
    if (!od) return;

    const layers: any[] = [];
    const activeIds = new Set(s.active);
    const cutoff = s.at ? new Date(s.at).getTime() : Infinity;
    const reached = (t: string) => new Date(t).getTime() <= cutoff;

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
          updateTriggers: { getFillColor: [risk.valid_time], getLineColor: [risk.valid_time] },
          transitions: { getFillColor: 420 },
        }),
      );
    }

    /* The track, styled by regime and split at the scrubber.
     *
     * This is the most important thing on the map. The point where the style
     * changes at the coastline, and continues rather than stopping, is the
     * land-sea transition made visible. */
    if (track && (activeIds.has("tri_regime_segments") || activeIds.has("tri_track_intensity"))) {
      const features = track.regime_segments.map((seg) => ({
        type: "Feature" as const,
        properties: { regime: seg.regime, start: seg.start_time,
                      reached: reached(seg.start_time) },
        geometry: { type: "LineString" as const, coordinates: seg.points },
      }));

      // A wide, low-alpha pass underneath the track reads as a glow at every
      // zoom without a shader, and it is what keeps a 3 px line legible over a
      // bright infrared field.
      layers.push(
        new GeoJsonLayer({
          id: "track-glow",
          data: { type: "FeatureCollection", features } as any,
          stroked: true,
          filled: false,
          lineWidthUnits: "pixels",
          getLineWidth: 9,
          getLineColor: (f: any) => {
            const c = hexToRgb(REGIME_COLOR[f.properties.regime] ?? "#38bdf8");
            return [c[0], c[1], c[2], f.properties.reached ? 46 : 14];
          },
          updateTriggers: { getLineColor: [track.storm_id, s.at] },
        }),
        new GeoJsonLayer({
          id: "track-regime",
          data: { type: "FeatureCollection", features } as any,
          pickable: true,
          stroked: true,
          filled: false,
          lineWidthUnits: "pixels",
          getLineWidth: 2.8,
          getLineColor: (f: any) => {
            const c = hexToRgb(REGIME_COLOR[f.properties.regime] ?? "#38bdf8");
            return [c[0], c[1], c[2], f.properties.reached ? 240 : 72];
          },
          updateTriggers: { getLineColor: [track.storm_id, s.at] },
        }),
      );

      // Fix markers, sized by intensity. Intensity is rendered along the track
      // and never painted as a field, because a scalar has no value at an
      // arbitrary grid point.
      layers.push(
        new ScatterplotLayer({
          id: "track-fixes",
          data: track.points,
          pickable: true,
          radiusUnits: "pixels",
          getPosition: (d: TrackPoint) => [d.lon, d.lat],
          getRadius: (d: TrackPoint) =>
            2 + Math.sqrt(Math.max(d.vmax_kt ?? 0, 0)) * 0.4,
          getFillColor: (d: TrackPoint) => {
            const c = hexToRgb(REGIME_COLOR[d.regime] ?? "#38bdf8");
            return [c[0], c[1], c[2], reached(d.valid_time) ? 225 : 62];
          },
          getLineColor: [5, 8, 12, 220],
          lineWidthUnits: "pixels",
          getLineWidth: 0.8,
          stroked: true,
          updateTriggers: { getFillColor: [s.at] },
        }),
      );
    }

    /* Centre-fix uncertainty ellipse, and the track cone. */
    if (activeIds.has("tri_centre_uncertainty") && state?.centre.sigma_km) {
      layers.push(
        new ScatterplotLayer({
          id: "centre-sigma",
          data: [state],
          radiusUnits: "meters",
          getPosition: (d: StormState) => [d.centre.lon, d.centre.lat],
          getRadius: (d: StormState) => (d.centre.sigma_km ?? 0) * 1000,
          filled: true,
          stroked: true,
          getFillColor: [252, 165, 165, 26],
          getLineColor: [252, 165, 165, 190],
          lineWidthUnits: "pixels",
          getLineWidth: 1.4,
          transitions: { getRadius: 420, getPosition: 420 },
        }),
      );
    }
    if (activeIds.has("tri_track_cone") && state?.centre.sigma_km) {
      layers.push(
        new ScatterplotLayer({
          id: "track-cone",
          data: [state],
          radiusUnits: "meters",
          getPosition: (d: StormState) => [d.centre.lon, d.centre.lat],
          getRadius: (d: StormState) => Math.max((d.centre.sigma_km ?? 40) * 2000, 60000),
          filled: true,
          stroked: true,
          getFillColor: [252, 165, 165, 16],
          getLineColor: [252, 165, 165, 120],
          lineWidthUnits: "pixels",
          getLineWidth: 1,
          transitions: { getRadius: 420, getPosition: 420 },
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
          getDashArray: [4, 3],
        }),
      );
    }

    /* The current storm marker. The halo thickness is the method spread, so
     * disagreement is visible on the map exactly where it is genuinely
     * spatial, and nowhere else. */
    if (state) {
      const spread = state.disagreement.spread_kt ?? 0;
      layers.push(
        // A soft disc well outside the marker, so the eye finds the current fix
        // immediately even against a bright infrared field.
        new ScatterplotLayer({
          id: "storm-beacon",
          data: [state],
          radiusUnits: "pixels",
          getPosition: (d: StormState) => [d.centre.lon, d.centre.lat],
          getRadius: 26,
          filled: true,
          stroked: false,
          getFillColor: state.disagreement.above_threshold
            ? [248, 113, 113, 28]
            : [79, 224, 207, 28],
          transitions: { getPosition: 420 },
          updateTriggers: { getFillColor: [state.disagreement.above_threshold] },
        }),
        new ScatterplotLayer({
          id: "storm-halo",
          data: [state],
          radiusUnits: "pixels",
          getPosition: (d: StormState) => [d.centre.lon, d.centre.lat],
          getRadius: 13,
          filled: false,
          stroked: true,
          getLineColor: state.disagreement.above_threshold
            ? [248, 113, 113, 235]
            : [143, 245, 230, 205],
          lineWidthUnits: "pixels",
          getLineWidth: Math.min(1.2 + spread * 0.55, 7),
          updateTriggers: { getLineWidth: [spread], getLineColor: [spread] },
          transitions: { getPosition: 420, getLineWidth: 320 },
        }),
        new ScatterplotLayer({
          id: "storm-centre",
          data: [state],
          radiusUnits: "pixels",
          getPosition: (d: StormState) => [d.centre.lon, d.centre.lat],
          getRadius: 4.5,
          filled: true,
          stroked: true,
          getLineColor: [5, 8, 12, 230],
          lineWidthUnits: "pixels",
          getLineWidth: 1.2,
          getFillColor: [240, 250, 252, 252],
          transitions: { getPosition: 420 },
        }),
        new TextLayer({
          id: "storm-label",
          data: [state],
          getPosition: (d: StormState) => [d.centre.lon, d.centre.lat],
          getText: (d: StormState) =>
            `${d.name.toUpperCase()}  ${d.intensity.vmax_kt?.toFixed(0) ?? "--"} KT`,
          getSize: 11,
          getColor: [236, 246, 250, 240],
          getPixelOffset: [0, -30],
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
  }, [track, state, risk, s.active, s.at, s.stormId]);

  /* ---------------------------------------------------------- follow mode */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !s.follow || !state) return;
    m.easeTo({ center: [state.centre.lon, state.centre.lat], duration: 700,
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
            color: "var(--class-d)", opacity: 0.6, textAlign: "right",
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
