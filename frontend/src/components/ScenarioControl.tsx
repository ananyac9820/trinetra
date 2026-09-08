/* Scenario corridor.
 *
 * What it is: a band of a chosen width drawn either side of the storm's path,
 * so a viewer can see which districts fall inside a corridor of that size. It
 * answers "if the track were 50 km off, who else is in the way".
 *
 * What it is not, and this matters more than what it is: it is not a
 * probabilistic track forecast and it is not the model's uncertainty. Those
 * would need a track-forecast head with verified coverage, and this project
 * deliberately does not attempt medium-range track forecasting at all. The
 * control is labelled "scenario" everywhere it appears, the widths are the
 * user's choice rather than a model output, and the panel says so in the one
 * place a viewer cannot miss.
 *
 * The honest version of this feature is worth having anyway, because the thing
 * it communicates is real and hard to convey otherwise: a track line is a
 * single guess through a wide space of possibilities, and reading a map as if
 * the line were the answer is the most common mistake made with cyclone
 * graphics.
 *
 * TRINETRA does have a verified uncertainty: the conformal intensity band,
 * whose stated 90 percent coverage was measured on held-out seasons. That one
 * is a model output and is shown in the intensity readout, not here.
 */

const WIDTHS = [25, 50, 100] as const;

interface Props {
  value: number | null;
  onChange: (km: number | null) => void;
  compact?: boolean;
}

export default function ScenarioControl({ value, onChange, compact }: Props) {
  return (
    <div
      className="glass"
      style={{ width: compact ? "min(268px, calc(100vw - 28px))" : 268,
               padding: "11px 13px 12px" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
        <div className="tele" style={{ color: "var(--fg-2)" }}>
          Explore possible tracks
        </div>
        <span style={{ flex: 1 }} />
        <span
          className="tele"
          style={{ color: "var(--warn)" }}
          title="Not a model forecast. A band of the width you choose, drawn around the recorded path."
        >
          scenario
        </span>
      </div>

      <p style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.6,
                  margin: "6px 0 9px" }}>
        A track line is one path through many possible ones. Pick a width to see
        which areas fall inside a corridor that size.
      </p>

      <div style={{ display: "flex", gap: 4 }}>
        <button
          onClick={() => onChange(null)}
          className="pill"
          style={{
            flex: 1, border: "none", fontSize: 11, padding: "5px 0",
            background: value === null ? "var(--accent-glow)" : "transparent",
            color: value === null ? "var(--accent)" : "var(--fg-2)",
          }}
        >
          Off
        </button>
        {WIDTHS.map((w) => (
          <button
            key={w}
            onClick={() => onChange(w)}
            className="pill"
            style={{
              flex: 1, border: "none", fontSize: 11, padding: "5px 0",
              background: value === w ? "var(--accent-glow)" : "transparent",
              color: value === w ? "var(--accent)" : "var(--fg-2)",
            }}
          >
            ±{w} km
          </button>
        ))}
      </div>

      {value !== null && (
        <div
          className="fade"
          style={{
            marginTop: 9, padding: "7px 9px", borderRadius: "var(--r-sm)",
            fontSize: 10.5, color: "var(--fg-1)", lineHeight: 1.6,
            background: "color-mix(in srgb, var(--warn) 8%, transparent)",
            border: "1px dashed color-mix(in srgb, var(--warn) 38%, transparent)",
          }}
        >
          Showing a <strong style={{ fontWeight: 500 }}>{value} km</strong>{" "}
          corridor around the recorded path. This is an illustration of how much
          a track can shift, not a probability and not a TRINETRA forecast.
          Verified uncertainty in this build is the intensity band, shown with
          the wind reading.
        </div>
      )}
    </div>
  );
}
