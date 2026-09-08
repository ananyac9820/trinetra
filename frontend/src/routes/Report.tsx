/* Operational outputs.
 *
 * ATCF deck line, bulletin text, GeoJSON and CAP XML. A few hundred lines of
 * templating on the backend, and the reason it matters is that the difference
 * between a research result and a system is often just whether it emits the
 * formats the receiving desk already parses.
 *
 * The CAP message is permanently status Exercise. A CAP message with status
 * Actual that reaches an aggregator is an alert, and this is not an alerting
 * authority.
 */

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, formatUtc } from "../api/client";
import type { StormState } from "../api/types";
import Page from "../components/Page";

const FORMATS = [
  {
    key: "bulletin", label: "Bulletin text", type: "text",
    why: "IMD-adjacent phrasing for a human reader, with the disclaimer at the " +
         "top rather than buried at the bottom. When a head declines, the " +
         "bulletin says so and says what would enable it.",
  },
  {
    key: "atcf", label: "ATCF a-deck", type: "text",
    why: "The fixed-width format track guidance is exchanged in. Field order is " +
         "not negotiable, so it is written out explicitly rather than through a " +
         "library, and the field meanings stay visible in the source.",
  },
  {
    key: "geojson", label: "Track and cone GeoJSON", type: "json",
    why: "Regime segments are separate features rather than one line with a " +
         "property, so any GIS can style the land-sea transition without " +
         "understanding a run-length encoding.",
  },
  {
    key: "swaths", label: "Parametric wind swaths", type: "json",
    why: "Holland-profile radii, labelled as a reconstruction. Wind radii are " +
         "not a headline claim of this project and are reported only on the " +
         "SAR-validated subset, which is currently empty.",
  },
  {
    key: "cap", label: "CAP 1.2 XML", type: "text",
    why: "Common Alerting Protocol, permanently status Exercise. A CAP message " +
         "with status Actual reaching an aggregator is an alert, and this is " +
         "not an alerting authority.",
  },
];

export default function Report() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const at = params.get("at") ?? undefined;
  const [state, setState] = useState<StormState | null>(null);
  const [active, setActive] = useState("bulletin");
  const [body, setBody] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.state(id, at).then(setState).catch(() => {});
  }, [id, at]);

  useEffect(() => {
    setLoading(true);
    fetch(api.reportUrl(id, active, at))
      .then((r) => r.text())
      .then((t) => {
        const f = FORMATS.find((x) => x.key === active);
        if (f?.type === "json") {
          try { setBody(JSON.stringify(JSON.parse(t), null, 2)); }
          catch { setBody(t); }
        } else {
          setBody(t);
        }
      })
      .catch((e) => setBody(String(e)))
      .finally(() => setLoading(false));
  }, [id, active, at]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard permission denied; the download button still works */
    }
  };

  return (
    <Page
      eyebrow={state ? `${state.name} · ${formatUtc(state.valid_time)}` : "Outputs"}
      title="Operational outputs"
      width={1060}
      lede={
        <>
          The difference between a research result and a system is often just
          whether it emits the formats the receiving desk already parses. These
          are generated from the same inference the Explorer displays.
        </>
      }
      actions={
        <Link to={`/storm/${id}`} className="btn" style={{ textDecoration: "none" }}>
          Back to storm detail
        </Link>
      }
    >
      <div>
        <div
          className="glass"
          style={{ display: "inline-flex", gap: 2, padding: 3,
                   borderRadius: "var(--r-pill)", flexWrap: "wrap" }}
        >
          {FORMATS.map((f) => (
            <button
              key={f.key}
              onClick={() => setActive(f.key)}
              className="pill"
              style={{
                border: "none", fontSize: 12,
                background: active === f.key ? "var(--accent-glow)" : "transparent",
                color: active === f.key ? "var(--accent)" : "var(--fg-2)",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 14,
                      lineHeight: 1.7, maxWidth: 760 }}>
          {FORMATS.find((f) => f.key === active)?.why}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
          <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          <a className="btn" href={api.reportUrl(id, active, at)} download
             style={{ textDecoration: "none" }}>
            Download
          </a>
          <span style={{ flex: 1 }} />
          <span className="tele">
            {loading ? "generating…" : `${body.length.toLocaleString("en-IN")} chars`}
          </span>
        </div>

        <pre
          className="panel ticked"
          style={{
            marginTop: 12, padding: "16px 18px", fontFamily: "var(--mono)",
            fontSize: 11.5, lineHeight: 1.65, color: "var(--fg-1)",
            whiteSpace: "pre-wrap", overflowX: "auto", maxHeight: 620,
            overflowY: "auto", minHeight: 220,
          }}
        >
          {loading ? "generating…" : body}
        </pre>

        <div className="disclaimer" style={{ marginTop: 22 }}>
          Decision support only. Not a warning product. IMD / RSMC New Delhi is
          the responsible warning authority for the North Indian Ocean. The CAP
          message is permanently status Exercise.
        </div>
      </div>
    </Page>
  );
}
