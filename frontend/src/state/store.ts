/* Explorer view state.
 *
 * The acceptance criterion is specific: zoom, pan, opacity, layer order, storm
 * selection, time and mode are all encoded in the URL, and pasting that URL
 * into a fresh browser reproduces the identical view. So the entire store is
 * built to be serialisable, and every field that affects what is on screen lives
 * in `ViewState` rather than in component state.
 *
 * That requirement is not only about sharing a finding. It is what makes a
 * scripted demo reliable: each step of the run is a URL, so a step cannot land
 * in the wrong state because a click was missed.
 *
 * The uncertainty rule is enforced here as well as in the manifest. `toggleLayer`
 * refuses to enable a class D layer whose companion uncertainty layer is not
 * available, and returns the reason so the UI can say why rather than appearing
 * broken. Making it impossible in the store rather than merely discouraged in
 * the panel is the difference the specification asks for.
 */

import { create } from "zustand";
import type { Layer, Manifest, Mode } from "../api/types";

export interface ViewState {
  mode: Mode;
  stormId: string | null;
  /** Scrubber position, ISO. Every layer resolves its own granule at or before. */
  at: string | null;
  active: string[];
  opacity: Record<string, number>;
  /** Explicit order within a class, so drag-to-reorder survives a reload. */
  order: string[];
  lon: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
  follow: boolean;
  speed: 1 | 5 | 20;
  playing: boolean;
  probe: { lat: number; lon: number } | null;
  panel: "layers" | "legend" | "probe";

  /* ---- Impact Mode.
   *
   * `view` is the product's main division. Analysis answers what the storm is
   * doing; Impact answers what that means on the ground. They share the map,
   * the storm and the clock, so switching is a change of question rather than
   * a change of page.
   */
  view: "analysis" | "impact";

  /** Which storms are drawn. `one` is the detailed single-storm workspace;
   *  `recent` and `all` draw the overview. */
  scope: "one" | "recent" | "all";

  /** Scenario corridor half-width in km, or null when off. This is an
   *  illustrative uncertainty band, not a model output, and every surface that
   *  renders it says so. */
  scenarioKm: number | null;
}

interface Store extends ViewState {
  manifest: Manifest | null;
  layersById: Record<string, Layer>;
  blocked: { layerId: string; reason: string } | null;

  setManifest: (m: Manifest) => void;
  set: (patch: Partial<ViewState>) => void;
  toggleLayer: (id: string) => void;
  setOpacity: (id: string, v: number) => void;
  moveLayer: (id: string, dir: -1 | 1) => void;
  clearBlocked: () => void;
  applyUrl: (search: string) => void;
  toUrl: () => string;
  visibleOrdered: () => Layer[];
}

export const DEFAULT_VIEW: ViewState = {
  mode: "replay",
  stormId: null,
  at: null,
  active: [],
  opacity: {},
  order: [],
  lon: 78,
  lat: 15,
  zoom: 4.1,
  bearing: 0,
  pitch: 0,
  /* Follow is on by default, which reverses an earlier decision.
     The argument against it — locking the viewport to a moving centre is
     disorienting — holds for a basin-wide map where the geography is the
     context. It does not hold here: the imagery is a 1000 km storm-centred
     cube, so scrubbing without follow walks the only data on the map off the
     screen within a few steps and leaves the viewer looking at an empty
     ocean. The control is one click away for anyone who wants the fixed
     frame. */
  follow: true,
  speed: 1,
  playing: false,
  probe: null,
  panel: "layers",
  view: "analysis",
  scope: "one",
  scenarioKm: null,
};

export const useStore = create<Store>((setState, getState) => ({
  ...DEFAULT_VIEW,
  manifest: null,
  layersById: {},
  blocked: null,

  setManifest: (m) => {
    const byId: Record<string, Layer> = {};
    for (const l of m.layers) byId[l.id] = l;
    const s = getState();
    // Defaults only apply on a first load. A URL that already named its layers
    // must win, or a shared permalink would silently gain the default set.
    const active = s.active.length
      ? s.active
      : m.layers.filter((l) => l.default_on).map((l) => l.id);
    const opacity = { ...s.opacity };
    for (const l of m.layers) if (!(l.id in opacity)) opacity[l.id] = l.default_opacity;
    setState({
      manifest: m,
      layersById: byId,
      active,
      opacity,
      order: s.order.length ? s.order : m.layers.map((l) => l.id),
    });
  },

  set: (patch) => setState(patch),

  toggleLayer: (id) => {
    const s = getState();
    const layer = s.layersById[id];
    if (!layer) return;

    if (s.active.includes(id)) {
      setState({ active: s.active.filter((x) => x !== id), blocked: null });
      return;
    }

    // The rule that keeps the map honest. A derived field without a companion
    // uncertainty representation is a machine for producing confident-looking
    // pictures of things the model does not know, so enabling one is refused
    // here rather than discouraged in the panel.
    if (layer.class === "D") {
      const companionId = layer.uncertainty_layer;
      const companion = companionId ? s.layersById[companionId] : undefined;
      if (!companionId || !companion) {
        setState({
          blocked: {
            layerId: id,
            reason:
              `${layer.label} is a TRINETRA-derived field and its companion ` +
              `uncertainty layer is not available, so it cannot be displayed. ` +
              `No derived layer ships without an uncertainty representation.`,
          },
        });
        return;
      }
      // Turning on a derived layer turns on its companion. Self-referential
      // companions (a cone that is its own uncertainty) need no second layer.
      const next = new Set([...s.active, id]);
      if (companionId !== id) next.add(companionId);
      setState({ active: [...next], blocked: null });
      return;
    }

    setState({ active: [...s.active, id], blocked: null });
  },

  setOpacity: (id, v) =>
    setState({ opacity: { ...getState().opacity, [id]: Math.max(0, Math.min(1, v)) } }),

  moveLayer: (id, dir) => {
    const s = getState();
    const layer = s.layersById[id];
    if (!layer) return;
    // Reordering is allowed within a class only. Class ordering is fixed:
    // boundaries on top, then derived, then reanalysis, then observed. Letting
    // an observed raster sit above a derived one would break the convention
    // the whole product rests on.
    const order = [...s.order];
    const peers = order.filter((x) => s.layersById[x]?.group === layer.group);
    const at = peers.indexOf(id);
    const swapWith = peers[at + dir];
    if (swapWith === undefined) return;
    const i = order.indexOf(id);
    const j = order.indexOf(swapWith);
    [order[i], order[j]] = [order[j], order[i]];
    setState({ order });
  },

  clearBlocked: () => setState({ blocked: null }),

  applyUrl: (search) => {
    const p = new URLSearchParams(search);
    const patch: Partial<ViewState> = {};
    const numOf = (k: string) => {
      const v = p.get(k);
      if (v === null) return undefined;
      const n = Number(v);
      return isFinite(n) ? n : undefined;
    };

    if (p.get("mode") === "live" || p.get("mode") === "replay") {
      patch.mode = p.get("mode") as Mode;
    }
    if (p.get("storm")) patch.stormId = p.get("storm");
    if (p.get("at")) patch.at = p.get("at");
    if (p.get("layers")) patch.active = p.get("layers")!.split(",").filter(Boolean);
    if (p.get("order")) patch.order = p.get("order")!.split(",").filter(Boolean);

    // Opacity is packed as id:value pairs, and only non-default values are
    // written, which keeps a shared URL readable.
    if (p.get("op")) {
      const op: Record<string, number> = {};
      for (const part of p.get("op")!.split(",")) {
        const [id, v] = part.split(":");
        const n = Number(v);
        if (id && isFinite(n)) op[id] = n;
      }
      patch.opacity = { ...getState().opacity, ...op };
    }

    const lon = numOf("lon"), lat = numOf("lat"), zoom = numOf("z");
    if (lon !== undefined) patch.lon = lon;
    if (lat !== undefined) patch.lat = lat;
    if (zoom !== undefined) patch.zoom = zoom;
    const bearing = numOf("b"), pitch = numOf("p");
    if (bearing !== undefined) patch.bearing = bearing;
    if (pitch !== undefined) patch.pitch = pitch;

    if (p.get("follow")) patch.follow = p.get("follow") === "1";
    if (p.get("view") === "impact" || p.get("view") === "analysis") {
      patch.view = p.get("view") as ViewState["view"];
    }
    const sc = p.get("scope");
    if (sc === "one" || sc === "recent" || sc === "all") patch.scope = sc;
    const scen = numOf("scenario");
    if (scen !== undefined) patch.scenarioKm = scen > 0 ? scen : null;
    const sp = numOf("speed");
    if (sp === 1 || sp === 5 || sp === 20) patch.speed = sp;

    const probeLat = numOf("plat"), probeLon = numOf("plon");
    if (probeLat !== undefined && probeLon !== undefined) {
      patch.probe = { lat: probeLat, lon: probeLon };
    }
    setState(patch);
  },

  toUrl: () => {
    const s = getState();
    const p = new URLSearchParams();
    p.set("mode", s.mode);
    if (s.stormId) p.set("storm", s.stormId);
    if (s.at) p.set("at", s.at);
    if (s.active.length) p.set("layers", s.active.join(","));

    // Only opacities that differ from the manifest default are serialised.
    const op = Object.entries(s.opacity)
      .filter(([id, v]) => {
        const d = s.layersById[id]?.default_opacity ?? 1;
        return s.active.includes(id) && Math.abs(v - d) > 0.005;
      })
      .map(([id, v]) => `${id}:${v.toFixed(2)}`);
    if (op.length) p.set("op", op.join(","));

    // Order is only serialised when it has actually been changed from the
    // manifest order, so a default URL stays short.
    const manifestOrder = s.manifest?.layers.map((l) => l.id).join(",");
    if (manifestOrder && s.order.join(",") !== manifestOrder) {
      p.set("order", s.order.join(","));
    }

    p.set("lon", s.lon.toFixed(3));
    p.set("lat", s.lat.toFixed(3));
    p.set("z", s.zoom.toFixed(2));
    if (Math.abs(s.bearing) > 0.5) p.set("b", s.bearing.toFixed(1));
    if (Math.abs(s.pitch) > 0.5) p.set("p", s.pitch.toFixed(1));
    // Serialised whenever it differs from the default, in either direction.
    // Writing it only when true was correct while the default was false; with
    // the default on, a user who turned follow off would get it back on the
    // next reload, and the permalink would no longer reproduce the view.
    if (s.follow !== DEFAULT_VIEW.follow) p.set("follow", s.follow ? "1" : "0");
    // Impact Mode, the storm scope and the scenario width. Only written
    // when they differ from the default, so an ordinary Analysis link
    // stays short, and always written when they do, so a demo step is
    // still one link.
    if (s.view !== DEFAULT_VIEW.view) p.set("view", s.view);
    if (s.scope !== DEFAULT_VIEW.scope) p.set("scope", s.scope);
    if (s.scenarioKm) p.set("scenario", String(s.scenarioKm));
    if (s.speed !== 1) p.set("speed", String(s.speed));
    if (s.probe) {
      p.set("plat", s.probe.lat.toFixed(4));
      p.set("plon", s.probe.lon.toFixed(4));
    }
    return p.toString();
  },

  visibleOrdered: () => {
    const s = getState();
    // Class order is fixed and not user-editable. Within a group, the user's
    // order applies.
    const groupRank: Record<string, number> = {
      observed: 0, reanalysis: 1, derived: 2, boundaries: 3,
    };
    return s.active
      .map((id) => s.layersById[id])
      .filter((l): l is Layer => Boolean(l))
      .sort((a, b) => {
        const g = (groupRank[a.group] ?? 0) - (groupRank[b.group] ?? 0);
        if (g !== 0) return g;
        return s.order.indexOf(a.id) - s.order.indexOf(b.id);
      });
  },
}));

/** True when any derived layer is on. Drives the persistent map watermark. */
export function anyDerivedActive(): boolean {
  const s = useStore.getState();
  return s.active.some((id) => s.layersById[id]?.class === "D");
}
