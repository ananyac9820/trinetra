"""IBTrACS North Indian Ocean best-track ingest.

Step 1 of the acquisition runbook (Part IX). No authentication, no queue, no
latency: this is the source that lets baselines and the evaluation harness exist
on day one, and everything downstream is measured against the labels it produces.

Label policy
------------
IMD / RSMC New Delhi is the primary label agency for this basin, so NEWDELHI_WIND
is preferred wherever it exists. JTWC (USA_WIND) is kept alongside it rather than
merged, because the gap between the two is the only estimate of label noise this
project can honestly quote.

The two agencies do not measure the same quantity. IMD reports a 3-minute
sustained wind; JTWC reports a 1-minute sustained wind. Comparing the raw numbers
overstates the disagreement, so the 1-minute values are converted with the
conventional 0.93 factor before the spread is computed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

IBTRACS_NI_URL = (
    "https://www.ncei.noaa.gov/data/"
    "international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.NI.list.v04r01.csv"
)

# WMO conversion between averaging periods. IMD publishes a 3-minute sustained
# wind, JTWC a 1-minute sustained wind.
ONE_MIN_TO_THREE_MIN = 0.93

# IMD intensity scale, in 3-minute sustained knots. Seven classes, which is the
# classification head's output space.
#
# Stored as inclusive lower bounds rather than as ranges. The published table
# quotes whole-knot ranges (17-27, 28-33, ...), and best-track values are not
# whole knots once a 1-minute wind has been converted, so a range table drops
# every value that lands in a gap. Lower bounds have no gaps.
IMD_SCALE: list[tuple[str, str, float]] = [
    ("D", "Depression", 17.0),
    ("DD", "Deep Depression", 28.0),
    ("CS", "Cyclonic Storm", 34.0),
    ("SCS", "Severe Cyclonic Storm", 48.0),
    ("VSCS", "Very Severe Cyclonic Storm", 64.0),
    ("ESCS", "Extremely Severe Cyclonic Storm", 90.0),
    ("SuCS", "Super Cyclonic Storm", 120.0),
]
IMD_CATEGORIES = [c[0] for c in IMD_SCALE]
IMD_LABELS = {c[0]: c[1] for c in IMD_SCALE}
IMD_LOWER_KT = {c[0]: c[2] for c in IMD_SCALE}

# Rapid intensification, per the model specification: 30 kt or more in 24 hours.
RI_DELTA_KT = 30.0
RI_WINDOW_H = 24.0

# North Indian Ocean domain used throughout the project.
NIO_BBOX = {"lon_min": 60.0, "lon_max": 100.0, "lat_min": 5.0, "lat_max": 28.0}

FEATURED_STORMS = {
    "2023156N10067": "biparjoy",
    "2024238N25077": "asna",
    "2020136N10088": "amphan",
    "2019116N02090": "fani",
}


@dataclass(frozen=True)
class IngestConfig:
    """Controls which slice of the archive becomes the working label set."""

    min_season: int = 1990
    # Sub-depression rows carry no useful intensity label and inflate the class
    # imbalance without adding signal.
    min_vmax_kt: float = 15.0
    # 'main' rows are the reconciled track; 'spur' rows are alternate fragments.
    main_track_only: bool = True


def load_raw(path: str | Path) -> pd.DataFrame:
    """Read the IBTrACS CSV. Row 0 is the header, row 1 is a units row."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. Fetch it with:\n  curl -o {path} {IBTRACS_NI_URL}"
        )
    df = pd.read_csv(path, skiprows=[1], low_memory=False, na_values=[" ", ""])
    df["ISO_TIME"] = pd.to_datetime(df["ISO_TIME"], errors="coerce")
    log.info("IBTrACS raw: %d rows, %d storms", len(df), df["SID"].nunique())
    return df


def epoch_seconds(times: pd.Series) -> np.ndarray:
    """Seconds since the epoch, independent of the datetime64 resolution.

    pandas 3 stores datetime64 in microseconds where pandas 2 used nanoseconds,
    so dividing a raw int64 cast by a fixed constant is off by a factor of 1000
    on one of them. Casting to datetime64[s] first pins the unit.
    """
    return times.to_numpy(dtype="datetime64[s]").astype("int64").astype(float)


def _num(df: pd.DataFrame, col: str) -> pd.Series:
    """Coerce a column to float, returning all-NaN if the column is absent."""
    if col not in df.columns:
        return pd.Series(np.nan, index=df.index, dtype=float)
    return pd.to_numeric(df[col], errors="coerce")


def imd_category(vmax_kt: float) -> str | None:
    """Map a 3-minute sustained wind in knots onto the IMD scale.

    Returns None below depression strength rather than inventing a class for it.
    """
    if vmax_kt is None or not np.isfinite(vmax_kt) or vmax_kt < IMD_SCALE[0][2]:
        return None
    code = IMD_CATEGORIES[0]
    for c, _label, lower in IMD_SCALE:
        if vmax_kt >= lower:
            code = c
    return code


def _resolve_intensity(df: pd.DataFrame) -> pd.DataFrame:
    """Assemble the intensity label and the agency spread that qualifies it."""
    imd_wind = _num(df, "NEWDELHI_WIND")
    imd_pres = _num(df, "NEWDELHI_PRES")
    jtwc_wind_1min = _num(df, "USA_WIND")
    jtwc_pres = _num(df, "USA_PRES")
    wmo_wind = _num(df, "WMO_WIND")
    wmo_pres = _num(df, "WMO_PRES")

    # Put JTWC on IMD's averaging period before any comparison or fallback.
    jtwc_wind_3min = jtwc_wind_1min * ONE_MIN_TO_THREE_MIN

    out = pd.DataFrame(index=df.index)
    out["imd_wind_kt"] = imd_wind
    out["imd_pres_hpa"] = imd_pres
    out["imd_ci"] = _num(df, "NEWDELHI_CI")  # IMD's own Dvorak CI number
    out["jtwc_wind_1min_kt"] = jtwc_wind_1min
    out["jtwc_wind_kt"] = jtwc_wind_3min
    out["jtwc_pres_hpa"] = jtwc_pres

    # Preference order: IMD, then WMO, then converted JTWC.
    vmax = imd_wind.copy()
    agency = pd.Series(
        np.where(vmax.notna(), "IMD", None), index=df.index, dtype=object
    )

    fill = vmax.isna() & wmo_wind.notna()
    vmax = vmax.where(~fill, wmo_wind)
    agency = agency.where(~fill, "WMO")

    fill = vmax.isna() & jtwc_wind_3min.notna()
    vmax = vmax.where(~fill, jtwc_wind_3min)
    agency = agency.where(~fill, "JTWC_conv_3min")

    pmin = imd_pres.copy()
    pmin = pmin.where(pmin.notna(), wmo_pres)
    pmin = pmin.where(pmin.notna(), jtwc_pres)

    out["vmax_kt"] = vmax
    out["pmin_hpa"] = pmin
    out["label_agency"] = agency

    # Label noise: only meaningful where both agencies actually analysed the storm.
    both = imd_wind.notna() & jtwc_wind_3min.notna()
    out["label_spread_kt"] = (imd_wind - jtwc_wind_3min).abs().where(both)
    return out


def _regime(df: pd.DataFrame) -> pd.Series:
    """Weak regime labels for the land-sea transition head.

    Four classes, derived from geometry and intensity trend rather than from a
    published regime product, because no such product exists for this basin.
    They are weak labels and the dataset card says so.
    """
    dist2land = df["dist2land_km"]
    vmax = df["vmax_kt"]
    trend = df["trend_12h_kt"]
    # Cumulative landfall flag: has this storm already touched land?
    made_landfall = (dist2land <= 0).groupby(df["sid"]).cummax().astype(bool)

    regime = pd.Series("maritime_mature", index=df.index, dtype=object)
    # Over ocean, below cyclonic-storm strength or weakening: the sheared or
    # otherwise disrupted case.
    weak_ocean = (dist2land > 0) & ((vmax < 34.0) | (trend < -5.0))
    regime[weak_ocean] = "sheared"
    regime[made_landfall & (dist2land > 0)] = "post_landfall_remnant"
    regime[dist2land <= 0] = "over_land"
    return regime


def build_labels(df: pd.DataFrame, cfg: IngestConfig | None = None) -> pd.DataFrame:
    """Turn the raw archive into the canonical per-fix label table."""
    cfg = cfg or IngestConfig()

    if cfg.main_track_only and "TRACK_TYPE" in df.columns:
        df = df[df["TRACK_TYPE"].astype(str).str.strip() == "main"]
    df = df[df["SEASON"] >= cfg.min_season]
    df = df[df["ISO_TIME"].notna()]

    intensity = _resolve_intensity(df)

    out = pd.DataFrame(
        {
            "sid": df["SID"].astype(str),
            "season": _num(df, "SEASON").astype("Int64"),
            "name": df["NAME"].astype(str).str.strip().str.title(),
            "subbasin": df["SUBBASIN"].astype(str).str.strip(),
            "nature": df["NATURE"].astype(str).str.strip(),
            "valid_time": df["ISO_TIME"],
            "lat": _num(df, "LAT"),
            "lon": _num(df, "LON"),
            "dist2land_km": _num(df, "DIST2LAND"),
            "landfall_km": _num(df, "LANDFALL"),
            "storm_speed_kt": _num(df, "STORM_SPEED"),
            "storm_dir_deg": _num(df, "STORM_DIR"),
        }
    ).join(intensity)

    out = out[out["vmax_kt"].notna() & (out["vmax_kt"] >= cfg.min_vmax_kt)]
    out = out[out["lat"].between(-5, 40) & out["lon"].between(40, 110)]
    out = out.sort_values(["sid", "valid_time"]).reset_index(drop=True)

    # Basin embedding input: Bay of Bengal, Arabian Sea, or over land.
    basin = np.where(out["subbasin"].eq("AS"), "arabian_sea", "bay_of_bengal")
    out["basin"] = np.where(out["dist2land_km"] <= 0, "land", basin)

    out["imd_category"] = out["vmax_kt"].map(imd_category)
    out["storm_motion_u_kt"] = out["storm_speed_kt"] * np.sin(
        np.deg2rad(out["storm_dir_deg"])
    )
    out["storm_motion_v_kt"] = out["storm_speed_kt"] * np.cos(
        np.deg2rad(out["storm_dir_deg"])
    )

    out = _add_temporal_targets(out)
    out["regime"] = _regime(out)
    out["featured_slug"] = out["sid"].map(FEATURED_STORMS)
    out["is_featured"] = out["featured_slug"].notna()

    log.info(
        "labels: %d fixes, %d storms, seasons %s-%s",
        len(out),
        out["sid"].nunique(),
        out["season"].min(),
        out["season"].max(),
    )
    return out


def _interp_at_offset(g: pd.DataFrame, hours: float) -> np.ndarray:
    """Intensity at t+hours for each row, interpolated along the storm's own track.

    Returns NaN where the offset falls outside the storm's observed window, so a
    storm's last fixes never borrow a target from another storm.
    """
    t = epoch_seconds(g["valid_time"])
    v = g["vmax_kt"].to_numpy(dtype=float)
    target = t + hours * 3600.0
    inside = (target >= t[0]) & (target <= t[-1])
    res = np.full(len(g), np.nan)
    if inside.any() and len(t) > 1:
        res[inside] = np.interp(target[inside], t, v)
    return res


def _add_temporal_targets(df: pd.DataFrame) -> pd.DataFrame:
    """Prior trend, forward intensity change, and the rare-event labels."""
    parts = []
    for _sid, g in df.groupby("sid", sort=False):
        g = g.copy()
        g["trend_12h_kt"] = g["vmax_kt"] - _interp_at_offset(g, -12.0)
        for h in (12, 24, 48):
            fut = _interp_at_offset(g, float(h))
            g[f"vmax_plus_{h}h_kt"] = fut
            g[f"dv_{h}h_kt"] = fut - g["vmax_kt"]
        g["ri_24h"] = (g["dv_24h_kt"] >= RI_DELTA_KT).astype(float)
        g.loc[g["dv_24h_kt"].isna(), "ri_24h"] = np.nan

        # Re-intensification over land: strengthening while inland. The Asna
        # signature, and the reason the regime head exists.
        over_land = g["dist2land_km"] <= 0
        g["reintensify_land"] = (over_land & (g["dv_24h_kt"] >= 10.0)).astype(float)
        g.loc[g["dv_24h_kt"].isna(), "reintensify_land"] = np.nan
        parts.append(g)
    out = pd.concat(parts, ignore_index=True)
    out["trend_12h_kt"] = out["trend_12h_kt"].fillna(0.0)
    return out


def _peak_category(series: pd.Series) -> str | None:
    vals = [c for c in series.dropna().unique() if c in IMD_CATEGORIES]
    if not vals:
        return None
    return max(vals, key=IMD_CATEGORIES.index)


def storm_index(labels: pd.DataFrame) -> pd.DataFrame:
    """One row per storm. Powers /api/storms and the archive page."""
    g = labels.groupby("sid")
    idx = pd.DataFrame(
        {
            "name": g["name"].first(),
            "season": g["season"].first(),
            "basin": g["basin"].agg(
                lambda s: s.mode().iat[0] if len(s.mode()) else "bay_of_bengal"
            ),
            "start_time": g["valid_time"].min(),
            "end_time": g["valid_time"].max(),
            "n_fixes": g.size(),
            "peak_vmax_kt": g["vmax_kt"].max(),
            "min_pmin_hpa": g["pmin_hpa"].min(),
            "peak_category": g["imd_category"].agg(_peak_category),
            "made_landfall": g["dist2land_km"].min() <= 0,
            "had_ri": g["ri_24h"].max(),
            "mean_label_spread_kt": g["label_spread_kt"].mean(),
            "featured_slug": g["featured_slug"].first(),
        }
    ).reset_index()
    return idx.sort_values("start_time", ascending=False).reset_index(drop=True)
