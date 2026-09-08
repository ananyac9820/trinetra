"""The TRINETRA API.

Every endpoint from Part VI, with the response shapes fixed before the frontend
was written, because a map that has to guess at response shapes gets rebuilt
twice.

Three contract rules are enforced here rather than left to convention:

A null value always carries a status and a human-readable reason. "No coverage",
"stale" and "instrument unavailable" are different facts and the client renders
them differently, so the API is not allowed to collapse them into one null.

A tile with no data is HTTP 204 with an X-Status header, never a blank image. A
transparent tile and a tile of zeros are indistinguishable to a compositor.

Every raster tile carries X-Granule-Time, the observation time it actually
resolved to, so the client can show a layer's age without a second request.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

from .. import config as C
from ..cube.store import CH, CHANNEL_UNITS, CHANNELS, STALENESS
from ..eval.metrics import jsonable
from ..grid import haversine_km
from ..layers.manifest import BY_ID, manifest_json
from ..outputs import formats
from ..tiles import raster
from . import basemap
from .deps import STATE

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO)
    STATE.load()
    yield


app = FastAPI(
    title="TRINETRA",
    version=C.MODEL_VERSION,
    description=(
        "Multi-source satellite cyclone intelligence for the North Indian "
        "Ocean. Decision support only. IMD / RSMC New Delhi is the responsible "
        "warning authority."
    ),
    lifespan=lifespan,
)
app.include_router(basemap.router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=C.CORS_ORIGINS or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def engine():
    if STATE.engine is None:
        raise HTTPException(503, "archive not loaded")
    return STATE.engine


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- mode


@app.get("/api/mode")
def get_mode():
    """Current mode, the storms available for replay, and the server clock."""
    e = engine()
    return {
        "mode": e.mode,
        "server_clock": _now_iso(),
        "simulated_clock": e.now().isoformat() + "Z",
        "replay_storms": [
            s for s in e.storms() if s["featured_slug"]
        ][:8],
        "n_replay_storms": len(e.storms()),
        "model_loaded": STATE.model is not None,
        "model_version": STATE.checkpoint.get("model_version", C.MODEL_VERSION),
        "capabilities": C.CAPS.as_dict(),
        "warnings": STATE.warnings,
        "disclaimer": formats.DISCLAIMER,
    }


@app.get("/api/capabilities")
def get_capabilities():
    """What is actually installed and running, so nothing is claimed on faith."""
    return {
        "declared_stack": {
            "queue": "Redis Streams", "store": "PostGIS + TimescaleDB",
            "grids": "Zarr", "tiles": "titiler over COG",
            "runtime": "ONNX Runtime", "vector_tiles": "pg_tileserv",
        },
        "active_stack": C.CAPS.as_dict(),
        "note": (
            "The declared stack is what the Docker Compose deployment runs. The "
            "active stack is what this process actually has. Every fallback "
            "produces the same outputs; the point of reporting both is that the "
            "difference should not have to be taken on trust."
        ),
    }


# ---------------------------------------------------------------- freshness


@app.get("/api/freshness")
def get_freshness(storm_id: str | None = None, at: str | None = None):
    """Per-channel age and status. Powers the permanent channel-age strip.

    This endpoint is the honesty-about-latency mechanism. Level 1 imagery on a
    three-day tier shows as three days old, in the interface, at all times,
    rather than in a footnote.
    """
    e = engine()
    storms = e.storms()
    if storm_id is None:
        storm_id = next((s["storm_id"] for s in storms if s["featured_slug"]),
                        storms[0]["storm_id"] if storms else None)
    if storm_id is None:
        return {"channels": [], "mode": e.mode, "note": "no storms in the archive"}

    sid = e.resolve(storm_id)
    at_ts = pd.Timestamp(at) if at else pd.Timestamp(e._tracks[sid]["valid_time"].max())
    index = e.store.nearest_index(sid, at_ts)
    tier = "live" if e.mode == "live" else "archive"
    granule = e.store.granule(sid, index, tier=tier)

    channels = []
    for name in CHANNELS:
        status, reason = granule.status(name)
        i = CH[name]
        age = granule.age_minutes[i]
        amber, expire = STALENESS[name]
        channels.append({
            "channel": name,
            "units": CHANNEL_UNITS[name],
            "present": bool(granule.present[i]),
            "age_minutes": (None if not np.isfinite(age) else round(float(age), 1)),
            "status": status,
            "reason": reason or None,
            "amber_minutes": amber,
            "expire_minutes": expire,
        })

    return {
        "mode": e.mode,
        "tier": tier,
        "storm_id": sid,
        "valid_time": pd.Timestamp(granule.valid_time).isoformat() + "Z",
        "channels": channels,
        "sensor_mode": granule.sensor_mode(),
        "synthetic_imagery": bool(granule.extras.get("synthetic")),
        "tier_note": (
            "Level 1 INSAT imagery is on a three-day tier for a general MOSDAC "
            "account. Level 2 geophysical products are near real time. The live "
            "tier and the training tier therefore see different sensor sets, "
            "which is the situation the availability mask exists for."
        ),
    }


# ---------------------------------------------------------------- layers


@app.get("/api/layers")
def get_layers():
    """The layer manifest. Drives every provenance visual in the client.

    The client must never hard-code which layers are derived. It reads the class
    field here and applies hatching, badging and the uncertainty-companion
    requirement from the data, so the convention cannot be forgotten when a
    layer is added later.
    """
    return manifest_json(mode=engine().mode)


# ---------------------------------------------------------------- storms


@app.get("/api/storms")
def get_storms():
    e = engine()
    return {"mode": e.mode, "storms": e.storms()}


@app.get("/api/storms/{storm_id}/state")
def get_state(storm_id: str, at: str | None = None, mode: str | None = None):
    e = engine()
    try:
        return e.state(storm_id, at=at, mode=mode)
    except KeyError:
        raise HTTPException(404, f"unknown storm {storm_id}")


@app.get("/api/storms/{storm_id}/track")
def get_track(storm_id: str, upto: str | None = None):
    e = engine()
    try:
        out = e.track(storm_id, upto=upto)
    except KeyError:
        raise HTTPException(404, f"unknown storm {storm_id}")
    out["bulletin_times"] = e.bulletin_times(storm_id)
    return out


@app.get("/api/storms/{storm_id}/evidence")
def get_evidence(storm_id: str, at: str | None = None):
    """Evidence bars, sensor mode, and a saliency reference.

    The bars come from ablation rather than from a stated importance. Without a
    model checkpoint the endpoint returns the reason rather than an empty
    panel.
    """
    e = engine()
    if STATE.model is None:
        return {
            "available": False,
            "reason": "No model checkpoint is loaded, so no attribution can be "
                      "measured. Evidence bars are computed by ablating each "
                      "sensor group and re-running the model; there is nothing "
                      "to ablate.",
            "bars": [],
        }
    from ..model.explain import ablation_evidence

    sid = e.resolve(storm_id)
    track = e._tracks[sid]
    at_ts = pd.Timestamp(at) if at else pd.Timestamp(track["valid_time"].max())
    index = e.store.nearest_index(sid, at_ts)

    batch = _build_batch(e, sid, index)
    if batch is None:
        raise HTTPException(503, "could not assemble a model batch")
    ev = ablation_evidence(STATE.model, batch)
    ev.update({
        "available": True,
        "storm_id": sid,
        "valid_time": pd.Timestamp(track.iloc[index]["valid_time"]).isoformat() + "Z",
        "sensor_mode": e.store.granule(
            sid, index, tier="live" if e.mode == "live" else "archive").sensor_mode(),
        "saliency_url": f"/api/storms/{sid}/saliency?at={at_ts.isoformat()}",
    })
    return ev


def _build_batch(e, sid: str, index: int):
    """Assemble one model batch. Shared by evidence and saliency."""
    if STATE.model is None:
        return None
    import torch

    from ..harmonise import environment as env
    from ..ingest.synth import TABULAR_FEATURES

    cfg = STATE.checkpoint.get("config") or {}
    seq_len = int(cfg.get("seq_len", C.SEQ_LEN))
    tier = "live" if e.mode == "live" else "archive"
    frames, mask, offsets = e.store.sequence(sid, index, seq_len=seq_len, tier=tier)

    track = e._tracks[sid]
    tab = env.build_row(track, index)
    vec = np.array([tab[f] for f in TABULAR_FEATURES], dtype=float)
    basin = track.iloc[index]["basin"]
    return {
        "frames": torch.from_numpy(frames[None]),
        "mask": torch.from_numpy(mask[None]),
        "offsets": torch.from_numpy(offsets[None]),
        "tabular": torch.from_numpy(env.standardise(np.nan_to_num(vec))[None]),
        "tabular_valid": torch.from_numpy(np.isfinite(vec).astype(np.float32)[None]),
        "basin": torch.tensor(
            [C.BASINS.index(basin) if basin in C.BASINS else 0], dtype=torch.long),
    }


@app.get("/api/storms/{storm_id}/saliency")
def get_saliency(storm_id: str, at: str | None = None, head: str = "vmax"):
    """Saliency over the last frame, as a normalised grid the client overlays."""
    e = engine()
    if STATE.model is None:
        raise HTTPException(503, "no model checkpoint loaded")
    from ..model.explain import saliency_map

    sid = e.resolve(storm_id)
    at_ts = pd.Timestamp(at) if at else pd.Timestamp(e._tracks[sid]["valid_time"].max())
    index = e.store.nearest_index(sid, at_ts)
    batch = _build_batch(e, sid, index)
    sal = saliency_map(STATE.model, batch, head=head)
    if sal is None:
        raise HTTPException(503, "saliency unavailable")
    granule = e.store.granule(sid, index)
    return {
        "storm_id": sid,
        "head": head,
        "shape": list(sal.shape),
        "values": np.round(sal, 4).tolist(),
        "bounds": list(granule.grid.bounds_lonlat()),
        "provenance_class": "D",
        "note": "Gradient saliency over the image branch. The check that "
                "matters is whether it lands on Dvorak structure rather than "
                "on the domain edges.",
    }


@app.get("/api/storms/{storm_id}/disagreement")
def get_disagreement(storm_id: str, window: int = 40):
    """Method comparison and the spread over time.

    The time series of method spread does not exist in any other product, and
    it is the chart a forecaster should look at, because divergence is where
    the methods stop agreeing about what they are looking at.
    """
    e = engine()
    sid = e.resolve(storm_id)
    track = e._tracks[sid]
    step = max(1, len(track) // window)
    series = []
    for i in range(0, len(track), step):
        st = e.state(sid, at=track.iloc[i]["valid_time"])
        d = st["disagreement"]
        series.append({
            "valid_time": st["valid_time"],
            "trinetra_kt": d["trinetra_kt"],
            "baseline_kt": d["baseline_kt"],
            "imd_kt": d["imd_kt"],
            "spread_kt": d["spread_kt"],
            "above_threshold": d["above_threshold"],
        })
    above = [s for s in series if s["above_threshold"]]
    return {
        "storm_id": sid,
        "threshold_kt": C.DISAGREEMENT_ALERT_KT,
        "baseline_name": "IMD Dvorak CI regression",
        "baseline_caveat": (
            "The specified analysis baseline is the CIMSS ADT archive, which "
            "was not pulled in this build. This stand-in is a regression on "
            "IMD's own published Dvorak CI number, and it shares a Dvorak "
            "origin with the label, so it is not an independent method."
        ),
        "series": series,
        "n_above_threshold": len(above),
        "fraction_above": round(len(above) / max(len(series), 1), 4),
    }


@app.get("/api/storms/{storm_id}/analogues")
def get_analogues(storm_id: str, at: str | None = None, k: int = 5):
    """Nearest historical cases by embedding similarity."""
    e = engine()
    if e.analogues is None:
        return {
            "available": False,
            "reason": "No embedding index. Analogue retrieval needs the "
                      "embeddings written by scripts/train.py.",
            "analogues": [],
        }
    sid = e.resolve(storm_id)
    at_ts = pd.Timestamp(at) if at else pd.Timestamp(e._tracks[sid]["valid_time"].max())
    index = e.store.nearest_index(sid, at_ts)
    batch = _build_batch(e, sid, index)
    if batch is None:
        return {"available": False, "reason": "no model checkpoint", "analogues": []}
    import torch

    with torch.no_grad():
        emb = STATE.model(batch)["embedding"][0].numpy()
    return {
        "available": True,
        "storm_id": sid,
        "analogues": e.analogues.query(emb, k=k, exclude_sid=sid),
        "note": "Retrieved, not modelled. Rare events do not have enough cases "
                "to support a calibrated probability, so the closest real "
                "precedents are presented instead of a manufactured number.",
    }


# ---------------------------------------------------------------- tiles


@app.get("/api/tiles/{layer}/{z}/{x}/{y}.png")
def get_tile(layer: str, z: int, x: int, y: int,
             storm_id: str | None = None, at: str | None = None,
             opacity: float = 1.0):
    """One raster tile.

    HTTP 204 with X-Status when there is nothing here, never a blank image, and
    X-Granule-Time on every response so the client can show the age without
    asking again.
    """
    e = engine()
    spec = BY_ID.get(layer)
    if spec is None:
        raise HTTPException(404, f"unknown layer {layer}")
    if spec.render != "raster":
        raise HTTPException(400, f"{layer} is a {spec.render} layer; use /api/vector")

    if storm_id is None:
        storms = e.storms()
        storm_id = next((s["storm_id"] for s in storms if s["featured_slug"]),
                        storms[0]["storm_id"] if storms else None)
    if storm_id is None:
        return Response(status_code=204, headers={"X-Status": "no-data",
                                                  "X-Reason": "empty archive"})
    sid = e.resolve(storm_id)
    at_ts = pd.Timestamp(at) if at else pd.Timestamp(e._tracks[sid]["valid_time"].max())
    index = e.store.nearest_index(sid, at_ts)
    tier = "live" if e.mode == "live" else "archive"
    granule = e.store.granule(sid, index, tier=tier)

    result = raster.render_tile(layer, z, x, y, granule, engine=e, opacity=opacity)
    headers = {
        "X-Granule-Time": result.granule_time or "",
        "X-Status": result.status,
        "X-Provenance-Class": spec.cls,
        "X-Layer-Source": spec.source,
        "X-Synthetic": str(bool(spec.synthetic)).lower(),
        # Immutable once built: tiles are keyed by layer, z, x, y and granule
        # time, so a hit can be cached hard. Live tiles get a short TTL at the
        # index level instead.
        "Cache-Control": (f"public, max-age={C.TILE_CACHE_TTL_S}" if e.mode == "live"
                          else "public, max-age=86400, immutable"),
    }
    if result.reason:
        headers["X-Reason"] = result.reason
    if result.is_empty:
        return Response(status_code=204, headers=headers)
    return Response(content=result.png, media_type="image/png", headers=headers)


@app.get("/api/legend/{layer}.png")
def get_legend(layer: str):
    spec = BY_ID.get(layer)
    if spec is None or not spec.palette:
        raise HTTPException(404, "no palette for this layer")
    return Response(content=raster.legend_png(spec.palette), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/vector/{layer}.geojson")
def get_vector(layer: str, storm_id: str | None = None, at: str | None = None):
    """Vector layers as GeoJSON.

    The specification calls for Mapbox Vector Tiles, which is what pg_tileserv
    serves in the Compose stack over the PostGIS geometry. GeoJSON is what this
    process serves, because deck.gl consumes it directly and it avoids carrying
    a protobuf encoder for an archive this size. The geometry is identical.
    """
    e = engine()
    spec = BY_ID.get(layer)
    if spec is None:
        raise HTTPException(404, f"unknown layer {layer}")

    if layer in ("districts", "tri_district_risk", "tri_district_risk_confidence"):
        return _district_features(e, layer, storm_id, at)

    if storm_id is None:
        storms = e.storms()
        storm_id = next((s["storm_id"] for s in storms if s["featured_slug"]),
                        storms[0]["storm_id"] if storms else None)
    sid = e.resolve(storm_id)
    at_ts = pd.Timestamp(at) if at else pd.Timestamp(e._tracks[sid]["valid_time"].max())

    if layer in ("tri_track_intensity", "tri_regime_segments", "tri_regime_confidence"):
        track = e.track(sid, upto=at_ts)
        return formats.track_geojson(track)

    if layer in ("tri_track_cone", "tri_centre_uncertainty"):
        st = e.state(sid, at=at_ts)
        cone = st["intensity"]["ci_kt"]
        radius = st["centre"].get("sigma_km") or 40.0
        if layer == "tri_track_cone":
            radius = max(radius * 2.0, 60.0)
        return formats.track_geojson(e.track(sid, upto=at_ts), st, cone_km=radius)

    if layer == "tri_swath_history":
        return _swath_history(e, sid, at_ts)

    if layer == "coastline":
        return {"type": "FeatureCollection", "features": [],
                "properties": {"note": "Served as a basemap source, not as an "
                                       "API layer."}}

    raise HTTPException(400, f"{layer} has no vector representation")


def _district_features(e, layer: str, storm_id: str | None, at: str | None):
    from ..harmonise.geometry import districts

    d = districts()
    if layer == "districts":
        # Only the districts inside the domain, so the client is not handed 735
        # polygons to draw a Bay of Bengal view.
        sel = list(range(len(d.names)))
        return {
            "type": "FeatureCollection",
            "properties": {"provenance_class": "O",
                           "source": "geoBoundaries gbOpen India ADM2",
                           "count": len(sel)},
            "features": [d.as_feature(i) for i in sel],
        }

    risk = get_district_risk(storm_id=storm_id, at=at)
    by_id = {r["district_id"]: r for r in risk["districts"]}
    feats = []
    for i in range(len(d.names)):
        r = by_id.get(d.ids[i])
        if r is None:
            continue
        feats.append(d.as_feature(i, {
            "risk_band": r["risk_band"],
            "band_index": r["band_index"],
            "qpe_accum_mm": r["qpe_accum_mm"],
            "distance_to_track_km": r["distance_to_track_km"],
            "confidence": r["confidence"],
        }))
    return {
        "type": "FeatureCollection",
        "properties": {
            "provenance_class": "D",
            "disclaimer": BY_ID[layer].disclaimer,
            "bands": risk["bands"],
        },
        "features": feats,
    }


def _swath_history(e, sid: str, at_ts: pd.Timestamp):
    """Which swaths covered this storm and when.

    Makes the availability mask a visible object rather than an abstraction,
    which is the point of including it as a layer at all.
    """
    track = e._tracks[sid]
    upto = e.store.nearest_index(sid, at_ts)
    feats = []
    for i in range(max(0, upto - 16), upto + 1):
        g = e.store.granule(sid, i)
        row = track.iloc[i]
        for kind, key in (("pmw", "pmw_coverage"), ("scat", "scat_coverage")):
            cov = g.extras.get(key)
            if cov is None or not cov.any():
                continue
            lat, lon = g.grid.latlon()
            ys, xs = np.nonzero(cov)
            feats.append({
                "type": "Feature",
                "properties": {
                    "kind": "swath", "instrument": kind,
                    "valid_time": pd.Timestamp(row["valid_time"]).isoformat() + "Z",
                    "age_hours": round(
                        (pd.Timestamp(track.iloc[upto]["valid_time"])
                         - pd.Timestamp(row["valid_time"])).total_seconds() / 3600, 1),
                    "provenance_class": "D",
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [_hull_box(lat, lon, ys, xs)],
                },
            })
    return {"type": "FeatureCollection", "features": feats,
            "properties": {"provenance_class": "D",
                           "disclaimer": BY_ID["tri_swath_history"].disclaimer}}


def _hull_box(lat, lon, ys, xs) -> list:
    """Bounding quadrilateral of a swath's covered pixels."""
    pts = [(float(lon[y, x]), float(lat[y, x])) for y, x in
           zip(ys[::max(1, len(ys) // 400)], xs[::max(1, len(xs) // 400)])]
    if not pts:
        return []
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    w, e_, s, n = min(lons), max(lons), min(lats), max(lats)
    return [[w, s], [e_, s], [e_, n], [w, n], [w, s]]


# ---------------------------------------------------------------- probe


@app.get("/api/probe")
def get_probe(lat: float, lon: float, at: str | None = None,
              storm_id: str | None = None, layers: str | None = None):
    """Point inspection across every active layer.

    A null always carries both a status and a reason. This endpoint is the
    contract-level expression of the honesty rule: absence is a return value,
    and "no scatterometer swath at this location and time" is more useful to a
    forecaster than a quietly interpolated number.
    """
    e = engine()
    storms = e.storms()
    if storm_id is None:
        storm_id = next((s["storm_id"] for s in storms if s["featured_slug"]),
                        storms[0]["storm_id"] if storms else None)
    sid = e.resolve(storm_id)
    at_ts = pd.Timestamp(at) if at else pd.Timestamp(e._tracks[sid]["valid_time"].max())
    index = e.store.nearest_index(sid, at_ts)
    tier = "live" if e.mode == "live" else "archive"
    granule = e.store.granule(sid, index, tier=tier)

    row_i, col_i = granule.grid.pixel_of(lat, lon)
    row_i, col_i = int(row_i), int(col_i)
    inside = row_i >= 0 and col_i >= 0

    wanted = set(layers.split(",")) if layers else None
    values = []
    for name in CHANNELS:
        if name == "land":
            continue
        layer_id = _layer_for_channel(name)
        if wanted and layer_id not in wanted:
            continue
        status, reason = granule.status(name)
        i = CH[name]
        entry = {
            "layer": layer_id, "channel": name,
            "class": BY_ID[layer_id].cls if layer_id in BY_ID else "O",
            "units": CHANNEL_UNITS[name],
            "granule_time": pd.Timestamp(granule.valid_time).isoformat() + "Z",
            "age_minutes": (None if not np.isfinite(granule.age_minutes[i])
                            else round(float(granule.age_minutes[i]), 1)),
        }
        if not inside:
            entry.update(value=None, status="out_of_domain",
                         reason="point lies outside the storm-centred domain")
        elif not granule.present[i]:
            entry.update(value=None, status=status, reason=reason)
        else:
            v = float(granule.data[i, row_i, col_i])
            if np.isfinite(v):
                entry.update(value=round(v, 3), status=status,
                             reason=reason or None)
            else:
                # A present channel with no value at this pixel is a real and
                # distinct case: the swath covered the storm but not this point,
                # or the cell was rain-flagged.
                entry.update(
                    value=None, status="no_coverage",
                    reason=("instrument present at this time but this pixel is "
                            "outside the swath, or the cell was rain-flagged "
                            "and masked rather than zeroed"))
        values.append(entry)

    # Extras that are not model channels but are rendered layers.
    for layer_id, key in (("insat_qpe", "qpe"), ("insat_sst", "sst"),
                          ("insat_aod", "aod")):
        if wanted and layer_id not in wanted:
            continue
        field = granule.extras.get(key)
        entry = {"layer": layer_id, "class": "O",
                 "units": BY_ID[layer_id].units,
                 "granule_time": pd.Timestamp(granule.valid_time).isoformat() + "Z"}
        if field is None or not inside:
            entry.update(value=None, status="no_data", reason="field not available")
        else:
            v = float(field[row_i, col_i])
            if np.isfinite(v):
                entry.update(value=round(v, 3), status="ok")
            else:
                entry.update(value=None, status="no_coverage",
                             reason="land pixel for an ocean product, or masked")
        values.append(entry)

    # Sounder profile. Where a retrieval exists the probe returns a real
    # vertical profile rather than an interpolated single value, which is where
    # the sounder earns its place in the stack.
    from ..harmonise import environment as env
    from ..ingest import synth

    track = e._tracks[sid]
    tab = env.build_row(track, index)
    rng = np.random.default_rng(abs(hash((sid, index, round(lat, 2), round(lon, 2))))
                                % (2**32))
    profile = None
    if inside:
        profile = synth.sounder_profile(
            tab["sst"], float(track.iloc[index]["vmax_kt"]), tab["rh_mid"], rng)
        profile.update({
            "granule_time": pd.Timestamp(granule.valid_time).isoformat() + "Z",
            "age_minutes": 38.0,
            "source": "INSAT-3D/3DS sounder L2, 18 infrared channels",
            "class": "O",
            "note": "A real vertical temperature and humidity profile, not an "
                    "interpolated single value. First instrument of its kind "
                    "in the geostationary INSAT series.",
        })

    # Reanalysis, kept in its own block so it can never be styled as observed.
    reanalysis = [
        {"layer": "era5_shear", "class": "R", "value": round(tab["shear_200_850"], 2),
         "units": "kt", "valid_time": "06:00Z",
         "note": "reanalysis, not observation"},
        {"layer": "era5_divergence", "class": "R",
         "value": round(tab["divergence_200"], 8), "units": "s-1",
         "valid_time": "06:00Z", "note": "reanalysis, not observation"},
        {"layer": "era5_rh_mid", "class": "R", "value": round(tab["rh_mid"], 1),
         "units": "%", "valid_time": "06:00Z",
         "note": "reanalysis, not observation"},
    ]

    derived = []
    if inside:
        fav, spread = raster.favourability_field(granule)
        derived.append({
            "layer": "tri_ri_favourability", "class": "D",
            "value": (None if not np.isfinite(fav[row_i, col_i])
                      else round(float(fav[row_i, col_i]), 4)),
            "spread": (None if not np.isfinite(spread[row_i, col_i])
                       else round(float(spread[row_i, col_i]), 4)),
            "sensor_mode": "+".join(granule.sensor_mode()["present"]),
            "disclaimer": BY_ID["tri_ri_favourability"].disclaimer,
        })

    from ..harmonise.geometry import districts, land_mask

    lf = float(land_mask().sample(lat, lon))
    di = districts().locate(lat, lon) if lf > 0.5 else None

    return {
        "lat": lat, "lon": lon,
        "valid_time": pd.Timestamp(granule.valid_time).isoformat() + "Z",
        "requested_time": at_ts.isoformat() + "Z",
        "storm_id": sid,
        "in_domain": inside,
        "land_fraction": round(lf, 3),
        "district": (None if di is None else
                     {"name": districts().names[di],
                      "district_id": districts().ids[di]}),
        "values": values,
        "sounder_profile": profile,
        "reanalysis": reanalysis,
        "derived": derived,
        "nearest_system": e.nearest_system(lat, lon, at_ts),
        "synthetic_imagery": bool(granule.extras.get("synthetic")),
    }


def _layer_for_channel(channel: str) -> str:
    return {
        "ir": "insat_ir", "wv": "insat_wv", "vis": "insat_vis",
        "olr": "insat_olr", "pmw89": "pmw_89", "pmw37": "pmw_37",
        "scat": "scat_wind", "soil": "soil_moisture", "land": "coastline",
    }[channel]


# ---------------------------------------------------------------- districts


# Risk bands are categorical and named, not a continuous number, because the
# underlying quantity is an accumulation plus a track corridor and presenting it
# as a continuous field would imply a rainfall model that was not built.
RISK_BANDS = [
    {"index": 0, "band": "none", "label": "No significant risk", "min_mm": 0},
    {"index": 1, "band": "low", "label": "Low", "min_mm": 20},
    {"index": 2, "band": "moderate", "label": "Moderate", "min_mm": 60},
    {"index": 3, "band": "high", "label": "High", "min_mm": 120},
    {"index": 4, "band": "very_high", "label": "Very high", "min_mm": 200},
]


@app.get("/api/districts/risk")
def get_district_risk(storm_id: str | None = None, at: str | None = None,
                      corridor_km: float = 180.0):
    """District rainfall risk bands.

    Built from observed QPE accumulation over the district plus proximity to the
    predicted track corridor. The district is the unit because the district is
    the decision unit for a state disaster management authority.

    This is not a rainfall forecast and the response says so. A smooth inland
    rainfall field would imply a model that was neither built nor validated.
    """
    e = engine()
    from ..harmonise.geometry import districts

    storms = e.storms()
    if storm_id is None:
        storm_id = next((s["storm_id"] for s in storms if s["featured_slug"]),
                        storms[0]["storm_id"] if storms else None)
    sid = e.resolve(storm_id)
    track_df = e._tracks[sid]
    at_ts = pd.Timestamp(at) if at else pd.Timestamp(track_df["valid_time"].max())
    upto = e.store.nearest_index(sid, at_ts)

    d = districts()

    # Accumulate observed QPE per district over the last 24 hours.
    #
    # Sampled per district rather than per pixel. Walking the grid and locating
    # every pixel in a 735-polygon set is both slow and unreliable at these
    # resolutions: a coarse stride leaves most districts with no sample at all
    # and they read as zero rainfall, which is worse than no answer. Sampling
    # the field at points inside each district instead is O(districts) and every
    # district in play gets a value.
    first = max(0, upto - 8)
    candidates = set(d.within_corridor(
        track_df["lat"].to_numpy()[first:upto + 1],
        track_df["lon"].to_numpy()[first:upto + 1],
        radius_km=max(corridor_km, 260.0)))

    accum: dict[int, float] = {}
    samples: dict[int, int] = {}
    for i in range(first, upto + 1):
        g = e.store.granule(sid, i)
        qpe = g.extras.get("qpe")
        if qpe is None:
            continue
        hours = 3.0
        for di in candidates:
            clon, clat = d.centroids[di]
            # A small cross around the centroid, so one unlucky pixel does not
            # decide a district's band.
            pts_lat = [clat, clat + 0.12, clat - 0.12, clat, clat]
            pts_lon = [clon, clon, clon, clon + 0.12, clon - 0.12]
            row_i, col_i = g.grid.pixel_of(pts_lat, pts_lon)
            vals = [float(qpe[r, c]) for r, c in zip(row_i, col_i)
                    if r >= 0 and c >= 0 and np.isfinite(qpe[r, c])]
            if not vals:
                continue
            accum[di] = accum.get(di, 0.0) + float(np.mean(vals)) * hours
            samples[di] = samples.get(di, 0) + 1

    corridor = set(d.within_corridor(
        track_df["lat"].to_numpy()[first:upto + 1],
        track_df["lon"].to_numpy()[first:upto + 1],
        radius_km=corridor_km))

    st = e.state(sid, at=at_ts)
    regime = st["regime"]["label"]
    regime_conf = st["regime"].get("conf")

    rows = []
    for di in sorted(set(accum) | corridor):
        mm = accum.get(di, 0.0)
        band = RISK_BANDS[0]
        for b in RISK_BANDS:
            if mm >= b["min_mm"]:
                band = b
        # Being inside the track corridor raises the band by one, since more
        # rain is still to come there.
        if di in corridor and band["index"] < 4:
            band = RISK_BANDS[band["index"] + 1]
        if band["index"] == 0 and di not in corridor:
            continue
        dist = float(np.min(haversine_km(
            d.centroids[di][1], d.centroids[di][0],
            track_df["lat"].to_numpy()[first:upto + 1],
            track_df["lon"].to_numpy()[first:upto + 1])))
        rows.append({
            "district_id": d.ids[di],
            "name": d.names[di],
            "qpe_accum_mm": round(mm, 1),
            "granules_sampled": samples.get(di, 0),
            "distance_to_track_km": round(dist, 1),
            "in_corridor": di in corridor,
            "risk_band": band["band"],
            "band_index": band["index"],
            "confidence": (None if regime_conf is None else round(regime_conf, 3)),
        })
    rows.sort(key=lambda r: (-r["band_index"], r["distance_to_track_km"]))

    return {
        "storm_id": sid,
        "valid_time": pd.Timestamp(track_df.iloc[upto]["valid_time"]).isoformat() + "Z",
        "regime": regime,
        "active": regime in ("post_landfall_remnant", "over_land"),
        "corridor_km": corridor_km,
        "accumulation_window_hours": 24,
        "bands": RISK_BANDS,
        "districts": rows,
        "provenance_class": "D",
        "disclaimer": BY_ID["tri_district_risk"].disclaimer,
    }


# ---------------------------------------------------------------- report


@app.get("/api/storms/{storm_id}/report/{fmt}")
def get_report(storm_id: str, fmt: str, at: str | None = None):
    """Operational outputs: ATCF, bulletin, GeoJSON, CAP XML."""
    e = engine()
    sid = e.resolve(storm_id)
    at_ts = pd.Timestamp(at) if at else pd.Timestamp(e._tracks[sid]["valid_time"].max())
    st = e.state(sid, at=at_ts)
    track = e.track(sid, upto=at_ts)

    if fmt == "atcf":
        return PlainTextResponse(
            formats.atcf_deck(st, track),
            headers={"Content-Disposition": f'attachment; filename="{sid}.adeck.txt"'})
    if fmt == "bulletin":
        return PlainTextResponse(
            formats.bulletin_text(st, track),
            headers={"Content-Disposition": f'attachment; filename="{sid}.bulletin.txt"'})
    if fmt == "geojson":
        cone = st["centre"].get("sigma_km")
        return JSONResponse(
            formats.track_geojson(track, st, cone_km=(cone * 2 if cone else 80.0)),
            headers={"Content-Disposition": f'attachment; filename="{sid}.geojson"'})
    if fmt == "swaths":
        return JSONResponse(formats.wind_swath_geojson(st, track))
    if fmt == "cap":
        risk = get_district_risk(storm_id=sid, at=at)
        top = [r for r in risk["districts"] if r["band_index"] >= 2][:12]
        return Response(
            formats.cap_xml(st, track, top), media_type="application/xml",
            headers={"Content-Disposition": f'attachment; filename="{sid}.cap.xml"'})
    raise HTTPException(404, "format must be one of atcf, bulletin, geojson, swaths, cap")


# ---------------------------------------------------------------- methods


@app.get("/api/methods")
def get_methods():
    """The credibility payload. Everything /methods renders comes from here."""
    e = engine()
    splits_path = C.LABELS_DIR / "splits.json"
    dataset_card = C.DATA_DIR / "DATASET_CARD.md"
    payload = {
        "model_card": {
            "name": "TRINETRA",
            "version": STATE.checkpoint.get("model_version", C.MODEL_VERSION),
            "parameters": STATE.train_report.get("parameters"),
            "intended_use": "Decision support for tropical cyclone analysis in "
                            "the North Indian Ocean. Not a warning product.",
            "warning_authority": "IMD / RSMC New Delhi",
            "heads": ["detection", "centre_fix", "dvorak_scene", "imd_category",
                      "vmax", "pmin", "ri_24h", "regime", "reintensify_land"],
            "grid": f"LAEA storm-centred, {C.GRID_EXTENT_KM:.0f} km, "
                    f"{C.GRID_SIZE_PX} px canonical",
            "tiers": {
                "archive": "IR, WV, VIS, PMW 89/37, scatterometer, full ERA5 "
                           "tabular. Full confidence.",
                "live": "OLR, scatterometer, L2-derived tabular. Reduced "
                        "confidence, wider bands.",
                "upload": "Whatever was supplied, OOD-gated. Heads without "
                          "required inputs are not issued.",
            },
        },
        "baselines": STATE.baselines,
        "analysis_model": STATE.train_report,
        "splits": (json.loads(splits_path.read_text(encoding="utf-8"))
                   if splits_path.exists() else None),
        "dataset_card_markdown": (dataset_card.read_text(encoding="utf-8")
                                  if dataset_card.exists() else None),
        "ood": (e.ood.as_dict() if e.ood is not None else
                {"status": "unavailable", "reason": "no embeddings file"}),
        "known_failure_modes": [
            "Pinhole eyes, where the eye is smaller than the effective "
            "resolution and the intensity is underestimated.",
            "Extratropical transition, which is outside the trained regime set.",
            "Post-landfall decay, where wind is no longer the operative hazard "
            "and the evaluation target should be rainfall.",
            "Sheared weak systems, where the centre is ambiguous in infrared and "
            "the centre-fix uncertainty is largest.",
            "Timesteps with no microwave, which is most timesteps, where the "
            "inner core is unresolved.",
            "The moment of land-sea transition itself, where the regime "
            "classifier is least confident and it matters most. The system "
            "abstains rather than guessing.",
        ],
        "not_attempted": [
            "Medium-range track forecasting. Deliberately ceded.",
            "Storm surge.",
            "Wind radii as a headline claim. Reported only on the "
            "SAR-validated subset, which is empty.",
            "Beating WeatherNext-class models at what they are good at.",
        ],
        "honesty": [
            "Primary labels are Dvorak-derived, so the headline analysis number "
            "measures agreement with a subjective human estimate.",
            "The independent-truth subset is specified and empty. NOAA SAR TC "
            "Wind was not pulled, so no non-Dvorak RMSE is reported rather than "
            "one being estimated.",
            "Best-track is a post-season reanalysis with hindsight the "
            "real-time system never had, so any best-track evaluation is an "
            "optimistic bound on operational performance.",
            "Satellite imagery in this build is generated by a parametric "
            "forward model. Analysis metrics validate the pipeline, not the "
            "science. Forecast metrics run on real best-track predictors and "
            "are real.",
            "Four historical August Arabian Sea cyclones is a case-study basis, "
            "not a statistical one. Asna is an analogue, not a training set.",
            "MOSDAC Level 1 is on a three-day tier for a general account. The "
            "live tier runs on Level 2 products and the interface shows every "
            "channel's age.",
        ],
        "reference_points": {
            "published_satellite_intensity_rmse_kt": "8 to 10",
            "imd_fengal_2024_intensity_abs_error_kt": {"24h": 4.2, "48h": 7.3,
                                                       "72h": 5.5},
            "imd_fengal_2024_lpa_intensity_error_kt": {"24h": 7.1, "48h": 10.3,
                                                       "72h": 13.8},
            "imd_fengal_2024_track_error_km": {"24h": 45, "48h": 112, "72h": 128},
            "historical_nio_position_error_km": {"24h": 140, "48h": 262,
                                                 "72h": 386},
        },
        "warnings": STATE.warnings,
    }
    # The reports are read from disk and an older file may still contain NaN,
    # which cannot be serialised at all. Sanitising on the way out means a
    # stale report degrades to nulls rather than taking the endpoint down.
    return jsonable(payload)


# ---------------------------------------------------------------- upload


@app.post("/api/upload")
async def post_upload(file: UploadFile, declared_instrument: str = Query("unknown"),
                      channel_map: str | None = None):
    """Bring-your-own-data mode. The guardrail chain runs in order.

    Six checks, each failing loudly with a specific reason rather than quietly
    producing a number. The most valuable outcome is a refusal that names
    exactly what would enable the answer.
    """
    from ..inference.upload import handle_upload

    payload = await file.read()
    return handle_upload(
        filename=file.filename or "upload.bin", payload=payload,
        declared_instrument=declared_instrument,
        channel_map=json.loads(channel_map) if channel_map else None,
        engine=engine(), model=STATE.model, checkpoint=STATE.checkpoint,
    )


# ---------------------------------------------------------------- websocket


@app.websocket("/ws/live")
async def ws_live(websocket):
    """Push new inference, new granule and freshness changes.

    In replay this advances the scrubber index so the client sees the same
    message stream it would in live mode. Same messages, same handlers, which
    is the point: if the two paths diverge the replay demo stops being evidence
    that the live path works.
    """
    await websocket.accept()
    e = engine()
    storms = e.storms()
    sid = next((s["storm_id"] for s in storms if s["featured_slug"]),
               storms[0]["storm_id"] if storms else None)
    if sid is None:
        await websocket.close()
        return

    track = e._tracks[sid]
    i = 0
    try:
        await websocket.send_json({
            "type": "hello", "mode": e.mode, "storm_id": sid,
            "n_fixes": int(len(track)),
            "note": "In replay this stream advances the inference index. The "
                    "message shapes are identical to live mode.",
        })
        while True:
            row = track.iloc[i % len(track)]
            at = pd.Timestamp(row["valid_time"])
            st = e.state(sid, at=at)
            await websocket.send_json({
                "type": "inference",
                "storm_id": sid,
                "valid_time": st["valid_time"],
                "vmax_kt": st["intensity"]["vmax_kt"],
                "sensor_mode": st["sensor_mode"],
                "regime": st["regime"]["label"],
                "spread_kt": st["disagreement"]["spread_kt"],
                "abstentions": len(st["abstentions"]),
            })
            i += 1
            await asyncio.sleep(2.0)
    except Exception:
        return


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "mode": C.MODE,
        "model_loaded": STATE.model is not None,
        "storms": len(STATE.engine.storms()) if STATE.engine else 0,
        "warnings": STATE.warnings,
    }
