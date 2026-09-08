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
import UploadResultMap from "../components/UploadResultMap";

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
  /* Kept as strings so the fields can be empty. Blank means "no position", and
   * the result view then says so rather than guessing one. */
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");

  const parsedPos = (() => {
    const a = Number(lat), o = Number(lon);
    if (!lat.trim() || !lon.trim() || !Number.isFinite(a) || !Number.isFinite(o)) {
      return null;
    }
    if (a < -90 || a > 90 || o < -180 || o > 180) return null;
    return { lat: a, lon: o };
  })();
  const posInvalid = (lat.trim() !== "" || lon.trim() !== "") && parsedPos === null;

  const submit = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.upload(file, instrument, undefined, parsedPos ?? undefined));
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

  /* An accepted upload leaves the document layout entirely. The point of this
   * screen is the map, and a judge should read it without scrolling. A refusal
   * stays inside the page, where its reason has room to be read. */
  if (result?.accepted) {
    return <UploadResultMap result={result} onReset={() => setResult(null)} />;
  }

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

          {/* Position. Optional, and labelled for exactly what it is: no
            * upload payload carries a longitude, so a marker on the result map
            * can only come from whoever supplied the file. */}
          <div style={{ display: "flex", gap: 8, justifyContent: "center",
                        alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <span className="tele" style={{ color: "var(--fg-2)" }}>
              observation position
            </span>
            <input
              type="number" step="0.01" min={-90} max={90} value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="lat °N" aria-label="latitude in degrees north"
              style={{ width: 92 }}
            />
            <input
              type="number" step="0.01" min={-180} max={180} value={lon}
              onChange={(e) => setLon(e.target.value)}
              placeholder="lon °E" aria-label="longitude in degrees east"
              style={{ width: 92 }}
            />
            <button
              className="btn"
              onClick={() => { setLat("19.2"); setLon("67.7"); }}
              title="19.2 N, 67.7 E — the Biparjoy fix the sample file was cut from"
            >
              use sample position
            </button>
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.6, marginTop: 6,
                        color: posInvalid ? "var(--warn)" : "var(--fg-3)" }}>
            {posInvalid
              ? "Latitude must be between -90 and 90, longitude between -180 and 180. Leave both blank to skip the map marker."
              : parsedPos
                ? "Used to place the marker on the result map, labelled as declared. It is not an input to the model and no head consumes it."
                : "Optional. TRINETRA cannot infer a position from an upload, so without one the result map has nothing to mark."}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 12,
                        lineHeight: 1.6, maxWidth: 560, margin: "12px auto 0" }}>
            This works on radiometrically calibrated gridded data with metadata.
            It does not work on arbitrary images from the internet, and a
            screenshot will be rejected with an explanation of why.{" "}
            <a href="/sample-biparjoy.npz" download>
              Download a sample file
            </a>{" "}
            (mode C, 56 KB): the five available channels and the fourteen
            predictors from the archived Biparjoy fix at 2023-06-12 00:00 UTC,
            whose recorded position is the sample position above.
          </div>
        </div>

        {/* ------------------------------------------------ refusal
          * An accepted result returned the map above, so the only thing that
          * reaches this point is a refusal, which belongs in the document
          * where its reason has room to be read. */}
        {result && !result.accepted && (
          <div className="rise" style={{ marginTop: 20 }}>
            <Rejected r={result} />
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
