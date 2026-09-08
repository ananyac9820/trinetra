"""Paths, domain constants and runtime switches.

Every heavy dependency in this project is optional. The stack described in Part
VIII is what runs in the full Docker Compose deployment; the same code runs with
none of it installed, on a laptop with no network, which is the configuration the
demo has to survive. `capabilities()` reports which tier is actually active so
the UI can say so rather than imply the full stack is present.
"""

from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
DATA_DIR = Path(os.environ.get("TRINETRA_DATA", REPO_ROOT / "data"))

RAW_DIR = DATA_DIR / "raw"
INTERIM_DIR = DATA_DIR / "interim"
CUBE_DIR = DATA_DIR / "cube"
LABELS_DIR = DATA_DIR / "labels"
TILE_DIR = DATA_DIR / "tiles"
MODEL_DIR = DATA_DIR / "models"
FIXTURE_DIR = DATA_DIR / "fixtures"

for _d in (RAW_DIR, INTERIM_DIR, CUBE_DIR, LABELS_DIR, TILE_DIR, MODEL_DIR):
    _d.mkdir(parents=True, exist_ok=True)

IBTRACS_CSV = RAW_DIR / "ibtracs" / "ibtracs.NI.list.v04r01.csv"
LABELS_PARQUET = LABELS_DIR / "besttrack_nio.parquet"
LABELS_CSV = LABELS_DIR / "besttrack_nio.csv"
STORM_INDEX_CSV = LABELS_DIR / "storm_index.csv"
CUBE_PATH = CUBE_DIR / "nio_storms.zarr"
CUBE_NPZ = CUBE_DIR / "nio_storms.npz"
MANIFEST_JSON = INTERIM_DIR / "manifest.json"

# ---------------------------------------------------------------- domain

# North Indian Ocean, as used by every acquisition command in the runbook.
NIO_BBOX = (60.0, 5.0, 100.0, 28.0)  # lon_min, lat_min, lon_max, lat_max

# Canonical model grid: Lambert azimuthal equal-area, storm-centred,
# 1000 km across at 256 px, which is roughly 3.9 km per pixel. This mirrors the
# Digital Typhoon dataset construction.
GRID_SIZE_PX = 256
GRID_EXTENT_KM = 1000.0
GRID_RES_KM = GRID_EXTENT_KM / GRID_SIZE_PX

# Image branch: eight frames spanning 24 hours at a 3-hour step, matching the
# best-track fix cadence so every frame has a label to sit against.
SEQ_LEN = 8
SEQ_STEP_HOURS = 3.0

BASINS = ["bay_of_bengal", "arabian_sea", "land"]
REGIMES = ["maritime_mature", "sheared", "post_landfall_remnant", "over_land"]
DETECTION_CLASSES = ["cyclone", "monsoon_depression", "other"]
DVORAK_SCENES = [
    "curved_band",
    "shear",
    "eye",
    "central_cold_cover",
    "central_dense_overcast",
    "embedded_centre",
    "irregular_cdo",
]

MODEL_VERSION = "trinetra-0.4.1"

# Basin presets offered by the Explorer viewport control.
BASIN_PRESETS = {
    "bay_of_bengal": {"label": "Bay of Bengal", "bbox": [78.0, 5.0, 96.0, 23.0]},
    "arabian_sea": {"label": "Arabian Sea", "bbox": [55.0, 5.0, 78.0, 26.0]},
    "nio": {"label": "Full NIO domain", "bbox": [55.0, 2.0, 100.0, 30.0]},
    "northwest_india": {
        "label": "Northwest India (land transition)",
        "bbox": [66.0, 20.0, 78.0, 30.0],
    },
}

# ---------------------------------------------------------------- runtime

MODE = os.environ.get("TRINETRA_MODE", "replay").lower()  # live | replay
REDIS_URL = os.environ.get("TRINETRA_REDIS_URL", "")
DATABASE_URL = os.environ.get("TRINETRA_DATABASE_URL", "")
TILE_CACHE_TTL_S = int(os.environ.get("TRINETRA_TILE_TTL", "120"))
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "TRINETRA_CORS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
]

# Out-of-distribution gate. Above this Mahalanobis score the system abstains
# from a numeric estimate and returns analogues instead.
OOD_THRESHOLD = 3.0
# Operational RI issue threshold, tuned on held-out seasons by the calibration
# step rather than chosen by hand.
RI_THRESHOLD_DEFAULT = 0.45
# Above this method spread the Disagreement Engine raises an alert.
DISAGREEMENT_ALERT_KT = 5.0


def _have(mod: str) -> bool:
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


@dataclass(frozen=True)
class Capabilities:
    """What is actually installed, so nothing has to be claimed on faith."""

    torch: bool = field(default_factory=lambda: _have("torch"))
    onnxruntime: bool = field(default_factory=lambda: _have("onnxruntime"))
    satpy: bool = field(default_factory=lambda: _have("satpy"))
    pyresample: bool = field(default_factory=lambda: _have("pyresample"))
    xarray: bool = field(default_factory=lambda: _have("xarray"))
    zarr: bool = field(default_factory=lambda: _have("zarr"))
    rasterio: bool = field(default_factory=lambda: _have("rasterio"))
    redis: bool = field(default_factory=lambda: _have("redis"))
    psycopg: bool = field(default_factory=lambda: _have("psycopg"))
    faiss: bool = field(default_factory=lambda: _have("faiss"))
    xgboost: bool = field(default_factory=lambda: _have("xgboost"))
    shap: bool = field(default_factory=lambda: _have("shap"))

    @property
    def store_backend(self) -> str:
        return "postgis+timescale" if (self.psycopg and DATABASE_URL) else "sqlite+parquet"

    @property
    def queue_backend(self) -> str:
        return "redis-streams" if (self.redis and REDIS_URL) else "asyncio-inproc"

    @property
    def grid_backend(self) -> str:
        return "zarr" if self.zarr else "npz"

    @property
    def tile_backend(self) -> str:
        return "rio-cogeo" if self.rasterio else "numpy+pillow"

    @property
    def inference_backend(self) -> str:
        if self.onnxruntime:
            return "onnxruntime"
        return "pytorch" if self.torch else "unavailable"

    def as_dict(self) -> dict:
        d = {k: getattr(self, k) for k in self.__dataclass_fields__}
        d.update(
            store_backend=self.store_backend,
            queue_backend=self.queue_backend,
            grid_backend=self.grid_backend,
            tile_backend=self.tile_backend,
            inference_backend=self.inference_backend,
        )
        return d


CAPS = Capabilities()
