"""The environmental predictor vector.

Fourteen features, in the order the tabular branch expects them. Which of them
are real matters more than how many there are, so the provenance is recorded per
feature and surfaced on the methods page rather than buried here.

Real, from IBTrACS
    latitude, storm_motion_u, storm_motion_v, prior_12h_intensity_trend,
    distance_to_coast

Real, from Natural Earth
    land_fraction

Synthetic, from the parametric forward model
    sst, tchp, potential_intensity, shear_200_850, rh_mid, divergence_200,
    sounder_stability_index, sounder_midlevel_moisture

The synthetic ones would come from ERA5 and the MOSDAC Level 2 tier given
credentials. `from_era5()` is the swap-in point and it takes the same shape.

The leakage rule
----------------
No feature may be a function of the intensity at any time after the valid time.
This is the constraint that keeps the forecast metrics meaningful. It would be
easy, and fatal, to derive a synthetic shear field from the intensity change the
model is supposed to predict: the RI head would score beautifully and would have
learned nothing except how this file works.

So the synthetic environmental fields are functions of position, calendar month,
and the storm's own past track only. The consequence is that they carry little
forecast signal, which is the honest outcome. The forecast skill this project
reports comes from the real predictors, which is the same information CLIPER
uses, and that is why CLIPER is the baseline it has to beat.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..ingest import synth
from .geometry import land_mask

FEATURE_PROVENANCE = {
    "shear_200_850": "synthetic",
    "rh_mid": "synthetic",
    "sst": "synthetic",
    "tchp": "synthetic",
    "potential_intensity": "synthetic",
    "divergence_200": "synthetic",
    "storm_motion_u": "real:ibtracs",
    "storm_motion_v": "real:ibtracs",
    "latitude": "real:ibtracs",
    "prior_12h_intensity_trend": "real:ibtracs",
    "sounder_stability_index": "synthetic",
    "sounder_midlevel_moisture": "synthetic",
    "land_fraction": "real:natural_earth",
    "distance_to_coast": "real:ibtracs",
}
assert list(FEATURE_PROVENANCE) == synth.TABULAR_FEATURES

# Rough per-feature ranges, used to standardise inputs and to bound the
# out-of-distribution check on uploaded tables.
FEATURE_RANGE = {
    "shear_200_850": (0.0, 60.0),
    "rh_mid": (10.0, 95.0),
    "sst": (18.0, 33.0),
    "tchp": (0.0, 160.0),
    "potential_intensity": (20.0, 180.0),
    "divergence_200": (-8e-5, 8e-5),
    "storm_motion_u": (-35.0, 35.0),
    "storm_motion_v": (-35.0, 35.0),
    "latitude": (0.0, 30.0),
    "prior_12h_intensity_trend": (-40.0, 40.0),
    "sounder_stability_index": (3.0, 9.0),
    "sounder_midlevel_moisture": (10.0, 95.0),
    "land_fraction": (0.0, 1.0),
    "distance_to_coast": (-600.0, 900.0),
}


def _synoptic_field(name: str, lat: float, lon: float, when: pd.Timestamp) -> float:
    """A smooth synoptic field sampled at a point.

    Deterministic in (name, position, day) so a rebuild reproduces the archive,
    and continuous in space and time so consecutive fixes see a coherent
    environment rather than independent noise. It has no knowledge of the storm
    at all, which is the point.
    """
    day = when.dayofyear
    month = when.month
    rng = np.random.default_rng(abs(hash((name, when.year, day // 3))) % (2**32))
    # Two large-scale waves plus a slowly varying offset.
    phase = rng.uniform(0, 2 * np.pi, 3)
    wave = (
        np.sin(np.radians(lon) * 3.1 + phase[0])
        + 0.7 * np.sin(np.radians(lat) * 4.4 + phase[1])
        + 0.5 * np.sin(np.radians(lon + lat) * 2.2 + phase[2])
    ) / 2.2

    if name == "shear":
        # Monsoon shear over the NIO: strong in July and August, weak in the
        # pre-monsoon and post-monsoon cyclone seasons. This seasonality is the
        # documented reason the basin has two cyclone peaks.
        seasonal = 22.0 + 16.0 * np.cos(2.0 * np.pi * (month - 7.5) / 12.0) * -1.0
        return float(np.clip(seasonal + 9.0 * wave + 0.35 * abs(lat - 12.0), 1.0, 58.0))
    if name == "rh_mid":
        seasonal = 62.0 + 9.0 * np.cos(2.0 * np.pi * (month - 7) / 12.0) * -1.0
        return float(np.clip(seasonal + 12.0 * wave, 15.0, 92.0))
    if name == "divergence":
        return float(np.clip(1.4e-5 + 2.6e-5 * wave, -7e-5, 7e-5))
    raise KeyError(name)


def cold_wake(track: pd.DataFrame, upto_index: int, max_lookback: int = 16
              ) -> list[tuple[float, float, float]]:
    """Cold-wake contributions from the storm's own past positions.

    Upwelling and mixing cool the surface behind a storm, and the cooling is
    stronger for intense and slow-moving systems. Only past fixes are used, so
    the wake is causal.
    """
    out: list[tuple[float, float, float]] = []
    lo = max(0, upto_index - max_lookback)
    for j in range(lo, upto_index):
        row = track.iloc[j]
        v = float(row["vmax_kt"])
        speed = float(row["storm_speed_kt"]) if np.isfinite(row["storm_speed_kt"]) else 10.0
        # Slow storms sit over the same water and cool it more.
        strength = 0.028 * v * (10.0 / max(speed, 3.0)) ** 0.55
        age = upto_index - j
        out.append((float(row["lat"]), float(row["lon"]), float(strength * np.exp(-age / 9.0))))
    return out


def sst_at(lat: float, lon: float, when: pd.Timestamp,
           wake: list[tuple[float, float, float]]) -> float:
    """Sea surface temperature at the storm centre, in degrees Celsius."""
    from ..grid import haversine_km

    seasonal = 1.15 * np.cos(2.0 * np.pi * (when.month - 5) / 12.0)
    sst = 30.4 + seasonal - 0.085 * max(lat - 8.0, 0.0) ** 1.25
    sst += 0.30 * _synoptic_field("rh_mid", lat, lon, when) / 62.0 - 0.30
    for wlat, wlon, strength in wake:
        d = float(haversine_km(lat, lon, wlat, wlon))
        sst -= strength * np.exp(-((d / 110.0) ** 2))
    return float(np.clip(sst, 18.0, 32.5))


def tchp_from_sst(sst_c: float, lat: float) -> float:
    """Tropical cyclone heat potential, kJ cm-2.

    A proxy: the heat content above the 26 degree isotherm, estimated from the
    surface temperature and a latitudinal mixed-layer depth. The real product
    needs an ocean analysis, and the layer label on the map says which product
    was used. Here that label reads synthetic.
    """
    excess = max(sst_c - 26.0, 0.0)
    mixed_layer_m = 55.0 - 0.9 * max(lat - 8.0, 0.0)
    return float(np.clip(excess * max(mixed_layer_m, 20.0) * 0.42, 0.0, 155.0))


def build_row(track: pd.DataFrame, i: int) -> dict:
    """The full 14-feature vector for one fix of one storm.

    `track` is a single storm's fixes sorted by time; `i` indexes the valid time.
    """
    row = track.iloc[i]
    lat, lon = float(row["lat"]), float(row["lon"])
    when = pd.Timestamp(row["valid_time"])
    vmax = float(row["vmax_kt"])

    wake = cold_wake(track, i)
    sst = sst_at(lat, lon, when, wake)
    shear = _synoptic_field("shear", lat, lon, when)
    rh = _synoptic_field("rh_mid", lat, lon, when)
    div = _synoptic_field("divergence", lat, lon, when)

    rng = np.random.default_rng(abs(hash((str(row["sid"]), when.value))) % (2**32))
    profile = synth.sounder_profile(sst, vmax, rh, rng)

    lf = float(land_mask().sample(lat, lon))
    motion_u = row["storm_motion_u_kt"]
    motion_v = row["storm_motion_v_kt"]

    return {
        "shear_200_850": shear,
        "rh_mid": rh,
        "sst": sst,
        "tchp": tchp_from_sst(sst, lat),
        "potential_intensity": float(synth.potential_intensity_kt(sst)),
        "divergence_200": div,
        "storm_motion_u": float(motion_u) if np.isfinite(motion_u) else 0.0,
        "storm_motion_v": float(motion_v) if np.isfinite(motion_v) else 0.0,
        "latitude": lat,
        "prior_12h_intensity_trend": float(row["trend_12h_kt"]),
        "sounder_stability_index": profile["stability_index"],
        "sounder_midlevel_moisture": profile["midlevel_moisture"],
        "land_fraction": lf,
        "distance_to_coast": float(row["dist2land_km"]),
    }


def build_table(labels: pd.DataFrame) -> pd.DataFrame:
    """The environmental table for every fix in the label set."""
    frames = []
    for sid, g in labels.groupby("sid", sort=False):
        g = g.sort_values("valid_time").reset_index(drop=True)
        rows = [build_row(g, i) for i in range(len(g))]
        tab = pd.DataFrame(rows)
        tab.insert(0, "sid", sid)
        tab.insert(1, "valid_time", g["valid_time"].to_numpy())
        frames.append(tab)
    return pd.concat(frames, ignore_index=True)


def standardise(x: np.ndarray, features: list[str] | None = None) -> np.ndarray:
    """Map each feature onto roughly [-1, 1] using its declared range.

    Fixed ranges rather than dataset statistics, so the same transform applies to
    an uploaded table without having to ship a scaler alongside the weights.
    """
    features = features or synth.TABULAR_FEATURES
    lo = np.array([FEATURE_RANGE[f][0] for f in features], dtype=np.float32)
    hi = np.array([FEATURE_RANGE[f][1] for f in features], dtype=np.float32)
    return (2.0 * (np.asarray(x, dtype=np.float32) - lo) / (hi - lo) - 1.0).astype(np.float32)


def from_era5(*_args, **_kwargs):
    """Swap-in point for real ERA5 and MOSDAC Level 2 environmental fields.

    Must return the same 14 columns in the same order, so the model does not
    change when the data becomes real. See docs/RUNBOOK.md for the cdsapi
    request and the MOSDAC Level 2 profiles.
    """
    raise NotImplementedError(
        "Requires a CDS API key and a MOSDAC account. See docs/RUNBOOK.md."
    )
