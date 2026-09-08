"""Materialise the storm-centred cube.

Dimensions are (storm, time, channel, y, x) plus the availability mask, written
as a memory-mapped array with a JSON sidecar index. Zarr is used instead when it
is installed, which is what the full stack runs; the memmap path exists so the
cube can be built with nothing but numpy.

Why this exists rather than generating granules on the fly
---------------------------------------------------------
The granule generator is deterministic, so lazy generation is always correct.
It is also six to seventy times more work than it needs to be. Each granule
appears in roughly six different training sequences, and training runs over many
epochs, so a shuffled loader regenerates the same granule again and again while
the LRU cache thrashes: consecutive samples come from unrelated storms, so
nothing useful stays resident.

Building once and reading a memmap turns granule generation from the dominant
cost into a one-off. At 96 px in float16 the whole selected archive is under a
gigabyte, which is a file, not a problem.

float16 is deliberate. The channels are stored already normalised to [0, 1] by
their declared physical range, where float16 resolves about one part in two
thousand. On a 135 K infrared range that is 0.07 K, far finer than the
instrument's own calibration uncertainty, so nothing measurable is lost and the
file halves.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from trinetra import config as C
from trinetra.cube.store import CHANNELS, GranuleStore, N_CH
from trinetra.harmonise import environment as env
from trinetra.ingest.synth import TABULAR_FEATURES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("cube")


def parse_args(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--size", type=int, default=96)
    p.add_argument("--max-storms", type=int, default=110)
    p.add_argument("--tier", type=str, default="archive", choices=["archive", "live"])
    p.add_argument("--seed", type=int, default=0)
    return p.parse_args(argv)


def select_storms(labels: pd.DataFrame, max_storms: int, seed: int) -> pd.DataFrame:
    """Featured storms first, then the strongest, then a random tail.

    A uniform sample would be almost entirely depressions, which are most of the
    archive and least of the interest, and would leave the upper intensity bins
    with too few cases to carry a metric.
    """
    idx = labels.groupby("sid").agg(
        peak=("vmax_kt", "max"), featured=("featured_slug", "first"))
    keep = set(idx.index[idx["featured"].notna()])
    for sid in idx.sort_values("peak", ascending=False).index:
        if len(keep) >= max_storms:
            break
        keep.add(sid)
    rng = np.random.default_rng(seed)
    rest = [s for s in idx.index if s not in keep]
    rng.shuffle(rest)
    for sid in rest:
        if len(keep) >= max_storms:
            break
        keep.add(sid)
    return labels[labels["sid"].isin(keep)].reset_index(drop=True)


def main(argv=None) -> int:
    args = parse_args(argv)
    labels = pd.read_csv(C.LABELS_CSV, parse_dates=["valid_time"])
    labels = select_storms(labels, args.max_storms, args.seed)
    labels = labels.sort_values(["sid", "valid_time"]).reset_index(drop=True)
    n = len(labels)
    log.info("cube: %d storms, %d fixes, %d px, tier=%s",
             labels["sid"].nunique(), n, args.size, args.tier)

    px = args.size
    tag = f"{args.tier}_{px}"
    data_path = C.CUBE_DIR / f"granules_{tag}.f16.npy"
    mask_path = C.CUBE_DIR / f"mask_{tag}.npy"
    age_path = C.CUBE_DIR / f"age_{tag}.npy"
    env_path = C.CUBE_DIR / f"env_{tag}.npy"
    index_path = C.CUBE_DIR / f"index_{tag}.json"

    nbytes = n * N_CH * px * px * 2
    log.info("granule array: %d x %d x %d x %d float16 = %.2f GB",
             n, N_CH, px, px, nbytes / 1e9)

    data = np.lib.format.open_memmap(
        data_path, mode="w+", dtype=np.float16, shape=(n, N_CH, px, px))
    mask = np.zeros((n, N_CH), dtype=np.uint8)
    ages = np.full((n, N_CH), np.nan, dtype=np.float32)
    env_arr = np.full((n, len(TABULAR_FEATURES)), np.nan, dtype=np.float32)
    absent_reasons: dict[str, dict] = {}

    store = GranuleStore(labels, size_px=px, tier=args.tier, cache_size=8)
    rows = []
    t0 = time.time()
    written = 0

    for sid, g in labels.groupby("sid", sort=False):
        track = store.track(sid)
        for local_i in range(len(track)):
            row_idx = int(g.index[local_i])
            gr = store.granule(sid, local_i, tier=args.tier)

            # Store normalised, since that is what the model consumes and it is
            # what makes float16 safe.
            from trinetra.cube.store import _normalise

            data[row_idx] = _normalise(np.nan_to_num(gr.data, nan=0.0)).astype(np.float16)
            mask[row_idx] = gr.present.astype(np.uint8)
            ages[row_idx] = gr.age_minutes
            absent_reasons[str(row_idx)] = gr.extras.get("absent_reason", {})

            vals = env.build_row(track, local_i)
            env_arr[row_idx] = np.array([vals[f] for f in TABULAR_FEATURES],
                                        dtype=np.float32)

            rows.append({
                "row": row_idx, "sid": sid, "local_index": local_i,
                "valid_time": pd.Timestamp(track.iloc[local_i]["valid_time"]).isoformat(),
                "lat": float(track.iloc[local_i]["lat"]),
                "lon": float(track.iloc[local_i]["lon"]),
            })
            written += 1
            if written % 500 == 0:
                rate = written / (time.time() - t0)
                log.info("  %d/%d granules  %.0f/s  eta %.0fs",
                         written, n, rate, (n - written) / max(rate, 1e-6))

    data.flush()
    np.save(mask_path, mask)
    np.save(age_path, ages)
    np.save(env_path, env_arr)

    index = {
        "tier": args.tier,
        "size_px": px,
        "n_fixes": n,
        "n_storms": int(labels["sid"].nunique()),
        "channels": CHANNELS,
        "tabular_features": TABULAR_FEATURES,
        "dtype": "float16",
        "normalised": True,
        "normalisation": "per-channel min-max over the declared physical range "
                         "in cube.store.CHANNEL_RANGE",
        "synthetic_imagery": True,
        "built_seconds": round(time.time() - t0, 1),
        "files": {
            "granules": data_path.name, "mask": mask_path.name,
            "age": age_path.name, "env": env_path.name,
        },
        "rows": rows,
        "absent_reasons": absent_reasons,
    }
    index_path.write_text(json.dumps(index, indent=1), encoding="utf-8")

    labels.to_csv(C.LABELS_DIR / f"cube_labels_{tag}.csv", index=False)

    present_frac = mask.mean(axis=0)
    log.info("built in %.0fs", time.time() - t0)
    print(f"\nwrote {data_path}  ({data_path.stat().st_size / 1e9:.2f} GB)")
    print(f"wrote {index_path}")
    print("\nchannel availability across the cube")
    for ch, frac in zip(CHANNELS, present_frac):
        print(f"  {ch:<7} {100 * frac:5.1f}%")
    print("\nThe microwave and scatterometer figures are the point: those "
          "channels\nare absent most of the time, which is why the availability "
          "mask is a\nmodel input rather than a build-time constant.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
