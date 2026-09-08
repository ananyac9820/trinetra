/* "What's happening here?" — the location panel.
 *
 * The existing probe answers a specialist's question: what is every layer's
 * value at this pixel, with what provenance and what age. That panel is still
 * there and is still the right answer for a forecaster.
 *
 * This one answers the question a normal person has when they click their own
 * district: is this storm going to affect me, how badly, and how sure are you.
 * Same data underneath. Different ordering, and the ordering is the product
 * decision: concern first, then the evidence, then the numbers, then the
 * caveats.
 *
 * Three rules it does not break:
 *
 * Nothing is invented. Exposure categories that need a dataset this build does
 * not have are listed as unavailable with the reason, because a reviewer
 * seeing them omitted would assume they were never considered, and a reviewer
 * seeing a made-up population figure would be right to stop trusting
 * everything else.
 *
 * Confidence names its cause. "Medium" on its own is decoration; "reduced
 * because microwave is not available at this time" is information.
 *
 * The approach wording says "on its recorded path", because in replay the
 * later track is recorded rather than forecast, and calling it a forecast
 * would be the easiest and least honest upgrade available.
 */

import { BAND_COLOR, BAND_LABEL, CONFIDENCE_LABEL, formatUtc } from "../api/client";
import type { LocationImpact, RiskLevel } from "../api/types";

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, moderate: 1, high: 2 };

const STRENGTH_DOTS: Record<string, number> = { weak: 1, moderate: 2, strong: 3 };

interface Props {
  impact: LocationImpact | null;
  loading: boolean;
  onClose: () => void;
  /** Switches to the technical per-layer probe for the same point. */
  onShowTechnical?: () => void;
}

export default function HerePanel({ impact, loading, onClose,
                                    onShowTechnical }: Props) {
  if (loading && !impact) {
    return (
      <div style={{ padding: 14 }}>
        <div className="tele">Working out what this storm means here…</div>
      </div>
    );
  }

  if (!impact) {
    return (
      <div style={{ padding: "16px 14px" }}>
        <h3 style={{ fontSize: 13.5, marginBottom: 7 }}>What's happening here?</h3>
        <p style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.7,
                    margin: 0 }}>
          Click anywhere on the map. You will get the conditions at that point,
          which hazard matters most there, how confident the system is, and the
          evidence behind it.
        </p>
        <p style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.65,
                    marginTop: 10 }}>
          Try a district near the coast, then scrub the timeline forward and
          watch the answer change as the storm arrives.
        </p>
      </div>
    );
  }

  const band = impact.risk_band;
  const bandColour = BAND_COLOR[band] ?? "var(--fg-2)";
  const place = impact.district?.name
    ?? (impact.on_land ? "Inland point" : "Over water");

  const concerns = [...impact.concerns].sort(
    (a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);

  return (
    <div className="stagger" style={{ padding: "12px 14px 16px",
                                      overflowY: "auto" }}>
      {/* ---- where */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 14.5 }}>{place}</h3>
          <div className="num" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
            {impact.lat.toFixed(2)}°N {impact.lon.toFixed(2)}°E
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} className="pill"
                style={{ fontSize: 10.5, padding: "2px 8px" }}>
          close
        </button>
      </div>

      {/* ---- the answer, first */}
      <div
        style={{
          marginTop: 11, padding: "11px 12px", borderRadius: "var(--r)",
          background: `color-mix(in srgb, ${bandColour} 9%, transparent)`,
          border: `1px solid color-mix(in srgb, ${bandColour} 34%, transparent)`,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="tele">Cyclone risk here</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 14, color: bandColour, fontWeight: 500 }}>
            {BAND_LABEL[band] ?? band}
          </span>
        </div>
        {impact.primary_concern && (
          <div style={{ fontSize: 13, color: "var(--fg)", marginTop: 5 }}>
            {impact.primary_concern.label}
          </div>
        )}
        <p style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.6,
                    margin: "5px 0 0" }}>
          {impact.risk_reason}
        </p>
      </div>

      {/* ---- how sure, and why */}
      <div style={{ marginTop: 11, display: "flex", alignItems: "baseline",
                    gap: 8 }}>
        <span className="tele">How sure</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "var(--fg)" }}>
          {CONFIDENCE_LABEL[impact.confidence] ?? impact.confidence}
        </span>
      </div>
      <p style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.6,
                  margin: "3px 0 0" }}>
        {impact.confidence_reason}
      </p>

      {/* ---- the storm relative to here */}
      <Group title="The storm from here" />
      <Row k="Distance to centre"
           v={`${impact.distance_to_centre_km.toFixed(0)} km`} />
      {impact.closest_approach_km !== null && (
        <Row
          k={impact.storm_approaching ? "Comes as close as" : "Closest it gets"}
          v={`${impact.closest_approach_km.toFixed(0)} km`}
          note={impact.storm_approaching ? "on its recorded path" : "already passed"}
        />
      )}
      <Row k="System" v={impact.storm_name}
           note={formatUtc(impact.valid_time)} />

      {/* ---- conditions */}
      <Group title="Conditions here" />
      <Cond label="Rain in the last 24 hours"
            technical="QPE accumulation"
            value={impact.conditions.rain_24h_mm}
            unit="mm" digits={0} synthetic />
      <Cond label="Wind at this point"
            technical="Holland parametric reconstruction"
            value={impact.conditions.parametric_wind_kt}
            unit="kt" digits={0} synthetic
            note="reconstructed from the storm's estimated centre, not measured here" />
      <Cond label="Storm cloud overhead"
            technical="Outgoing longwave radiation"
            value={impact.conditions.olr_w_m2}
            unit="W/m²" digits={0} synthetic />
      <Cond label="How wet the ground is"
            technical="Volumetric soil moisture"
            value={impact.conditions.soil_moisture}
            unit="m³/m³" digits={2} synthetic />

      {/* ---- why. Evidence contributing, not a causal claim. */}
      <Group title="Evidence contributing to this"
             note="not a causal explanation" />
      {impact.evidence.map((e, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
            <span style={{ display: "inline-flex", gap: 2, flex: "none" }}>
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  style={{
                    width: 4, height: 4, borderRadius: "50%",
                    background: d < (STRENGTH_DOTS[e.strength] ?? 1)
                      ? bandColour : "var(--line-strong)",
                  }}
                />
              ))}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--fg)" }}>{e.label}</span>
            <span style={{ flex: 1 }} />
            <span className="tele"
                  style={{ color: e.provenance.startsWith("real")
                    ? "var(--class-o)" : "var(--warn)" }}>
              {e.provenance.startsWith("real") ? "observed" : "synthetic"}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.55,
                        marginLeft: 21 }}>
            {e.detail}
          </div>
        </div>
      ))}

      {/* ---- other concerns */}
      {concerns.length > 1 && (
        <>
          <Group title="Other hazards here" />
          {concerns.slice(1).map((c) => (
            <div key={c.key} style={{ display: "flex", gap: 8,
                                      alignItems: "baseline", marginBottom: 5 }}>
              <span
                style={{
                  width: 6, height: 6, borderRadius: "50%", flex: "none",
                  background: BAND_COLOR[c.level] ?? "var(--fg-3)",
                  marginTop: 4,
                }}
              />
              <span style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.55 }}>
                <span style={{ color: "var(--fg)" }}>{c.label}</span>{" — "}
                {c.detail}
              </span>
            </div>
          ))}
        </>
      )}

      {/* ---- what we cannot tell you.
             Listed rather than omitted: a reviewer who sees no exposure section
             assumes it was never considered. */}
      <Group title="Not available in this build" />
      {impact.exposure_unavailable.map((x) => (
        <div key={x.key} style={{ display: "flex", gap: 8, marginBottom: 5 }}>
          <span className="tele" style={{ minWidth: 118, color: "var(--fg-3)" }}>
            {x.label}
          </span>
          <span style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.55 }}>
            {x.reason}
          </span>
        </div>
      ))}

      <div className="disclaimer" style={{ marginTop: 14, fontSize: 10.5 }}>
        {impact.basis} {impact.wind_note}
      </div>

      {onShowTechnical && (
        <button onClick={onShowTechnical} className="pill"
                style={{ marginTop: 12, width: "100%", fontSize: 11.5 }}>
          Per-layer values for this point
        </button>
      )}
    </div>
  );
}

function Group({ title, note }: { title: string; note?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8,
                  margin: "15px 0 6px" }}>
      <span className="tele" style={{ color: "var(--fg-2)" }}>{title}</span>
      {note && <span className="tele">{note}</span>}
      <span className="hair" style={{ flex: 1 }} />
    </div>
  );
}

function Row({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline",
                  padding: "3px 0", fontSize: 11.5,
                  borderBottom: "1px solid var(--line-soft)" }}>
      <span className="tele" style={{ minWidth: 118 }}>{k}</span>
      <span className="num" style={{ color: "var(--fg)" }}>{v}</span>
      <span style={{ flex: 1 }} />
      {note && <span className="tele">{note}</span>}
    </div>
  );
}

/** A condition row: plain label first, technical name underneath, and an
 *  explicit "Data unavailable" rather than a dash when there is no value. */
function Cond({ label, technical, value, unit, digits = 0, synthetic, note }: {
  label: string; technical: string; value: number | null; unit: string;
  digits?: number; synthetic?: boolean; note?: string;
}) {
  const missing = value === null || !isFinite(value);
  return (
    <div style={{ padding: "4px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontSize: 11.5, color: "var(--fg-1)", flex: 1 }}>
          {label}
        </span>
        {missing ? (
          <span className="tele" style={{ color: "var(--fg-3)" }}>
            Data unavailable
          </span>
        ) : (
          <>
            <span className="num" style={{ fontSize: 12.5, color: "var(--fg)" }}>
              {value.toFixed(digits)}
            </span>
            <span className="tele">{unit}</span>
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <span className="tele" style={{ color: "var(--fg-3)" }}>{technical}</span>
        {synthetic && !missing && (
          <span className="tele" style={{ color: "var(--warn)" }}>synthetic</span>
        )}
      </div>
      {note && !missing && (
        <div style={{ fontSize: 10, color: "var(--fg-3)", lineHeight: 1.5,
                      marginTop: 1 }}>
          {note}
        </div>
      )}
    </div>
  );
}
