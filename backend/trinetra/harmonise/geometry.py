"""Land mask and district geometry.

Two pieces of real vector data, both open and both downloaded without
credentials, which makes them the only genuinely observed spatial layers in the
build besides the best-track itself.

Natural Earth 1:50m land polygons give the coastline and the land mask channel.
geoBoundaries gbOpen India ADM2 gives 735 district polygons, which is the unit
the post-landfall rainfall choropleth uses. The district is the decision unit
for a state disaster management authority, so a district-level risk band is
actionable in a way a smooth inland rainfall field is not.

The land mask is rasterised once onto a fixed regular grid over the domain and
cached. Every storm-centred grid then samples that raster, so the polygon fill
runs once for the whole archive rather than once per granule.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .. import config as C

log = logging.getLogger(__name__)

VECTOR_DIR = C.RAW_DIR / "vector"
LAND_GEOJSON = VECTOR_DIR / "ne_50m_land.geojson"
DISTRICTS_GEOJSON = VECTOR_DIR / "districts_ind_adm2.geojson"
LAND_CACHE = C.INTERIM_DIR / "land_mask_nio.npz"

# Rasterisation domain, wider than the NIO bounding box so a storm grid centred
# near the edge still samples real geometry rather than falling off the raster.
MASK_BBOX = (48.0, -2.0, 108.0, 40.0)  # west, south, east, north
MASK_RES_DEG = 0.02  # roughly 2.2 km, finer than the 3.9 km model grid

# Districts named in the Biparjoy and Asna case studies. Pinned so the archive
# page can tell those two stories without a lookup by hand.
CASE_STUDY_DISTRICTS = {
    "biparjoy": ["Jalor", "Sirohi", "Barmer", "Kachchh", "Banas Kantha", "Patan"],
    "asna": ["Jalor", "Barmer", "Kachchh", "Jamnagar", "Rajkot", "Morbi"],
}


def _polygons(geometry: dict) -> list[tuple[np.ndarray, list[np.ndarray]]]:
    """GeoJSON Polygon or MultiPolygon as a list of (exterior, holes).

    The exterior and interior rings are kept apart because the rasteriser fills
    them in two passes. Flattening them into one list works for a
    crossing-number point test but not for a scanline fill, which would paint
    the holes solid.
    """
    out: list[tuple[np.ndarray, list[np.ndarray]]] = []
    gtype = geometry.get("type")
    coords = geometry.get("coordinates", [])
    polys = [coords] if gtype == "Polygon" else coords if gtype == "MultiPolygon" else []
    for poly in polys:
        rings = [np.asarray(r, dtype=float)[:, :2] for r in poly
                 if np.asarray(r).ndim == 2 and len(r) >= 4]
        if rings:
            out.append((rings[0], rings[1:]))
    return out


def _rings(geometry: dict) -> list[np.ndarray]:
    """Every ring of a geometry, flattened. Used by the point-in-polygon test.

    A point inside a hole crosses the exterior ring and the hole ring an odd
    number of times each, so the parity test handles holes without needing to
    know which ring is which.
    """
    out: list[np.ndarray] = []
    for ext, holes in _polygons(geometry):
        out.append(ext)
        out.extend(holes)
    return out


def _contains(rings: list[np.ndarray], pts: np.ndarray) -> np.ndarray:
    """Point-in-polygon over a ring set, returning a boolean per point.

    matplotlib.path is used when available because it is compiled and roughly an
    order of magnitude faster. The numpy crossing-number fallback keeps this
    module working with nothing but numpy installed.
    """
    inside = np.zeros(len(pts), dtype=bool)
    try:
        from matplotlib.path import Path as MplPath

        for ring in rings:
            inside ^= MplPath(ring).contains_points(pts)
        return inside
    except ImportError:
        pass

    x, y = pts[:, 0], pts[:, 1]
    for ring in rings:
        x0, y0 = ring[:-1, 0], ring[:-1, 1]
        x1, y1 = ring[1:, 0], ring[1:, 1]
        for i in range(len(x0)):
            straddles = (y0[i] > y[:]) != (y1[i] > y[:])
            if not straddles.any():
                continue
            with np.errstate(divide="ignore", invalid="ignore"):
                x_at = x0[i] + (y - y0[i]) * (x1[i] - x0[i]) / (y1[i] - y0[i])
            inside ^= straddles & (x < x_at)
    return inside


def _rasterise(features: list[list[tuple[np.ndarray, list[np.ndarray]]]],
               lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
    """Burn polygons onto a regular grid, returning a float land fraction.

    Uses a scanline polygon fill rather than a point-in-polygon test. The
    distinction is not a micro-optimisation: a parity test costs one pass over
    every grid cell for every polygon edge, and Natural Earth's Eurasia feature
    is a single polygon with tens of thousands of edges whose bounding box
    covers the whole domain. A scanline fill costs the area it paints. The same
    job goes from minutes to under a second.

    Exteriors are filled first, then holes are cleared, which is why the ring
    roles have to be kept apart upstream.
    """
    from PIL import Image, ImageDraw

    height, width = len(lats), len(lons)
    lon0, lat0 = lons[0], lats[0]
    img = Image.new("1", (width, height), 0)
    draw = ImageDraw.Draw(img)

    def to_px(ring: np.ndarray) -> list[tuple[float, float]]:
        px = (ring[:, 0] - lon0) / MASK_RES_DEG
        py = (lat0 - ring[:, 1]) / MASK_RES_DEG
        return list(zip(px.tolist(), py.tolist()))

    for polys in features:
        for ext, holes in polys:
            if len(ext) < 3:
                continue
            draw.polygon(to_px(ext), fill=1)
            for hole in holes:
                if len(hole) >= 3:
                    draw.polygon(to_px(hole), fill=0)

    return np.asarray(img, dtype=np.uint8).astype(np.float32)


@dataclass
class LandMask:
    """Rasterised land fraction over the domain."""

    lons: np.ndarray
    lats: np.ndarray
    mask: np.ndarray  # float32 land fraction in [0, 1], shape (nlat, nlon)

    @classmethod
    def build(cls, force: bool = False) -> LandMask:
        if LAND_CACHE.exists() and not force:
            z = np.load(LAND_CACHE)
            return cls(z["lons"], z["lats"], z["mask"])
        if not LAND_GEOJSON.exists():
            raise FileNotFoundError(
                f"{LAND_GEOJSON} missing. See docs/RUNBOOK.md for the fetch command."
            )

        w, s, e, n = MASK_BBOX
        lons = np.arange(w, e, MASK_RES_DEG)
        lats = np.arange(n, s, -MASK_RES_DEG)

        data = json.loads(LAND_GEOJSON.read_text(encoding="utf-8"))
        mask = _rasterise(
            [_polygons(f["geometry"]) for f in data["features"]], lons, lats
        )
        log.info("land mask %s, %.1f%% land", mask.shape, 100.0 * float(mask.mean()))
        np.savez_compressed(LAND_CACHE, lons=lons, lats=lats, mask=mask)
        return cls(lons, lats, mask)

    def sample(self, lat, lon) -> np.ndarray:
        """Land fraction at arbitrary coordinates, by bilinear interpolation.

        Interpolating rather than taking the nearest cell gives a genuine
        fraction along the coastline, which is what the `land_fraction` tabular
        predictor and the coastal blending in the soil moisture channel need.
        """
        lat = np.asarray(lat, dtype=float)
        lon = np.asarray(lon, dtype=float)
        fx = (lon - self.lons[0]) / MASK_RES_DEG
        fy = (self.lats[0] - lat) / MASK_RES_DEG

        x0 = np.clip(np.floor(fx).astype(int), 0, len(self.lons) - 2)
        y0 = np.clip(np.floor(fy).astype(int), 0, len(self.lats) - 2)
        tx = np.clip(fx - x0, 0.0, 1.0)
        ty = np.clip(fy - y0, 0.0, 1.0)

        m = self.mask
        top = m[y0, x0] * (1 - tx) + m[y0, x0 + 1] * tx
        bot = m[y0 + 1, x0] * (1 - tx) + m[y0 + 1, x0 + 1] * tx
        return (top * (1 - ty) + bot * ty).astype(np.float32)

    def distance_to_coast_km(self, lat, lon, max_km: float = 500.0) -> np.ndarray:
        """Signed distance to the coastline: positive over water, negative inland.

        Computed by expanding rings on the cached raster rather than by a true
        distance transform, which keeps it dependency-free. Accuracy is one mask
        cell, about 2 km, and it saturates at max_km.
        """
        from ..grid import haversine_km

        lat = np.atleast_1d(np.asarray(lat, dtype=float))
        lon = np.atleast_1d(np.asarray(lon, dtype=float))
        here = self.sample(lat, lon) > 0.5

        # Sample the coastline once: mask cells with a differing neighbour.
        if not hasattr(self, "_coast_pts"):
            m = self.mask > 0.5
            edge = np.zeros_like(m)
            edge[:-1, :] |= m[:-1, :] != m[1:, :]
            edge[:, :-1] |= m[:, :-1] != m[:, 1:]
            yy, xx = np.nonzero(edge)
            # Thin the coastline to keep the nearest-point search cheap.
            step = max(1, len(yy) // 40000)
            self._coast_pts = np.column_stack(
                [self.lons[xx[::step]], self.lats[yy[::step]]]
            )

        cp = self._coast_pts
        out = np.full(lat.shape, max_km, dtype=np.float32)
        for i in range(lat.size):
            near = (np.abs(cp[:, 0] - lon.flat[i]) < 6.0) & (
                np.abs(cp[:, 1] - lat.flat[i]) < 6.0
            )
            if not near.any():
                continue
            d = haversine_km(lat.flat[i], lon.flat[i], cp[near, 1], cp[near, 0]).min()
            out.flat[i] = min(float(d), max_km)
        return np.where(here, -out, out)


@dataclass
class Districts:
    """India ADM2 polygons, with fast bounding-box rejection."""

    names: list[str]
    ids: list[str]
    states: list[str]
    rings: list[list[np.ndarray]]
    bboxes: np.ndarray  # (n, 4) west, south, east, north
    centroids: np.ndarray  # (n, 2) lon, lat

    @classmethod
    def load(cls) -> Districts:
        if not DISTRICTS_GEOJSON.exists():
            raise FileNotFoundError(
                f"{DISTRICTS_GEOJSON} missing. See docs/RUNBOOK.md."
            )
        data = json.loads(DISTRICTS_GEOJSON.read_text(encoding="utf-8"))
        names, ids, states, rings, bboxes, cents = [], [], [], [], [], []
        for feat in data["features"]:
            r = _rings(feat["geometry"])
            if not r:
                continue
            p = feat["properties"]
            allpts = np.vstack(r)
            names.append(str(p.get("shapeName", "")))
            ids.append(str(p.get("shapeID", "")))
            states.append(str(p.get("shapeISO") or ""))
            rings.append(r)
            bboxes.append(
                [allpts[:, 0].min(), allpts[:, 1].min(), allpts[:, 0].max(), allpts[:, 1].max()]
            )
            cents.append([allpts[:, 0].mean(), allpts[:, 1].mean()])
        log.info("districts loaded: %d", len(names))
        return cls(names, ids, states, rings, np.asarray(bboxes), np.asarray(cents))

    def locate(self, lat: float, lon: float) -> int | None:
        """Index of the district containing a point, or None over water."""
        cand = np.nonzero(
            (self.bboxes[:, 0] <= lon)
            & (lon <= self.bboxes[:, 2])
            & (self.bboxes[:, 1] <= lat)
            & (lat <= self.bboxes[:, 3])
        )[0]
        pt = np.array([[lon, lat]])
        for i in cand:
            if _contains(self.rings[i], pt)[0]:
                return int(i)
        return None

    def within_corridor(self, track_lat, track_lon, radius_km: float = 150.0) -> list[int]:
        """Districts whose centroid falls within a radius of the track polyline.

        The corridor is the predicted track buffered by a radius, which is how
        the rainfall risk choropleth decides which districts are in play. Using
        centroids rather than full polygon intersection is a deliberate
        simplification and it is stated on the methods page.
        """
        from ..grid import haversine_km

        track_lat = np.atleast_1d(np.asarray(track_lat, dtype=float))
        track_lon = np.atleast_1d(np.asarray(track_lon, dtype=float))
        hit: list[int] = []
        for i, (clon, clat) in enumerate(self.centroids):
            d = haversine_km(clat, clon, track_lat, track_lon).min()
            if d <= radius_km:
                hit.append(i)
        return hit

    def find(self, name: str) -> int | None:
        target = name.strip().lower()
        for i, n in enumerate(self.names):
            if n.strip().lower() == target:
                return i
        return None

    def as_feature(self, i: int, properties: dict | None = None) -> dict:
        """One district as a GeoJSON feature, for the vector tile service."""
        polys = [[ring.tolist() for ring in self.rings[i]]]
        return {
            "type": "Feature",
            "id": self.ids[i],
            "properties": {
                "district_id": self.ids[i],
                "name": self.names[i],
                **(properties or {}),
            },
            "geometry": {"type": "MultiPolygon", "coordinates": polys},
        }


_LAND: LandMask | None = None
_DISTRICTS: Districts | None = None


def land_mask() -> LandMask:
    global _LAND
    if _LAND is None:
        _LAND = LandMask.build()
    return _LAND


def districts() -> Districts:
    global _DISTRICTS
    if _DISTRICTS is None:
        _DISTRICTS = Districts.load()
    return _DISTRICTS
