"""Checks on the metric definitions and the split protocol."""

import numpy as np
import pandas as pd
import pytest

from trinetra.eval import metrics as M
from trinetra.eval import splits as S
from trinetra.model import calibrate as K


def test_auc_of_a_constant_forecast_is_exactly_half():
    """A forecast with no variation cannot discriminate.

    Ties must be averaged, not broken by array order. Breaking them by order
    gives 1.0 or 0.0 for a constant forecast, which then looks like either a
    perfect or an inverted model.
    """
    y = np.array([0, 1, 0, 1, 0, 0, 1, 0])
    assert M.roc_auc(y, np.full(len(y), 0.3)) == pytest.approx(0.5)


def test_auc_of_a_perfect_ranking_is_one():
    y = np.array([0, 0, 0, 1, 1])
    assert M.roc_auc(y, np.array([0.1, 0.2, 0.3, 0.8, 0.9])) == pytest.approx(1.0)
    assert M.roc_auc(y, np.array([0.9, 0.8, 0.3, 0.2, 0.1])) == pytest.approx(0.0)


def test_auc_matches_sklearn():
    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 400)
    p = np.clip(0.5 + 0.3 * y + rng.normal(0, 0.3, 400), 0, 1)
    try:
        from sklearn.metrics import roc_auc_score
    except ImportError:
        pytest.skip("scikit-learn not installed")
    assert M.roc_auc(y, p) == pytest.approx(roc_auc_score(y, p), abs=1e-9)


def test_auc_is_invariant_under_monotone_rescaling():
    """This is the property that lets calibration fix the Brier score without
    touching discrimination, and it is why both are reported."""
    rng = np.random.default_rng(1)
    y = rng.integers(0, 2, 300)
    p = rng.random(300)
    squashed = 1.0 / (1.0 + np.exp(-(6 * p - 3)))
    assert M.roc_auc(y, p) == pytest.approx(M.roc_auc(y, squashed), abs=1e-9)


def test_brier_skill_score_of_climatology_is_zero():
    y = np.array([0, 0, 1, 0, 0, 0, 0, 1, 0, 0], dtype=float)
    assert M.brier_skill_score(y, np.full(len(y), y.mean())) == pytest.approx(0.0)


def test_macro_f1_ignores_the_majority_class_advantage():
    """Always predicting the majority class must not score well."""
    classes = ["D", "CS", "SuCS"]
    y = ["D"] * 90 + ["CS"] * 9 + ["SuCS"]
    always_d = ["D"] * 100
    assert M.classification_report(y, always_d, classes)["accuracy"] == pytest.approx(0.9)
    assert M.macro_f1(y, always_d, classes) < 0.35


def test_grouped_bootstrap_is_wider_than_row_bootstrap():
    """Resampling rows treats 3-hourly fixes of one storm as independent and
    returns an interval several times too narrow."""
    rng = np.random.default_rng(3)
    groups = np.repeat(np.arange(20), 30)
    offset = rng.normal(0, 6, 20)[groups]  # a per-storm bias
    truth = rng.normal(60, 20, len(groups))
    pred = truth + offset + rng.normal(0, 1, len(groups))
    wide = M.bootstrap_ci(truth, pred, M.rmse, groups=groups, n_boot=400, seed=0)
    narrow = M.bootstrap_ci(truth, pred, M.rmse, groups=None, n_boot=400, seed=0)
    assert (wide.hi - wide.lo) > 2.5 * (narrow.hi - narrow.lo)


def _fake_labels(n_storms=12, per=25):
    rows = []
    for s in range(n_storms):
        for k in range(per):
            rows.append({
                "sid": f"S{s:03d}", "season": 2000 + s // 3,
                "valid_time": pd.Timestamp("2005-05-01") + pd.Timedelta(hours=3 * k),
                "vmax_kt": 30.0 + k, "ri_24h": float(k % 9 == 0),
            })
    return pd.DataFrame(rows)


def test_leave_one_season_out_never_leaks_a_storm():
    labels = _fake_labels()
    folds = S.leave_one_season_out(labels, min_test_fixes=10, min_test_storms=1)
    S.verify_no_storm_leakage(labels, folds)
    assert len(folds) == labels["season"].nunique()


def test_grouped_kfold_never_leaks_a_storm():
    labels = _fake_labels()
    folds = S.grouped_kfold(labels, n_folds=4)
    S.verify_no_storm_leakage(labels, folds)
    assert sum(len(f.test_idx) for f in folds) == len(labels)


def test_leakage_check_actually_catches_a_leak():
    labels = _fake_labels(n_storms=4, per=10)
    bad = [S.Split("bad", np.arange(0, 25), np.arange(20, 40))]
    with pytest.raises(AssertionError):
        S.verify_no_storm_leakage(labels, bad)


def test_isotonic_calibration_is_monotone_and_nearly_preserves_auc():
    """Isotonic is weakly monotone, so it merges scores into flat steps.

    Ranking is never inverted, which is the property that matters, but merged
    scores become ties and ties count as half, so AUC shifts a little rather
    than being bit-identical. Platt scaling is strictly monotone and does leave
    AUC exactly unchanged.
    """
    rng = np.random.default_rng(5)
    scores = rng.random(500)
    y = (rng.random(500) < scores * 0.4).astype(float)

    iso = K.fit_calibrator(scores, y, method="isotonic").predict(scores)
    order = np.argsort(scores)
    assert np.all(np.diff(iso[order]) >= -1e-12), "isotonic must never invert order"
    assert M.roc_auc(y, iso) == pytest.approx(M.roc_auc(y, scores), abs=0.05)

    platt = K.fit_calibrator(scores, y, method="platt").predict(scores)
    assert M.roc_auc(y, platt) == pytest.approx(M.roc_auc(y, scores), abs=1e-9)


def test_calibration_moves_the_mean_forecast_onto_the_base_rate():
    """The failure this repairs: a class-weighted fit averaging 0.33 on a
    0.035 event."""
    rng = np.random.default_rng(7)
    n = 4000
    y = (rng.random(n) < 0.035).astype(float)
    inflated = np.clip(0.33 + 0.25 * (y - 0.035) + rng.normal(0, 0.1, n), 0.001, 0.999)
    cal = K.fit_calibrator(inflated, y)
    out = cal.predict(inflated)
    assert abs(out.mean() - y.mean()) < 0.01
    assert M.brier(y, out) < M.brier(y, inflated)


def test_conformal_coverage_matches_its_stated_level():
    rng = np.random.default_rng(11)
    truth = rng.normal(60, 20, 2000)
    pred = truth + rng.normal(0, 8, 2000)
    ci = K.ConformalInterval.fit(truth[:1000], pred[:1000], level=0.9)
    coverage = ci.empirical_coverage(truth[1000:], pred[1000:])
    assert 0.86 < coverage < 0.94
