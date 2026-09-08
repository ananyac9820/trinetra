"""Colour ramps for the raster layers.

The infrared ramp is the one that matters. Forecasters read cyclone infrared
imagery through an enhancement curve, not a linear grey scale, because the
information sits in a narrow band of very cold brightness temperatures near the
top of the range. A linear grey ramp over 180 to 315 K puts the entire
convective signal into the last 15 percent of the scale and throws away the
structure the Dvorak technique depends on. The enhancement here follows the same
idea as the BD curve: grey through the warm and mid range, then hard colour steps
between 233 K and 190 K where the deep convection is.

Every palette is defined as control points in physical units, so the legend can
be generated from the same table that colours the pixels. A legend that is drawn
separately from the ramp drifts out of step with it.
"""

from __future__ import annotations

import numpy as np

# Control points: (physical value, (r, g, b)). Interpolated linearly between.
PALETTES: dict[str, list[tuple[float, tuple[int, int, int]]]] = {
    # Enhanced infrared, kelvin. Warm is dark, cold runs through the colour steps.
    "ir_enhanced": [
        (315.0, (12, 10, 18)),
        (290.0, (48, 46, 58)),
        (273.0, (96, 96, 104)),
        (253.0, (158, 158, 164)),
        (233.0, (236, 236, 238)),
        (232.9, (0, 176, 190)),
        (223.0, (0, 106, 214)),
        (213.0, (36, 190, 96)),
        (208.0, (232, 226, 60)),
        (203.0, (240, 138, 32)),
        (198.0, (218, 36, 44)),
        (193.0, (172, 40, 168)),
        (180.0, (255, 255, 255)),
    ],
    # Water vapour, kelvin. Sepia is conventional and keeps it distinct from IR.
    "water_vapour": [
        (265.0, (24, 18, 12)),
        (250.0, (86, 66, 44)),
        (240.0, (158, 132, 96)),
        (230.0, (216, 200, 168)),
        (220.0, (244, 242, 232)),
        (210.0, (120, 200, 224)),
        (190.0, (16, 40, 120)),
    ],
    # Outgoing longwave radiation, W m-2. Low means deep convection.
    "convection": [
        (340.0, (14, 14, 20)),
        (290.0, (44, 48, 66)),
        (240.0, (30, 96, 140)),
        (200.0, (24, 158, 168)),
        (160.0, (108, 200, 120)),
        (130.0, (244, 214, 68)),
        (105.0, (238, 122, 40)),
        (70.0, (200, 32, 60)),
    ],
    # Precipitation rate, mm h-1. Transparent below the first stop.
    "rainfall": [
        (0.0, (0, 0, 0)),
        (0.5, (18, 62, 128)),
        (2.0, (30, 128, 190)),
        (6.0, (54, 186, 154)),
        (12.0, (150, 214, 88)),
        (25.0, (246, 214, 62)),
        (45.0, (240, 130, 44)),
        (80.0, (214, 40, 60)),
        (160.0, (150, 30, 130)),
    ],
    # Sea surface temperature, degrees C. The 26 C stop is drawn as a contour
    # because it is the cyclogenesis threshold, not because it looks good.
    "thermal": [
        (18.0, (24, 34, 92)),
        (22.0, (32, 108, 168)),
        (26.0, (96, 186, 174)),
        (28.0, (216, 208, 120)),
        (30.0, (236, 138, 58)),
        (33.0, (186, 32, 46)),
    ],
    # Upper tropospheric humidity, percent. Dry intrusions must read clearly.
    "moisture": [
        (0.0, (86, 54, 24)),
        (30.0, (170, 132, 78)),
        (55.0, (222, 218, 206)),
        (75.0, (86, 172, 190)),
        (100.0, (18, 58, 128)),
    ],
    # Passive microwave 89 GHz, kelvin. Depression means ice scattering.
    "microwave": [
        (295.0, (18, 20, 28)),
        (275.0, (60, 70, 96)),
        (255.0, (52, 140, 176)),
        (230.0, (96, 196, 160)),
        (205.0, (240, 216, 84)),
        (180.0, (236, 120, 48)),
        (150.0, (198, 34, 62)),
        (120.0, (128, 24, 120)),
    ],
    # Surface wind speed, knots. Stops sit on the IMD category boundaries so the
    # colour change means something rather than being evenly spaced.
    "wind": [
        (0.0, (20, 24, 34)),
        (17.0, (40, 90, 140)),
        (34.0, (44, 160, 168)),
        (48.0, (128, 200, 96)),
        (64.0, (244, 210, 70)),
        (90.0, (240, 130, 44)),
        (120.0, (212, 42, 58)),
        (180.0, (150, 28, 128)),
    ],
    # Volumetric soil moisture, m3 m-3. The brown-ocean channel.
    "soil": [
        (0.0, (110, 82, 52)),
        (0.12, (162, 136, 96)),
        (0.25, (128, 158, 108)),
        (0.38, (48, 132, 138)),
        (0.5, (24, 62, 126)),
    ],
    # Aerosol optical depth at 550 nm. Dust.
    "dust": [
        (0.0, (28, 26, 24)),
        (0.3, (128, 104, 72)),
        (0.8, (198, 158, 96)),
        (1.4, (232, 196, 122)),
        (2.4, (250, 238, 206)),
    ],
    # Derived favourability, 0 to 1. Deliberately unlike every observed ramp
    # above, because a derived field must not read as an observation.
    "favourability": [
        (0.0, (40, 42, 58)),
        (0.25, (72, 82, 128)),
        (0.5, (128, 116, 178)),
        (0.75, (196, 138, 168)),
        (1.0, (250, 196, 150)),
    ],
    # Uncertainty, in whatever unit the companion layer declares.
    "uncertainty": [
        (0.0, (34, 38, 48)),
        (0.5, (108, 96, 96)),
        (1.0, (226, 206, 176)),
    ],
}

# Layers whose low end should render transparent rather than as a colour, so a
# field of zeros does not paint the ocean.
TRANSPARENT_BELOW = {"rainfall": 0.4, "dust": 0.08, "favourability": 0.02}

# Contours drawn on top of the ramp, in physical units.
CONTOURS = {"thermal": [26.0]}


def _table(name: str, steps: int = 256) -> np.ndarray:
    """Expand a palette's control points into a lookup table of RGB rows."""
    stops = PALETTES[name]
    values = np.array([s[0] for s in stops], dtype=float)
    colours = np.array([s[1] for s in stops], dtype=float)
    # Control points are written in the natural reading order for each field,
    # which is descending for temperature ramps. Sort so interpolation works
    # either way rather than requiring every table to be written ascending.
    order = np.argsort(values)
    values, colours = values[order], colours[order]

    grid = np.linspace(values[0], values[-1], steps)
    out = np.empty((steps, 3), dtype=np.uint8)
    for c in range(3):
        out[:, c] = np.interp(grid, values, colours[:, c]).round().astype(np.uint8)
    return out


_CACHE: dict[str, tuple[np.ndarray, float, float]] = {}


def lookup(name: str) -> tuple[np.ndarray, float, float]:
    """The lookup table plus the value range it spans."""
    if name not in _CACHE:
        stops = PALETTES[name]
        lo = min(s[0] for s in stops)
        hi = max(s[0] for s in stops)
        _CACHE[name] = (_table(name), lo, hi)
    return _CACHE[name]


def colourise(field: np.ndarray, name: str, vmin: float | None = None,
              vmax: float | None = None) -> np.ndarray:
    """Map a physical field to RGBA.

    NaN becomes fully transparent. That is the contract the tile service depends
    on: a missing value has to be visually distinguishable from a low value, or
    the map is telling the viewer that no coverage means zero.
    """
    table, lo, hi = lookup(name)
    lo = lo if vmin is None else vmin
    hi = hi if vmax is None else vmax

    a = np.asarray(field, dtype=np.float32)
    missing = ~np.isfinite(a)
    idx = np.clip((a - lo) / (hi - lo), 0.0, 1.0)
    idx = np.nan_to_num(idx, nan=0.0)
    idx = (idx * (len(table) - 1)).round().astype(np.int32)

    rgba = np.empty(a.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = table[idx]
    rgba[..., 3] = 255

    cut = TRANSPARENT_BELOW.get(name)
    if cut is not None:
        faint = a < cut
        rgba[..., 3] = np.where(faint, 0, rgba[..., 3])

    # Missing cells are cleared in RGB as well as in alpha. Alpha alone is
    # enough for a correct compositor, but anything that drops the alpha channel
    # would otherwise paint missing data as the palette's low-end colour, which
    # is the one confusion this whole system exists to prevent.
    rgba[missing] = (0, 0, 0, 0)

    for level in CONTOURS.get(name, []):
        rgba[_contour_mask(a, level)] = (255, 255, 255, 235)
    return rgba


def _contour_mask(a: np.ndarray, level: float) -> np.ndarray:
    """Cells where the field crosses a level, for a one-pixel contour line."""
    m = np.zeros(a.shape, dtype=bool)
    above = a >= level
    m[:-1, :] |= above[:-1, :] != above[1:, :]
    m[:, :-1] |= above[:, :-1] != above[:, 1:]
    return m & np.isfinite(a)


def legend(name: str, n: int = 9) -> list[dict]:
    """Legend stops in physical units, generated from the same table.

    The Explorer renders the legend from this rather than from a hand-written
    list, so a palette change cannot leave a stale legend behind.
    """
    table, lo, hi = lookup(name)
    values = np.linspace(lo, hi, n)
    idx = ((values - lo) / (hi - lo) * (len(table) - 1)).round().astype(int)
    return [
        {"value": round(float(v), 2), "rgb": [int(c) for c in table[i]]}
        for v, i in zip(values, idx)
    ]
