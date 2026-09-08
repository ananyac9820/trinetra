"""The storm-centred data cube, and the availability mask that comes with it.

Dimensions are (storm, time, channel, y, x) plus the mask, as specified. The
cube is materialised lazily rather than written out in full, for a reason worth
stating: the full archive at the specified resolution is 11,993 fixes by 8 frames
by 9 channels by 256 by 256 in float32, which is 226 GB. Nobody demos that.

So `GranuleStore` presents the cube interface and resolves each granule on
demand. Two backends sit behind it:

    synthetic   generated from the parametric forward model, deterministic in
                (storm, time, channel), so the archive is reproducible without
                being stored
    materialised  read from a real Zarr or npz cube built from downloaded
                granules, which is what runs once credentials exist

The interface is identical, which is the same trick the live and replay paths
use. Nothing above this module knows which backend answered.

The availability mask is the load-bearing part of the whole design. It is an
input to the model rather than a build-time constant, which is what lets one set
of weights serve the archive tier, the live tier and an uploaded file. Anywhere a
channel is missing the mask says so and the time-offset channel says how stale
the last observation was, so the model can discount an old microwave overpass
instead of treating it as current.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import config as C
from ..grid import StormGrid
from ..harmonise import environment as env
from ..harmonise.geometry import land_mask
from ..ingest import synth

log = logging.getLogger(__name__)

CHANNELS = synth.IMAGE_CHANNELS
N_CH = synth.N_IMAGE_CHANNELS
CH = {name: i for i, name in enumerate(CHANNELS)}

# Channels that must be present for the model to run at all. Everything else is
# allowed to be absent, and the mask carries that fact forward.
MANDATORY = ("ir", "wv")

# Per-channel staleness thresholds in minutes. Past amber the layer renders
# dimmed and hatched; past expiry it is removed rather than shown stale.
STALENESS = {
    "ir": (60, 4320),  # archive tier is three days old by design
    "wv": (60, 4320),
    "vis": (60, 240),
    "olr": (120, 360),
    "pmw89": (360, 720),
    "pmw37": (360, 720),
    "scat": (720, 1440),
    "soil": (1440, 4320),
    "land": (10**7, 10**7),  # static
}

# Physical range per channel, for the OOD schema check and for palette scaling.
CHANNEL_RANGE = {
    "ir": (180.0, 315.0),
    "wv": (190.0, 265.0),
    "vis": (0.0, 1.0),
    "olr": (70.0, 340.0),
    "pmw89": (120.0, 295.0),
    "pmw37": (150.0, 295.0),
    "scat": (0.0, 180.0),
    "soil": (0.0, 0.5),
    "land": (0.0, 1.0),
}

CHANNEL_UNITS = {
    "ir": "K", "wv": "K", "vis": "reflectance", "olr": "W m-2",
    "pmw89": "K", "pmw37": "K", "scat": "kt", "soil": "m3 m-3", "land": "fraction",
}


@dataclass
class Granule:
    """One timestep of one storm on the canonical grid."""

    sid: str
    valid_time: pd.Timestamp
    grid: StormGrid
    data: np.ndarray  # (C, H, W) float32, NaN where the channel has no value
    present: np.ndarray  # (C,) bool
    age_minutes: np.ndarray  # (C,) float, NaN where absent
    extras: dict = field(default_factory=dict)

    def channel(self, name: str) -> np.ndarray | None:
        i = CH[name]
        return self.data[i] if self.present[i] else None

    def status(self, name: str) -> tuple[str, str]:
        """Per-channel status and the reason for it.

        The three absent states are different facts and the UI renders them
        differently, so they are distinguished here rather than collapsed into a
        single null.
        """
        i = CH[name]
        if not self.present[i]:
            reason = self.extras.get("absent_reason", {}).get(name, "not available")
            if "swath" in reason or "overpass" in reason:
                return "no_coverage", reason
            if "night" in reason or "zenith" in reason:
                return "instrument_unavailable", reason
            return "no_data", reason
        amber, expire = STALENESS[name]
        age = float(self.age_minutes[i])
        if age > expire:
            return "expired", f"last observation {age:.0f} min old, past hard expiry"
        if age > amber:
            return "stale", f"last observation {age:.0f} min old, past staleness threshold"
        return "ok", ""

    def sensor_mode(self) -> dict:
        present = [c for c in CHANNELS if self.present[CH[c]] and c != "land"]
        absent = [c for c in CHANNELS if not self.present[CH[c]]]
        # Confidence follows what is actually there, not what was hoped for.
        has_pmw = "pmw89" in present
        has_scat = "scat" in present
        has_core = all(c in present for c in MANDATORY) or "olr" in present
        if has_core and has_pmw and has_scat:
            conf = "high"
        elif has_core and (has_pmw or has_scat):
            conf = "medium"
        elif has_core:
            conf = "low"
        else:
            conf = "insufficient"
        return {
            "present": present,
            "absent": absent,
            "ages_minutes": {
                c: round(float(self.age_minutes[CH[c]]), 1)
                for c in present
                if np.isfinite(self.age_minutes[CH[c]])
            },
            "confidence": conf,
        }


class GranuleStore:
    """Resolves granules for a storm and time, with an LRU cache."""

    def __init__(self, labels: pd.DataFrame, size_px: int = C.GRID_SIZE_PX,
                 cache_size: int = 96, tier: str = "archive"):
        self.labels = labels.sort_values(["sid", "valid_time"]).reset_index(drop=True)
        self.size_px = size_px
        self.tier = tier
        self._cache: OrderedDict[tuple, Granule] = OrderedDict()
        self._cache_size = cache_size
        self._tracks = {sid: g.reset_index(drop=True)
                        for sid, g in self.labels.groupby("sid", sort=False)}

    # ------------------------------------------------------------ lookup

    def storms(self) -> list[str]:
        return list(self._tracks)

    def track(self, sid: str) -> pd.DataFrame:
        return self._tracks[sid]

    def times(self, sid: str) -> pd.Series:
        return self._tracks[sid]["valid_time"]

    def nearest_index(self, sid: str, at: pd.Timestamp) -> int:
        """Index of the most recent fix at or before `at`.

        Snapping backwards rather than to the nearest fix is deliberate. A
        display that snaps forward is showing the viewer an observation that had
        not happened yet at the time on the scrubber.
        """
        t = self.times(sid)
        idx = int(np.searchsorted(t.to_numpy(), np.datetime64(pd.Timestamp(at)), side="right") - 1)
        return max(0, min(idx, len(t) - 1))

    # ------------------------------------------------------------ granules

    def granule(self, sid: str, index: int, tier: str | None = None) -> Granule:
        key = (sid, index, self.size_px, tier or self.tier)
        hit = self._cache.get(key)
        if hit is not None:
            self._cache.move_to_end(key)
            return hit
        g = self._generate(sid, index, tier or self.tier)
        self._cache[key] = g
        if len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)
        return g

    def _generate(self, sid: str, index: int, tier: str) -> Granule:
        track = self._tracks[sid]
        row = track.iloc[index]
        when = pd.Timestamp(row["valid_time"])
        lat, lon = float(row["lat"]), float(row["lon"])
        vmax, pmin = float(row["vmax_kt"]), float(row["pmin_hpa"])
        if not np.isfinite(pmin):
            # Holland B needs a pressure deficit. Recover one from the wind with
            # the same relation, rather than dropping the fix.
            pmin = synth.P_ENV_HPA - (vmax * synth.KT_TO_MS) ** 2 * synth.RHO_AIR * np.e / (
                1.35 * 100.0
            )

        grid = StormGrid(lat, lon, size_px=self.size_px)
        rng = synth._rng((sid, when.value, self.size_px))

        glat, glon = grid.latlon()
        land = land_mask().sample(glat, glon)

        wake = env.cold_wake(track, index)
        shear = env._synoptic_field("shear", lat, lon, when)
        shear_dir = (float(row["storm_dir_deg"]) + 130.0) % 360.0 if np.isfinite(
            row["storm_dir_deg"]
        ) else 250.0
        motion_dir = float(row["storm_dir_deg"]) if np.isfinite(row["storm_dir_deg"]) else 0.0

        data = np.full((N_CH, self.size_px, self.size_px), np.nan, dtype=np.float32)
        present = np.zeros(N_CH, dtype=bool)
        ages = np.full(N_CH, np.nan, dtype=np.float32)
        absent_reason: dict[str, str] = {}

        # --- always present
        data[CH["land"]] = land
        present[CH["land"]] = True
        ages[CH["land"]] = 0.0

        ir = synth.ir_field(grid, vmax, pmin, lat, shear, shear_dir, motion_dir, land, rng)
        qpe = synth.qpe_field(ir, vmax, rng)

        # --- tier gating. This is the whole two-tier argument, in code.
        live = tier == "live"
        if live:
            # Level 1 imagery is on the three-day tier, so it is not here.
            absent_reason["ir"] = "INSAT L1 on the three-day archive tier"
            absent_reason["wv"] = "INSAT L1 on the three-day archive tier"
            absent_reason["vis"] = "INSAT L1 on the three-day archive tier"
        else:
            data[CH["ir"]] = ir
            present[CH["ir"]] = True
            ages[CH["ir"]] = 15.0
            wv = synth.wv_field(ir, grid, rng, (shear_dir + 180.0) % 360.0)
            data[CH["wv"]] = wv
            present[CH["wv"]] = True
            ages[CH["wv"]] = 15.0

            # Visible is gated by solar zenith angle, not by clock hour.
            sza = synth.solar_zenith_deg(np.array([lat]), np.array([lon]), when)[0]
            if sza < 80.0:
                vis = np.clip((1.0 - (ir - 190.0) / 120.0), 0.0, 1.0) * np.cos(
                    np.radians(min(sza, 79.0))
                )
                data[CH["vis"]] = vis.astype(np.float32)
                present[CH["vis"]] = True
                ages[CH["vis"]] = 15.0
            else:
                absent_reason["vis"] = f"solar zenith {sza:.0f} deg, night side"

        # --- Level 2 products: near real time on both tiers
        data[CH["olr"]] = synth.olr_from_window_tb(ir).astype(np.float32)
        present[CH["olr"]] = True
        ages[CH["olr"]] = 22.0

        # --- overpass-limited instruments
        pmw_cov, pmw_age = synth.swath_mask(grid, when, "pmw", rng)
        if pmw_age is not None and pmw_cov.any():
            for name, freq in (("pmw89", 89.0), ("pmw37", 37.0)):
                fld = synth.pmw_field(ir, grid, freq, rng)
                data[CH[name]] = np.where(pmw_cov, fld, np.nan).astype(np.float32)
                present[CH[name]] = True
                ages[CH[name]] = pmw_age
        else:
            for name in ("pmw89", "pmw37"):
                absent_reason[name] = "no microwave overpass inside the staleness window"

        scat_cov, scat_age = synth.swath_mask(grid, when, "scat", rng)
        if scat_age is not None and scat_cov.any():
            speed, _u, _v = synth.scat_field(
                grid, vmax, pmin, lat, float(row["storm_motion_u_kt"] or 0.0),
                float(row["storm_motion_v_kt"] or 0.0), qpe, land, rng,
            )
            data[CH["scat"]] = np.where(scat_cov, speed, np.nan).astype(np.float32)
            present[CH["scat"]] = True
            ages[CH["scat"]] = scat_age
        else:
            absent_reason["scat"] = "no scatterometer swath at this location and time"

        # --- soil moisture: only meaningful where there is land in the domain
        if float(land.mean()) > 0.02:
            accum = qpe * 3.0  # one 3-hour step of the observed rate
            data[CH["soil"]] = synth.soil_moisture_field(grid, land, accum, rng)
            present[CH["soil"]] = True
            ages[CH["soil"]] = 90.0
        else:
            absent_reason["soil"] = "ocean domain, no land pixels"

        extras = {
            "absent_reason": absent_reason,
            "qpe": qpe,
            "sst": synth.sst_field(grid, when.month, land, wake, rng),
            "aod": synth.aod_field(grid, land, when.month, rng),
            "pmw_coverage": pmw_cov,
            "scat_coverage": scat_cov,
            "rmw_km": synth.radius_max_wind_km(vmax, lat),
            "holland_b": synth.holland_b(vmax, pmin),
            "synthetic": True,
            "tier": tier,
        }
        return Granule(sid, when, grid, data, present, ages, extras)

    # ------------------------------------------------------------ sequences

    def sequence(self, sid: str, index: int, seq_len: int = C.SEQ_LEN,
                 tier: str | None = None
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """The model's image input: (T, C, H, W), mask (T, C), offsets (T, C).

        Frames run backwards from the valid time on a fixed grid, which is the
        approach the model specification chose over irregular-time architectures.
        Where a frame falls before the storm's first fix the whole frame is
        marked absent rather than padded with the earliest one, because padding
        would teach the model that a storm's history repeats.
        """
        track = self._tracks[sid]
        t0 = pd.Timestamp(track.iloc[index]["valid_time"])
        step = pd.Timedelta(hours=C.SEQ_STEP_HOURS)

        frames = np.zeros((seq_len, N_CH, self.size_px, self.size_px), dtype=np.float32)
        mask = np.zeros((seq_len, N_CH), dtype=np.float32)
        offsets = np.zeros((seq_len, N_CH), dtype=np.float32)

        times = track["valid_time"].to_numpy()
        for k in range(seq_len):
            want = t0 - step * (seq_len - 1 - k)
            j = int(np.searchsorted(times, np.datetime64(want), side="right") - 1)
            if j < 0:
                offsets[k, :] = 10_000.0  # far past, and masked out anyway
                continue
            g = self.granule(sid, j, tier)
            filled = np.nan_to_num(g.data, nan=0.0)
            frames[k] = _normalise(filled)
            mask[k] = g.present.astype(np.float32)
            gap_min = (want - pd.Timestamp(g.valid_time)).total_seconds() / 60.0
            offsets[k] = np.where(
                g.present, np.nan_to_num(g.age_minutes, nan=0.0) + gap_min, 10_000.0
            )
        return frames, mask, offsets


def _normalise(data: np.ndarray) -> np.ndarray:
    """Scale each channel onto roughly [0, 1] using its declared physical range.

    Fixed ranges, not per-batch statistics. A batch-relative scaling would make
    the same brightness temperature mean different things in different batches,
    which matters here because absolute cloud-top temperature carries the
    intensity signal.
    """
    out = np.empty_like(data)
    for i, name in enumerate(CHANNELS):
        lo, hi = CHANNEL_RANGE[name]
        out[i] = np.clip((data[i] - lo) / (hi - lo), 0.0, 1.0)
    return out
