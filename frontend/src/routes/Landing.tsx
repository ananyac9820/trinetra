/* The landing page.
 *
 * Its job is to orient a stranger in under ten seconds and to load fast. It is
 * not a workspace, and it deliberately does not contain the map: the Explorer's
 * WebGL stack is code-split so that opening this page does not pay for it.
 *
 * The order of the content follows the demo script rather than the
 * architecture. The one thing that decides whether this project lands is not
 * opening with a system diagram. It opens with a district under water and the
 * question of which product was watching it, because a reviewer who already
 * knows what problem they are looking at reads everything after it differently.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import ChannelAgeStrip from "../components/ChannelAgeStrip";
import Graticule from "../components/Graticule";
import { api } from "../api/client";
import type { Freshness, ModeInfo, StormSummary } from "../api/types";

export default function Landing() {
  const [info, setInfo] = useState<ModeInfo | null>(null);
  const [storms, setStorms] = useState<StormSummary[]>([]);
  const [freshness, setFreshness] = useState<Freshness | null>(null);

  useEffect(() => {
    api.mode().then(setInfo).catch(() => {});
    api.storms().then((r) => setStorms(r.storms)).catch(() => {});
    api.freshness().then(setFreshness).catch(() => {});
  }, []);

  const featured = storms.filter((s) => s.featured_slug);

  return (
    <div style={{ position: "absolute", inset: 0, overflowY: "auto" }}>
      {/* ------------------------------------------------ the problem first */}
      <section
        style={{
          maxWidth: 1180, margin: "0 auto", padding: "52px 28px 12px",
          position: "relative",
        }}
      >
        <div className="rule-h" style={{ top: 40, opacity: 0.6 }} />
        <div
          style={{
            display: "grid", gridTemplateColumns: "1fr 340px", gap: 40,
            alignItems: "center",
          }}
        >
          <div className="stagger">
            <div className="tele" style={{ color: "var(--accent)" }}>
              IIC 3.0 · PS 25 · Team HyperNova
            </div>

            <h1 style={{ fontSize: 34, lineHeight: 1.15, margin: "10px 0 0",
                         letterSpacing: "-0.03em" }}>
              471 mm of rain fell on Ahore.
              <br />
              <span style={{ color: "var(--fg-2)" }}>
                No cyclone product was watching.
              </span>
            </h1>

            <p style={{ fontSize: 14, color: "var(--fg-1)", lineHeight: 1.65,
                        maxWidth: 620, marginTop: 14 }}>
              June 2023. Biparjoy had crossed the Gujarat coast and stopped being
              a cyclone, so the products that track cyclones stopped tracking it.
              A dam breached at Sanchore. Jalore, Sirohi and Barmer flooded.
              Gujarat paid Rs 240 crore in farmer relief after 1.30 lakh hectares
              of crop damage.
            </p>
            <p style={{ fontSize: 14, color: "var(--fg-1)", lineHeight: 1.65,
                        maxWidth: 620, marginTop: 10 }}>
              In August 2024 Asna ran the other way: a depression intensified
              over land in Rajasthan, crossed Gujarat, and emerged into the
              Arabian Sea as its first August cyclone since 1976. Rajasthan sits
              at both ends of that transition and nobody owns the regime.
            </p>

            <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
              <Link to="/explorer" className="btn primary"
                    style={{ textDecoration: "none", padding: "8px 16px" }}>
                Open the Cyclone Explorer
              </Link>
              <Link to="/archive" className="btn"
                    style={{ textDecoration: "none", padding: "8px 16px" }}>
                Replay a storm
              </Link>
              <Link to="/methods" className="btn"
                    style={{ textDecoration: "none", padding: "8px 16px" }}>
                Validation and limits
              </Link>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "center" }}>
            <Graticule
              size={280}
              labels={[
                { text: "DOMAIN", value: "60-100°E" },
                { text: "BASINS", value: "BoB · AS" },
                { text: "STORMS", value: String(storms.length || "—") },
                { text: "TIER", value: freshness?.tier ?? "—" },
              ]}
            />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ what it is */}
      <section style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 28px 0" }}>
        <div className="hair sweep" style={{ marginBottom: 22 }} />
        <div style={{ display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                      gap: 18 }}>
          <Claim
            n="01"
            title="Every pixel says where it came from"
            body="Three provenance classes, enforced in code rather than by habit.
                  Observed is rendered from a satellite product. Reanalysis is a
                  model-assimilated input, labelled as such. Derived is a
                  TRINETRA output, hatched and badged, and it cannot be switched
                  on without its companion uncertainty layer."
          />
          <Claim
            n="02"
            title="Absence is a return value"
            body="Click a point with no scatterometer swath and the probe says
                  so. It does not interpolate. No coverage, stale and instrument
                  unavailable are three different facts and they render three
                  different ways, because a forecaster needs to tell them apart."
          />
          <Claim
            n="03"
            title="The track does not stop at the coast"
            body="A regime head classifies maritime, sheared, post-landfall
                  remnant and over land. At the coastline the output switches
                  from wind category to district rainfall risk, and the track
                  keeps going. This is the part no prior-art model in the review
                  does."
          />
          <Claim
            n="04"
            title="One model, three input regimes"
            body="MOSDAC Level 1 imagery is on a three-day tier; Level 2 products
                  are near real time. So the live tier and the training tier see
                  different sensors. The availability mask is a model input
                  rather than a build-time constant, which is what lets one set
                  of weights serve both, and an uploaded file as well."
          />
          <Claim
            n="05"
            title="Where the methods disagree"
            body="TRINETRA, an analysis baseline and the IMD label are compared
                  at every timestep, and the spread is surfaced as an alert.
                  Divergence is where a forecaster should look, and no other
                  product shows it."
          />
          <Claim
            n="06"
            title="It declines to answer"
            body="The RI head does not issue a probability without the
                  environmental predictors it needs, and says which ones are
                  missing. An out-of-distribution input returns historical
                  analogues instead of a number. A system that refuses to guess
                  is easier to believe when it does not."
          />
        </div>
      </section>

      {/* ------------------------------------------------ active systems */}
      <section style={{ maxWidth: 1180, margin: "0 auto", padding: "34px 28px 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10,
                      marginBottom: 10 }}>
          <h2 style={{ fontSize: 15 }}>
            {info?.mode === "live" ? "Active systems" : "Featured replay cases"}
          </h2>
          <span className="hair" style={{ flex: 1 }} />
          <span className="tele">
            {info ? `${info.n_replay_storms} storms in archive` : ""}
          </span>
        </div>

        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th>System</th>
                <th>Season</th>
                <th>Basin</th>
                <th className="num">Peak VMAX</th>
                <th>Peak category</th>
                <th>Landfall</th>
                <th className="num">Fixes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(featured.length ? featured : storms.slice(0, 6)).map((s) => (
                <tr key={s.storm_id}>
                  <td style={{ color: "var(--fg)" }}>{s.name}</td>
                  <td className="num">{s.season}</td>
                  <td>{s.basin.replace(/_/g, " ")}</td>
                  <td className="num">{s.peak_vmax_kt.toFixed(0)} kt</td>
                  <td>{s.peak_category ?? "--"}</td>
                  <td>{s.made_landfall ? "yes" : "no"}</td>
                  <td className="num">{s.n_fixes}</td>
                  <td>
                    <Link to={`/explorer?storm=${s.storm_id}`}>replay →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------ honesty */}
      <section style={{ maxWidth: 1180, margin: "0 auto", padding: "34px 28px 0" }}>
        <div className="panel" style={{ padding: "14px 16px" }}>
          <div className="tele" style={{ marginBottom: 8, color: "var(--warn)" }}>
            Read this before the numbers
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5,
                       color: "var(--fg-1)", lineHeight: 1.7 }}>
            <li>
              Best-track labels in this basin are largely Dvorak-derived, so
              agreement with them measures agreement with a subjective human
              estimate. IMD and JTWC disagree by 7.0 kt on average across the
              5,555 fixes both analysed, and that is the floor below which an
              intensity error is a bug rather than a result.
            </li>
            <li>
              The satellite imagery in this build is generated by a parametric
              forward model, because the real products need credentials and days
              of download. Positions, intensities and every label are real
              IBTrACS best-track. Analysis metrics validate the pipeline; the
              forecast metrics run on real predictors and are real.
            </li>
            <li>
              The independent-truth subset is specified and empty. No SAR-derived
              Vmax was pulled, so no non-Dvorak error is reported rather than one
              being estimated.
            </li>
            <li>
              Cyclone warnings are a statutory IMD function. This is decision
              support. It does not attempt medium-range track forecasting, storm
              surge, or wind radii as a headline claim.
            </li>
          </ul>
          <div style={{ marginTop: 10 }}>
            <Link to="/methods">Full validation, splits and failure modes →</Link>
          </div>
        </div>
      </section>

      <footer
        style={{
          maxWidth: 1180, margin: "0 auto", padding: "26px 28px 16px",
          color: "var(--fg-3)", fontSize: 11,
        }}
      >
        <div className="hair" style={{ marginBottom: 12 }} />
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>Best-track: IBTrACS v04r01, NOAA NCEI.</span>
          <span>Geometry: Natural Earth, geoBoundaries.</span>
          <span>Warning authority: IMD / RSMC New Delhi.</span>
          <span style={{ flex: 1 }} />
          <Link to="/methods">Methods</Link>
          <a href="https://github.com/ananyac9820/trinetra">Source</a>
        </div>
      </footer>

      {/* The age strip is permanent here too, so the latency story is on screen
          from the first page rather than only inside the Explorer. */}
      <div style={{ position: "sticky", bottom: 0, background: "var(--bg-1)" }}>
        <ChannelAgeStrip freshness={freshness} compact />
      </div>
    </div>
  );
}

function Claim({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="panel rise" style={{ padding: "13px 15px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="tele" style={{ color: "var(--accent)" }}>{n}</span>
        <h3 style={{ fontSize: 13.5, color: "var(--fg)" }}>{title}</h3>
      </div>
      <p style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.65,
                  margin: "7px 0 0" }}>
        {body}
      </p>
    </div>
  );
}
