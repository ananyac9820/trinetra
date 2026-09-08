/* The rotating wireframe graticule.
 *
 * Taken directly from the reference footage: a hairline sphere of meridians and
 * parallels over a dark ground, rotating slowly, with monospace telemetry
 * labels pinned beside it and a small satellite dot in orbit. It is the landing
 * page hero.
 *
 * Drawn as SVG rather than WebGL for a specific reason. The landing page has to
 * load in under two seconds and its job is to orient a stranger, so it must not
 * pull in the Explorer's WebGL stack before anyone has asked for the Explorer.
 * A few hundred SVG paths animated by one CSS transform costs nothing.
 *
 * The projection is a real orthographic one with a rotating central meridian,
 * so the North Indian Ocean domain marked on it sits where it actually is
 * rather than being drawn by eye.
 */

import { useEffect, useRef, useState } from "react";

interface Props {
  size?: number;
  /** Seconds per full rotation. Slow: the reference footage drifts. */
  period?: number;
  labels?: { text: string; value: string }[];
  /** The rotating central meridian readout. Off where it would collide with
   *  a headline; on where the globe is the readout. */
  showMeridian?: boolean;
}

const R = 100; // unit sphere radius in SVG units

/** Orthographic projection. Returns null for points on the far hemisphere. */
function project(lat: number, lon: number, lon0: number): [number, number] | null {
  const p = (lat * Math.PI) / 180;
  const l = ((lon - lon0) * Math.PI) / 180;
  const cosc = Math.cos(p) * Math.cos(l);
  if (cosc <= 0) return null; // back of the sphere
  return [R * Math.cos(p) * Math.sin(l), -R * Math.sin(p)];
}

function pathFor(points: ([number, number] | null)[]): string {
  let d = "";
  let pen = false;
  for (const pt of points) {
    if (!pt) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`;
    pen = true;
  }
  return d;
}

export default function Graticule({
  size = 320, period = 90, labels = [], showMeridian = true,
}: Props) {
  const [lon0, setLon0] = useState(60);
  const raf = useRef<number | null>(null);
  const start = useRef<number>(0);

  useEffect(() => {
    // Respect a reduced-motion preference: hold a static, well-composed angle
    // rather than rotating.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setLon0(78);
      return;
    }
    /* Throttled to about 24 frames a second. Every frame re-projects a few
       hundred points and re-renders forty SVG paths through React, and at 60
       the rotation is slow enough that nobody can tell the difference, so
       three fifths of that work bought nothing. */
    let last = 0;
    const tick = (t: number) => {
      if (!start.current) start.current = t;
      if (t - last > 41) {
        last = t;
        const elapsed = (t - start.current) / 1000;
        setLon0(((elapsed / period) * 360 + 40) % 360);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [period]);

  const meridians: string[] = [];
  for (let lon = 0; lon < 360; lon += 20) {
    const pts: ([number, number] | null)[] = [];
    for (let lat = -90; lat <= 90; lat += 3) pts.push(project(lat, lon, lon0));
    const d = pathFor(pts);
    if (d) meridians.push(d);
  }

  const parallels: string[] = [];
  for (let lat = -60; lat <= 60; lat += 20) {
    const pts: ([number, number] | null)[] = [];
    for (let lon = 0; lon <= 360; lon += 3) pts.push(project(lat, lon, lon0));
    const d = pathFor(pts);
    if (d) parallels.push(d);
  }

  // The North Indian Ocean domain, 60 to 100 E and 5 to 28 N, drawn where it
  // actually is on the sphere.
  const domain: ([number, number] | null)[] = [];
  for (let lon = 60; lon <= 100; lon += 2) domain.push(project(5, lon, lon0));
  for (let lat = 5; lat <= 28; lat += 2) domain.push(project(lat, 100, lon0));
  for (let lon = 100; lon >= 60; lon -= 2) domain.push(project(28, lon, lon0));
  for (let lat = 28; lat >= 5; lat -= 2) domain.push(project(lat, 60, lon0));
  const domainPath = pathFor(domain);
  const domainVisible = domain.some(Boolean);

  // A satellite in orbit, so the hero has one moving object independent of the
  // rotation, which is what the reference frames do.
  const orbitAngle = (lon0 * 2.4 * Math.PI) / 180;
  const sat: [number, number] = [
    R * 1.16 * Math.cos(orbitAngle),
    R * 0.42 * Math.sin(orbitAngle),
  ];

  const centre = project(16.5, 88, lon0);

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg
        viewBox={`${-R * 1.3} ${-R * 1.3} ${R * 2.6} ${R * 2.6}`}
        width={size}
        height={size}
        style={{ display: "block", overflow: "visible" }}
        aria-hidden
      >
        {/* Limb */}
        <circle cx={0} cy={0} r={R} fill="none" stroke="var(--line-strong)"
                strokeWidth={0.7} />
        <circle cx={0} cy={0} r={R} fill="url(#globe-fill)" />
        <defs>
          <radialGradient id="globe-fill" cx="38%" cy="32%">
            <stop offset="0%" stopColor="#111b28" />
            <stop offset="72%" stopColor="#0a0e15" />
            <stop offset="100%" stopColor="#070a10" />
          </radialGradient>
        </defs>

        {parallels.map((d, i) => (
          <path key={`p${i}`} d={d} fill="none" stroke="var(--graticule)"
                strokeWidth={0.6} />
        ))}
        {meridians.map((d, i) => (
          <path key={`m${i}`} d={d} fill="none" stroke="var(--graticule)"
                strokeWidth={0.6} />
        ))}

        {/* Equator, slightly stronger */}
        <path d={pathFor(Array.from({ length: 121 }, (_, i) =>
                project(0, i * 3, lon0)))}
              fill="none" stroke="var(--line)" strokeWidth={0.8} />

        {domainVisible && domainPath && (
          <path d={domainPath + "Z"} fill="var(--accent-glow)"
                stroke="var(--accent)" strokeWidth={1.1} strokeOpacity={0.85} />
        )}

        {centre && (
          <>
            <circle cx={centre[0]} cy={centre[1]} r={2.6} fill="var(--accent)" />
            <circle cx={centre[0]} cy={centre[1]} r={7} fill="none"
                    stroke="var(--accent)" strokeWidth={0.6} strokeOpacity={0.5}>
              <animate attributeName="r" values="7;13;7" dur="3.4s"
                       repeatCount="indefinite" />
              <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="3.4s"
                       repeatCount="indefinite" />
            </circle>
          </>
        )}

        {/* Orbit and satellite */}
        <ellipse cx={0} cy={0} rx={R * 1.16} ry={R * 0.42} fill="none"
                 stroke="var(--line-soft)" strokeWidth={0.5} />
        <circle cx={sat[0]} cy={sat[1]} r={2} fill="var(--fg-1)" />

        {/* Crosshair ticks at the limb, as in the reference */}
        {[0, 90, 180, 270].map((a) => {
          const rad = (a * Math.PI) / 180;
          return (
            <line
              key={a}
              x1={Math.cos(rad) * R * 1.02}
              y1={Math.sin(rad) * R * 1.02}
              x2={Math.cos(rad) * R * 1.1}
              y2={Math.sin(rad) * R * 1.1}
              stroke="var(--line-strong)"
              strokeWidth={0.8}
            />
          );
        })}
      </svg>

      {/* Telemetry labels, pinned beside the sphere. */}
      {labels.length > 0 && (
        <div
          className="stagger"
          style={{
            position: "absolute", left: "100%", top: "34%",
            marginLeft: -14, whiteSpace: "nowrap",
          }}
        >
          {labels.map((l) => (
            <div key={l.text} style={{ display: "flex", alignItems: "baseline",
                                       gap: 7, marginBottom: 3 }}>
              <span className="num" style={{ fontSize: 11, color: "var(--fg-1)" }}>
                {l.value}
              </span>
              <span className="tele">{l.text}</span>
            </div>
          ))}
        </div>
      )}

      {showMeridian && (
        <div
          className="tele"
          style={{ position: "absolute", left: "50%", bottom: -6,
                   transform: "translateX(-50%)" }}
        >
          {`lon ${lon0.toFixed(0)}°`}
        </div>
      )}
    </div>
  );
}
