/* The map legend.
 *
 * A colour scale with no numbers on it is decoration, and a map whose symbols
 * are not explained is a map only its author can read. This card carries both:
 * the colour ramp of the topmost active image layer with its real values and
 * units, and a key for every mark the map draws.
 *
 * The ramp comes from the manifest, which is generated from the same palette
 * table the tile renderer paints with, so a palette change cannot leave a
 * stale legend behind.
 *
 * It collapses to a single bar, because on a map-first surface a legend that
 * cannot be got out of the way is chrome the user cannot dismiss.
 */

import { useEffect, useState } from "react";
import { REGIME_COLOR, REGIME_LABEL } from "../api/client";
import { LAYER_PLAIN, REGIME_PLAIN } from "../api/plain";
import type { Layer } from "../api/types";
import { useStore } from "../state/store";

export default function MapLegend({ startOpen = true }: { startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);

  /* `startOpen` seeds the initial state, which is not enough: the Explorer
     folds the legend when it switches to Impact Mode, and a seed value is read
     once at mount, so the legend stayed open over the map. Following the prop
     when it changes makes the caller's intent take effect, while leaving the
     panel's own toggle in charge between changes. */
  useEffect(() => { setOpen(startOpen); }, [startOpen]);
  const ordered = useStore((s) => s.visibleOrdered)();
  const active = useStore((s) => s.active);

  // The topmost image layer is the one whose colours the viewer is actually
  // reading, so it is the one the ramp describes.
  const rasters = ordered.filter((l) => l.render === "raster" && l.legend?.length);
  const shown: Layer | undefined = rasters[rasters.length - 1];

  const trackOn = active.includes("tri_regime_segments") ||
    active.includes("tri_track_intensity");

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="glass"
        style={{ display: "flex", alignItems: "center", gap: 8,
                 padding: "7px 13px", borderRadius: "var(--r-pill)" }}
      >
        {shown && <Ramp layer={shown} width={92} height={7} />}
        <span className="tele">Legend</span>
      </button>
    );
  }

  return (
    <div
      className="glass rise"
      style={{ width: "min(258px, calc(100vw - 28px))",
               padding: "12px 14px 13px" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8,
                    marginBottom: 10 }}>
        <h3 style={{ fontSize: 12.5 }}>Legend</h3>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setOpen(false)}
          aria-label="Collapse legend"
          className="icon-btn"
          style={{ border: "none", background: "transparent", fontSize: 12,
                   width: 20, height: 20 }}
        >
          ✕
        </button>
      </div>

      {shown ? (
        <div style={{ marginBottom: trackOn ? 12 : 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontSize: 11.5, color: "var(--fg)" }}>
              {shown.label}
            </span>
            <span className={`chip cls-${shown.class}`}
                  style={{ padding: "0 4px", fontSize: 9 }}>
              {shown.class}
            </span>
          </div>
          {LAYER_PLAIN[shown.id] && (
            <div style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.5,
                          margin: "4px 0 7px" }}>
              {LAYER_PLAIN[shown.id]}
            </div>
          )}
          <Ramp layer={shown} />
          <Scale layer={shown} />
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.55,
                      marginBottom: trackOn ? 12 : 0 }}>
          No image layer is switched on, so there is no colour scale to read.
        </div>
      )}

      {trackOn && (
        <>
          <div className="hair" style={{ margin: "0 0 9px" }} />
          <div className="tele" style={{ marginBottom: 7 }}>
            The storm's path
          </div>
          {Object.keys(REGIME_COLOR).map((k) => (
            <Key key={k} colour={REGIME_COLOR[k]} shape="line"
                 label={REGIME_PLAIN[k] ?? REGIME_LABEL[k] ?? k} />
          ))}
          <div style={{ height: 6 }} />
          <Key colour="#f2fbfd" shape="dot" label="Where it is now" />
          <Key colour="#8ff5e6" shape="ring"
               label="Ring thickness: how much the methods disagree" />
          <Key colour="#f87171" shape="ring"
               label="Red ring: they disagree enough to check" />
          <div
            style={{ fontSize: 10, color: "var(--fg-3)", lineHeight: 1.5,
                     marginTop: 8 }}
          >
            The faint part of the track is time the replay has not reached yet.
            It is recorded best-track, not a forecast.
          </div>
        </>
      )}
    </div>
  );
}

function Ramp({ layer, width, height = 10 }: {
  layer: Layer; width?: number; height?: number;
}) {
  const stops = layer.legend ?? [];
  const gradient = `linear-gradient(90deg, ${stops
    .map((s, i) => `rgb(${s.rgb.join(",")}) ${(i / (stops.length - 1)) * 100}%`)
    .join(", ")})`;
  return (
    <div
      style={{
        height, width: width ?? "100%", borderRadius: 3, background: gradient,
        border: "1px solid var(--line)",
      }}
    />
  );
}

/* Four labelled ticks rather than two endpoints: a viewer reading a cloud-top
   temperature needs to know roughly where -60 °C falls on the bar, not only
   where the bar starts and stops. */
function Scale({ layer }: { layer: Layer }) {
  const stops = layer.legend ?? [];
  if (stops.length < 2) return null;
  const picks = [0, Math.round((stops.length - 1) / 3),
                 Math.round((2 * (stops.length - 1)) / 3), stops.length - 1];
  return (
    <div style={{ display: "flex", justifyContent: "space-between",
                  marginTop: 4 }}>
      {picks.map((i, k) => (
        <span key={i} className="num"
              style={{ fontSize: 9, color: "var(--fg-3)" }}>
          {stops[i].value}
          {k === picks.length - 1 && layer.units ? ` ${layer.units}` : ""}
        </span>
      ))}
    </div>
  );
}

function Key({ colour, shape, label }: {
  colour: string; shape: "line" | "dot" | "ring"; label: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 9,
                  marginBottom: 5 }}>
      <span
        style={{
          flex: "none", width: 16, height: 14, display: "inline-flex",
          alignItems: "center", justifyContent: "center", marginTop: 1,
        }}
      >
        {shape === "line" && (
          <span style={{ width: 16, height: 2.6, borderRadius: 2,
                         background: colour }} />
        )}
        {shape === "dot" && (
          <span style={{ width: 8, height: 8, borderRadius: 5,
                         background: colour,
                         boxShadow: "0 0 0 1px rgba(5,8,12,0.9)" }} />
        )}
        {shape === "ring" && (
          <span style={{ width: 11, height: 11, borderRadius: 7,
                         border: `2px solid ${colour}` }} />
        )}
      </span>
      <span style={{ fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.45 }}>
        {label}
      </span>
    </div>
  );
}
