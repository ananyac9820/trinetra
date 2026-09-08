/* Storm detail and evidence.
 *
 * The Explorer answers where and what. This page answers why, and how much
 * should I trust it, and it is where the scientific argument lives.
 *
 * Three stacked time series share an axis: intensity with its uncertainty band
 * and the comparison methods, RI probability with the operational threshold
 * drawn, and the disagreement spread over time. The third chart does not exist
 * in any other product and it is the one worth talking about.
 *
 * The evidence bars are measured, not asserted. Each sensor group is switched
 * off through the availability mask and the model re-run, so the bar is the
 * actual change in the estimate. That is only meaningful because the mask is a
 * model input, which means removing a channel is a state the model was trained
 * to handle rather than an out-of-distribution poke.
 */

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { api, formatUtc, num, REGIME_COLOR, REGIME_LABEL } from "../api/client";
import type { Analogue, Evidence, StormState, Track } from "../api/types";
import Series from "../components/Series";
import Page, { Section as PageSection } from "../components/Page";

export default function StormDetail() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const at = params.get("at") ?? undefined;

  const [state, setState] = useState<StormState | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [dis, setDis] = useState<any>(null);
  const [analogues, setAnalogues] = useState<Analogue[]>([]);
  const [analogueNote, setAnalogueNote] = useState<string | null>(null);

  useEffect(() => {
    api.state(id, at).then(setState).catch(() => {});
    api.track(id).then(setTrack).catch(() => {});
    api.evidence(id, at).then(setEvidence).catch(() => {});
    api.disagreement(id).then(setDis).catch(() => {});
    api.analogues(id, at).then((r) => {
      setAnalogues(r.analogues ?? []);
      setAnalogueNote(r.available ? (r.note ?? null) : (r.reason ?? null));
    }).catch(() => {});
  }, [id, at]);

  if (!state) {
    return (
      <Page eyebrow="Storm detail" title="Loading system…">
        <div className="tele">running inference at the requested time…</div>
      </Page>
    );
  }

  const i = state.intensity;
  const c = state.classification;
  const d = state.disagreement;

  return (
    <Page
      eyebrow={
        <>
          TRINETRA classifies this as{" "}
          {c.imd_category_label ?? c.imd_category ?? "unclassified"} ·{" "}
          {state.storm_id}
        </>
      }
      title={state.name}
      width={1180}
      lede={
        <>
          Evidence for the estimate at {formatUtc(state.valid_time)}. The
          Explorer answers where and what; this page answers why, and how much
          the answer should be trusted.
        </>
      }
      meta={
        <span className="tele">
          {state.tier} tier · model {state.provenance.model_version} · inference{" "}
          {state.provenance.inference_id.slice(0, 12)}
        </span>
      }
      actions={
        <>
          <Link to={`/explorer?storm=${state.storm_id}&at=${encodeURIComponent(
            state.valid_time)}`} className="btn primary"
            style={{ textDecoration: "none" }}>
            Open in Explorer
          </Link>
          <Link to={`/storm/${state.storm_id}/report?at=${encodeURIComponent(
            state.valid_time)}`} className="btn" style={{ textDecoration: "none" }}>
            Operational outputs
          </Link>
        </>
      }
    >
      <div>
        {/* current state */}
        <div
          className="panel ticked stagger"
          style={{ padding: "18px 20px", display: "grid",
                   gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))",
                   gap: 18 }}
        >
          <Big label="Current intensity"
               value={i.vmax_kt === null ? "not issued" : i.vmax_kt.toFixed(0)}
               unit={i.vmax_kt === null ? "" : "kt"}
               sub={i.ci_kt ? `± ${i.ci_kt.toFixed(0)} kt (90%)` : null} />
          <Big label="Minimum pressure"
               value={i.pmin_hpa === null ? "not issued" : i.pmin_hpa.toFixed(0)}
               unit={i.pmin_hpa === null ? "" : "hPa"}
               sub={i.pmin_ci ? `± ${i.pmin_ci.toFixed(0)} hPa` : null} />
          <Big label="Centre fix"
               value={`${state.centre.lat.toFixed(1)}°N ${state.centre.lon.toFixed(1)}°E`}
               unit=""
               sub={state.centre.sigma_km
                 ? `± ${state.centre.sigma_km.toFixed(0)} km`
                 : "uncertainty unavailable"} />
          <Big label="Regime"
               value={REGIME_LABEL[state.regime.label] ?? state.regime.label}
               unit=""
               colour={REGIME_COLOR[state.regime.label]}
               sub={state.regime.conf ? `conf ${state.regime.conf.toFixed(2)}` : null} />
          <Big label="Dvorak scene"
               value={c.dvorak_scene?.replace(/_/g, " ") ?? "--"}
               unit=""
               sub={c.dvorak_status} />
          <Big label="Best-track"
               value={num(i.observed_vmax_kt, 0)}
               unit="kt"
               sub={`${c.observed_category ?? "unclassified"} · ${i.label_agency}`} />
        </div>

        {state.centre.validated === false && state.centre.caveat && (
          <div
            className="panel"
            style={{ marginTop: 10, padding: "10px 13px",
                     borderColor: "color-mix(in srgb, var(--warn) 42%, transparent)",
                     background: "color-mix(in srgb, var(--warn) 6%, transparent)" }}
          >
            <div className="tele" style={{ color: "var(--warn)", marginBottom: 3 }}>
              Centre fix: disclosed negative result
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.65 }}>
              {state.centre.caveat}
            </div>
          </div>
        )}

        {/* RI */}
        <Section title="Rapid intensification, 24 hours" />
        <div className="panel ticked" style={{ padding: "16px 18px" }}>
          {state.ri.issued && state.ri.p24 !== null ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, height: 12, borderRadius: 6,
                              background: "var(--bg-3)", overflow: "hidden",
                              position: "relative" }}>
                  <div className="grow-x"
                       style={{ height: "100%",
                                width: `${Math.min(state.ri.p24 * 100, 100)}%`,
                                background: state.ri.above_threshold
                                  ? "var(--warn)" : "var(--accent)" }} />
                  <div style={{ position: "absolute", top: 0, bottom: 0,
                                left: `${state.ri.threshold * 100}%`, width: 2,
                                background: "var(--fg-1)" }}
                       title={`operational threshold ${(state.ri.threshold * 100).toFixed(0)}%`} />
                </div>
                <span className="num" style={{ fontSize: 22 }}>
                  {(state.ri.p24 * 100).toFixed(0)}%
                </span>
              </div>
              <div className="tele" style={{ marginTop: 6 }}>
                operational threshold {(state.ri.threshold * 100).toFixed(0)}%
                {state.ri.calibration ? ` · calibration: ${state.ri.calibration}` : ""}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.6 }}>
              <div className="tele" style={{ color: "var(--warn)", marginBottom: 4 }}>
                Not issued
              </div>
              {state.ri.reason ?? "Required inputs unavailable."}
              {state.ri.missing_inputs?.length ? (
                <div className="tele" style={{ marginTop: 5 }}>
                  missing: {state.ri.missing_inputs.join(", ")}
                </div>
              ) : null}
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 8 }}>
                The system is declining and naming what would enable the answer.
                An image-only RI number would not be supported by anything.
              </div>
            </div>
          )}
        </div>

        {/* evidence */}
        <Section title="Evidence" note={evidence?.method} />
        <div className="panel ticked" style={{ padding: "16px 18px" }}>
          {evidence?.available ? (
            <>
              <p style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.6,
                          margin: "0 0 12px" }}>
                {evidence.explanation}
              </p>
              {evidence.bars.map((b, k) => (
                <div key={b.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 12, color: b.available
                      ? "var(--fg)" : "var(--fg-3)", minWidth: 168 }}>
                      {b.label}
                    </span>
                    <div style={{ flex: 1, height: 7, borderRadius: 4,
                                  background: "var(--bg-3)", overflow: "hidden" }}>
                      <div
                        className="grow-x"
                        style={{
                          height: "100%", width: `${Math.max(b.bar * 100, 1)}%`,
                          background: b.available
                            ? (b.delta_vmax_kt ?? 0) >= 0
                              ? "var(--accent)" : "var(--warn)"
                            : "var(--line-strong)",
                          animationDelay: `${k * 60}ms`,
                        }}
                      />
                    </div>
                    <span className="num" style={{ fontSize: 11, width: 74,
                                                   textAlign: "right",
                                                   color: "var(--fg-1)" }}>
                      {b.delta_vmax_kt === null
                        ? "--"
                        : `${b.delta_vmax_kt >= 0 ? "+" : ""}${b.delta_vmax_kt.toFixed(1)} kt`}
                    </span>
                    <span className="num" style={{ fontSize: 10.5, width: 74,
                                                   textAlign: "right",
                                                   color: "var(--fg-3)" }}>
                      {b.delta_sigma_kt === null
                        ? ""
                        : `σ ${b.delta_sigma_kt >= 0 ? "+" : ""}${b.delta_sigma_kt.toFixed(1)}`}
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-3)",
                                marginLeft: 176, lineHeight: 1.45 }}>
                    {b.available ? b.why : b.note}
                  </div>
                </div>
              ))}
              {evidence.baseline && (
                <div className="tele" style={{ marginTop: 4 }}>
                  baseline with everything present: {evidence.baseline.vmax_kt} kt,
                  σ {evidence.baseline.sigma_kt} kt
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.6 }}>
              {evidence?.reason ?? "Evidence unavailable."}
            </div>
          )}
        </div>

        {/* time series */}
        <Section title="Time series" note="shared axis" />
        <div className="panel ticked" style={{ padding: "16px 18px" }}>
          {track && (
            <Series
              track={track}
              disagreement={dis}
              riThreshold={state.ri.threshold}
              markAt={state.valid_time}
            />
          )}
        </div>

        {/* disagreement */}
        <Section title="Disagreement" note={d.baseline_name} />
        <div className="panel ticked" style={{ padding: "16px 18px" }}>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
            <Big label="TRINETRA" value={num(d.trinetra_kt, 0)} unit="kt" />
            <Big label="Baseline" value={num(d.baseline_kt, 0)} unit="kt" />
            <Big label="IMD" value={num(d.imd_kt, 0)} unit="kt" />
            <Big label="Spread" value={num(d.spread_kt, 0)} unit="kt"
                 colour={d.above_threshold ? "var(--alert)" : undefined}
                 sub={`threshold ${d.threshold_kt} kt`} />
          </div>
          {d.above_threshold && d.driver && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-1)",
                          lineHeight: 1.55, padding: "8px 10px",
                          borderRadius: "var(--r-sm)",
                          border: "1px solid color-mix(in srgb, var(--alert) 38%, transparent)",
                          background: "color-mix(in srgb, var(--alert) 8%, transparent)" }}>
              Above the agreement threshold. Driver: {d.driver}.
            </div>
          )}
          {dis && (
            <div className="tele" style={{ marginTop: 8 }}>
              {dis.n_above_threshold} of {dis.series?.length ?? 0} timesteps above
              threshold ({((dis.fraction_above ?? 0) * 100).toFixed(0)}%)
            </div>
          )}
          {dis?.baseline_caveat && (
            <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 6,
                          lineHeight: 1.5 }}>
              {dis.baseline_caveat}
            </div>
          )}
        </div>

        {/* analogues */}
        <Section title="Closest historical analogues" />
        <div className="panel ticked" style={{ padding: "16px 18px" }}>
          {analogues.length ? (
            <>
              <div className="scroll-x">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Storm</th>
                      <th>Season</th>
                      <th>At</th>
                      <th className="num">VMAX</th>
                      <th>Regime</th>
                      <th className="num">ΔV 24h</th>
                      <th>Then intensified</th>
                      <th className="num">Similarity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analogues.map((a, k) => (
                      <tr key={k}>
                        <td style={{ color: "var(--fg)" }}>{a.name}</td>
                        <td className="num">{a.season}</td>
                        <td className="num">{formatUtc(a.valid_time)}</td>
                        <td className="num">{a.vmax_kt.toFixed(0)} kt</td>
                        <td>{(REGIME_LABEL[a.regime] ?? a.regime)}</td>
                        <td className="num">
                          {a.dv_24h_kt === null ? "--"
                            : `${a.dv_24h_kt >= 0 ? "+" : ""}${a.dv_24h_kt.toFixed(0)}`}
                        </td>
                        <td style={{ color: a.subsequently_ri
                          ? "var(--warn)" : "var(--fg-2)" }}>
                          {a.subsequently_ri === null ? "unknown"
                            : a.subsequently_ri ? "yes, rapidly" : "no"}
                        </td>
                        <td className="num">{a.similarity.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {analogueNote && (
                <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 8,
                              lineHeight: 1.5 }}>
                  {analogueNote}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
              {analogueNote ?? "No analogues available."}
            </div>
          )}
        </div>

        {/* abstentions */}
        {state.abstentions.length > 0 && (
          <>
            <Section title="Abstentions" note={`${state.abstentions.length} head(s) declined`} />
            <div className="panel ticked" style={{ padding: "16px 18px" }}>
              {state.abstentions.map((a, k) => (
                <div key={k} style={{ marginBottom: 10 }}>
                  <div className="tele" style={{ color: "var(--warn)" }}>{a.head}</div>
                  <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.55 }}>
                    {a.reason}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* environment, with provenance per feature */}
        <Section title="Environmental predictors" note="provenance per feature" />
        <div className="panel scroll-x" style={{ padding: "2px 0" }}>
          <table className="data">
            <thead>
              <tr>
                <th>Predictor</th>
                <th className="num">Value</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(state.environment).map(([k, v]) => {
                const prov = state.environment_provenance[k] ?? "unknown";
                const real = prov.startsWith("real");
                return (
                  <tr key={k}>
                    <td>{k.replace(/_/g, " ")}</td>
                    <td className="num">
                      {v === null ? "--"
                        : Math.abs(v) < 0.001 ? v.toExponential(1) : v.toFixed(2)}
                    </td>
                    <td>
                      <span className={`chip cls-${real ? "O" : "D"}`}>
                        {real ? prov.replace("real:", "") : "synthetic"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="disclaimer" style={{ marginTop: 20 }}>
          Decision support only. IMD / RSMC New Delhi is the responsible warning
          authority for the North Indian Ocean.{" "}
          {state.provenance.synthetic_imagery && (
            <>
              Gridded imagery in this analysis is a parametric reconstruction.
              Positions and intensity labels are real IBTrACS best-track.
            </>
          )}{" "}
          <Link to="/methods">Validation and limits →</Link>
        </div>
      </div>
    </Page>
  );
}

function Section({ title, note }: { title: string; note?: string | null }) {
  return <PageSection title={title} note={note ?? undefined} />;
}

function Big({ label, value, unit, sub, colour }: {
  label: string; value: string; unit: string; sub?: string | null; colour?: string;
}) {
  return (
    <div>
      <div className="tele">{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 2 }}>
        <span className="num count-in"
              style={{ fontSize: 19, color: colour ?? "var(--fg)" }}>
          {value}
        </span>
        {unit && <span className="tele">{unit}</span>}
      </div>
      {sub && <div className="tele" style={{ marginTop: 1 }}>{sub}</div>}
    </div>
  );
}
