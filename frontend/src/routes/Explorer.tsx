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
import ChangeCard from "../components/ChangeCard";
import HerePanel from "../components/HerePanel";
import ScenarioControl from "../components/ScenarioControl";
import StormOverview, { stormsInScope } from "../components/StormOverview";
import ThreatCard from "../components/ThreatCard";
import ThreatStrip from "../components/ThreatStrip";
import ChannelAgeStrip from "../components/ChannelAgeStrip";
import LayerPanel from "../components/LayerPanel";
import MapLegend from "../components/MapLegend";
import Probe from "../components/Probe";
import SidePanel from "../components/SidePanel";
import StormPicker from "../components/StormPicker";
import TimeScrubber from "../components/TimeScrubber";
import { api } from "../api/client";
import type {
  Changes, DistrictRisk, Freshness, Hazard, HazardTimeline, LocationImpact,
  Probe as ProbeData, StormState, StormSummary, Track,
} from "../api/types";
import { useStore } from "../state/store";
import { useViewport } from "../state/useViewport";

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
  const { compact, tight } = useViewport();
  const [leftOpen, setLeftOpen] = useState(!tight);
  const [rightOpen, setRightOpen] = useState(!tight);

  /* Panels follow the breakpoint until the user touches one, after which
     their choice stands. Re-closing a panel someone deliberately opened
     because the window moved a few pixels is worse than a cramped layout. */
  const touchedPanels = useRef(false);
  useEffect(() => {
    if (touchedPanels.current) return;
    setLeftOpen(!tight);
    setRightOpen(!tight);
  }, [tight]);

  /* Impact Mode hands the left column to the impact stack.
     The layer controls are an Analysis instrument, and holding both open
     leaves the map a strip down the middle. Switching back to Analysis
     restores them. Either way a deliberate toggle wins, as above. */
  useEffect(() => {
    if (touchedPanels.current) return;
    setLeftOpen(store.view === "analysis" && !tight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.view]);
  const [copied, setCopied] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);

  /* ---- Impact Mode state.
   *
   * The hazard, its timeline and the change summary all key off the same storm
   * and scrubber position the analysis panels use, so switching mode never
   * re-fetches the storm or moves the map. It is a change of question, not a
   * change of page. */
  const [hazard, setHazard] = useState<Hazard | null>(null);
  const [hazardTl, setHazardTl] = useState<HazardTimeline | null>(null);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [impact, setImpact] = useState<LocationImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [compared, setCompared] = useState<string[]>([]);
  const [others, setOthers] = useState<{ summary: StormSummary; track: Track }[]>([]);
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
    // Every field `toUrl` serialises has to be listed here. It is a plain
    // dependency array rather than a subscription, so a field that is written
    // to the URL but missing from this list is a field whose change never
    // reaches the address bar: the mode, the storm scope and the scenario
    // width were all dropped from shared links until they were added.
  }, [store.mode, store.stormId, store.at, store.active, store.opacity, store.order,
      store.lon, store.lat, store.zoom, store.bearing, store.pitch, store.follow,
      store.speed, store.probe, store.view, store.scope, store.scenarioKm]);

  const onProbe = useCallback(
    (lat: number, lon: number) => {
      set({ probe: { lat, lon }, panel: "probe" });
      setRightOpen(true);
      setProbing(true);
      if (store.view === "impact") askHere(lat, lon);
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

  /* ---- hazard for the current moment, and the change summary.
     Both follow the scrubber. The timeline is per storm and so is fetched
     once per storm rather than once per step. */
  useEffect(() => {
    if (!store.stormId || !store.at) return;
    let alive = true;
    const sid = store.stormId;
    const at = store.at;
    api.hazard(sid, at).then((h) => { if (alive) setHazard(h); })
      .catch(() => { if (alive) setHazard(null); });
    api.changes(sid, at, 6).then((c) => { if (alive) setChanges(c); })
      .catch(() => { if (alive) setChanges(null); });
    return () => { alive = false; };
  }, [store.stormId, store.at]);

  useEffect(() => {
    if (!store.stormId) return;
    let alive = true;
    setHazardTl(null);
    api.hazardTimeline(store.stormId)
      .then((t) => { if (alive) setHazardTl(t); })
      .catch(() => { if (alive) setHazardTl(null); });
    return () => { alive = false; };
  }, [store.stormId]);

  /* ---- the overview storms.
     Tracks are fetched only for the storms actually drawn, and the selected
     storm is excluded because it already has its own detailed track. Fetching
     110 tracks to render a list of six would be absurd. */
  useEffect(() => {
    if (store.scope === "one" && compared.length === 0) {
      setOthers([]);
      return;
    }
    const wanted = stormsInScope(storms, store.scope, store.stormId, compared)
      .filter((s) => s.storm_id !== store.stormId)
      // A hard cap: "All" over 110 storms is 110 requests and an unreadable
      // map. The list still shows every storm; the map draws the first slice.
      .slice(0, store.scope === "all" ? 24 : 8);
    if (!wanted.length) {
      setOthers([]);
      return;
    }
    let alive = true;
    Promise.all(wanted.map((sm) =>
      api.track(sm.storm_id)
        .then((t) => ({ summary: sm, track: t }))
        .catch(() => null)))
      .then((rows) => {
        if (alive) {
          setOthers(rows.filter(Boolean) as { summary: StormSummary; track: Track }[]);
        }
      });
    return () => { alive = false; };
  }, [storms, store.scope, store.stormId, compared]);

  /* ---- the location answer, for Impact Mode's probe. */
  const askHere = useCallback((lat: number, lon: number) => {
    if (!store.stormId) return;
    setImpactLoading(true);
    api.impact(lat, lon, store.stormId, store.at ?? undefined)
      .then(setImpact)
      .catch(() => setImpact(null))
      .finally(() => setImpactLoading(false));
  }, [store.stormId, store.at]);

  /* Keep the location answer truthful when the clock moves. An open panel
     showing values from another time is worse than no panel. */
  useEffect(() => {
    if (!store.probe || !store.at || store.view !== "impact") return;
    askHere(store.probe.lat, store.probe.lon);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.at, store.view]);

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
      <MapCanvas
        track={track}
        state={state}
        risk={risk}
        onProbe={onProbe}
        onHover={(lat, lon) => setCursor({ lat, lon })}
        others={others}
        scenarioKm={store.scenarioKm}
        onSelectStorm={(id) => {
          set({ stormId: id, at: null, probe: null });
          setProbe(null);
          setImpact(null);
        }}
      />

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

        {/* The product's main division, and the first control after the
            storm itself. Analysis answers what the storm is doing; Impact
            answers what that means on the ground. */}
        <div
          className="glass"
          style={{
            pointerEvents: "auto", display: "flex", gap: 2, padding: 3,
            borderRadius: "var(--r-pill)", flex: "none",
          }}
        >
          {([["analysis", "Analysis"], ["impact", "Impact"]] as const)
            .map(([k, label]) => (
            <button
              key={k}
              onClick={() => set({ view: k, panel: k === "impact" ? "probe" : "layers" })}
              className="pill"
              title={k === "analysis"
                ? "What the storm is doing: the observations, the estimate and the evidence."
                : "What it means on the ground: the leading hazard, how it changes, and what it means at a place you click."}
              style={{
                fontSize: 11.5, padding: "4px 13px", border: "none",
                background: store.view === k ? "var(--accent-glow)" : "transparent",
                color: store.view === k ? "var(--accent)" : "var(--fg-2)",
                fontWeight: store.view === k ? 500 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          className="glass"
          style={{
            pointerEvents: "auto", display: "flex", gap: 2, padding: 3,
            borderRadius: "var(--r-pill)",
          }}
        >
          {!compact && Object.entries(presets).map(([k, p]) => (
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

        <div style={{ display: "flex", gap: 6, pointerEvents: "auto",
                      alignItems: "center" }}>
          {/* Where the cursor is, the way a chart tool shows a readout. It
              costs nothing and it answers "what am I looking at" before the
              user has clicked anything. */}
          <span
            className="glass num"
            style={{
              display: tight ? "none" : "inline-block",
              fontSize: 10.5, padding: "6px 12px",
              borderRadius: "var(--r-pill)", color: "var(--fg-2)",
              minWidth: 132, textAlign: "center",
            }}
          >
            {cursor
              ? `${cursor.lat.toFixed(2)}°N  ${cursor.lon.toFixed(2)}°E`
              : "--.--°N  --.--°E"}
          </span>
          <button
            onClick={copyPermalink}
            className="glass pill"
            style={{ fontSize: 11, padding: "6px 14px",
                     color: copied ? "var(--accent)" : undefined }}
            title="The whole view is in the address bar. Paste that link anywhere and it opens on exactly this view."
          >
            {copied ? "Link copied" : (compact ? "Copy link" : "Copy link to this view")}
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------- left panel */}
      <PanelShell
        side="left"
        open={leftOpen}
        width={LEFT_W}
        onToggle={() => { touchedPanels.current = true; setLeftOpen((v) => !v); }}
        label="Layers"
      >
        <LayerPanel
          freshness={freshness}
          onClose={() => { touchedPanels.current = true; setLeftOpen(false); }}
        />
      </PanelShell>

      {/* ------------------------------------------------------ right panel */}
      <PanelShell
        side="right"
        open={rightOpen}
        width={RIGHT_W}
        onToggle={() => { touchedPanels.current = true; setRightOpen((v) => !v); }}
        label={store.panel === "probe" ? "Probe" : "System"}
        tabs={
          <div style={{ display: "flex", padding: 3, gap: 2 }}>
            {(["layers", "probe"] as const).map((p) => {
              const label = p === "layers"
                ? "Selected system"
                : store.view === "impact" ? "What's here?" : "Probe";
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
          /* In Impact Mode a click means "what does this mean here"; in
             Analysis Mode it means "what is every layer's value here". Same
             click, same point, different question, so the mode picks the
             panel rather than making the user find the right tab. */
          store.view === "impact" ? (
            <HerePanel
              impact={impact}
              loading={impactLoading}
              onClose={() => {
                set({ probe: null, panel: "layers" });
                setImpact(null);
                setProbe(null);
              }}
              onShowTechnical={() => set({ view: "analysis" })}
            />
          ) : (
            <Probe
              probe={probe}
              loading={probing}
              onClose={() => { set({ probe: null, panel: "layers" }); setProbe(null); }}
            />
          )
        ) : (
          <SidePanel state={state} loading={loading} />
        )}
      </PanelShell>

      {/* --------------------------------------------------------- timeline */}
      <div
        style={{
          position: "absolute",
          left: compact ? 14 : (leftOpen ? LEFT_W + 26 : 60),
          right: compact ? 14 : (rightOpen ? RIGHT_W + 26 : 60),
          bottom: 40, zIndex: 20, pointerEvents: "none",
          transition: "left var(--t) var(--ease-out), right var(--t) var(--ease-out)",
        }}
      >
        <div className="glass" style={{ pointerEvents: "auto", padding: "10px 14px 12px" }}>
          <TimeScrubber track={track} />
          {/* The dominant hazard laid out along the same axis. In Impact Mode
              it is the point of the timeline, so it is always shown; in
              Analysis Mode it is context and stays folded to one strip. */}
          {track && track.points.length > 1 && (
            <div style={{ marginTop: 9 }}>
              <ThreatStrip
                timeline={hazardTl}
                t0={new Date(track.points[0].valid_time).getTime()}
                t1={new Date(track.points[track.points.length - 1].valid_time).getTime()}
                at={store.at}
                onSeek={(iso) => set({ at: iso, playing: false })}
                height={store.view === "impact" ? 18 : 13}
              />
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------ impact cards
          Only in Impact Mode, and stacked so the leading hazard is highest
          and nearest the eye. */}
      {store.view === "impact" && (
        <div
          className="fade"
          style={{
            position: "absolute",
            left: compact ? 14 : (leftOpen ? LEFT_W + 26 : 58),
            top: "calc(var(--chrome-h) + 58px)",
            bottom: 156,
            zIndex: 18,
            display: "flex", flexDirection: "column", gap: 10,
            pointerEvents: "none",
            overflowY: "auto", overflowX: "hidden",
            transition: "left var(--t) var(--ease-out)",
          }}
        >
          <div style={{ pointerEvents: "auto" }}>
            <ThreatCard
              hazard={hazard}
              loading={!hazard && !!store.stormId}
              shift={changes?.hazard_shift
                ? { from: changes.hazard_shift.from.label,
                    to: changes.hazard_shift.to.label }
                : null}
              compact={compact}
            />
          </div>
          <div style={{ pointerEvents: "auto" }}>
            <ChangeCard changes={changes} compact={compact} />
          </div>
          <div style={{ pointerEvents: "auto" }}>
            <ScenarioControl
              value={store.scenarioKm}
              onChange={(km) => set({ scenarioKm: km })}
              compact={compact}
            />
          </div>
        </div>
      )}

      {/* ------------------------------------------------ storm overview
          Shown whenever more than the selected storm is on the map, and
          available as a scope switch at all times. */}
      <div
        style={{
          position: "absolute",
          right: compact ? 14 : (rightOpen ? RIGHT_W + 26 : 60),
          top: "calc(var(--chrome-h) + 58px)",
          zIndex: 18,
          transition: "right var(--t) var(--ease-out)",
        }}
      >
        <StormOverview
          storms={storms}
          scope={store.scope}
          selected={store.stormId}
          compared={compared}
          onScope={(scope) => set({ scope })}
          onSelect={(id) => {
            set({ stormId: id, at: null, probe: null });
            setProbe(null);
            setImpact(null);
          }}
          onToggleCompare={(id) =>
            setCompared((prev) => prev.includes(id)
              ? prev.filter((x) => x !== id)
              : [...prev, id])}
          compact={compact}
        />
      </div>

      {/* --------------------------------------------------------- legend */}
      <div
        style={{
          position: "absolute",
          right: compact ? 14 : (rightOpen ? RIGHT_W + 26 : 60),
          bottom: 158,
          zIndex: 19,
          transition: "right var(--t) var(--ease-out)",
        }}
      >
        <MapLegend startOpen={!compact && store.view === "analysis"} />
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
