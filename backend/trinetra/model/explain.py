"""Evidence bars, saliency, and the sensor-ablation attribution.

The evidence panel is the thing that separates this from a product that hands
you an answer. So the bars have to be measured rather than asserted, or the
panel is decoration with a scientific accent.

How the bars are computed
-------------------------
By ablation. Each sensor group is switched off through the availability mask,
exactly the way a real outage would switch it off, and the model is re-run. The
change in the intensity estimate and in the model's own confidence is that
group's contribution.

This works precisely because the availability mask is a model input. The
architecture already has to handle a missing channel honestly, so removing one
is a legitimate forward pass rather than an out-of-distribution poke, and the
resulting number means what it appears to mean.

It also demonstrates the degradation claim as a side effect. Turn microwave off
and the error band widens and the confidence drops, which is the same behaviour
the demo shows by hand, measured.

Grad-CAM is included for the image branch when pytorch-grad-cam is installed,
and a plain gradient-times-activation saliency otherwise, so the attention
overlay works either way. The check that matters is whether it lands on Dvorak
structure rather than on the domain edges.
"""

from __future__ import annotations

import logging

import numpy as np

from ..cube.store import CH
from ..ingest.synth import IMAGE_CHANNELS

log = logging.getLogger(__name__)

# Sensor groups as a forecaster thinks about them, not as the tensor is laid
# out. A judge asks "how much is the microwave contributing", not "how much is
# channel 4 contributing".
SENSOR_GROUPS = {
    "ir_structure": {
        "label": "IR structure",
        "channels": ["ir", "vis"],
        "why": "Cloud-top structure and organisation. Blind to the inner core "
               "under a central dense overcast.",
    },
    "water_vapour": {
        "label": "Water vapour",
        "channels": ["wv"],
        "why": "Mid and upper-level moisture, and dry-air intrusion.",
    },
    "convection": {
        "label": "Convection (OLR)",
        "channels": ["olr"],
        "why": "The live convective intensity proxy. Present on the Level 2 "
               "tier when Level 1 imagery is not.",
    },
    "microwave_core": {
        "label": "Microwave core",
        "channels": ["pmw89", "pmw37"],
        "why": "Penetrates the cirrus canopy to the convective structure. "
               "Absent at most timesteps.",
    },
    "surface_wind": {
        "label": "Scatterometer surface wind",
        "channels": ["scat"],
        "why": "Direct ocean surface wind vectors. Rain-corrupted in the "
               "eyewall, so masked there rather than zeroed.",
    },
    "land_surface": {
        "label": "Land surface and soil moisture",
        "channels": ["soil", "land"],
        "why": "The brown-ocean channel. Carries the post-landfall regime.",
    },
}

# Tabular predictor groups, for the environment bar.
TABULAR_GROUPS = {
    "environment": ["shear_200_850", "rh_mid", "sst", "tchp",
                    "potential_intensity", "divergence_200"],
    "sounder": ["sounder_stability_index", "sounder_midlevel_moisture"],
    "kinematics": ["storm_motion_u", "storm_motion_v", "latitude",
                   "prior_12h_intensity_trend"],
    "geography": ["land_fraction", "distance_to_coast"],
}


def _clone(batch: dict) -> dict:
    return {k: (v.clone() if hasattr(v, "clone") else v) for k, v in batch.items()}


def ablation_evidence(model, batch: dict) -> dict:
    """Per-group contribution, by switching each group off through the mask.

    Returns a magnitude per group in knots of intensity change, the direction of
    that change, and the change in the model's own predicted uncertainty. The
    magnitudes are also normalised to 0-1 for the bar widths, because the panel
    needs a bar length and the raw knots need to stay visible next to it.
    """
    import torch

    from ..ingest.synth import TABULAR_FEATURES

    with torch.no_grad():
        base = model(_clone(batch))
    base_vmax = float(base["vmax"][0])
    base_sigma = float(base["vmax_sigma_kt"][0])
    base_ri = float(torch.sigmoid(base["ri_logit"])[0])

    rows = []
    for key, group in SENSOR_GROUPS.items():
        idx = [CH[c] for c in group["channels"] if c in CH]
        present = [c for c, i in zip(group["channels"], idx)
                   if float(batch["mask"][0, :, i].max()) > 0.5]
        if not present:
            rows.append({
                "id": key, "label": group["label"], "why": group["why"],
                "available": False, "delta_vmax_kt": None, "delta_sigma_kt": None,
                "delta_ri": None, "magnitude": 0.0,
                "note": "Not available at this timestamp, so it contributed "
                        "nothing and the bar is empty rather than absent.",
            })
            continue

        ab = _clone(batch)
        for i in idx:
            ab["mask"][0, :, i] = 0.0
            # Push the staleness out too, so the availability input and the age
            # input stay consistent. An inconsistent pair is a state the model
            # never saw in training.
            ab["offsets"][0, :, i] = 10_000.0
        with torch.no_grad():
            out = model(ab)

        rows.append({
            "id": key, "label": group["label"], "why": group["why"],
            "available": True,
            "channels_present": present,
            "delta_vmax_kt": round(base_vmax - float(out["vmax"][0]), 2),
            "delta_sigma_kt": round(float(out["vmax_sigma_kt"][0]) - base_sigma, 2),
            "delta_ri": round(base_ri - float(torch.sigmoid(out["ri_logit"])[0]), 4),
            "magnitude": abs(base_vmax - float(out["vmax"][0])),
        })

    # Tabular groups, ablated through the feature-validity flags.
    for key, features in TABULAR_GROUPS.items():
        idx = [TABULAR_FEATURES.index(f) for f in features if f in TABULAR_FEATURES]
        ab = _clone(batch)
        for i in idx:
            ab["tabular_valid"][0, i] = 0.0
            ab["tabular"][0, i] = 0.0
        with torch.no_grad():
            out = model(ab)
        rows.append({
            "id": key, "label": key.replace("_", " ").capitalize(),
            "why": f"Tabular predictors: {', '.join(features)}",
            "available": True,
            "delta_vmax_kt": round(base_vmax - float(out["vmax"][0]), 2),
            "delta_sigma_kt": round(float(out["vmax_sigma_kt"][0]) - base_sigma, 2),
            "delta_ri": round(base_ri - float(torch.sigmoid(out["ri_logit"])[0]), 4),
            "magnitude": abs(base_vmax - float(out["vmax"][0])),
        })

    peak = max((r["magnitude"] for r in rows), default=0.0)
    for r in rows:
        r["bar"] = round(r["magnitude"] / peak, 4) if peak > 1e-9 else 0.0
        r.pop("magnitude", None)

    rows.sort(key=lambda r: (r["available"], r["bar"]), reverse=True)
    return {
        "method": "sensor ablation through the availability mask",
        "explanation": (
            "Each group is switched off the way a real outage would switch it "
            "off, and the model is re-run. The bar is the resulting change in "
            "the intensity estimate. This is a measurement rather than an "
            "assertion, and it is only meaningful because the availability mask "
            "is a model input, so a missing channel is a state the model was "
            "trained to handle."
        ),
        "baseline": {
            "vmax_kt": round(base_vmax, 2),
            "sigma_kt": round(base_sigma, 2),
            "ri_p24": round(base_ri, 4),
        },
        "bars": rows,
    }


def saliency_map(model, batch: dict, head: str = "vmax") -> np.ndarray | None:
    """Spatial saliency for the image branch.

    Gradient of the chosen head with respect to the input frames, times the
    input. Used as the attention overlay on the infrared imagery, and the check
    worth running is whether it lands on Dvorak structure rather than on the
    domain edges, which is the usual sign of a model reading an artefact.
    """
    import torch

    frames = batch["frames"].clone().requires_grad_(True)
    b = {**_clone(batch), "frames": frames}
    out = model(b)
    target = out["vmax"][0] if head == "vmax" else out["ri_logit"][0]
    model.zero_grad(set_to_none=True)
    target.backward()
    if frames.grad is None:
        return None
    sal = (frames.grad * frames).abs().sum(dim=2)[0]  # sum over channels
    sal = sal[-1]  # last frame
    sal = sal.detach().numpy()
    peak = float(sal.max())
    return (sal / peak) if peak > 0 else sal


def gradcam(model, batch: dict) -> np.ndarray | None:
    """Grad-CAM over the image trunk, when pytorch-grad-cam is installed."""
    try:
        from pytorch_grad_cam import GradCAM
    except ImportError:
        return saliency_map(model, batch)
    try:
        target_layer = model.image.trunk[-1]
        cam = GradCAM(model=model, target_layers=[target_layer])
        return cam(input_tensor=batch)[0]
    except Exception:
        log.debug("grad-cam failed, falling back to gradient saliency")
        return saliency_map(model, batch)
