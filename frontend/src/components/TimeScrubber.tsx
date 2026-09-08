/* The time axis.
 *
 * Two things on it do work no general weather map does.
 *
 * IMD bulletin times are drawn as ticks on the axis itself, so the
 * between-bulletin gap is visible without a separate chart. The argument the
 * whole nowcasting claim rests on is that official bulletins are three to six
 * hourly and leave blind windows; putting the ticks on the axis makes that
 * argument out of geometry rather than out of a sentence on a slide.
 *
 * Playback advances the inference index, not wall-clock seconds. At 20x the
 * intent is twenty inference steps per unit time, not a twenty-times-faster
 * animation, and the difference matters because the underlying data is a
 * discrete sequence of granules rather than a continuous field.
 *
 * Keyboard: space to play or pause, arrows to step, L to cycle layers, F for
 * follow. Those are the specified bindings.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { formatUtc, formatUtcShort, REGIME_COLOR } from "../api/client";
import { REGIME_PLAIN } from "../api/plain";
import type { Track } from "../api/types";
import { useStore } from "../state/store";

interface Props {
  track: Track | null;
}

const SPEEDS: (1 | 5 | 20)[] = [1, 5, 20];

export default function TimeScrubber({ track }: Props) {
  const { at, playing, speed, follow, active, layersById } = useStore();
  const set = useStore((s) => s.set);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const timer = useRef<number | null>(null);

  const points = track?.points ?? [];
  const index = useMemo(() => {
    if (!at || !points.length) return Math.max(points.length - 1, 0);
    const t = new Date(at).getTime();
    // Snap backwards: the most recent fix at or before the scrubber position.
    // Snapping forward would show an observation that had not happened yet.
    let best = 0;
    for (let i = 0; i < points.length; i++) {
      if (new Date(points[i].valid_time).getTime() <= t) best = i;
      else break;
    }
    return best;
  }, [at, points]);

  const goTo = useCallback(
    (i: number) => {
      if (!points.length) return;
      const clamped = Math.max(0, Math.min(points.length - 1, i));
      set({ at: points[clamped].valid_time });
    },
    [points, set],
  );

  /* Playback advances the inference index. */
  useEffect(() => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (!playing || points.length < 2) return;
    // One inference step per tick; the speed sets the tick rate.
    const period = Math.round(1100 / speed);
    timer.current = window.setInterval(() => {
      const s = useStore.getState();
      const t = s.at ? new Date(s.at).getTime() : 0;
      let cur = 0;
      for (let i = 0; i < points.length; i++) {
        if (new Date(points[i].valid_time).getTime() <= t) cur = i;
        else break;
      }
      if (cur >= points.length - 1) {
        set({ playing: false });
        return;
      }
      set({ at: points[cur + 1].valid_time });
    }, period);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, speed, points, set]);

  /* Keyboard bindings. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          set({ playing: !useStore.getState().playing });
          break;
        case "ArrowRight":
          e.preventDefault();
          set({ playing: false });
          goTo(index + 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          set({ playing: false });
          goTo(index - 1);
          break;
        case "f":
        case "F":
          set({ follow: !useStore.getState().follow });
          break;
        case "l":
        case "L": {
          // Cycle through the raster layers, so one key steps a demo through
          // the observed stack without hunting in the panel.
          const rasters = Object.values(layersById)
            .filter((l) => l.render === "raster" && l.group === "observed")
            .map((l) => l.id);
          if (!rasters.length) break;
          const on = rasters.filter((id) => active.includes(id));
          const next = on.length
            ? rasters[(rasters.indexOf(on[on.length - 1]) + 1) % rasters.length]
            : rasters[0];
          for (const id of on) toggleLayer(id);
          toggleLayer(next);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, goTo, set, active, layersById, toggleLayer]);

  if (!points.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, height: 58 }}>
        <span className="tele">Loading track…</span>
      </div>
    );
  }

  const t0 = new Date(points[0].valid_time).getTime();
  const t1 = new Date(points[points.length - 1].valid_time).getTime();
  const span = Math.max(t1 - t0, 1);
  const pct = (iso: string) =>
    ((new Date(iso).getTime() - t0) / span) * 100;

  const current = points[index];
  const bulletins = track?.bulletin_times ?? [];

  return (
    <div>
      {/* The transport row, laid out the way a media player is: controls on
          the left, the time this view is showing in the middle at the largest
          size on the bar, view options on the right. The time is the single
          most important thing here — everything on the map is an answer to
          "at this moment" — so it is centred and set large. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8,
                    marginBottom: 9 }}>
        <button
          onClick={() => set({ playing: !playing })}
          className={playing ? "active" : undefined}
          title="Play or pause (spacebar)"
          aria-label={playing ? "pause" : "play"}
          style={{
            width: 36, height: 32, padding: 0, borderRadius: "var(--r-pill)",
            fontFamily: "var(--mono)", fontSize: 12, flex: "none",
            ...(playing ? {} : {
              color: "var(--accent-ink)",
              background: "linear-gradient(180deg, var(--accent-2), var(--accent))",
              borderColor: "transparent",
            }),
          }}
        >
          {playing ? "❙❙" : "▶"}
        </button>
        <button onClick={() => { set({ playing: false }); goTo(index - 1); }}
                title="Step back one observation (left arrow)"
                aria-label="step back"
                className="icon-btn">
          ◀
        </button>
        <button onClick={() => { set({ playing: false }); goTo(index + 1); }}
                title="Step forward one observation (right arrow)"
                aria-label="step forward"
                className="icon-btn">
          ▶
        </button>

        <span style={{ flex: 1 }} />

        <div style={{ textAlign: "center", minWidth: 0 }}>
          <div className="num" style={{ fontSize: 15, color: "var(--fg)",
                                        letterSpacing: "-0.015em" }}>
            {formatUtc(current.valid_time)}
          </div>
          <div className="tele" style={{ marginTop: 2 }}>
            Observation {index + 1} of {points.length}
            {current.regime && (
              <>
                {" · "}
                <span style={{ color: REGIME_COLOR[current.regime] }}>
                  {REGIME_PLAIN[current.regime] ??
                    current.regime.replace(/_/g, " ")}
                </span>
              </>
            )}
          </div>
        </div>

        <span style={{ flex: 1 }} />

        <div style={{ display: "flex", gap: 3, flex: "none" }}>
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              className={speed === sp ? "active" : undefined}
              onClick={() => set({ speed: sp })}
              title="How fast playback steps through the observations. It advances one observation at a time, not a fixed number of seconds."
              style={{ padding: "4px 9px", fontFamily: "var(--mono)",
                       fontSize: 11, borderRadius: "var(--r-pill)" }}
            >
              {sp}×
            </button>
          ))}
        </div>

        <button
          className={follow ? "active" : undefined}
          onClick={() => set({ follow: !follow })}
          title="Keep the map centred on the storm as time advances (F). On by default: the satellite imagery only covers a box around the storm, so an unlocked view loses it within a few steps."
          style={{ padding: "4px 12px", fontSize: 11, flex: "none",
                   borderRadius: "var(--r-pill)" }}
        >
          Follow storm
        </button>
      </div>

      {/* The axis. */}
      <div style={{ position: "relative", height: 32 }}>
        {/* Phase bands behind the axis, so the land-sea transition is visible
            on the timeline as well as on the map. */}
        <div style={{ position: "absolute", left: 0, right: 0, top: 5, height: 7,
                      borderRadius: 4, overflow: "hidden",
                      background: "rgba(255,255,255,0.06)" }}>
          {track!.regime_segments.map((seg, i) => {
            const a = pct(seg.start_time);
            const b = pct(seg.end_time);
            return (
              <div
                key={i}
                className="sweep"
                style={{
                  position: "absolute", left: `${a}%`,
                  width: `${Math.max(b - a, 0.6)}%`, top: 0, bottom: 0,
                  background: REGIME_COLOR[seg.regime] ?? "var(--accent)",
                  opacity: 0.78,
                  animationDelay: `${i * 70}ms`,
                }}
                title={REGIME_PLAIN[seg.regime] ?? seg.regime.replace(/_/g, " ")}
              />
            );
          })}
        </div>

        {/* Landfall marker. */}
        {track!.landfall_index !== null && points[track!.landfall_index!] && (
          <div
            title="Crossed the coast"
            style={{
              position: "absolute",
              left: `${pct(points[track!.landfall_index!].valid_time)}%`,
              top: 0, bottom: 12, width: 1.5,
              background: "var(--regime-overland)", opacity: 0.9,
            }}
          />
        )}

        {/* IMD bulletin ticks. The gap between them is the argument: official
            bulletins are three to six hourly, and everything between two ticks
            is a window nothing official covers. */}
        {bulletins.map((b, i) => (
          <div
            key={i}
            title={`Official IMD bulletin issued ${formatUtcShort(b)}`}
            style={{
              position: "absolute", left: `${pct(b)}%`, top: 15, height: 6,
              width: 1, background: "var(--fg-3)", opacity: 0.8,
            }}
          />
        ))}

        <input
          type="range"
          min={0}
          max={points.length - 1}
          step={1}
          value={index}
          onChange={(e) => { set({ playing: false }); goTo(Number(e.target.value)); }}
          aria-label="Time"
          style={{
            position: "absolute", left: 0, right: 0, top: 2, width: "100%",
            background: "transparent", height: 13, cursor: "pointer",
          }}
        />

        <div style={{ position: "absolute", left: 0, bottom: -2 }} className="tele">
          {formatUtcShort(points[0].valid_time)}
        </div>
        <div style={{ position: "absolute", right: 0, bottom: -2 }} className="tele">
          {formatUtcShort(points[points.length - 1].valid_time)}
        </div>
        <div
          style={{ position: "absolute", left: "50%", bottom: -2,
                   transform: "translateX(-50%)" }}
          className="tele"
        >
          ▏ ticks are official IMD bulletins
        </div>
      </div>
    </div>
  );
}
