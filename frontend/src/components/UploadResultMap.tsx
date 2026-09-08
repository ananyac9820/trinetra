/* The result view for an accepted upload, as a map.
 *
 * Everything quantitative on this screen is a value the API returned. The one
 * thing that is not a model output is the position, and that is the whole
 * reason this component is careful about it: nothing in an upload payload
 * carries a longitude, so the marker sits where the uploader said the
 * observation was taken and every label that touches it says "declared".
 *
 * Two things are deliberately absent.
 *
 * There is no forecast track. The upload path has no head that emits future
 * positions, so a line leaving the marker would be invented. The genuine
 * forward-looking output is the 24-hour rapid-intensification probability, and
 * it appears as a number rather than as geometry.
 *
 * There are no wind radii. A 34/50/64 kt swath is the shape a weather app
 * draws here, and TRINETRA's upload path does not estimate one. The only
 * radius it does produce is the centre-fix uncertainty, so that is the only
 * circle drawn to scale, and the legend says so. The rings on the marker are
 * sized by category for emphasis and carry no distance.
 *
 * The IMD category is derived on the client from the estimated wind using the
 * band table served by /api/mode. That is the scale's definition applied to a
 * model output, not a second opinion about the storm.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
// Required here as well as in MapCanvas. MapCanvas ships in the Explorer
// chunk, so on this route its stylesheet is never loaded, and without it
// .maplibregl-marker loses its absolute positioning and the cyclone marker
// lands in normal flow below the canvas instead of on the storm.
import "maplibre-gl/dist/maplibre-gl.css";
import { api, mapTransformRequest } from "../api/client";
import { useStore } from "../state/store";
import type { ImdBand } from "../api/types";

/* ---------------------------------------------------------------- palette
 * A pastel meteorological basemap under dark glass chrome. The map surface is
 * light because that is how a severity colour reads best; the controls stay in
 * TRINETRA's own dark glass so the page still belongs to the rest of the app.
 */
const OCEAN = "#dce9f2";
const OCEAN_DEEP = "#cddfec";
const LAND = "#f3f0e7";
const COAST = "#7d95a8";
const DISTRICT = "rgba(125, 149, 168, 0.28)";

/** Severity ramp for the IMD bands, weak to strong. */
const CAT_COLOUR: Record<string, string> = {
  D: "#5eb3d6",
  DD: "#49c2b0",
  CS: "#e8c34a",
  SCS: "#f0983a",
  VSCS: "#e8632f",
  ESCS: "#d33b52",
  SuCS: "#a3239c",
};

const EMPTY = { type: "FeatureCollection", features: [] } as any;

const CAT_ORDER = ["D", "DD", "CS", "SCS", "VSCS", "ESCS", "SuCS"];

interface Analogue {
  sid: string;
  name: string;
  season: number;
  valid_time: string;
  vmax_kt: number | null;
  category: string | null;
  similarity: number;
}

interface Props {
  result: any;
  onReset: () => void;
}

/** Which IMD band a wind speed falls in. Inclusive lower bounds, as stored. */
function bandFor(vmaxKt: number | null | undefined, scale: ImdBand[]) {
  if (vmaxKt == null || !scale.length) return null;
  let hit: ImdBand | null = null;
  for (const b of scale) if (vmaxKt >= b.lower_kt) hit = b;
  return hit;
}

/** A circle on the ground, as a GeoJSON ring. Geometry, not meteorology. */
function circleRing(lat: number, lon: number, km: number, n = 96) {
  const kmLat = 110.574;
  const kmLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    ring.push([lon + (km / kmLon) * Math.cos(t), lat + (km / kmLat) * Math.sin(t)]);
  }
  return ring;
}

/** Feed a declared source, then set its layers' visibility.
 *
 * Every call is guarded. A map exception thrown from inside a React effect
 * reaches the error boundary and unmounts the whole result view, turning a
 * cosmetic map problem into a blank screen mid-demo. A missing overlay is the
 * better failure.
 */
function paint(m: maplibregl.Map, sourceId: string, data: any,
               layerIds: string[], visible: boolean) {
  try {
    const src = m.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (src && typeof src.setData === "function") src.setData(data);
  } catch (e) {
    console.error("upload map: could not set " + sourceId, e);
  }
  setVisible(m, layerIds, visible);
}

function setVisible(m: maplibregl.Map, layerIds: string[], visible: boolean) {
  for (const id of layerIds) {
    try {
      if (m.getLayer(id)) {
        m.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    } catch (e) {
      console.error("upload map: could not toggle " + id, e);
    }
  }
}

export default function UploadResultMap({ result, onReset }: Props) {
  const holder = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [tech, setTech] = useState(false);
  const [show, setShow] = useState({
    cyclone: true, uncertainty: true, analogues: true, districts: true,
  });
  const [tracks, setTracks] = useState<Record<string, [number, number][]>>({});

  const imdScale = useStore((s) => s.imdScale);
  const setImdScale = useStore((s) => s.setImdScale);

  const pos = result?.position ?? {};
  const res = result?.result ?? {};
  const dc = result?.distribution_check ?? {};
  const analogues: Analogue[] = result?.analogues ?? [];

  const vmax: number | null = res.intensity?.vmax_kt ?? null;
  const ci: number | null = res.intensity?.ci_kt ?? null;
  const sigmaKm: number | null = res.centre_fix?.sigma_km ?? null;
  const band = useMemo(() => bandFor(vmax, imdScale), [vmax, imdScale]);
  const colour = band ? CAT_COLOUR[band.code] ?? "#d33b52" : "#7d95a8";

  const hasPos = pos.declared === true
    && typeof pos.lat === "number" && typeof pos.lon === "number";

  /* The band table drives the category label, so fetch it if this page was
   * opened directly and the store has not been seeded by the Explorer. */
  useEffect(() => {
    if (imdScale.length) return;
    api.mode()
      .then((m: any) => { if (m?.imd_scale?.length) setImdScale(m.imd_scale); })
      .catch(() => { /* the readout falls back to the raw wind speed */ });
  }, [imdScale.length, setImdScale]);

  /* Real geography for the analogues: their own best-track positions. */
  useEffect(() => {
    const sids = Array.from(new Set(analogues.map((a) => a.sid))).slice(0, 4);
    if (!sids.length) return;
    let live = true;
    Promise.all(sids.map((sid) =>
      api.track(sid)
        .then((t: any) => [sid, (t.points ?? [])
          .map((p: any) => [p.lon, p.lat] as [number, number])] as const)
        .catch(() => [sid, [] as [number, number][]] as const)))
      .then((pairs) => {
        if (!live) return;
        const out: Record<string, [number, number][]> = {};
        for (const [sid, pts] of pairs) if (pts.length > 1) out[sid] = pts;
        setTracks(out);
      });
    return () => { live = false; };
  }, [result]);

  /* ---------------------------------------------------------------- map */
  useEffect(() => {
    if (!holder.current || map.current) return;

    const m = new maplibregl.Map({
      container: holder.current,
      style: {
        version: 8,
        // No glyphs key at all. A null glyphs URL invalidates the whole style,
        // and nothing here needs a symbol layer: the labels are HTML markers.
        sources: {
          land: { type: "geojson", data: "/api/basemap/land.geojson" },
          districts: { type: "geojson", data: "/api/basemap/districts.geojson" },
          // Declared empty and filled by setData once the style has loaded.
          // Adding a source after the fact throws while the style is still
          // settling, and that throw reaches the error boundary and takes the
          // whole result view down with it.
          unc: { type: "geojson", data: EMPTY },
          analogues: { type: "geojson", data: EMPTY },
        },
        layers: [
          { id: "ocean", type: "background", paint: { "background-color": OCEAN } },
          {
            id: "land-fill", type: "fill", source: "land",
            paint: { "fill-color": LAND },
          },
          {
            id: "district-line", type: "line", source: "districts",
            paint: { "line-color": DISTRICT, "line-width": 0.6 },
          },
          {
            id: "coast-line", type: "line", source: "land",
            paint: { "line-color": COAST, "line-width": 1.1 },
          },
          {
            id: "unc-fill", type: "fill", source: "unc",
            paint: { "fill-color": "#1f5f8b", "fill-opacity": 0.1 },
          },
          {
            id: "unc-line", type: "line", source: "unc",
            paint: {
              "line-color": "#1f5f8b", "line-width": 1.4,
              "line-dasharray": [3, 2], "line-opacity": 0.6,
            },
          },
          {
            id: "analogue-halo", type: "line", source: "analogues",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.7 },
          },
          {
            id: "analogue-line", type: "line", source: "analogues",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#6b4fb8", "line-width": 1.8,
              "line-dasharray": [2.5, 1.8], "line-opacity": 0.95,
            },
          },
        ],
      },
      // The basemap sources below are relative paths, which resolve against
      // this page rather than the API. On a split deployment that is the
      // static host, which rewrites unknown paths to index.html and hands
      // MapLibre HTML where it wanted GeoJSON.
      transformRequest: mapTransformRequest,
      center: hasPos ? [pos.lon, pos.lat] : [72, 17],
      zoom: hasPos ? 5.1 : 4.2,
      attributionControl: false,
      dragRotate: false,
      maxZoom: 10,
      minZoom: 2.5,
    });

    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    m.on("wheel", (e) => { if (!e.originalEvent.ctrlKey) e.originalEvent.stopPropagation(); });

    // Only "load", plus a loaded() check on idle. styledata fires while the
    // style is still settling, and every mutating call throws until it
    // finishes, so a layer-existence test is not a safe gate here.
    // The readout bar covers the bottom of the frame, so the camera is padded
    // to keep the storm in the clear part of it.
    m.setPadding({ top: 20, right: 20, bottom: 150, left: 20 });

    const markReady = () => setReady(true);
    m.on("load", markReady);
    m.on("idle", () => { if (m.loaded()) markReady(); });
    m.on("error", (e: any) => console.error("upload map:", e?.error ?? e));

    // The map is created in the same commit that lays the container out, so
    // MapLibre can measure a height that is still settling and then hold a
    // viewport a few dozen pixels taller than its holder. Observing the holder
    // keeps the two in step, and covers the window resize for free.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(holder.current);

    if (import.meta.env.DEV) (window as any).__uploadMap = m;

    map.current = m;
    return () => { ro.disconnect(); m.remove(); map.current = null; };
  }, []);

  /* ------------------------------------------------- uncertainty + rings */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const feats: any[] = [];
    if (hasPos && sigmaKm) {
      feats.push({
        type: "Feature", properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [circleRing(pos.lat, pos.lon, sigmaKm)],
        },
      });
    }
    paint(m, "unc", { type: "FeatureCollection", features: feats },
          ["unc-fill", "unc-line"], show.uncertainty);
  }, [ready, hasPos, sigmaKm, pos.lat, pos.lon, show.uncertainty]);

  /* ------------------------------------------------------ analogue tracks */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const feats = Object.entries(tracks).map(([sid, pts]) => ({
      type: "Feature",
      properties: { sid },
      geometry: { type: "LineString", coordinates: pts },
    }));
    paint(m, "analogues", { type: "FeatureCollection", features: feats },
          ["analogue-halo", "analogue-line"], show.analogues);
  }, [ready, tracks, show.analogues]);

  /* -------------------------------------------------------- district toggle */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    setVisible(m, ["district-line"], show.districts);
  }, [ready, show.districts]);

  /* ------------------------------------------------------- cyclone marker */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    marker.current?.remove();
    marker.current = null;
    if (!hasPos || !show.cyclone) return;

    const el = document.createElement("div");
    el.className = "cyc-marker";
    el.style.setProperty("--cyc", colour);
    el.innerHTML = `
      <span class="cyc-ring cyc-ring-3"></span>
      <span class="cyc-ring cyc-ring-2"></span>
      <span class="cyc-ring cyc-ring-1"></span>
      <span class="cyc-eye">
        <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
          <path d="M12 12c0-4 3.4-7 7.4-6.4C16.8 3 13.6 2.6 11 3.8 8 5.2 6.6 8.4 7.4 11.4"
                fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/>
          <path d="M12 12c0 4-3.4 7-7.4 6.4C7.2 21 10.4 21.4 13 20.2c3-1.4 4.4-4.6 3.6-7.6"
                fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/>
          <circle cx="12" cy="12" r="1.7" fill="#fff"/>
        </svg>
      </span>`;

    marker.current = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([pos.lon, pos.lat])
      .addTo(m);
  }, [ready, hasPos, show.cyclone, colour, pos.lat, pos.lon]);

  /* -------------------------------------------------------------- render */
  const stamp = result?.provenance_stamp ?? {};

  return (
    <div className="ur-wrap">
      <style>{CSS}</style>

      <div ref={holder} className="ur-map" />
      {!ready && <div className="ur-loading">drawing the basin…</div>}

      {/* ----------------------------------------- top left: layer selector */}
      <div className="ur-panel ur-tl">
        <div className="ur-brand">
          <span className="ur-dot" />
          TRINETRA
          <span className="ur-brand-sub">upload analysis</span>
        </div>
        <div className="ur-layers">
          {([
            ["cyclone", "Cyclone position"],
            ["uncertainty", "Centre uncertainty"],
            ["analogues", "Historical analogues"],
            ["districts", "District boundaries"],
          ] as const).map(([k, label]) => (
            <label key={k} className="ur-check">
              <input
                type="checkbox"
                checked={show[k]}
                onChange={(e) => setShow((s) => ({ ...s, [k]: e.target.checked }))}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* --------------------------------------- top right: position status */}
      <div className="ur-panel ur-tr">
        {hasPos ? (
          <>
            <div className="ur-pos">
              {Math.abs(pos.lat).toFixed(2)}&deg;{pos.lat >= 0 ? "N" : "S"}{" "}
              {Math.abs(pos.lon).toFixed(2)}&deg;{pos.lon >= 0 ? "E" : "W"}
            </div>
            <div className="ur-tags">
              <span className="ur-tag ur-tag-declared">declared position</span>
              <span className={`ur-tag ${pos.in_basin ? "ur-tag-ok" : "ur-tag-warn"}`}>
                {pos.in_basin ? "inside trained basin" : "outside trained basin"}
              </span>
            </div>
            <div className="ur-fine">
              TRINETRA did not estimate this position. Nothing in an upload
              payload carries a longitude.
            </div>
          </>
        ) : (
          <>
            <div className="ur-pos ur-pos-none">no position supplied</div>
            <div className="ur-fine">{pos.note ?? "Nothing to place on the map."}</div>
          </>
        )}
      </div>

      {/* --------------------------------------------- right: legend */}
      <div className="ur-panel ur-legend">
        <div className="ur-legend-t">Marker colour, IMD category</div>
        <div className="ur-ramp">
          {CAT_ORDER.map((c) => (
            <span
              key={c}
              className={`ur-swatch ${band?.code === c ? "on" : ""}`}
              style={{ background: CAT_COLOUR[c] }}
              title={c}
            >
              {band?.code === c ? c : ""}
            </span>
          ))}
        </div>
        {hasPos && sigmaKm != null && (
          <div className="ur-legend-k">
            <span className="ur-key ur-key-unc" />
            drawn to scale: centre uncertainty, &plusmn;{sigmaKm.toFixed(0)} km
          </div>
        )}
        <div className="ur-legend-k">
          <span className="ur-key ur-key-ana" />
          historical analogue, real best-track
        </div>
        <div className="ur-fine">
          The rings on the marker are sized by category for emphasis and are not
          wind radii. This upload path does not estimate one.
        </div>
      </div>

      {/* ---------------------------------------------- bottom: the readout */}
      <div className="ur-bar">
        <div className="ur-bar-main">
          <div className="ur-cat" style={{ borderColor: colour }}>
            <span className="ur-cat-code" style={{ color: colour }}>
              {band?.code ?? "--"}
            </span>
            <span className="ur-cat-label">{band?.label ?? "category unavailable"}</span>
          </div>

          <Stat
            label="Estimated wind"
            value={vmax != null ? `${vmax.toFixed(1)}` : "not issued"}
            unit={vmax != null ? `kt${ci != null ? ` ± ${ci.toFixed(1)}` : ""}` : ""}
            note={res.intensity?.confidence
              ? `${res.intensity.confidence} confidence · ${res.intensity.sensor_mode}`
              : "no imagery supplied"}
          />
          <Stat
            label="Rapid intensification, 24 h"
            value={res.ri?.issued ? `${(res.ri.p24 * 100).toFixed(1)}` : "NOT ISSUED"}
            unit={res.ri?.issued ? "%" : ""}
            note={res.ri?.issued
              ? `alert threshold ${(res.ri.threshold * 100).toFixed(0)}%`
              : (res.ri?.missing_inputs ?? []).join(", ") || "inputs missing"}
            warn={!res.ri?.issued}
          />
          <Stat
            label="Centre uncertainty"
            value={sigmaKm != null ? sigmaKm.toFixed(0) : "--"}
            unit="km"
            note={res.centre_fix?.widened ? "widened, infrared only" : "nominal"}
            warn={!!res.centre_fix?.widened}
          />
          <Stat
            label="Detected as"
            value={res.detection?.class?.replace(/_/g, " ") ?? "--"}
            unit=""
            note={res.detection
              ? `confidence ${res.detection.confidence} · regime ${
                  res.regime?.label?.replace(/_/g, " ") ?? "--"}`
              : ""}
          />

          <div className="ur-bar-actions">
            <button className="ur-btn" onClick={() => setTech((v) => !v)}>
              {tech ? "Hide" : "Technical details"}
            </button>
            <button className="ur-btn ur-btn-primary" onClick={onReset}>
              New upload
            </button>
          </div>
        </div>

        <div className="ur-bar-foot">
          <span className="ur-mono">{stamp.filename ?? "upload"}</span>
          <span className="ur-sep">/</span>
          <span>mode {result?.mode} &middot; {(result?.input?.channels_supplied ?? []).length} channels</span>
          <span className="ur-sep">/</span>
          <span>analysed {stamp.received ?? "--"}</span>
          <span className="ur-sep">/</span>
          <span className="ur-nofc">
            No forecast track. This path emits no future positions, so none is drawn.
          </span>
        </div>
      </div>

      {/* --------------------------------------- technical details, secondary */}
      {tech && (
        <div className="ur-tech">
          <div className="ur-tech-head">
            <span>Technical details</span>
            <button className="ur-x" onClick={() => setTech(false)} aria-label="close">
              &times;
            </button>
          </div>
          <div className="ur-tech-body">
            <TRow k="Out-of-distribution score"
                  v={typeof dc.score === "number"
                    ? `${dc.score} against threshold ${dc.threshold} — ${dc.verdict}`
                    : dc.reason ?? "unavailable"} />
            <TRow k="Channels supplied"
                  v={(result?.input?.channels_supplied ?? []).join(", ") || "none"} />
            <TRow k="Channels absent"
                  v={(result?.input?.channels_absent ?? []).join(", ") || "none"} />
            <TRow k="Environmental data" v={result?.input?.environmental_data ?? "--"} />
            <TRow k="Grid" v={result?.input?.grid ?? "--"} />
            <TRow k="Instrument"
                  v={`${result?.input?.instrument?.declared ?? "--"} — ${
                    result?.input?.instrument?.note ?? ""}`} />
            <TRow k="Dvorak scene"
                  v={res.dvorak_scene
                    ? `${res.dvorak_scene.scene} (conf ${res.dvorak_scene.confidence}) — ${res.dvorak_scene.status}`
                    : "--"} />
            <TRow k="Centre fix"
                  v={res.centre_fix?.reason ?? `± ${sigmaKm ?? "--"} km`} />
            <TRow k="Model version" v={stamp.model_version ?? "--"} />

            {(result?.abstentions ?? []).length > 0 && (
              <>
                <div className="ur-tech-t">Abstentions</div>
                {result.abstentions.map((a: any, i: number) => (
                  <div key={i} className="ur-abstain">
                    <span className="ur-mono">{a.head}</span>
                    <span>{a.reason}</span>
                  </div>
                ))}
              </>
            )}

            {analogues.length > 0 && (
              <>
                <div className="ur-tech-t">
                  Nearest analogues, by encoder embedding
                </div>
                {analogues.slice(0, 6).map((a, i) => (
                  <div key={i} className="ur-ana">
                    <span className="ur-ana-name">{a.name} {a.season}</span>
                    <span className="ur-mono">{a.valid_time?.slice(0, 16)}</span>
                    <span className="ur-mono">
                      {a.vmax_kt != null ? `${a.vmax_kt.toFixed(0)} kt` : "--"}
                    </span>
                    <span className="ur-mono">{a.category ?? "--"}</span>
                    <span className="ur-mono ur-sim">{a.similarity}</span>
                  </div>
                ))}
                <div className="ur-fine">
                  Retrieved by similarity in the encoder's embedding space, drawn
                  on the map from their own best-track positions. They are past
                  storms that resembled this input, not a projection of it.
                </div>
              </>
            )}

            {(stamp.checks ?? []).length > 0 && (
              <>
                <div className="ur-tech-t">
                  Guardrail chain, {stamp.checks.length} checks
                </div>
                {stamp.checks.map((c: any, i: number) => (
                  <div key={i} className={`ur-chk ur-chk-${c.level}`}>
                    <span className="ur-mono">{c.check}</span>
                    <span>{c.detail}</span>
                  </div>
                ))}
              </>
            )}

            <a
              className="ur-btn"
              style={{ display: "inline-block", marginTop: 12, textDecoration: "none" }}
              download={`${stamp.filename ?? "upload"}.provenance.json`}
              href={URL.createObjectURL(new Blob(
                [JSON.stringify(stamp, null, 2)], { type: "application/json" }))}
            >
              Download provenance stamp
            </a>
          </div>
        </div>
      )}

      <div className="ur-disclaim">
        {result?.disclaimer ?? "Decision support only. Not a warning product."}
      </div>
    </div>
  );
}

function Stat({ label, value, unit, note, warn }: {
  label: string; value: string; unit: string; note?: string; warn?: boolean;
}) {
  return (
    <div className="ur-stat">
      <div className="ur-stat-l">{label}</div>
      <div className="ur-stat-v">
        <span className={warn ? "ur-warn" : undefined}>{value}</span>
        {unit && <span className="ur-stat-u">{unit}</span>}
      </div>
      {note && <div className="ur-stat-n">{note}</div>}
    </div>
  );
}

function TRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="ur-trow">
      <span className="ur-trow-k">{k}</span>
      <span className="ur-trow-v">{v}</span>
    </div>
  );
}

/* Scoped to this view. The map surface is light, so these controls cannot
 * inherit the app's panel styles: they need their own contrast against a pale
 * ground while keeping the same glass language. */
const CSS = `
.ur-wrap { position: relative; width: 100%; height: calc(100vh - var(--chrome-h));
  min-height: 620px; overflow: hidden; background: ${OCEAN_DEEP}; }
.ur-map { position: absolute; inset: 0; }
.ur-map canvas { outline: none; }
.ur-loading { position: absolute; inset: 0; display: grid; place-items: center;
  font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase;
  color: #5b7185; pointer-events: none; }

.ur-panel { position: absolute; z-index: 3; background: var(--glass);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--line-strong); border-radius: var(--r);
  box-shadow: var(--shadow); color: var(--fg); padding: 11px 13px; }

.ur-tl { top: 14px; left: 14px; width: 208px; }
.ur-brand { display: flex; align-items: center; gap: 7px; font: 600 11px/1 var(--mono);
  letter-spacing: .17em; text-transform: uppercase; }
.ur-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 8px var(--accent); flex: none; }
.ur-brand-sub { font-size: 9.5px; letter-spacing: .1em; color: var(--fg-2);
  margin-left: auto; text-transform: none; }
.ur-layers { display: grid; gap: 2px; margin-top: 10px;
  border-top: 1px solid var(--line-soft); padding-top: 9px; }
.ur-check { display: flex; align-items: center; gap: 8px; font-size: 11.5px;
  color: var(--fg-1); cursor: pointer; padding: 3px 0; }
.ur-check input { accent-color: var(--accent); width: 13px; height: 13px;
  cursor: pointer; }
.ur-check:hover { color: var(--fg); }

.ur-tr { top: 14px; right: 14px; max-width: 250px; }
.ur-pos { font: 600 15px/1.1 var(--mono); font-variant-numeric: tabular-nums; }
.ur-pos-none { font-size: 12px; color: var(--fg-2); font-weight: 500; }
.ur-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
.ur-tag { font: 600 9px/1 var(--mono); letter-spacing: .11em; text-transform: uppercase;
  padding: 4px 6px; border-radius: var(--r-sm); border: 1px solid transparent; }
.ur-tag-declared { color: #ffd08a; border-color: rgba(255, 208, 138, .4);
  background: rgba(255, 208, 138, .1); }
.ur-tag-ok { color: var(--ok); border-color: rgba(74, 222, 128, .35);
  background: rgba(74, 222, 128, .09); }
.ur-tag-warn { color: var(--warn); border-color: rgba(251, 146, 60, .4);
  background: rgba(251, 146, 60, .1); }
.ur-fine { font-size: 10px; line-height: 1.55; color: var(--fg-2); margin-top: 7px; }

.ur-legend { right: 14px; top: 138px; width: 214px; }
.ur-legend-t { font: 600 9.5px/1 var(--mono); letter-spacing: .13em;
  text-transform: uppercase; color: var(--fg-2); }
.ur-ramp { display: flex; gap: 2px; margin: 8px 0 10px; }
.ur-swatch { flex: 1; height: 15px; border-radius: 2px; display: grid;
  place-items: center; font: 700 8px var(--mono); color: #fff;
  opacity: .42; transition: opacity var(--t-fast), transform var(--t-fast); }
.ur-swatch.on { opacity: 1; transform: scaleY(1.5);
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .8); }
.ur-legend-k { display: flex; align-items: center; gap: 7px; font-size: 10.5px;
  color: var(--fg-1); margin-bottom: 5px; }
.ur-key { width: 18px; height: 0; flex: none; }
.ur-key-unc { border-top: 1.5px dashed #7fb4d8; }
.ur-key-ana { border-top: 2px dashed #a98fe0; }

.ur-bar { position: absolute; left: 14px; right: 14px; bottom: 14px; z-index: 3;
  background: var(--glass-2); backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur); border: 1px solid var(--line-strong);
  border-radius: var(--r-lg); box-shadow: var(--shadow-lg); overflow: hidden; }
.ur-bar-main { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; }
.ur-cat { display: flex; flex-direction: column; justify-content: center;
  padding: 12px 16px; border-left: 3px solid; min-width: 132px; }
.ur-cat-code { font: 700 21px/1 var(--sans); letter-spacing: -.01em; }
.ur-cat-label { font-size: 10px; color: var(--fg-1); line-height: 1.35; margin-top: 3px; }
.ur-stat { padding: 12px 16px; border-left: 1px solid var(--line-soft); min-width: 138px;
  flex: 1; }
.ur-stat-l { font: 600 9px/1 var(--mono); letter-spacing: .12em;
  text-transform: uppercase; color: var(--fg-2); }
.ur-stat-v { display: flex; align-items: baseline; gap: 5px; margin-top: 5px;
  font: 600 17px/1 var(--sans); font-variant-numeric: tabular-nums; color: var(--fg); }
.ur-stat-u { font: 500 10.5px var(--mono); color: var(--fg-1); }
.ur-stat-n { font-size: 9.5px; color: var(--fg-2); margin-top: 4px; line-height: 1.4; }
.ur-warn { color: var(--warn); font-size: 13px; }
.ur-bar-actions { display: flex; align-items: center; gap: 7px; padding: 12px 14px;
  border-left: 1px solid var(--line-soft); margin-left: auto; }
.ur-btn { font: 500 11px var(--sans); color: var(--fg-1); background: var(--bg-3);
  border: 1px solid var(--line-strong); border-radius: var(--r-sm);
  padding: 7px 11px; cursor: pointer; transition: all var(--t-fast); white-space: nowrap; }
.ur-btn:hover { color: var(--fg); border-color: var(--accent-dim); }
.ur-btn-primary { background: var(--accent); color: var(--accent-ink); font-weight: 600;
  border-color: transparent; }
.ur-btn-primary:hover { background: var(--accent-2); color: var(--accent-ink); }
.ur-bar-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 16px; border-top: 1px solid var(--line-soft);
  background: rgba(0, 0, 0, .22); font-size: 10px; color: var(--fg-2); }
.ur-sep { color: var(--fg-3); }
.ur-mono { font: 500 10px var(--mono); color: var(--fg-1); }
.ur-nofc { color: #ffd08a; }

.ur-tech { position: absolute; z-index: 4; left: 14px; top: 14px; bottom: 100px;
  width: min(430px, calc(100% - 28px)); background: var(--glass-2);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--line-strong); border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg); display: flex; flex-direction: column;
  animation: ur-in var(--t) var(--ease-out) both; }
@keyframes ur-in { from { opacity: 0; transform: translateX(-10px); } }
.ur-tech-head { display: flex; align-items: center; padding: 11px 14px;
  border-bottom: 1px solid var(--line); font: 600 10px/1 var(--mono);
  letter-spacing: .14em; text-transform: uppercase; color: var(--fg-1); }
.ur-x { margin-left: auto; background: none; border: none; color: var(--fg-2);
  font-size: 17px; line-height: 1; cursor: pointer; padding: 0 3px; }
.ur-x:hover { color: var(--fg); }
.ur-tech-body { overflow-y: auto; padding: 12px 14px 16px; }
.ur-tech-t { font: 600 9.5px/1 var(--mono); letter-spacing: .13em;
  text-transform: uppercase; color: var(--accent); margin: 15px 0 7px; }
.ur-trow { display: flex; gap: 10px; padding: 4px 0;
  border-bottom: 1px solid var(--line-soft); font-size: 11px; }
.ur-trow-k { color: var(--fg-2); min-width: 132px; flex: none; }
.ur-trow-v { color: var(--fg-1); line-height: 1.5; }
.ur-abstain { display: grid; gap: 3px; padding: 8px 10px; margin-bottom: 6px;
  border-radius: var(--r-sm); font-size: 11px; line-height: 1.55; color: var(--fg-1);
  border: 1px solid rgba(251, 146, 60, .34); background: rgba(251, 146, 60, .07); }
.ur-ana { display: flex; gap: 8px; align-items: baseline; padding: 4px 0;
  border-bottom: 1px solid var(--line-soft); font-size: 11px; }
.ur-ana-name { color: var(--fg); flex: 1; min-width: 0; }
.ur-sim { color: var(--accent); }
.ur-chk { display: grid; grid-template-columns: 84px 1fr; gap: 8px; padding: 4px 0;
  border-bottom: 1px solid var(--line-soft); font-size: 10.5px; line-height: 1.5;
  color: var(--fg-2); }
.ur-chk-warning .ur-mono { color: var(--warn); }
.ur-chk-error .ur-mono { color: var(--alert); }
.ur-chk-info .ur-mono { color: var(--ok); }

.ur-disclaim { position: absolute; z-index: 2; left: 14px; bottom: 0;
  font-size: 9.5px; color: #5b7185; padding: 3px 6px; pointer-events: none; }

/* --------------------------------------------------------- cyclone marker */
.cyc-marker { position: relative; width: 34px; height: 34px; display: grid;
  place-items: center; }
.cyc-eye { position: relative; z-index: 2; width: 30px; height: 30px;
  border-radius: 50%; display: grid; place-items: center;
  background: var(--cyc); box-shadow: 0 2px 10px rgba(0, 0, 0, .4),
  0 0 0 2.5px rgba(255, 255, 255, .9); animation: cyc-spin 9s linear infinite; }
.cyc-ring { position: absolute; border-radius: 50%; border: 2px solid var(--cyc);
  opacity: 0; animation: cyc-pulse 2.9s var(--ease-out) infinite; }
.cyc-ring-1 { width: 46px; height: 46px; animation-delay: 0s; }
.cyc-ring-2 { width: 66px; height: 66px; animation-delay: .55s; }
.cyc-ring-3 { width: 88px; height: 88px; animation-delay: 1.1s; }
@keyframes cyc-spin { to { transform: rotate(360deg); } }
@keyframes cyc-pulse {
  0% { opacity: .55; transform: scale(.55); }
  70% { opacity: .06; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.03); }
}
@media (prefers-reduced-motion: reduce) {
  .cyc-eye { animation: none; }
  .cyc-ring { animation: none; opacity: .3; }
}

/* Below the Explorer's own breakpoint the bar stacks and the legend steps out
 * of the way of the position pill. */
@media (max-width: 900px) {
  .ur-legend { display: none; }
  .ur-tl { width: 176px; }
  .ur-stat { min-width: 116px; }
  .ur-bar-actions { margin-left: 0; width: 100%; border-left: none;
    border-top: 1px solid var(--line-soft); }
}
`;
