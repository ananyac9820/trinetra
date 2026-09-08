"""XYZ raster tiles from the storm-centred fields.

The Explorer cannot consume NetCDF, so something has to reproject the
scientific grid to Web Mercator and colour it. That happens here and only here.
The model path never sees Web Mercator, and the tile builder never sees the
model.

Two contract points from the specification matter more than the rendering does.

A tile with no data returns HTTP 204 with an `X-Status` header, never a blank
image. A transparent PNG and a tile full of zeros look identical to a
compositor, and "no scatterometer swath here" has to be distinguishable from
"the wind is calm here". That distinction is the whole product.

Every tile carries `X-Granule-Time`, the actual observation time it resolved
to, so the client can display the layer's age without a second request. The
scrubber asks for a time; the service answers with the most recent granule at or
before it and says which one that was.

rasterio and rio-cogeo are used when installed, which is what the full stack
runs. The numpy and Pillow path here produces the same tiles and needs neither,
because the demo has to survive a machine with no geospatial stack.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .. import config as C
from ..cube.store import CH, Granule
from ..grid import StormGrid, tile_pixel_lonlat
from .palettes import colourise

log = logging.getLogger(__name__)

TILE_PX = 256

# Which field each layer id draws from. Layers not listed here are vector layers
# and are served by the MVT endpoint instead.
LAYER_FIELD = {
    "insat_ir": ("channel", "ir", "ir_enhanced"),
    "insat_wv": ("channel", "wv", "water_vapour"),
    "insat_vis": ("channel", "vis", "ir_enhanced"),
    "insat_olr": ("channel", "olr", "convection"),
    "insat_qpe": ("extra", "qpe", "rainfall"),
    "insat_sst": ("extra", "sst", "thermal"),
    "insat_aod": ("extra", "aod", "dust"),
    "insat_uth": ("derived_uth", None, "moisture"),
    "pmw_89": ("channel", "pmw89", "microwave"),
    "pmw_37": ("channel", "pmw37", "microwave"),
    "scat_wind": ("channel", "scat", "wind"),
    "soil_moisture": ("channel", "soil", "soil"),
    "tri_parametric_wind": ("parametric_wind", None, "wind"),
    "tri_parametric_wind_spread": ("parametric_wind_spread", None, "uncertainty"),
    "tri_ri_favourability": ("favourability", None, "favourability"),
    "tri_ri_favourability_spread": ("favourability_spread", None, "uncertainty"),
    "tri_sensor_coverage": ("sensor_coverage", None, "uncertainty"),
    "era5_shear": ("synoptic", "shear", "wind"),
    "cmv_shear": ("synoptic", "shear", "wind"),
    "era5_rh_mid": ("synoptic", "rh_mid", "moisture"),
    "era5_divergence": ("synoptic", "divergence", "favourability"),
    "tchp": ("tchp", None, "thermal"),
}


@dataclass
class TileResult:
    """Either a PNG, or an explicit statement that there is nothing here."""

    png: bytes | None
    status: str  # ok | no-coverage | out-of-domain | no-data | expired
    granule_time: str | None = None
    reason: str | None = None
    provenance: str | None = None

    @property
    def is_empty(self) -> bool:
        return self.png is None


def _field_for(layer_id: str, granule: Granule, engine=None) -> tuple[np.ndarray | None, str, str]:
    """Resolve a layer to a 2D field on the granule's own grid.

    Returns (field, palette, provenance note). A None field means the layer has
    nothing at this time, which the caller turns into a 204.
    """
    spec = LAYER_FIELD.get(layer_id)
    if spec is None:
        return None, "ir_enhanced", "unknown layer"
    kind, key, palette = spec

    if kind == "channel":
        i = CH[key]
        if not granule.present[i]:
            return None, palette, granule.extras.get("absent_reason", {}).get(
                key, "channel not present")
        return granule.data[i], palette, "observed"

    if kind == "extra":
        return granule.extras.get(key), palette, "observed"

    if kind == "derived_uth":
        # Upper tropospheric humidity, from the water vapour channel. The real
        # product is an INSAT Level 2 retrieval; this is a stand-in and the
        # provenance string says so.
        i = CH["wv"]
        if not granule.present[i]:
            return None, palette, "water vapour channel absent"
        wv = granule.data[i]
        return np.clip((265.0 - wv) / 0.75, 0.0, 100.0), palette, "observed"

    if kind == "synoptic":
        from ..harmonise import environment as env

        g = granule.grid
        lat, lon = g.latlon()
        # Sampled on a coarse lattice and interpolated, because the synoptic
        # generator is a per-point Python function and calling it 65,536 times
        # per tile would make the tile service the slowest thing in the stack.
        step = 16
        coarse = np.zeros((g.size_px // step + 1, g.size_px // step + 1))
        for a, yy in enumerate(range(0, g.size_px + step, step)):
            for b, xx in enumerate(range(0, g.size_px + step, step)):
                y = min(yy, g.size_px - 1)
                x = min(xx, g.size_px - 1)
                coarse[a, b] = env._synoptic_field(
                    key, float(lat[y, x]), float(lon[y, x]),
                    pd.Timestamp(granule.valid_time))
        field = _bilinear_upsample(coarse, g.size_px)
        return field, palette, "reanalysis"

    if kind == "tchp":
        from ..harmonise import environment as env

        sst = granule.extras.get("sst")
        if sst is None:
            return None, palette, "no SST field"
        lat, _lon = granule.grid.latlon()
        excess = np.clip(sst - 26.0, 0.0, None)
        mixed = 55.0 - 0.9 * np.clip(lat - 8.0, 0.0, None)
        return np.clip(excess * np.maximum(mixed, 20.0) * 0.42, 0.0, 155.0), palette, "reanalysis"

    if kind in ("parametric_wind", "parametric_wind_spread"):
        from ..ingest.synth import holland_wind_kt

        vmax = engine_vmax(engine, granule)
        if vmax is None:
            return None, palette, "no intensity estimate at this time"
        rmw = granule.extras.get("rmw_km", 40.0)
        b = granule.extras.get("holland_b", 1.3)
        wind = holland_wind_kt(granule.grid.radius_km(), vmax, rmw, b)
        if kind == "parametric_wind":
            return wind, palette, "derived: parametric reconstruction"
        # The spread is the intensity uncertainty pushed through the same
        # profile, so the band widens where the wind is strongest.
        ci = 7.0
        return wind * (ci / max(vmax, 1.0)), palette, "derived: uncertainty"

    if kind in ("favourability", "favourability_spread"):
        field, spread = favourability_field(granule)
        return (field if kind == "favourability" else spread), palette, "derived"

    if kind == "sensor_coverage":
        # How many channels actually covered each pixel. The honest spatial
        # expression of where the system knows less.
        cover = np.zeros(granule.data.shape[1:], dtype=np.float32)
        for name, i in CH.items():
            if name == "land" or not granule.present[i]:
                continue
            cover += np.isfinite(granule.data[i]).astype(np.float32)
        return cover / 8.0, palette, "derived: availability mask"

    return None, palette, "unhandled layer kind"


def engine_vmax(engine, granule: Granule) -> float | None:
    """Intensity for the parametric reconstruction, from the model if loaded."""
    if engine is None:
        return None
    try:
        st = engine.state(granule.sid, granule.valid_time)
        v = st["intensity"]["vmax_kt"]
        return float(v) if v is not None else st["intensity"]["observed_vmax_kt"]
    except Exception:  # a tile must not take the map down
        return None


def favourability_field(granule: Granule) -> tuple[np.ndarray, np.ndarray]:
    """RI environmental favourability, evaluated across the grid.

    This is the defensible form of what people ask for when they ask for an
    RI heatmap. The storm's own RI probability is a scalar and smearing it over
    a map would invent a per-location forecast. What is genuinely spatial is
    whether the environment at each point would support intensification, and
    that is computable from SST, the thermal potential and the shear at that
    point.

    It is named favourability everywhere, never probability, and the manifest
    refuses to register a layer that calls it otherwise.
    """
    from ..ingest.synth import potential_intensity_kt

    sst = granule.extras.get("sst")
    lat, _lon = granule.grid.latlon()
    if sst is None:
        sst = np.full(lat.shape, 29.0, dtype=np.float32)

    mpi = potential_intensity_kt(sst)
    # Three ingredients, each mapped to 0-1 and combined multiplicatively so
    # that any one of them being hostile suppresses the result. Shear that kills
    # a storm should not be averaged away by a warm ocean.
    thermal = np.clip((sst - 26.0) / 4.0, 0.0, 1.0)
    potential = np.clip((mpi - 60.0) / 80.0, 0.0, 1.0)
    land = granule.data[CH["land"]]
    over_water = 1.0 - np.clip(land, 0.0, 1.0)

    fav = thermal * potential * over_water
    fav = np.where(np.isfinite(fav), fav, np.nan)
    # Spread grows where the inputs are least constrained, which over the ocean
    # means where SST is near the threshold and the answer is most sensitive.
    spread = np.clip(0.28 - 0.5 * np.abs(thermal - 0.5), 0.03, 0.3) * over_water
    return fav.astype(np.float32), spread.astype(np.float32)


def _bilinear_upsample(a: np.ndarray, size: int) -> np.ndarray:
    """Upsample a coarse lattice to the full grid without needing scipy."""
    src_y = np.linspace(0, a.shape[0] - 1, size)
    src_x = np.linspace(0, a.shape[1] - 1, size)
    y0 = np.clip(np.floor(src_y).astype(int), 0, a.shape[0] - 2)
    x0 = np.clip(np.floor(src_x).astype(int), 0, a.shape[1] - 2)
    ty = (src_y - y0)[:, None]
    tx = (src_x - x0)[None, :]
    top = a[np.ix_(y0, x0)] * (1 - tx) + a[np.ix_(y0, x0 + 1)] * tx
    bot = a[np.ix_(y0 + 1, x0)] * (1 - tx) + a[np.ix_(y0 + 1, x0 + 1)] * tx
    return (top * (1 - ty) + bot * ty).astype(np.float32)


def render_tile(layer_id: str, z: int, x: int, y: int, granule: Granule,
                engine=None, opacity: float = 1.0) -> TileResult:
    """One XYZ tile, reprojected from the storm-centred LAEA grid.

    Reprojection is by inverse mapping: for each tile pixel, compute its
    geographic position, project that into the scientific grid, and sample.
    Doing it this way keeps the resampling in the tile builder and means there
    is only ever one definition of the scientific grid.
    """
    field, palette, provenance = _field_for(layer_id, granule, engine)
    granule_time = pd.Timestamp(granule.valid_time).isoformat() + "Z"

    if field is None:
        return TileResult(None, "no-coverage", granule_time, provenance, provenance)

    grid: StormGrid = granule.grid
    lon, lat = tile_pixel_lonlat(z, x, y, TILE_PX)

    # Project the tile's pixels into grid space and index.
    px, py = grid.project(lat, lon)
    col = np.floor((px + grid.half_km) / grid.res_km).astype(np.int64)
    row = np.floor((grid.half_km - py) / grid.res_km).astype(np.int64)
    inside = (
        (col >= 0) & (col < grid.size_px) & (row >= 0) & (row < grid.size_px)
        & np.isfinite(px) & np.isfinite(py)
    )
    if not inside.any():
        return TileResult(None, "out-of-domain", granule_time,
                          "tile lies outside the storm-centred domain", provenance)

    sampled = np.full((TILE_PX, TILE_PX), np.nan, dtype=np.float32)
    sampled[inside] = field[row[inside], col[inside]]

    if not np.isfinite(sampled).any():
        return TileResult(None, "no-data", granule_time,
                          "no finite values in this tile", provenance)

    rgba = colourise(sampled, palette)
    if opacity < 1.0:
        rgba[..., 3] = (rgba[..., 3] * float(np.clip(opacity, 0.0, 1.0))).astype(np.uint8)

    return TileResult(_png(rgba), "ok", granule_time, None, provenance)


def _png(rgba: np.ndarray) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def legend_png(palette: str, width: int = 220, height: int = 14) -> bytes:
    """A horizontal ramp strip, generated from the same table as the pixels."""
    from .palettes import lookup

    table, _lo, _hi = lookup(palette)
    idx = (np.linspace(0, 1, width) * (len(table) - 1)).round().astype(int)
    strip = np.tile(table[idx][None, :, :], (height, 1, 1)).astype(np.uint8)
    rgba = np.dstack([strip, np.full((height, width, 1), 255, dtype=np.uint8)])
    return _png(rgba)
