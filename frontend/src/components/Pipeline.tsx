/* The four-step proposition, as a row.
 *
 * The landing page has to answer "what is this" before a reader decides
 * whether to care, and the honest answer is a chain rather than a claim:
 * several satellites see different parts of a storm, the model reads them
 * together, that gives the storm's state over time, and the state is then
 * translated into what it means at a place. Drawing the chain makes the last
 * step visible, which is the step that distinguishes this from a cyclone map.
 *
 * Deliberately not an architecture diagram. Nobody arriving at a landing page
 * wants a box-and-arrow of the inference pipeline; they want to know where the
 * thing ends up. The architecture is on the Methods page for the reader who
 * does want it.
 */

const STEPS = [
  {
    key: "observe",
    label: "Observe",
    plain: "Several satellites, each seeing a different part of the storm",
    detail: "Infrared, water vapour, microwave, scatterometer, ocean heat",
    icon: (
      <>
        <circle cx="12" cy="12" r="2.6" />
        <path d="M12 4.2a7.8 7.8 0 0 1 7.8 7.8M12 19.8A7.8 7.8 0 0 1 4.2 12" />
        <path d="M12 1.4a10.6 10.6 0 0 1 10.6 10.6M12 22.6A10.6 10.6 0 0 1 1.4 12" />
      </>
    ),
  },
  {
    key: "understand",
    label: "Understand",
    plain: "One model reads them together, and says what it was missing",
    detail: "Multimodal fusion with an availability mask",
    icon: (
      <>
        <path d="M4 16V9M8.5 16V6M13 16v-4.5M17.5 16V8M4 19.5h16" />
        <circle cx="17.5" cy="5" r="1.6" />
      </>
    ),
  },
  {
    key: "anticipate",
    label: "Anticipate",
    plain: "How the storm is changing, with the uncertainty attached",
    detail: "Intensity, phase, rapid-strengthening risk",
    icon: (
      <>
        <path d="M3 17c3.5 0 5-9 9-9s5.5 5 9 5" />
        <path d="M17 9.5 21 13l-3.6 3" />
      </>
    ),
  },
  {
    key: "impact",
    label: "Assess impact",
    plain: "What that means for a place you can point at",
    detail: "Leading hazard, district rainfall, location answers",
    icon: (
      <>
        <path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11z" />
        <circle cx="12" cy="10" r="2.4" />
      </>
    ),
  },
];

export default function Pipeline({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className="stagger"
      style={{
        display: "grid",
        gridTemplateColumns: compact
          ? "1fr"
          : "repeat(auto-fit, minmax(200px, 1fr))",
        gap: compact ? 10 : 0,
        alignItems: "stretch",
      }}
    >
      {STEPS.map((s, i) => (
        <div
          key={s.key}
          style={{
            position: "relative",
            padding: compact ? "12px 14px" : "18px 20px 16px",
            borderLeft: compact || i === 0 ? "none" : "1px solid var(--line-soft)",
            textAlign: "left",
          }}
        >
          {/* The connector. Only between steps, and only when they sit in a
              row, so the chain reads as a sequence rather than four cards. */}
          {!compact && i < STEPS.length - 1 && (
            <span
              aria-hidden
              style={{
                position: "absolute", right: -5, top: 30, width: 10, height: 10,
                borderTop: "1px solid var(--line-strong)",
                borderRight: "1px solid var(--line-strong)",
                transform: "rotate(45deg)",
                opacity: 0.75,
              }}
            />
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <svg
              width="19" height="19" viewBox="0 0 24 24" fill="none"
              stroke={i === STEPS.length - 1 ? "var(--accent)" : "var(--fg-2)"}
              strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
              aria-hidden
            >
              {s.icon}
            </svg>
            <span
              className="tele"
              style={{
                color: i === STEPS.length - 1 ? "var(--accent)" : "var(--fg-2)",
              }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
          </div>

          <div
            style={{
              fontSize: 13.5, marginTop: 8,
              color: i === STEPS.length - 1 ? "var(--accent)" : "var(--fg)",
            }}
          >
            {s.label}
          </div>
          <p style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.6,
                      margin: "5px 0 0" }}>
            {s.plain}
          </p>
          <div className="tele" style={{ marginTop: 6, whiteSpace: "normal",
                                         lineHeight: 1.5 }}>
            {s.detail}
          </div>
        </div>
      ))}
    </div>
  );
}

export { STEPS as PIPELINE_STEPS };
