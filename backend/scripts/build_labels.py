"""Stage 0: turn the raw IBTrACS archive into the canonical label tables."""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from trinetra import config as C
from trinetra.ingest import ibtracs

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


def main() -> int:
    raw = ibtracs.load_raw(C.IBTRACS_CSV)
    labels = ibtracs.build_labels(raw)
    index = ibtracs.storm_index(labels)

    labels.to_csv(C.LABELS_CSV, index=False)
    index.to_csv(C.STORM_INDEX_CSV, index=False)
    try:
        labels.to_parquet(C.LABELS_PARQUET, index=False)
    except Exception as exc:  # pyarrow is optional
        logging.warning("parquet skipped (%s); CSV written", exc)

    print(f"\nfixes            {len(labels):,}")
    print(f"storms           {labels['sid'].nunique():,}")
    print(f"seasons          {labels['season'].min()}-{labels['season'].max()}")
    print(f"RI positives     {int(labels['ri_24h'].sum()):,} / {int(labels['ri_24h'].notna().sum()):,}"
          f"  ({100*labels['ri_24h'].mean():.2f}%)")
    print(f"land-reintensify {int(labels['reintensify_land'].sum()):,}")
    print("\nIMD category counts")
    print(labels["imd_category"].value_counts().reindex(ibtracs.IMD_CATEGORIES).to_string())
    print("\nregime counts")
    print(labels["regime"].value_counts().to_string())
    print(f"\nIMD-vs-JTWC label spread: mean {labels['label_spread_kt'].mean():.2f} kt, "
          f"median {labels['label_spread_kt'].median():.2f} kt, "
          f"n={int(labels['label_spread_kt'].notna().sum()):,}")
    print("\nfeatured storms")
    print(index[index.featured_slug.notna()][
        ["sid", "name", "season", "basin", "peak_vmax_kt", "peak_category", "made_landfall", "n_fixes"]
    ].to_string(index=False))
    print(f"\nwrote {C.LABELS_CSV}")
    print(f"wrote {C.STORM_INDEX_CSV}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
