/* The layer panel, grouped by provenance class rather than by theme.
 *
 * This is the first of the four things on the Explorer that no general weather
 * map does, and the grouping is the point. A theme-grouped panel puts "wind"
 * next to "wind" regardless of whether one is a scatterometer retrieval and the
 * other a reanalysis field. Grouping by provenance forces the distinction into
 * the layout itself.
 *
 * Nothing in this file knows which layers are derived. Every visual comes from
 * `layer.class` off the manifest, so grepping this source for a hard-coded
 * derived-layer id returns nothing, which is an acceptance criterion.
 *
 * Each chip carries its class badge, source and current age at all times,
 * without hovering. Age is the reason: a layer whose age is only in a tooltip
 * is a layer whose staleness nobody notices.
 */

import { useEffect, useMemo, useState } from "react";
import { formatAge } from "../api/client";
import type { Freshness, Layer } from "../api/types";
import { useStore } from "../state/store";

const CHANNEL_OF_LAYER: Record<string, string> = {
  insat_ir: "ir", insat_wv: "wv", insat_vis: "vis", insat_olr: "olr",
  pmw_89: "pmw89", pmw_37: "pmw37", scat_wind: "scat", soil_moisture: "soil",
};

interface Props {
  freshness: Freshness | null;
}

export default function LayerPanel({ freshness }: Props) {
  const { manifest, active, opacity, blocked } = useStore();
  const toggleLayer = useStore((s) => s.toggleLayer);
  const setOpacity = useStore((s) => s.setOpacity);
  const moveLayer = useStore((s) => s.moveLayer);
  const clearBlocked = useStore((s) => s.clearBlocked);
  const [expanded, setExpanded] = useState<string | null>(null);

  const groups = useMemo(() => {
    if (!manifest) return [];
    const order = ["observed", "reanalysis", "derived", "boundaries"];
    const titles: Record<string, string> = {
      observed: "Observed",
      reanalysis: "Reanalysis",
      derived: "Derived by TRINETRA",
      boundaries: "Boundaries",
    };
    return order
      .map((g) => ({
        key: g,
        title: titles[g],
        layers: manifest.layers.filter((l) => l.group === g),
      }))
      .filter((g) => g.layers.length > 0);
  }, [manifest]);

  useEffect(() => {
    if (!blocked) return;
    const t = setTimeout(clearBlocked, 9000);
    return () => clearTimeout(t);
  }, [blocked, clearBlocked]);

  if (!manifest) {
    return <div className="tele" style={{ padding: 14 }}>loading manifest…</div>;
  }

  const channelState = (l: Layer) => {
    const ch = CHANNEL_OF_LAYER[l.id];
    if (!ch || !freshness) return null;
    return freshness.channels.find((c) => c.channel === ch) ?? null;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "11px 14px 9px", borderBottom: "1px solid var(--line)",
                    flex: "none" }}>
        <div className="tele" style={{ color: "var(--fg-2)" }}>Layers</div>
        <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 4,
                      lineHeight: 1.45 }}>
          Grouped by provenance, not by theme.
        </div>
      </div>

      {blocked && (
        <div
          className="rise"
          style={{
            margin: 8, padding: "8px 10px", borderRadius: "var(--r)",
            border: "1px solid color-mix(in srgb, var(--alert) 45%, transparent)",
            background: "color-mix(in srgb, var(--alert) 10%, transparent)",
            fontSize: 11, color: "var(--fg-1)", lineHeight: 1.5,
          }}
        >
          <div className="tele" style={{ color: "var(--alert)", marginBottom: 3 }}>
            Cannot enable
          </div>
          {blocked.reason}
        </div>
      )}

      <div style={{ overflowY: "auto", flex: 1, padding: "4px 0 12px" }}>
        {groups.map((g) => (
          <section key={g.key}>
            <header
              style={{
                display: "flex", alignItems: "center", gap: 7,
                padding: "9px 12px 5px",
                position: "sticky", top: 0, zIndex: 2,
                background: "linear-gradient(180deg, rgba(9,13,19,0.96) 68%, transparent)",
                backdropFilter: "blur(6px)",
              }}
            >
              <span className={`swatch cls-${g.layers[0].class}`} />
              <span className="tele" style={{ color: "var(--fg-2)" }}>{g.title}</span>
              <span className="hair" style={{ flex: 1, marginLeft: 4 }} />
              <span className="tele">{g.layers.filter((l) => active.includes(l.id)).length}</span>
            </header>

            {g.layers.map((l) => {
              const on = active.includes(l.id);
              const cs = channelState(l);
              const stale = cs?.status === "stale" || cs?.status === "expired";
              const gone = cs?.status === "expired";
              const open = expanded === l.id;

              return (
                <div
                  key={l.id}
                  className={stale ? "stale" : undefined}
                  style={{
                    padding: "6px 14px",
                    borderLeft: on ? "2px solid var(--accent)" : "2px solid transparent",
                    background: on ? "rgba(79,224,207,0.07)" : "transparent",
                    transition: "background var(--t-fast) var(--ease-out)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleLayer(l.id)}
                      aria-label={l.label}
                      style={{ flex: "none" }}
                    />
                    <button
                      onClick={() => setExpanded(open ? null : l.id)}
                      title="details"
                      style={{
                        flex: 1, textAlign: "left", background: "none",
                        border: "none", padding: 0, cursor: "pointer",
                        color: on ? "var(--fg)" : "var(--fg-1)", fontSize: 11.5,
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {l.label}
                    </button>
                    <span className={`chip cls-${l.class}`} title={manifest.classes[l.class].meaning}>
                      {l.class}
                    </span>
                  </div>

                  {/* Source and age, always visible, never only on hover. */}
                  <div
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      marginTop: 2, marginLeft: 24,
                    }}
                  >
                    <span className="tele" style={{ overflow: "hidden",
                                                    textOverflow: "ellipsis" }}>
                      {l.source}
                    </span>
                    <span style={{ flex: 1 }} />
                    {l.synthetic && (
                      <span className="tele" style={{ color: "var(--warn)" }}
                            title="Generated by the project's parametric forward model, not observed.">
                        SYNTH
                      </span>
                    )}
                    {gone ? (
                      <span className="tele" style={{ color: "var(--alert)" }}>
                        NO DATA AT THIS TIME
                      </span>
                    ) : cs ? (
                      <span
                        className="num"
                        style={{
                          fontSize: 10,
                          color: stale ? "var(--replay)" : "var(--fg-2)",
                        }}
                      >
                        {cs.present ? formatAge(cs.age_minutes) : "absent"}
                      </span>
                    ) : (
                      <span className="tele">{l.available_live ? "live" : "archive"}</span>
                    )}
                  </div>

                  {open && (
                    <div
                      className="rise"
                      style={{
                        marginLeft: 24, marginTop: 6, marginBottom: 4,
                        paddingLeft: 8, borderLeft: "1px solid var(--line)",
                        fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.55,
                      }}
                    >
                      <Row k="Class" v={manifest.classes[l.class].label} />
                      {l.instrument && <Row k="Instrument" v={l.instrument} />}
                      {l.native_resolution_km && (
                        <Row k="Resolution" v={`${l.native_resolution_km} km`} />
                      )}
                      {l.cadence_minutes && (
                        <Row k="Cadence" v={`${l.cadence_minutes} min`} />
                      )}
                      {l.units && <Row k="Units" v={l.units} />}
                      <Row k="Live" v={l.available_live ? "yes" : "no, archive tier"} />
                      {cs?.reason && <Row k="Status" v={cs.reason} />}
                      {l.uncertainty_layer && l.class === "D" && (
                        <Row k="Uncertainty" v={l.uncertainty_layer} />
                      )}
                      {l.produced_by.length > 0 && (
                        <Row k="Produced by" v={l.produced_by.join(", ")} />
                      )}
                      {l.disclaimer && (
                        <div
                          style={{
                            marginTop: 5, padding: "5px 7px",
                            borderRadius: "var(--r-sm)",
                            background: "color-mix(in srgb, var(--class-d) 8%, transparent)",
                            border: "1px solid color-mix(in srgb, var(--class-d) 24%, transparent)",
                            color: "var(--fg-1)",
                          }}
                        >
                          {l.disclaimer}
                        </div>
                      )}
                      {l.notes && (
                        <div style={{ marginTop: 5, color: "var(--fg-3)" }}>{l.notes}</div>
                      )}
                      {l.class === "R" && (
                        <div className="tele" style={{ color: "var(--class-r)", marginTop: 5 }}>
                          Reanalysis, not observation
                        </div>
                      )}
                      {l.legend && l.legend.length > 0 && (
                        <Legend layer={l} />
                      )}
                    </div>
                  )}

                  {on && (
                    <div
                      style={{
                        display: "flex", alignItems: "center", gap: 7,
                        marginLeft: 24, marginTop: 4,
                      }}
                    >
                      <input
                        type="range" min={0} max={1} step={0.05}
                        value={opacity[l.id] ?? 1}
                        onChange={(e) => setOpacity(l.id, Number(e.target.value))}
                        style={{ flex: 1 }}
                        aria-label={`${l.label} opacity`}
                      />
                      <span className="num" style={{ fontSize: 9.5, width: 26,
                                                     color: "var(--fg-3)" }}>
                        {Math.round((opacity[l.id] ?? 1) * 100)}
                      </span>
                      <button
                        onClick={() => moveLayer(l.id, -1)}
                        title="move up within this class"
                        style={{ padding: "0 4px", fontSize: 10, lineHeight: "16px" }}
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveLayer(l.id, 1)}
                        title="move down within this class"
                        style={{ padding: "0 4px", fontSize: 10, lineHeight: "16px" }}
                      >
                        ↓
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}

        <div style={{ padding: "10px 12px", marginTop: 6 }}>
          <div className="hair" style={{ marginBottom: 8 }} />
          <div className="tele" style={{ marginBottom: 5 }}>Convention</div>
          {(["O", "R", "D"] as const).map((c) => (
            <div key={c} style={{ display: "flex", gap: 7, alignItems: "flex-start",
                                  marginBottom: 5 }}>
              <span className={`chip cls-${c}`} style={{ flex: "none" }}>{c}</span>
              <span style={{ fontSize: 10, color: "var(--fg-3)", lineHeight: 1.45 }}>
                {manifest.classes[c].meaning}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 1 }}>
      <span className="tele" style={{ minWidth: 74 }}>{k}</span>
      <span style={{ color: "var(--fg-1)", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

/* The legend is generated from the same palette table that colours the pixels,
   served by the API, so a palette change cannot leave a stale legend behind. */
function Legend({ layer }: { layer: Layer }) {
  const stops = layer.legend ?? [];
  if (!stops.length) return null;
  const gradient = `linear-gradient(90deg, ${stops
    .map((s, i) => `rgb(${s.rgb.join(",")}) ${(i / (stops.length - 1)) * 100}%`)
    .join(", ")})`;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ height: 9, borderRadius: 2, background: gradient,
                    border: "1px solid var(--line)" }} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span className="num" style={{ fontSize: 9, color: "var(--fg-3)" }}>
          {stops[0].value}
        </span>
        <span className="num" style={{ fontSize: 9, color: "var(--fg-3)" }}>
          {stops[stops.length - 1].value}{layer.units ? ` ${layer.units}` : ""}
        </span>
      </div>
    </div>
  );
}
