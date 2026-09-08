/* The storm selector.
 *
 * A native select with 110 options is technically a selector and practically a
 * wall. This is a search field over the same list, with the featured cases
 * pinned at the top, because in a demo the operator wants Biparjoy in two
 * keystrokes and a reviewer wants to see that the archive is not four
 * hand-picked storms.
 *
 * The closed state is not a control, it is a readout: the current system, its
 * category and its current intensity, which is the single most important line
 * on the Explorer and was previously only available by reading the right-hand
 * panel.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { REGIME_COLOR, REGIME_LABEL } from "../api/client";
import type { StormState, StormSummary } from "../api/types";

interface Props {
  storms: StormSummary[];
  value: string | null;
  state: StormState | null;
  onChange: (id: string) => void;
}

export default function StormPicker({ storms, value, state, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const current = storms.find((s) => s.storm_id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    input.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const match = (s: StormSummary) =>
      !t ||
      s.name.toLowerCase().includes(t) ||
      String(s.season).includes(t) ||
      s.basin.includes(t) ||
      (s.peak_category ?? "").toLowerCase().includes(t);
    const featured = storms.filter((s) => s.featured_slug && match(s));
    const rest = storms.filter((s) => !s.featured_slug && match(s));
    return { featured, rest };
  }, [storms, q]);

  const regime = state?.regime.label;

  return (
    <div ref={box} style={{ position: "relative", width: 296 }}>
      <button
        onClick={() => { setOpen((v) => !v); setQ(""); }}
        className="glass"
        aria-expanded={open}
        aria-haspopup="listbox"
        style={{
          width: "100%", textAlign: "left", padding: "9px 12px",
          display: "flex", alignItems: "center", gap: 10,
          borderRadius: "var(--r-lg)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 14.5, color: "var(--fg)", fontWeight: 500,
                           letterSpacing: "-0.01em" }}>
              {current?.name ?? "Select a system"}
            </span>
            {current && <span className="tele">{current.season}</span>}
            {current?.featured_slug && (
              <span className="tele" style={{ color: "var(--accent)" }}>featured</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8,
                        marginTop: 2, overflow: "hidden" }}>
            {state ? (
              <>
                <span className="num" style={{ fontSize: 12, color: "var(--fg-1)" }}>
                  {state.intensity.vmax_kt === null
                    ? "not issued"
                    : `${state.intensity.vmax_kt.toFixed(0)} kt`}
                </span>
                <span className="tele">
                  {state.classification.imd_category ?? "--"}
                </span>
                {regime && (
                  <span className="tele" style={{ color: REGIME_COLOR[regime] }}>
                    {REGIME_LABEL[regime] ?? regime}
                  </span>
                )}
              </>
            ) : (
              <span className="tele">
                {current
                  ? `${current.n_fixes} fixes · ${current.basin.replace(/_/g, " ")}`
                  : `${storms.length || "—"} in archive`}
              </span>
            )}
          </div>
        </div>
        <span className="tele" style={{ fontSize: 12, color: "var(--fg-2)" }}>
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div
          className="glass rise"
          role="listbox"
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
            maxHeight: "62vh", display: "flex", flexDirection: "column",
            overflow: "hidden", zIndex: 40,
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, season, basin, category"
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ overflowY: "auto", padding: "4px 0" }}>
            {list.featured.length > 0 && (
              <>
                <GroupLabel>Featured cases</GroupLabel>
                {list.featured.map((s) => (
                  <Row key={s.storm_id} s={s} on={s.storm_id === value}
                       onPick={() => { onChange(s.storm_id); setOpen(false); }} />
                ))}
              </>
            )}
            {list.rest.length > 0 && (
              <>
                <GroupLabel>
                  Archive · {list.rest.length} system{list.rest.length === 1 ? "" : "s"}
                </GroupLabel>
                {list.rest.slice(0, 140).map((s) => (
                  <Row key={s.storm_id} s={s} on={s.storm_id === value}
                       onPick={() => { onChange(s.storm_id); setOpen(false); }} />
                ))}
              </>
            )}
            {!list.featured.length && !list.rest.length && (
              <div className="tele" style={{ padding: "14px 12px" }}>
                nothing matches “{q}”
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="tele" style={{ padding: "8px 12px 4px" }}>{children}</div>
  );
}

function Row({ s, on, onPick }: {
  s: StormSummary; on: boolean; onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      role="option"
      aria-selected={on}
      style={{
        width: "100%", textAlign: "left", border: "none", borderRadius: 0,
        background: on ? "var(--accent-glow)" : "transparent",
        padding: "6px 12px", display: "flex", alignItems: "baseline", gap: 8,
      }}
    >
      <span style={{ color: on ? "var(--accent)" : "var(--fg)", fontSize: 12.5,
                     flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                     whiteSpace: "nowrap" }}>
        {s.name}
      </span>
      <span className="tele">{s.season}</span>
      <span className="num" style={{ fontSize: 10.5, color: "var(--fg-2)",
                                     width: 44, textAlign: "right" }}>
        {s.peak_vmax_kt.toFixed(0)} kt
      </span>
      <span className="tele" style={{ width: 40, textAlign: "right" }}>
        {s.peak_category ?? "--"}
      </span>
    </button>
  );
}
