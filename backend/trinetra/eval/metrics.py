"""Metric definitions. One function per metric, used everywhere.

The specification asks for one reporting function with one definition, because
the failure mode it prevents is real: a number computed one way in a notebook, a
different way in the API, and a third way on a slide, with nobody able to say
which one is on the poster.

Two tables, never blended. Analysis estimates the current state from current
observations and is scored against ADT and published fusion results. Forecast
predicts intensity change and RI at a lead time and is scored against
persistence and CLIPER. A number that mixes them means nothing.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Intensity bins for stratified reporting, on the IMD scale in knots. A single
# aggregate RMSE hides that most models are accurate on depressions, which are
# most of the data, and poor on the severe cases, which are the ones that matter.
INTENSITY_BINS = [
    ("17-33 kt (D, DD)", 17.0, 34.0),
    ("34-47 kt (CS)", 34.0, 48.0),
    ("48-63 kt (SCS)", 48.0, 64.0),
    ("64-89 kt (VSCS)", 64.0, 90.0),
    ("90+ kt (ESCS, SuCS)", 90.0, np.inf),
]


def jsonable(obj):
    """Recursively replace NaN and infinity with None.

    JSON has no representation for either, so a metric that is genuinely
    undefined has to travel as null. This matters for a real case rather than a
    hypothetical one: the climatology baseline issues no forecasts above the
    operational threshold, so its false-alarm ratio divides by zero, and a
    report containing that NaN cannot be serialised at all.

    None is also the honest encoding. An undefined false-alarm ratio is not
    zero, and writing zero would claim the baseline never raises a false alarm
    when in fact it never raises anything.
    """
    if isinstance(obj, dict):
        return {k: jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [jsonable(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return None if not np.isfinite(f) else f
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


def _clean(y_true, y_pred) -> tuple[np.ndarray, np.ndarray]:
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    ok = np.isfinite(y_true) & np.isfinite(y_pred)
    return y_true[ok], y_pred[ok]


def rmse(y_true, y_pred) -> float:
    t, p = _clean(y_true, y_pred)
    return float(np.sqrt(np.mean((t - p) ** 2))) if t.size else float("nan")


def mae(y_true, y_pred) -> float:
    t, p = _clean(y_true, y_pred)
    return float(np.mean(np.abs(t - p))) if t.size else float("nan")


def bias(y_true, y_pred) -> float:
    """Mean signed error. Reported alongside RMSE because a model that is
    consistently 6 kt low is a different problem from one that is noisy."""
    t, p = _clean(y_true, y_pred)
    return float(np.mean(p - t)) if t.size else float("nan")


def regression_report(y_true, y_pred, stratify_by=None) -> dict:
    """RMSE, MAE and bias overall, and within each intensity bin."""
    out = {
        "n": int(np.sum(np.isfinite(np.asarray(y_true, float)) &
                        np.isfinite(np.asarray(y_pred, float)))),
        "rmse": rmse(y_true, y_pred),
        "mae": mae(y_true, y_pred),
        "bias": bias(y_true, y_pred),
    }
    strat = np.asarray(stratify_by if stratify_by is not None else y_true, dtype=float)
    bins = []
    for label, lo, hi in INTENSITY_BINS:
        sel = (strat >= lo) & (strat < hi)
        if sel.sum() >= 10:
            bins.append({
                "bin": label,
                "n": int(sel.sum()),
                "rmse": rmse(np.asarray(y_true)[sel], np.asarray(y_pred)[sel]),
                "mae": mae(np.asarray(y_true)[sel], np.asarray(y_pred)[sel]),
                "bias": bias(np.asarray(y_true)[sel], np.asarray(y_pred)[sel]),
            })
    out["by_intensity"] = bins
    return out


# ------------------------------------------------------------ classification


def confusion(y_true, y_pred, classes: list[str]) -> np.ndarray:
    idx = {c: i for i, c in enumerate(classes)}
    m = np.zeros((len(classes), len(classes)), dtype=int)
    for t, p in zip(y_true, y_pred):
        if t in idx and p in idx:
            m[idx[t], idx[p]] += 1
    return m


def macro_f1(y_true, y_pred, classes: list[str]) -> float:
    """Macro-averaged F1. Never overall accuracy.

    The category distribution runs from 6,048 depressions to 46 super cyclonic
    storm fixes. Overall accuracy on that is a measure of how often the model
    says depression.
    """
    m = confusion(y_true, y_pred, classes)
    f1s = []
    for i in range(len(classes)):
        tp = m[i, i]
        fp = m[:, i].sum() - tp
        fn = m[i, :].sum() - tp
        if tp + fn == 0:
            continue  # class absent from the truth, so it has no recall
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn)
        f1s.append(2 * prec * rec / (prec + rec) if prec + rec else 0.0)
    return float(np.mean(f1s)) if f1s else float("nan")


def classification_report(y_true, y_pred, classes: list[str]) -> dict:
    m = confusion(y_true, y_pred, classes)
    per = []
    for i, c in enumerate(classes):
        tp = m[i, i]
        fp = m[:, i].sum() - tp
        fn = m[i, :].sum() - tp
        support = int(m[i, :].sum())
        prec = float(tp / (tp + fp)) if tp + fp else 0.0
        rec = float(tp / (tp + fn)) if tp + fn else 0.0
        per.append({
            "class": c, "support": support, "precision": round(prec, 4),
            "recall": round(rec, 4),
            "f1": round(2 * prec * rec / (prec + rec), 4) if prec + rec else 0.0,
        })
    return {
        "n": int(m.sum()),
        "macro_f1": macro_f1(y_true, y_pred, classes),
        "accuracy": float(np.trace(m) / m.sum()) if m.sum() else float("nan"),
        "confusion": m.tolist(),
        "classes": classes,
        "per_class": per,
    }


# ------------------------------------------------------------ probabilistic


def brier(y_true, p_pred) -> float:
    t, p = _clean(y_true, p_pred)
    return float(np.mean((p - t) ** 2)) if t.size else float("nan")


def brier_skill_score(y_true, p_pred, climatology: float | None = None) -> float:
    """Brier Skill Score against climatology.

    Positive means better than always predicting the base rate. On a 3.5 percent
    event this is the only intensity-forecast score that means anything: a model
    that always predicts zero gets a Brier score of 0.035 and is useless.
    """
    t, p = _clean(y_true, p_pred)
    if t.size == 0:
        return float("nan")
    clim = float(np.mean(t)) if climatology is None else float(climatology)
    bs_ref = float(np.mean((clim - t) ** 2))
    return float(1.0 - brier(t, p) / bs_ref) if bs_ref > 0 else float("nan")


def roc_auc(y_true, p_pred) -> float:
    """Area under the ROC curve, by the rank-sum identity.

    Reported next to the Brier score because the two answer different questions
    and can move in opposite directions. Class weighting on a rare event raises
    AUC and wrecks the Brier score: the model got better at ranking which fixes
    will intensify and worse at saying how likely it is. Quoting only one of
    them hides half of what happened.

    AUC is also invariant to any monotone rescaling of the scores, which is why
    calibration can repair the Brier score without changing AUC at all.
    """
    t, p = _clean(y_true, p_pred)
    pos, neg = p[t == 1], p[t == 0]
    if pos.size == 0 or neg.size == 0:
        return float("nan")
    ranks = np.argsort(np.argsort(p)) + 1.0
    # Average ranks within ties so a constant score gives 0.5 rather than 1.0.
    order = np.argsort(p)
    sorted_p = p[order]
    i = 0
    while i < len(sorted_p):
        j = i
        while j + 1 < len(sorted_p) and sorted_p[j + 1] == sorted_p[i]:
            j += 1
        if j > i:
            ranks[order[i:j + 1]] = np.mean(ranks[order[i:j + 1]])
        i = j + 1
    r_pos = ranks[t == 1].sum()
    return float((r_pos - pos.size * (pos.size + 1) / 2.0) / (pos.size * neg.size))


def reliability(y_true, p_pred, n_bins: int = 10) -> list[dict]:
    """Reliability diagram points: forecast probability against observed frequency.

    Equal-width bins. Bins with fewer than five cases are returned with their
    count so the plot can drop them rather than showing a spike built on two
    events.
    """
    t, p = _clean(y_true, p_pred)
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    out = []
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        sel = (p >= lo) & (p < hi if i < n_bins - 1 else p <= hi)
        if sel.sum() == 0:
            continue
        out.append({
            "bin_lo": round(float(lo), 3), "bin_hi": round(float(hi), 3),
            "n": int(sel.sum()),
            "mean_forecast": round(float(p[sel].mean()), 4),
            "observed_frequency": round(float(t[sel].mean()), 4),
        })
    return out


def contingency(y_true, p_pred, threshold: float) -> dict:
    """POD, FAR and CSI at an operational threshold."""
    t, p = _clean(y_true, p_pred)
    yes = p >= threshold
    hit = int(np.sum(yes & (t == 1)))
    miss = int(np.sum(~yes & (t == 1)))
    false_alarm = int(np.sum(yes & (t == 0)))
    correct_neg = int(np.sum(~yes & (t == 0)))
    # None rather than NaN where the ratio is undefined. The climatology
    # baseline forecasts nothing above threshold, so hits + false alarms is
    # zero and its false-alarm ratio has no value. Reporting 0.0 there would
    # read as a perfect false-alarm record.
    pod = hit / (hit + miss) if hit + miss else None
    far = false_alarm / (hit + false_alarm) if hit + false_alarm else None
    denom = hit + miss + false_alarm
    csi = hit / denom if denom else None
    return {
        "threshold": round(float(threshold), 3),
        "hits": hit, "misses": miss,
        "false_alarms": false_alarm, "correct_negatives": correct_neg,
        "pod": None if pod is None else round(float(pod), 4),
        "far": None if far is None else round(float(far), 4),
        "csi": None if csi is None else round(float(csi), 4),
        "forecasts_issued": hit + false_alarm,
    }


def cost_loss_value(y_true, p_pred, cost_loss_ratios=None) -> list[dict]:
    """Potential economic value across cost-loss ratios.

    The question a warning decision actually poses: for a user whose cost of
    acting is a given fraction of their loss from being caught out, does this
    forecast beat both always acting and never acting. A forecast can have a
    good Brier score and no value at any realistic ratio.
    """
    t, p = _clean(y_true, p_pred)
    if t.size == 0:
        return []
    ratios = cost_loss_ratios if cost_loss_ratios is not None else np.linspace(0.05, 0.95, 19)
    base = float(np.mean(t))
    out = []
    for a in ratios:
        best = -np.inf
        # The user acts when the probability exceeds their own cost-loss ratio,
        # but the optimal threshold is swept because a miscalibrated forecast
        # can still have value at a different one.
        for thr in np.linspace(0.02, 0.98, 49):
            c = contingency(t, p, thr)
            h, m, f = c["hits"], c["misses"], c["false_alarms"]
            n = t.size
            expense = (a * (h + f) + m) / n
            clim_expense = min(a, base)
            perfect = a * base
            if clim_expense - perfect <= 0:
                continue
            value = (clim_expense - expense) / (clim_expense - perfect)
            best = max(best, value)
        out.append({"cost_loss_ratio": round(float(a), 3),
                    "value": round(float(best), 4) if np.isfinite(best) else None})
    return out


def probabilistic_report(y_true, p_pred, threshold: float = 0.45) -> dict:
    return {
        "n": int(np.sum(np.isfinite(np.asarray(y_true, float)))),
        "base_rate": float(np.nanmean(np.asarray(y_true, float))),
        "mean_forecast": float(np.nanmean(np.asarray(p_pred, float))),
        "brier": brier(y_true, p_pred),
        "brier_skill_score": brier_skill_score(y_true, p_pred),
        "roc_auc": roc_auc(y_true, p_pred),
        "reliability": reliability(y_true, p_pred),
        "contingency": contingency(y_true, p_pred, threshold),
        "cost_loss": cost_loss_value(y_true, p_pred),
    }


# ------------------------------------------------------------ intervals


@dataclass(frozen=True)
class Interval:
    point: float
    lo: float
    hi: float
    level: float = 0.95

    def as_dict(self) -> dict:
        return {"point": round(self.point, 4), "ci_lo": round(self.lo, 4),
                "ci_hi": round(self.hi, 4), "level": self.level}

    def __str__(self) -> str:
        return f"{self.point:.2f} [{self.lo:.2f}, {self.hi:.2f}]"


def bootstrap_ci(y_true, y_pred, statistic=rmse, groups=None,
                 n_boot: int = 2000, level: float = 0.95,
                 seed: int = 0) -> Interval:
    """Bootstrap confidence interval, resampling groups rather than rows.

    The group key is the storm. Resampling individual fixes would treat
    consecutive 3-hourly observations of the same storm as independent, which
    they are not, and would return an interval several times too narrow. With
    North Indian Ocean sample sizes a point estimate without an interval is not
    a result, and an interval computed the wrong way is worse than none.
    """
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    ok = np.isfinite(y_true) & np.isfinite(y_pred)
    y_true, y_pred = y_true[ok], y_pred[ok]
    point = statistic(y_true, y_pred)
    if y_true.size == 0:
        return Interval(float("nan"), float("nan"), float("nan"), level)

    rng = np.random.default_rng(seed)
    if groups is None:
        idx_pool = [np.arange(y_true.size)]
    else:
        g = np.asarray(groups)[ok]
        idx_pool = [np.nonzero(g == u)[0] for u in np.unique(g)]

    stats = np.empty(n_boot)
    n_groups = len(idx_pool)
    for b in range(n_boot):
        pick = rng.integers(0, n_groups, n_groups)
        idx = np.concatenate([idx_pool[i] for i in pick])
        stats[b] = statistic(y_true[idx], y_pred[idx])
    alpha = (1.0 - level) / 2.0
    lo, hi = np.nanpercentile(stats, [100 * alpha, 100 * (1 - alpha)])
    return Interval(float(point), float(lo), float(hi), level)
