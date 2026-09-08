/* The Cyclone Explorer. The platform's centre of gravity.
 *
 * Map-first: the map is the document and fills the viewport edge to edge, and
 * everything else is a translucent panel floating over it. The alternative — a
 * three-column grid with the map in the middle slot — spends a third of the
 * screen on chrome that shows no data, and on a product whose whole argument is
 * about what the satellite saw, the satellite imagery should be the largest
 * thing on screen.
 *
 * Both side panels collapse, because the single most useful thing a reviewer
 * can do during a demo is get the panels out of the way and look at the storm.
 *
 * What makes it TRINETRA sits in what those panels carry: the provenance
 * grouping, the sensor-mode indicator, the disagreement row, calibrated
 * uncertainty, abstention, the land-sea transition, and the observed-versus-
 * derived distinction. The test is that a reviewer should not be able to say
 * "this is a general weather map for India". They should say "a weather map
 * shows me a forecast; this shows me the evidence".
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
import StormPicker from "../components/StormPicker";
import TimeScrubber from "../components/TimeScrubber";
import { api } from "../api/client";
import type {
  DistrictRisk, Freshness, Probe as ProbeData, StormState, StormSummary, Track,
} from "../api/types";
import { useStore } from "../state/store";

const LEFT_W = 288;
const RIGHT_W = 322;

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
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);
  const hydrated = useRef(false);

  /* Hydrate from the URL exactly once, before anything else writes to it.
     Whether the incoming URL carried a viewport is recorded here rather than
     read back later, because by the time the storm's state arrives the app has
     already written its own viewport into the URL and the question "did the
     user ask for this view" is no longer answerable from it. */
  const urlHadViewport = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    urlHadViewport.current = params.get("z") !== null;
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
    setTrackError(null);
    api.track(store.stormId)
      .then((t) => {
        if (!alive) return;
        setTrack(t);
        if (!store.at && t.points.length) {
          set({ at: t.points[t.points.length - 1].valid_time });
        }
      })
      .catch((e) => {
        if (!alive) return;
        setTrack(null);
        setTrackError(String(e?.message ?? e));
      });
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
      setRightOpen(true);
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
      follow: false,
    });
  };

  /* Frame the storm itself, which is what a reviewer wants nine times out of
     ten and what the imagery footprint actually covers: the cube is a
     1000 km storm-centred grid, so a basin-wide viewport shows mostly empty
     ocean with a small square of data in it. */
  const frameStorm = useCallback(() => {
    if (!state) return;
    set({ lon: state.centre.lon, lat: state.centre.lat, zoom: 6.1 });
  }, [state, set]);

  const framedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    // Once per storm, and never when the incoming permalink named a viewport,
    // so a shared link opens on its view and a user's pan is never fought.
    if (framedFor.current === state.storm_id) return;
    const first = framedFor.current === null;
    framedFor.current = state.storm_id;
    if (first && urlHadViewport.current) return;
    set({ lon: state.centre.lon, lat: state.centre.lat, zoom: 5.7 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.storm_id]);

  const copyPermalink = async () => {
    const url = `${window.location.origin}/explorer?${toUrl()}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1700);
    } catch {
      window.prompt("Copy this permalink", url);
    }
  };

  const noSystem = store.mode === "live" && !state;
  const loading = !state && !noSystem && !trackError;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {/* The map is the ground. Everything else floats on it. */}
      <MapCanvas track={track} state={state} risk={risk} onProbe={onProbe} />

      {/* ------------------------------------------------- top command row */}
      <div
        style={{
          position: "absolute", top: "calc(var(--chrome-h) + 8px)",
          left: 14, right: 14, display: "flex", gap: 8,
          alignItems: "flex-start", pointerEvents: "none", zIndex: 20,
        }}
      >
        <div style={{ pointerEvents: "auto" }}>
          <StormPicker
            storms={storms}
            value={store.stormId}
            state={state}
            onChange={(id) => {
              set({ stormId: id, at: null, probe: null });
              setProbe(null);
            }}
          />
        </div>

        <div
          className="glass"
          style={{
            pointerEvents: "auto", display: "flex", gap: 2, padding: 3,
            borderRadius: "var(--r-pill)",
          }}
        >
          {Object.entries(presets).map(([k, p]) => (
            <button
              key={k}
              onClick={() => goPreset(k)}
              title={p.label}
              className="pill"
              style={{ fontSize: 11, padding: "4px 11px", background: "transparent",
                       border: "none" }}
            >
              {p.label.replace(" (land transition)", "")}
            </button>
          ))}
          <button
            onClick={frameStorm}
            disabled={!state}
            title="Centre the viewport on the current fix, at the scale the storm-centred data cube covers"
            className="pill"
            style={{ fontSize: 11, padding: "4px 11px", background: "transparent",
                     border: "none", color: "var(--accent)" }}
          >
            Frame storm
          </button>
        </div>

        <span style={{ flex: 1 }} />

        <div style={{ display: "flex", gap: 6, pointerEvents: "auto" }}>
          <button
            onClick={copyPermalink}
            className="glass pill"
            style={{ fontSize: 11, padding: "6px 14px",
                     color: copied ? "var(--accent)" : undefined }}
            title="The full view state is in the URL. Pasting it into a fresh browser reproduces this exact view."
          >
            {copied ? "Link copied" : "Copy permalink"}
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------- left panel */}
      <PanelShell
        side="left"
        open={leftOpen}
        width={LEFT_W}
        onToggle={() => setLeftOpen((v) => !v)}
        label="Layers"
      >
        <LayerPanel freshness={freshness} />
      </PanelShell>

      {/* ------------------------------------------------------ right panel */}
      <PanelShell
        side="right"
        open={rightOpen}
        width={RIGHT_W}
        onToggle={() => setRightOpen((v) => !v)}
        label={store.panel === "probe" ? "Probe" : "System"}
        tabs={
          <div style={{ display: "flex", padding: 3, gap: 2 }}>
            {(["layers", "probe"] as const).map((p) => {
              const label = p === "layers" ? "Selected system" : "Probe";
              const on = store.panel === p ||
                (p === "layers" && store.panel === "legend");
              return (
                <button
                  key={p}
                  onClick={() => set({ panel: p })}
                  className="pill"
                  style={{
                    flex: 1, border: "none",
                    background: on ? "var(--accent-glow)" : "transparent",
                    color: on ? "var(--accent)" : "var(--fg-2)",
                    padding: "5px 0", fontSize: 11.5,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        }
      >
        {store.panel === "probe" ? (
          <Probe
            probe={probe}
            loading={probing}
            onClose={() => { set({ probe: null, panel: "layers" }); setProbe(null); }}
          />
        ) : (
          <SidePanel state={state} loading={loading} />
        )}
      </PanelShell>

      {/* --------------------------------------------------------- timeline */}
      <div
        style={{
          position: "absolute", left: leftOpen ? LEFT_W + 26 : 60,
          right: rightOpen ? RIGHT_W + 26 : 60,
          bottom: 40, zIndex: 20, pointerEvents: "none",
          transition: "left var(--t) var(--ease-out), right var(--t) var(--ease-out)",
        }}
      >
        <div className="glass" style={{ pointerEvents: "auto", padding: "10px 14px 12px" }}>
          <TimeScrubber track={track} />
        </div>
      </div>

      {/* ------------------------------------------------- channel age strip */}
      <div
        style={{
          position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 25,
          background: "rgba(5,8,12,0.9)",
          backdropFilter: "var(--glass-blur)",
          borderTop: "1px solid var(--line)",
        }}
      >
        <ChannelAgeStrip freshness={freshness} compact />
      </div>

      {/* ---------------------------------------------------- empty states */}
      {noSystem && (
        <Overlay title="No system tracked">
          No cyclonic system is currently being tracked in the basin. Layer
          freshness is still reported below, and the archive is available in
          replay.
        </Overlay>
      )}
      {trackError && (
        <Overlay title="Track unavailable" tone="alert">
          The track for this system could not be loaded. {trackError}
        </Overlay>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- fragments */

/* A floating side panel with a collapse control. The control stays on screen
   when the panel is closed, because a collapse the user cannot undo is a bug
   rather than a feature. */
function PanelShell({
  side, open, width, onToggle, label, tabs, children,
}: {
  side: "left" | "right";
  open: boolean;
  width: number;
  onToggle: () => void;
  label: string;
  tabs?: React.ReactNode;
  children: React.ReactNode;
}) {
  const edge = side === "left" ? { left: 14 } : { right: 14 };
  const arrow = side === "left"
    ? (open ? "‹" : "›")
    : (open ? "›" : "‹");

  return (
    <>
      <aside
        className="glass"
        style={{
          position: "absolute",
          top: "calc(var(--chrome-h) + 52px)",
          bottom: 132,
          ...edge,
          width,
          zIndex: 18,
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          opacity: open ? 1 : 0,
          transform: open
            ? "none"
            : `translateX(${side === "left" ? -24 : 24}px)`,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity var(--t) var(--ease-out), transform var(--t) var(--ease-out)",
        }}
      >
        {tabs && (
          <div style={{ flex: "none", borderBottom: "1px solid var(--line)" }}>
            {tabs}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, display: "flex",
                      flexDirection: "column" }}>
          {children}
        </div>
      </aside>

      <button
        onClick={onToggle}
        title={`${open ? "Hide" : "Show"} ${label.toLowerCase()}`}
        aria-label={`${open ? "Hide" : "Show"} ${label}`}
        className="glass"
        style={{
          position: "absolute",
          top: "calc(var(--chrome-h) + 52px)",
          ...(side === "left"
            ? { left: open ? width + 20 : 14 }
            : { right: open ? width + 20 : 14 }),
          zIndex: 19,
          width: 26, height: 30, padding: 0,
          borderRadius: "var(--r)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--mono)", fontSize: 14, lineHeight: 1,
          transition: "left var(--t) var(--ease-out), right var(--t) var(--ease-out)",
        }}
      >
        {arrow}
      </button>
    </>
  );
}

function Overlay({
  title, children, tone,
}: { title: string; children: React.ReactNode; tone?: "alert" }) {
  return (
    <div
      className="glass fade"
      style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)", padding: "16px 20px",
        maxWidth: 400, textAlign: "center", zIndex: 22,
        borderColor: tone === "alert"
          ? "color-mix(in srgb, var(--alert) 40%, transparent)"
          : undefined,
      }}
    >
      <div className="tele" style={{ marginBottom: 6,
                                     color: tone === "alert" ? "var(--alert)" : undefined }}>
        {title}
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.6 }}>
        {children}
      </div>
    </div>
  );
}
