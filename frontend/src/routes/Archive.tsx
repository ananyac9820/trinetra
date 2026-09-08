/* The historical storm index, and the entry point into replay.
 *
 * The featured cases are pinned at the top and told as stories rather than as
 * rows, because the two Rajasthan cases are the argument for the whole project
 * and a reviewer who scrolls past them as table entries has missed it.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { StormSummary } from "../api/types";
import Page, { Section } from "../components/Page";

const STORIES: Record<string, { title: string; body: string }> = {
  biparjoy: {
    title: "Biparjoy, June 2023",
    body:
      "Crossed the Gujarat coast on 15 June and stopped being a cyclone, which " +
      "is when it did most of its damage. 471 mm of rain at Ahore. A dam " +
      "breached at Sanchore. Flooding across Jalore, Sirohi and Barmer, five " +
      "railway breaches, and Rs 240 crore in Gujarat farmer relief after " +
      "1.30 lakh hectares of crop damage. Scrub to landfall and watch the track " +
      "continue, the regime badge flip, and the district choropleth appear.",
  },
  asna: {
    title: "Asna, August 2024",
    body:
      "The reverse direction. A land depression over Rajasthan and Madhya " +
      "Pradesh on 25 August became a deep depression over East Rajasthan the " +
      "same midnight, crossed Gujarat between 27 and 29 August, and emerged " +
      "into the northeast Arabian Sea on 30 August as the first August Arabian " +
      "Sea cyclone since 1976. A system that intensified over land is the case " +
      "no cyclone product is built for.",
  },
  amphan: {
    title: "Amphan, May 2020",
    body:
      "A super cyclonic storm, 130 kt at peak in the best-track, and the " +
      "strongest case in the archive. Useful as the opposite end of the " +
      "intensity range: this is where an intensity estimator is tested and " +
      "where the eye is actually resolvable.",
  },
  fani: {
    title: "Fani, April 2019",
    body:
      "An extremely severe cyclonic storm that made landfall near Puri after a " +
      "long track up the Bay of Bengal, giving a rapid intensification episode " +
      "with plenty of lead time before it.",
  },
};

export default function Archive() {
  const [storms, setStorms] = useState<StormSummary[]>([]);
  const [q, setQ] = useState("");
  const [onlyLandfall, setOnlyLandfall] = useState(false);

  useEffect(() => {
    api.storms().then((r) => setStorms(r.storms)).catch(() => {});
  }, []);

  const featured = storms.filter((s) => s.featured_slug);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return storms.filter((s) => {
      if (onlyLandfall && !s.made_landfall) return false;
      if (!t) return true;
      return (
        s.name.toLowerCase().includes(t) ||
        String(s.season).includes(t) ||
        s.basin.includes(t) ||
        (s.peak_category ?? "").toLowerCase().includes(t)
      );
    });
  }, [storms, q, onlyLandfall]);

  return (
    <Page
      eyebrow="Replay"
      title="Archive"
      width={1160}
      lede={
        <>
          {storms.length || "—"} storms from the IBTrACS North Indian Ocean
          best-track, 1990 onward. Every entry opens in replay, which runs the
          same inference path as live mode with the archive reader in place of
          the watchers and the scrubber in place of the clock.
        </>
      }
      actions={
        <Link to="/explorer" className="btn primary"
              style={{ textDecoration: "none" }}>
          Open the Explorer
        </Link>
      }
    >
      <div>
        <Section title="Featured cases" note="the argument for the project" />
        <div style={{ display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))",
                      gap: 14 }}>
          {featured.map((s) => {
            const story = STORIES[s.featured_slug!];
            if (!story) return null;
            return (
              <div key={s.storm_id} className="panel ticked rise"
                   style={{ padding: "16px 18px", display: "flex",
                            flexDirection: "column" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <h3 style={{ fontSize: 14.5 }}>{story.title}</h3>
                  <span style={{ flex: 1 }} />
                  <span className="tele">{s.peak_category}</span>
                </div>
                <p style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.7,
                            margin: "10px 0 12px", flex: 1 }}>
                  {story.body}
                </p>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap",
                              marginBottom: 10 }}>
                  <span className="tele">
                    peak{" "}
                    <span className="num" style={{ color: "var(--fg-1)" }}>
                      {s.peak_vmax_kt.toFixed(0)} kt
                    </span>
                  </span>
                  <span className="tele">
                    fixes{" "}
                    <span className="num" style={{ color: "var(--fg-1)" }}>
                      {s.n_fixes}
                    </span>
                  </span>
                  <span className="tele">{s.basin.replace(/_/g, " ")}</span>
                </div>
                <Link to={`/explorer?storm=${s.storm_id}`} className="btn primary"
                      style={{ textDecoration: "none", display: "inline-block" }}>
                  Replay in Explorer
                </Link>
              </div>
            );
          })}
        </div>

        <Section title="All storms" note={`${filtered.length} shown`} />
        <div style={{ display: "flex", alignItems: "center", gap: 12,
                      marginBottom: 12, flexWrap: "wrap" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, season, basin, category"
            style={{ minWidth: 260 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 7,
                          fontSize: 12, color: "var(--fg-2)" }}>
            <input type="checkbox" checked={onlyLandfall}
                   onChange={(e) => setOnlyLandfall(e.target.checked)} />
            made landfall
          </label>
        </div>

        <div className="panel scroll-x" style={{ padding: "2px 0",
                                                 maxHeight: 620, overflowY: "auto" }}>
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Season</th>
                <th>Basin</th>
                <th className="num">Peak VMAX</th>
                <th>Category</th>
                <th>Landfall</th>
                <th className="num">Fixes</th>
                <th>Start</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.storm_id}>
                  <td style={{ color: "var(--fg)" }}>
                    {s.name}{s.featured_slug ? " ★" : ""}
                  </td>
                  <td className="num">{s.season}</td>
                  <td>{s.basin.replace(/_/g, " ")}</td>
                  <td className="num">{s.peak_vmax_kt.toFixed(0)} kt</td>
                  <td>{s.peak_category ?? "--"}</td>
                  <td>{s.made_landfall ? "yes" : "no"}</td>
                  <td className="num">{s.n_fixes}</td>
                  <td className="num" style={{ fontSize: 10.5 }}>
                    {s.start_time.slice(0, 10)}
                  </td>
                  <td>
                    <Link to={`/explorer?storm=${s.storm_id}`}>replay</Link>
                    {"  ·  "}
                    <Link to={`/storm/${s.storm_id}`}>detail</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!filtered.length && storms.length > 0 && (
          <div className="tele" style={{ padding: "16px 2px" }}>
            no storm matches that filter
          </div>
        )}

        <div className="disclaimer" style={{ marginTop: 26 }}>
          Best-track: IBTrACS v04r01, NOAA NCEI. IMD / RSMC New Delhi is the
          responsible warning authority. <Link to="/methods">Methods →</Link>
        </div>
      </div>
    </Page>
  );
}
