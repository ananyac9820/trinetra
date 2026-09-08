"""The canonical storm-centred grid, and the projections around it.

Lambert azimuthal equal-area centred on the storm, 1000 km across, 256 by 256
pixels, so roughly 3.9 km per pixel. Every source resamples onto this grid before
the model sees it. The construction mirrors the Digital Typhoon dataset, which is
the precedent to cite when a reviewer asks why this projection and this size.

Equal-area matters here for a specific reason. Convective coverage within a
radius and the symmetry index are both area integrals over the cloud field. On a
plate-carree grid the pixel area shrinks with latitude, so the same storm scores
differently at 8 N and at 24 N. On LAEA it does not.

Web Mercator appears in this module only for the tile service. The scientific
grid never leaves LAEA, and reprojection happens in the tile builder rather than
anywhere in the model path.

pyproj is used when it is installed. The closed-form LAEA equations are
implemented here as well, because the demo has to run without the geospatial
stack and because a 20-line spherical implementation is easier to check than a
dependency.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import config as C

EARTH_RADIUS_KM = 6371.0088  # IUGG mean radius


@dataclass(frozen=True)
class StormGrid:
    """A storm-centred LAEA grid instance.

    Attributes
    ----------
    centre_lat, centre_lon
        Projection origin, which is the storm centre for this frame.
    size_px
        Pixels per side.
    extent_km
        Full width of the domain in kilometres.
    """

    centre_lat: float
    centre_lon: float
    size_px: int = C.GRID_SIZE_PX
    extent_km: float = C.GRID_EXTENT_KM

    @property
    def res_km(self) -> float:
        return self.extent_km / self.size_px

    @property
    def half_km(self) -> float:
        return self.extent_km / 2.0

    def xy_km(self) -> tuple[np.ndarray, np.ndarray]:
        """Projected coordinates of pixel centres, in kilometres from the origin.

        y increases northward, so the array is flipped when written as an image
        where row 0 is the top.
        """
        half = self.half_km
        step = self.res_km
        axis = np.linspace(-half + step / 2, half - step / 2, self.size_px)
        return np.meshgrid(axis, axis[::-1])  # (x, y), y descending down rows

    def radius_km(self) -> np.ndarray:
        """Great-circle-equivalent distance from the storm centre per pixel."""
        x, y = self.xy_km()
        return np.hypot(x, y)

    def azimuth_deg(self) -> np.ndarray:
        """Bearing from the centre, degrees clockwise from north."""
        x, y = self.xy_km()
        return np.degrees(np.arctan2(x, y)) % 360.0

    def latlon(self) -> tuple[np.ndarray, np.ndarray]:
        """Geographic coordinates of every pixel centre."""
        x, y = self.xy_km()
        return laea_inverse(x, y, self.centre_lat, self.centre_lon)

    def project(self, lat, lon) -> tuple[np.ndarray, np.ndarray]:
        """Geographic to projected kilometres on this grid."""
        return laea_forward(lat, lon, self.centre_lat, self.centre_lon)

    def pixel_of(self, lat, lon) -> tuple[np.ndarray, np.ndarray]:
        """Nearest pixel index (row, col) for a geographic position.

        Out-of-domain positions come back as -1 rather than as a clamped edge
        pixel, so a caller cannot silently read the wrong cell.
        """
        x, y = self.project(lat, lon)
        col = np.floor((x + self.half_km) / self.res_km).astype(int)
        row = np.floor((self.half_km - y) / self.res_km).astype(int)
        bad = (col < 0) | (col >= self.size_px) | (row < 0) | (row >= self.size_px)
        col = np.where(bad, -1, col)
        row = np.where(bad, -1, row)
        return row, col

    def bounds_lonlat(self) -> tuple[float, float, float, float]:
        """Geographic bounding box of the domain, for the tile service."""
        lat, lon = self.latlon()
        return float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())


def laea_forward(lat, lon, lat0: float, lon0: float) -> tuple[np.ndarray, np.ndarray]:
    """Spherical Lambert azimuthal equal-area, geographic to projected km."""
    lat = np.radians(np.asarray(lat, dtype=float))
    lon = np.radians(np.asarray(lon, dtype=float))
    p0, l0 = np.radians(lat0), np.radians(lon0)

    dlon = lon - l0
    cos_c = np.sin(p0) * np.sin(lat) + np.cos(p0) * np.cos(lat) * np.cos(dlon)
    cos_c = np.clip(cos_c, -1.0, 1.0)
    # k degenerates at the antipode. Nothing in a 1000 km domain gets near it,
    # but guard anyway so a bad centre produces NaN rather than an overflow.
    with np.errstate(invalid="ignore", divide="ignore"):
        k = EARTH_RADIUS_KM * np.sqrt(2.0 / (1.0 + cos_c))
    k = np.where(cos_c <= -1.0 + 1e-12, np.nan, k)

    x = k * np.cos(lat) * np.sin(dlon)
    y = k * (np.cos(p0) * np.sin(lat) - np.sin(p0) * np.cos(lat) * np.cos(dlon))
    return x, y


def laea_inverse(x, y, lat0: float, lon0: float) -> tuple[np.ndarray, np.ndarray]:
    """Spherical Lambert azimuthal equal-area, projected km to geographic."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    p0, l0 = np.radians(lat0), np.radians(lon0)

    rho = np.hypot(x, y)
    with np.errstate(invalid="ignore", divide="ignore"):
        c = 2.0 * np.arcsin(np.clip(rho / (2.0 * EARTH_RADIUS_KM), -1.0, 1.0))
        sin_c, cos_c = np.sin(c), np.cos(c)
        lat = np.arcsin(
            np.clip(cos_c * np.sin(p0) + np.where(rho == 0, 0.0, y * sin_c * np.cos(p0) / rho), -1.0, 1.0)
        )
        lon = l0 + np.arctan2(
            x * sin_c, rho * cos_c * np.cos(p0) - y * sin_c * np.sin(p0)
        )
    lat = np.where(rho == 0, p0, lat)
    lon = np.where(rho == 0, l0, lon)
    return np.degrees(lat), (np.degrees(lon) + 180.0) % 360.0 - 180.0


def haversine_km(lat1, lon1, lat2, lon2) -> np.ndarray:
    """Great-circle distance in kilometres. Used by the measure tool and the probe."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2.0 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def bearing_deg(lat1, lon1, lat2, lon2) -> np.ndarray:
    """Initial bearing, degrees clockwise from north."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    y = np.sin(dl) * np.cos(p2)
    x = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0


# ------------------------------------------------------------------ Web Mercator


def lonlat_to_mercator(lon, lat) -> tuple[np.ndarray, np.ndarray]:
    """EPSG:4326 to EPSG:3857 metres. Tile service only."""
    lon = np.asarray(lon, dtype=float)
    lat = np.clip(np.asarray(lat, dtype=float), -85.05112878, 85.05112878)
    r = EARTH_RADIUS_KM * 1000.0
    x = np.radians(lon) * r
    y = r * np.log(np.tan(np.pi / 4.0 + np.radians(lat) / 2.0))
    return x, y


def tile_bounds_lonlat(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Geographic bounds of an XYZ tile, as (west, south, east, north)."""
    n = 2.0**z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y / n))))
    south = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y + 1) / n))))
    return west, float(south), east, float(north)


def tile_pixel_lonlat(z: int, x: int, y: int, size: int = 256):
    """Per-pixel geographic coordinates of an XYZ tile.

    The tile builder samples the LAEA field at these coordinates. Doing the
    reprojection by inverse mapping from tile pixels keeps the resampling in the
    tile builder, where it belongs, instead of pushing a second grid definition
    into the model path.
    """
    n = 2.0**z
    px = (x + (np.arange(size) + 0.5) / size) / n
    py = (y + (np.arange(size) + 0.5) / size) / n
    lon = px * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * py))))
    return np.meshgrid(lon, lat)


def pyproj_crs_string(centre_lat: float, centre_lon: float) -> str:
    """PROJ string for this grid, so a GeoTIFF written from it is georeferenced."""
    return (
        f"+proj=laea +lat_0={centre_lat:.6f} +lon_0={centre_lon:.6f} "
        f"+x_0=0 +y_0=0 +R={EARTH_RADIUS_KM * 1000:.1f} +units=m +no_defs"
    )
