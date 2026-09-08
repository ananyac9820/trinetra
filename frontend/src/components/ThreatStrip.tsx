/* The threat-evolution strip, drawn under the time axis.
 *
 * A timeline that shows only hours makes the viewer read the imagery to work
 * out what was happening. This strip puts the answer on the axis: the dominant
 * hazard as a run of coloured phases, labelled where there is room, so the
 * migration from wind at sea to rainfall and flooding inland is visible as one
 * shape before anything is clicked.
 *
 * It is the same information the ThreatCard gives for a single moment, laid
 * out along time, and it is the clearest single expression of the project's
 * argument. Reading left to right on a landfalling storm you get: strengthens,
 * runs as a wind threat, hits the coast, becomes a rainfall threat, floods,
 * fades. The threat does not stop at the coastline, and neither does the strip.
 */

import { useMemo } from "react";
import type { HazardTimeline } from "../api/types";

interface Props {
  timeline: HazardTimeline | null;
  /** Start and end of the axis this strip aligns to, so the phases line up
   *  with the scrubber above rather than with their own extent. */
  t0: number;
  t1: number;
  /** Current scrubber time, for the marker. */
  at: string | null;
  onSeek?: (iso: string) => void;
  height?: number;
}

export default function ThreatStrip({ timeline, t0, t1, at, onSeek,
                                      height = 16 }: Props) {
  const span = Math.max(t1 - t0, 1);

  const phases = useMemo(() => {
    if (!timeline) return [];
    return timeline.phases.map((p) => {
      const a = new Date(p.start_time).getTime();
      const b = new Date(p.end_time).getTime();
      const left = ((a - t0) / span) * 100;
      const width = Math.max(((b - a) / span) * 100, 0.7);
      return { ...p, left, width };
    });
  }, [timeline, t0, span]);

  if (!timeline || !phases.length) {
    return (
      <div style={{ height, display: "flex", alignItems: "center" }}>
        <span className="tele" style={{ color: "var(--fg-3)" }}>
          threat evolution unavailable
        </span>
      </div>
    );
  }

  const atPct = at
    ? ((new Date(at).getTime() - t0) / span) * 100
    : null;

  return (
    <div>
      <div
        style={{
          position: "relative", height, borderRadius: 4,
          overflow: "hidden", background: "var(--bg-3)",
        }}
      >
        {phases.map((p, i) => (
          <button
            key={i}
            onClick={() => onSeek?.(p.start_time)}
            title={`${p.label} — ${p.start_time.slice(0, 16).replace("T", " ")} to ${
              p.end_time.slice(0, 16).replace("T", " ")}`}
            className="sweep"
            style={{
              position: "absolute", left: `${p.left}%`, width: `${p.width}%`,
              top: 0, bottom: 0, padding: 0,
              border: "none", borderRadius: 0, cursor: onSeek ? "pointer" : "default",
              background: p.colour, opacity: 0.82,
              animationDelay: `${i * 60}ms`,
              display: "flex", alignItems: "center", justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {/* Label only where the phase is wide enough to hold one, so the
                strip never becomes a row of clipped words. */}
            {p.width > 13 && (
              <span
                style={{
                  fontFamily: "var(--mono)", fontSize: 8.5,
                  letterSpacing: "0.08em", textTransform: "uppercase",
                  color: "rgba(5,8,12,0.82)", whiteSpace: "nowrap",
                  fontWeight: 600,
                }}
              >
                {p.label}
              </span>
            )}
          </button>
        ))}

        {atPct !== null && atPct >= 0 && atPct <= 100 && (
          <div
            style={{
              position: "absolute", left: `${atPct}%`, top: -1, bottom: -1,
              width: 2, background: "var(--fg)", boxShadow: "0 0 4px rgba(0,0,0,0.8)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      {/* A key only for the phases this storm actually went through, rather
          than the whole vocabulary. */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 5 }}>
        <span className="tele" style={{ color: "var(--fg-3)" }}>
          biggest concern over time
        </span>
        {Array.from(new Map(phases.map((p) => [p.hazard, p])).values()).map((p) => (
          <span key={p.hazard} style={{ display: "inline-flex", alignItems: "center",
                                        gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2,
                           background: p.colour }} />
            <span className="tele" style={{ color: "var(--fg-2)" }}>{p.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
