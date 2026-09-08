/* The three stacked time series, on a shared axis.
 *
 * Intensity with the comparison methods, RI probability with the operational
 * threshold drawn, and disagreement spread over time. The third one is the
 * reason this component exists: nothing else surfaces where the methods stop
 * agreeing, and it is the chart a forecaster should read first.
 *
 * Drawn as inline SVG rather than with a charting library. The tech stack names
 * uPlot for time series with thousands of points, which is the right call for
 * the live inference stream; these three charts have a few hundred points each
 * and are static per storm, so hand-drawn paths avoid pulling a canvas
 * renderer into the route for no gain. The scales are shared explicitly, which
 * is easier to guarantee here than by configuring three linked instances.
 */

import { useMemo } from "react";
import { REGIME_COLOR, formatUtcShort } from "../api/client";
import type { Track } from "../api/types";

interface Props {
  track: Track;
  disagreement: any | null;
  riThreshold: number;
  markAt?: string;
}

const W = 960;
const PAD_L = 42;
const PAD_R = 12;

export default function Series({ track, disagreement, riThreshold, markAt }: Props) {
  const pts = track.points;

  const scale = useMemo(() => {
    if (!pts.length) return null;
    const t0 = new Date(pts[0].valid_time).getTime();
    const t1 = new Date(pts[pts.length - 1].valid_time).getTime();
    const span = Math.max(t1 - t0, 1);
    const x = (iso: string) =>
      PAD_L + ((new Date(iso).getTime() - t0) / span) * (W - PAD_L - PAD_R);
    return { t0, t1, span, x };
  }, [pts]);

  if (!scale || !pts.length) return null;

  const vmaxMax = Math.max(40, ...pts.map((p) => p.vmax_kt ?? 0)) * 1.14;
  const series = disagreement?.series ?? [];
  const spreadMax = Math.max(
    6, ...series.map((s: any) => s.spread_kt ?? 0)) * 1.2;

  const yIn = (h: number, v: number, max: number) => h - (v / max) * (h - 10) - 4;

  const path = (
    data: { x: number; y: number }[],
  ) => data.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("");

  /* Panel 1: intensity */
  const H1 = 132;
  const observed = pts
    .filter((p) => p.vmax_kt !== null)
    .map((p) => ({ x: scale.x(p.valid_time), y: yIn(H1, p.vmax_kt!, vmaxMax) }));
  const triLine = series
    .filter((s: any) => s.trinetra_kt !== null)
    .map((s: any) => ({ x: scale.x(s.valid_time), y: yIn(H1, s.trinetra_kt, vmaxMax) }));
  const baseLine = series
    .filter((s: any) => s.baseline_kt !== null)
    .map((s: any) => ({ x: scale.x(s.valid_time), y: yIn(H1, s.baseline_kt, vmaxMax) }));

  /* Panel 3: spread */
  const H3 = 74;
  const spreadLine = series
    .filter((s: any) => s.spread_kt !== null)
    .map((s: any) => ({ x: scale.x(s.valid_time), y: yIn(H3, s.spread_kt, spreadMax) }));

  const markX = markAt ? scale.x(markAt) : null;

  return (
    <div className="scroll-x">
      <svg viewBox={`0 0 ${W} ${H1 + 92 + H3 + 26}`} width="100%"
           style={{ display: "block", minWidth: 640 }}>
        {/* ---- panel 1: intensity */}
        <g>
          <text x={PAD_L} y={11} className="tele" fill="var(--fg-3)"
                style={{ fontSize: 9.5, letterSpacing: "0.14em" }}>
            INTENSITY, KT
          </text>
          {[0, 34, 64, 90, 120].filter((v) => v < vmaxMax).map((v) => (
            <g key={v}>
              <line x1={PAD_L} x2={W - PAD_R} y1={yIn(H1, v, vmaxMax)}
                    y2={yIn(H1, v, vmaxMax)} stroke="var(--line-soft)"
                    strokeWidth={1} />
              <text x={PAD_L - 6} y={yIn(H1, v, vmaxMax) + 3} textAnchor="end"
                    fill="var(--fg-3)" style={{ fontSize: 9,
                    fontFamily: "var(--mono)" }}>
                {v}
              </text>
            </g>
          ))}

          {/* Regime bands, so the land-sea transition reads on the chart too. */}
          {track.regime_segments.map((seg, i) => {
            const a = scale.x(seg.start_time);
            const b = scale.x(seg.end_time);
            return (
              <rect key={i} x={a} y={H1 - 3} width={Math.max(b - a, 1)} height={3}
                    fill={REGIME_COLOR[seg.regime] ?? "var(--accent)"}
                    opacity={0.8} />
            );
          })}

          {baseLine.length > 1 && (
            <path d={path(baseLine)} fill="none" stroke="var(--class-r)"
                  strokeWidth={1.2} strokeDasharray="3 3" opacity={0.85} />
          )}
          {triLine.length > 1 && (
            <path d={path(triLine)} fill="none" stroke="var(--class-d)"
                  strokeWidth={1.8} />
          )}
          {observed.length > 1 && (
            <path d={path(observed)} fill="none" stroke="var(--class-o)"
                  strokeWidth={1.8} />
          )}
          {observed.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={1.5} fill="var(--class-o)" />
          ))}
        </g>

        {/* ---- panel 2: RI */}
        <g transform={`translate(0, ${H1 + 16})`}>
          <text x={PAD_L} y={11} fill="var(--fg-3)"
                style={{ fontSize: 9.5, fontFamily: "var(--mono)",
                         letterSpacing: "0.14em" }}>
            RI PROBABILITY
          </text>
          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <line x1={PAD_L} x2={W - PAD_R} y1={yIn(60, v, 1)} y2={yIn(60, v, 1)}
                    stroke="var(--line-soft)" />
              <text x={PAD_L - 6} y={yIn(60, v, 1) + 3} textAnchor="end"
                    fill="var(--fg-3)" style={{ fontSize: 9,
                    fontFamily: "var(--mono)" }}>
                {(v * 100).toFixed(0)}
              </text>
            </g>
          ))}
          {/* The operational threshold, drawn. */}
          <line x1={PAD_L} x2={W - PAD_R} y1={yIn(60, riThreshold, 1)}
                y2={yIn(60, riThreshold, 1)} stroke="var(--warn)"
                strokeWidth={1.1} strokeDasharray="5 3" />
          <text x={W - PAD_R} y={yIn(60, riThreshold, 1) - 4} textAnchor="end"
                fill="var(--warn)" style={{ fontSize: 9,
                fontFamily: "var(--mono)" }}>
            threshold {(riThreshold * 100).toFixed(0)}%
          </text>
          <text x={PAD_L} y={54} fill="var(--fg-3)"
                style={{ fontSize: 9.5, fontFamily: "var(--mono)" }}>
            per-timestep RI series requires a model run at every fix
          </text>
        </g>

        {/* ---- panel 3: disagreement spread */}
        <g transform={`translate(0, ${H1 + 92})`}>
          <text x={PAD_L} y={11} fill="var(--fg-3)"
                style={{ fontSize: 9.5, fontFamily: "var(--mono)",
                         letterSpacing: "0.14em" }}>
            METHOD SPREAD, KT
          </text>
          <line x1={PAD_L} x2={W - PAD_R} y1={yIn(H3, 0, spreadMax)}
                y2={yIn(H3, 0, spreadMax)} stroke="var(--line)" />
          <line x1={PAD_L} x2={W - PAD_R} y1={yIn(H3, 5, spreadMax)}
                y2={yIn(H3, 5, spreadMax)} stroke="var(--alert)"
                strokeWidth={1} strokeDasharray="5 3" opacity={0.7} />
          <text x={PAD_L - 6} y={yIn(H3, 5, spreadMax) + 3} textAnchor="end"
                fill="var(--alert)" style={{ fontSize: 9,
                fontFamily: "var(--mono)" }}>
            5
          </text>
          {spreadLine.length > 1 && (
            <path d={path(spreadLine)} fill="none" stroke="var(--fg-1)"
                  strokeWidth={1.5} />
          )}
          {spreadLine.map((p: { x: number; y: number }, i: number) => (
            <circle key={i} cx={p.x} cy={p.y} r={1.4}
                    fill={series[i]?.above_threshold ? "var(--alert)" : "var(--fg-2)"} />
          ))}
        </g>

        {/* ---- shared axis: bulletin ticks and the current position */}
        <g transform={`translate(0, ${H1 + 92 + H3 + 4})`}>
          <line x1={PAD_L} x2={W - PAD_R} y1={0} y2={0} stroke="var(--line)" />
          {track.bulletin_times.map((b, i) => (
            <line key={i} x1={scale.x(b)} x2={scale.x(b)} y1={0} y2={5}
                  stroke="var(--fg-3)" strokeWidth={1} />
          ))}
          <text x={PAD_L} y={17} fill="var(--fg-3)"
                style={{ fontSize: 9, fontFamily: "var(--mono)" }}>
            {formatUtcShort(pts[0].valid_time)}
          </text>
          <text x={W - PAD_R} y={17} textAnchor="end" fill="var(--fg-3)"
                style={{ fontSize: 9, fontFamily: "var(--mono)" }}>
            {formatUtcShort(pts[pts.length - 1].valid_time)}
          </text>
          <text x={(PAD_L + W - PAD_R) / 2} y={17} textAnchor="middle"
                fill="var(--fg-3)" style={{ fontSize: 9,
                fontFamily: "var(--mono)" }}>
            IMD bulletin ticks
          </text>
        </g>

        {/* Current scrubber position, across all three panels. */}
        {markX !== null && (
          <line x1={markX} x2={markX} y1={4} y2={H1 + 92 + H3} stroke="var(--accent)"
                strokeWidth={1} opacity={0.75} />
        )}
      </svg>

      <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
        <Key colour="var(--class-o)" label="Best-track observed" cls="O" />
        <Key colour="var(--class-d)" label="TRINETRA analysis" cls="D" />
        <Key colour="var(--class-r)" label="Analysis baseline" cls="R" />
        <span className="tele">
          Spread above 5 kt is flagged. That chart is the one worth reading.
        </span>
      </div>
    </div>
  );
}

function Key({ colour, label, cls }: { colour: string; label: string;
                                       cls: "O" | "R" | "D" }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 14, height: 2, background: colour }} />
      <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{label}</span>
      <span className={`chip cls-${cls}`} style={{ padding: "0 4px", fontSize: 9 }}>
        {cls}
      </span>
    </span>
  );
}
