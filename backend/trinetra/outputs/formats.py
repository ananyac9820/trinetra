"""Operational output formats.

A few hundred lines that turn a model into something a duty forecaster could
actually receive. Nothing here is clever, and that is the point: the difference
between a research result and a system is often just whether it emits the
formats the receiving desk already parses.

Four formats:

    ATCF deck line   the fixed-width format track guidance is exchanged in
    Bulletin text    IMD-style phrasing, for a human reader
    GeoJSON          track, cone and wind swaths, for any GIS
    CAP XML          Common Alerting Protocol, for alert distribution

Every one of them carries the decision-support disclaimer. IMD / RSMC New Delhi
is the warning authority for this basin and nothing produced here is a warning.
That line is not legal decoration; a product that emits CAP XML without it is
one forwarding mistake away from looking like an official alert.
"""

from __future__ import annotations

from datetime import datetime, timezone
from xml.etree import ElementTree as ET

import numpy as np
import pandas as pd

from .. import config as C
from ..ingest.ibtracs import IMD_LABELS

DISCLAIMER = (
    "Decision support only. Not a warning product. IMD / RSMC New Delhi is the "
    "responsible warning authority for the North Indian Ocean."
)

# ATCF basin codes. The North Indian Ocean splits into two.
ATCF_BASIN = {"bay_of_bengal": "BB", "arabian_sea": "AA", "land": "BB"}


def _latlon_atcf(lat: float, lon: float) -> tuple[str, str]:
    """ATCF encodes position in tenths of a degree with a hemisphere letter."""
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"{abs(lat) * 10:.0f}{ns}", f"{abs(lon) * 10:.0f}{ew}"


def atcf_deck_line(state: dict, track: dict, tech: str = "TRIN",
                   tau: int = 0) -> str:
    """One ATCF a-deck line.

    Fixed-width, comma-separated, and the field order is not negotiable. Written
    out explicitly rather than through a library so the field meanings stay
    visible in the source.
    """
    sid = state["storm_id"]
    valid = pd.Timestamp(state["valid_time"].rstrip("Z"))
    basin = ATCF_BASIN.get(_basin_of(track), "BB")
    # Cyclone number within the season, from the IBTrACS SID suffix.
    number = sid[-2:] if sid[-2:].isdigit() else "01"

    centre = state["centre"]
    lat_s, lon_s = _latlon_atcf(float(centre["lat"]), float(centre["lon"]))
    vmax = state["intensity"]["vmax_kt"] or state["intensity"]["observed_vmax_kt"] or 0
    pmin = state["intensity"]["pmin_hpa"] or state["intensity"]["observed_pmin_hpa"] or 0
    cat = state["classification"]["imd_category"] or "DB"

    fields = [
        f"{basin:>2}",
        f"{number:>3}",
        valid.strftime("%Y%m%d%H"),
        f"{0:>3}",  # technum
        f"{tech:>4}",
        f"{tau:>4}",  # forecast hour
        f"{lat_s:>5}",
        f"{lon_s:>6}",
        f"{round(float(vmax)):>4}",
        f"{round(float(pmin)):>5}",
        f"{cat:>3}",
    ]
    return ", ".join(fields)


def _basin_of(track: dict) -> str:
    pts = track.get("points") or []
    if not pts:
        return "bay_of_bengal"
    return "arabian_sea" if float(pts[-1]["lon"]) < 78.0 else "bay_of_bengal"


def atcf_deck(state: dict, track: dict) -> str:
    """The deck, with a header naming the fields and the disclaimer."""
    header = (
        "# TRINETRA ATCF-style a-deck\n"
        "# BASIN, CY, YYYYMMDDHH, TECHNUM, TECH, TAU, LatN/S, LonE/W, VMAX, MSLP, TY\n"
        f"# model {C.MODEL_VERSION}   generated {_utc_now()}\n"
        f"# {DISCLAIMER}\n"
    )
    lines = [atcf_deck_line(state, track)]
    return header + "\n".join(lines) + "\n"


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bulletin_text(state: dict, track: dict) -> str:
    """A bulletin in IMD-adjacent phrasing.

    Deliberately mirrors the structure of an IMD bulletin so a forecaster does
    not have to learn a new layout, and deliberately does not mirror it so
    exactly that the output could be mistaken for one. The header says TRINETRA
    and the disclaimer is at the top, not buried at the bottom.
    """
    st = state
    centre = st["centre"]
    intensity = st["intensity"]
    valid = pd.Timestamp(st["valid_time"].rstrip("Z"))
    cat = st["classification"]["imd_category"]
    cat_label = IMD_LABELS.get(cat, "system")
    name = (st.get("name") or "unnamed").upper()

    vmax = intensity["vmax_kt"]
    ci = intensity["ci_kt"]
    pmin = intensity["pmin_hpa"]

    lat, lon = float(centre["lat"]), float(centre["lon"])
    sigma = centre.get("sigma_km")

    lines = [
        "TRINETRA DECISION SUPPORT BULLETIN",
        DISCLAIMER,
        "",
        f"ISSUED {_utc_now()}",
        f"VALID  {valid.strftime('%d %B %Y, %H%M')} UTC",
        f"SYSTEM {name}  ({st['storm_id']})",
        "",
        f"The {cat_label.lower()} was centred near latitude "
        f"{abs(lat):.1f} degrees {'north' if lat >= 0 else 'south'} and "
        f"longitude {abs(lon):.1f} degrees "
        f"{'east' if lon >= 0 else 'west'}"
        + (f", with a centre-fixing uncertainty of {sigma:.0f} km."
           if sigma else "."),
    ]

    if vmax is not None:
        band = f" plus or minus {ci:.0f} kt" if ci else ""
        lines.append(
            f"Estimated maximum sustained wind is {vmax:.0f} kt{band} "
            f"(3-minute averaging period)."
        )
    else:
        lines.append(
            "No intensity estimate is issued at this time. See the abstention "
            "notes below."
        )
    if pmin is not None:
        lines.append(f"Estimated minimum central pressure is {pmin:.0f} hPa.")

    regime = st["regime"]
    lines += ["", f"REGIME  {regime['label'].replace('_', ' ')}"
                  + (f" (confidence {regime['conf']:.2f})" if regime.get("conf") else "")]
    if regime["label"] in ("post_landfall_remnant", "over_land"):
        lines.append(
            "The system is inland. Wind category is no longer the operative "
            "hazard; district rainfall accumulation is. See the district risk "
            "output."
        )

    ri = st["ri"]
    lines.append("")
    if ri.get("issued"):
        lines.append(
            f"RAPID INTENSIFICATION  probability of a 30 kt increase within "
            f"24 hours is {100 * ri['p24']:.0f} percent "
            f"(operational threshold {100 * ri['threshold']:.0f} percent)."
        )
    else:
        lines.append(
            f"RAPID INTENSIFICATION  NOT ISSUED. {ri.get('reason', 'unavailable')}."
        )

    sm = st["sensor_mode"]
    lines += [
        "",
        f"SENSOR MODE  {'+'.join(sm['present']).upper() or 'NONE'}",
        f"CONFIDENCE   {sm['confidence'].upper()}",
    ]
    if sm["absent"]:
        lines.append(f"ABSENT       {', '.join(sm['absent'])}")

    dis = st["disagreement"]
    if dis.get("spread_kt") is not None:
        lines += ["", f"METHOD SPREAD  {dis['spread_kt']:.0f} kt "
                      f"(TRINETRA {_fmt(dis['trinetra_kt'])}, "
                      f"{dis['baseline_name']} {_fmt(dis['baseline_kt'])}, "
                      f"IMD {_fmt(dis['imd_kt'])})"]
        if dis["above_threshold"]:
            lines.append(f"  Above the {dis['threshold_kt']:.0f} kt agreement "
                         f"threshold. Driver: {dis['driver']}.")

    if st["abstentions"]:
        lines += ["", "ABSTENTIONS"]
        for a in st["abstentions"]:
            lines.append(f"  {a['head']}: {a['reason']}")

    prov = st["provenance"]
    lines += [
        "",
        f"PROVENANCE  model {prov['model_version']}, tier {st['tier']}, "
        f"mode {st['mode']}",
    ]
    if prov.get("synthetic_imagery"):
        lines.append(
            "  Imagery in this analysis is generated by a parametric forward "
            "model, not observed. Positions and intensity labels are real "
            "best-track."
        )
    lines += ["", DISCLAIMER, ""]
    return "\n".join(lines)


def _fmt(x) -> str:
    return "n/a" if x is None else f"{float(x):.0f} kt"


def track_geojson(track: dict, state: dict | None = None,
                  cone_km: float | None = None) -> dict:
    """Track, regime segments and the uncertainty cone as a FeatureCollection.

    Regime segments are separate features rather than one line with a property,
    so any GIS can style the land-sea transition without needing to understand
    a run-length encoding.
    """
    features = []

    for seg in track.get("regime_segments", []):
        features.append({
            "type": "Feature",
            "properties": {
                "kind": "track_segment",
                "regime": seg["regime"],
                "start_time": seg["start_time"],
                "end_time": seg["end_time"],
                "provenance_class": "O",
                "source": "best_track observed positions",
            },
            "geometry": {"type": "LineString", "coordinates": seg["points"]},
        })

    for p in track.get("points", []):
        features.append({
            "type": "Feature",
            "properties": {
                "kind": "fix", "valid_time": p["valid_time"],
                "vmax_kt": p["vmax_kt"], "pmin_hpa": p["pmin_hpa"],
                "category": p["category"], "regime": p["regime"],
                "over_land": p["over_land"], "provenance_class": "O",
            },
            "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
        })

    if state is not None and cone_km:
        centre = state["centre"]
        features.append({
            "type": "Feature",
            "properties": {
                "kind": "uncertainty_cone",
                "provenance_class": "D",
                "produced_by": "TRINETRA conformal prediction",
                "radius_km": cone_km,
                "coverage": 0.9,
                "disclaimer": "Short-range only. Coverage verified empirically "
                              "on held-out seasons. Not a medium-range track "
                              "forecast.",
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [_circle(float(centre["lat"]), float(centre["lon"]),
                                        cone_km)],
            },
        })

    return {
        "type": "FeatureCollection",
        "properties": {
            "generated": _utc_now(),
            "model_version": C.MODEL_VERSION,
            "disclaimer": DISCLAIMER,
            "storm_id": track.get("storm_id"),
            "name": track.get("name"),
        },
        "features": features,
    }


def _circle(lat: float, lon: float, radius_km: float, n: int = 64) -> list:
    """A geodesic-ish circle, closed. Adequate at these radii."""
    ang = np.linspace(0, 2 * np.pi, n + 1)
    dlat = radius_km / 111.0 * np.cos(ang)
    dlon = radius_km / (111.0 * max(np.cos(np.radians(lat)), 0.2)) * np.sin(ang)
    return [[float(lon + b), float(lat + a)] for a, b in zip(dlat, dlon)]


def wind_swath_geojson(state: dict, track: dict) -> dict:
    """Parametric wind radii as polygons, from the Holland profile.

    Explicitly a reconstruction. Wind radii are out of scope as a headline
    claim, and these are emitted only because a GIS consumer asks for a swath
    and a labelled parametric polygon is more useful than nothing. The
    properties say what produced them.
    """
    from ..ingest.synth import holland_b, radius_max_wind_km

    centre = state["centre"]
    lat, lon = float(centre["lat"]), float(centre["lon"])
    vmax = state["intensity"]["vmax_kt"] or state["intensity"]["observed_vmax_kt"]
    pmin = state["intensity"]["pmin_hpa"] or state["intensity"]["observed_pmin_hpa"] or 990.0
    if not vmax:
        return {"type": "FeatureCollection", "features": [],
                "properties": {"status": "no intensity estimate"}}

    rmw = radius_max_wind_km(float(vmax), lat)
    b = holland_b(float(vmax), float(pmin))
    features = []
    for threshold in (34, 50, 64):
        if float(vmax) <= threshold:
            continue
        # Invert the Holland profile for the radius at which the wind falls to
        # the threshold. Solved numerically because it has no closed form.
        r = _radius_of_wind(float(vmax), rmw, b, threshold)
        if r is None:
            continue
        features.append({
            "type": "Feature",
            "properties": {
                "kind": "wind_swath", "threshold_kt": threshold,
                "radius_km": round(r, 1), "provenance_class": "D",
                "produced_by": "Holland parametric profile from the TRINETRA "
                               "intensity head",
                "disclaimer": "Parametric reconstruction, symmetric. Wind radii "
                              "are not a headline claim of this project and are "
                              "reported only on the SAR-validated subset, which "
                              "is currently empty.",
            },
            "geometry": {"type": "Polygon", "coordinates": [_circle(lat, lon, r)]},
        })
    return {"type": "FeatureCollection", "features": features,
            "properties": {"disclaimer": DISCLAIMER, "generated": _utc_now()}}


def _radius_of_wind(vmax: float, rmw: float, b: float, target: float) -> float | None:
    from ..ingest.synth import holland_wind_kt

    r = np.linspace(rmw, 800.0, 2000)
    v = holland_wind_kt(r, vmax, rmw, b)
    below = np.nonzero(v <= target)[0]
    return float(r[below[0]]) if len(below) else None


def cap_xml(state: dict, track: dict, districts: list[dict] | None = None) -> str:
    """Common Alerting Protocol 1.2.

    Status is Exercise rather than Actual, deliberately and permanently. A CAP
    message with status Actual that reaches an aggregator is an alert, and this
    system is not an alerting authority. The msgType, the status, the
    responseType and the headline all say so.
    """
    cap = ET.Element("alert", {"xmlns": "urn:oasis:names:tc:emergency:cap:1.2"})
    ET.SubElement(cap, "identifier").text = (
        f"TRINETRA.{state['storm_id']}.{state['valid_time'].replace(':', '')}"
    )
    ET.SubElement(cap, "sender").text = "trinetra.decision-support"
    ET.SubElement(cap, "sent").text = _utc_now()
    # Exercise, not Actual. This is not an alerting authority.
    ET.SubElement(cap, "status").text = "Exercise"
    ET.SubElement(cap, "msgType").text = "Alert"
    ET.SubElement(cap, "scope").text = "Private"
    ET.SubElement(cap, "note").text = DISCLAIMER

    info = ET.SubElement(cap, "info")
    ET.SubElement(info, "language").text = "en-IN"
    ET.SubElement(info, "category").text = "Met"
    ET.SubElement(info, "event").text = "Tropical cyclone decision support"
    ET.SubElement(info, "responseType").text = "None"
    ET.SubElement(info, "urgency").text = "Future"

    cat = state["classification"]["imd_category"] or "D"
    order = C.IMD_CATEGORIES.index(cat) if cat in C.IMD_CATEGORIES else 0
    ET.SubElement(info, "severity").text = (
        "Extreme" if order >= 5 else "Severe" if order >= 3 else "Moderate"
    )
    ET.SubElement(info, "certainty").text = (
        "Observed" if state["sensor_mode"]["confidence"] in ("high", "medium")
        else "Possible"
    )
    ET.SubElement(info, "senderName").text = "TRINETRA (not a warning authority)"
    ET.SubElement(info, "headline").text = (
        f"EXERCISE / DECISION SUPPORT: {state.get('name') or state['storm_id']}, "
        f"{IMD_LABELS.get(cat, 'system')}"
    )
    ET.SubElement(info, "description").text = bulletin_text(state, track)
    ET.SubElement(info, "instruction").text = (
        "Follow IMD / RSMC New Delhi bulletins for all warning decisions. This "
        "message carries no warning authority."
    )

    for key, value in (
        ("model_version", state["provenance"]["model_version"]),
        ("sensor_mode", "+".join(state["sensor_mode"]["present"])),
        ("sensor_confidence", state["sensor_mode"]["confidence"]),
        ("method_spread_kt", str(state["disagreement"].get("spread_kt"))),
        ("abstentions", str(len(state["abstentions"]))),
        ("synthetic_imagery", str(state["provenance"].get("synthetic_imagery"))),
    ):
        p = ET.SubElement(info, "parameter")
        ET.SubElement(p, "valueName").text = key
        ET.SubElement(p, "value").text = value

    area = ET.SubElement(info, "area")
    ET.SubElement(area, "areaDesc").text = (
        ", ".join(d["name"] for d in districts) if districts
        else "North Indian Ocean, storm-centred domain"
    )
    centre = state["centre"]
    ET.SubElement(area, "circle").text = (
        f"{float(centre['lat']):.3f},{float(centre['lon']):.3f} "
        f"{float(centre.get('sigma_km') or 50.0):.0f}"
    )
    for d in districts or []:
        geo = ET.SubElement(area, "geocode")
        ET.SubElement(geo, "valueName").text = "district_id"
        ET.SubElement(geo, "value").text = str(d.get("district_id"))

    ET.indent(cap, space="  ")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(
        cap, encoding="unicode")
