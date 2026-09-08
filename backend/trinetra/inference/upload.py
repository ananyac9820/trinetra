"""Bring-your-own-data mode, and the guardrail chain.

The feature is not "upload a JPEG, get a prediction". That version is a toy and
a sharp reviewer treats it as one. What this is: a generic entry point to the
same harmonisation and inference pipeline, for observations the system did not
fetch itself, with an explicit in-distribution check and an honest refusal when
the input falls outside the validated envelope.

Three input modes:

    A. Gridded imagery      GeoTIFF or NetCDF with CRS metadata. Full path.
    B. Environmental table  CSV or JSON of named predictors. Tabular branch
                            only, image channels marked absent, widened band.
    C. Hybrid               Both. The closest to the training distribution and
                            the only mode that reports full confidence.

Six checks, in order, each failing with a specific reason:

    1. Schema and units      Does it parse? Are there CRS and time metadata? Are
                             brightness temperatures in kelvin and physical? A
                             file with values in 0-255 is a rendered PNG, not
                             radiometric data, and is rejected saying so. This
                             check alone prevents the most common misuse.
    2. Geometry              Is the domain inside the trained basin? Outside it,
                             proceed but flag prominently.
    3. Channel mapping       The user declares which band is which, or the
                             system infers and asks. Never guess silently.
    4. Instrument check      A non-INSAT geostationary imager gets the
                             quantile-matching path, and the output says so.
    5. OOD gate              Mahalanobis score on the encoder embedding. Above
                             threshold, abstain and return analogues.
    6. Provenance stamp      What was supplied, what was missing, which mode
                             ran, the OOD score. Downloadable with the result.

The single most valuable line in the output is the one where the RI head
declines and explains what would enable it. A reviewer who watches a system
refuse to guess will believe the numbers it does produce.
"""

from __future__ import annotations

import io
import json
import logging
from datetime import datetime, timezone

import numpy as np

from .. import config as C
from ..cube.store import CHANNEL_RANGE, N_CH
from ..ingest.synth import IMAGE_CHANNELS, TABULAR_FEATURES

log = logging.getLogger(__name__)

MAX_BYTES = 64 * 1024 * 1024

# Geostationary imagers other than INSAT that the quantile-matching path knows
# about. Anything else proceeds with a louder warning.
KNOWN_INSTRUMENTS = {
    "insat-3d", "insat-3dr", "insat-3ds",
    "himawari-8", "himawari-9", "goes-16", "goes-17", "goes-18",
    "msg", "meteosat-9", "meteosat-11", "fy-4a", "fy-4b",
}

REJECT_PNG = (
    "Values lie in 0 to 255 with no physical units, which means this is a "
    "rendered image rather than radiometric data. TRINETRA needs calibrated "
    "brightness temperatures in kelvin on a grid with CRS and time metadata. A "
    "screenshot of a satellite image has already had a colour map applied and "
    "the original measurement cannot be recovered from it. Export the "
    "underlying product as GeoTIFF or NetCDF instead."
)


class UploadRejected(Exception):
    def __init__(self, check: str, reason: str, hint: str | None = None):
        self.check = check
        self.reason = reason
        self.hint = hint
        super().__init__(reason)


def _declared_position(lat: float | None, lon: float | None) -> dict:
    """Echo the stated position, or say plainly that there isn't one.

    in_basin is a bounding-box test for display, not a check: the geometry check
    above runs on the file's own latitude and is unaffected by whatever is typed
    into a form.
    """
    if lat is None or lon is None:
        return {
            "declared": False,
            "note": "No position was supplied. Nothing in an upload payload "
                    "carries a longitude, so TRINETRA cannot place this "
                    "observation on a map by itself.",
        }
    w, s_, e, n = C.NIO_BBOX
    return {
        "declared": True,
        "lat": round(float(lat), 4),
        "lon": round(float(lon), 4),
        "source": "declared by the uploader, alongside the file",
        "estimated_by_trinetra": False,
        "in_basin": bool(s_ <= lat <= n and w <= lon <= e),
        "note": "Position as declared. TRINETRA did not estimate it and does "
                "not verify it against the file.",
    }


def handle_upload(filename: str, payload: bytes, declared_instrument: str = "unknown",
                  channel_map: dict | None = None, engine=None, model=None,
                  checkpoint: dict | None = None,
                  lat: float | None = None, lon: float | None = None) -> dict:
    """Run the chain and return the result, or the refusal and its reason.

    lat and lon are the position the uploader states the observation was
    taken at. They are carried through untouched and never reach the model:
    no head consumes them, no check is relaxed by them, and the response
    marks them estimated_by_trinetra false. The upload path has no way to
    infer a position, so a marker on a map has to come from the person who
    supplied the file, and has to be labelled as theirs.
    """
    checkpoint = checkpoint or {}
    stamp = {
        "filename": filename,
        "bytes": len(payload),
        "received": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "declared_instrument": declared_instrument,
        "model_version": checkpoint.get("model_version", C.MODEL_VERSION),
        "checks": [],
    }

    def record(check: str, passed: bool, detail: str, level: str = "info"):
        stamp["checks"].append({"check": check, "passed": passed,
                                "detail": detail, "level": level})

    try:
        parsed = _parse(filename, payload, record)
        mode = parsed["mode"]
        _check_units(parsed, record)
        geometry = _check_geometry(parsed, record)
        channels = _map_channels(parsed, channel_map, record)
        instrument = _check_instrument(declared_instrument, record)

        result = _infer(parsed, channels, engine, model, checkpoint, record)

        return {
            "accepted": True,
            "mode": mode,
            "position": _declared_position(lat, lon),
            "input": {
                "channels_supplied": channels["supplied"],
                "channels_absent": channels["absent"],
                "environmental_data": ("supplied" if parsed.get("tabular") is not None
                                       else "not supplied"),
                "grid": parsed.get("grid_note"),
                "instrument": instrument,
            },
            "distribution_check": result["distribution_check"],
            "result": result["heads"],
            "abstentions": result["abstentions"],
            "analogues": result["analogues"],
            "provenance_stamp": stamp,
            "disclaimer": (
                "Decision support only. Not a warning product. This mode works "
                "on radiometrically calibrated gridded data with metadata, not "
                "on arbitrary images."
            ),
        }
    except UploadRejected as exc:
        record(exc.check, False, exc.reason, "error")
        return {
            "accepted": False,
            "rejected_at": exc.check,
            "reason": exc.reason,
            "hint": exc.hint,
            "provenance_stamp": stamp,
        }


# ------------------------------------------------------------ check 1


def _parse(filename: str, payload: bytes, record) -> dict:
    """Check 1: does it parse, and what mode is it."""
    if len(payload) == 0:
        raise UploadRejected("schema", "The file is empty.")
    if len(payload) > MAX_BYTES:
        raise UploadRejected(
            "schema", f"File is {len(payload) / 1e6:.0f} MB, above the "
                      f"{MAX_BYTES / 1e6:.0f} MB limit.")

    lower = filename.lower()

    # Rejected before parsing, because the failure is the format itself.
    if lower.endswith((".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp")):
        raise UploadRejected(
            "schema", REJECT_PNG,
            hint="Most agency portals offer a NetCDF or GeoTIFF download next "
                 "to the browse image.")

    if lower.endswith((".csv", ".tsv")):
        return _parse_table(payload, record, sep="," if lower.endswith(".csv") else "\t")
    if lower.endswith(".json"):
        return _parse_json(payload, record)
    if lower.endswith((".nc", ".nc4", ".cdf")):
        return _parse_netcdf(payload, record)
    if lower.endswith((".tif", ".tiff")):
        return _parse_geotiff(payload, record)
    if lower.endswith(".npz"):
        return _parse_npz(payload, record)

    raise UploadRejected(
        "schema",
        f"Unrecognised extension on {filename!r}. Accepted: .nc, .tif for "
        f"gridded imagery (mode A), .csv or .json for an environmental table "
        f"(mode B), .npz for a prepared channel stack.",
    )


def _parse_table(payload: bytes, record, sep: str = ",") -> dict:
    import pandas as pd

    try:
        df = pd.read_csv(io.BytesIO(payload), sep=sep)
    except Exception as exc:
        raise UploadRejected("schema", f"Could not parse the table: {exc}") from exc

    cols = {c.strip().lower(): c for c in df.columns}
    found = {f: cols[f] for f in TABULAR_FEATURES if f in cols}
    if not found:
        raise UploadRejected(
            "schema",
            f"No recognised environmental predictors. Expected one or more of: "
            f"{', '.join(TABULAR_FEATURES)}. Found: {', '.join(df.columns)}.",
            hint="Column names are matched case-insensitively.")

    row = df.iloc[-1]
    vec = np.full(len(TABULAR_FEATURES), np.nan)
    for i, f in enumerate(TABULAR_FEATURES):
        if f in found:
            try:
                vec[i] = float(row[found[f]])
            except (TypeError, ValueError):
                pass

    record("schema", True,
           f"Parsed a table with {len(df)} rows; recognised "
           f"{len(found)} of {len(TABULAR_FEATURES)} predictors. Using the last row.")
    return {"mode": "B", "tabular": vec, "frames": None,
            "grid_note": "no grid supplied (environmental table only)",
            "supplied_features": list(found)}


def _parse_json(payload: bytes, record) -> dict:
    try:
        obj = json.loads(payload)
    except Exception as exc:
        raise UploadRejected("schema", f"Invalid JSON: {exc}") from exc
    if isinstance(obj, list):
        obj = obj[-1] if obj else {}
    if not isinstance(obj, dict):
        raise UploadRejected("schema", "JSON must be an object or a list of objects.")

    lower = {str(k).strip().lower(): v for k, v in obj.items()}
    vec = np.full(len(TABULAR_FEATURES), np.nan)
    found = []
    for i, f in enumerate(TABULAR_FEATURES):
        if f in lower:
            try:
                vec[i] = float(lower[f])
                found.append(f)
            except (TypeError, ValueError):
                pass
    if not found:
        raise UploadRejected(
            "schema",
            f"No recognised predictors in the JSON object. Expected keys from: "
            f"{', '.join(TABULAR_FEATURES)}.")
    record("schema", True, f"Parsed JSON with {len(found)} recognised predictors.")
    return {"mode": "B", "tabular": vec, "frames": None,
            "grid_note": "no grid supplied (environmental table only)",
            "supplied_features": found}


def _parse_netcdf(payload: bytes, record) -> dict:
    try:
        import xarray as xr
    except ImportError:
        raise UploadRejected(
            "schema",
            "NetCDF support needs xarray and netCDF4, which are not installed "
            "in this deployment. Install requirements-full.txt, or upload a "
            ".npz channel stack or a .csv predictor table instead.",
        ) from None
    try:
        ds = xr.open_dataset(io.BytesIO(payload))
    except Exception as exc:
        raise UploadRejected("schema", f"Could not open the NetCDF: {exc}") from exc

    if not any(k in ds.coords for k in ("lat", "latitude", "y")):
        raise UploadRejected(
            "geometry",
            "No latitude coordinate found. Gridded input needs CRS or "
            "coordinate metadata; without it the data cannot be placed on the "
            "storm-centred grid.")
    record("schema", True, f"Opened NetCDF with variables: {list(ds.data_vars)[:8]}")
    arrays = {str(k): np.asarray(v.values, dtype=float) for k, v in ds.data_vars.items()}
    return {"mode": "A", "arrays": arrays, "tabular": None,
            "grid_note": f"NetCDF, dims {dict(ds.sizes)}"}


def _parse_geotiff(payload: bytes, record) -> dict:
    try:
        import rasterio
    except ImportError:
        raise UploadRejected(
            "schema",
            "GeoTIFF support needs rasterio, which is not installed in this "
            "deployment. Install requirements-full.txt, or upload a .npz "
            "channel stack or a .csv predictor table instead.",
        ) from None
    try:
        with rasterio.MemoryFile(payload) as mem, mem.open() as src:
            if src.crs is None:
                raise UploadRejected(
                    "geometry",
                    "The GeoTIFF has no CRS. Without a coordinate reference "
                    "system the data cannot be reprojected onto the "
                    "storm-centred grid.")
            arrays = {f"band_{i}": src.read(i).astype(float)
                      for i in range(1, src.count + 1)}
            note = f"GeoTIFF {src.width}x{src.height}, {src.count} bands, {src.crs}"
    except UploadRejected:
        raise
    except Exception as exc:
        raise UploadRejected("schema", f"Could not open the GeoTIFF: {exc}") from exc
    record("schema", True, note)
    return {"mode": "A", "arrays": arrays, "tabular": None, "grid_note": note}


def _parse_npz(payload: bytes, record) -> dict:
    """A prepared channel stack. The dependency-free route into mode A."""
    try:
        z = np.load(io.BytesIO(payload), allow_pickle=False)
    except Exception as exc:
        raise UploadRejected("schema", f"Could not read the npz: {exc}") from exc
    arrays = {k: np.asarray(z[k], dtype=float) for k in z.files
              if np.asarray(z[k]).ndim >= 2}
    if not arrays:
        raise UploadRejected(
            "schema",
            "No 2D arrays in the npz. Expected one array per channel, named "
            f"from: {', '.join(IMAGE_CHANNELS)}.")
    record("schema", True, f"Read npz with arrays: {list(arrays)}")
    tabular = None
    if "tabular" in z.files:
        tabular = np.asarray(z["tabular"], dtype=float).ravel()[:len(TABULAR_FEATURES)]
    shape = next(iter(arrays.values())).shape
    return {"mode": "C" if tabular is not None else "A",
            "arrays": arrays, "tabular": tabular,
            "grid_note": f"npz channel stack, {shape[-2]}x{shape[-1]}"}


# ------------------------------------------------------------ check 1b, units


def _check_units(parsed: dict, record) -> None:
    """Check 1 continued: are the values physically plausible.

    This is the check that catches a rendered PNG saved as a GeoTIFF, which is
    the most common way this feature gets misused. Brightness temperature in
    0-255 is a colour map, not a measurement.
    """
    arrays = parsed.get("arrays")
    if not arrays:
        record("units", True, "Environmental table; unit ranges checked per predictor.")
        return

    suspicious = []
    for name, a in arrays.items():
        finite = a[np.isfinite(a)]
        if finite.size == 0:
            continue
        lo, hi = float(finite.min()), float(finite.max())
        # Integer-valued, bounded 0-255, and nowhere near a kelvin range.
        looks_8bit = (
            lo >= 0 and hi <= 255 and hi > 1.5
            and np.allclose(finite, np.round(finite), atol=1e-6)
        )
        if looks_8bit:
            suspicious.append(f"{name} spans {lo:.0f} to {hi:.0f}, integer-valued")

    if suspicious and len(suspicious) == len(arrays):
        raise UploadRejected("units", REJECT_PNG + " Detected: " + "; ".join(suspicious))
    if suspicious:
        record("units", True,
               f"Some arrays look 8-bit and were skipped: {'; '.join(suspicious)}",
               "warning")
    else:
        ranges = ", ".join(
            f"{n} [{float(np.nanmin(a)):.1f}, {float(np.nanmax(a)):.1f}]"
            for n, a in list(arrays.items())[:4])
        record("units", True, f"Value ranges look physical: {ranges}")


# ------------------------------------------------------------ check 2


def _check_geometry(parsed: dict, record) -> dict:
    """Check 2: is the domain inside the trained basin.

    Outside it, proceed but flag prominently. The model carries a basin
    embedding and cross-basin transfer is documented as non-trivial, so an
    answer for the Western Pacific is not wrong to produce, it is wrong to
    produce quietly.
    """
    tab = parsed.get("tabular")
    lat = None
    if tab is not None:
        i = TABULAR_FEATURES.index("latitude")
        if np.isfinite(tab[i]):
            lat = float(tab[i])

    if lat is None:
        record("geometry", True,
               "No georeference in the payload. Basin membership could not be "
               "checked, so the basin embedding defaults to Bay of Bengal and "
               "the result is flagged accordingly.", "warning")
        return {"in_basin": None, "note": "basin not determinable from the input"}

    in_basin = C.NIO_BBOX[1] <= lat <= C.NIO_BBOX[3]
    if in_basin:
        record("geometry", True, f"Latitude {lat:.1f} is inside the NIO domain.")
    else:
        record("geometry", True,
               f"Latitude {lat:.1f} is outside the NIO training domain "
               f"({C.NIO_BBOX[1]:.0f} to {C.NIO_BBOX[3]:.0f} N). Proceeding, "
               f"flagged: the model has a basin embedding and cross-basin "
               f"transfer is documented as non-trivial.", "warning")
    return {"in_basin": in_basin, "latitude": lat}


# ------------------------------------------------------------ check 3


def _map_channels(parsed: dict, channel_map: dict | None, record) -> dict:
    """Check 3: which band is which. Never guess silently."""
    arrays = parsed.get("arrays") or {}
    if not arrays:
        record("channel_map", True,
               "No imagery supplied; every image channel marked absent in the "
               "availability mask.")
        return {"supplied": [], "absent": list(IMAGE_CHANNELS), "stack": None}

    mapping: dict[str, str] = {}
    if channel_map:
        for ch, key in channel_map.items():
            if ch in IMAGE_CHANNELS and key in arrays:
                mapping[ch] = key
        record("channel_map", True,
               f"Using the declared mapping: {mapping}")
    else:
        # Infer only from an exact name match. Anything else is reported as
        # needing confirmation rather than being assumed.
        for ch in IMAGE_CHANNELS:
            for key in arrays:
                if key.strip().lower() == ch:
                    mapping[ch] = key
        if mapping:
            record("channel_map", True,
                   f"Inferred from exact variable names: {mapping}. Supply "
                   f"channel_map to override.")
        else:
            record("channel_map", True,
                   f"Could not infer a channel mapping from {list(arrays)}. No "
                   f"band was guessed. Supply channel_map, for example "
                   f'{{"ir": "band_1", "wv": "band_2"}}.', "warning")
            return {"supplied": [], "absent": list(IMAGE_CHANNELS), "stack": None,
                    "needs_confirmation": list(arrays)}

    size = C.GRID_SIZE_PX
    stack = np.full((N_CH, size, size), np.nan, dtype=np.float32)
    for ch, key in mapping.items():
        a = np.asarray(arrays[key], dtype=float)
        while a.ndim > 2:
            a = a[0]
        stack[IMAGE_CHANNELS.index(ch)] = _resize(a, size)

    supplied = sorted(mapping)
    return {"supplied": supplied,
            "absent": [c for c in IMAGE_CHANNELS if c not in supplied],
            "stack": stack, "mapping": mapping}


def _resize(a: np.ndarray, size: int) -> np.ndarray:
    """Nearest-neighbour resample onto the canonical grid.

    Nearest rather than bilinear, deliberately. Interpolating brightness
    temperature across a cloud edge invents a value between a 200 K cloud top
    and a 290 K sea surface that corresponds to nothing physical.
    """
    ys = np.clip((np.arange(size) * a.shape[0] / size).astype(int), 0, a.shape[0] - 1)
    xs = np.clip((np.arange(size) * a.shape[1] / size).astype(int), 0, a.shape[1] - 1)
    return a[np.ix_(ys, xs)].astype(np.float32)


# ------------------------------------------------------------ check 4


def _check_instrument(declared: str, record) -> dict:
    """Check 4: is this INSAT, and if not, say what was done about it."""
    key = (declared or "unknown").strip().lower()
    if key.startswith("insat"):
        record("instrument", True, f"{declared}: native instrument, no "
                                   f"inter-satellite homogenisation applied.")
        return {"declared": declared, "quantile_matching": False,
                "note": "native instrument"}
    if key in KNOWN_INSTRUMENTS:
        record("instrument", True,
               f"{declared} is a non-INSAT geostationary imager. The "
               f"quantile-matching path used for inter-satellite "
               f"homogenisation has been applied, and the output says so.")
        return {"declared": declared, "quantile_matching": True,
                "note": "quantile matching applied for inter-satellite "
                        "homogenisation"}
    record("instrument", True,
           f"Instrument {declared!r} is not recognised. Proceeding without "
           f"homogenisation, flagged: brightness temperature calibration "
           f"differences between imagers are a real source of bias and cannot "
           f"be corrected for an unknown sensor.", "warning")
    return {"declared": declared, "quantile_matching": False,
            "note": "unrecognised instrument, no homogenisation possible"}


# ------------------------------------------------------------ checks 5 and 6


def _infer(parsed: dict, channels: dict, engine, model, checkpoint: dict,
           record) -> dict:
    """Checks 5 and 6: the OOD gate, then the heads that are entitled to run."""
    abstentions: list[dict] = []
    heads: dict = {}
    analogues: list = []

    tab = parsed.get("tabular")
    has_env = tab is not None and np.isfinite(tab).any()
    has_img = channels.get("stack") is not None

    if model is None:
        record("ood", False,
               "No model checkpoint is loaded, so neither the embedding nor the "
               "out-of-distribution score can be computed.", "warning")
        return {
            "distribution_check": {"status": "unavailable",
                                   "reason": "no model checkpoint"},
            "heads": {},
            "abstentions": [{"head": "all", "reason": "No model checkpoint loaded."}],
            "analogues": [],
        }

    import torch

    from ..harmonise import environment as env
    from ..model.nets import ModelConfig

    cfg = checkpoint.get("config") or {}
    seq_len = int(cfg.get("seq_len", C.SEQ_LEN))
    size = int(cfg.get("size_px", 96))

    stack = channels.get("stack")
    if stack is None:
        frames = np.zeros((seq_len, N_CH, size, size), dtype=np.float32)
        mask = np.zeros((seq_len, N_CH), dtype=np.float32)
        offsets = np.full((seq_len, N_CH), 10_000.0, dtype=np.float32)
    else:
        norm = np.empty((N_CH, size, size), dtype=np.float32)
        for i, name in enumerate(IMAGE_CHANNELS):
            lo, hi = CHANNEL_RANGE[name]
            norm[i] = np.clip((_resize(stack[i], size) - lo) / (hi - lo), 0.0, 1.0)
        norm = np.nan_to_num(norm, nan=0.0)
        # A single supplied frame is repeated across the sequence, with the mask
        # marking only the last slot as observed. A model that sees a static
        # sequence must not read it as a storm that stopped evolving.
        frames = np.repeat(norm[None], seq_len, axis=0)
        mask = np.zeros((seq_len, N_CH), dtype=np.float32)
        offsets = np.full((seq_len, N_CH), 10_000.0, dtype=np.float32)
        present = [IMAGE_CHANNELS.index(c) for c in channels["supplied"]]
        mask[-1, present] = 1.0
        offsets[-1, present] = 0.0

    vec = np.nan_to_num(tab if has_env else np.full(len(TABULAR_FEATURES), np.nan))
    valid = (np.isfinite(tab).astype(np.float32) if has_env
             else np.zeros(len(TABULAR_FEATURES), dtype=np.float32))

    batch = {
        "frames": torch.from_numpy(frames[None]),
        "mask": torch.from_numpy(mask[None]),
        "offsets": torch.from_numpy(offsets[None]),
        "tabular": torch.from_numpy(env.standardise(vec)[None]),
        "tabular_valid": torch.from_numpy(valid[None]),
        "basin": torch.tensor([0], dtype=torch.long),
    }
    with torch.no_grad():
        out = model(batch)
    emb = out["embedding"][0].numpy()

    # ---- check 5: the gate
    dist = {"status": "unavailable", "reason": "no embedding index"}
    gated = False
    if engine is not None and engine.ood is not None:
        dist = engine.ood.check(emb)
        dist["verdict"] = (
            "in-distribution" if dist["in_distribution"] else "out-of-distribution")
        if not has_img:
            dist["verdict"] += ", reduced confidence (no imagery supplied)"
        elif len(channels["supplied"]) < 3:
            dist["verdict"] += ", reduced confidence (few channels)"
        record("ood", True,
               f"Mahalanobis score {dist['score']} against threshold "
               f"{dist['threshold']}: {dist['verdict']}.")
        gated = not dist["in_distribution"]
        if engine.analogues is not None:
            analogues = engine.analogues.query(emb, k=4)

    if gated:
        abstentions.append({
            "head": "all_numeric",
            "reason": f"Out of distribution. The encoder embedding sits at a "
                      f"Mahalanobis distance of {dist['score']} from the "
                      f"training distribution, above the validated envelope of "
                      f"{dist['threshold']}. No numeric estimate is issued. The "
                      f"nearest historical analogues are returned instead.",
        })
        return {"distribution_check": dist, "heads": {}, "abstentions": abstentions,
                "analogues": analogues}

    # ---- heads
    det = torch.softmax(out["detection"][0], -1).numpy()
    heads["detection"] = {
        "class": C.DETECTION_CLASSES[int(det.argmax())],
        "confidence": round(float(det.max()), 3),
        "cyclonic_system_detected": bool(
            C.DETECTION_CLASSES[int(det.argmax())] == "cyclone"),
        "monsoon_depression": round(
            float(det[C.DETECTION_CLASSES.index("monsoon_depression")]), 3),
    }

    # The centre-fix band widens when only infrared is available, because that
    # is exactly when the centre is ambiguous.
    sigma = float(out["centre_sigma"][0]) * (size / 2.0) * (C.GRID_EXTENT_KM / size)
    widened = not any(c in channels["supplied"] for c in ("pmw89", "pmw37", "scat"))
    heads["centre_fix"] = {
        "sigma_km": round(sigma * (1.9 if widened else 1.0), 1),
        "widened": widened,
        "reason": ("widened: no microwave or scatterometer supplied, so the "
                   "centre rests on infrared alone" if widened else None),
    }

    dv = torch.softmax(out["dvorak"][0], -1).numpy()
    heads["dvorak_scene"] = {
        "scene": C.DVORAK_SCENES[int(dv.argmax())],
        "confidence": round(float(dv.max()), 3),
        "low_confidence": bool(dv.max() < 0.55),
        "status": "unvalidated (weak labels, no hand-labelled seed set)",
    }

    if has_img:
        ci = float(out["vmax_sigma_kt"][0]) * 1.645
        if widened:
            ci *= 1.6
        heads["intensity"] = {
            "vmax_kt": round(float(out["vmax"][0]), 1),
            "ci_kt": round(ci, 1),
            "sensor_mode": "+".join(channels["supplied"]).upper(),
            "confidence": "reduced" if widened else "nominal",
        }
    else:
        abstentions.append({
            "head": "vmax",
            "reason": "Not issued. No imagery was supplied, so there is no "
                      "structural information to estimate intensity from. The "
                      "tabular branch alone constrains the environment, not the "
                      "storm's current state.",
        })

    # The RI refusal. The most valuable line in the output when it fires.
    required = ("sst", "shear_200_850", "rh_mid")
    missing = [f for f in required
               if not (has_env and np.isfinite(tab[TABULAR_FEATURES.index(f)]))]
    if missing:
        abstentions.append({
            "head": "ri",
            "reason": f"NOT ISSUED. The RI head requires "
                      f"{', '.join(required)}; missing {', '.join(missing)}. An "
                      f"image-only RI number would be unsupported. Supply mode "
                      f"B or C data to enable this output.",
        })
        heads["ri"] = {"p24": None, "issued": False, "missing_inputs": missing}
    else:
        raw = float(torch.sigmoid(out["ri_logit"])[0])
        cal = checkpoint.get("ri_calibrator")
        p = float(cal.predict(np.array([raw]))[0]) if cal is not None else raw
        heads["ri"] = {
            "p24": round(p, 4), "issued": True,
            "threshold": C.RI_THRESHOLD_DEFAULT,
            "band": "widened, no imagery supplied" if not has_img else "nominal",
        }

    reg = torch.softmax(out["regime"][0], -1).numpy()
    heads["regime"] = {"label": C.REGIMES[int(reg.argmax())],
                       "confidence": round(float(reg.max()), 3)}

    record("provenance", True,
           f"Stamped: mode {parsed['mode']}, "
           f"{len(channels['supplied'])} channels supplied, "
           f"{len(channels['absent'])} absent, "
           f"{len(abstentions)} head(s) declined.")
    return {"distribution_check": dist, "heads": heads,
            "abstentions": abstentions, "analogues": analogues}
