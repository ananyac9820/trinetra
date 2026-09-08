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
    <div style={{ position: "absolute", inset: 0, overflowY: "auto" }}>
      <div style={{ maxWidth: 1060, margin: "0 auto", padding: "22px 28px 44px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12,
                      flexWrap: "wrap" }}>
          <h1 style={{ fontSize: 22, letterSpacing: "-0.02em" }}>
            Operational outputs
          </h1>
          {state && (
            <span className="tele">
              {state.name} · {formatUtc(state.valid_time)}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <Link to={`/storm/${id}`} className="btn" style={{ textDecoration: "none" }}>
            Back to storm detail
          </Link>
        </div>

        <div style={{ display: "flex", gap: 4, marginTop: 16, flexWrap: "wrap" }}>
          {FORMATS.map((f) => (
            <button key={f.key} className={active === f.key ? "active" : undefined}
                    onClick={() => setActive(f.key)}>
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 8,
                      lineHeight: 1.6, maxWidth: 760 }}>
          {FORMATS.find((f) => f.key === active)?.why}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          <a className="btn" href={api.reportUrl(id, active, at)} download
             style={{ textDecoration: "none" }}>
            Download
          </a>
          <span style={{ flex: 1 }} />
          <span className="tele">{body.length.toLocaleString("en-IN")} chars</span>
        </div>

        <pre
          className="panel"
          style={{
            marginTop: 12, padding: "14px 16px", fontFamily: "var(--mono)",
            fontSize: 11.5, lineHeight: 1.6, color: "var(--fg-1)",
            whiteSpace: "pre-wrap", overflowX: "auto", maxHeight: 620,
            overflowY: "auto",
          }}
        >
          {loading ? "loading…" : body}
        </pre>

        <div className="disclaimer" style={{ marginTop: 18 }}>
          Decision support only. Not a warning product. IMD / RSMC New Delhi is
          the responsible warning authority for the North Indian Ocean.
        </div>
      </div>
    </div>
  );
}
