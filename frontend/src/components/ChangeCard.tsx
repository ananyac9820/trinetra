/* "What changed?"
 *
 * The question a person actually has on arriving at a moving situation is not
 * "what is the intensity" but "is this getting worse". Answering it from raw
 * imagery means comparing two satellite pictures by eye, which is a skill.
 * This is that comparison done for them.
 *
 * Every row is a real difference between two states the system computed at two
 * times. Where a quantity is missing at either end the row says so rather than
 * reporting a change of zero, because "no change" and "we could not tell" are
 * different answers and the second one is the more useful warning.
 *
 * Direction is coloured by whether it is worsening rather than by sign, since
 * falling central pressure and rising wind are the same news.
 */

import type { Changes } from "../api/types";

const ARROW: Record<string, string> = { up: "↑", down: "↓", flat: "→" };

interface Props {
  changes: Changes | null;
  loading?: boolean;
  compact?: boolean;
}

export default function ChangeCard({ changes, loading, compact }: Props) {
  if (loading && !changes) {
    return (
      <div className="glass" style={{ padding: "11px 13px", width: 268 }}>
        <span className="tele">Comparing with earlier…</span>
      </div>
    );
  }
  if (!changes) return null;

  if (!changes.available) {
    return (
      <div className="glass" style={{ width: compact ? "min(268px, calc(100vw - 28px))" : 268,
                                      padding: "11px 13px" }}>
        <div className="tele" style={{ marginBottom: 4 }}>What changed</div>
        <div style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.6 }}>
          {changes.reason}
        </div>
      </div>
    );
  }

  const usable = changes.rows.filter((r) => r.status === "ok");
  const missing = changes.rows.filter((r) => r.status !== "ok");

  return (
    <div
      className="glass rise"
      style={{ width: compact ? "min(268px, calc(100vw - 28px))" : 268,
               padding: "11px 13px 12px" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
        <div className="tele" style={{ color: "var(--fg-2)" }}>What changed</div>
        <span style={{ flex: 1 }} />
        <span className="tele">last {changes.window_hours} h</span>
      </div>

      {/* The headline, when the dominant hazard itself moved. */}
      {changes.hazard_shift && (
        <div
          className="fade"
          style={{
            margin: "8px 0 9px", padding: "7px 9px", borderRadius: "var(--r-sm)",
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
          }}
        >
          <div style={{ fontSize: 11.5, color: "var(--fg)" }}>
            {changes.hazard_shift.from.label}
            {" → "}
            <strong style={{ fontWeight: 500, color: "var(--accent)" }}>
              {changes.hazard_shift.to.label}
            </strong>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.55,
                        marginTop: 3 }}>
            {changes.hazard_shift.to.why_this_matters}
          </div>
        </div>
      )}

      <div style={{ marginTop: changes.hazard_shift ? 0 : 8 }}>
        {usable.map((r, i) => (
          <div
            key={i}
            title={r.plain}
            style={{ display: "flex", alignItems: "baseline", gap: 7,
                     padding: "3px 0",
                     borderBottom: "1px solid var(--line-soft)" }}
          >
            <span style={{ fontSize: 11, color: "var(--fg-1)", flex: 1,
                           minWidth: 0 }}>
              {r.label}
            </span>
            <span
              className="num"
              style={{ fontSize: 10.5, color: "var(--fg-3)" }}
            >
              {r.from}
            </span>
            <span
              style={{
                fontFamily: "var(--mono)", fontSize: 11, width: 11,
                textAlign: "center",
                color: r.direction === "flat" ? "var(--fg-3)"
                     : r.worsening ? "var(--warn)" : "var(--ok)",
              }}
            >
              {ARROW[r.direction ?? "flat"]}
            </span>
            <span
              className="num"
              style={{ fontSize: 12,
                       color: r.direction === "flat" ? "var(--fg-2)"
                            : r.worsening ? "var(--warn)" : "var(--ok)" }}
            >
              {r.to}
            </span>
          </div>
        ))}
      </div>

      {missing.length > 0 && (
        <div style={{ marginTop: 7 }}>
          {missing.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 7, alignItems: "baseline" }}>
              <span className="tele" style={{ flex: 1, color: "var(--fg-3)" }}>
                {r.label}
              </span>
              <span className="tele" style={{ color: "var(--fg-3)" }}>
                not comparable
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
