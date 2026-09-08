"""Dominant hazard, location impact, and what changed.

This module is the translation layer between a cyclone's physical state and
what that state means somewhere on the ground. It is what turns "58 kt at
16.8N 88.1E" into "the wind threat is easing and the rainfall threat is not".

What this is, precisely
-----------------------
A deterministic rule set over quantities the rest of the system already
produces: the regime head's phase, the intensity head's wind, observed
precipitation accumulated from the QPE field, distance to the coast, and soil
moisture. It is not a learned impact model and it is not an operational
hazard product, and every response says so in a `basis` field.

The reason a rule set is the right answer here rather than a weakness: the
mapping from cyclone phase to dominant hazard is not something that needs
learning. It is established meteorology that a system weakening over land
stops being a wind threat before it stops being a rainfall threat. Fitting a
model to rediscover that, on four case studies, would be worse in every way
than writing it down.

What is deliberately absent
---------------------------
Population, infrastructure, agriculture and road exposure. Those need an
exposure dataset joined to the district geometry, and no such dataset is
loaded in this build. The API returns them as explicitly unavailable with the
reason, rather than multiplying a district area by a made-up density. A
fabricated population-at-risk number is the single easiest thing to put on a
slide and the single most dishonest.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import config as C
from .engine import utc_naive

log = logging.getLogger(__name__)

BASIS = (
    "Rule-based classification over TRINETRA's regime and intensity heads plus "
    "observed precipitation and coastline geometry. Not a learned impact model "
    "and not an operational hazard product."
)

# The hazard vocabulary. Ordered roughly by how a cyclone's threat migrates as
# it comes ashore, which is the sequence the timeline draws.
HAZARDS = {
    "intensification": {
        "label": "Rapid strengthening",
        "technical": "Rapid intensification, over-water deepening",
        "icon": "spiral",
        "colour": "#f472b6",
        "plain": "The storm is over warm open water and gaining strength. The "
                 "concern is how strong it becomes before it reaches anyone.",
    },
    "wind": {
        "label": "Damaging wind",
        "technical": "Sustained wind and gusts at the surface",
        "icon": "wind",
        "colour": "#38bdf8",
        "plain": "A mature cyclone at sea. Wind is the dominant hazard, and it "
                 "matters most for shipping and for the coast it is heading "
                 "towards.",
    },
    "wind_and_rain": {
        "label": "Wind and rainfall",
        "technical": "Combined wind and precipitation hazard near landfall",
        "icon": "landfall",
        "colour": "#a78bfa",
        "plain": "The storm is close to the coast. Both hazards are live at "
                 "once: destructive wind at the coast and heavy rain reaching "
                 "inland ahead of the centre.",
    },
    "rainfall": {
        "label": "Extreme rainfall",
        "technical": "Precipitation-dominant inland hazard",
        "icon": "rain",
        "colour": "#fb923c",
        "plain": "The wind has dropped but the rain has not. This is the phase "
                 "that does most of the inland damage, and it is where most "
                 "cyclone products stop paying attention.",
    },
    "flood": {
        "label": "Flooding",
        "technical": "Accumulated rainfall on saturated ground",
        "icon": "flood",
        "colour": "#f87171",
        "plain": "Rain has been falling long enough on ground already wet that "
                 "the water has nowhere to go. The storm may barely register "
                 "as a cyclone by now.",
    },
    "weakening": {
        "label": "Weakening remnant",
        "technical": "Dissipating circulation, residual moisture",
        "icon": "fade",
        "colour": "#64748b",
        "plain": "The system is breaking up. Localised heavy rain is still "
                 "possible but the organised threat is over.",
    },
}

# Thresholds, all in the units the rest of the system uses. Named so a reviewer
# can argue with the numbers rather than having to find them.
WIND_CS_KT = 34.0  # cyclonic storm strength
WIND_SEVERE_KT = 48.0
NEAR_COAST_KM = 150.0  # within this of the coast, both hazards are live
RAIN_HEAVY_MM = 60.0  # 24-hour accumulation that makes rainfall dominant
RAIN_FLOOD_MM = 120.0
SOIL_WET = 0.30  # volumetric, above which the ground is near saturation
RI_CONCERN = 0.35  # RI probability at which strengthening leads the summary


@dataclass
class Hazard:
    """The dominant hazard at one moment, with the reasoning that produced it."""

    key: str
    valid_time: str
    confidence: str
    drivers: list[dict] = field(default_factory=list)
    secondary: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        spec = HAZARDS[self.key]
        return {
            "key": self.key,
            "label": spec["label"],
            "technical": spec["technical"],
            "icon": spec["icon"],
            "colour": spec["colour"],
            "why_this_matters": spec["plain"],
            "valid_time": self.valid_time,
            "confidence": self.confidence,
            "drivers": self.drivers,
            "secondary": [
                {"key": k, "label": HAZARDS[k]["label"]} for k in self.secondary
            ],
            "basis": BASIS,
        }


def classify(regime: str, vmax_kt: float | None, dist2land_km: float | None,
             rain_24h_mm: float | None, soil_moisture: float | None,
             ri_p24: float | None, trend_kt: float | None,
             valid_time: str = "", regime_conf: float | None = None) -> Hazard:
    """Pick the dominant hazard, and record why.

    Order matters. The checks run from the most consequential situation
    downward, so a storm that is both flooding inland and technically still a
    depression reports flooding rather than wind.
    """
    drivers: list[dict] = []
    secondary: list[str] = []

    v = float(vmax_kt) if vmax_kt is not None and np.isfinite(vmax_kt) else None
    d2l = float(dist2land_km) if dist2land_km is not None and np.isfinite(dist2land_km) else None
    rain = float(rain_24h_mm) if rain_24h_mm is not None and np.isfinite(rain_24h_mm) else None
    soil = float(soil_moisture) if soil_moisture is not None and np.isfinite(soil_moisture) else None
    ri = float(ri_p24) if ri_p24 is not None and np.isfinite(ri_p24) else None
    trend = float(trend_kt) if trend_kt is not None and np.isfinite(trend_kt) else None

    over_land = regime in ("over_land", "post_landfall_remnant") or (
        d2l is not None and d2l <= 0)
    near_coast = d2l is not None and 0 < d2l <= NEAR_COAST_KM

    def drive(label: str, detail: str, direction: str = "up"):
        drivers.append({"label": label, "detail": detail, "direction": direction})

    # ---- flooding: rain on saturated ground, inland
    if over_land and rain is not None and rain >= RAIN_FLOOD_MM:
        drive("Accumulated rainfall",
              f"{rain:.0f} mm estimated over the last 24 hours from the "
              f"satellite rainfall field")
        if soil is not None and soil >= SOIL_WET:
            drive("Saturated ground",
                  f"soil moisture {soil:.2f} m3/m3, near saturation, so further "
                  f"rain runs off rather than soaking in")
        secondary.append("rainfall")
        return Hazard("flood", valid_time, _confidence(regime_conf, rain is not None),
                      drivers, secondary)

    # ---- rainfall-dominant: inland, wind gone, rain heavy
    if over_land and rain is not None and rain >= RAIN_HEAVY_MM:
        drive("Heavy rainfall continuing",
              f"{rain:.0f} mm estimated over the last 24 hours")
        if v is not None and v < WIND_CS_KT:
            drive("Wind hazard easing",
                  f"strongest wind down to {v:.0f} kt, below cyclonic storm "
                  f"strength", "down")
        if soil is not None and soil >= SOIL_WET:
            secondary.append("flood")
        return Hazard("rainfall", valid_time, _confidence(regime_conf, True),
                      drivers, secondary)

    # ---- near landfall: both live
    if near_coast and v is not None and v >= WIND_CS_KT:
        drive("Approaching the coast", f"centre about {d2l:.0f} km offshore")
        drive("Cyclone-strength wind", f"strongest wind {v:.0f} kt")
        if rain is not None and rain > 10:
            drive("Rain already reaching inland",
                  f"{rain:.0f} mm estimated over the last 24 hours")
        secondary.extend(["wind", "rainfall"])
        return Hazard("wind_and_rain", valid_time, _confidence(regime_conf, True),
                      drivers, secondary)

    # ---- strengthening at sea
    if not over_land and ri is not None and ri >= RI_CONCERN:
        drive("Rapid strengthening signalled",
              f"{ri * 100:.0f} percent chance of gaining 30 kt within 24 hours")
        if trend is not None and trend > 0:
            drive("Already strengthening",
                  f"up {trend:.0f} kt over the last 12 hours")
        secondary.append("wind")
        return Hazard("intensification", valid_time,
                      _confidence(regime_conf, True), drivers, secondary)

    # ---- mature at sea
    if not over_land and v is not None and v >= WIND_CS_KT:
        drive("Cyclone-strength wind over water", f"strongest wind {v:.0f} kt")
        if trend is not None and trend < -5:
            drive("Weakening", f"down {abs(trend):.0f} kt over 12 hours", "down")
        if d2l is not None:
            drive("Distance to land", f"{d2l:.0f} km", "flat")
        return Hazard("wind", valid_time, _confidence(regime_conf, True),
                      drivers, secondary)

    # ---- inland but not raining hard, or a weak system anywhere
    if over_land:
        drive("Inland and losing organisation",
              "the circulation is over land and cut off from its ocean heat "
              "source", "down")
        if rain is not None:
            drive("Rainfall", f"{rain:.0f} mm estimated over 24 hours",
                  "up" if rain > 20 else "flat")
        if rain is not None and rain >= 20:
            secondary.append("rainfall")
        return Hazard("weakening", valid_time, _confidence(regime_conf, True),
                      drivers, secondary)

    drive("Below cyclonic storm strength",
          f"strongest wind {v:.0f} kt" if v is not None else "intensity not issued",
          "flat")
    return Hazard("weakening", valid_time, _confidence(regime_conf, v is not None),
                  drivers, secondary)


def _confidence(regime_conf: float | None, have_inputs: bool) -> str:
    """Confidence in the hazard call, not in the underlying numbers.

    Driven by the regime head's own confidence, because the phase is what the
    rule set branches on. The land-sea transition is exactly where that head is
    least sure, and it is also where the hazard changes, so a low reading here
    is meaningful rather than incidental.
    """
    if not have_inputs:
        return "low"
    if regime_conf is None:
        return "medium"
    if regime_conf >= 0.75:
        return "high"
    if regime_conf >= 0.5:
        return "medium"
    return "low"


# ------------------------------------------------------------ rainfall


def rain_accumulation_mm(engine, sid: str, index: int, hours: float = 24.0,
                         at_centre: bool = True,
                         lat: float | None = None,
                         lon: float | None = None) -> float | None:
    """Observed rainfall accumulated over a window, from the QPE field.

    Integrated over the granules in the window rather than taken from a single
    timestep, because the quantity that floods a district is the total, not the
    instantaneous rate. Sampled at the storm centre by default, or at a given
    point for the location probe.
    """
    track = engine._tracks.get(sid)
    if track is None:
        return None
    steps = max(1, int(round(hours / C.SEQ_STEP_HOURS)))
    first = max(0, index - steps + 1)
    total = 0.0
    seen = 0
    for i in range(first, index + 1):
        try:
            g = engine.store.granule(sid, i)
        except Exception:
            continue
        qpe = g.extras.get("qpe")
        if qpe is None:
            continue
        if at_centre:
            row, col = g.grid.size_px // 2, g.grid.size_px // 2
        else:
            r, c = g.grid.pixel_of(lat, lon)
            row, col = int(r), int(c)
            if row < 0 or col < 0:
                continue
        v = float(qpe[row, col])
        if not np.isfinite(v):
            continue
        total += v * C.SEQ_STEP_HOURS
        seen += 1
    return round(total, 1) if seen else None


def soil_at(engine, sid: str, index: int, lat: float | None = None,
            lon: float | None = None) -> float | None:
    """Soil moisture at a point, or at the storm centre."""
    from ..cube.store import CH

    try:
        g = engine.store.granule(sid, index)
    except Exception:
        return None
    if not g.present[CH["soil"]]:
        return None
    field_ = g.data[CH["soil"]]
    if lat is None or lon is None:
        row, col = g.grid.size_px // 2, g.grid.size_px // 2
    else:
        r, c = g.grid.pixel_of(lat, lon)
        row, col = int(r), int(c)
        if row < 0 or col < 0:
            return None
    v = float(field_[row, col])
    return round(v, 4) if np.isfinite(v) else None


# ------------------------------------------------------------ per-storm


def hazard_at(engine, storm_id: str, at=None) -> dict:
    """The dominant hazard now, for one storm."""
    sid = engine.resolve(storm_id)
    track = engine._tracks[sid]
    at = utc_naive(at) if at is not None else pd.Timestamp(track["valid_time"].max())
    index = engine.store.nearest_index(sid, at)
    row = track.iloc[index]

    st = engine.state(sid, at=row["valid_time"])
    rain = rain_accumulation_mm(engine, sid, index)
    soil = soil_at(engine, sid, index)

    hz = classify(
        regime=st["regime"]["label"],
        vmax_kt=st["intensity"]["vmax_kt"] or st["intensity"]["observed_vmax_kt"],
        dist2land_km=float(row["dist2land_km"]) if np.isfinite(row["dist2land_km"]) else None,
        rain_24h_mm=rain,
        soil_moisture=soil,
        ri_p24=st["ri"].get("p24") if st["ri"].get("issued") else None,
        trend_kt=float(row["trend_12h_kt"]) if np.isfinite(row["trend_12h_kt"]) else None,
        valid_time=st["valid_time"],
        regime_conf=st["regime"].get("conf"),
    )
    out = hz.as_dict()
    out.update({
        "storm_id": sid,
        "index": index,
        "inputs": {
            "regime": st["regime"]["label"],
            "regime_confidence": st["regime"].get("conf"),
            "vmax_kt": st["intensity"]["vmax_kt"],
            "observed_vmax_kt": st["intensity"]["observed_vmax_kt"],
            "dist2land_km": _f(row["dist2land_km"]),
            "rain_24h_mm": rain,
            "soil_moisture": soil,
            "ri_p24": st["ri"].get("p24"),
            "trend_12h_kt": _f(row["trend_12h_kt"]),
        },
        "synthetic_inputs": ["rain_24h_mm", "soil_moisture"],
        "synthetic_note": "Rainfall and soil moisture come from the parametric "
                          "forward model in this build, not from a satellite "
                          "retrieval. Position, phase and best-track intensity "
                          "are real.",
    })
    return out


def _f(v):
    try:
        f = float(v)
        return round(f, 2) if np.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def hazard_timeline(engine, storm_id: str, max_points: int = 60) -> dict:
    """The dominant hazard across the whole track.

    This is the sequence the timeline renders, and it is the clearest single
    expression of the project's argument: the threat migrates from wind to
    rainfall as the storm comes ashore, and it does not simply stop.

    Computed from the recorded track and the observed rainfall field rather
    than from a model run at every step, so it is cheap enough to draw for a
    113-fix storm without waiting.
    """
    sid = engine.resolve(storm_id)
    track = engine._tracks[sid]
    n = len(track)
    step = max(1, n // max_points)

    points = []
    for i in range(0, n, step):
        row = track.iloc[i]
        rain = rain_accumulation_mm(engine, sid, i)
        soil = soil_at(engine, sid, i)
        hz = classify(
            regime=str(row["regime"]),
            vmax_kt=_f(row["vmax_kt"]),
            dist2land_km=_f(row["dist2land_km"]),
            rain_24h_mm=rain,
            soil_moisture=soil,
            ri_p24=_f(row["ri_24h"]),
            trend_kt=_f(row["trend_12h_kt"]),
            valid_time=pd.Timestamp(row["valid_time"]).isoformat() + "Z",
        )
        points.append({
            "valid_time": pd.Timestamp(row["valid_time"]).isoformat() + "Z",
            "index": int(i),
            "hazard": hz.key,
            "label": HAZARDS[hz.key]["label"],
            "colour": HAZARDS[hz.key]["colour"],
            "vmax_kt": _f(row["vmax_kt"]),
            "rain_24h_mm": rain,
            "over_land": bool(row["dist2land_km"] <= 0)
            if np.isfinite(row["dist2land_km"]) else None,
        })

    # Run-length encode into phases, which is what a person reads off a
    # timeline. A per-fix colour strip is noise at 113 points.
    phases = []
    for p in points:
        if phases and phases[-1]["hazard"] == p["hazard"]:
            phases[-1]["end_time"] = p["valid_time"]
            phases[-1]["end_index"] = p["index"]
            phases[-1]["n"] += 1
        else:
            phases.append({
                "hazard": p["hazard"], "label": p["label"], "colour": p["colour"],
                "start_time": p["valid_time"], "end_time": p["valid_time"],
                "start_index": p["index"], "end_index": p["index"], "n": 1,
            })

    return {
        "storm_id": sid,
        "points": points,
        "phases": phases,
        "hazards": HAZARDS,
        "basis": BASIS,
        "note": "Computed from the recorded track and the observed rainfall "
                "field. The rainfall field is synthetic in this build.",
    }


# ------------------------------------------------------------ what changed


def changes(engine, storm_id: str, at=None, hours: float = 6.0) -> dict:
    """What changed over the last few hours.

    Answers the question a person actually has when they arrive at a moving
    situation, which is not "what is the intensity" but "is this getting worse".
    Every row is a real difference between two states the system computed; where
    a quantity is unavailable at either end the row says so rather than
    reporting a change of zero.
    """
    sid = engine.resolve(storm_id)
    track = engine._tracks[sid]
    at = utc_naive(at) if at is not None else pd.Timestamp(track["valid_time"].max())
    now_i = engine.store.nearest_index(sid, at)
    back = max(1, int(round(hours / C.SEQ_STEP_HOURS)))
    prev_i = max(0, now_i - back)

    if prev_i == now_i:
        return {"storm_id": sid, "available": False,
                "reason": "This is the first observation of the storm, so there "
                          "is nothing to compare against yet.",
                "rows": []}

    now = engine.state(sid, at=track.iloc[now_i]["valid_time"])
    prev = engine.state(sid, at=track.iloc[prev_i]["valid_time"])

    rows: list[dict] = []

    def row(label: str, plain: str, a, b, unit: str, better_is_lower=False,
            digits=0, sensitivity=0.5):
        if a is None or b is None or not np.isfinite(a) or not np.isfinite(b):
            rows.append({"label": label, "plain": plain, "status": "unavailable",
                         "reason": "not available at both times"})
            return
        delta = float(b) - float(a)
        if abs(delta) < sensitivity:
            direction = "flat"
        elif delta > 0:
            direction = "up"
        else:
            direction = "down"
        rows.append({
            "label": label, "plain": plain, "status": "ok",
            "from": round(float(a), digits), "to": round(float(b), digits),
            "delta": round(delta, digits if digits else 1),
            "unit": unit, "direction": direction,
            "worsening": (direction == "down") if better_is_lower
                         else (direction == "up"),
        })

    row("Strongest wind", "How hard the wind is blowing at the storm's core",
        prev["intensity"]["vmax_kt"], now["intensity"]["vmax_kt"], "kt",
        digits=0, sensitivity=1.0)

    row("Central pressure", "Lower pressure means a stronger storm",
        prev["intensity"]["pmin_hpa"], now["intensity"]["pmin_hpa"], "hPa",
        better_is_lower=True, digits=0, sensitivity=1.0)

    # Convection from the observed OLR at the centre: lower OLR is deeper cloud.
    olr_prev = _centre_channel(engine, sid, prev_i, "olr")
    olr_now = _centre_channel(engine, sid, now_i, "olr")
    row("Storm cloud depth",
        "Deeper, colder cloud means stronger thunderstorms in the core",
        None if olr_prev is None else -olr_prev,
        None if olr_now is None else -olr_now,
        "W/m2 (inverted)", digits=0, sensitivity=3.0)

    rain_prev = rain_accumulation_mm(engine, sid, prev_i)
    rain_now = rain_accumulation_mm(engine, sid, now_i)
    row("Rainfall over 24 h", "How much rain has fallen near the centre",
        rain_prev, rain_now, "mm", digits=0, sensitivity=3.0)

    ri_prev = prev["ri"].get("p24") if prev["ri"].get("issued") else None
    ri_now = now["ri"].get("p24") if now["ri"].get("issued") else None
    row("Chance of rapid strengthening",
        "How likely the storm is to gain 30 kt within a day",
        None if ri_prev is None else ri_prev * 100,
        None if ri_now is None else ri_now * 100,
        "%", digits=0, sensitivity=2.0)

    row("Method disagreement",
        "How far apart the different estimates are. Wider means less certain",
        prev["disagreement"].get("spread_kt"), now["disagreement"].get("spread_kt"),
        "kt", digits=0, sensitivity=1.0)

    hz_prev = classify(
        regime=prev["regime"]["label"],
        vmax_kt=prev["intensity"]["vmax_kt"] or prev["intensity"]["observed_vmax_kt"],
        dist2land_km=_f(track.iloc[prev_i]["dist2land_km"]),
        rain_24h_mm=rain_prev, soil_moisture=soil_at(engine, sid, prev_i),
        ri_p24=ri_prev, trend_kt=_f(track.iloc[prev_i]["trend_12h_kt"]),
        regime_conf=prev["regime"].get("conf"))
    hz_now = classify(
        regime=now["regime"]["label"],
        vmax_kt=now["intensity"]["vmax_kt"] or now["intensity"]["observed_vmax_kt"],
        dist2land_km=_f(track.iloc[now_i]["dist2land_km"]),
        rain_24h_mm=rain_now, soil_moisture=soil_at(engine, sid, now_i),
        ri_p24=ri_now, trend_kt=_f(track.iloc[now_i]["trend_12h_kt"]),
        regime_conf=now["regime"].get("conf"))

    return {
        "storm_id": sid,
        "available": True,
        "window_hours": hours,
        "from_time": prev["valid_time"],
        "to_time": now["valid_time"],
        "rows": rows,
        "hazard_shift": None if hz_prev.key == hz_now.key else {
            "from": {"key": hz_prev.key, "label": HAZARDS[hz_prev.key]["label"]},
            "to": {"key": hz_now.key, "label": HAZARDS[hz_now.key]["label"],
                   "why_this_matters": HAZARDS[hz_now.key]["plain"]},
        },
        "basis": BASIS,
    }


def _centre_channel(engine, sid: str, index: int, channel: str) -> float | None:
    from ..cube.store import CH

    try:
        g = engine.store.granule(sid, index)
    except Exception:
        return None
    i = CH[channel]
    if not g.present[i]:
        return None
    mid = g.grid.size_px // 2
    v = float(g.data[i, mid, mid])
    return v if np.isfinite(v) else None


# ------------------------------------------------------------ location impact


# Exposure categories the product would want and does not have data for. Listed
# explicitly so the UI can show them as unavailable rather than silently
# omitting them, which would leave a reviewer assuming they were never
# considered.
EXPOSURE_UNAVAILABLE = [
    {"key": "population", "label": "Population exposure",
     "reason": "No gridded population dataset is loaded in this build."},
    {"key": "infrastructure", "label": "Infrastructure exposure",
     "reason": "No infrastructure or critical-facility dataset is loaded."},
    {"key": "agriculture", "label": "Agriculture exposure",
     "reason": "No cropland or crop-calendar dataset is loaded."},
    {"key": "transport", "label": "Road and transport disruption",
     "reason": "No road network dataset is loaded."},
]


def location_impact(engine, lat: float, lon: float, storm_id: str, at=None) -> dict:
    """What this cyclone means at one point on the ground.

    Built from the same quantities the probe already returns, plus distance to
    the storm centre and whether the point sits in the track corridor. The
    risk band is categorical rather than numeric on purpose: the inputs do not
    support a continuous number and presenting one would imply precision that
    is not there.
    """
    from ..grid import haversine_km
    from ..harmonise.geometry import districts, land_mask

    sid = engine.resolve(storm_id)
    track = engine._tracks[sid]
    at = utc_naive(at) if at is not None else pd.Timestamp(track["valid_time"].max())
    index = engine.store.nearest_index(sid, at)
    row = track.iloc[index]
    st = engine.state(sid, at=row["valid_time"])

    land_frac = float(land_mask().sample(lat, lon))
    on_land = land_frac > 0.5
    di = districts().locate(lat, lon) if on_land else None
    district = None
    if di is not None:
        d = districts()
        district = {"name": d.names[di], "district_id": d.ids[di]}

    dist_to_centre = float(haversine_km(lat, lon, float(row["lat"]), float(row["lon"])))

    # Has the storm passed this point already, or is it coming?
    future = track.iloc[index:]
    approaching = False
    closest_future_km = None
    if len(future) > 1:
        d = haversine_km(lat, lon, future["lat"].to_numpy(), future["lon"].to_numpy())
        closest_future_km = float(np.min(d))
        approaching = bool(closest_future_km < dist_to_centre - 20.0)

    rain = rain_accumulation_mm(engine, sid, index, at_centre=False, lat=lat, lon=lon)
    soil = soil_at(engine, sid, index, lat=lat, lon=lon)

    # Wind at this point from the parametric profile, which is a reconstruction
    # rather than an observation and is labelled that way.
    wind_here = _parametric_wind_at(engine, sid, index, dist_to_centre, st)

    concerns = _rank_concerns(rain, soil, wind_here, dist_to_centre,
                              closest_future_km, on_land, st)
    band, band_reason = _risk_band(concerns, rain, wind_here, dist_to_centre,
                                   closest_future_km)

    evidence: list[dict] = []
    if rain is not None:
        evidence.append({
            "label": "Rainfall accumulation",
            "detail": f"{rain:.0f} mm estimated here over the last 24 hours",
            "strength": "strong" if rain >= RAIN_HEAVY_MM else
                        "moderate" if rain >= 20 else "weak",
            "provenance": "synthetic",
        })
    olr = _channel_at(engine, sid, index, "olr", lat, lon)
    if olr is not None:
        evidence.append({
            "label": "Storm cloud overhead",
            "detail": f"outgoing longwave radiation {olr:.0f} W/m2"
                      + (" — deep convective cloud" if olr < 160 else
                         " — moderate cloud" if olr < 240 else " — little cloud"),
            "strength": "strong" if olr < 160 else "moderate" if olr < 240 else "weak",
            "provenance": "synthetic",
        })
    if soil is not None:
        evidence.append({
            "label": "Ground wetness",
            "detail": f"soil moisture {soil:.2f} m3/m3"
                      + (" — near saturation" if soil >= SOIL_WET else " — able to absorb more"),
            "strength": "strong" if soil >= SOIL_WET else "weak",
            "provenance": "synthetic",
        })
    if closest_future_km is not None:
        evidence.append({
            "label": "Storm track relative to here",
            "detail": (f"the centre comes within about {closest_future_km:.0f} km "
                       f"on its recorded path" if approaching else
                       f"the centre is {dist_to_centre:.0f} km away and moving off"),
            "strength": "strong" if closest_future_km < 100 else
                        "moderate" if closest_future_km < 250 else "weak",
            "provenance": "real:ibtracs",
        })

    return {
        "lat": lat, "lon": lon,
        "storm_id": sid,
        "storm_name": st["name"],
        "valid_time": st["valid_time"],
        "on_land": on_land,
        "land_fraction": round(land_frac, 3),
        "district": district,
        "distance_to_centre_km": round(dist_to_centre, 1),
        "closest_approach_km": None if closest_future_km is None
                               else round(closest_future_km, 1),
        "storm_approaching": approaching,
        "conditions": {
            "rain_24h_mm": rain,
            "soil_moisture": soil,
            "parametric_wind_kt": wind_here,
            "olr_w_m2": olr,
        },
        "primary_concern": concerns[0] if concerns else None,
        "concerns": concerns,
        "risk_band": band,
        "risk_reason": band_reason,
        "confidence": st["sensor_mode"]["confidence"],
        "confidence_reason": _confidence_sentence(st),
        "evidence": evidence,
        "exposure_unavailable": EXPOSURE_UNAVAILABLE,
        "basis": BASIS,
        "wind_note": "Wind at this point is reconstructed from a Holland "
                     "profile around the estimated centre. It is not an "
                     "observation of the wind here.",
    }


def _parametric_wind_at(engine, sid: str, index: int, dist_km: float,
                        st: dict) -> float | None:
    from ..ingest.synth import holland_b, holland_wind_kt, radius_max_wind_km

    v = st["intensity"]["vmax_kt"] or st["intensity"]["observed_vmax_kt"]
    p = st["intensity"]["pmin_hpa"] or st["intensity"]["observed_pmin_hpa"] or 995.0
    if v is None or not np.isfinite(v) or v <= 0:
        return None
    lat = st["centre"]["lat"]
    rmw = radius_max_wind_km(float(v), float(lat))
    b = holland_b(float(v), float(p))
    w = float(holland_wind_kt(np.array([max(dist_km, 1.0)]), float(v), rmw, b)[0])
    return round(w, 1) if np.isfinite(w) else None


def _channel_at(engine, sid: str, index: int, channel: str,
                lat: float, lon: float) -> float | None:
    from ..cube.store import CH

    try:
        g = engine.store.granule(sid, index)
    except Exception:
        return None
    i = CH[channel]
    if not g.present[i]:
        return None
    r, c = g.grid.pixel_of(lat, lon)
    r, c = int(r), int(c)
    if r < 0 or c < 0:
        return None
    v = float(g.data[i, r, c])
    return round(v, 1) if np.isfinite(v) else None


def _rank_concerns(rain, soil, wind, dist_km, closest_km, on_land, st) -> list[dict]:
    """Order the hazards at this point by how much they matter here."""
    out = []
    if rain is not None and rain >= 20:
        out.append({
            "key": "rainfall",
            "label": "Heavy rainfall",
            "level": "high" if rain >= RAIN_FLOOD_MM else
                     "moderate" if rain >= RAIN_HEAVY_MM else "low",
            "detail": f"{rain:.0f} mm estimated over 24 hours",
        })
    if on_land and rain is not None and soil is not None and \
            rain >= RAIN_HEAVY_MM and soil >= SOIL_WET:
        out.insert(0, {
            "key": "flood",
            "label": "Flooding",
            "level": "high" if rain >= RAIN_FLOOD_MM else "moderate",
            "detail": "heavy rain on ground that is already near saturation",
        })
    if wind is not None and wind >= 25:
        out.append({
            "key": "wind",
            "label": "Strong wind",
            "level": "high" if wind >= WIND_SEVERE_KT else
                     "moderate" if wind >= WIND_CS_KT else "low",
            "detail": f"about {wind:.0f} kt from the reconstructed wind field",
        })
    if not on_land and closest_km is not None and closest_km < 120:
        out.append({
            "key": "coastal",
            "label": "Coastal and marine risk",
            "level": "moderate",
            "detail": f"the centre passes within about {closest_km:.0f} km",
        })

    # What is coming, not only what has arrived.
    #
    # Without this a location the storm is heading straight for reports no
    # hazard, because nothing has happened there yet. That is technically true
    # of the current conditions and useless to anyone deciding what to do, and
    # it was the first thing that looked wrong when the probe was tested on a
    # district the storm later flooded.
    #
    # In replay the later track is recorded rather than forecast, so the
    # wording says "on its recorded path". The distinction matters and the UI
    # repeats it.
    if closest_km is not None and dist_km - closest_km > 20.0:
        level = ("high" if closest_km < 60 else
                 "moderate" if closest_km < 150 else "low")
        out.insert(0 if level == "high" and not any(
            c["level"] == "high" for c in out) else len(out), {
            "key": "approaching",
            "label": "Storm approaching this area",
            "level": level,
            "detail": f"the centre is {dist_km:.0f} km away now and comes "
                      f"within about {closest_km:.0f} km on its recorded path",
        })

    if not out:
        out.append({
            "key": "none",
            "label": "No significant cyclone hazard here",
            "level": "low",
            "detail": f"the centre is {dist_km:.0f} km away, it does not come "
                      f"closer, and the local rainfall signal is weak",
        })
    return out


def _risk_band(concerns, rain, wind, dist_km, closest_km) -> tuple[str, str]:
    levels = [c["level"] for c in concerns]
    if "high" in levels:
        return "high", ("A hazard here is at its strongest level in this rule "
                        "set: " + concerns[levels.index("high")]["detail"] + ".")
    if "moderate" in levels:
        return "moderate", ("A hazard is present but below the strongest "
                            "threshold: "
                            + concerns[levels.index("moderate")]["detail"] + ".")
    if concerns and concerns[0]["key"] == "none":
        return "low", concerns[0]["detail"] + "."
    return "low", "Hazards are present but weak at this location."


def _confidence_sentence(st: dict) -> str:
    """Say in one sentence why confidence is what it is.

    Reads the actual sensor mode rather than restating the label, so the
    sentence changes when an instrument is missing. This is the honest version
    of a confidence readout: it names the cause.
    """
    sm = st["sensor_mode"]
    absent = [a for a in sm["absent"] if a != "land"]
    stale = [c for c, age in sm.get("ages_minutes", {}).items() if age and age > 240]

    parts = []
    if absent:
        pretty = {"pmw89": "microwave", "pmw37": "microwave 37 GHz",
                  "scat": "surface wind", "vis": "visible", "soil": "soil moisture",
                  "ir": "infrared", "wv": "water vapour", "olr": "cloud activity"}
        names = sorted({pretty.get(a, a) for a in absent})
        parts.append(f"{', '.join(names)} not available at this time")
    if stale:
        parts.append("some observations are more than four hours old")
    if st.get("abstentions"):
        parts.append(f"{len(st['abstentions'])} model head(s) declined to answer")
    if not parts:
        return ("All expected instruments reported recently, so the estimate "
                "rests on a full sensor set.")
    return "Confidence is reduced because " + "; ".join(parts) + "."
