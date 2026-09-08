/* "Why this estimate?" — the sensor-ablation evidence, in the Explorer.
 *
 * This is the most defensible explanation the system can offer, and it is
 * worth being precise about why. Each sensor group is switched off through the
 * availability mask and the model is re-run; the bar is the resulting change
 * in the intensity estimate. That is a measurement, not an attribution
 * heuristic, and it is only meaningful because the mask is a model input, so a
 * missing channel is a state the network was trained to handle rather than an
 * out-of-distribution poke.
 *
 * It is deliberately titled "evidence contributing to this assessment" rather
 * than anything causal. A change in output when an input is removed tells you
 * the model was using that input. It does not tell you the storm intensified
 * because of what that instrument saw, and the wording should not imply a
 * neural network reasons in these terms.
 *
 * Folded by default: it costs a request and a forward pass per sensor group,
 * so it runs when asked rather than on every scrubber step.
 */

import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Evidence } from "../api/types";

interface Props {
  stormId: string | null;
  at: string | null;
}

export default function WhyPanel({ stormId, at }: Props) {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Drop any previous answer when the moment changes, so an open panel never
    // shows evidence computed for a different timestep.
    setEvidence(null);
    setError(null);
  }, [stormId, at]);

  useEffect(() => {
    if (!open || !stormId || evidence || loading) return;
    setLoading(true);
    api.evidence(stormId, at ?? undefined)
      .then(setEvidence)
      .catch((e) => setError(String(e).slice(0, 140)))
      .finally(() => setLoading(false));
  }, [open, stormId, at, evidence, loading]);

  if (!stormId) return null;

  return (
    <div className="panel" style={{ padding: "8px 10px", marginTop: 8 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%",
          background: "none", border: "none", padding: 0, cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span className="tele" style={{ color: "var(--fg-2)" }}>
          Why this estimate?
        </span>
        <span style={{ flex: 1 }} />
        <span className="tele" style={{ color: "var(--accent)" }}>
          {open ? "hide" : "show"}
        </span>
      </button>

      {!open && (
        <div style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.5,
                      marginTop: 4 }}>
          Switches each sensor off and re-runs the model, to measure what it was
          actually using.
        </div>
      )}

      {open && (
        <div className="fade" style={{ marginTop: 8 }}>
          {loading && <div className="tele">Re-running with each sensor off…</div>}
          {error && (
            <div style={{ fontSize: 11, color: "var(--warn)", lineHeight: 1.55 }}>
              {error}
            </div>
          )}

          {evidence && !evidence.available && (
            <div style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.6 }}>
              {evidence.reason}
            </div>
          )}

          {evidence?.available && (
            <>
              <div style={{ fontSize: 10.5, color: "var(--fg-3)",
                            lineHeight: 1.55, marginBottom: 8 }}>
                Evidence contributing to this assessment. The bar is how much
                the wind estimate moved when that sensor was removed, not a
                claim about cause.
              </div>

              {evidence.bars.slice(0, 7).map((b, i) => {
                const delta = b.delta_vmax_kt;
                const width = Math.max(b.bar * 100, b.available ? 2 : 0);
                return (
                  <div key={b.id} style={{ marginBottom: 7 }}>
                    <div style={{ display: "flex", alignItems: "baseline",
                                  gap: 6 }}>
                      <span
                        style={{ fontSize: 11,
                                 color: b.available ? "var(--fg)" : "var(--fg-3)",
                                 flex: 1, minWidth: 0, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={b.available ? b.why : b.note}
                      >
                        {b.label}
                      </span>
                      {b.available ? (
                        <span className="num" style={{ fontSize: 10.5,
                                                       color: "var(--fg-2)" }}>
                          {delta === null ? "--"
                            : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} kt`}
                        </span>
                      ) : (
                        <span className="tele" style={{ color: "var(--fg-3)" }}>
                          not available
                        </span>
                      )}
                    </div>
                    <div style={{ height: 4, borderRadius: 3,
                                  background: "var(--bg-3)", marginTop: 3,
                                  overflow: "hidden" }}>
                      <div
                        className="grow-x"
                        style={{
                          height: "100%", width: `${width}%`,
                          background: !b.available ? "var(--line-strong)"
                            : (delta ?? 0) >= 0 ? "var(--accent)" : "var(--warn)",
                          animationDelay: `${i * 55}ms`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}

              {evidence.baseline && (
                <div className="tele" style={{ marginTop: 6,
                                               whiteSpace: "normal",
                                               lineHeight: 1.5 }}>
                  With everything present: {evidence.baseline.vmax_kt} kt,
                  spread {evidence.baseline.sigma_kt} kt
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
