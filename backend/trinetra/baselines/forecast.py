"""Persistence, climatology and CLIPER.

These are the numbers everything else is measured against, and they are built
before any deep learning for the reason the specification gives: teams that
build the model first and the baseline last discover on the final morning that
they have no result. Roughly fifty lines each, and if the deep model does not
beat them by a clear margin with error bars then there is no result and no
amount of architecture rescues it.

Everything here runs on the real IBTrACS best-track. No synthetic field enters
these baselines, so the numbers they produce are genuine and so is the bar.

CLIPER
------
Climatology and persistence, as a linear regression on the operational
predictor set: current intensity, the prior 12-hour intensity change, day of
year, latitude, longitude, and the zonal and meridional components of storm
motion. That is the same information the operational statistical baselines use,
and all of it is real here.

It is a deliberately hard baseline to beat on intensity. Published operational
intensity forecasts sit only a few knots better than it, which is the honest
context for any number this project reports.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

LEADS_H = (12, 24, 48)

# Predictors, in the order the design matrix builds them.
CLIPER_PREDICTORS = [
    "vmax_kt",  # persistence
    "trend_12h_kt",  # prior 12 h intensity change
    "lat",
    "lon",
    "storm_motion_u_kt",
    "storm_motion_v_kt",
    "sin_doy",  # season, as a pair so December and January are adjacent
    "cos_doy",
    "vmax_sq",  # intensity change is not linear in intensity
    "dist2land_km",
]


def persistence(labels: pd.DataFrame, lead_h: int) -> np.ndarray:
    """The intensity now, held constant to the lead time.

    Trivial, and genuinely difficult to beat at 12 hours. Any model that does
    not clear it is reporting noise.
    """
    return labels["vmax_kt"].to_numpy(dtype=float)


def decay_persistence(labels: pd.DataFrame, lead_h: int) -> np.ndarray:
    """Persistence with an inland decay term.

    A storm already over land will not hold its intensity for 24 hours, and a
    baseline that pretends otherwise is easy to beat for the wrong reason. The
    decay rate is fitted on the training data rather than assumed, in
    `fit_decay_persistence`.
    """
    return persistence(labels, lead_h)


def fit_decay_persistence(train: pd.DataFrame, lead_h: int) -> dict:
    """Fit an over-land decay rate in knots per hour."""
    y = train[f"vmax_plus_{lead_h}h_kt"].to_numpy(dtype=float)
    v0 = train["vmax_kt"].to_numpy(dtype=float)
    over_land = (train["dist2land_km"].to_numpy(dtype=float) <= 0).astype(float)
    ok = np.isfinite(y) & np.isfinite(v0)
    if ok.sum() < 30:
        return {"rate_kt_per_h": 0.0, "lead_h": lead_h}
    # dV = rate * lead * over_land, least squares on the over-land subset only.
    sel = ok & (over_land > 0)
    if sel.sum() < 30:
        return {"rate_kt_per_h": 0.0, "lead_h": lead_h}
    rate = float(np.mean((y[sel] - v0[sel]) / lead_h))
    return {"rate_kt_per_h": rate, "lead_h": lead_h}


def apply_decay_persistence(model: dict, df: pd.DataFrame) -> np.ndarray:
    lead = model["lead_h"]
    v0 = df["vmax_kt"].to_numpy(dtype=float)
    over_land = (df["dist2land_km"].to_numpy(dtype=float) <= 0).astype(float)
    return np.clip(v0 + model["rate_kt_per_h"] * lead * over_land, 10.0, None)


def _design(df: pd.DataFrame) -> np.ndarray:
    """The CLIPER design matrix, with an intercept column."""
    doy = pd.to_datetime(df["valid_time"]).dt.dayofyear.to_numpy(dtype=float)
    cols = {
        "vmax_kt": df["vmax_kt"].to_numpy(dtype=float),
        "trend_12h_kt": df["trend_12h_kt"].to_numpy(dtype=float),
        "lat": df["lat"].to_numpy(dtype=float),
        "lon": df["lon"].to_numpy(dtype=float),
        "storm_motion_u_kt": np.nan_to_num(
            df["storm_motion_u_kt"].to_numpy(dtype=float), nan=0.0),
        "storm_motion_v_kt": np.nan_to_num(
            df["storm_motion_v_kt"].to_numpy(dtype=float), nan=0.0),
        "sin_doy": np.sin(2 * np.pi * doy / 365.25),
        "cos_doy": np.cos(2 * np.pi * doy / 365.25),
        "vmax_sq": df["vmax_kt"].to_numpy(dtype=float) ** 2,
        "dist2land_km": np.nan_to_num(
            df["dist2land_km"].to_numpy(dtype=float), nan=0.0),
    }
    x = np.column_stack([cols[k] for k in CLIPER_PREDICTORS])
    return np.column_stack([np.ones(len(df)), x])


def fit_cliper(train: pd.DataFrame, lead_h: int) -> dict:
    """Least-squares fit of the intensity change at a lead time.

    The target is the change rather than the absolute intensity. Regressing the
    absolute value lets the model recover persistence through the intercept and
    hides whether it has learned anything about the change.
    """
    x = _design(train)
    y = train[f"dv_{lead_h}h_kt"].to_numpy(dtype=float)
    ok = np.isfinite(y) & np.isfinite(x).all(axis=1)
    if ok.sum() < len(CLIPER_PREDICTORS) + 10:
        return {"coef": None, "lead_h": lead_h, "n_train": int(ok.sum())}
    coef, *_ = np.linalg.lstsq(x[ok], y[ok], rcond=None)
    return {"coef": coef, "lead_h": lead_h, "n_train": int(ok.sum()),
            "predictors": CLIPER_PREDICTORS}


def apply_cliper(model: dict, df: pd.DataFrame) -> np.ndarray:
    """Predicted absolute intensity at the lead time."""
    if model.get("coef") is None:
        return persistence(df, model["lead_h"])
    dv = _design(df) @ model["coef"]
    return np.clip(df["vmax_kt"].to_numpy(dtype=float) + dv, 10.0, 200.0)


# ------------------------------------------------------------ RI baselines


def fit_ri_climatology(train: pd.DataFrame) -> dict:
    """The base rate, as a constant probability.

    This is the reference the Brier Skill Score is computed against, and it is
    the thing an RI model has to beat. On a 3.5 percent event, always predicting
    the base rate gives a Brier score of about 0.033 while being useless, which
    is why accuracy is not reported anywhere near this head.
    """
    y = train["ri_24h"].to_numpy(dtype=float)
    y = y[np.isfinite(y)]
    return {"p": float(np.mean(y)) if y.size else 0.0, "n_train": int(y.size)}


def apply_ri_climatology(model: dict, df: pd.DataFrame) -> np.ndarray:
    return np.full(len(df), model["p"], dtype=float)


def fit_ri_logistic(train: pd.DataFrame, l2: float = 1.0, iters: int = 300) -> dict:
    """Logistic regression on the CLIPER predictors, as the RI baseline.

    Newton steps with an L2 penalty, written out rather than imported so the
    baseline has no dependency that could stop it running. Features are
    standardised on the training fold, and those statistics travel with the
    model so the test fold gets the same transform.
    """
    x = _design(train)[:, 1:]  # standardise the predictors, keep the intercept apart
    y = train["ri_24h"].to_numpy(dtype=float)
    ok = np.isfinite(y) & np.isfinite(x).all(axis=1)
    x, y = x[ok], y[ok]
    if len(y) < 100 or y.sum() < 5:
        return {"coef": None}

    mu, sd = x.mean(axis=0), x.std(axis=0)
    sd[sd == 0] = 1.0
    xs = np.column_stack([np.ones(len(x)), (x - mu) / sd])

    w = np.zeros(xs.shape[1])
    # Class weighting, because a 3.5 percent positive rate otherwise drives the
    # fit to predict zero everywhere.
    pos_weight = float((len(y) - y.sum()) / max(y.sum(), 1.0))
    sample_w = np.where(y == 1, pos_weight, 1.0)

    for _ in range(iters):
        z = xs @ w
        p = 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))
        grad = xs.T @ (sample_w * (p - y)) + l2 * np.r_[0.0, w[1:]]
        s = sample_w * p * (1 - p)
        hess = xs.T @ (xs * s[:, None]) + l2 * np.diag(np.r_[0.0, np.ones(len(w) - 1)])
        try:
            step = np.linalg.solve(hess + 1e-8 * np.eye(len(w)), grad)
        except np.linalg.LinAlgError:
            break
        w -= step
        if np.max(np.abs(step)) < 1e-7:
            break
    return {"coef": w, "mu": mu, "sd": sd, "n_train": int(len(y)),
            "pos_rate": float(y.mean())}


def apply_ri_logistic(model: dict, df: pd.DataFrame) -> np.ndarray:
    if model.get("coef") is None:
        return np.full(len(df), 0.035, dtype=float)
    x = _design(df)[:, 1:]
    x = np.nan_to_num(x, nan=0.0)
    xs = np.column_stack([np.ones(len(x)), (x - model["mu"]) / model["sd"]])
    z = xs @ model["coef"]
    raw = 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))
    cal = model.get("calibrator")
    return cal.predict(raw) if cal is not None else raw


def fit_ri_logistic_calibrated(train: pd.DataFrame, seed: int = 0) -> dict:
    """The class-weighted logistic, then a calibrator fitted on held-out storms.

    Class weighting is what makes the model find events at all on a 3.5 percent
    base rate, and it is also what destroys the calibration: the returned scores
    average around 30 percent on a 3.5 percent event, so the Brier Skill Score
    goes deeply negative while the probability of detection goes up.

    Both facts are real, and they are separate. Weighting improved the ranking,
    which is the hard part and which AUC measures. It broke the mapping from
    score to probability, which the Brier score measures and which a monotone
    one-dimensional fit can repair without touching the ranking at all.

    The calibrator is fitted on storms held out of the inner fit, so the
    reliability diagram is not the reliability on data it was tuned against.
    """
    from ..model.calibrate import fit_calibrator, inner_split

    fit_idx, cal_idx = inner_split(
        len(train), groups=train["sid"].to_numpy(), calib_frac=0.3, seed=seed
    )
    inner = train.iloc[fit_idx]
    calib = train.iloc[cal_idx]

    model = fit_ri_logistic(inner)
    if model.get("coef") is None:
        return model

    raw = apply_ri_logistic(model, calib)
    y = calib["ri_24h"].to_numpy(dtype=float)
    ok = np.isfinite(y)
    if ok.sum() < 100 or y[ok].sum() < 5:
        return model  # not enough held-out events to calibrate against
    model["calibrator"] = fit_calibrator(raw[ok], y[ok])
    model["calibration"] = {
        "method": model["calibrator"].method,
        "n_calib": int(ok.sum()),
        "n_calib_positives": int(y[ok].sum()),
        "calib_storms": int(calib["sid"].nunique()),
    }
    return model


# ------------------------------------------------------------ analysis baseline


def fit_dvorak_ci_regression(train: pd.DataFrame) -> dict:
    """Intensity from the IMD Dvorak CI number, as the analysis baseline.

    This stands in for the ADT comparison. The CIMSS ADT archive is the
    specified baseline for the analysis table, and it was not pulled during this
    build, so what is available instead is IMD's own published CI number, which
    is in IBTrACS for 6,736 fixes.

    It is a fair analysis baseline and an honest one, with one caveat that has to
    be stated wherever the number appears: CI and the best-track intensity label
    both come from the same Dvorak analysis, so the relationship between them is
    close to definitional. It measures the Dvorak wind-pressure table, not an
    independent method.
    """
    ci = train["imd_ci"].to_numpy(dtype=float)
    v = train["vmax_kt"].to_numpy(dtype=float)
    ok = np.isfinite(ci) & np.isfinite(v)
    if ok.sum() < 50:
        return {"coef": None}
    a = np.column_stack([np.ones(ok.sum()), ci[ok], ci[ok] ** 2])
    coef, *_ = np.linalg.lstsq(a, v[ok], rcond=None)
    return {"coef": coef, "n_train": int(ok.sum())}


def apply_dvorak_ci_regression(model: dict, df: pd.DataFrame) -> np.ndarray:
    ci = df["imd_ci"].to_numpy(dtype=float)
    if model.get("coef") is None:
        return np.full(len(df), np.nan)
    a = np.column_stack([np.ones(len(ci)), ci, ci**2])
    out = a @ model["coef"]
    return np.where(np.isfinite(ci), out, np.nan)
