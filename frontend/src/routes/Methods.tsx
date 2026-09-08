/* The methods page. The credibility page.
 *
 * A reviewer who cannot find the validation will assume there is none, so this
 * is linked from every page footer and it holds everything: the model card, the
 * two metric tables with their named baselines and bootstrap intervals, the
 * split configuration, the calibration result, the enumerated failure modes and
 * the honesty list.
 *
 * The two tables are kept separate and are never blended. Analysis estimates
 * the current state from current observations. Forecast predicts change at a
 * lead time. They have different baselines and a number that mixes them means
 * nothing.
 *
 * The provenance warning is placed above the analysis table rather than in a
 * footnote, because in this build the analysis metric is measuring the pipeline
 * rather than the science, and a reader who takes it for the latter has been
 * misled by the layout.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import Page, { Section } from "../components/Page";
import Pipeline from "../components/Pipeline";

export default function Methods() {
  const [m, setM] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.methods().then(setM).catch((e) => setErr(String(e)));
  }, []);

  if (err) {
    return (
      <Page title="Methods, validation and limits" eyebrow="Credibility">
        <div className="panel ticked" style={{ padding: "18px 20px",
          borderColor: "color-mix(in srgb, var(--alert) 40%, transparent)" }}>
          <div className="tele" style={{ color: "var(--alert)", marginBottom: 6 }}>
            Could not load the methods report
          </div>
          <div style={{ fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.6 }}>
            {err}. The API serves this page from the evaluation artefacts on
            disk; if the backend is not running there is nothing to report and
            nothing is invented in its place.
          </div>
        </div>
      </Page>
    );
  }
  if (!m) {
    return (
      <Page title="Methods, validation and limits" eyebrow="Credibility">
        <div className="tele">loading evaluation artefacts…</div>
      </Page>
    );
  }

  const bl = m.baselines ?? {};
  const am = m.analysis_model ?? {};
  const lu = bl.label_uncertainty ?? {};

  return (
    <Page
      eyebrow="Credibility"
      title="Methods, validation and limits"
      width={1060}
      lede={
        <>
          Every headline number here carries a named baseline and a bootstrap
          interval resampled over storms rather than over rows. The split
          configuration is published below so the numbers can be reproduced
          instead of taken on trust.
        </>
      }
      actions={
        <Link to="/archive" className="btn" style={{ textDecoration: "none" }}>
          Browse the archive
        </Link>
      }
    >
      <div>
        {m.warnings?.length > 0 && (
          <div className="panel" style={{ padding: "10px 14px", marginTop: 14,
            borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}>
            <div className="tele" style={{ color: "var(--warn)", marginBottom: 4 }}>
              Build warnings
            </div>
            {m.warnings.map((w: string, i: number) => (
              <div key={i} style={{ fontSize: 11.5, color: "var(--fg-1)",
                                    lineHeight: 1.55 }}>
                {w}
              </div>
            ))}
          </div>
        )}

        {/* ---------------------------------------------- how it works
            Two levels on one page, in this order. A reviewer with a
            meteorology background wants the tables; a reviewer without one
            needs to know what the thing does before the tables mean anything.
            Putting the plain version first costs the specialist one scroll and
            saves the non-specialist the whole page. */}
        <H2>How it works</H2>
        <div className="panel" style={{ padding: "18px 20px 14px" }}>
          <Pipeline />
          <div className="hair" style={{ margin: "18px 0 14px" }} />
          <div style={{ display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
                        gap: 18 }}>
            <Plain
              q="Why several satellites?"
              a="Each one is blind to something. Infrared sees the cloud tops but
                 not through them, so a solid canopy hides the core. Microwave
                 sees through the canopy but only passes overhead a few times a
                 day. A cloud picture cannot see how warm the ocean underneath
                 is, and the ocean is the fuel. Reading them together is the
                 only way to cover each one's blind spot." />
            <Plain
              q="What happens when a satellite is missing?"
              a="The model is told which sensors it had, as an input, and it was
                 trained with them going missing at the rates they really do.
                 So it degrades instead of breaking, and the interface says
                 which sensors were behind any given estimate and how old they
                 were." />
            <Plain
              q="How does it know it might be wrong?"
              a="Three ways, and all three are on screen. The intensity band is
                 a checked 90 percent range rather than a guess. Its estimate is
                 shown next to the other methods, and the gap between them is
                 flagged. And heads that lack a required input return nothing
                 rather than a number." />
            <Plain
              q="What does it do that a cyclone map does not?"
              a="It keeps going after the coast. A phase classifier tracks
                 whether the system is at sea, being sheared, over land or a
                 remnant, and the leading hazard changes with it: wind at sea,
                 wind and rain at the coast, rainfall and flooding inland. That
                 last phase does most of the damage and is where cyclone
                 products usually stop." />
          </div>
        </div>

        <H2>Technical details</H2>
        <p style={{ fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.7,
                    maxWidth: 780, margin: "0 0 14px" }}>
          Everything below is the specialist version: the baselines, the split
          protocol, the calibration result, the failure modes and the things
          this build does not have. Nothing here is rounded in the product's
          favour.
        </p>

        {/* ---------------------------------------------- label uncertainty */}
        <H2>Label uncertainty</H2>
        <div className="panel ticked" style={{ padding: "16px 18px" }}>
          <p style={{ fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.65,
                      margin: 0 }}>
            {lu.description ??
              "Absolute IMD minus JTWC intensity, after converting JTWC's " +
              "1-minute sustained wind to IMD's 3-minute averaging period."}
          </p>
          <div style={{ display: "flex", gap: 26, marginTop: 12, flexWrap: "wrap" }}>
            <Stat label="Fixes with both agencies" value={fmtInt(lu.n)} />
            <Stat label="Mean disagreement" value={fmt(lu.mean_kt, 2)} unit="kt" />
            <Stat label="Median" value={fmt(lu.median_kt, 2)} unit="kt" />
            <Stat label="90th percentile" value={fmt(lu.p90_kt, 2)} unit="kt" />
          </div>
          <div style={{ fontSize: 12, color: "var(--warn)", marginTop: 12,
                        lineHeight: 1.6 }}>
            {lu.note ?? "An intensity RMSE below this is a leakage bug, not a result."}
            {" "}Published satellite intensity estimation sits in the 8 to 10 kt
            RMSE band, which is the same order.
          </div>
        </div>

        {/* ---------------------------------------------- table B: forecast */}
        <H2>Table B: forecast</H2>
        <Note>
          Intensity change at a lead time, out of fold under
          leave-one-season-out with the storm as the group key. These run on real
          IBTrACS best-track predictors, so these numbers are real.
        </Note>
        {["vmax_12h", "vmax_24h", "vmax_48h"].map((k) => {
          const rows = bl.forecast?.[k];
          if (!rows) return null;
          return (
            <div key={k} className="panel scroll-x"
                 style={{ marginBottom: 12, padding: "4px 0" }}>
              <div className="tele" style={{ padding: "8px 14px 2px" }}>
                {k.replace("vmax_", "+").replace("h", " hours")}
              </div>
              <table className="data">
                <thead>
                  <tr>
                    <th>Baseline</th>
                    <th className="num">n</th>
                    <th className="num">RMSE</th>
                    <th className="num">95% interval</th>
                    <th className="num">MAE</th>
                    <th className="num">Bias</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: any) => (
                    <tr key={r.baseline}>
                      <td style={{ color: "var(--fg)" }}>{r.baseline}</td>
                      <td className="num">{fmtInt(r.n)}</td>
                      <td className="num">{fmt(r.rmse, 2)}</td>
                      <td className="num" style={{ color: "var(--fg-2)" }}>
                        [{fmt(r.rmse_ci?.ci_lo, 2)}, {fmt(r.rmse_ci?.ci_hi, 2)}]
                      </td>
                      <td className="num">{fmt(r.mae, 2)}</td>
                      <td className="num">{fmt(r.bias, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}

        {/* stratified */}
        {bl.forecast?.vmax_24h?.find((r: any) => r.baseline === "CLIPER")
          ?.by_intensity?.length > 0 && (
          <div className="panel scroll-x" style={{ padding: "2px 0" }}>
            <div className="tele" style={{ padding: "8px 14px 2px" }}>
              CLIPER at +24 h, stratified by verifying intensity
            </div>
            <table className="data">
              <thead>
                <tr>
                  <th>Bin</th>
                  <th className="num">n</th>
                  <th className="num">RMSE</th>
                  <th className="num">MAE</th>
                  <th className="num">Bias</th>
                </tr>
              </thead>
              <tbody>
                {bl.forecast.vmax_24h.find((r: any) => r.baseline === "CLIPER")
                  .by_intensity.map((b: any) => (
                  <tr key={b.bin}>
                    <td>{b.bin}</td>
                    <td className="num">{fmtInt(b.n)}</td>
                    <td className="num">{fmt(b.rmse, 2)}</td>
                    <td className="num">{fmt(b.mae, 2)}</td>
                    <td className="num" style={{
                      color: Math.abs(b.bias ?? 0) > 12 ? "var(--warn)" : undefined }}>
                      {fmt(b.bias, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 11.5, color: "var(--fg-2)", padding: "8px 14px",
                          lineHeight: 1.55 }}>
              The bias running from positive on depressions to strongly negative
              above 90 kt is a linear model regressing extremes toward the mean.
              It is reported rather than hidden, because a model that is
              systematically 29 kt low on the strongest cases is a different
              problem from one that is noisy.
            </div>
          </div>
        )}

        {/* ---------------------------------------------- RI */}
        <H2>Rapid intensification, and what calibration is for</H2>
        {bl.forecast?.ri_24h && (
          <>
            <div className="panel scroll-x" style={{ padding: "2px 0" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Base rate</th>
                    <th className="num">Mean forecast</th>
                    <th className="num">Brier</th>
                    <th className="num">BSS</th>
                    <th className="num">AUC</th>
                    <th className="num">POD</th>
                    <th className="num">FAR</th>
                  </tr>
                </thead>
                <tbody>
                  {bl.forecast.ri_24h.map((r: any) => (
                    <tr key={r.baseline}>
                      <td style={{ color: "var(--fg)" }}>{r.baseline}</td>
                      <td className="num">{fmt(r.base_rate, 4)}</td>
                      <td className="num" style={{
                        color: Math.abs((r.mean_forecast ?? 0) - (r.base_rate ?? 0)) > 0.05
                          ? "var(--alert)" : "var(--ok)" }}>
                        {fmt(r.mean_forecast, 4)}
                      </td>
                      <td className="num">{fmt(r.brier, 5)}</td>
                      <td className="num" style={{
                        color: (r.brier_skill_score ?? 0) > 0 ? "var(--ok)" : "var(--alert)" }}>
                        {fmt(r.brier_skill_score, 3)}
                      </td>
                      <td className="num">{fmt(r.roc_auc, 3)}</td>
                      <td className="num">{fmt(r.contingency?.pod, 3)}</td>
                      <td className="num">{fmt(r.contingency?.far, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {bl.forecast.ri_24h_note && (
              <div className="panel" style={{ padding: "12px 14px", marginTop: 10,
                fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.65 }}>
                {bl.forecast.ri_24h_note}
              </div>
            )}
            {bl.forecast.climatology_auc_note && (
              <div className="panel" style={{ padding: "12px 14px", marginTop: 8,
                fontSize: 12, color: "var(--fg-2)", lineHeight: 1.6 }}>
                {bl.forecast.climatology_auc_note}
              </div>
            )}
          </>
        )}

        {/* ---------------------------------------------- table A */}
        <H2>Table A: analysis</H2>
        {am.provenance_warning && (
          <div
            className="panel"
            style={{
              padding: "12px 14px", marginBottom: 12,
              borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)",
              background: "color-mix(in srgb, var(--warn) 7%, transparent)",
            }}
          >
            <div className="tele" style={{ color: "var(--warn)", marginBottom: 4 }}>
              Read this before the analysis numbers
            </div>
            <div style={{ fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.65 }}>
              {am.provenance_warning}
            </div>
          </div>
        )}

        {bl.analysis?.imd_ci_regression && (
          <div className="panel" style={{ padding: "14px 16px", marginBottom: 12 }}>
            <div className="tele" style={{ marginBottom: 6 }}>
              Analysis baseline
            </div>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <Stat label={bl.analysis.imd_ci_regression.baseline}
                    value={fmt(bl.analysis.imd_ci_regression.rmse, 2)} unit="kt RMSE" />
              <Stat label="95% interval"
                    value={`[${fmt(bl.analysis.imd_ci_regression.rmse_ci?.ci_lo, 2)}, ${
                      fmt(bl.analysis.imd_ci_regression.rmse_ci?.ci_hi, 2)}]`} />
              <Stat label="MAE" value={fmt(bl.analysis.imd_ci_regression.mae, 2)}
                    unit="kt" />
              <Stat label="n" value={fmtInt(bl.analysis.imd_ci_regression.n)} />
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 10,
                          lineHeight: 1.6 }}>
              {bl.analysis.imd_ci_regression.caveat}
            </div>
          </div>
        )}

        {am.analysis && (
          <div className="panel ticked" style={{ padding: "16px 18px" }}>
            <div className="tele" style={{ marginBottom: 8 }}>TRINETRA model</div>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <Stat label="VMAX RMSE" value={fmt(am.analysis.vmax_rmse_ci?.point, 2)}
                    unit="kt"
                    sub={`[${fmt(am.analysis.vmax_rmse_ci?.ci_lo, 2)}, ${
                      fmt(am.analysis.vmax_rmse_ci?.ci_hi, 2)}]`} />
              <Stat label="VMAX MAE" value={fmt(am.analysis.vmax?.mae, 2)} unit="kt"
                    sub={`bias ${fmt(am.analysis.vmax?.bias, 2)}`} />
              <Stat label="Centre fix, median"
                    value={fmt(am.analysis.centre_fix_km?.median, 1)} unit="km"
                    sub={`p90 ${fmt(am.analysis.centre_fix_km?.p90, 1)} km`} />
              <Stat label="IMD category, macro-F1"
                    value={fmt(am.analysis.category?.macro_f1, 3)} />
              <Stat label="Regime, macro-F1"
                    value={fmt(am.analysis.regime?.macro_f1, 3)} />
              <Stat label="Conformal 90% band"
                    value={`± ${fmt(am.analysis.conformal_vmax?.half_width_kt, 1)}`}
                    unit="kt"
                    sub={`coverage ${fmt(am.analysis.conformal_vmax?.empirical_coverage, 3)}`} />
            </div>

            {am.analysis.centre_fix_km?.note && (
              <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 12,
                            lineHeight: 1.6 }}>
                {am.analysis.centre_fix_km.note}
              </div>
            )}

            {am.analysis.conformal_vmax?.empirical_coverage && (
              <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 8,
                            lineHeight: 1.6 }}>
                The conformal band's stated 90 percent coverage was verified
                empirically at{" "}
                {(am.analysis.conformal_vmax.empirical_coverage * 100).toFixed(1)}
                {" "}percent on held-out data, rather than assumed from a
                multiple of a standard deviation. That is what lets the Explorer
                draw a cone with a coverage claim attached to it.
              </div>
            )}

            {am.split && (
              <div className="tele" style={{ marginTop: 10 }}>
                {am.split.protocol}, test seasons{" "}
                {(am.split.test_seasons ?? []).join(", ")} ·{" "}
                {fmtInt(am.split.train_fixes)} train / {fmtInt(am.split.test_fixes)}{" "}
                test fixes · group key {am.split.group_key}
              </div>
            )}
          </div>
        )}

        {am.dvorak_head && (
          <div className="panel" style={{ padding: "12px 14px", marginTop: 10 }}>
            <div className="tele" style={{ marginBottom: 4 }}>
              Dvorak scene head: {am.dvorak_head.status}
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.6 }}>
              {am.dvorak_head.reason}
            </div>
          </div>
        )}

        {/* ---------------------------------------------- independent truth */}
        <H2>The independent-truth subset</H2>
        <div
          className="panel"
          style={{ padding: "14px 16px",
            borderColor: "color-mix(in srgb, var(--alert) 34%, transparent)" }}
        >
          <div className="tele" style={{ color: "var(--alert)", marginBottom: 6 }}>
            Status: {bl.independent_truth_subset?.status ?? "absent"} (
            {bl.independent_truth_subset?.n_cases ?? 0} cases)
          </div>
          <div style={{ fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.65 }}>
            {bl.independent_truth_subset?.reason ??
              "NOAA SAR TC Wind was not pulled in this build."}
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 10,
                        lineHeight: 1.6 }}>
            This is the single most credibility-enhancing number available to a
            project in this basin, and it is reported as absent rather than
            approximated. Best-track intensity here is largely Dvorak-derived, so
            a second error measured against a non-Dvorak source, such as the
            estimated Vmax in the NOAA SAR TC Wind product, would change the
            claim from "we agree with the analysts" to "we agree with an
            independent instrument". The client is written and needs credentials,
            not code.
          </div>
        </div>

        {/* ---------------------------------------------- splits */}
        {m.splits && (
          <>
            <H2>Split configuration</H2>
            <Note>
              Grouped by storm from the first experiment. Consecutive best-track
              fixes are three hours apart and near-duplicates, so a random split
              puts near-copies on both sides and the model scores well having
              learned nothing.
            </Note>
            <div className="panel scroll-x" style={{ padding: "2px 0" }}>
              <div style={{ display: "flex", gap: 22, padding: "8px 14px",
                            flexWrap: "wrap" }}>
                <Stat label="Fixes" value={fmtInt(m.splits.n_fixes)} />
                <Stat label="Storms" value={fmtInt(m.splits.n_storms)} />
                <Stat label="Folds" value={fmtInt(m.splits.folds?.length)} />
                <Stat label="Group key" value={m.splits.group_key} />
                <Stat label="Seasons"
                      value={`${m.splits.seasons?.[0]}-${
                        m.splits.seasons?.[m.splits.seasons.length - 1]}`} />
              </div>
            </div>
          </>
        )}

        {/* ---------------------------------------------- OOD */}
        {m.ood?.calibration && (
          <>
            <H2>Out-of-distribution gate</H2>
            <div className="panel ticked" style={{ padding: "16px 18px" }}>
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                <Stat label="Threshold" value={fmt(m.ood.threshold, 3)}
                      sub={`quantile ${m.ood.calibration.quantile}`} />
                <Stat label="Training median"
                      value={fmt(m.ood.calibration.train_median, 3)} />
                <Stat label="Training p99"
                      value={fmt(m.ood.calibration.train_p99, 3)} />
                <Stat label="Embedding dimension"
                      value={fmtInt(m.ood.calibration.dim)} />
                <Stat label="Covariance shrinkage"
                      value={fmt(m.ood.calibration.shrinkage, 3)} />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 10,
                            lineHeight: 1.6 }}>
                Mahalanobis distance on the fused embedding, with a shrunk
                covariance. Shrinkage is not optional at this size: with a
                256-dimensional embedding and a few thousand samples the sample
                covariance is nearly singular, and inverting it directly produces
                enormous distances driven by its smallest eigenvalues rather than
                by anything about the input.
              </div>
            </div>
          </>
        )}

        {/* ---------------------------------------------- failure modes */}
        <H2>Known failure modes</H2>
        <div className="panel ticked" style={{ padding: "16px 18px" }}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5,
                       color: "var(--fg-1)", lineHeight: 1.75 }}>
            {(m.known_failure_modes ?? []).map((f: string, i: number) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>

        <H2>Not attempted</H2>
        <div className="panel ticked" style={{ padding: "16px 18px" }}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5,
                       color: "var(--fg-1)", lineHeight: 1.75 }}>
            {(m.not_attempted ?? []).map((f: string, i: number) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>

        <H2>Honesty register</H2>
        <div className="panel ticked" style={{ padding: "16px 18px" }}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5,
                       color: "var(--fg-1)", lineHeight: 1.75 }}>
            {(m.honesty ?? []).map((f: string, i: number) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>

        {/* ---------------------------------------------- reference points */}
        {m.reference_points && (
          <>
            <H2>Reference points</H2>
            <div className="panel scroll-x" style={{ padding: "2px 0" }}>
              <table className="data">
                <tbody>
                  <tr>
                    <td>Published satellite intensity estimation</td>
                    <td className="num">
                      {m.reference_points.published_satellite_intensity_rmse_kt} kt RMSE
                    </td>
                  </tr>
                  <tr>
                    <td>IMD operational intensity, Fengal 2024</td>
                    <td className="num">
                      {objRow(m.reference_points.imd_fengal_2024_intensity_abs_error_kt,
                              "kt")}
                    </td>
                  </tr>
                  <tr>
                    <td>Long-period-average intensity error</td>
                    <td className="num">
                      {objRow(m.reference_points.imd_fengal_2024_lpa_intensity_error_kt,
                              "kt")}
                    </td>
                  </tr>
                  <tr>
                    <td>IMD operational track, Fengal 2024</td>
                    <td className="num">
                      {objRow(m.reference_points.imd_fengal_2024_track_error_km, "km")}
                    </td>
                  </tr>
                  <tr>
                    <td>Historical NIO direct position error</td>
                    <td className="num">
                      {objRow(m.reference_points.historical_nio_position_error_km, "km")}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ---------------------------------------------- dataset card */}
        {m.dataset_card_markdown && (
          <>
            <H2>Dataset card</H2>
            <details className="panel" style={{ padding: "12px 14px" }}>
              <summary style={{ cursor: "pointer", fontSize: 12.5,
                                color: "var(--fg-1)" }}>
                Full dataset card, including which fields are real and which are
                synthetic
              </summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap", fontSize: 11, lineHeight: 1.6,
                  color: "var(--fg-2)", fontFamily: "var(--mono)",
                  marginTop: 12, maxHeight: 520, overflowY: "auto",
                }}
              >
                {m.dataset_card_markdown}
              </pre>
            </details>
          </>
        )}

        <div className="disclaimer" style={{ marginTop: 30 }}>
          Decision support only. IMD / RSMC New Delhi is the responsible warning
          authority for the North Indian Ocean.{" "}
          <Link to="/">Back to overview</Link>
        </div>
      </div>
    </Page>
  );
}

/** A plain-language question and answer. No jargon in the question, and the
 *  answer says what is true rather than what sells. */
function Plain({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--fg)" }}>{q}</div>
      <p style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.7,
                  margin: "6px 0 0" }}>
        {a}
      </p>
    </div>
  );
}


function H2({ children }: { children: React.ReactNode }) {
  return <Section title={String(children)} />;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.6,
                margin: "0 0 10px", maxWidth: 780 }}>
      {children}
    </p>
  );
}

function Stat({ label, value, unit, sub }: { label: string; value: string;
                                             unit?: string; sub?: string }) {
  return (
    <div>
      <div className="tele">{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        <span className="num" style={{ fontSize: 16, color: "var(--fg)" }}>{value}</span>
        {unit && <span className="tele">{unit}</span>}
      </div>
      {sub && <div className="tele">{sub}</div>}
    </div>
  );
}

const fmt = (v: unknown, d = 2) =>
  typeof v === "number" && isFinite(v) ? v.toFixed(d) : "--";
const fmtInt = (v: unknown) =>
  typeof v === "number" && isFinite(v) ? v.toLocaleString("en-IN") : "--";
const objRow = (o: Record<string, number> | undefined, unit: string) =>
  o ? Object.entries(o).map(([k, v]) => `${k} ${v}${unit}`).join(" · ") : "--";
