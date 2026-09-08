/* The multi-storm overview.
 *
 * The Archive answers "which storms exist"; this answers "what is on the map
 * right now". Selecting a storm from a table and landing in a single-storm
 * workspace is the right flow for studying one system and the wrong flow for
 * getting oriented, because it never shows you the basin.
 *
 * Kept deliberately light. The map is the centrepiece and this is a list that
 * sits over it, so each entry is four short lines: name, what it was at its
 * last fix, where it was heading, and which hazard led. Clicking one focuses
 * the map on it; the detailed single-storm analysis is unchanged behind it.
 *
 * "Recent" means the most recent seasons in the archive, not current systems.
 * Nothing here is live and the header says so, because calling a 2024 replay
 * "recent storms" without that qualifier is the kind of small dishonesty that
 * costs more than it buys.
 */

import { useMemo } from "react";
import { REGIME_PLAIN } from "../api/plain";
import type { StormSummary } from "../api/types";

const CATEGORY_SHORT: Record<string, string> = {
  D: "Depression", DD: "Deep Depression", CS: "Cyclonic Storm",
  SCS: "Severe Cyclonic Storm", VSCS: "Very Severe Cyclonic Storm",
  ESCS: "Extremely Severe", SuCS: "Super Cyclonic Storm",
};

/** The hazard a storm's last recorded state implies, in one word.
 *
 *  A local echo of the backend's rule set, on the two inputs the summary
 *  carries. Fetching the full hazard endpoint for every storm in the list
 *  would be a request per row to render a caption. It is deliberately coarser
 *  than the real classification and only ever labels a tendency. */
function concernOf(s: StormSummary): { label: string; colour: string } {
  const v = s.last_vmax_kt ?? 0;
  if (s.last_over_land) {
    return { label: "Rainfall concern", colour: "#fb923c" };
  }
  if (v >= 48) return { label: "Wind concern", colour: "#38bdf8" };
  if (v >= 34) return { label: "Wind concern", colour: "#38bdf8" };
  return { label: "Weak system", colour: "#64748b" };
}

function Arrow({ deg }: { deg: number | null }) {
  if (deg === null) return <span className="tele">track unknown</span>;
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden
         style={{ transform: `rotate(${deg}deg)`, flex: "none" }}>
      <path d="M12 3v18M12 3l-5 6M12 3l5 6" fill="none"
            stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}

interface Props {
  storms: StormSummary[];
  scope: "one" | "recent" | "all";
  selected: string | null;
  /** Additional storms drawn alongside the selected one. */
  compared: string[];
  onSelect: (id: string) => void;
  onToggleCompare: (id: string) => void;
  onScope: (scope: "one" | "recent" | "all") => void;
  compact?: boolean;
}

export const RECENT_COUNT = 6;

/** Which storms the overview draws, for a given scope. Exported so the map and
 *  the list cannot disagree about it. */
export function stormsInScope(storms: StormSummary[],
                              scope: "one" | "recent" | "all",
                              selected: string | null,
                              compared: string[]): StormSummary[] {
  if (scope === "all") return storms;
  if (scope === "recent") {
    // Most recent by start time, with the selected storm always included even
    // if it is older, so selecting from the Archive never empties the list.
    const recent = storms.slice(0, RECENT_COUNT);
    const extra = storms.filter(
      (s) => (s.storm_id === selected || compared.includes(s.storm_id)) &&
             !recent.some((r) => r.storm_id === s.storm_id));
    return [...recent, ...extra];
  }
  const picked = new Set([selected, ...compared].filter(Boolean) as string[]);
  return storms.filter((s) => picked.has(s.storm_id));
}

export default function StormOverview({ storms, scope, selected, compared,
                                        onSelect, onToggleCompare, onScope,
                                        compact }: Props) {
  const shown = useMemo(
    () => stormsInScope(storms, scope, selected, compared),
    [storms, scope, selected, compared]);

  const seasons = useMemo(() => {
    if (!shown.length) return null;
    const ys = shown.map((s) => s.season);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
  }, [shown]);

  return (
    <div
      className="glass rise"
      style={{
        width: compact ? "min(300px, calc(100vw - 28px))" : 300,
        maxHeight: "min(52vh, 460px)", display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "11px 13px 9px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <h3 style={{ fontSize: 12.5 }}>Storms on the map</h3>
          <span style={{ flex: 1 }} />
          <span className="tele">{shown.length}</span>
        </div>

        <div style={{ display: "flex", gap: 2, marginTop: 8 }}>
          {([["one", "Selected"], ["recent", "Recent"], ["all", "All"]] as const)
            .map(([k, label]) => (
            <button
              key={k}
              onClick={() => onScope(k)}
              className="pill"
              style={{
                flex: 1, border: "none", fontSize: 11, padding: "4px 0",
                background: scope === k ? "var(--accent-glow)" : "transparent",
                color: scope === k ? "var(--accent)" : "var(--fg-2)",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* The qualifier that keeps "Recent" honest. */}
        <div className="tele" style={{ marginTop: 7, whiteSpace: "normal",
                                       lineHeight: 1.5, color: "var(--fg-3)" }}>
          {scope === "one"
            ? "The storm you are analysing, plus anything you add to compare."
            : `Dataset replay${seasons ? `, ${seasons}` : ""}. These are ` +
              `archived storms, not systems active today.`}
        </div>
      </div>

      <div style={{ overflowY: "auto", flex: 1 }}>
        {shown.length === 0 && (
          <div style={{ padding: 14 }}>
            <span className="tele">No storms in this selection.</span>
          </div>
        )}
        {shown.map((s) => {
          const on = s.storm_id === selected;
          const inCompare = compared.includes(s.storm_id);
          const concern = concernOf(s);
          return (
            <div
              key={s.storm_id}
              style={{
                padding: "9px 13px",
                borderBottom: "1px solid var(--line-soft)",
                borderLeft: on ? "2px solid var(--accent)"
                          : inCompare ? "2px solid var(--fg-3)"
                          : "2px solid transparent",
                background: on ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                          : "transparent",
                transition: "background var(--t-fast) var(--ease-out)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                <button
                  onClick={() => onSelect(s.storm_id)}
                  title="Focus the map on this storm"
                  style={{
                    background: "none", border: "none", padding: 0,
                    cursor: "pointer", textAlign: "left", minWidth: 0,
                    color: on ? "var(--accent)" : "var(--fg)", fontSize: 13,
                    fontFamily: "var(--sans)",
                  }}
                >
                  {s.name}
                </button>
                <span className="tele">{s.season}</span>
                <span style={{ flex: 1 }} />
                {s.featured_slug && (
                  <span className="tele" style={{ color: "var(--accent)" }}>
                    featured
                  </span>
                )}
                <button
                  onClick={() => onToggleCompare(s.storm_id)}
                  title={inCompare ? "Remove from the map"
                                   : "Also draw this storm's track"}
                  className="tele"
                  style={{
                    background: "none", border: "none", padding: "0 2px",
                    cursor: "pointer",
                    color: inCompare ? "var(--accent)" : "var(--fg-3)",
                  }}
                >
                  {inCompare ? "shown" : "+ add"}
                </button>
              </div>

              <div style={{ fontSize: 11, color: "var(--fg-1)", marginTop: 2 }}>
                {CATEGORY_SHORT[s.last_category ?? ""] ??
                  (s.last_vmax_kt ? `${s.last_vmax_kt} kt` : "below depression")}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6,
                            marginTop: 3, color: "var(--fg-2)" }}>
                <Arrow deg={s.heading_deg} />
                <span className="tele" style={{ color: "var(--fg-2)" }}>
                  {s.heading_compass ? `moving ${s.heading_compass}` : "stationary"}
                  {s.speed_kt ? ` · ${s.speed_kt} kt` : ""}
                </span>
                <span style={{ flex: 1 }} />
                <span className="tele" style={{ color: concern.colour }}>
                  {concern.label}
                </span>
              </div>

              <div className="tele" style={{ marginTop: 2, color: "var(--fg-3)" }}>
                last fix {REGIME_PLAIN[s.last_regime] ??
                  s.last_regime.replace(/_/g, " ")}
                {s.made_landfall ? " · crossed the coast" : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
