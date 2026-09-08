"""Self-contained basemap.

The Explorer draws its own basemap from Natural Earth land polygons rather than
pulling raster tiles from a hosted style. Three reasons, in order of how much
they matter:

The demo must not have a network on its critical path. A map that goes grey
because a tile host is slow, on stage, is the whole presentation.

There is no API key and no licence cost, which is also why MapLibre was chosen
over a commercial SDK.

A hosted street basemap is actively wrong for this product. It draws roads and
place labels at the expense of the coastline, and the coastline is the single
most important line on this map: it is where the regime changes and the track
keeps going.

The land geometry is simplified on the way out, because the browser does not
need 1:50m detail at basin zoom and the untouched file is 1.6 MB.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache

import numpy as np
from fastapi import APIRouter, Response

from .. import config as C
from ..harmonise.geometry import LAND_GEOJSON, _polygons, districts

log = logging.getLogger(__name__)
router = APIRouter()

# Slightly wider than the NIO domain so panning to the edge does not reveal
# the end of the world.
CLIP = (44.0, -6.0, 112.0, 44.0)


def _douglas_peucker(pts: np.ndarray, tol: float) -> np.ndarray:
    """Simplify a ring, keeping its shape.

    Written out rather than imported because shapely is an optional dependency
    and this is twenty lines. Iterative rather than recursive so a 40,000-vertex
    coastline ring cannot blow the stack.
    """
    n = len(pts)
    if n < 4:
        return pts
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        a, b = pts[lo], pts[hi]
        seg = b - a
        length = float(np.hypot(*seg))
        if length < 1e-12:
            d = np.hypot(*(pts[lo + 1 : hi] - a).T)
        else:
            # Perpendicular distance from each interior point to the chord.
            d = np.abs(np.cross(seg, pts[lo + 1 : hi] - a)) / length
        if d.size == 0:
            continue
        k = int(np.argmax(d)) + lo + 1
        if d.max() > tol:
            keep[k] = True
            stack.append((lo, k))
            stack.append((k, hi))
    return pts[keep]


@lru_cache(maxsize=4)
def land_geojson(tolerance: float = 0.02) -> str:
    """Land polygons, clipped to the region and simplified."""
    if not LAND_GEOJSON.exists():
        return json.dumps({"type": "FeatureCollection", "features": []})
    data = json.loads(LAND_GEOJSON.read_text(encoding="utf-8"))
    w, s, e, n = CLIP
    out = []
    for feat in data["features"]:
        for ext, holes in _polygons(feat["geometry"]):
            if (ext[:, 0].max() < w or ext[:, 0].min() > e
                    or ext[:, 1].max() < s or ext[:, 1].min() > n):
                continue
            rings = [_douglas_peucker(ext, tolerance)]
            for h in holes:
                # Holes are kept only if they survive simplification as a
                # polygon. A hole reduced to three points is noise.
                sh = _douglas_peucker(h, tolerance)
                if len(sh) >= 4:
                    rings.append(sh)
            if len(rings[0]) < 4:
                continue
            out.append({
                "type": "Feature",
                "properties": {"kind": "land"},
                "geometry": {"type": "Polygon",
                             "coordinates": [r.tolist() for r in rings]},
            })
    log.info("basemap land: %d polygons at tolerance %.3f", len(out), tolerance)
    return json.dumps({
        "type": "FeatureCollection",
        "properties": {"source": "Natural Earth 1:50m land",
                       "simplified_tolerance_deg": tolerance,
                       "provenance_class": "O"},
        "features": out,
    })


@router.get("/api/basemap/land.geojson")
def get_land(tolerance: float = 0.02):
    return Response(land_geojson(tolerance), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=604800, immutable"})


@lru_cache(maxsize=2)
def districts_geojson(tolerance: float = 0.02) -> str:
    """District polygons, simplified, cached on disk.

    Two things here were worth fixing rather than leaving.

    Simplification must never lose a district. Douglas-Peucker can reduce a
    small district's ring below the three points a polygon needs, and dropping
    the feature at that point removes a district from the map entirely: it
    cannot be clicked, and it silently disappears from the rainfall
    choropleth. At a tolerance of 0.03 two districts went that way. So a ring
    that does not survive simplification keeps its original geometry instead.

    The result is cached to disk as well as in memory. Simplifying 735
    districts takes around six seconds, and paying that on every server start,
    for geometry that never changes, is the kind of cost that turns into "the
    demo takes a while to warm up".
    """
    cache = C.INTERIM_DIR / f"districts_simplified_{tolerance:.3f}.geojson"
    if cache.exists():
        return cache.read_text(encoding="utf-8")

    d = districts()
    feats = []
    for i in range(len(d.names)):
        rings = []
        for r in d.rings[i]:
            simplified = _douglas_peucker(r, tolerance)
            # Keep the full ring rather than drop the district.
            rings.append(simplified if len(simplified) >= 4 else r)
        rings = [r for r in rings if len(r) >= 4]
        if not rings:
            continue
        feats.append({
            "type": "Feature",
            "id": d.ids[i],
            "properties": {"district_id": d.ids[i], "name": d.names[i],
                           "provenance_class": "O"},
            "geometry": {"type": "Polygon",
                         "coordinates": [r.tolist() for r in rings]},
        })
    if len(feats) != len(d.names):
        # Loud rather than silent: a missing district is a hole in the product,
        # not a rendering nicety.
        log.warning("districts: %d of %d survived simplification at tol %.3f",
                    len(feats), len(d.names), tolerance)

    out = json.dumps({
        "type": "FeatureCollection",
        "properties": {"source": "geoBoundaries gbOpen India ADM2",
                       "count": len(feats), "provenance_class": "O",
                       "simplified_tolerance_deg": tolerance},
        "features": feats,
    })
    try:
        cache.write_text(out, encoding="utf-8")
    except OSError:
        pass  # a read-only data directory is not a reason to fail the request
    log.info("districts geojson: %d features, %.0f KB at tol %.3f",
             len(feats), len(out) / 1024, tolerance)
    return out


@router.get("/api/basemap/districts.geojson")
def get_districts(tolerance: float = 0.02):
    return Response(districts_geojson(tolerance), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=604800, immutable"})


@router.get("/api/basemap/style.json")
def get_style():
    """A complete MapLibre style with no external dependency.

    Ordering follows the manifest rule: boundaries on top, then derived, then
    reanalysis, then observed. The client inserts its data layers beneath the
    `boundary-*` layers by id, so the coastline is never buried under a raster.
    """
    # No "glyphs" key at all. Setting it to null serialises to JSON null,
    # which fails MapLibre's style validation ("glyphs: string expected, null
    # found") and makes it reject the entire style, so nothing renders at all,
    # including the coastline. Omitting the key means no glyph source, which is
    # what is wanted: there are no text layers here.
    return {
        "version": 8,
        "name": "TRINETRA instrument",
        "sources": {
            "land": {"type": "geojson", "data": "/api/basemap/land.geojson"},
            "districts": {"type": "geojson",
                          "data": "/api/basemap/districts.geojson"},
            "graticule": {"type": "geojson", "data": _graticule()},
        },
        "layers": [
            {"id": "ocean", "type": "background",
             "paint": {"background-color": "#070a10"}},
            {"id": "graticule-lines", "type": "line", "source": "graticule",
             "paint": {"line-color": "#1b2433", "line-width": 0.6}},
            {"id": "land-fill", "type": "fill", "source": "land",
             "paint": {"fill-color": "#111722", "fill-opacity": 0.96}},
            {"id": "district-lines", "type": "line", "source": "districts",
             "minzoom": 4.5,
             "paint": {"line-color": "#25303f", "line-width": 0.5}},
            # Everything the client adds goes above this and below the next.
            {"id": "boundary-coast", "type": "line", "source": "land",
             "paint": {"line-color": "#4d6178", "line-width": 1.0}},
        ],
    }


def _graticule(step: float = 5.0) -> dict:
    """A 5-degree graticule, drawn as data.

    Present because the reference material for this interface is an instrument
    readout rather than a consumer map, and because a graticule gives a reader
    a scale without a scale bar.
    """
    feats = []
    w, s, e, n = CLIP
    for lon in np.arange(np.ceil(w / step) * step, e, step):
        feats.append({"type": "Feature",
                      "properties": {"kind": "meridian", "value": float(lon)},
                      "geometry": {"type": "LineString",
                                   "coordinates": [[float(lon), float(s)],
                                                   [float(lon), float(n)]]}})
    for lat in np.arange(np.ceil(s / step) * step, n, step):
        feats.append({"type": "Feature",
                      "properties": {"kind": "parallel", "value": float(lat)},
                      "geometry": {"type": "LineString",
                                   "coordinates": [[float(w), float(lat)],
                                                   [float(e), float(lat)]]}})
    return {"type": "FeatureCollection", "features": feats}


@router.get("/api/basemap/presets")
def get_presets():
    """Basin presets for the viewport control."""
    return {"presets": C.BASIN_PRESETS}
