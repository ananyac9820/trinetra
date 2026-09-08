/* The selected-system panel.
 *
 * The map answers where and what. This panel starts answering how much should I
 * trust it, and the storm detail page finishes the job.
 *
 * Four rows here are the ones that make this not a general weather product:
 * the sensor mode with its confidence, the abstentions rendered as first-class
 * rows rather than as blanks, the disagreement spread, and the out-of-basin
 * gate. Everything else is table stakes.
 */

import { Link } from "react-router-dom";
import { formatAge, formatUtc, num, REGIME_LABEL, REGIME_COLOR } from "../api/client";
import { CATEGORY_PLAIN, REGIME_PLAIN } from "../api/plain";
import type { StormState } from "../api/types";

const CATEGORY_LABEL: Record<string, string> = {
  D: "Depression", DD: "Deep Depression", CS: "Cyclonic Storm",
  SCS: "Severe Cyclonic Storm", VSCS: "Very Severe Cyclonic Storm",
  ESCS: "Extremely Severe Cyclonic Storm", SuCS: "Super Cyclonic Storm",
};

const CONFIDENCE_COLOUR: Record<string, string> = {
  high: "var(--ok)", medium: "var(--replay)", low: "var(--warn)",
  insufficient: "var(--alert)",
};

interface Props {
  state: StormState | null;
  loading?: boolean;
}

export default function SidePanel({ state, loading }: Props) {
  if (!state) {
    return (
      <div style={{ padding: 16 }}>
        <div className="tele">Selected system</div>
        {loading ? (
          <div style={{ marginTop: 12 }}>
            {/* Skeleton rather than a spinner: the panel's shape is stable, so
                showing its shape is more informative than showing motion. */}
            {[62, 88, 44, 74].map((w, k) => (
              <div
                key={k}
                className="fade"
                style={{
                  height: 11, width: `${w}%`, marginBottom: 9, borderRadius: 3,
                  background: "rgba(255,255,255,0.055)",
                  animationDelay: `${k * 90}ms`,
                }}
              />
            ))}
            <div className="tele" style={{ marginTop: 14 }}>
              running inference…
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 8,
                        lineHeight: 1.6 }}>
            No system selected. Pick one from the storm selector, or click a
            marker on the map.
          </div>
        )}
      </div>
    );
  }

  const i = state.intensity;
  const c = state.classification;
  const sm = state.sensor_mode;
  const d = state.disagreement;

  return (
    <div className="stagger" style={{ padding: "12px 14px 16px", overflowY: "auto",
                                      flex: 1, minHeight: 0 }}>
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
          <h3 style={{ fontSize: 16 }}>{state.name}</h3>
          <span className="tele">{state.storm_id}</span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-1)" }}>
          {c.imd_category_label ??
            (c.imd_category ? CATEGORY_LABEL[c.imd_category] : "unclassified")}
        </div>
        {c.imd_category && CATEGORY_PLAIN[c.imd_category] && (
          <div style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.5,
                        marginTop: 3 }}>
            {CATEGORY_PLAIN[c.imd_category]}
          </div>
        )}
        <div className="tele" style={{ marginTop: 4 }}>
          {formatUtc(state.valid_time)} · {state.tier} tier
        </div>
      </div>

      {/* Intensity, with the uncertainty band that every derived number has to
          carry. */}
      <div className="panel" style={{ padding: "8px 10px", marginTop: 10 }}>
        <Metric
          label="Strongest wind"
          title="TRINETRA's estimate of the peak sustained wind, with the range it is confident about."
          value={i.vmax_kt === null ? "not issued" : `${i.vmax_kt.toFixed(0)}`}
          unit={i.vmax_kt === null ? "" : "kt"}
          ci={i.ci_kt}
          big
        />
        <Metric
          label="Pressure at centre"
          title="Lower pressure means a stronger storm."
          value={i.pmin_hpa === null ? "not issued" : `${i.pmin_hpa.toFixed(0)}`}
          unit={i.pmin_hpa === null ? "" : "hPa"}
          ci={i.pmin_ci}
        />
        <div className="hair" style={{ margin: "7px 0" }} />
        <Metric
          label="Official record"
          title="The agency best-track value for the same moment, for comparison."
          value={num(i.observed_vmax_kt, 0)}
          unit="kt"
          note={i.label_agency}
        />
        <Metric
          label="Eye position"
          title="Where the centre is, and how far off that could be."
          value={`${state.centre.lat.toFixed(1)}°N ${state.centre.lon.toFixed(1)}°E`}
          unit=""
          ci={state.centre.sigma_km}
          ciUnit="km"
        />
        <Metric label="Cloud pattern"
                title="The shape the storm's clouds make, which is what forecasters have read from satellite images since the 1970s."
                value={c.dvorak_scene?.replace(/_/g, " ") ?? "--"}
                unit="" conf={c.dvorak_conf} note={c.dvorak_status} />
        <Metric
          label="Phase"
          title="Where the storm is in its life: at sea, being torn apart by wind shear, over land, or a decaying remnant."
          value={REGIME_PLAIN[state.regime.label] ??
                 REGIME_LABEL[state.regime.label] ?? state.regime.label}
          unit=""
          conf={state.regime.conf}
          colour={REGIME_COLOR[state.regime.label]}
        />
      </div>

      {/* RI. When it declines, the reason is the most valuable line here. */}
      <div className="panel" style={{ padding: "8px 10px", marginTop: 8 }}>
        <div className="tele" style={{ marginBottom: 2 }}>
          Chance of rapid strengthening
        </div>
        <div style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.5,
                      marginBottom: 7 }}>
          How likely it is to gain 30 kt or more within 24 hours.
        </div>
        {state.ri.issued && state.ri.p24 !== null ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  flex: 1, height: 7, borderRadius: 4,
                  background: "var(--bg-3)", overflow: "hidden",
                }}
              >
                <div
                  className="grow-x"
                  style={{
                    height: "100%",
                    width: `${Math.min(state.ri.p24 * 100, 100)}%`,
                    background: state.ri.above_threshold
                      ? "var(--warn)" : "var(--accent)",
                  }}
                />
              </div>
              <span className="num" style={{ fontSize: 14 }}>
                {(state.ri.p24 * 100).toFixed(0)}%
              </span>
            </div>
            <div className="tele" style={{ marginTop: 4 }}>
              threshold {(state.ri.threshold * 100).toFixed(0)}%
              {state.ri.calibration ? ` · ${state.ri.calibration}` : ""}
            </div>
          </>
        ) : (
          <div
            style={{
              fontSize: 11, color: "var(--fg-1)", lineHeight: 1.5,
              padding: "6px 8px", borderRadius: "var(--r-sm)",
              border: "1px solid color-mix(in srgb, var(--warn) 34%, transparent)",
              background: "color-mix(in srgb, var(--warn) 8%, transparent)",
            }}
          >
            <div className="tele" style={{ color: "var(--warn)", marginBottom: 3 }}>
              Not issued
            </div>
            {state.ri.reason ??
              "Required inputs were not available at this timestep."}
            {state.ri.missing_inputs?.length ? (
              <div className="tele" style={{ marginTop: 4 }}>
                missing: {state.ri.missing_inputs.join(", ")}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Sensor mode. What the estimate was actually computed from. */}
      <div className="panel" style={{ padding: "8px 10px", marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span className="tele">Instruments used</span>
          <span style={{ flex: 1 }} />
          <span
            className="tele"
            style={{ color: CONFIDENCE_COLOUR[sm.confidence] ?? "var(--fg-2)" }}
          >
            {sm.confidence}
          </span>
        </div>
        <div className="num" style={{ fontSize: 11.5, marginTop: 3,
                                      color: "var(--fg)", wordBreak: "break-word" }}>
          {sm.present.map((p) => p.toUpperCase()).join("+") || "NONE"}
        </div>
        {sm.absent.length > 0 && (
          <div className="tele" style={{ marginTop: 4, whiteSpace: "normal",
                                         lineHeight: 1.5 }}>
            not available at this moment: {sm.absent.join(", ")}
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px", marginTop: 5 }}>
          {Object.entries(sm.ages_minutes).map(([ch, age]) => (
            <span key={ch} className="tele">
              {ch.toUpperCase()} <span className="num"
                style={{ color: "var(--fg-2)" }}>{formatAge(age)}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Disagreement. Divergence is the alert, not the answer. */}
      <div
        className="panel"
        style={{
          padding: "8px 10px", marginTop: 8,
          borderColor: d.above_threshold
            ? "color-mix(in srgb, var(--alert) 45%, transparent)"
            : "var(--line)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span className={`chip cls-D`} style={{ padding: "0 5px", fontSize: 9 }}>D</span>
          <span className="tele">Do the methods agree?</span>
          <span style={{ flex: 1 }} />
          {d.spread_kt !== null && (
            <span
              className="num"
              style={{
                fontSize: 12,
                color: d.above_threshold ? "var(--alert)" : "var(--fg-1)",
              }}
            >
              spread {d.spread_kt.toFixed(0)} kt
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 5, flexWrap: "wrap" }}>
          <Compare label="This system" v={d.trinetra_kt} />
          <Compare label="Baseline" v={d.baseline_kt} />
          <Compare label="IMD" v={d.imd_kt} />
        </div>
        <div className="tele" style={{ marginTop: 4 }}>{d.baseline_name}</div>
        {d.above_threshold && d.driver && (
          <div style={{ fontSize: 10.5, color: "var(--fg-1)", marginTop: 5,
                        lineHeight: 1.45 }}>
            The estimates differ by more than {d.threshold_kt.toFixed(0)} kt,
            which is the point at which a forecaster should look closer.
            Likely reason: {d.driver}.
          </div>
        )}
      </div>

      {/* Abstentions as first-class rows. An empty box would be information
          destroyed. */}
      {state.abstentions.length > 0 && (
        <div className="panel" style={{ padding: "8px 10px", marginTop: 8 }}>
          <div className="tele" style={{ marginBottom: 2 }}>
            Declined to answer ({state.abstentions.length})
          </div>
          <div style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.5,
                        marginBottom: 7 }}>
            Each one names what would have been needed.
          </div>
          {state.abstentions.map((a, k) => (
            <div key={k} style={{ marginBottom: 6 }}>
              <div className="tele" style={{ color: "var(--warn)" }}>{a.head}</div>
              <div style={{ fontSize: 10.5, color: "var(--fg-1)", lineHeight: 1.45 }}>
                {a.reason}
              </div>
            </div>
          ))}
        </div>
      )}

      {state.ood && (
        <div className="panel" style={{ padding: "8px 10px", marginTop: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span className="tele">Seen anything like this before?</span>
            <span style={{ flex: 1 }} />
            <span
              className="tele"
              style={{ color: state.ood.in_distribution ? "var(--ok)" : "var(--alert)" }}
            >
              {state.ood.in_distribution ? "yes, familiar" : "no, unfamiliar"}
            </span>
          </div>
          <div className="num" style={{ fontSize: 11, marginTop: 3,
                                        color: "var(--fg-1)" }}>
            Mahalanobis {state.ood.score.toFixed(2)} / threshold{" "}
            {state.ood.threshold.toFixed(2)}
          </div>
        </div>
      )}

      <Link
        to={`/storm/${state.storm_id}?at=${encodeURIComponent(state.valid_time)}`}
        className="btn"
        style={{
          display: "block", textAlign: "center", marginTop: 10,
          textDecoration: "none",
        }}
      >
        Why it says this →
      </Link>

      <div className="disclaimer" style={{ marginTop: 10 }}>
        Decision support only. IMD / RSMC New Delhi is the warning authority.
        {state.provenance.synthetic_imagery && (
          <>
            {" "}Imagery is a parametric reconstruction; positions and labels are
            real best-track.
          </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, unit, ci, ciUnit = "", conf, note, colour, big,
                 title }: {
  label: string; value: string; unit: string; ci?: number | null;
  ciUnit?: string; conf?: number | null; note?: string | null;
  colour?: string; big?: boolean; title?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8,
                  padding: "3px 0" }}>
      <span
        className="tele"
        style={{ minWidth: 88, whiteSpace: "normal", lineHeight: 1.35 }}
        title={title}
      >
        {label}
      </span>
      <span
        className="num count-in"
        style={{ fontSize: big ? 17 : 12, color: colour ?? "var(--fg)",
                 fontWeight: big ? 500 : 400 }}
      >
        {value}
      </span>
      {unit && <span className="tele">{unit}</span>}
      {ci !== null && ci !== undefined && (
        <span className="num" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
          ±{ci.toFixed(ciUnit === "km" ? 0 : 1)}{ciUnit ? ` ${ciUnit}` : ""}
        </span>
      )}
      {conf !== null && conf !== undefined && (
        <span className="tele">conf {conf.toFixed(2)}</span>
      )}
      <span style={{ flex: 1 }} />
      {note && <span className="tele">{note}</span>}
    </div>
  );
}

function Compare({ label, v }: { label: string; v: number | null }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4 }}>
      <span className="tele">{label}</span>
      <span className="num" style={{ fontSize: 12, color: "var(--fg)" }}>
        {v === null ? "--" : v.toFixed(0)}
      </span>
    </span>
  );
}
