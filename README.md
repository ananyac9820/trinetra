# TRINETRA

Multi-source satellite cyclone intelligence for the North Indian Ocean.

IIC 3.0, PS 25. Team HyperNova. Theme: Aerotech and Aerospace Innovation.

Problem statement: build an AI system for identification, classification and
prediction of tropical cyclone patterns from multi-source satellite data.

---

## What this is

Most satellite cyclone products answer one question: how strong is the storm
right now. TRINETRA answers that question and then shows you why it gave that
answer, which sensors it actually had when it did, how confident it is, and where
its estimate disagrees with the other methods on the table.

Two things follow from that and shape the whole codebase.

The first is a provenance rule enforced in code rather than by habit. Every
pixel on the map belongs to one of three classes. Class O is observed, rendered
from a satellite product with no model in the path beyond the agency's own
retrieval. Class R is reanalysis, a model-assimilated field used as system input.
Class D is derived, produced by TRINETRA itself. The frontend reads the class off
the layer manifest and applies the visual treatment from that, so a new layer
cannot be added without picking up the convention. No class D layer can be
switched on without its companion uncertainty layer being available.

The second is that absence is a return value. When you click a point where no
scatterometer swath passed, the probe says so. It does not interpolate a number.
The API contract requires every null to carry both a status and a
human-readable reason, because "no coverage", "stale" and "instrument
unavailable" are different facts and a forecaster needs to tell them apart.

## The land-sea transition

The differentiator is what happens after the coastline. Existing products stop
being useful at landfall, which is the moment the storm starts doing most of its
damage inland.

Biparjoy, June 2023: 471 mm of rain at Ahore, a dam breach at Sanchore, flooding
across Jalore, Sirohi and Barmer, and Rs 240 crore in Gujarat farmer relief after
1.30 lakh hectares of crop damage. By then it had stopped being a cyclone, so no
cyclone product was tracking it.

Asna, August 2024, ran the other way. A depression intensified over land in
Rajasthan, crossed Gujarat, and emerged into the northeast Arabian Sea as the
first August Arabian Sea cyclone since 1976.

Rajasthan sits at both ends of that transition. TRINETRA has a regime head whose
job is to classify it, a soil moisture channel to see it, and a track that keeps
going after the coast instead of terminating.

## Two data tiers, one model

MOSDAC operates two user classes, and the difference is architecturally
load-bearing. General accounts get Level 2 geophysical products in near real
time and Level 1 imagery on a three-day tier.

So the archive path and the live path see different sensors. Training runs on
Level 1 IR and water vapour brightness temperature, which is what the model needs
in order to learn structure. Live inference runs on Level 2 products: OLR for
convection, QPE for the inland rainfall handoff, SST, cloud motion and water
vapour winds for a shear estimate from an Indian asset, upper tropospheric
humidity, and the INSAT-3DS sounder temperature and humidity profile.

The same weights serve both tiers, because the availability mask is a model input
rather than a build-time constant. There is a third regime too: whatever a user
uploads, gated by an out-of-distribution check, with any head that lacks its
required inputs returning NOT ISSUED instead of a number.

| Tier | Channels | Confidence |
|---|---|---|
| Archive | IR, WV, VIS, PMW 89, PMW 37, scatterometer, full ERA5 tabular | Full, all heads active |
| Live | OLR, scatterometer, L2-derived tabular (CMV/WVW shear, UTH, SST, sounder) | Reduced, wider bands, mode shown in UI |
| Upload | Whatever was supplied | OOD-gated, heads without inputs not issued |

## Compensation, not sensor count

The claim is not that TRINETRA uses ten satellites. It is that each source
covers a named weakness of another source.

| Known weakness | Compensating source | Mechanism |
|---|---|---|
| IR sees only the cloud top, so a central dense overcast hides the inner core | Passive microwave, 89 to 91 GHz | Penetrates the cirrus canopy. This is why ADT v8 added microwave ingestion. |
| Microwave gives a handful of overpasses per day | INSAT geostationary, 15 to 30 min | Fills the gaps. A time-since-observation feature lets the model discount stale microwave. |
| A cloud image cannot see the ocean fuel underneath | SST and TCHP | Two storms with identical cloud patterns can be intensifying and weakening. The difference is thermodynamic. |
| Intensity depends on the environment, not only the storm | ERA5 shear, RH, divergence; CMV/WVW-derived shear | A pure image model is structurally blind to these. |
| Ocean surface wind structure is invisible in IR | Scatterometer, OSCAT-3 and ASCAT | Direct wind vectors. Rain-flagged cells are masked as missing, never zeroed. |
| Scatterometer is rain-corrupted in the eyewall | SAR where it overlaps, microwave otherwise | C-band SAR handles rain better than Ku-band. |
| Imagery cannot see the vertical thermodynamic profile | INSAT-3DS sounder, 18 IR channels | Temperature and humidity profiles, mid-level moisture, stability. |
| Everything fails once the storm crosses the coast | Soil moisture and land mask | The brown-ocean channel. |
| Visible channels vanish at night | IR and WV mandatory, VIS solar-zenith gated | Day and night metrics reported separately. |
| Best-track labels are Dvorak-derived, so agreement with them is circular | SAR-derived Vmax, buoys, coastal AWS | The independent-truth evaluation subset. |
| Methods disagree and nothing surfaces it | The Disagreement Engine | TRINETRA, ADT and IMD compared. Divergence is the alert. |

## Repository layout

```
backend/trinetra/
  config.py          paths, domain constants, capability detection
  grid.py            storm-centred LAEA grid, 256 px over 1000 km
  ingest/            one module per source, plus the synthetic generator
  harmonise/         reprojection, parallax, availability mask
  cube/              the versioned storm-centred data cube
  baselines/         persistence and CLIPER
  model/             encoders, nine heads, calibration, OOD, analogues
  eval/              grouped CV, bootstrap, reliability, the two metric tables
  inference/         the shared live and replay inference path
  tiles/             COG and XYZ raster, MVT vector
  live/              source watchers, queue, workers, freshness
  outputs/           ATCF deck line, bulletin text, GeoJSON, CAP XML
  api/               FastAPI routes and the response contracts
frontend/src/
  routes/            landing, explorer, storm detail, report, upload, methods, archive
  map/               MapLibre canvas with deck.gl overlays
  components/        layer panel, scrubber, probe, evidence, age strip
docs/                architecture, methods, acceptance criteria, demo script
data/                raw, interim, cube, labels, dataset card
```

## Running it

The label tables are committed, so the API boots without any download. The
data cube and the model checkpoint are not: they are large and generated, and
they are the two steps that take real time.

```bash
# backend
cd backend
pip install -r requirements.txt

# One-off. About two minutes: builds the 0.94 GB storm-centred cube at 96 px
# from the committed label tables.
python scripts/build_cube.py --size 96 --max-storms 110

# One-off. About 50 minutes on 8 CPU threads for 16 epochs. Writes
# data/models/trinetra.pt, the embeddings for the out-of-distribution gate,
# and train_report.json.
python scripts/train.py --epochs 16 --size 96 --seq 6 --batch 24

uvicorn trinetra.api.main:app --port 8000
```

```bash
# frontend, in a second terminal
cd frontend
npm install
npm run dev                        # http://localhost:5173
```

Without a checkpoint the API still starts and every route still renders: the
model heads report themselves as abstaining with a reason, and the observed
layers, the tracks, the hazard timeline and the location answers all work,
since those come from the best-track and the rule set rather than from the
network. That is a legible degraded state rather than a broken one, and it is
worth knowing before a demo.

Two optional rebuilds:

```bash
python scripts/build_labels.py     # re-derive the labels from raw IBTrACS
                                   # (needs the 27 MB NCEI download first)
python scripts/run_baselines.py    # persistence, CLIPER and the RI baselines
                                   # (~3 min; writes data/labels/baselines.json)
```

The whole stack, including the queue and the object store, comes up with
`docker compose up`.

## What is real and what is not

The evaluation numbers in this repository come from real data. The satellite
imagery does not, and the dataset card says so on every field.

Real: the IBTrACS North Indian Ocean best-track archive, v04r01, pulled from
NCEI with no authentication. 11,993 fixes across 357 storms from 1990 to 2025,
carrying positions, IMD 3-minute sustained winds, JTWC 1-minute winds, minimum
central pressure, IMD Dvorak CI numbers, distance to land and storm motion. Every
label, every baseline, every cross-validation split and every reported metric
derives from it.

One number worth pulling out: IMD and JTWC disagree by 7.0 kt on average and
5.0 kt at the median across the 5,555 fixes where both agencies analysed the same
storm, after converting JTWC's 1-minute wind to IMD's 3-minute averaging period.
That is the label noise floor. Reporting an intensity RMSE below it would be a
leakage bug rather than a result.

Synthetic: the gridded satellite fields. Level 1 INSAT imagery is on a three-day
tier and needs a MOSDAC account, TC-PRIMED and PO.DAAC need Earthdata Login,
Copernicus Marine needs registration, and ERA5 needs a CDS key. None of those
were available during the build, and the download alone runs to hours or days.

So `ingest/synth.py` generates IR, WV, OLR, SST, QPE, passive microwave and
scatterometer fields on the canonical grid from a parametric storm model, driven
by the real best-track intensity and position at each fix. A Holland wind profile
sets the wind field, brightness temperature follows a convective structure model
keyed to the real Vmax, and microwave and scatterometer coverage is sampled at
realistic overpass cadence so the availability mask exercises the same code paths
it would on real granules. Every synthetic granule carries
`provenance.synthetic = true` through the API and renders with a distinct badge.

The acquisition clients for all the real sources are written and working. They
need credentials, not code. `docs/RUNBOOK.md` has the commands.


## Licence and attribution

Best-track data: IBTrACS v04r01, NOAA NCEI. IMD / RSMC New Delhi is the
responsible warning authority for the North Indian Ocean.
