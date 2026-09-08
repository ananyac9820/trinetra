"""Cross-validation splits. Grouped by storm, from the first experiment.

The single most likely way this project produces an implausible number is
temporal leakage, and the mechanism is simple enough to describe in a sentence:
best-track fixes are three hours apart, so consecutive fixes of the same storm
are near-duplicates. Split them at random and the test set contains fixes taken
90 minutes either side of training fixes of the same storm at nearly the same
intensity. The model scores well and has learned nothing.

Two protocols, both grouped:

Leave-one-season-out is the headline. A season is the natural unit of
operational deployment, and holding one out asks the question a forecaster
cares about, which is whether the model works on a year it has never seen.

Grouped k-fold by storm is for the cheaper sweeps. Storms are assigned to folds
whole, so a storm is never split across the boundary.

Any reported number below the label uncertainty of roughly 5 kt should be treated
as a leakage bug to find rather than a result to present.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import config as C


@dataclass
class Split:
    name: str
    train_idx: np.ndarray
    test_idx: np.ndarray
    meta: dict = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.test_idx)


def leave_one_season_out(labels: pd.DataFrame, min_test_fixes: int = 60,
                         min_test_storms: int = 2) -> list[Split]:
    """One fold per season, holding that season's storms out entirely.

    Seasons too small to support a metric are skipped rather than reported with
    a wide interval, and the skipped list is recorded in the split file so the
    omission is visible instead of silent.
    """
    seasons = sorted(labels["season"].dropna().unique())
    splits: list[Split] = []
    skipped = []
    for s in seasons:
        test = labels["season"].eq(s).to_numpy()
        n_storms = labels.loc[test, "sid"].nunique()
        if test.sum() < min_test_fixes or n_storms < min_test_storms:
            skipped.append({"season": int(s), "fixes": int(test.sum()),
                            "storms": int(n_storms)})
            continue
        splits.append(Split(
            name=f"season_{int(s)}",
            train_idx=np.nonzero(~test)[0],
            test_idx=np.nonzero(test)[0],
            meta={"season": int(s), "test_storms": int(n_storms)},
        ))
    if skipped:
        splits and splits[0].meta.setdefault("skipped_seasons", skipped)
    return splits


def grouped_kfold(labels: pd.DataFrame, n_folds: int = 5, seed: int = 0) -> list[Split]:
    """K folds with the storm as the group key.

    Storms are shuffled then dealt into folds by descending size, which keeps
    the folds closer to equal in fixes than a plain round robin does. Amphan has
    51 fixes and Biparjoy 113, so dealing by count matters at this sample size.
    """
    sids = labels["sid"].to_numpy()
    counts = pd.Series(sids).value_counts()
    rng = np.random.default_rng(seed)
    order = counts.index.to_numpy()
    rng.shuffle(order)
    order = sorted(order, key=lambda s: -counts[s])

    buckets: list[list[str]] = [[] for _ in range(n_folds)]
    loads = np.zeros(n_folds, dtype=int)
    for sid in order:
        k = int(np.argmin(loads))
        buckets[k].append(sid)
        loads[k] += counts[sid]

    splits = []
    for k, bucket in enumerate(buckets):
        test = np.isin(sids, bucket)
        splits.append(Split(
            name=f"fold_{k}",
            train_idx=np.nonzero(~test)[0],
            test_idx=np.nonzero(test)[0],
            meta={"test_storms": len(bucket), "test_fixes": int(test.sum())},
        ))
    return splits


def holdout_recent_seasons(labels: pd.DataFrame, n_seasons: int = 4) -> Split:
    """A single chronological holdout of the most recent seasons.

    Used for the final reported model, because it is the only split that
    respects the arrow of time end to end. Cross-validation folds trained on
    later seasons and tested on earlier ones give a slightly optimistic picture
    of operational performance.
    """
    seasons = sorted(labels["season"].dropna().unique())
    test_seasons = seasons[-n_seasons:]
    test = labels["season"].isin(test_seasons).to_numpy()
    return Split(
        name=f"holdout_{int(test_seasons[0])}_{int(test_seasons[-1])}",
        train_idx=np.nonzero(~test)[0],
        test_idx=np.nonzero(test)[0],
        meta={"test_seasons": [int(s) for s in test_seasons]},
    )


def verify_no_storm_leakage(labels: pd.DataFrame, splits: list[Split]) -> None:
    """Assert that no storm appears in both sides of any split.

    This is a test that runs in production rather than only in the suite,
    because the cost of getting it wrong is a headline number that has to be
    withdrawn.
    """
    sids = labels["sid"].to_numpy()
    for sp in splits:
        overlap = set(sids[sp.train_idx]) & set(sids[sp.test_idx])
        if overlap:
            raise AssertionError(
                f"split {sp.name} leaks {len(overlap)} storm(s): {sorted(overlap)[:5]}"
            )


def describe(labels: pd.DataFrame, splits: list[Split]) -> dict:
    """The split configuration, published on the methods page.

    Reported numbers can be reproduced from this rather than taken on trust.
    """
    return {
        "n_fixes": int(len(labels)),
        "n_storms": int(labels["sid"].nunique()),
        "seasons": [int(s) for s in sorted(labels["season"].dropna().unique())],
        "group_key": "sid",
        "folds": [
            {
                "name": sp.name,
                "train_fixes": int(len(sp.train_idx)),
                "test_fixes": int(len(sp.test_idx)),
                "train_storms": int(labels.iloc[sp.train_idx]["sid"].nunique()),
                "test_storms": int(labels.iloc[sp.test_idx]["sid"].nunique()),
                **sp.meta,
            }
            for sp in splits
        ],
    }


def save(labels: pd.DataFrame, splits: list[Split], path=None) -> None:
    path = path or (C.LABELS_DIR / "splits.json")
    path.write_text(json.dumps(describe(labels, splits), indent=2), encoding="utf-8")
