"""Reader for the materialised cube.

Presents the same interface as the lazy `GranuleStore` so nothing above it
changes. The lazy store generates granules on demand and is what the API uses,
since it serves scattered single timesteps. This reader memory-maps a prebuilt
array and is what training uses, since it sweeps the whole archive many times.

Same data either way, and there is a test asserting that.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

from .. import config as C
from .store import CHANNELS, N_CH

log = logging.getLogger(__name__)


class MaterialisedCube:
    """Memory-mapped (fix, channel, y, x) granules plus mask, ages and predictors."""

    def __init__(self, tier: str = "archive", size_px: int = 96):
        tag = f"{tier}_{size_px}"
        self.index_path = C.CUBE_DIR / f"index_{tag}.json"
        if not self.index_path.exists():
            raise FileNotFoundError(
                f"{self.index_path} not found. Build it with:\n"
                f"  python scripts/build_cube.py --size {size_px} --tier {tier}"
            )
        self.index = json.loads(self.index_path.read_text(encoding="utf-8"))
        self.tier = tier
        self.size_px = size_px

        f = self.index["files"]
        # mmap_mode keeps the file on disk and pages in only what a batch
        # touches, so a cube larger than RAM still trains.
        self.data = np.load(C.CUBE_DIR / f["granules"], mmap_mode="r")
        self.mask = np.load(C.CUBE_DIR / f["mask"]).astype(np.float32)
        self.ages = np.load(C.CUBE_DIR / f["age"])
        self.env = np.load(C.CUBE_DIR / f["env"])

        self.labels = pd.read_csv(
            C.LABELS_DIR / f"cube_labels_{tag}.csv", parse_dates=["valid_time"])
        self._local = (
            self.labels.groupby("sid", sort=False).cumcount().to_numpy()
        )
        self._row_of: dict[tuple[str, int], int] = {
            (str(r["sid"]), int(r["local_index"])): int(r["row"])
            for r in self.index["rows"]
        }
        self._absent = self.index.get("absent_reasons", {})
        log.info("cube loaded: %s, %d fixes, %d px",
                 tier, self.index["n_fixes"], size_px)

    def __len__(self) -> int:
        return int(self.index["n_fixes"])

    def row_for(self, sid: str, local_index: int) -> int | None:
        return self._row_of.get((sid, local_index))

    def absent_reason(self, row: int) -> dict:
        return self._absent.get(str(row), {})

    def sequence(self, sid: str, local_index: int, seq_len: int = C.SEQ_LEN
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Frames, mask and offsets for a sequence ending at local_index.

        Frames step backwards on the fixed 3-hour grid. A frame before the
        storm's first fix is marked absent across every channel and its offset
        pushed far out, rather than being padded with the earliest frame, which
        would teach the model that a storm's history repeats.
        """
        frames = np.zeros((seq_len, N_CH, self.size_px, self.size_px), dtype=np.float32)
        mask = np.zeros((seq_len, N_CH), dtype=np.float32)
        offsets = np.full((seq_len, N_CH), 10_000.0, dtype=np.float32)

        for k in range(seq_len):
            want = local_index - (seq_len - 1 - k)
            if want < 0:
                continue
            row = self.row_for(sid, want)
            if row is None:
                continue
            frames[k] = self.data[row].astype(np.float32)
            mask[k] = self.mask[row]
            age = np.nan_to_num(self.ages[row], nan=10_000.0)
            # Add the gap between this frame's slot and the requested time, so
            # staleness is measured from the sequence's own end.
            gap = (seq_len - 1 - k) * C.SEQ_STEP_HOURS * 60.0
            offsets[k] = np.where(self.mask[row] > 0.5, age + gap, 10_000.0)
        return frames, mask, offsets

    def tabular(self, sid: str, local_index: int) -> np.ndarray:
        row = self.row_for(sid, local_index)
        if row is None:
            return np.full(self.env.shape[1], np.nan, dtype=np.float32)
        return self.env[row]
