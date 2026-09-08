# Runbook

Everything here has been run on a clean clone. Commands that need credentials
say so, and nothing in the demo path does.

## What a clean clone already has

- `data/labels/*.csv` and `*.json`: the derived best-track label tables, the
  cube label index for 110 storms at 96 px, the CV splits and the baseline
  scores. These are what let the API boot with no download.
- `data/raw/vector/ne_50m_land.geojson` and `districts_ind_adm2.geojson`: the
  coastline and the 735 India ADM2 districts. The API raises on the first
  `/api/storms/{id}/state` request without these, so they are committed rather
  than fetched.
- `data/models/train_report.json`: the evaluation numbers the methods page
  reads, so the reported metrics are checkable without retraining.

## What it does not have, and what to run

Two artefacts are generated, large, and gitignored.

```bash
cd backend
pip install -r requirements.txt
```

```bash
# The storm-centred data cube. About 2 minutes, writes roughly 0.94 GB into
# data/cube/. Reads the committed label tables and the synthetic granule
# generator; needs no network.
python scripts/build_cube.py --size 96 --max-storms 110
```

```bash
# The model checkpoint. About 50 minutes on 8 CPU threads for 16 epochs.
# Writes data/models/trinetra.pt, the OOD embeddings, and train_report.json.
python scripts/train.py --epochs 16 --size 96 --seq 6 --batch 24
```

```bash
uvicorn trinetra.api.main:app --port 8000
```

```bash
# second terminal
cd frontend
npm ci
npm run dev
```

Vite serves on 5173 and silently moves to 5174 if the port is held. Read the
port off its output.

### Running without the checkpoint

Skipping `train.py` is a legible degraded state, not a broken one. Every model
head reports itself as abstaining with a reason, and the observed layers, the
tracks, the hazard timeline, the district choropleth and the location probe all
still answer, because those come from the best-track and the rule set. Worth
knowing before a demo, and worth not demoing.

Skipping `build_cube.py` is different. Granules are then generated on demand and
cached per request, so the first load of each timestep is slow enough to be
visible on camera.

## Verifying the install

```bash
cd backend
python -m pytest tests -q
```

```bash
curl http://127.0.0.1:8000/api/health
```

`model_loaded` tells you whether `train.py` has run. `storms` should read 110.
If either is wrong, the two build steps above are the reason.

## Re-fetching the vector layers

Only needed if the committed copies are removed. Both are open, neither needs an
account.

```bash
mkdir -p data/raw/vector
```

```bash
# Natural Earth 1:50m land polygons, public domain.
curl -L -o data/raw/vector/ne_50m_land.geojson \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson
```

```bash
# geoBoundaries gbOpen India ADM2, 2021, ODbL 1.0. Pinned to the commit the
# committed copy came from, so the district ids stay stable.
curl -L -o data/raw/vector/districts_ind_adm2.geojson \
  https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/ADM2/geoBoundaries-IND-ADM2.geojson
```

The land mask rasterises from the first file on first use and caches to
`data/interim/land_mask_nio.npz`. The simplified district geometry caches to
`data/interim/districts_simplified_0.020.geojson`. Both are gitignored and both
rebuild in under a second, so deleting them is a safe way to force a refresh.

## Re-deriving the labels

Not needed for the demo. The label tables are committed; this regenerates them
from the source archive.

```bash
# IBTrACS v04r01 North Indian Ocean, 27 MB, no authentication.
mkdir -p data/raw/ibtracs
curl -L -o data/raw/ibtracs/ibtracs.NI.list.v04r01.csv \
  https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.NI.list.v04r01.csv
```

```bash
cd backend
python scripts/build_labels.py
python scripts/run_baselines.py   # about 3 minutes
```

## Environment variables

All optional. Defaults are what the demo runs on.

| Variable | Default | Effect |
|---|---|---|
| `TRINETRA_DATA` | `<repo>/data` | Moves the data root. |
| `TRINETRA_MODE` | `replay` | `live` switches the inference path to the reduced live channel set. There is no live feed wired up, so this currently only changes which channels the availability mask reports as present. |
| `TRINETRA_TILE_TTL` | `120` | Tile cache seconds. |
| `TRINETRA_REDIS_URL` | empty | Unused in this build. |
| `TRINETRA_DATABASE_URL` | empty | Unused in this build. |

## Real source acquisition

Not implemented. `backend/trinetra/ingest/` contains two modules: `ibtracs.py`,
which reads the real best-track archive, and `synth.py`, which generates the
gridded fields from a parametric storm model driven by that archive.

There are no MOSDAC, PO.DAAC, Copernicus Marine or CDS clients in this
repository. Wiring them up is the next piece of work, not a credentials
problem, and `data/DATASET_CARD.md` records which fields are synthetic. Do not
describe the imagery in this build as observed.
