"""Probability calibration and conformal intervals.

Why this module exists, concretely
----------------------------------
Rapid intensification happens on 3.5 percent of fixes. Fit a logistic
regression on that without weighting and it predicts nothing; the optimiser
finds that always saying no is close to optimal. Weight the positive class by
the inverse frequency and it starts finding events, at 79 percent probability of
detection on the real best-track, but the probabilities it returns are no longer
probabilities. They average around 30 percent on a 3.5 percent event, so the
Brier score goes from 0.034 to 0.160 and the Brier Skill Score to -3.77. The
model is now better at ranking and much worse at answering.

Both things are true at once and they are measured by different scores.
Discrimination is what AUC measures and it improved. Calibration is what the
Brier score and the reliability diagram measure and it collapsed.

The fix is not to drop the weighting, because discrimination is the part that is
hard to get. It is to fit a one-dimensional monotone map from the model's score
to a calibrated probability, on data the model did not train on. Ranking is
preserved exactly, since the map is monotone, and the probabilities become
usable.

Isotonic regression is the default because it makes no shape assumption. Platt
scaling is available for small samples, where isotonic overfits its own steps.

Everything here is nested. The calibrator is fitted on an inner split of the
training fold, never on the test fold, or the reported calibration would be the
calibration on data it was tuned against.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class IsotonicCalibrator:
    """Monotone step function from score to probability.

    Pool-adjacent-violators, written out rather than imported so the calibration
    path has no dependency that could stop the demo running.
    """

    x: np.ndarray
    y: np.ndarray
    method: str = "isotonic"

    @classmethod
    def fit(cls, scores, targets) -> IsotonicCalibrator:
        s = np.asarray(scores, dtype=float)
        t = np.asarray(targets, dtype=float)
        ok = np.isfinite(s) & np.isfinite(t)
        s, t = s[ok], t[ok]
        order = np.argsort(s)
        s, t = s[order], t[order]

        # Pool adjacent violators.
        values = t.astype(float).copy()
        weights = np.ones_like(values)
        blocks = [[v, w, i, i] for i, (v, w) in enumerate(zip(values, weights))]
        merged = True
        while merged:
            merged = False
            out: list[list] = []
            for b in blocks:
                if out and out[-1][0] > b[0] - 1e-12:
                    prev = out[-1]
                    tw = prev[1] + b[1]
                    prev[0] = (prev[0] * prev[1] + b[0] * b[1]) / tw
                    prev[1] = tw
                    prev[3] = b[3]
                    merged = True
                else:
                    out.append(list(b))
            blocks = out

        xs, ys = [], []
        for value, _w, lo, hi in blocks:
            xs.append(s[lo])
            ys.append(value)
            xs.append(s[hi])
            ys.append(value)
        return cls(np.asarray(xs), np.clip(np.asarray(ys), 0.0, 1.0))

    def predict(self, scores) -> np.ndarray:
        s = np.asarray(scores, dtype=float)
        if len(self.x) < 2:
            return np.full(s.shape, float(self.y[0]) if len(self.y) else 0.0)
        return np.clip(np.interp(s, self.x, self.y), 0.0, 1.0)


@dataclass
class PlattCalibrator:
    """Logistic map from score to probability. Two parameters, so it survives
    small calibration sets where isotonic would fit its own noise."""

    a: float
    b: float
    method: str = "platt"

    @classmethod
    def fit(cls, scores, targets, iters: int = 200) -> PlattCalibrator:
        s = np.asarray(scores, dtype=float)
        t = np.asarray(targets, dtype=float)
        ok = np.isfinite(s) & np.isfinite(t)
        s, t = s[ok], t[ok]
        a, b = 1.0, 0.0
        for _ in range(iters):
            z = a * s + b
            p = 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))
            g = np.array([np.sum((p - t) * s), np.sum(p - t)])
            w = p * (1 - p)
            h = np.array([
                [np.sum(w * s * s), np.sum(w * s)],
                [np.sum(w * s), np.sum(w)],
            ]) + 1e-9 * np.eye(2)
            try:
                step = np.linalg.solve(h, g)
            except np.linalg.LinAlgError:
                break
            a, b = a - step[0], b - step[1]
            if np.max(np.abs(step)) < 1e-9:
                break
        return cls(float(a), float(b))

    def predict(self, scores) -> np.ndarray:
        z = self.a * np.asarray(scores, dtype=float) + self.b
        return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


def fit_calibrator(scores, targets, method: str = "auto"):
    """Pick a calibrator. Isotonic needs a reasonable number of positives."""
    t = np.asarray(targets, dtype=float)
    n_pos = int(np.nansum(t))
    if method == "auto":
        method = "isotonic" if n_pos >= 40 else "platt"
    return (IsotonicCalibrator if method == "isotonic" else PlattCalibrator).fit(
        scores, targets
    )


def inner_split(n: int, groups=None, calib_frac: float = 0.3, seed: int = 0):
    """Split a training fold into a fit part and a calibration part.

    Grouped by storm like every other split in this project. Calibrating on
    fixes whose storm the model trained on would give an optimistic reliability
    diagram, which is the one plot that has to be trustworthy.
    """
    rng = np.random.default_rng(seed)
    if groups is None:
        idx = rng.permutation(n)
        cut = int(n * (1 - calib_frac))
        return idx[:cut], idx[cut:]

    groups = np.asarray(groups)
    uniq = np.unique(groups)
    rng.shuffle(uniq)
    cut = max(1, int(len(uniq) * (1 - calib_frac)))
    fit_groups = set(uniq[:cut])
    is_fit = np.array([g in fit_groups for g in groups])
    return np.nonzero(is_fit)[0], np.nonzero(~is_fit)[0]


# ------------------------------------------------------------ conformal


@dataclass
class ConformalInterval:
    """Split-conformal prediction interval for a regression head.

    Gives a coverage guarantee that does not depend on the model being right
    about its own uncertainty. The residual quantile is measured on held-out
    data, so a stated 90 percent interval covers 90 percent of held-out cases by
    construction rather than by assumption.

    This is what lets the Explorer draw a track cone whose stated coverage has
    actually been verified, instead of a band whose width came from a
    convenient multiple of a standard deviation.
    """

    quantile: float
    level: float

    @classmethod
    def fit(cls, y_true, y_pred, level: float = 0.9) -> ConformalInterval:
        t = np.asarray(y_true, dtype=float)
        p = np.asarray(y_pred, dtype=float)
        ok = np.isfinite(t) & np.isfinite(p)
        residuals = np.abs(t[ok] - p[ok])
        n = residuals.size
        if n == 0:
            return cls(float("nan"), level)
        # The finite-sample correction. Using the plain empirical quantile
        # undercovers, slightly but systematically.
        k = min(int(np.ceil((n + 1) * level)), n)
        q = float(np.sort(residuals)[k - 1])
        return cls(q, level)

    def interval(self, y_pred) -> tuple[np.ndarray, np.ndarray]:
        p = np.asarray(y_pred, dtype=float)
        return p - self.quantile, p + self.quantile

    def empirical_coverage(self, y_true, y_pred) -> float:
        """The check that has to be run and reported, not assumed."""
        lo, hi = self.interval(y_pred)
        t = np.asarray(y_true, dtype=float)
        ok = np.isfinite(t)
        return float(np.mean((t[ok] >= lo[ok]) & (t[ok] <= hi[ok])))


def adaptive_conformal(y_true, y_pred, level: float = 0.9,
                       bins=None, by=None) -> dict:
    """Conformal intervals fitted separately within strata.

    A single global interval is too wide for depressions and too narrow for
    severe systems, because the residual scale grows with intensity. Fitting per
    stratum keeps coverage honest across the range instead of on average.
    """
    by = np.asarray(by if by is not None else y_pred, dtype=float)
    bins = bins if bins is not None else [0, 34, 48, 64, 90, np.inf]
    out = {}
    for i in range(len(bins) - 1):
        sel = (by >= bins[i]) & (by < bins[i + 1])
        if sel.sum() < 25:
            continue
        ci = ConformalInterval.fit(np.asarray(y_true)[sel], np.asarray(y_pred)[sel], level)
        out[f"{bins[i]:.0f}-{bins[i + 1]:.0f}"] = {
            "quantile": round(ci.quantile, 3),
            "n": int(sel.sum()),
            "coverage": round(
                ci.empirical_coverage(np.asarray(y_true)[sel], np.asarray(y_pred)[sel]), 4
            ),
        }
    return out
