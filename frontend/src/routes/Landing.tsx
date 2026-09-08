/* The landing page.
 *
 * Its job is to orient a stranger in under ten seconds and to load fast. It is
 * not a workspace, and it deliberately does not contain the map: the Explorer's
 * WebGL stack is code-split so that opening this page does not pay for it.
 *
 * The composition is a single centred column over a lit ground: eyebrow, one
 * headline with one word carrying the accent, one paragraph, one primary
 * action. Everything that follows is evidence for that headline, in the order
 * the demo tells it — the case that motivates the project, what the system
 * actually does, the archive it runs on, and the limits, which are on the
 * landing page rather than hidden in Methods because a product that leads with
 * its caveats is the point of this one.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import Ambient from "../components/Ambient";
import ChannelAgeStrip from "../components/ChannelAgeStrip";
import { api } from "../api/client";
import type { Freshness, ModeInfo, StormSummary } from "../api/types";
import { useStore } from "../state/store";

export default function Landing() {
  const [info, setInfo] = useState<ModeInfo | null>(null);
  const [storms, setStorms] = useState<StormSummary[]>([]);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const manifest = useStore((s) => s.manifest);

  useEffect(() => {
    api.mode().then(setInfo).catch(() => {});
    api.storms().then((r) => setStorms(r.storms)).catch(() => {});
    api.freshness().then(setFreshness).catch(() => {});
  }, []);

  const featured = storms.filter((s) => s.featured_slug);
  const rows = featured.length ? featured : storms.slice(0, 4);
  const nFixes = storms.reduce((a, s) => a + s.n_fixes, 0);

  return (
    <div style={{ position: "absolute", inset: 0, overflowY: "auto" }}>
      {/* ------------------------------------------------------------ hero */}
      <section
        style={{
          position: "relative", minHeight: "min(760px, 96vh)",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          padding: "108px 24px 56px", textAlign: "center",
        }}
      >
        <Ambient variant="hero" />

        <div
          className="stagger"
          style={{ position: "relative", zIndex: 1, maxWidth: 940 }}
        >
          <div>
            <span className="eyebrow">
              <span
                style={{
                  width: 6, height: 6, borderRadius: 3,
                  background: "var(--accent)",
                  boxShadow: "0 0 8px var(--accent)",
                }}
              />
              IIC 3.0 · PS 25 · Team HyperNova
            </span>
          </div>

          <h1 className="display" style={{ margin: "24px 0 0" }}>
            <span className="grad">Multi-source</span> satellite
            <br />
            cyclone intelligence.
          </h1>

          <p
            style={{
              fontSize: 15.5, lineHeight: 1.72, color: "var(--fg-1)",
              maxWidth: 640, margin: "22px auto 0",
            }}
          >
            TRINETRA identifies, classifies and predicts tropical cyclone
            patterns over the North Indian Ocean — and shows you which sensors
            it actually had, how old they were, and where its estimate
            disagrees with the other methods on the table.
          </p>

          <div
            style={{
              display: "flex", gap: 10, marginTop: 30, flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            <Link to="/explorer" className="btn primary pill"
                  style={{ padding: "10px 22px", fontSize: 13 }}>
              Open the Cyclone Explorer →
            </Link>
            <Link to="/archive" className="btn pill"
                  style={{ padding: "10px 20px", fontSize: 13 }}>
              Replay a storm
            </Link>
            <Link to="/methods" className="btn pill"
                  style={{ padding: "10px 20px", fontSize: 13 }}>
              Validation and limits
            </Link>
          </div>

          {/* The instrument bar. Real counts from the API, so the first
              numbers a reviewer sees are ones the running system reports. */}
          <div
            style={{
              display: "flex", gap: 0, marginTop: 46, flexWrap: "wrap",
              justifyContent: "center",
              borderTop: "1px solid var(--line-soft)",
              paddingTop: 20,
            }}
          >
            <Fact k="Storms in archive" v={info ? String(info.n_replay_storms) : "—"} />
            <Fact k="Best-track fixes" v={nFixes ? nFixes.toLocaleString("en-IN") : "—"} />
            <Fact k="Layers" v={manifest ? String(manifest.layers.length) : "—"} />
            <Fact k="Model" v={info?.model_version?.replace("trinetra-", "v") ?? "—"} />
            <Fact k="Basins" v="BoB · AS" last />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- the case */}
      <Band>
        <div
          style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))",
            gap: 28, alignItems: "start",
          }}
        >
          <div>
            <h2 className="display-sm" style={{ maxWidth: 460 }}>
              471 mm of rain fell on Ahore.
              <br />
              <span style={{ color: "var(--fg-2)" }}>
                No cyclone product was watching.
              </span>
            </h2>
          </div>
          <div style={{ display: "grid", gap: 14 }}>
            <p style={{ fontSize: 14, color: "var(--fg-1)", lineHeight: 1.75,
                        margin: 0 }}>
              June 2023. Biparjoy had crossed the Gujarat coast and stopped
              being a cyclone, so the products that track cyclones stopped
              tracking it. A dam breached at Sanchore. Jalore, Sirohi and
              Barmer flooded. Gujarat paid Rs 240 crore in farmer relief after
              1.30 lakh hectares of crop damage.
            </p>
            <p style={{ fontSize: 14, color: "var(--fg-1)", lineHeight: 1.75,
                        margin: 0 }}>
              In August 2024 Asna ran the other way: a depression intensified
              over land in Rajasthan, crossed Gujarat, and emerged into the
              Arabian Sea as its first August cyclone since 1976. Rajasthan
              sits at both ends of that transition and nobody owns the regime.
            </p>
            <div>
              <Link to="/explorer?storm=2023156N10067" className="btn"
                    style={{ display: "inline-block" }}>
                Replay Biparjoy through landfall →
              </Link>
            </div>
          </div>
        </div>
      </Band>

      {/* ---------------------------------------------------- what it is */}
      <Band>
        <SectionHead
          kicker="What the system does"
          title="Six things a weather map does not."
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 14, marginTop: 26,
          }}
        >
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
      </Band>

      {/* ---------------------------------------------------- archive */}
      <Band>
        <SectionHead
          kicker={info?.mode === "live" ? "Active systems" : "Featured replay cases"}
          title="Every case runs the live inference path."
          note={info ? `${info.n_replay_storms} storms in archive` : ""}
        />
        <div className="panel scroll-x" style={{ marginTop: 22, padding: "2px 0" }}>
          <table className="data">
            <thead>
              <tr>
                <th>System</th>
                <th className="num">Season</th>
                <th>Basin</th>
                <th className="num">Peak VMAX</th>
                <th>Peak category</th>
                <th>Landfall</th>
                <th className="num">Fixes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.storm_id}>
                  <td style={{ color: "var(--fg)" }}>{s.name}</td>
                  <td className="num">{s.season}</td>
                  <td>{s.basin.replace(/_/g, " ")}</td>
                  <td className="num">{s.peak_vmax_kt.toFixed(0)} kt</td>
                  <td>{s.peak_category ?? "--"}</td>
                  <td>{s.made_landfall ? "yes" : "no"}</td>
                  <td className="num">{s.n_fixes}</td>
                  <td style={{ textAlign: "right" }}>
                    <Link to={`/explorer?storm=${s.storm_id}`}>replay →</Link>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={8} className="tele" style={{ padding: 18 }}>
                    loading archive…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 14 }}>
          <Link to="/archive">Browse the full archive →</Link>
        </div>
      </Band>

      {/* ---------------------------------------------------- honesty */}
      <Band>
        <div
          className="panel ticked"
          style={{ padding: "20px 22px", borderColor: "color-mix(in srgb, var(--warn) 26%, transparent)" }}
        >
          <div className="tele" style={{ marginBottom: 12, color: "var(--warn)" }}>
            Read this before the numbers
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 18,
            }}
          >
            <Caveat
              t="Labels are Dvorak-derived"
              b="Best-track labels in this basin are largely Dvorak-derived, so
                 agreement with them measures agreement with a subjective human
                 estimate. IMD and JTWC disagree by 7.0 kt on average across the
                 5,555 fixes both analysed, and that is the floor below which an
                 intensity error is a bug rather than a result."
            />
            <Caveat
              t="The imagery in this build is synthetic"
              b="Gridded channels are generated by a parametric forward model,
                 because the real products need credentials and days of
                 download. Positions, intensities and every label are real
                 IBTrACS best-track. Analysis metrics validate the pipeline;
                 the forecast metrics run on real predictors and are real."
            />
            <Caveat
              t="The independent-truth subset is empty"
              b="It is specified and unpopulated. No SAR-derived Vmax was
                 pulled, so no non-Dvorak error is reported rather than one
                 being estimated."
            />
            <Caveat
              t="This is not a warning product"
              b="Cyclone warnings are a statutory IMD function. This is decision
                 support. It does not attempt medium-range track forecasting,
                 storm surge, or wind radii as a headline claim."
            />
          </div>
          <div style={{ marginTop: 16 }}>
            <Link to="/methods">Full validation, splits and failure modes →</Link>
          </div>
        </div>
      </Band>

      <footer
        style={{
          maxWidth: 1160, margin: "0 auto", padding: "10px 30px 18px",
          color: "var(--fg-3)", fontSize: 11,
        }}
      >
        <div className="hair" style={{ marginBottom: 14 }} />
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap",
                      alignItems: "center" }}>
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
      <div style={{ position: "sticky", bottom: 0, zIndex: 2,
                    background: "rgba(7,10,16,0.9)",
                    backdropFilter: "var(--glass-blur)" }}>
        <ChannelAgeStrip freshness={freshness} compact />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- fragments */

function Band({ children }: { children: React.ReactNode }) {
  return (
    <section style={{ position: "relative", zIndex: 1 }}>
      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "56px 30px 0" }}>
        {children}
      </div>
    </section>
  );
}

function SectionHead({ kicker, title, note }: {
  kicker: string; title: string; note?: string;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span className="tele" style={{ color: "var(--accent)" }}>{kicker}</span>
        <span className="hair" style={{ flex: 1 }} />
        {note && <span className="tele">{note}</span>}
      </div>
      <h2 className="display-sm" style={{ marginTop: 14, maxWidth: 620 }}>
        {title}
      </h2>
    </div>
  );
}

function Fact({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div
      style={{
        padding: "0 26px",
        borderRight: last ? "none" : "1px solid var(--line-soft)",
        textAlign: "center",
      }}
    >
      <div className="num" style={{ fontSize: 20, color: "var(--fg)",
                                    letterSpacing: "-0.02em" }}>
        {v}
      </div>
      <div className="tele" style={{ marginTop: 3 }}>{k}</div>
    </div>
  );
}

function Claim({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div
      className="panel ticked rise"
      style={{ padding: "16px 18px", display: "flex", flexDirection: "column",
               gap: 8 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="tele" style={{ color: "var(--accent)" }}>{n}</span>
        <h3 style={{ fontSize: 13.5, color: "var(--fg)", lineHeight: 1.35 }}>
          {title}
        </h3>
      </div>
      <p style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.7, margin: 0 }}>
        {body}
      </p>
    </div>
  );
}

function Caveat({ t, b }: { t: string; b: string }) {
  return (
    <div>
      <div style={{ fontSize: 12.5, color: "var(--fg)", marginBottom: 5 }}>{t}</div>
      <div style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.7 }}>{b}</div>
    </div>
  );
}
