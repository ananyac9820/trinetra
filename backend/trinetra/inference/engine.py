"""The inference path. One implementation, two modes.

Live and replay run through this class with exactly two differences: where the
clock comes from, and where the granules come from. That is a design
requirement rather than an optimisation, because if the two paths diverge into
separate implementations then the replay demo stops being evidence that the live
system works.

    LIVE     clock is the wall clock; granules come from the source watchers
    REPLAY   clock is the scrubber position; granules come from the frozen archive

Everything after the granule arrives is byte-identical: availability mask, OOD
gate, detection, centre-fix, classification, intensity, RI, regime, evidence,
disagreement.

Abstention
----------
`abstentions` is a list, not a boolean, and each entry names the head that
declined and why. The side panel renders those as first-class rows rather than
as blanks, because "the RI head did not run because no environmental predictors
were supplied" is information and an empty box is not.

`ri.issued` is deliberately separate from `ri.p24`, so the API can carry a
probability that the UI is instructed not to display. A head can compute a
number that should not be shown, and collapsing those two facts into one field
would force the UI to either show it or lose it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .. import config as C
from ..cube.store import CHANNELS, GranuleStore
from ..grid import bearing_deg, haversine_km
from ..harmonise import environment as env
from ..ingest import synth
from ..ingest.ibtracs import IMD_LABELS, imd_category

log = logging.getLogger(__name__)

# Channels the RI head needs before it will issue a probability. Without an
# environmental vector an image-only RI number would be unsupported, and the
# system says so rather than producing one.
RI_REQUIRED_FEATURES = ("sst", "shear_200_850", "rh_mid")


@dataclass
class Disagreement:
    """Method comparison. Divergence is the alert, not the answer."""

    trinetra_kt: float | None
    baseline_kt: float | None
    imd_kt: float | None
    spread_kt: float | None
    threshold_kt: float
    above_threshold: bool
    driver: str | None
    baseline_name: str

    def as_dict(self) -> dict:
        return {
            "trinetra_kt": _r(self.trinetra_kt),
            "baseline_kt": _r(self.baseline_kt),
            "baseline_name": self.baseline_name,
            "imd_kt": _r(self.imd_kt),
            "spread_kt": _r(self.spread_kt),
            "threshold_kt": self.threshold_kt,
            "above_threshold": self.above_threshold,
            "driver": self.driver,
        }


def _r(x, n: int = 2):
    if x is None or not np.isfinite(x):
        return None
    return round(float(x), n)


class InferenceEngine:
    """Holds the model and the archive, and answers state queries."""

    def __init__(self, labels: pd.DataFrame, model=None, checkpoint: dict | None = None,
                 size_px: int = 128, mode: str = "replay"):
        self.labels = labels.sort_values(["sid", "valid_time"]).reset_index(drop=True)
        self.mode = mode
        self.size_px = size_px
        self.store = GranuleStore(self.labels, size_px=size_px,
                                  tier="live" if mode == "live" else "archive")
        self.model = model
        self.checkpoint = checkpoint or {}
        self.ood = None
        self.analogues = None
        self._tracks = {sid: g.reset_index(drop=True)
                        for sid, g in self.labels.groupby("sid", sort=False)}
        self._baseline = self._fit_baseline()

    # ------------------------------------------------------------ setup

    def _fit_baseline(self) -> dict:
        """The analysis comparison method for the Disagreement Engine.

        The specification wants ADT from the CIMSS archive here. That archive
        was not pulled, so what stands in is a regression on IMD's own published
        Dvorak CI number, and it is labelled as that everywhere it appears
        rather than being called ADT.
        """
        from ..baselines.forecast import fit_dvorak_ci_regression

        return fit_dvorak_ci_regression(self.labels)

    def attach_ood(self, embeddings: np.ndarray, meta: list[dict]) -> None:
        from ..model.ood import AnalogueIndex, MahalanobisOOD

        self.ood = MahalanobisOOD.fit(embeddings)
        self.analogues = AnalogueIndex.build(embeddings, meta)

    # ------------------------------------------------------------ clock

    def now(self) -> pd.Timestamp:
        """The clock. This is the only place the two modes differ on time."""
        if self.mode == "live":
            return pd.Timestamp(datetime.now(timezone.utc)).tz_localize(None)
        return pd.Timestamp(self.labels["valid_time"].max())

    def storms(self) -> list[dict]:
        out = []
        for sid, g in self._tracks.items():
            peak = float(g["vmax_kt"].max())
            out.append({
                "storm_id": sid,
                "name": str(g["name"].iloc[0]),
                "season": int(g["season"].iloc[0]),
                "basin": str(g["basin"].mode().iat[0]) if len(g) else "bay_of_bengal",
                "start_time": g["valid_time"].min().isoformat() + "Z",
                "end_time": g["valid_time"].max().isoformat() + "Z",
                "n_fixes": int(len(g)),
                "peak_vmax_kt": peak,
                "peak_category": imd_category(peak),
                "made_landfall": bool(g["dist2land_km"].min() <= 0),
                "featured_slug": (None if pd.isna(g["featured_slug"].iloc[0])
                                  else str(g["featured_slug"].iloc[0])),
            })
        return sorted(out, key=lambda s: s["start_time"], reverse=True)

    def resolve(self, storm_id: str) -> str:
        """Accept a SID or a featured slug, so demo URLs can be readable."""
        if storm_id in self._tracks:
            return storm_id
        hit = self.labels.loc[self.labels["featured_slug"] == storm_id, "sid"]
        if len(hit):
            return str(hit.iloc[0])
        raise KeyError(storm_id)

    # ------------------------------------------------------------ inference

    def _first_guess_centre(self, track: pd.DataFrame, index: int
                            ) -> tuple[float, float]:
        """Extrapolate the previous two fixes forward.

        The centre-fix head refines a first guess rather than inventing a
        position, which is what an operational tracker does and what the head
        was trained against. Using the true position as the first guess would
        make the reported centre error meaningless.
        """
        row = track.iloc[index]
        if index == 0:
            return float(row["lat"]), float(row["lon"])
        prev = track.iloc[index - 1]
        dt_prev = (pd.Timestamp(row["valid_time"]) - pd.Timestamp(prev["valid_time"]))
        if dt_prev.total_seconds() <= 0:
            return float(prev["lat"]), float(prev["lon"])
        # Persist the previous step's motion across the current step.
        return (
            float(prev["lat"]) + (float(prev["lat"]) - float(track.iloc[max(index - 2, 0)]["lat"])),
            float(prev["lon"]) + (float(prev["lon"]) - float(track.iloc[max(index - 2, 0)]["lon"])),
        )

    def state(self, storm_id: str, at: pd.Timestamp | str | None = None,
              mode: str | None = None) -> dict:
        """The full inference state. Powers /api/storms/{id}/state."""
        sid = self.resolve(storm_id)
        track = self._tracks[sid]
        mode = mode or self.mode
        at = pd.Timestamp(at) if at is not None else pd.Timestamp(track["valid_time"].max())
        index = self.store.nearest_index(sid, at)
        row = track.iloc[index]
        valid_time = pd.Timestamp(row["valid_time"])

        tier = "live" if mode == "live" else "archive"
        granule = self.store.granule(sid, index, tier=tier)
        sensor_mode = granule.sensor_mode()

        tab = env.build_row(track, index)
        abstentions: list[dict] = []

        pred = self._run_model(sid, index, tier, tab)

        # ---- intensity
        vmax = pred.get("vmax")
        vmax_ci = pred.get("vmax_ci")
        if vmax is None:
            abstentions.append({
                "head": "vmax",
                "reason": "No trained model checkpoint is loaded, so no "
                          "intensity estimate is produced. The best-track "
                          "value is shown as the observed label, not as an "
                          "estimate.",
            })

        # ---- centre fix
        centre = pred.get("centre") or {
            "lat": float(row["lat"]), "lon": float(row["lon"]),
            "sigma_km": None, "source": "best_track",
        }
        if centre.get("sigma_km") is None:
            abstentions.append({
                "head": "centre_fix",
                "reason": "Centre-fix uncertainty unavailable without a model "
                          "checkpoint. Best-track position shown instead.",
            })

        # ---- RI: the head that declines, and says what would enable it
        ri = self._ri_block(pred, tab, abstentions)

        # ---- regime
        regime = pred.get("regime") or {
            "label": str(row["regime"]), "conf": None, "source": "weak_label"
        }

        # ---- OOD
        ood = None
        if self.ood is not None and pred.get("embedding") is not None:
            ood = self.ood.check(pred["embedding"])
            if not ood["in_distribution"]:
                abstentions.append({
                    "head": "all_numeric",
                    "reason": f"Out of distribution: Mahalanobis score "
                              f"{ood['score']} exceeds the validated envelope "
                              f"({ood['threshold']}). Nearest historical "
                              f"analogues are returned instead of a number.",
                })

        disagreement = self._disagreement(row, vmax, granule)

        return {
            "storm_id": sid,
            "name": str(row["name"]),
            "valid_time": valid_time.isoformat() + "Z",
            "requested_time": pd.Timestamp(at).isoformat() + "Z",
            "mode": mode,
            "tier": tier,
            "centre": centre,
            "intensity": {
                "vmax_kt": _r(vmax),
                "ci_kt": _r(vmax_ci),
                "pmin_hpa": _r(pred.get("pmin")),
                "pmin_ci": _r(pred.get("pmin_ci")),
                "observed_vmax_kt": _r(row["vmax_kt"]),
                "observed_pmin_hpa": _r(row["pmin_hpa"]),
                "label_agency": str(row["label_agency"]),
            },
            "classification": {
                "dvorak_scene": pred.get("dvorak_scene"),
                "dvorak_conf": _r(pred.get("dvorak_conf"), 3),
                "dvorak_status": "unvalidated",
                "imd_category": pred.get("category") or row["imd_category"],
                "imd_category_label": IMD_LABELS.get(
                    pred.get("category") or row["imd_category"], None),
                "imd_conf": _r(pred.get("category_conf"), 3),
                "observed_category": row["imd_category"],
                "detection": pred.get("detection"),
                "detection_conf": _r(pred.get("detection_conf"), 3),
            },
            "regime": regime,
            "ri": ri,
            "sensor_mode": sensor_mode,
            "ood": ood,
            "abstentions": abstentions,
            "disagreement": disagreement.as_dict(),
            "environment": {
                k: _r(v, 4) for k, v in tab.items()
            },
            "environment_provenance": env.FEATURE_PROVENANCE,
            "provenance": {
                "model_version": self.checkpoint.get("model_version", C.MODEL_VERSION),
                "inference_id": f"inf_{sid}_{index}",
                "synthetic_imagery": bool(granule.extras.get("synthetic")),
                "label_source": "IBTrACS v04r01, IMD preferred",
                "grid": f"LAEA storm-centred, {C.GRID_EXTENT_KM:.0f} km at "
                        f"{self.size_px} px",
            },
            "index": index,
            "n_fixes": int(len(track)),
        }

    def _ri_block(self, pred: dict, tab: dict, abstentions: list) -> dict:
        """The RI block, including the refusal that explains itself.

        This is the most valuable thing on the screen when it declines. A system
        that refuses to guess and names exactly what would enable the answer is
        more believable about the numbers it does produce.
        """
        missing = [f for f in RI_REQUIRED_FEATURES
                   if not np.isfinite(tab.get(f, np.nan))]
        p24 = pred.get("ri_p24")
        threshold = float(self.checkpoint.get("ri_threshold", C.RI_THRESHOLD_DEFAULT))

        if missing:
            abstentions.append({
                "head": "ri",
                "reason": f"Not issued. The RI head requires "
                          f"{', '.join(RI_REQUIRED_FEATURES)}; missing "
                          f"{', '.join(missing)}. An image-only RI number "
                          f"would be unsupported.",
            })
            return {"p24": None, "issued": False, "threshold": threshold,
                    "missing_inputs": missing,
                    "reason": "required environmental predictors not supplied"}

        if p24 is None:
            abstentions.append({
                "head": "ri",
                "reason": "Not issued. No trained model checkpoint is loaded.",
            })
            return {"p24": None, "issued": False, "threshold": threshold,
                    "reason": "no model checkpoint"}

        return {
            "p24": _r(p24, 4),
            "issued": True,
            "threshold": threshold,
            "above_threshold": bool(p24 >= threshold),
            "calibration": "isotonic, fitted on held-out storms",
            "bss_reference": self.checkpoint.get("ri_bss"),
        }

    def _run_model(self, sid: str, index: int, tier: str, tab: dict) -> dict:
        """Run the network, or return an empty dict if none is loaded.

        Returning an empty dict rather than raising is deliberate: the API stays
        up without a checkpoint and every head reports itself as abstaining,
        which is a legible state rather than a 500.
        """
        if self.model is None:
            return {}
        import torch

        from ..model.nets import ModelConfig

        cfg = self.checkpoint.get("config") or {}
        seq_len = int(cfg.get("seq_len", C.SEQ_LEN))
        size_px = int(cfg.get("size_px", self.size_px))

        store = self.store
        if size_px != self.size_px:
            store = GranuleStore(self.labels, size_px=size_px, tier=tier)

        track = self._tracks[sid]
        frames, mask, offsets = store.sequence(sid, index, seq_len=seq_len, tier=tier)

        vec = np.array([tab[f] for f in synth.TABULAR_FEATURES], dtype=float)
        valid = np.isfinite(vec).astype(np.float32)
        basin = track.iloc[index]["basin"]

        batch = {
            "frames": torch.from_numpy(frames[None]),
            "mask": torch.from_numpy(mask[None]),
            "offsets": torch.from_numpy(offsets[None]),
            "tabular": torch.from_numpy(env.standardise(np.nan_to_num(vec))[None]),
            "tabular_valid": torch.from_numpy(valid[None]),
            "basin": torch.tensor(
                [C.BASINS.index(basin) if basin in C.BASINS else 0], dtype=torch.long),
        }
        with torch.no_grad():
            out = self.model(batch)

        # Conformal half-width, per intensity stratum where one was fitted.
        vmax = float(out["vmax"][0])
        ci = self._conformal_half_width(vmax)

        # The keypoint head refines a first guess, so convert its normalised
        # offset back into a real position relative to that guess.
        guess_lat, guess_lon = self._first_guess_centre(track, index)
        off = out["centre_offset"][0].numpy()
        res_km = C.GRID_EXTENT_KM / size_px
        half = size_px / 2.0
        dx_km, dy_km = float(off[0]) * half * res_km, float(off[1]) * half * res_km
        lat = guess_lat + dy_km / 111.0
        lon = guess_lon + dx_km / (111.0 * max(np.cos(np.radians(guess_lat)), 0.2))
        sigma_km = float(out["centre_sigma"][0]) * half * res_km

        cat_probs = torch.softmax(out["category"][0], dim=-1).numpy()
        dv_probs = torch.softmax(out["dvorak"][0], dim=-1).numpy()
        det_probs = torch.softmax(out["detection"][0], dim=-1).numpy()
        reg_probs = torch.softmax(out["regime"][0], dim=-1).numpy()

        ri_raw = float(torch.sigmoid(out["ri_logit"])[0])
        cal = self.checkpoint.get("ri_calibrator")
        ri_p = float(cal.predict(np.array([ri_raw]))[0]) if cal is not None else ri_raw

        return {
            "vmax": vmax,
            "vmax_ci": ci,
            "pmin": float(out["pmin"][0]),
            "pmin_ci": float(out["pmin_sigma_hpa"][0]) * 1.645,
            "centre": {"lat": round(lat, 3), "lon": round(lon, 3),
                       "sigma_km": round(sigma_km, 1),
                       "first_guess_lat": round(guess_lat, 3),
                       "first_guess_lon": round(guess_lon, 3),
                       "source": "trinetra_keypoint_head"},
            "category": C.IMD_CATEGORIES[int(cat_probs.argmax())],
            "category_conf": float(cat_probs.max()),
            "dvorak_scene": C.DVORAK_SCENES[int(dv_probs.argmax())],
            "dvorak_conf": float(dv_probs.max()),
            "detection": C.DETECTION_CLASSES[int(det_probs.argmax())],
            "detection_conf": float(det_probs.max()),
            "regime": {"label": C.REGIMES[int(reg_probs.argmax())],
                       "conf": round(float(reg_probs.max()), 3),
                       "source": "trinetra_regime_head",
                       "probabilities": {r: round(float(p), 4)
                                         for r, p in zip(C.REGIMES, reg_probs)}},
            "ri_p24": ri_p,
            "reintensify_p": float(torch.sigmoid(out["reintensify_logit"])[0]),
            "embedding": out["embedding"][0].numpy(),
        }

    def _conformal_half_width(self, vmax: float) -> float | None:
        """The 90 percent half-width for this intensity, from the fitted table."""
        table = self.checkpoint.get("adaptive_conformal") or {}
        for key, entry in table.items():
            lo, hi = key.split("-")
            hi_v = float("inf") if hi == "inf" else float(hi)
            if float(lo) <= vmax < hi_v:
                return float(entry["quantile"])
        q = self.checkpoint.get("conformal_quantile")
        return float(q) if q is not None else None

    def _disagreement(self, row: pd.Series, vmax: float | None, granule) -> Disagreement:
        """TRINETRA against the analysis baseline and against IMD.

        The spread is the alert. A forecaster should look where the methods
        disagree, and no other product surfaces that.
        """
        from ..baselines.forecast import apply_dvorak_ci_regression

        frame = row.to_frame().T
        base = apply_dvorak_ci_regression(self._baseline, frame)
        base_kt = float(base[0]) if len(base) and np.isfinite(base[0]) else None
        imd_kt = float(row["imd_wind_kt"]) if np.isfinite(row["imd_wind_kt"]) else None

        vals = [v for v in (vmax, base_kt, imd_kt) if v is not None and np.isfinite(v)]
        spread = (max(vals) - min(vals)) if len(vals) >= 2 else None
        above = bool(spread is not None and spread > C.DISAGREEMENT_ALERT_KT)

        driver = None
        if above:
            # Name the likely cause from what the sensors were doing, since that
            # is the actionable part.
            if "pmw89" not in granule.sensor_mode()["present"]:
                driver = ("no microwave overpass in the window, so the inner "
                          "core is unresolved and the infrared centre is "
                          "ambiguous")
            elif float(row["vmax_kt"]) >= 85:
                driver = "eye region ambiguity at high intensity"
            else:
                driver = "weak or sheared system, centre-fixing uncertainty"

        return Disagreement(
            trinetra_kt=vmax, baseline_kt=base_kt, imd_kt=imd_kt,
            spread_kt=spread, threshold_kt=C.DISAGREEMENT_ALERT_KT,
            above_threshold=above, driver=driver,
            baseline_name="IMD Dvorak CI regression (ADT archive not pulled)",
        )

    # ------------------------------------------------------------ tracks

    def track(self, storm_id: str, upto: pd.Timestamp | None = None) -> dict:
        """Track with per-point intensity, regime and uncertainty."""
        sid = self.resolve(storm_id)
        g = self._tracks[sid]
        if upto is not None:
            g = g[g["valid_time"] <= pd.Timestamp(upto)]

        points = []
        for i, row in g.reset_index(drop=True).iterrows():
            points.append({
                "valid_time": pd.Timestamp(row["valid_time"]).isoformat() + "Z",
                "lat": _r(row["lat"], 3), "lon": _r(row["lon"], 3),
                "vmax_kt": _r(row["vmax_kt"]),
                "pmin_hpa": _r(row["pmin_hpa"]),
                "category": row["imd_category"],
                "regime": row["regime"],
                "dist2land_km": _r(row["dist2land_km"], 1),
                "over_land": bool(row["dist2land_km"] <= 0),
                "storm_speed_kt": _r(row["storm_speed_kt"]),
                "storm_dir_deg": _r(row["storm_dir_deg"]),
                "index": int(i),
            })

        # Regime segments, so the frontend can style the polyline by regime
        # without recomputing the run-length encoding itself.
        segments = []
        for p in points:
            if segments and segments[-1]["regime"] == p["regime"]:
                segments[-1]["points"].append([p["lon"], p["lat"]])
                segments[-1]["end_time"] = p["valid_time"]
            else:
                segments.append({
                    "regime": p["regime"],
                    "start_time": p["valid_time"], "end_time": p["valid_time"],
                    "points": [[p["lon"], p["lat"]]],
                })
        # Join segment ends so the drawn line has no gaps at a regime change.
        for a, b in zip(segments, segments[1:]):
            b["points"].insert(0, a["points"][-1])

        return {
            "storm_id": sid,
            "name": str(g["name"].iloc[0]) if len(g) else None,
            "points": points,
            "regime_segments": segments,
            "source": "best_track observed positions",
            "landfall_index": next(
                (p["index"] for p in points if p["over_land"]), None),
        }

    def bulletin_times(self, storm_id: str) -> list[str]:
        """IMD bulletin times, drawn as ticks on the Explorer time axis.

        IMD issues at 00, 03, 06, 09, 12, 15, 18 and 21 UTC during a cyclone,
        and less often for a depression. The visible gap between ticks is the
        between-bulletin argument, so the cadence has to be right or the
        argument is decoration.
        """
        sid = self.resolve(storm_id)
        g = self._tracks[sid]
        out = []
        for _, row in g.iterrows():
            t = pd.Timestamp(row["valid_time"])
            vmax = float(row["vmax_kt"])
            step = 3 if vmax >= 34 else 6
            if t.hour % step == 0:
                out.append(t.isoformat() + "Z")
        return out

    def nearest_system(self, lat: float, lon: float, at: pd.Timestamp) -> dict | None:
        """Closest tracked system to a probe point."""
        best = None
        for sid, g in self._tracks.items():
            idx = self.store.nearest_index(sid, at)
            row = g.iloc[idx]
            if abs((pd.Timestamp(row["valid_time"]) - pd.Timestamp(at)).total_seconds()) > 6 * 3600:
                continue
            d = float(haversine_km(lat, lon, float(row["lat"]), float(row["lon"])))
            if best is None or d < best["distance_km"]:
                best = {
                    "id": sid, "name": str(row["name"]),
                    "distance_km": round(d, 1),
                    "bearing": round(float(bearing_deg(
                        lat, lon, float(row["lat"]), float(row["lon"]))), 0),
                }
        return best
