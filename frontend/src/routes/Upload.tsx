/* Bring-your-own-data mode.
 *
 * This page exists to make the out-of-distribution gate, the availability mask
 * and the abstention logic interactive rather than a claim on a slide. Hand it
 * data from another basin and watch the system flag it. Hand it imagery with no
 * environmental predictors and watch the RI head decline and say exactly what
 * would enable the answer.
 *
 * What it is not: upload a screenshot, get a prediction. That version is a toy
 * and the guardrail chain rejects it with a specific reason, which is itself
 * more useful than a number would have been. The rejection message for a
 * rendered PNG explains why an 8-bit image is not radiometric data, and saying
 * that plainly makes the feature read as rigorous rather than fragile.
 */

import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import Page, { Section } from "../components/Page";

const INSTRUMENTS = [
  "insat-3d", "insat-3dr", "insat-3ds", "himawari-9", "goes-18",
  "meteosat-11", "fy-4b", "unknown",
];

const CHECKS = [
  ["schema", "Schema and units",
   "Does it parse? Are there CRS and time metadata? Are brightness " +
   "temperatures in kelvin and physically plausible? A file with values in " +
   "0 to 255 is a rendered image, not radiometric data."],
  ["units", "Physical ranges",
   "Integer-valued arrays bounded at 255 are a colour map. The original " +
   "measurement cannot be recovered from one."],
  ["geometry", "Geometry",
   "Is the domain inside the basin the model was trained on? Outside it, " +
   "proceed but flag prominently: the model carries a basin embedding and " +
   "cross-basin transfer is documented as non-trivial."],
  ["channel_map", "Channel mapping",
   "You declare which band is which, or the system infers it from an exact " +
   "name match. It never guesses silently."],
  ["instrument", "Instrument check",
   "A non-INSAT geostationary imager gets the quantile-matching path used for " +
   "inter-satellite homogenisation, and the output says so."],
  ["ood", "Out-of-distribution gate",
   "Mahalanobis score of the encoder embedding against the training " +
   "distribution. Above threshold the system abstains and returns the nearest " +
   "historical analogues instead."],
  ["provenance", "Provenance stamp",
   "What was supplied, what was missing, which mode ran, and the OOD score. " +
   "Downloadable with the result."],
];

export default function Upload() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [instrument, setInstrument] = useState("unknown");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [dragging, setDragging] = useState(false);

  const submit = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.upload(file, instrument));
    } catch (e) {
      setResult({ accepted: false, rejected_at: "transport", reason: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) submit(f);
  };

  return (
    <Page
      eyebrow="Bring your own data"
      title="Upload"
      width={1060}
      lede={
        <>
          A generic entry point to the same harmonisation and inference
          pipeline, for observations the system did not fetch itself, with an
          explicit in-distribution check and an honest refusal when the input
          falls outside the validated envelope.
        </>
      }
      actions={
        <Link to="/methods" className="btn" style={{ textDecoration: "none" }}>
          Validation and limits
        </Link>
      }
    >
      <div>
        <div style={{ display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                      gap: 12 }}>
          <Mode letter="A" title="Gridded imagery"
                body="GeoTIFF or NetCDF with CRS metadata, or an .npz channel
                      stack. Full path: reproject, channel map, availability
                      mask, OOD gate, then every head."
                accepts=".nc .tif .npz" />
          <Mode letter="B" title="Environmental table"
                body="CSV or JSON of named predictors. Tabular branch only.
                      Image channels are marked absent rather than zero-filled,
                      and the band is widened."
                accepts=".csv .json" />
          <Mode letter="C" title="Hybrid"
                body="Imagery plus a predictor table. The closest to the
                      training distribution, and the only mode that reports full
                      confidence."
                accepts=".npz with a tabular array" />
        </div>

        {/* ------------------------------------------------ drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className="panel"
          style={{
            marginTop: 20, padding: "36px 20px", textAlign: "center",
            borderStyle: "dashed", borderWidth: 1.5,
            borderColor: dragging ? "var(--accent)" : "var(--line-strong)",
            background: dragging ? "var(--accent-glow)" : undefined,
            transition: "border-color var(--t-fast), background var(--t-fast)",
          }}
        >
          <div style={{ fontSize: 13, color: "var(--fg-1)" }}>
            Drop a file here, or
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center",
                        alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <input
              ref={fileRef}
              type="file"
              accept=".nc,.nc4,.cdf,.tif,.tiff,.npz,.csv,.tsv,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) submit(f);
              }}
              style={{ display: "none" }}
            />
            <button className="primary" onClick={() => fileRef.current?.click()}
                    disabled={busy}>
              {busy ? "Running the chain…" : "Choose a file"}
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6,
                            fontSize: 12, color: "var(--fg-2)" }}>
              declared instrument
              <select value={instrument}
                      onChange={(e) => setInstrument(e.target.value)}>
                {INSTRUMENTS.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </label>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 12,
                        lineHeight: 1.6, maxWidth: 560, margin: "12px auto 0" }}>
            This works on radiometrically calibrated gridded data with metadata.
            It does not work on arbitrary images from the internet, and a
            screenshot will be rejected with an explanation of why.
          </div>
        </div>

        {/* ------------------------------------------------ result */}
        {result && (
          <div className="rise" style={{ marginTop: 20 }}>
            {result.accepted ? <Accepted r={result} /> : <Rejected r={result} />}
          </div>
        )}

        {/* ------------------------------------------------ the chain */}
        <Section title="The guardrail chain"
                 note="every stage can refuse, and says why" />
        <div className="panel ticked" style={{ padding: "6px 0" }}>
          {CHECKS.map(([key, title, body], i) => (
            <div key={key} style={{ display: "flex", gap: 12, padding: "10px 16px",
                                    borderBottom: i < CHECKS.length - 1
                                      ? "1px solid var(--line-soft)" : undefined }}>
              <span className="num" style={{ color: "var(--accent)", flex: "none",
                                             fontSize: 12 }}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <div style={{ fontSize: 12.5, color: "var(--fg)" }}>{title}</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-2)",
                              lineHeight: 1.6, marginTop: 2 }}>
                  {body}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="disclaimer" style={{ marginTop: 20 }}>
          Decision support only. Not a warning product.{" "}
          <Link to="/methods">Validation and limits →</Link>
        </div>
      </div>
    </Page>
  );
}

function Mode({ letter, title, body, accepts }: { letter: string; title: string;
                                                  body: string; accepts: string }) {
  return (
    <div className="panel ticked" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="chip cls-O" style={{ flex: "none" }}>{letter}</span>
        <h3 style={{ fontSize: 13 }}>{title}</h3>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.6,
                  margin: "7px 0 6px" }}>
        {body}
      </p>
      <div className="tele">{accepts}</div>
    </div>
  );
}

function Rejected({ r }: { r: any }) {
  return (
    <div
      className="panel"
      style={{
        padding: "16px 18px",
        borderColor: "color-mix(in srgb, var(--alert) 50%, transparent)",
        background: "color-mix(in srgb, var(--alert) 6%, transparent)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="tele" style={{ color: "var(--alert)" }}>Input rejected</span>
        <span className="tele">at check: {r.rejected_at}</span>
      </div>
      <p style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.65,
                  margin: "10px 0 0" }}>
        {r.reason}
      </p>
      {r.hint && (
        <p style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.6,
                    margin: "8px 0 0" }}>
          {r.hint}
        </p>
      )}
      {r.provenance_stamp?.checks?.length > 0 && <Checks stamp={r.provenance_stamp} />}
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 12,
                    lineHeight: 1.6 }}>
        A refusal that names the reason is the intended behaviour here, not a
        failure. The alternative is a confident number computed from data the
        system cannot interpret.
      </div>
    </div>
  );
}

function Accepted({ r }: { r: any }) {
  const dc = r.distribution_check ?? {};
  const res = r.result ?? {};
  const ood = typeof dc.score === "number";
  return (
    <div className="panel" style={{ padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10,
                    flexWrap: "wrap" }}>
        <span className="tele" style={{ color: "var(--ok)" }}>Input accepted</span>
        <span className="tele">mode {r.mode}</span>
        <span style={{ flex: 1 }} />
        <span className="tele">{r.provenance_stamp?.filename}</span>
      </div>

      <Group title="Input" />
      <Row k="Channels supplied"
           v={(r.input?.channels_supplied ?? []).join(", ") || "none"} />
      <Row k="Channels absent"
           v={(r.input?.channels_absent ?? []).join(", ") || "none"} />
      <Row k="Environmental data" v={r.input?.environmental_data ?? "--"} />
      <Row k="Grid" v={r.input?.grid ?? "--"} />
      <Row k="Instrument"
           v={`${r.input?.instrument?.declared ?? "--"} — ${
             r.input?.instrument?.note ?? ""}`} />

      <Group title="Distribution check" />
      {ood ? (
        <>
          <Row k="OOD score"
               v={`${dc.score} against threshold ${dc.threshold}`}
               colour={dc.in_distribution ? "var(--ok)" : "var(--alert)"} />
          <Row k="Verdict" v={dc.verdict ?? "--"} />
        </>
      ) : (
        <Row k="Status" v={dc.reason ?? dc.status ?? "unavailable"} />
      )}

      {Object.keys(res).length > 0 && (
        <>
          <Group title="Result" />
          {res.detection && (
            <Row k="Detection"
                 v={`${res.detection.class} (conf ${res.detection.confidence})`} />
          )}
          {res.intensity && (
            <Row k="Estimated intensity"
                 v={`${res.intensity.vmax_kt} ± ${res.intensity.ci_kt} kt · sensor mode ${
                   res.intensity.sensor_mode} · confidence ${res.intensity.confidence}`} />
          )}
          {res.centre_fix && (
            <Row k="Centre fix"
                 v={`± ${res.centre_fix.sigma_km} km${
                   res.centre_fix.widened ? " (widened: IR only)" : ""}`} />
          )}
          {res.dvorak_scene && (
            <Row k="Dvorak scene"
                 v={`${res.dvorak_scene.scene} (conf ${res.dvorak_scene.confidence})${
                   res.dvorak_scene.low_confidence ? " — low" : ""}`} />
          )}
          {res.regime && (
            <Row k="Regime"
                 v={`${res.regime.label} (conf ${res.regime.confidence})`} />
          )}
          {res.ri && (
            <Row k="RI probability"
                 v={res.ri.issued ? `${(res.ri.p24 * 100).toFixed(0)}%` : "NOT ISSUED"}
                 colour={res.ri.issued ? undefined : "var(--warn)"} />
          )}
        </>
      )}

      {r.abstentions?.length > 0 && (
        <>
          <Group title={`Abstentions (${r.abstentions.length})`} />
          {r.abstentions.map((a: any, i: number) => (
            <div
              key={i}
              style={{
                margin: "6px 0", padding: "9px 11px", borderRadius: "var(--r-sm)",
                border: "1px solid color-mix(in srgb, var(--warn) 38%, transparent)",
                background: "color-mix(in srgb, var(--warn) 7%, transparent)",
              }}
            >
              <div className="tele" style={{ color: "var(--warn)" }}>{a.head}</div>
              <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.6 }}>
                {a.reason}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 4,
                        lineHeight: 1.6 }}>
            Read the abstention again. The system is declining to answer and
            explaining exactly what would enable the answer. That is the most
            valuable thing on this screen.
          </div>
        </>
      )}

      {r.analogues?.length > 0 && (
        <>
          <Group title="Nearest analogues" />
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Storm</th>
                  <th className="num">Season</th>
                  <th className="num">VMAX</th>
                  <th className="num">Similarity</th>
                </tr>
              </thead>
              <tbody>
                {r.analogues.map((a: any, i: number) => (
                  <tr key={i}>
                    <td>{a.name}</td>
                    <td className="num">{a.season}</td>
                    <td className="num">{a.vmax_kt?.toFixed?.(0) ?? "--"} kt</td>
                    <td className="num">{a.similarity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {r.provenance_stamp && <Checks stamp={r.provenance_stamp} />}

      <div className="disclaimer" style={{ marginTop: 14 }}>{r.disclaimer}</div>
    </div>
  );
}

function Checks({ stamp }: { stamp: any }) {
  return (
    <details style={{ marginTop: 14 }}>
      <summary style={{ cursor: "pointer" }} className="tele">
        Provenance stamp and check log ({stamp.checks?.length ?? 0} checks)
      </summary>
      <div style={{ marginTop: 8 }}>
        {(stamp.checks ?? []).map((c: any, i: number) => (
          <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0",
                                borderBottom: "1px solid var(--line-soft)" }}>
            <span className="tele" style={{ minWidth: 88,
              color: c.level === "error" ? "var(--alert)"
                : c.level === "warning" ? "var(--warn)" : "var(--ok)" }}>
              {c.check}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
              {c.detail}
            </span>
          </div>
        ))}
        <a
          className="btn"
          style={{ display: "inline-block", marginTop: 10, textDecoration: "none" }}
          download={`${stamp.filename ?? "upload"}.provenance.json`}
          href={URL.createObjectURL(
            new Blob([JSON.stringify(stamp, null, 2)], { type: "application/json" }))}
        >
          Download provenance stamp
        </a>
      </div>
    </details>
  );
}

function Group({ title }: { title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8,
                  margin: "14px 0 6px" }}>
      <span className="tele" style={{ color: "var(--fg-2)" }}>{title}</span>
      <span className="hair" style={{ flex: 1 }} />
    </div>
  );
}

function Row({ k, v, colour }: { k: string; v: string; colour?: string }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "3px 0", fontSize: 12,
                  borderBottom: "1px solid var(--line-soft)" }}>
      <span className="tele" style={{ minWidth: 148 }}>{k}</span>
      <span style={{ color: colour ?? "var(--fg-1)", lineHeight: 1.5 }}>{v}</span>
    </div>
  );
}
