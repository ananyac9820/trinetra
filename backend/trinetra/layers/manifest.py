"""The layer manifest. This file is the provenance convention.

Every visual rule in the Explorer is derived from the `class` field here, and
the frontend is forbidden from hard-coding which layers are derived. That is not
a style preference, it is the mechanism that stops the rule being forgotten the
next time somebody adds a layer: a new entry picks up hatching, badging and the
uncertainty requirement automatically, or it fails validation and does not ship.

Three classes:

    O   Observed. Rendered from a satellite product, with no model in the path
        beyond the agency's own retrieval. Solid legend chip, continuous ramp.

    R   Reanalysis. Model-assimilated fields used as system input. Not an
        observation and not a TRINETRA output. Solid chip with a dotted border,
        muted palette, and the words "reanalysis, not observation" in the
        legend.

    D   Derived. Produced by TRINETRA. Hatched chip, a badge on the layer, and
        a watermark on the map whenever any D layer is on.

The rule that keeps it honest: no class D layer may be enabled without its
companion uncertainty layer being available. `validate()` enforces it at import
time, so a derived layer without an uncertainty companion cannot be added
without the process failing loudly.

Several layers here are named to avoid a specific fabrication. There is no
layer called "RI probability" anywhere in this product, because a storm's
24-hour RI probability is a property of the storm and painting it across space
would be inventing a per-location forecast that does not exist. What exists is
"RI environmental favourability", which runs the tabular branch on a grid and
answers a different and answerable question: where would a storm intensify if it
went there.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from ..cube.store import CHANNEL_UNITS
from ..tiles.palettes import legend as palette_legend


@dataclass
class Layer:
    id: str
    label: str
    cls: str  # O | R | D
    source: str
    render: str  # raster | vector | barbs
    palette: str | None = None
    instrument: str | None = None
    native_resolution_km: float | None = None
    cadence_minutes: float | None = None
    units: str | None = None
    available_live: bool = True
    staleness_amber_minutes: float | None = None
    staleness_expire_minutes: float | None = None
    uncertainty_layer: str | None = None
    produced_by: list[str] = field(default_factory=list)
    disclaimer: str | None = None
    synthetic: bool = False
    group: str = "observed"
    default_on: bool = False
    default_opacity: float = 1.0
    daylight_only: bool = False
    notes: str | None = None

    def to_json(self) -> dict:
        d = asdict(self)
        d["class"] = d.pop("cls")
        if self.palette:
            d["legend"] = palette_legend(self.palette)
        return d


# ------------------------------------------------------------ observed

OBSERVED = [
    Layer(
        id="insat_ir", label="IR brightness temperature 10.8 um", cls="O",
        source="INSAT-3D/3DR/3DS imager L1", instrument="Imager",
        render="raster", palette="ir_enhanced", units=CHANNEL_UNITS["ir"],
        native_resolution_km=4, cadence_minutes=30,
        # Level 1 is on the three-day tier for a general MOSDAC account. This
        # single flag is what the whole two-tier architecture argument rests on.
        available_live=False,
        staleness_amber_minutes=60, staleness_expire_minutes=4320,
        group="observed", default_on=True, synthetic=True,
        notes="Archive tier. MOSDAC Level 1 carries a three-day latency for "
              "general accounts.",
    ),
    Layer(
        id="insat_wv", label="Water vapour 6.7 um", cls="O",
        source="INSAT imager L1", instrument="Imager",
        render="raster", palette="water_vapour", units=CHANNEL_UNITS["wv"],
        native_resolution_km=8, cadence_minutes=30, available_live=False,
        staleness_amber_minutes=60, staleness_expire_minutes=4320,
        group="observed", synthetic=True,
    ),
    Layer(
        id="insat_vis", label="Visible / SWIR", cls="O",
        source="INSAT imager L1", instrument="Imager",
        render="raster", palette="ir_enhanced", units="reflectance",
        native_resolution_km=1, cadence_minutes=30, available_live=False,
        staleness_amber_minutes=60, staleness_expire_minutes=240,
        group="observed", daylight_only=True, synthetic=True,
        notes="Gated by solar zenith angle. Absent at night is absent data, "
              "not dark data, and the availability mask records it that way.",
    ),
    Layer(
        id="insat_olr", label="Outgoing longwave radiation", cls="O",
        source="INSAT-3D L2", instrument="Imager",
        render="raster", palette="convection", units="W m-2",
        native_resolution_km=4, cadence_minutes=30, available_live=True,
        staleness_amber_minutes=120, staleness_expire_minutes=360,
        group="observed", default_on=True, synthetic=True,
        notes="The live convection channel. Level 2 products are near real "
              "time on a general account.",
    ),
    Layer(
        id="insat_qpe", label="Precipitation rate (QPE)", cls="O",
        source="INSAT-3D L2", render="raster", palette="rainfall",
        units="mm h-1", native_resolution_km=4, cadence_minutes=30,
        available_live=True, staleness_amber_minutes=120,
        staleness_expire_minutes=360, group="observed", synthetic=True,
        notes="The inland rainfall handoff channel, and what the district risk "
              "band is built from after landfall.",
    ),
    Layer(
        id="insat_sst", label="Sea surface temperature", cls="O",
        source="INSAT-3D L2 or OISST", render="raster", palette="thermal",
        units="degC", native_resolution_km=10, cadence_minutes=360,
        available_live=True, staleness_amber_minutes=360,
        staleness_expire_minutes=1440, group="observed", synthetic=True,
        notes="The 26 degree contour is drawn because it is the cyclogenesis "
              "threshold, not for decoration.",
    ),
    Layer(
        id="insat_uth", label="Upper tropospheric humidity", cls="O",
        source="INSAT-3D L2", render="raster", palette="moisture",
        units="%", native_resolution_km=10, cadence_minutes=180,
        available_live=True, staleness_amber_minutes=240,
        staleness_expire_minutes=720, group="observed", synthetic=True,
    ),
    Layer(
        id="insat_aod", label="Aerosol optical depth 550 nm", cls="O",
        source="INSAT-3D L2", render="raster", palette="dust",
        units="unitless", native_resolution_km=10, cadence_minutes=30,
        available_live=True, staleness_amber_minutes=180,
        staleness_expire_minutes=720, group="observed", daylight_only=True,
        synthetic=True, notes="Powers the dust module. Daylight only.",
    ),
    Layer(
        id="pmw_89", label="Passive microwave 89-91 GHz", cls="O",
        source="GMI, AMSR2, SSMIS via TC-PRIMED", render="raster",
        palette="microwave", units="K", native_resolution_km=10,
        available_live=True, staleness_amber_minutes=360,
        staleness_expire_minutes=720, group="observed", synthetic=True,
        notes="Sees the inner core through the cirrus canopy that blinds "
              "infrared. Swath-limited, a handful of overpasses per day.",
    ),
    Layer(
        id="pmw_37", label="Passive microwave 37 GHz", cls="O",
        source="GMI, AMSR2, SSMIS via TC-PRIMED", render="raster",
        palette="microwave", units="K", native_resolution_km=15,
        available_live=True, staleness_amber_minutes=360,
        staleness_expire_minutes=720, group="observed", synthetic=True,
    ),
    Layer(
        id="scat_wind", label="Scatterometer surface wind", cls="O",
        source="OSCAT-3 and ASCAT via Copernicus Marine / PO.DAAC",
        render="raster", palette="wind", units="kt", native_resolution_km=25,
        available_live=True, staleness_amber_minutes=720,
        staleness_expire_minutes=1440, group="observed", synthetic=True,
        notes="Rain-flagged cells render as missing, never as zero wind. A "
              "zero is a number a model will believe.",
    ),
    Layer(
        id="soil_moisture", label="Soil moisture", cls="O",
        source="MOSDAC L2 / SMAP / ERA5", render="raster", palette="soil",
        units="m3 m-3", native_resolution_km=25, available_live=True,
        staleness_amber_minutes=1440, staleness_expire_minutes=4320,
        group="observed", synthetic=True,
        notes="The brown-ocean channel, and the differentiator. Active in the "
              "post-landfall regime.",
    ),
    Layer(
        id="districts", label="District boundaries", cls="O",
        source="geoBoundaries gbOpen India ADM2", render="vector",
        units=None, available_live=True, group="boundaries", default_on=True,
        synthetic=False,
        notes="Real vector data. 735 polygons. The district is the decision "
              "unit for a state disaster management authority.",
    ),
    Layer(
        id="coastline", label="Coastline and land", cls="O",
        source="Natural Earth 1:50m", render="vector", available_live=True,
        group="boundaries", default_on=True, synthetic=False,
    ),
]

# ------------------------------------------------------------ reanalysis

REANALYSIS = [
    Layer(
        id="era5_shear", label="Vertical wind shear 200-850 hPa", cls="R",
        source="ERA5 reanalysis", render="raster", palette="wind", units="kt",
        native_resolution_km=31, cadence_minutes=360, available_live=False,
        staleness_amber_minutes=720, staleness_expire_minutes=2880,
        group="reanalysis", synthetic=True,
        disclaimer="Reanalysis, not observation. Model-assimilated field.",
    ),
    Layer(
        id="cmv_shear", label="Shear from INSAT CMV/WVW level difference",
        cls="O", source="INSAT-3D L2 cloud motion and water vapour winds",
        render="raster", palette="wind", units="kt", native_resolution_km=25,
        cadence_minutes=60, available_live=True,
        staleness_amber_minutes=180, staleness_expire_minutes=720,
        group="observed", synthetic=True,
        notes="The observed counterpart to era5_shear. Same quantity, "
              "different provenance class, so the two must never be styled "
              "alike. This one is derived from an Indian asset in near real "
              "time; the ERA5 version is a reanalysis.",
    ),
    Layer(
        id="era5_rh_mid", label="Mid-level relative humidity", cls="R",
        source="ERA5 reanalysis", render="raster", palette="moisture",
        units="%", native_resolution_km=31, cadence_minutes=360,
        available_live=False, staleness_amber_minutes=720,
        staleness_expire_minutes=2880, group="reanalysis", synthetic=True,
        disclaimer="Reanalysis, not observation.",
    ),
    Layer(
        id="era5_divergence", label="Divergence at 200 hPa", cls="R",
        source="ERA5 reanalysis, or Copernicus scatterometer wind divergence",
        render="raster", palette="favourability", units="s-1",
        native_resolution_km=31, cadence_minutes=360, available_live=False,
        staleness_amber_minutes=720, staleness_expire_minutes=2880,
        group="reanalysis", synthetic=True,
        disclaimer="Reanalysis, not observation. The Copernicus scatterometer "
                   "variant of this field is observed and belongs to class O.",
    ),
    Layer(
        id="tchp", label="Tropical cyclone heat potential", cls="R",
        source="Derived from SST and ocean analysis", render="raster",
        palette="thermal", units="kJ cm-2", native_resolution_km=25,
        available_live=False, staleness_amber_minutes=1440,
        staleness_expire_minutes=4320, group="reanalysis", synthetic=True,
        disclaimer="Reanalysis-derived. The ocean product used is named in the "
                   "layer notes.",
    ),
]

# ------------------------------------------------------------ derived

DERIVED = [
    Layer(
        id="tri_track_intensity", label="Track coloured by intensity", cls="D",
        source="TRINETRA centre-fix and intensity heads", render="vector",
        palette="wind", units="kt", produced_by=["centre_fix", "vmax"],
        available_live=True, group="derived", default_on=True,
        uncertainty_layer="tri_track_cone",
        disclaimer="Intensity is a single scalar per storm, the maximum "
                   "sustained wind. It has no value at an arbitrary grid "
                   "point, so it is drawn along the track and never painted "
                   "across space.",
    ),
    Layer(
        id="tri_track_cone", label="Track cone, calibrated coverage", cls="D",
        source="TRINETRA conformal prediction", render="vector",
        produced_by=["centre_fix"], available_live=True, group="derived",
        uncertainty_layer="tri_track_cone",  # it is its own uncertainty
        disclaimer="Short range only. Stated coverage is verified empirically "
                   "on held-out seasons by split conformal prediction, not "
                   "assumed from a standard deviation. Not a medium-range "
                   "track forecast.",
    ),
    Layer(
        id="tri_centre_uncertainty", label="Centre-fix uncertainty ellipse",
        cls="D", source="TRINETRA keypoint head sigma", render="vector",
        produced_by=["centre_fix"], available_live=True, group="derived",
        uncertainty_layer="tri_centre_uncertainty",
        disclaimer="Ellipse from the spatial softmax spread, propagated to "
                   "every downstream head.",
    ),
    Layer(
        id="tri_ri_favourability", label="RI environmental favourability",
        cls="D", source="TRINETRA tabular branch evaluated on a grid",
        render="raster", palette="favourability", units="0-1",
        produced_by=["ri_head"], available_live=True, group="derived",
        uncertainty_layer="tri_ri_favourability_spread", synthetic=True,
        disclaimer="Favourability of the environment, not a storm RI "
                   "probability. Answers where a storm would intensify if it "
                   "went there. Not valid as a per-location forecast.",
    ),
    Layer(
        id="tri_ri_favourability_spread", label="RI favourability spread",
        cls="D", source="TRINETRA tabular branch, ensemble spread",
        render="raster", palette="uncertainty", units="0-1",
        produced_by=["ri_head"], available_live=True, group="derived",
        uncertainty_layer="tri_ri_favourability_spread", synthetic=True,
        disclaimer="Companion uncertainty for tri_ri_favourability.",
    ),
    Layer(
        id="tri_district_risk", label="District rainfall risk band", cls="D",
        source="TRINETRA: observed QPE accumulation plus predicted track corridor",
        render="vector", produced_by=["regime", "centre_fix"],
        available_live=True, group="derived",
        uncertainty_layer="tri_district_risk_confidence",
        disclaimer="Categorical risk band derived from observed rainfall and a "
                   "predicted track corridor. Not a rainfall forecast. The "
                   "district is the unit because the district is the decision "
                   "unit.",
    ),
    Layer(
        id="tri_district_risk_confidence", label="District risk confidence",
        cls="D", source="TRINETRA regime and track confidence", render="vector",
        produced_by=["regime"], available_live=True, group="derived",
        uncertainty_layer="tri_district_risk_confidence",
        disclaimer="Companion confidence for tri_district_risk.",
    ),
    Layer(
        id="tri_sensor_coverage", label="Sensor coverage at this time", cls="D",
        source="TRINETRA availability mask", render="raster",
        palette="uncertainty", units="channels", produced_by=["availability"],
        available_live=True, group="derived",
        uncertainty_layer="tri_sensor_coverage",
        disclaimer="The honest spatial expression of where the system knows "
                   "less: which sensors actually covered each region at this "
                   "timestamp.",
    ),
    Layer(
        id="tri_regime_segments", label="Track regime segmentation", cls="D",
        source="TRINETRA regime head", render="vector", produced_by=["regime"],
        available_live=True, group="derived", default_on=True,
        uncertainty_layer="tri_regime_confidence",
        disclaimer="Track styled by regime: maritime mature, sheared, "
                   "post-landfall remnant, over land. The point where the "
                   "style changes at the coastline, and continues, is the "
                   "land-sea transition made visible.",
    ),
    Layer(
        id="tri_regime_confidence", label="Regime confidence", cls="D",
        source="TRINETRA regime head softmax", render="vector",
        produced_by=["regime"], available_live=True, group="derived",
        uncertainty_layer="tri_regime_confidence",
        disclaimer="Companion confidence for tri_regime_segments. Lowest at "
                   "the moment of land-sea transition, which is exactly when "
                   "it matters most, and where the system abstains.",
    ),
    Layer(
        id="tri_parametric_wind", label="Parametric wind field reconstruction",
        cls="D", source="TRINETRA intensity head through a Holland profile",
        render="raster", palette="wind", units="kt",
        produced_by=["vmax", "centre_fix"], available_live=True,
        group="derived", uncertainty_layer="tri_parametric_wind_spread",
        synthetic=True,
        disclaimer="A parametric reconstruction from the Holland profile, not "
                   "an observed wind field and not a spatial intensity "
                   "estimate. Labelled as a reconstruction wherever it "
                   "appears.",
    ),
    Layer(
        id="tri_parametric_wind_spread", label="Parametric wind spread",
        cls="D", source="TRINETRA intensity uncertainty through the profile",
        render="raster", palette="uncertainty", units="kt",
        produced_by=["vmax"], available_live=True, group="derived",
        uncertainty_layer="tri_parametric_wind_spread", synthetic=True,
        disclaimer="Companion uncertainty for tri_parametric_wind.",
    ),
    Layer(
        id="tri_swath_history", label="Sensor footprint history", cls="D",
        source="TRINETRA availability mask over time", render="vector",
        produced_by=["availability"], available_live=True, group="derived",
        uncertainty_layer="tri_swath_history",
        disclaimer="Which swaths covered this storm and when. Makes the "
                   "availability mask a visible object rather than an "
                   "abstraction.",
    ),
]

ALL_LAYERS: list[Layer] = OBSERVED + REANALYSIS + DERIVED
BY_ID: dict[str, Layer] = {layer.id: layer for layer in ALL_LAYERS}


def validate(layers: list[Layer] | None = None) -> None:
    """Enforce the manifest rules. Called at import, so a violation cannot ship.

    The uncertainty rule is the one that matters. A derived field rendered
    without a companion uncertainty representation is a machine for producing
    confident-looking pictures of things the model does not know, and the point
    of this whole convention is to make that structurally impossible rather
    than merely discouraged.
    """
    layers = layers or ALL_LAYERS
    ids = {layer.id for layer in layers}

    seen: set[str] = set()
    for layer in layers:
        if layer.id in seen:
            raise ValueError(f"duplicate layer id: {layer.id}")
        seen.add(layer.id)

        if layer.cls not in ("O", "R", "D"):
            raise ValueError(f"{layer.id}: class must be O, R or D, got {layer.cls!r}")

        if layer.cls == "D":
            if not layer.uncertainty_layer:
                raise ValueError(
                    f"{layer.id} is class D with no uncertainty_layer. A derived "
                    f"layer may not ship without a companion uncertainty "
                    f"representation."
                )
            if layer.uncertainty_layer not in ids:
                raise ValueError(
                    f"{layer.id} names uncertainty_layer {layer.uncertainty_layer!r}, "
                    f"which is not in the manifest."
                )
            if not layer.disclaimer:
                raise ValueError(f"{layer.id} is class D and needs a disclaimer")

        if layer.cls == "R" and not layer.disclaimer:
            raise ValueError(
                f"{layer.id} is class R and must be explicitly labelled as "
                f"reanalysis rather than observation."
            )

        # The naming rule from the specification, enforced rather than trusted.
        if "ri_probability" in layer.id or (
            "RI probability" in layer.label and layer.render == "raster"
        ):
            raise ValueError(
                f"{layer.id}: a spatial field may not be named an RI "
                f"probability. RI probability is a per-storm scalar; painting "
                f"it across space invents a per-location forecast. Use "
                f"tri_ri_favourability."
            )


validate()


def manifest_json(mode: str = "replay") -> dict:
    """The /api/layers payload."""
    return {
        "mode": mode,
        "classes": {
            "O": {
                "label": "Observed",
                "meaning": "Rendered directly from a satellite product. No "
                           "model in the path beyond the agency's own retrieval.",
                "chip": "solid", "ramp": "continuous", "hatched": False,
            },
            "R": {
                "label": "Reanalysis",
                "meaning": "Model-assimilated field used as system input. Not a "
                           "satellite observation and not a TRINETRA output.",
                "chip": "dotted-border", "ramp": "muted", "hatched": False,
            },
            "D": {
                "label": "Derived",
                "meaning": "Produced by TRINETRA. A model output.",
                "chip": "hatched", "ramp": "continuous", "hatched": True,
                "requires_uncertainty_companion": True,
                "watermark_when_active": True,
            },
        },
        "groups": ["observed", "reanalysis", "derived", "boundaries"],
        # Class order is fixed: vector on top, derived above observed,
        # boundaries always on top.
        "class_order": ["boundaries", "derived", "reanalysis", "observed"],
        "layers": [layer.to_json() for layer in ALL_LAYERS],
    }
