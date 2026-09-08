/* The dominant threat, and why it matters.
 *
 * This is the single most important thing Impact Mode says, so it gets its own
 * card and it leads with a sentence in ordinary words rather than a category.
 *
 * The idea it carries: a cyclone is not the same threat throughout its life.
 * Over warm water the question is how strong it gets. Near the coast both wind
 * and rain are live. Inland the wind has gone and the rain has not, and that is
 * the phase that does most of the damage and the phase most cyclone products
 * stop following. Showing which threat leads right now, and letting a viewer
 * watch it change as they scrub, is the argument the whole project rests on.
 *
 * What it must not do is imply that a model predicted the threat category. It
 * comes from a rule set over the model's outputs, and the card says so on the
 * back of the card rather than hiding it.
 */

import { useState } from "react";
import type { Hazard } from "../api/types";

const ICON: Record<string, string> = {
  spiral: "M12 3a9 9 0 1 0 9 9M12 3a6 6 0 0 1 6 6M12 21a9 9 0 0 1-9-9",
  wind: "M3 8h11a3 3 0 1 0-3-3M3 14h15a3 3 0 1 1-3 3M3 11h9",
  landfall: "M3 18h18M6 18V9M10 18V5M14 18v-7M18 18v-4",
  rain: "M5 13a4 4 0 0 1 1-7.9A5 5 0 0 1 16 5a3.5 3.5 0 0 1 .5 7H6M8 17v3M12 16v4M16 17v3",
  flood: "M2 15c2 0 3-1.4 5-1.4s3 1.4 5 1.4 3-1.4 5-1.4 3 1.4 5 1.4M2 20c2 0 3-1.4 5-1.4s3 1.4 5 1.4 3-1.4 5-1.4 3 1.4 5 1.4M7 9l5-6 5 6",
  fade: "M4 12h6M14 12h6M12 4v4M12 16v4",
};

function ThreatIcon({ icon, colour, size = 26 }: { icon: string; colour: string;
                                                    size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={colour} strokeWidth={1.6} strokeLinecap="round"
         strokeLinejoin="round" aria-hidden>
      <path d={ICON[icon] ?? ICON.fade} />
    </svg>
  );
}

const ARROW: Record<string, string> = { up: "↑", down: "↓", flat: "→" };

interface Props {
  hazard: Hazard | null;
  loading?: boolean;
  /** Rendered when the hazard shifted at this step, so the change is
   *  announced rather than left for the viewer to notice. */
  shift?: { from: string; to: string } | null;
  compact?: boolean;
}

export default function ThreatCard({ hazard, loading, shift, compact }: Props) {
  const [showBasis, setShowBasis] = useState(false);

  if (loading && !hazard) {
    return (
      <div className="glass" style={{ padding: "12px 14px", width: 300 }}>
        <div className="tele">Reading the dominant threat…</div>
      </div>
    );
  }
  if (!hazard) return null;

  return (
    <div
      className="glass rise"
      style={{
        width: compact ? "min(320px, calc(100vw - 28px))" : 320,
        padding: "13px 15px 14px",
        borderColor: `color-mix(in srgb, ${hazard.colour} 42%, transparent)`,
        boxShadow: `0 0 0 1px color-mix(in srgb, ${hazard.colour} 16%, transparent), var(--shadow)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="tele" style={{ color: "var(--fg-2)" }}>
          Biggest concern right now
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="tele"
          title="How confident the phase classification is. It is lowest exactly at the coastline, where the threat changes and it matters most."
          style={{ color: hazard.confidence === "high" ? "var(--ok)"
                        : hazard.confidence === "medium" ? "var(--replay)"
                        : "var(--warn)" }}
        >
          {hazard.confidence} confidence
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 11,
                    marginTop: 8 }}>
        <ThreatIcon icon={hazard.icon} colour={hazard.colour} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, color: hazard.colour, fontWeight: 500,
                        letterSpacing: "-0.01em", lineHeight: 1.2 }}>
            {hazard.label}
          </div>
          <div className="tele" style={{ whiteSpace: "normal" }}>
            {hazard.technical}
          </div>
        </div>
      </div>

      {shift && (
        <div
          className="fade"
          style={{
            marginTop: 9, padding: "6px 9px", borderRadius: "var(--r-sm)",
            fontSize: 11, color: "var(--fg-1)",
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
          }}
        >
          Just changed: {shift.from} → <strong style={{ fontWeight: 500 }}>{shift.to}</strong>
        </div>
      )}

      {/* The sentence a non-specialist reads. Deliberately first, before any
          numbers, because it is the only part that needs no training. */}
      <p style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.65,
                  margin: "10px 0 0" }}>
        {hazard.why_this_matters}
      </p>

      {hazard.drivers.length > 0 && (
        <>
          <div className="tele" style={{ margin: "11px 0 5px" }}>
            What points to this
          </div>
          {hazard.drivers.map((d, i) => (
            <div key={i} style={{ display: "flex", gap: 7, alignItems: "baseline",
                                  marginBottom: 4 }}>
              <span
                style={{ color: d.direction === "down" ? "var(--ok)"
                              : d.direction === "up" ? hazard.colour
                              : "var(--fg-3)",
                         fontFamily: "var(--mono)", fontSize: 11, width: 10 }}
              >
                {ARROW[d.direction] ?? "→"}
              </span>
              <span style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.55 }}>
                <span style={{ color: "var(--fg)" }}>{d.label}</span>
                {" — "}
                <span style={{ color: "var(--fg-2)" }}>{d.detail}</span>
              </span>
            </div>
          ))}
        </>
      )}

      {hazard.secondary.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
          <span className="tele">also live</span>
          {hazard.secondary.map((s) => (
            <span key={s.key} className="tele"
                  style={{ color: "var(--fg-1)", border: "1px solid var(--line)",
                           borderRadius: 3, padding: "0 5px" }}>
              {s.label}
            </span>
          ))}
        </div>
      )}

      {/* How this was produced. Folded away, never absent: a viewer who wants
          to know whether a neural network chose this category can find out in
          one click, and one who does not is not made to read it. */}
      <button
        onClick={() => setShowBasis((v) => !v)}
        className="tele"
        style={{
          marginTop: 11, background: "none", border: "none", padding: 0,
          cursor: "pointer", color: "var(--fg-3)", textAlign: "left",
        }}
      >
        {showBasis ? "Hide" : "How was this decided?"}
      </button>
      {showBasis && (
        <div className="fade" style={{ fontSize: 10.5, color: "var(--fg-2)",
                                       lineHeight: 1.6, marginTop: 6 }}>
          <p style={{ margin: 0 }}>{hazard.basis}</p>
          <p style={{ margin: "6px 0 0" }}>{hazard.synthetic_note}</p>
          <div style={{ marginTop: 7 }}>
            {Object.entries(hazard.inputs).map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 6 }}>
                <span className="tele" style={{ minWidth: 118 }}>
                  {k.replace(/_/g, " ")}
                </span>
                <span className="num" style={{ color: "var(--fg-1)" }}>
                  {v === null ? "unavailable" : String(v)}
                </span>
                {hazard.synthetic_inputs.includes(k) && (
                  <span className="tele" style={{ color: "var(--warn)" }}>synthetic</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export { ThreatIcon };
