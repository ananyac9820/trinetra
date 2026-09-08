"""Training samples, targets, and the losses.

One design point here needs stating because getting it wrong would have
produced a meaningless centre-fix result.

The canonical grid is centred on the storm, so if the centre-fix target were
the storm centre on that grid it would be the exact middle of every single
sample. The head would learn to output (0, 0), score a zero-kilometre error,
and have learned nothing. The task would be leaking its own answer through the
grid definition.

What an operational centre-fix actually does is refine a first guess. A
forecaster or a tracker extrapolates the previous position forward, lands within
some tens of kilometres, and the algorithm's job is to correct that. So the grid
here is deliberately built off-centre by a random offset standing in for
first-guess error, and the target is the vector from that offset centre to the
truth. The reported error is then the residual after refinement, which is the
number that means something.

At inference the same thing happens for real: the first guess comes from
extrapolating the previous two fixes, and the head corrects it.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import torch
from torch.utils.data import Dataset

from .. import config as C
from ..cube.store import CHANNELS, GranuleStore, N_CH
from ..harmonise import environment as env
from ..ingest.synth import TABULAR_FEATURES
from .nets import norm_pmin, norm_vmax

# First-guess error injected at training time, in kilometres. Chosen to bracket
# what track extrapolation actually achieves over three hours in this basin.
CENTRE_JITTER_KM = 70.0

DETECTION_CLASSES = C.DETECTION_CLASSES
REGIMES = C.REGIMES
IMD_CATEGORIES = C.IMD_CATEGORIES
DVORAK_SCENES = C.DVORAK_SCENES


def shift_field(a: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """Translate an array by whole pixels, padding with the edge value.

    Used to simulate a grid built around a wrong centre. Edge padding rather
    than wrapping, because wrapping would move the storm's cirrus canopy to the
    opposite corner and teach the encoder that storms have two cores.
    """
    if dy == 0 and dx == 0:
        return a
    pad = max(abs(dy), abs(dx))
    p = np.pad(a, [(0, 0)] * (a.ndim - 2) + [(pad, pad), (pad, pad)], mode="edge")
    y0, x0 = pad - dy, pad - dx
    return p[..., y0 : y0 + a.shape[-2], x0 : x0 + a.shape[-1]]


def detection_label(row: pd.Series) -> int:
    """Detection class from the IBTrACS nature field and the calendar.

    A weak label. IBTrACS records nature (TS, DS, ET, SS, MX, NR) but has no
    monsoon-depression class, and the specification requires monsoon depression
    to be an explicit class rather than a negative, because in this basin
    misclassifying one as a cyclone is the common operational error.

    So the class is derived: a disturbance-strength system in the monsoon months
    over or near land is labelled a monsoon depression. This is documented as a
    weak label on the methods page and the confusion matrix is reported against
    a hand-checked subset rather than against these labels alone.
    """
    nature = str(row.get("nature", "")).strip().upper()
    month = pd.Timestamp(row["valid_time"]).month
    vmax = float(row["vmax_kt"])
    dist = float(row["dist2land_km"]) if np.isfinite(row["dist2land_km"]) else 999.0

    if nature in ("ET", "SS", "MX", "NR"):
        return DETECTION_CLASSES.index("other")
    if month in (6, 7, 8, 9) and vmax < 34.0 and dist < 300.0:
        return DETECTION_CLASSES.index("monsoon_depression")
    return DETECTION_CLASSES.index("cyclone")


def dvorak_scene_label(row: pd.Series) -> int:
    """Dvorak scene type from the IMD CI number and the intensity.

    Weak supervision. The specification wants scene type from the CIMSS ADT
    archive, which was not pulled in this build, so what is available is IMD's
    own CI number. The mapping below follows the usual correspondence between
    CI and scene, and it is weak in exactly the way the specification warns
    about: the head is reported against a hand-labelled seed rather than against
    these labels. With no seed labelled, the scene head is reported as
    unvalidated rather than scored.
    """
    ci = float(row.get("imd_ci", np.nan))
    vmax = float(row["vmax_kt"])
    if not np.isfinite(ci):
        ci = 1.0 + vmax / 25.0
    if ci < 2.5:
        return DVORAK_SCENES.index("curved_band")
    if ci < 3.5:
        return DVORAK_SCENES.index("shear" if vmax < 40 else "central_dense_overcast")
    if ci < 4.5:
        return DVORAK_SCENES.index("embedded_centre")
    if ci < 5.5:
        return DVORAK_SCENES.index("irregular_cdo")
    if ci < 6.5:
        return DVORAK_SCENES.index("eye")
    return DVORAK_SCENES.index("eye")


class StormSequenceDataset(Dataset):
    """Sequences, targets and provenance for one split."""

    def __init__(self, labels: pd.DataFrame, indices: np.ndarray | None = None,
                 size_px: int = 128, seq_len: int = C.SEQ_LEN,
                 tier: str = "archive", jitter: bool = True,
                 env_table: pd.DataFrame | None = None, seed: int = 0,
                 cube=None):
        self.labels = labels.sort_values(["sid", "valid_time"]).reset_index(drop=True)
        # A materialised cube when one was built, the lazy generator otherwise.
        # Identical data either way; the cube is many times faster under a
        # shuffled loader, where the lazy store's LRU cache thrashes because
        # consecutive samples come from unrelated storms.
        self.cube = cube
        self.store = GranuleStore(self.labels, size_px=size_px, tier=tier)
        self.size_px = size_px
        self.seq_len = seq_len
        self.tier = tier
        self.jitter = jitter
        self.seed = seed

        # Position of each label row within its own storm, for the store lookup.
        self._pos = (
            self.labels.groupby("sid", sort=False).cumcount().to_numpy()
        )
        self.indices = (
            np.arange(len(self.labels)) if indices is None else np.asarray(indices)
        )
        self.env_table = env_table

    def __len__(self) -> int:
        return len(self.indices)

    def _tabular(self, row_idx: int) -> tuple[np.ndarray, np.ndarray]:
        row = self.labels.iloc[row_idx]
        if self.cube is not None:
            vec = self.cube.tabular(str(row["sid"]), int(self._pos[row_idx]))
            valid = np.isfinite(vec).astype(np.float32)
            return env.standardise(np.nan_to_num(vec)), valid
        if self.env_table is not None:
            vec = self.env_table.iloc[row_idx][TABULAR_FEATURES].to_numpy(dtype=float)
        else:
            sid = row["sid"]
            track = self.store.track(sid)
            vals = env.build_row(track, int(self._pos[row_idx]))
            vec = np.array([vals[f] for f in TABULAR_FEATURES], dtype=float)
        valid = np.isfinite(vec).astype(np.float32)
        return env.standardise(np.nan_to_num(vec)), valid

    def __getitem__(self, i: int) -> dict:
        row_idx = int(self.indices[i])
        row = self.labels.iloc[row_idx]
        sid = str(row["sid"])
        pos = int(self._pos[row_idx])

        if self.cube is not None:
            frames, mask, offsets = self.cube.sequence(sid, pos, seq_len=self.seq_len)
        else:
            frames, mask, offsets = self.store.sequence(
                sid, pos, seq_len=self.seq_len, tier=self.tier
            )

        # First-guess error. The same offset for every frame, because a
        # first-guess centre is one wrong position rather than a wobble.
        res_km = C.GRID_EXTENT_KM / self.size_px
        if self.jitter:
            rng = np.random.default_rng(abs(hash((sid, pos, self.seed))) % (2**32))
            max_px = int(CENTRE_JITTER_KM / res_km)
            dy = int(rng.integers(-max_px, max_px + 1))
            dx = int(rng.integers(-max_px, max_px + 1))
        else:
            dy = dx = 0
        if dy or dx:
            frames = shift_field(frames, dy, dx)

        # Target offset in normalised grid coordinates, matching the spatial
        # softmax output. x increases right, y increases up.
        half = self.size_px / 2.0
        target_centre = np.array([-dx / half, dy / half], dtype=np.float32)

        tab, tab_valid = self._tabular(row_idx)
        basin = C.BASINS.index(row["basin"]) if row["basin"] in C.BASINS else 0
        cat = row["imd_category"]
        regime = row["regime"]

        return {
            "frames": torch.from_numpy(frames),
            "mask": torch.from_numpy(mask),
            "offsets": torch.from_numpy(offsets),
            "tabular": torch.from_numpy(tab),
            "tabular_valid": torch.from_numpy(tab_valid),
            "basin": torch.tensor(basin, dtype=torch.long),
            # targets
            "t_vmax": torch.tensor(float(row["vmax_kt"]), dtype=torch.float32),
            "t_pmin": torch.tensor(
                float(row["pmin_hpa"]) if np.isfinite(row["pmin_hpa"]) else float("nan"),
                dtype=torch.float32),
            "t_category": torch.tensor(
                IMD_CATEGORIES.index(cat) if cat in IMD_CATEGORIES else -100,
                dtype=torch.long),
            "t_regime": torch.tensor(
                REGIMES.index(regime) if regime in REGIMES else -100, dtype=torch.long),
            "t_detection": torch.tensor(detection_label(row), dtype=torch.long),
            "t_dvorak": torch.tensor(dvorak_scene_label(row), dtype=torch.long),
            "t_ri": torch.tensor(
                float(row["ri_24h"]) if np.isfinite(row["ri_24h"]) else float("nan"),
                dtype=torch.float32),
            "t_reintensify": torch.tensor(
                float(row["reintensify_land"])
                if np.isfinite(row["reintensify_land"]) else float("nan"),
                dtype=torch.float32),
            "t_centre": torch.from_numpy(target_centre),
            "row_idx": torch.tensor(row_idx, dtype=torch.long),
        }


# ------------------------------------------------------------ losses


def focal_ce(logits: torch.Tensor, target: torch.Tensor, weight: torch.Tensor | None = None,
             gamma: float = 2.0, ignore_index: int = -100) -> torch.Tensor:
    """Class-balanced focal cross-entropy.

    The category distribution runs from 6,048 depression fixes to 46 super
    cyclonic storm fixes. Plain cross-entropy on that spends its capacity
    getting depressions right. Focal down-weights the easy majority so the tail
    contributes, and the class weights carry the rest.

    SMOTE is deliberately not used anywhere. Interpolating between two satellite
    images produces a picture of a storm that does not exist and cannot exist.
    """
    valid = target != ignore_index
    if valid.sum() == 0:
        return logits.sum() * 0.0
    logits, target = logits[valid], target[valid]
    logp = torch.log_softmax(logits, dim=-1)
    logpt = logp.gather(1, target[:, None]).squeeze(1)
    pt = logpt.exp()
    loss = -((1 - pt) ** gamma) * logpt
    if weight is not None:
        loss = loss * weight.to(logits.device)[target]
    return loss.mean()


def gaussian_nll(pred: torch.Tensor, logvar: torch.Tensor,
                 target: torch.Tensor) -> torch.Tensor:
    """Heteroscedastic regression loss.

    The network predicts a mean and a log variance, and the variance is what
    the side panel renders as the plus-or-minus. Training it with a plain Huber
    loss would give a point estimate and no uncertainty, and no derived field is
    allowed to ship without one.

    A Huber term on the mean is kept alongside so that a few bad fixes cannot
    drag the fit, since the NLL is quadratic in the residual.
    """
    ok = torch.isfinite(target)
    if ok.sum() == 0:
        return pred.sum() * 0.0
    p, lv, t = pred[ok], logvar[ok], target[ok]
    nll = 0.5 * (lv + (t - p) ** 2 / lv.exp())
    huber = torch.nn.functional.huber_loss(p, t, delta=1.0, reduction="none")
    return (nll + 0.15 * huber).mean()


def masked_bce(logit: torch.Tensor, target: torch.Tensor,
               pos_weight: float = 1.0, gamma: float = 2.0) -> torch.Tensor:
    """Focal binary cross-entropy that skips unlabelled rows.

    Rows near the end of a storm have no +24 h target, so they are NaN rather
    than zero. Treating them as negatives would add hundreds of false negatives
    to a 3.5 percent event.
    """
    ok = torch.isfinite(target)
    if ok.sum() == 0:
        return logit.sum() * 0.0
    z, t = logit[ok], target[ok]
    p = torch.sigmoid(z)
    ce = torch.nn.functional.binary_cross_entropy_with_logits(
        z, t, reduction="none",
        pos_weight=torch.tensor(pos_weight, device=z.device),
    )
    pt = torch.where(t > 0.5, p, 1 - p)
    return (((1 - pt) ** gamma) * ce).mean()


def centre_loss(pred_offset: torch.Tensor, pred_sigma: torch.Tensor,
                target: torch.Tensor, heatmap: torch.Tensor,
                target_sigma_cells: float = 1.6) -> torch.Tensor:
    """Heatmap supervision, offset regression, and a concentration term.

    The heatmap term matters most and was missing at first. Supervising only the
    softmax expectation is a weak signal: the expectation of a distribution is
    one number per axis, so a wide, badly-shaped heatmap whose mean happens to
    land in the right place scores as well as a correctly peaked one. Training
    that way left the centre error at 52 km from a 70 km first guess, which is
    barely a refinement at all.

    Placing an explicit Gaussian target on the heatmap supervises the whole
    distribution rather than its first moment, which is what the model
    specification asks for. Cross-entropy against the normalised Gaussian rather
    than plain MSE, because the prediction is already a softmax and matching two
    distributions is the natural objective for it.

    The concentration term stays, for a separate reason: sigma is what the
    uncertainty ellipse is drawn from, so a distribution that is accurate but
    unpeaked would produce a confident-looking ellipse with nothing behind it.
    """
    last = heatmap[:, -1]
    b, h, w = last.shape
    dev = last.device

    # The target width is set in heatmap cells, not in normalised units.
    #
    # This was wrong first time and made the head worse than its own first
    # guess. A fixed sigma of 0.06 in normalised coordinates is narrower than
    # one cell whenever the heatmap is coarser than 33 by 33, and at 96 px input
    # the heatmap is 24 by 24, so one cell spans 0.083. The target Gaussian
    # collapsed to a sub-cell spike, which is close to a one-hot target on a
    # coarse grid: hard to fit, and it pulls against the offset term, which is
    # computed from the distribution's smooth expectation.
    #
    # Expressing the width in cells keeps the target a few cells wide at any
    # resolution, which is what both terms can agree on.
    cell = 2.0 / max(h, 1)
    sigma = max(target_sigma_cells * cell, 1e-3)

    ys = torch.linspace(-1, 1, h, device=dev)[None, :, None]
    xs = torch.linspace(-1, 1, w, device=dev)[None, None, :]
    tx = target[:, 0][:, None, None]
    ty = target[:, 1][:, None, None]

    # Gaussian target, normalised to a distribution over the grid.
    d2 = (xs - tx) ** 2 + (ys - ty) ** 2
    gauss = torch.exp(-d2 / (2.0 * sigma**2))
    gauss = gauss / gauss.sum(dim=(1, 2), keepdim=True).clamp(min=1e-8)

    logp = torch.log_softmax(last.reshape(b, -1), dim=1).reshape(b, h, w)
    heat = -(gauss * logp).sum(dim=(1, 2)).mean()

    err = torch.nn.functional.smooth_l1_loss(pred_offset, target, beta=0.1)
    concentration = pred_sigma.clamp(min=0.02).mean()
    # The offset term carries more weight than the heatmap term. The heatmap
    # shapes the distribution; the offset is the quantity actually reported.
    return 0.25 * heat + 1.5 * err + 0.05 * concentration


def class_weights(counts: np.ndarray, beta: float = 0.999) -> torch.Tensor:
    """Effective-number class weights.

    Inverse frequency over-corrects when the rarest class has 46 examples: the
    weight becomes so large that a handful of fixes dominate the gradient. The
    effective-number reweighting saturates instead.
    """
    counts = np.maximum(np.asarray(counts, dtype=float), 1.0)
    eff = (1.0 - np.power(beta, counts)) / (1.0 - beta)
    w = 1.0 / eff
    w = w / w.mean()
    return torch.tensor(w, dtype=torch.float32)


LOSS_WEIGHTS = {
    "vmax": 1.0,
    "pmin": 0.4,
    "category": 0.6,
    "detection": 0.3,
    "dvorak": 0.2,  # weakly supervised, so it gets less say
    "regime": 0.6,
    "ri": 0.8,
    "reintensify": 0.2,
    "centre": 1.1,
}


def total_loss(out: dict, batch: dict, weights: dict | None = None,
               cat_weight: torch.Tensor | None = None,
               regime_weight: torch.Tensor | None = None,
               ri_pos_weight: float = 12.0) -> tuple[torch.Tensor, dict]:
    """Sum of the head losses, and the parts, for logging."""
    w = {**LOSS_WEIGHTS, **(weights or {})}
    # Standardised units on both sides. Comparing a 980 hPa target with a 60 kt
    # target in raw units makes the pressure head roughly 250 times louder.
    parts = {
        "vmax": gaussian_nll(out["vmax_norm"], out["vmax_logvar"],
                             norm_vmax(batch["t_vmax"])),
        "pmin": gaussian_nll(out["pmin_norm"], out["pmin_logvar"],
                             norm_pmin(batch["t_pmin"])),
        "category": focal_ce(out["category"], batch["t_category"], cat_weight),
        "detection": focal_ce(out["detection"], batch["t_detection"]),
        "dvorak": focal_ce(out["dvorak"], batch["t_dvorak"]),
        "regime": focal_ce(out["regime"], batch["t_regime"], regime_weight),
        "ri": masked_bce(out["ri_logit"], batch["t_ri"], pos_weight=ri_pos_weight),
        "reintensify": masked_bce(
            out["reintensify_logit"], batch["t_reintensify"], pos_weight=40.0),
        "centre": centre_loss(
            out["centre_offset"], out["centre_sigma"], batch["t_centre"], out["heatmap"]),
    }
    total = sum(w[k] * v for k, v in parts.items())
    return total, {k: float(v.detach()) for k, v in parts.items()}
