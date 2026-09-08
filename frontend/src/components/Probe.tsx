/* The point probe.
 *
 * A click returns every active layer's value at that coordinate and time, each
 * with its own provenance and age. The important part is what happens when
 * there is no value: "no swath coverage at this time" does more for the
 * product's credibility than a quietly interpolated number would, so the three
 * absent states are rendered as three visually distinct things rather than as
 * one blank.
 *
 *     no coverage             the instrument was there, this point was not in
 *                             the swath, or the cell was rain-flagged
 *     stale                   an observation exists but is past its threshold
 *     instrument unavailable  the channel cannot report here at all, which for
 *                             the visible channel at night is the usual case
 *
 * This is also where the sounder earns its place in the stack. A click returns
 * an actual vertical temperature and humidity profile, not an interpolated
 * single value, and the INSAT-3D sounder is the first instrument of its kind in
 * the geostationary INSAT series.
 */

import { formatAge, formatUtc, num } from "../api/client";
import type { Probe as ProbeData, ProbeValue, ValueStatus } from "../api/types";

const STATUS_STYLE: Record<string, { colour: string; label: string }> = {
  no_coverage: { colour: "var(--fg-3)", label: "no coverage" },
  no_data: { colour: "var(--fg-3)", label: "no data" },
  stale: { colour: "var(--replay)", label: "stale" },
  expired: { colour: "var(--alert)", label: "expired" },
  instrument_unavailable: { colour: "var(--class-r)", label: "instrument off" },
  out_of_domain: { colour: "var(--fg-3)", label: "out of domain" },
};

const NAME: Record<string, string> = {
  insat_ir: "IR 10.8 µm", insat_wv: "WV 6.7 µm", insat_vis: "Visible",
  insat_olr: "OLR", insat_qpe: "QPE", insat_sst: "SST", insat_aod: "AOD",
  pmw_89: "PMW 89 GHz", pmw_37: "PMW 37 GHz", scat_wind: "Scatterometer wind",
  soil_moisture: "Soil moisture", era5_shear: "Shear 200-850",
  era5_divergence: "Divergence 200", era5_rh_mid: "Mid-level RH",
  tri_ri_favourability: "RI env. favourability",
};

interface Props {
  probe: ProbeData | null;
  loading: boolean;
  onClose: () => void;
}

export default function Probe({ probe, loading, onClose }: Props) {
  if (loading && !probe) {
    return (
      <div style={{ padding: 16 }}>
        <div className="tele">Probe</div>
        <div style={{ marginTop: 12 }}>
          {[70, 50, 84].map((w, k) => (
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
          <div className="tele" style={{ marginTop: 12 }}>sampling granules…</div>
        </div>
      </div>
    );
  }
  if (!probe) {
    return (
      <div style={{ padding: 16 }}>
        <div className="tele" style={{ marginBottom: 6 }}>Probe</div>
        <div style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
          Click anywhere on the map. Every active layer returns its value at that
          coordinate and time, with its provenance and age. Where there is no
          observation it says so, rather than interpolating one.
        </div>
      </div>
    );
  }

  const observed = probe.values;
  const nulls = observed.filter((v) => v.value === null).length;

  return (
    <div className="stagger" style={{ padding: "12px 14px 16px", overflowY: "auto",
                                      flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div>
          <div className="num" style={{ fontSize: 13 }}>
            {probe.lat.toFixed(2)}°{probe.lat >= 0 ? "N" : "S"}{"  "}
            {probe.lon.toFixed(2)}°{probe.lon >= 0 ? "E" : "W"}
          </div>
          <div className="tele">{formatUtc(probe.valid_time)}</div>
        </div>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ padding: "1px 6px", fontSize: 11 }}>
          close
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
        <span className="tele">
          land {(probe.land_fraction * 100).toFixed(0)}%
        </span>
        {probe.district && (
          <span className="tele" style={{ color: "var(--accent)" }}>
            {probe.district.name}
          </span>
        )}
        {!probe.in_domain && (
          <span className="tele" style={{ color: "var(--warn)" }}>
            outside storm domain
          </span>
        )}
        {nulls > 0 && (
          <span className="tele" style={{ color: "var(--fg-2)" }}>
            {nulls} absent
          </span>
        )}
      </div>

      <Section title="Observed" cls="O" />
      {observed.map((v) => (
        <ValueRow key={v.layer} v={v} />
      ))}

      {probe.sounder_profile && (
        <>
          <Section
            title="Sounder profile"
            cls="O"
            note={`${probe.sounder_profile.source} · ${formatAge(
              probe.sounder_profile.age_minutes)}`}
          />
          <div className="scroll-x">
            <table className="data" style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <th>Level</th>
                  <th className="num">T (°C)</th>
                  <th className="num">RH (%)</th>
                </tr>
              </thead>
              <tbody>
                {probe.sounder_profile.levels_hpa.map((lvl, i) => (
                  <tr key={lvl}>
                    <td className="num">{lvl} hPa</td>
                    <td className="num">
                      {probe.sounder_profile!.temperature_c[i].toFixed(1)}
                    </td>
                    <td className="num">{probe.sounder_profile!.rh_percent[i]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
            <span className="tele">
              stability {probe.sounder_profile.stability_index.toFixed(2)} K/km
            </span>
            <span className="tele">
              mid moisture {probe.sounder_profile.midlevel_moisture.toFixed(0)}%
            </span>
          </div>
          <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 4,
                        lineHeight: 1.45 }}>
            {probe.sounder_profile.note}
          </div>
        </>
      )}

      {probe.reanalysis.length > 0 && (
        <>
          <Section title="Reanalysis" cls="R" note="not observation" />
          {probe.reanalysis.map((r) => (
            <div key={r.layer} style={rowStyle}>
              <span style={{ flex: 1, color: "var(--fg-1)" }}>
                {NAME[r.layer] ?? r.layer}
              </span>
              <span className="num" style={{ color: "var(--class-r)" }}>
                {typeof r.value === "number"
                  ? (Math.abs(r.value) < 0.001
                      ? r.value.toExponential(1)
                      : r.value.toFixed(2))
                  : "--"}
              </span>
              <span className="tele" style={{ width: 46, textAlign: "right" }}>
                {r.units}
              </span>
              <span className="tele" style={{ width: 52, textAlign: "right" }}>
                {r.valid_time}
              </span>
            </div>
          ))}
        </>
      )}

      {probe.derived.length > 0 && (
        <>
          <Section title="Derived" cls="D" note="TRINETRA output" />
          {probe.derived.map((d) => (
            <div key={d.layer}>
              <div style={rowStyle}>
                <span style={{ flex: 1, color: "var(--fg-1)" }}>
                  {NAME[d.layer] ?? d.layer}
                </span>
                <span className="num" style={{ color: "var(--class-d)" }}>
                  {d.value === null ? "--" : d.value.toFixed(3)}
                </span>
                <span className="tele" style={{ width: 46, textAlign: "right" }}>
                  {d.spread === null ? "" : `±${d.spread.toFixed(2)}`}
                </span>
              </div>
              <div className="tele" style={{ marginLeft: 2 }}>
                sensor mode {d.sensor_mode || "none"}
              </div>
              <div
                style={{
                  fontSize: 10, color: "var(--fg-2)", lineHeight: 1.45,
                  margin: "3px 0 6px", padding: "4px 6px",
                  borderRadius: "var(--r-sm)",
                  border: "1px solid color-mix(in srgb, var(--class-d) 24%, transparent)",
                  background: "color-mix(in srgb, var(--class-d) 7%, transparent)",
                }}
              >
                {d.disclaimer}
              </div>
            </div>
          ))}
        </>
      )}

      {probe.nearest_system && (
        <>
          <Section title="Nearest system" cls="O" />
          <div style={rowStyle}>
            <span style={{ flex: 1, color: "var(--fg-1)" }}>
              {probe.nearest_system.name}
            </span>
            <span className="num">{probe.nearest_system.distance_km.toFixed(0)} km</span>
            <span className="tele" style={{ width: 46, textAlign: "right" }}>
              {probe.nearest_system.bearing.toFixed(0)}°
            </span>
          </div>
        </>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "baseline", gap: 8,
  padding: "3px 0", fontSize: 11.5,
  borderBottom: "1px solid var(--line-soft)",
};

function Section({ title, cls, note }: { title: string; cls: "O" | "R" | "D";
                                         note?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7,
                  margin: "12px 0 4px" }}>
      <span className={`swatch cls-${cls}`} />
      <span className="tele" style={{ color: "var(--fg-2)" }}>{title}</span>
      {note && <span className="tele">{note}</span>}
      <span className="hair" style={{ flex: 1 }} />
    </div>
  );
}

function ValueRow({ v }: { v: ProbeValue }) {
  const absent = v.value === null;
  const st = STATUS_STYLE[v.status as ValueStatus] ?? STATUS_STYLE.no_data;
  return (
    <div style={rowStyle} title={v.reason ?? undefined}>
      <span style={{ flex: 1, color: absent ? "var(--fg-2)" : "var(--fg-1)" }}>
        {NAME[v.layer] ?? v.layer}
      </span>
      {absent ? (
        <span
          className="tele"
          style={{
            color: st.colour,
            border: `1px solid color-mix(in srgb, ${st.colour} 34%, transparent)`,
            borderRadius: 2, padding: "0 4px",
            // The visual difference between the absent states is deliberate:
            // no coverage is a plain outline, stale is dashed, and an
            // unavailable instrument is dotted, matching the reanalysis chip.
            borderStyle:
              v.status === "stale" ? "dashed"
              : v.status === "instrument_unavailable" ? "dotted"
              : "solid",
          }}
        >
          {st.label}
        </span>
      ) : (
        <span className="num" style={{ color: "var(--fg)" }}>
          {num(v.value, Math.abs(v.value ?? 0) < 10 ? 2 : 1)}
        </span>
      )}
      <span className="tele" style={{ width: 46, textAlign: "right" }}>
        {v.units ?? ""}
      </span>
      <span className="tele" style={{ width: 52, textAlign: "right" }}>
        {absent ? "" : formatAge(v.age_minutes)}
      </span>
      <span className={`chip cls-${v.class}`} style={{ padding: "0 4px", fontSize: 9 }}>
        {v.class}
      </span>
    </div>
  );
}
