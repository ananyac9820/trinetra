/* The Cyclone Explorer. The platform's centre of gravity.
 *
 * Map-primary layout, with the layer panel on the left, the selected-system
 * panel on the right, the time axis along the bottom and the channel-age strip
 * beneath that. The interaction paradigm is deliberately the familiar one for
 * geospatial exploration, because that paradigm is good and inventing a worse
 * one would help nobody.
 *
 * What makes it TRINETRA sits outside that paradigm and is what the panels
 * carry: the provenance grouping, the sensor-mode indicator, the disagreement
 * row, calibrated uncertainty, abstention, the land-sea transition, and the
 * observed-versus-derived distinction. The test is that a reviewer should not
 * be able to say "this is a general weather map for India". They should say
 * "a weather map shows me a forecast; this shows me the evidence".
 *
 * Every piece of view state is in the store and every change is reflected in
 * the URL, so a permalink reproduces the view exactly and a scripted demo is a
 * list of URLs rather than a list of clicks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import MapCanvas from "../map/MapCanvas";
import ChannelAgeStrip from "../components/ChannelAgeStrip";
import LayerPanel from "../components/LayerPanel";
import Probe from "../components/Probe";
import SidePanel from "../components/SidePanel";
import TimeScrubber from "../components/TimeScrubber";
import { api } from "../api/client";
import type {
  DistrictRisk, Freshness, Probe as ProbeData, StormState, StormSummary, Track,
} from "../api/types";
import { useStore } from "../state/store";

export default function Explorer() {
  const [params, setParams] = useSearchParams();
  const store = useStore();
  const applyUrl = useStore((s) => s.applyUrl);
  const toUrl = useStore((s) => s.toUrl);
  const set = useStore((s) => s.set);

  const [storms, setStorms] = useState<StormSummary[]>([]);
  const [track, setTrack] = useState<Track | null>(null);
  const [state, setState] = useState<StormState | null>(null);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [risk, setRisk] = useState<DistrictRisk | null>(null);
  const [probe, setProbe] = useState<ProbeData | null>(null);
  const [probing, setProbing] = useState(false);
  const [presets, setPresets] = useState<Record<string, { label: string; bbox: number[] }>>({});
  const hydrated = useRef(false);

  /* Hydrate from the URL exactly once, before anything else writes to it. */
  useEffect(() => {
    if (hydrated.current) return;
    applyUrl(params.toString());
    hydrated.current = true;
  }, [params, applyUrl]);

  useEffect(() => {
    api.storms().then((r) => setStorms(r.storms)).catch(() => {});
    api.presets().then((r) => setPresets(r.presets)).catch(() => {});
  }, []);

  /* Pick a default storm once the list arrives, preferring a featured case so
     the Explorer opens on something worth looking at. */
  useEffect(() => {
    if (store.stormId || !storms.length) return;
    const featured = storms.find((s) => s.featured_slug === "biparjoy") ??
      storms.find((s) => s.featured_slug) ?? storms[0];
    set({ stormId: featured.storm_id, at: featured.end_time });
  }, [storms, store.stormId, set]);

  /* Track, which also sets the scrubber bounds. */
  useEffect(() => {
    if (!store.stormId) return;
    let alive = true;
    api.track(store.stormId)
      .then((t) => {
        if (!alive) return;
        setTrack(t);
        if (!store.at && t.points.length) {
          set({ at: t.points[t.points.length - 1].valid_time });
        }
      })
      .catch(() => setTrack(null));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.stormId]);

  /* State, freshness and district risk all follow the scrubber. */
  useEffect(() => {
    if (!store.stormId || !store.at) return;
    let alive = true;
    const at = store.at;
    const sid = store.stormId;
    api.state(sid, at).then((s) => { if (alive) setState(s); }).catch(() => {});
    api.freshness(sid, at).then((f) => { if (alive) setFreshness(f); }).catch(() => {});
    if (store.active.includes("tri_district_risk")) {
      api.districtRisk(sid, at).then((r) => { if (alive) setRisk(r); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [store.stormId, store.at, store.active]);

  /* Push view state into the URL. Replace rather than push, so the browser
     back button steps through pages rather than through every scrubber move. */
  useEffect(() => {
    if (!hydrated.current) return;
    const next = toUrl();
    if (next !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.mode, store.stormId, store.at, store.active, store.opacity, store.order,
      store.lon, store.lat, store.zoom, store.bearing, store.pitch, store.follow,
      store.speed, store.probe]);

  const onProbe = useCallback(
    (lat: number, lon: number) => {
      set({ probe: { lat, lon }, panel: "probe" });
      setProbing(true);
      api.probe(lat, lon, store.stormId ?? undefined, store.at ?? undefined)
        .then(setProbe)
        .catch(() => setProbe(null))
        .finally(() => setProbing(false));
    },
    [set, store.stormId, store.at],
  );

  /* Re-probe when the scrubber moves, so an open probe stays truthful rather
     than silently showing values from another time. */
  useEffect(() => {
    if (!store.probe || !store.at) return;
    setProbing(true);
    api.probe(store.probe.lat, store.probe.lon, store.stormId ?? undefined, store.at)
      .then(setProbe)
      .catch(() => {})
      .finally(() => setProbing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.at]);

  const goPreset = (key: string) => {
    const p = presets[key];
    if (!p) return;
    const [w, s, e, n] = p.bbox;
    set({
      lon: (w + e) / 2, lat: (s + n) / 2,
      zoom: Math.min(6.2, Math.max(3.4, 7.4 - Math.log2(Math.max(e - w, n - s)))),
    });
  };

  const copyPermalink = async () => {
    const url = `${window.location.origin}/explorer?${toUrl()}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy this permalink", url);
    }
  };

  const noSystem = store.mode === "live" && !state;

  return (
    <div
      style={{
        position: "absolute", inset: 0, display: "grid",
        gridTemplateColumns: "252px 1fr 302px",
        gridTemplateRows: "1fr auto auto",
        minHeight: 0,
      }}
    >
      {/* Left: layers */}
      <aside
        style={{
          gridRow: "1 / 2", borderRight: "1px solid var(--line)",
          background: "var(--bg-1)", overflow: "hidden", minHeight: 0,
          display: "flex", flexDirection: "column",
        }}
      >
        <LayerPanel freshness={freshness} />
      </aside>

      {/* Centre: map */}
      <section style={{ gridRow: "1 / 2", position: "relative", minHeight: 0 }}>
        <MapCanvas track={track} state={state} risk={risk} onProbe={onProbe} />

        {/* Storm selector and viewport presets, floating over the map. */}
        <div
          className="rise"
          style={{
            position: "absolute", top: 10, left: 10, right: 10,
            display: "flex", gap: 8, alignItems: "center",
            pointerEvents: "none", flexWrap: "wrap",
          }}
        >
          <select
            value={store.stormId ?? ""}
            onChange={(e) => set({ stormId: e.target.value, at: null, probe: null })}
            style={{
              pointerEvents: "auto", background: "var(--bg-2)",
              color: "var(--fg)", border: "1px solid var(--line-strong)",
              borderRadius: "var(--r-sm)", padding: "4px 7px", fontSize: 12,
              maxWidth: 260,
            }}
          >
            {storms.map((s) => (
              <option key={s.storm_id} value={s.storm_id}>
                {s.name} {s.season}
                {s.peak_category ? ` · ${s.peak_category}` : ""}
                {s.featured_slug ? " ★" : ""}
              </option>
            ))}
          </select>

          <div style={{ display: "flex", gap: 3, pointerEvents: "auto" }}>
            {Object.entries(presets).map(([k, p]) => (
              <button key={k} onClick={() => goPreset(k)} title={p.label}
                      style={{ fontSize: 11, padding: "3px 7px" }}>
                {p.label.replace(" (land transition)", "")}
              </button>
            ))}
          </div>

          <span style={{ flex: 1 }} />

          <button onClick={copyPermalink} style={{ pointerEvents: "auto", fontSize: 11 }}
                  title="The full view state is in the URL. Pasting it into a fresh browser reproduces this exact view.">
            Copy permalink
          </button>
        </div>

        {/* In live mode with no active system the Explorer still renders and
            says so, rather than appearing broken. */}
        {noSystem && (
          <div
            className="panel fade"
            style={{
              position: "absolute", top: "50%", left: "50%",
              transform: "translate(-50%, -50%)", padding: "14px 18px",
              maxWidth: 380, textAlign: "center",
            }}
          >
            <div className="tele" style={{ marginBottom: 5 }}>No system tracked</div>
            <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.55 }}>
              No cyclonic system is currently being tracked in the basin. Layer
              freshness is still reported below, and the archive is available in
              replay.
            </div>
          </div>
        )}
      </section>

      {/* Right: selected system, or the probe */}
      <aside
        style={{
          gridRow: "1 / 2", borderLeft: "1px solid var(--line)",
          background: "var(--bg-1)", overflow: "hidden", minHeight: 0,
          display: "flex", flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", borderBottom: "1px solid var(--line)",
                      flex: "none" }}>
          {(["layers", "probe"] as const).map((p) => {
            const label = p === "layers" ? "Selected system" : "Probe";
            const on = store.panel === p || (p === "layers" && store.panel === "legend");
            return (
              <button
                key={p}
                onClick={() => set({ panel: p })}
                style={{
                  flex: 1, border: "none", borderRadius: 0,
                  borderBottom: on ? "1.5px solid var(--accent)" : "1.5px solid transparent",
                  background: on ? "var(--bg-2)" : "transparent",
                  color: on ? "var(--fg)" : "var(--fg-2)",
                  padding: "7px 0", fontSize: 11.5,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          {store.panel === "probe" ? (
            <Probe
              probe={probe}
              loading={probing}
              onClose={() => { set({ probe: null, panel: "layers" }); setProbe(null); }}
            />
          ) : (
            <SidePanel state={state} />
          )}
        </div>
      </aside>

      {/* Bottom: time axis, then the permanent channel-age strip. */}
      <div style={{ gridColumn: "1 / -1", gridRow: "2 / 3" }}>
        <TimeScrubber track={track} />
      </div>
      <div style={{ gridColumn: "1 / -1", gridRow: "3 / 4" }}>
        <ChannelAgeStrip freshness={freshness} />
      </div>
    </div>
  );
}
