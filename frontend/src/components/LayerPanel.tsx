/* Controls: the layer panel, grouped by provenance rather than by theme.
 *
 * This is the first of the four things on the Explorer that no general weather
 * map does, and the grouping is the point. A theme-grouped panel puts "wind"
 * next to "wind" regardless of whether one is a scatterometer retrieval and
 * the other a reanalysis field. Grouping by provenance forces the distinction
 * into the layout itself.
 *
 * Nothing in this file knows which layers are derived. Every visual comes from
 * `layer.class` off the manifest, so grepping this source for a hard-coded
 * derived-layer id returns nothing, which is an acceptance criterion.
 *
 * Each row carries its class badge, source and current age at all times,
 * without hovering. Age is the reason: a layer whose age is only in a tooltip
 * is a layer whose staleness nobody notices.
 *
 * Every row also carries a one-sentence plain-English gloss under the
 * technical label. "Outgoing longwave radiation, INSAT-3D L2" is correct and
 * tells a non-meteorologist nothing, and the people this has to convince are
 * not all meteorologists. The group headings say the same thing at the level
 * above: measured by satellites, from a weather model, produced by TRINETRA.
 */

import { useEffect, useMemo, useState } from "react";
import { formatAge } from "../api/client";
import { CLASS_PLAIN, LAYER_PLAIN } from "../api/plain";
import type { Freshness, Layer } from "../api/types";
import { useStore } from "../state/store";

const CHANNEL_OF_LAYER: Record<string, string> = {
  insat_ir: "ir", insat_wv: "wv", insat_vis: "vis", insat_olr: "olr",
  pmw_89: "pmw89", pmw_37: "pmw37", scat_wind: "scat", soil_moisture: "soil",
};

const GROUP_TITLE: Record<string, string> = {
  observed: "Measured by satellites",
  reanalysis: "From a weather model",
  derived: "Produced by TRINETRA",
  boundaries: "Map reference",
};

const GROUP_SUB: Record<string, string> = {
  observed: "An instrument saw this.",
  reanalysis: "A model's reconstruction, used as an input.",
  derived: "This system's own output, always with its uncertainty.",
  boundaries: "Coastlines and districts.",
};

interface Props {
  freshness: Freshness | null;
  onClose?: () => void;
}

export default function LayerPanel({ freshness, onClose }: Props) {
  const { manifest, active, opacity, blocked } = useStore();
  const toggleLayer = useStore((s) => s.toggleLayer);
  const setOpacity = useStore((s) => s.setOpacity);
  const moveLayer = useStore((s) => s.moveLayer);
  const clearBlocked = useStore((s) => s.clearBlocked);
  const [expanded, setExpanded] = useState<string | null>(null);
  // The reference-heavy groups start folded, so the panel opens on the things
  // a viewer is most likely to reach for.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    reanalysis: true, boundaries: true,
  });

  const groups = useMemo(() => {
    if (!manifest) return [];
    const order = ["observed", "reanalysis", "derived", "boundaries"];
    return order
      .map((g) => ({
        key: g,
        title: GROUP_TITLE[g],
        sub: GROUP_SUB[g],
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
    return <div className="tele" style={{ padding: 16 }}>loading layers…</div>;
  }

  const channelState = (l: Layer) => {
    const ch = CHANNEL_OF_LAYER[l.id];
    if (!ch || !freshness) return null;
    return freshness.channels.find((c) => c.channel === ch) ?? null;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
                  minHeight: 0 }}>
      <header
        style={{
          display: "flex", alignItems: "center", gap: 8, flex: "none",
          padding: "11px 10px 11px 15px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <h2 style={{ fontSize: 14, letterSpacing: "-0.01em" }}>Controls</h2>
        <span className="tele">{active.length} on</span>
        <span style={{ flex: 1 }} />
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Hide controls"
            title="Hide controls"
            className="icon-btn"
            style={{ border: "none", background: "transparent", fontSize: 13 }}
          >
            ✕
          </button>
        )}
      </header>

      {blocked && (
        <div
          className="rise"
          style={{
            margin: 10, padding: "10px 12px", borderRadius: "var(--r)",
            border: "1px solid color-mix(in srgb, var(--alert) 45%, transparent)",
            background: "color-mix(in srgb, var(--alert) 10%, transparent)",
            fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.55, flex: "none",
          }}
        >
          <div className="tele" style={{ color: "var(--alert)", marginBottom: 4 }}>
            Cannot switch this on
          </div>
          {blocked.reason}
        </div>
      )}

      <div style={{ overflowY: "auto", flex: 1, minHeight: 0,
                    padding: "2px 0 14px" }}>
        {groups.map((g) => {
          const isOpen = !collapsed[g.key];
          const onCount = g.layers.filter((l) => active.includes(l.id)).length;
          return (
            <section key={g.key}>
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [g.key]: isOpen }))}
                aria-expanded={isOpen}
                style={{
                  width: "100%", textAlign: "left", border: "none",
                  borderRadius: 0, background: "transparent",
                  padding: "12px 14px 8px",
                  display: "flex", alignItems: "flex-start", gap: 9,
                }}
              >
                <span className={`swatch cls-${g.layers[0].class}`}
                      style={{ marginTop: 3 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12.5,
                                 color: "var(--fg)" }}>
                    {g.title}
                  </span>
                  <span style={{ display: "block", fontSize: 10.5,
                                 color: "var(--fg-3)", lineHeight: 1.45,
                                 marginTop: 2, whiteSpace: "normal" }}>
                    {g.sub}
                  </span>
                </span>
                <span className="tele" style={{ marginTop: 2, color: onCount
                  ? "var(--accent)" : "var(--fg-3)" }}>
                  {onCount}/{g.layers.length}
                </span>
                <span className="tele" style={{ fontSize: 11, marginTop: 2 }}>
                  {isOpen ? "▴" : "▾"}
                </span>
              </button>

              {isOpen && g.layers.map((l) => {
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
                      padding: "7px 14px",
                      borderLeft: on
                        ? "2px solid var(--accent)"
                        : "2px solid transparent",
                      background: on ? "rgba(79,224,207,0.07)" : "transparent",
                      transition: "background var(--t-fast) var(--ease-out)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleLayer(l.id)}
                        aria-label={l.label}
                        style={{ flex: "none" }}
                      />
                      <button
                        onClick={() => setExpanded(open ? null : l.id)}
                        title="Show the source, resolution and colour scale"
                        style={{
                          flex: 1, textAlign: "left", background: "none",
                          border: "none", padding: 0, cursor: "pointer",
                          color: on ? "var(--fg)" : "var(--fg-1)", fontSize: 12,
                          overflow: "hidden", textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {l.label}
                      </button>
                      <span className={`chip cls-${l.class}`}
                            title={manifest.classes[l.class].meaning}>
                        {l.class}
                      </span>
                    </div>

                    {/* One sentence in ordinary words, always visible. */}
                    {LAYER_PLAIN[l.id] && (
                      <div
                        style={{
                          marginLeft: 26, marginTop: 3, fontSize: 11,
                          color: on ? "var(--fg-2)" : "var(--fg-3)",
                          lineHeight: 1.5,
                        }}
                      >
                        {LAYER_PLAIN[l.id]}
                      </div>
                    )}

                    {/* Source and age, always visible, never only on hover. */}
                    <div
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        marginTop: 4, marginLeft: 26,
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
                          title={cs.present
                            ? "How long ago this was last observed"
                            : (cs.reason ?? "not available at this time")}
                        >
                          {cs.present ? formatAge(cs.age_minutes) : "absent"}
                        </span>
                      ) : (
                        <span className="tele">
                          {l.available_live ? "live" : "archive"}
                        </span>
                      )}
                    </div>

                    {open && (
                      <div
                        className="rise"
                        style={{
                          marginLeft: 26, marginTop: 8, marginBottom: 4,
                          paddingLeft: 10, borderLeft: "1px solid var(--line)",
                          fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.6,
                        }}
                      >
                        <Row k="Class" v={manifest.classes[l.class].label} />
                        {l.instrument && <Row k="Instrument" v={l.instrument} />}
                        {l.native_resolution_km && (
                          <Row k="Resolution" v={`${l.native_resolution_km} km`} />
                        )}
                        {l.cadence_minutes && (
                          <Row k="Updates every" v={`${l.cadence_minutes} min`} />
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
                              marginTop: 7, padding: "6px 8px",
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
                          <div style={{ marginTop: 6, color: "var(--fg-3)" }}>
                            {l.notes}
                          </div>
                        )}
                        {l.class === "R" && (
                          <div className="tele" style={{ color: "var(--class-r)",
                                                         marginTop: 6 }}>
                            Reanalysis, not observation
                          </div>
                        )}
                        {l.legend && l.legend.length > 0 && <Legend layer={l} />}
                      </div>
                    )}

                    {on && (
                      <div
                        style={{
                          display: "flex", alignItems: "center", gap: 8,
                          marginLeft: 26, marginTop: 7,
                        }}
                      >
                        <span className="tele" style={{ flex: "none" }}>Fade</span>
                        <input
                          type="range" min={0} max={1} step={0.05}
                          value={opacity[l.id] ?? 1}
                          onChange={(e) => setOpacity(l.id, Number(e.target.value))}
                          style={{ flex: 1 }}
                          aria-label={`${l.label} opacity`}
                        />
                        <span className="num" style={{ fontSize: 9.5, width: 24,
                                                       color: "var(--fg-3)" }}>
                          {Math.round((opacity[l.id] ?? 1) * 100)}
                        </span>
                        <button
                          onClick={() => moveLayer(l.id, -1)}
                          title="Move up within this group"
                          aria-label="move up"
                          style={{ padding: "0 5px", fontSize: 10,
                                   lineHeight: "17px" }}
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => moveLayer(l.id, 1)}
                          title="Move down within this group"
                          aria-label="move down"
                          style={{ padding: "0 5px", fontSize: 10,
                                   lineHeight: "17px" }}
                        >
                          ↓
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}

        <div style={{ padding: "12px 14px", marginTop: 4 }}>
          <div className="hair" style={{ marginBottom: 10 }} />
          <div className="tele" style={{ marginBottom: 7 }}>
            What the badges mean
          </div>
          {(["O", "R", "D"] as const).map((c) => (
            <div key={c} style={{ display: "flex", gap: 8,
                                  alignItems: "flex-start", marginBottom: 7 }}>
              <span className={`chip cls-${c}`} style={{ flex: "none" }}>{c}</span>
              <span style={{ fontSize: 10.5, color: "var(--fg-3)",
                             lineHeight: 1.5 }}>
                {CLASS_PLAIN[c]}
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
    <div style={{ display: "flex", gap: 7, marginBottom: 2 }}>
      <span className="tele" style={{ minWidth: 78 }}>{k}</span>
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
    <div style={{ marginTop: 8 }}>
      <div style={{ height: 9, borderRadius: 3, background: gradient,
                    border: "1px solid var(--line)" }} />
      <div style={{ display: "flex", justifyContent: "space-between",
                    marginTop: 3 }}>
        <span className="num" style={{ fontSize: 9, color: "var(--fg-3)" }}>
          {stops[0].value}
        </span>
        <span className="num" style={{ fontSize: 9, color: "var(--fg-3)" }}>
          {stops[stops.length - 1].value}
          {layer.units ? ` ${layer.units}` : ""}
        </span>
      </div>
    </div>
  );
}
