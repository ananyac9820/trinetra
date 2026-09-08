"""Parametric granule generator for the storm-centred grid.

What this is and is not
-----------------------
This module is a forward model. It takes the real best-track state at a fix
(position, Vmax, Pmin, motion, distance to land) and produces the gridded fields
a satellite would have seen: infrared and water vapour brightness temperature,
outgoing longwave radiation, precipitation rate, sea surface temperature, passive
microwave, scatterometer wind, soil moisture and aerosol optical depth.

It exists because the real fields need credentials this build did not have. MOSDAC
Level 1 is on a three-day tier, TC-PRIMED and PO.DAAC need Earthdata Login,
Copernicus Marine needs registration and ERA5 needs a CDS key. The clients for
all of those are written and sit next to this file. They need accounts, not code.

Two consequences, and both matter more than the code does.

Anything the model learns about estimating current intensity from these images is
partly the inverse of this forward model. The analysis metric therefore measures
whether the pipeline works, not whether the science does, and it is reported that
way on the methods page. Swap in real granules and the number becomes a claim.

Nothing here is allowed to see the future. Every field is a function of the state
at or before the valid time. If the environmental predictors were generated from
the intensity 24 hours ahead, the RI head would look excellent and would have
learned nothing, so the forecast metrics stay honest by construction rather than
by inspection.

Physical relations used
-----------------------
Holland (1980) pressure-wind profile, with B recovered from the pressure deficit
rather than assumed. Willoughby and Rahn (2004) for the radius of maximum wind.
DeMaria and Kaplan (1994) for maximum potential intensity from sea surface
temperature. Each is named at the point of use.
"""

from __future__ import annotations

import numpy as np

from .. import config as C
from ..grid import StormGrid

KT_TO_MS = 0.514444
RHO_AIR = 1.15  # kg m-3, standard for Holland B recovery
P_ENV_HPA = 1010.0  # environmental pressure for the NIO
STEFAN = 5.670374e-8

# Channel order in the image branch, per the model specification.
IMAGE_CHANNELS = [
    "ir",  # 0  INSAT IR 10.8 um brightness temperature   [mandatory]
    "wv",  # 1  INSAT WV 6.7 um brightness temperature    [mandatory]
    "vis",  # 2  INSAT VIS / SWIR                          [daylight-gated]
    "olr",  # 3  INSAT OLR                                 [live tier]
    "pmw89",  # 4  PMW 89 to 91 GHz                          [overpass-limited]
    "pmw37",  # 5  PMW 37 GHz                                [overpass-limited]
    "scat",  # 6  Scatterometer wind speed                  [swath-limited]
    "soil",  # 7  Soil moisture                             [land regime]
    "land",  # 8  Land mask                                 [always present]
]
N_IMAGE_CHANNELS = len(IMAGE_CHANNELS)

# Tabular predictors, in the order the model expects them.
TABULAR_FEATURES = [
    "shear_200_850",
    "rh_mid",
    "sst",
    "tchp",
    "potential_intensity",
    "divergence_200",
    "storm_motion_u",
    "storm_motion_v",
    "latitude",
    "prior_12h_intensity_trend",
    "sounder_stability_index",
    "sounder_midlevel_moisture",
    "land_fraction",
    "distance_to_coast",
]
N_TABULAR = len(TABULAR_FEATURES)

# Overpass cadence. Realistic rather than convenient: microwave is absent at most
# timesteps, which is the whole reason the availability mask exists.
PMW_OVERPASSES_PER_DAY = 5.0
SCAT_OVERPASSES_PER_DAY = 3.0
PMW_SWATH_WIDTH_KM = 700.0
SCAT_SWATH_WIDTH_KM = 550.0

# Rain rate above which a scatterometer cell is rain-flagged. Flagged cells are
# returned as missing, never as zero wind.
SCAT_RAIN_FLAG_MM_H = 6.0


def _rng(seed_parts: tuple) -> np.random.Generator:
    """Deterministic per-granule generator, so a rebuild reproduces the archive."""
    h = abs(hash(seed_parts)) % (2**32)
    return np.random.default_rng(h)


# --------------------------------------------------------------- storm physics


def holland_b(vmax_kt: float, pmin_hpa: float) -> float:
    """Holland shape parameter recovered from the pressure deficit.

    Holland (1980) gives Vmax = sqrt(B * dp / (rho * e)), so B follows from the
    two quantities best-track already reports. Clipped to the observed range;
    values outside it come from a bad Pmin rather than from a real storm.
    """
    v = max(float(vmax_kt), 1.0) * KT_TO_MS
    dp = max(P_ENV_HPA - float(pmin_hpa), 1.0) * 100.0  # Pa
    b = RHO_AIR * np.e * v * v / dp
    return float(np.clip(b, 0.8, 2.5))


def radius_max_wind_km(vmax_kt: float, lat: float) -> float:
    """Willoughby and Rahn (2004) radius of maximum wind.

    Rmw = 46.4 * exp(-0.0155 * Vmax + 0.0169 * |lat|), Vmax in m s-1, Rmw in km.
    Stronger storms have tighter cores and higher-latitude storms wider ones.
    """
    v = max(float(vmax_kt), 1.0) * KT_TO_MS
    rmw = 46.4 * np.exp(-0.0155 * v + 0.0169 * abs(float(lat)))
    return float(np.clip(rmw, 12.0, 120.0))


def holland_wind_kt(r_km: np.ndarray, vmax_kt: float, rmw_km: float, b: float) -> np.ndarray:
    """Holland (1980) radial wind profile, in knots.

    V(r) = Vmax * sqrt( (Rmw/r)^B * exp(1 - (Rmw/r)^B) )

    The profile is singular at r = 0, so the innermost pixels are filled by
    linear spin-up from the centre to the radius of maximum wind, which is what
    the eye actually looks like.
    """
    r = np.maximum(np.asarray(r_km, dtype=float), 1e-6)
    ratio = (rmw_km / r) ** b
    with np.errstate(over="ignore", invalid="ignore"):
        v = vmax_kt * np.sqrt(np.clip(ratio * np.exp(1.0 - ratio), 0.0, None))
    inner = r < rmw_km
    v = np.where(inner, vmax_kt * (r / rmw_km), v)
    return np.nan_to_num(v, nan=0.0, posinf=vmax_kt)


def potential_intensity_kt(sst_c: float | np.ndarray) -> np.ndarray:
    """DeMaria and Kaplan (1994) maximum potential intensity from SST.

    MPI = 15.69 + 98.03 * exp(0.1806 * (SST - 30.0)), in knots.
    """
    sst = np.asarray(sst_c, dtype=float)
    return 15.69 + 98.03 * np.exp(0.1806 * (sst - 30.0))


def coldest_top_k(vmax_kt: float) -> float:
    """Coldest cloud-top brightness temperature expected at a given intensity.

    Deeper convection reaches higher and radiates colder. The relation is a
    linear fit through the range operational forecasters use, floored at 185 K
    because the tropical tropopause does not get colder than that.
    """
    return float(np.clip(219.0 - 0.26 * float(vmax_kt), 185.0, 232.0))


def olr_from_window_tb(tb_k: np.ndarray) -> np.ndarray:
    """Broadband OLR from window-channel brightness temperature.

    A two-point linear approximation, anchored at deep convection (200 K,
    95 W m-2) and clear tropical ocean (290 K, 290 W m-2). A Stefan-Boltzmann
    conversion is wrong here by roughly 40 W m-2 in the clear sky, because
    broadband OLR is not the emission of a single window channel.
    """
    return 95.0 + (290.0 - 95.0) / (290.0 - 200.0) * (np.asarray(tb_k, dtype=float) - 200.0)


# --------------------------------------------------------------- field builders


def _spiral_phase(r_km: np.ndarray, az_deg: np.ndarray, rmw_km: float,
                  n_arms: int = 2, cross_angle_deg: float = 17.0) -> np.ndarray:
    """Logarithmic spiral phase for rainbands.

    A logarithmic spiral has a constant crossing angle with the radial
    direction, which is what observed rainbands do. 15 to 20 degrees is the
    range quoted for tropical cyclone bands.
    """
    r = np.maximum(r_km, rmw_km * 0.5)
    pitch = np.tan(np.radians(cross_angle_deg))
    theta = np.radians(az_deg)
    return np.cos(n_arms * (theta - np.log(r / rmw_km) / pitch))


def _asymmetry(az_deg: np.ndarray, direction_deg: float, strength: float) -> np.ndarray:
    """Cosine asymmetry aligned with a bearing, for shear and motion effects."""
    return strength * np.cos(np.radians(az_deg - direction_deg))


def ir_field(grid: StormGrid, vmax_kt: float, pmin_hpa: float, lat: float,
             shear_kt: float, shear_dir_deg: float, motion_dir_deg: float,
             land_frac: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Infrared 10.8 um brightness temperature, in kelvin.

    Structure, from the centre outward: an eye that warms once the storm is
    strong enough to clear one, an eyewall ring of the deepest convection, a
    central dense overcast, spiral bands, then increasingly clear surroundings.
    Shear displaces the convection downshear and motion adds a forward-right
    bias, so the field is not circularly symmetric.
    """
    r = grid.radius_km()
    az = grid.azimuth_deg()
    rmw = radius_max_wind_km(vmax_kt, lat)
    t_cold = coldest_top_k(vmax_kt)

    # Background: warm sea surface seen through a clear window, cooler over land.
    t_bg = 290.0 - 4.0 * land_frac

    # Convective depth as a fraction of the full cold anomaly, by radius.
    #
    # The radii here are physical rather than multiples of Rmw. Scaling the
    # whole cloud field to the radius of maximum wind makes an intense storm
    # look tiny, because Rmw shrinks as a storm strengthens while its cirrus
    # canopy grows. Amphan had a 25 km eyewall and a shield covering most of the
    # Bay of Bengal.
    r_cdo = max(2.5 * rmw, 110.0)
    r_shield = 180.0 + 2.2 * float(vmax_kt)  # 180 km weak, roughly 470 km at 130 kt

    ring = np.exp(-(((r - rmw) / (0.75 * rmw)) ** 2))  # eyewall convection
    cdo = 1.0 / (1.0 + (r / r_cdo) ** 3)  # flat-topped overcast over the core
    shield = np.exp(-((r / r_shield) ** 1.6))  # cirrus canopy
    bands = (
        0.50
        * np.clip(_spiral_phase(r, az, max(rmw, 30.0)), 0.0, None)
        * np.exp(-r / (0.95 * r_shield))
    )
    # Combined as independent contributions rather than summed and clipped.
    # A clipped sum saturates over a wide area and flattens the core into one
    # temperature, which destroys exactly the structure the intensity signal
    # lives in. This form approaches 1 smoothly and never exceeds it.
    depth = 1.0 - (
        (1.0 - 0.58 * ring) * (1.0 - 0.72 * cdo) * (1.0 - 0.50 * shield)
        * (1.0 - np.clip(bands, 0.0, 0.9))
    )

    # An eye only clears above roughly 85 kt. Its radius sits just inside the
    # radius of maximum wind, which is at the inner edge of the eyewall, so it
    # scales with Rmw rather than being a small fraction of it.
    if vmax_kt >= 85.0:
        r_eye = rmw * (0.65 + 0.0020 * (vmax_kt - 85.0))
        clearing = np.clip(1.0 - (r / r_eye) ** 2.5, 0.0, 1.0)
        depth *= 1.0 - 0.94 * clearing

    # Shear tears the convection downshear and motion biases it forward-right.
    depth *= np.clip(
        1.0
        + _asymmetry(az, (shear_dir_deg + 180.0) % 360.0, min(shear_kt / 45.0, 0.55))
        + _asymmetry(az, (motion_dir_deg + 45.0) % 360.0, 0.12),
        0.15,
        1.6,
    )
    # Weak or heavily sheared systems never build a full canopy.
    depth *= float(np.clip(vmax_kt / 45.0, 0.22, 1.0))

    tb = t_bg - depth * (t_bg - t_cold)
    tb += _correlated_noise(grid.size_px, 6.0, rng) * 2.4  # sensor and cloud texture
    return np.clip(tb, 180.0, 315.0).astype(np.float32)


def wv_field(ir: np.ndarray, grid: StormGrid, rng: np.random.Generator,
             dry_intrusion_dir_deg: float) -> np.ndarray:
    """Water vapour 6.7 um brightness temperature, in kelvin.

    The water vapour channel is opaque at mid to upper levels, so it never sees
    the surface. Clear areas read near 245 K rather than near 290 K, and the
    channel's value is the dry slots, which is what the intrusion term adds.
    """
    az = grid.azimuth_deg()
    r = grid.radius_km()
    # Compress the IR range upward: deep convection stays cold, clear sky does not.
    wv = 245.0 - (245.0 - ir) * np.where(ir < 250.0, 0.92, 0.10)
    dry = np.clip(_asymmetry(az, dry_intrusion_dir_deg, 1.0), 0.0, None) * np.clip(
        (r - 180.0) / 320.0, 0.0, 1.0
    )
    wv += 11.0 * dry
    wv += _correlated_noise(grid.size_px, 9.0, rng) * 2.0
    return np.clip(wv, 190.0, 265.0).astype(np.float32)


def qpe_field(ir: np.ndarray, vmax_kt: float, rng: np.random.Generator,
              land_frac: np.ndarray | None = None, month: int = 6,
              over_land: bool = False) -> np.ndarray:
    """Precipitation rate in mm h-1, from cloud-top temperature.

    A power-law fit of rain rate against window brightness temperature, of the
    kind the operational GOES precipitation index uses. Zero above 245 K, rising
    steeply as the tops get colder.

    Rainfall decouples from wind after landfall
    -------------------------------------------
    Scaling rain rate by maximum wind is reasonable over water and wrong over
    land, and getting it wrong here would contradict the project's own thesis.
    Biparjoy dropped 471 mm at Ahore and breached a dam at Sanchore as a
    weakening inland remnant whose wind had already collapsed. A rain model tied
    to Vmax produces almost nothing for that system, which is exactly the
    failure that makes existing cyclone products stop being useful at the coast.

    So over land the wind scaling is replaced by a moisture-convergence term
    that does not decay with intensity. A remnant low embedded in a monsoon
    moisture field is a rainfall producer long after it stops being a cyclone,
    which is the whole reason the regime head and this channel exist.
    """
    x = np.clip((245.0 - ir) / 55.0, 0.0, 1.6)

    if over_land and land_frac is not None:
        # Monsoon-season moisture convergence, strongest in the core months.
        monsoon = 1.0 if month in (6, 7, 8, 9) else 0.55
        # Weak systems are not weak rain producers inland, so the floor is high.
        scaling = monsoon * float(np.clip(0.85 + vmax_kt / 90.0, 0.85, 1.6))
        rate = 52.0 * x**1.7 * scaling
        # Enhanced over land, retained over adjacent water.
        rate = rate * (0.55 + 0.65 * np.clip(land_frac, 0.0, 1.0))
    else:
        rate = 46.0 * x**2.1 * float(np.clip(vmax_kt / 60.0, 0.35, 1.5))

    rate = rate * (1.0 + 0.30 * _correlated_noise(ir.shape[0], 4.0, rng))
    return np.clip(rate, 0.0, 160.0).astype(np.float32)


def sst_field(grid: StormGrid, month: int, land_frac: np.ndarray,
              wake_track: list[tuple[float, float, float]],
              rng: np.random.Generator) -> np.ndarray:
    """Sea surface temperature in degrees Celsius.

    A latitudinal and seasonal warm pool, with a cold wake along the storm's own
    past track. The wake is the reason a storm can weaken over water that looked
    warm enough on yesterday's chart, and it depends only on where the storm has
    already been.
    """
    lat, _lon = grid.latlon()
    seasonal = 1.15 * np.cos(2.0 * np.pi * (month - 5) / 12.0)  # NIO peaks in May
    sst = 30.4 + seasonal - 0.085 * np.clip(lat - 8.0, 0.0, None) ** 1.25
    sst += _correlated_noise(grid.size_px, 22.0, rng) * 0.35

    for wlat, wlon, strength in wake_track:
        wx, wy = grid.project(wlat, wlon)
        if not np.isfinite(wx):
            continue
        x, y = grid.xy_km()
        d = np.hypot(x - wx, y - wy)
        sst -= strength * np.exp(-((d / 110.0) ** 2))

    sst = np.where(land_frac > 0.5, np.nan, sst)
    return sst.astype(np.float32)


def pmw_field(ir: np.ndarray, grid: StormGrid, freq_ghz: float,
              rng: np.random.Generator) -> np.ndarray:
    """Passive microwave brightness temperature, in kelvin.

    At 89 to 91 GHz the signal is ice scattering, so deep convection appears as
    a brightness depression and the channel sees the inner core through the
    cirrus canopy that blinds the infrared. At 37 GHz emission dominates and the
    contrast is weaker and smoother.
    """
    convection = np.clip((250.0 - ir) / 60.0, 0.0, 1.0)
    if freq_ghz > 60.0:
        tb = 278.0 - 95.0 * convection**1.25
        smooth = 2.0
    else:
        tb = 262.0 - 42.0 * convection
        smooth = 5.0
    tb += _correlated_noise(grid.size_px, smooth, rng) * 3.0
    return np.clip(tb, 120.0, 295.0).astype(np.float32)


def scat_field(grid: StormGrid, vmax_kt: float, pmin_hpa: float, lat: float,
               motion_u_kt: float, motion_v_kt: float, qpe: np.ndarray,
               land_frac: np.ndarray, rng: np.random.Generator
               ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Scatterometer surface wind, as (speed_kt, u_kt, v_kt).

    Holland profile for the symmetric part, plus the storm's own translation
    added to the vector field, which is why the right-hand side of a
    northward-moving storm is the strong side.

    Rain-flagged cells come back as NaN. That is the point: a rain-corrupted
    eyewall retrieval reported as zero wind is worse than no retrieval, because
    zero is a number a model will believe.
    """
    r = grid.radius_km()
    az = grid.azimuth_deg()
    rmw = radius_max_wind_km(vmax_kt, lat)
    b = holland_b(vmax_kt, pmin_hpa)

    speed = holland_wind_kt(r, vmax_kt, rmw, b)
    # Cyclonic (counter-clockwise in the northern hemisphere) with inflow.
    inflow = np.radians(22.0)
    tangential = np.radians(az) - np.pi / 2.0 + inflow
    u = speed * np.cos(tangential) + motion_u_kt * 0.55
    v = -speed * np.sin(tangential) + motion_v_kt * 0.55
    speed = np.hypot(u, v)

    speed *= 1.0 + 0.06 * _correlated_noise(grid.size_px, 8.0, rng)
    invalid = (qpe > SCAT_RAIN_FLAG_MM_H) | (land_frac > 0.5)
    speed = np.where(invalid, np.nan, speed)
    u = np.where(invalid, np.nan, u)
    v = np.where(invalid, np.nan, v)
    return speed.astype(np.float32), u.astype(np.float32), v.astype(np.float32)


def soil_moisture_field(grid: StormGrid, land_frac: np.ndarray,
                        rain_accum_mm: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Volumetric soil moisture, m3 m-3, land only.

    The brown-ocean channel. A land surface already saturated by the storm's own
    rainfall supplies latent heat that a dry surface cannot, which is the
    documented mechanism behind inland re-intensification.
    """
    base = 0.11 + 0.05 * _correlated_noise(grid.size_px, 26.0, rng)
    wet = 0.34 * np.clip(rain_accum_mm / 140.0, 0.0, 1.0)
    sm = np.clip(base + wet, 0.02, 0.48)
    return np.where(land_frac > 0.5, sm, np.nan).astype(np.float32)


def aod_field(grid: StormGrid, land_frac: np.ndarray, month: int,
              rng: np.random.Generator) -> np.ndarray:
    """Aerosol optical depth at 550 nm. Daylight only, land-weighted.

    Powers the dust module. INSAT-3D reports AOD at 10 km and 30 minutes over
    daylight scenes, so this channel is absent at night by construction.
    """
    lat, lon = grid.latlon()
    # Thar desert source region, northwest India.
    dust = np.exp(-(((lat - 27.0) / 5.0) ** 2) - (((lon - 71.5) / 6.0) ** 2))
    pre_monsoon = 1.0 if month in (4, 5, 6) else 0.45
    aod = 0.12 + 1.05 * dust * pre_monsoon * land_frac
    aod += 0.05 * _correlated_noise(grid.size_px, 18.0, rng)
    return np.clip(aod, 0.0, 2.4).astype(np.float32)


def sounder_profile(sst_c: float, vmax_kt: float, rh_mid: float,
                    rng: np.random.Generator) -> dict:
    """INSAT-3DS sounder temperature and humidity profile.

    Eighteen infrared channels retrieved onto pressure levels. The warm core is
    the signal worth having: an intensifying storm shows a positive temperature
    anomaly at 200 to 300 hPa that no imager channel can see.
    """
    levels = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100]
    # Standard tropical lapse, anchored to the sea surface.
    temp = np.array([sst_c - 2.0, sst_c - 5.0, sst_c - 11.0, sst_c - 22.0,
                     sst_c - 36.0, sst_c - 45.0, sst_c - 58.0, sst_c - 66.0,
                     sst_c - 82.0, sst_c - 95.0, sst_c - 100.0], dtype=float)
    warm_core = np.array([0, 0, 0.2, 0.7, 1.6, 2.4, 3.3, 3.0, 2.1, 0.6, 0]) * (
        vmax_kt / 100.0
    )
    temp = temp + warm_core + rng.normal(0.0, 0.45, temp.shape)

    rh = np.array([82, 84, 81, 68, rh_mid, 54, 44, 36, 26, 18, 12], dtype=float)
    rh = np.clip(rh + rng.normal(0.0, 3.2, rh.shape), 2.0, 100.0)

    # Stability: 850 to 500 hPa lapse rate, in K km-1. Larger means less stable.
    lapse = (temp[2] - temp[4]) / 3.1
    return {
        "levels_hpa": levels,
        "temperature_c": [round(float(t), 1) for t in temp],
        "rh_percent": [round(float(x)) for x in rh],
        "stability_index": round(float(lapse), 3),
        "midlevel_moisture": round(float(rh[4]), 1),
    }


# --------------------------------------------------------------- support


def _correlated_noise(size: int, length_scale_px: float, rng: np.random.Generator) -> np.ndarray:
    """Spatially correlated noise in roughly [-1, 1].

    White noise looks nothing like a satellite image. Smoothing it to a length
    scale gives texture the encoder has to work through, which is the point of
    including it at all. The smoothing is a separable box filter applied twice,
    which approximates a Gaussian without needing scipy.
    """
    field = rng.standard_normal((size, size))
    k = max(int(length_scale_px), 1)
    if k > 1:
        for _ in range(2):
            field = _box_blur(field, k)
    peak = np.abs(field).max()
    return field / peak if peak > 0 else field


def _box_blur(a: np.ndarray, k: int) -> np.ndarray:
    """Separable box blur by cumulative sums, with edge padding."""
    pad = k // 2
    out = a
    for axis in (0, 1):
        p = np.pad(out, [(pad + 1, pad) if i == axis else (0, 0) for i in range(2)],
                   mode="edge")
        cs = np.cumsum(p, axis=axis)
        hi = np.take(cs, np.arange(k, k + a.shape[axis]), axis=axis)
        lo = np.take(cs, np.arange(0, a.shape[axis]), axis=axis)
        out = (hi - lo) / k
    return out


def solar_zenith_deg(lat: np.ndarray, lon: np.ndarray, when) -> np.ndarray:
    """Solar zenith angle, for gating the visible channel.

    A visible channel at night is not dark data, it is absent data, and the
    availability mask has to say so. This is the gate that makes it say so.
    """
    import datetime as dt

    when = when if isinstance(when, dt.datetime) else _to_datetime(when)
    doy = when.timetuple().tm_yday
    frac_hour = when.hour + when.minute / 60.0 + when.second / 3600.0

    decl = np.radians(23.44) * np.sin(2.0 * np.pi * (284 + doy) / 365.0)
    # Local solar time from longitude, ignoring the equation of time, which is
    # worth at most a few minutes and cannot flip a day-night decision.
    lst = frac_hour + np.asarray(lon, dtype=float) / 15.0
    hour_angle = np.radians(15.0 * (lst - 12.0))
    p = np.radians(np.asarray(lat, dtype=float))
    cos_z = np.sin(p) * np.sin(decl) + np.cos(p) * np.cos(decl) * np.cos(hour_angle)
    return np.degrees(np.arccos(np.clip(cos_z, -1.0, 1.0)))


def _to_datetime(x):
    import datetime as dt

    import pandas as pd

    if isinstance(x, dt.datetime):
        return x
    return pd.Timestamp(x).to_pydatetime()


def swath_mask(grid: StormGrid, valid_time, kind: str,
               rng: np.random.Generator) -> tuple[np.ndarray, float | None]:
    """Which pixels a swath instrument actually covered, and how stale it is.

    Returns the boolean coverage mask and the age of the overpass in minutes, or
    (all False, None) when no overpass falls inside the staleness window. Most
    timesteps get nothing, because most timesteps really do get nothing.
    """
    import pandas as pd

    per_day = PMW_OVERPASSES_PER_DAY if kind == "pmw" else SCAT_OVERPASSES_PER_DAY
    width = PMW_SWATH_WIDTH_KM if kind == "pmw" else SCAT_SWATH_WIDTH_KM
    window_min = 360.0 if kind == "pmw" else 720.0

    t = pd.Timestamp(valid_time)
    # Deterministic overpass times: fixed offsets through the day, phase-shifted
    # per day so the pattern does not repeat exactly.
    day_seed = _rng((kind, t.year, t.dayofyear))
    phase = day_seed.uniform(0.0, 24.0 / per_day)
    times = np.arange(phase, 24.0, 24.0 / per_day)
    now_h = t.hour + t.minute / 60.0

    ages = (now_h - times) * 60.0
    ages = ages[ages >= 0]
    if len(ages) == 0 or ages.min() > window_min:
        return np.zeros((grid.size_px, grid.size_px), dtype=bool), None
    age_min = float(ages.min())

    # A swath crosses the domain as a band at the instrument's own track angle.
    x, y = grid.xy_km()
    angle = np.radians(day_seed.uniform(-28.0, 28.0) + (98.0 if kind == "pmw" else 82.0))
    # Cross-track offset of the swath centre from the domain centre. Sampled
    # across a range wider than the domain so a pass can genuinely miss the
    # storm, which is what makes the availability mask non-trivial.
    offset = day_seed.uniform(-grid.half_km * 1.25, grid.half_km * 1.25)
    across = x * np.cos(angle) + y * np.sin(angle) - offset
    covered = np.abs(across) <= width / 2.0
    return covered, age_min
