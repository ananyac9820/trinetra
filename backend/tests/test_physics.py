"""Checks on the physical relations and the geometry.

These are the tests worth having, because every one of them caught or would
catch a wrong number rather than a crash.
"""

import numpy as np
import pytest

from trinetra import config as C
from trinetra.grid import StormGrid, haversine_km, laea_forward, laea_inverse
from trinetra.ingest import ibtracs, synth


def test_laea_round_trip_is_exact():
    g = StormGrid(16.8, 88.1)
    lat, lon = g.latlon()
    x, y = laea_forward(lat, lon, 16.8, 88.1)
    la, lo = laea_inverse(x, y, 16.8, 88.1)
    assert np.nanmax(np.abs(la - lat)) < 1e-9
    assert np.nanmax(np.abs(lo - lon)) < 1e-9


def test_laea_distance_error_is_subpixel():
    """LAEA is equal-area, not equidistant, so check the error stays small.

    The projected radius must agree with the true great-circle distance to
    better than one pixel across the domain, or radius-based features such as
    convective coverage within 200 km are measuring the wrong annulus.
    """
    g = StormGrid(16.8, 88.1)
    lat, lon = g.latlon()
    err = np.abs(g.radius_km() - haversine_km(16.8, 88.1, lat, lon))
    assert np.nanmax(err) < g.res_km


def test_out_of_domain_pixel_is_flagged_not_clamped():
    g = StormGrid(16.8, 88.1)
    row, col = g.pixel_of([16.8, 0.0], [88.1, 88.1])
    assert (row[0], col[0]) == (128, 128)
    assert row[1] == -1 and col[1] == -1


def test_imd_scale_has_no_gaps():
    """Every wind from 17 kt upward maps to a class.

    The published scale quotes whole-knot ranges. Converted 1-minute winds are
    not whole knots, and a range table sent 27.9 kt through every band into the
    fallback and returned Super Cyclonic Storm.
    """
    for v in np.arange(17.0, 200.0, 0.1):
        assert ibtracs.imd_category(float(v)) is not None
    assert ibtracs.imd_category(16.9) is None
    assert ibtracs.imd_category(27.9) == "D"
    assert ibtracs.imd_category(28.0) == "DD"
    assert ibtracs.imd_category(130.0) == "SuCS"


def test_imd_scale_is_monotonic():
    prev = -1
    for v in np.arange(17.0, 200.0, 0.5):
        idx = ibtracs.IMD_CATEGORIES.index(ibtracs.imd_category(float(v)))
        assert idx >= prev
        prev = idx


def test_epoch_seconds_is_resolution_independent():
    """pandas 3 stores datetime64 in microseconds, pandas 2 in nanoseconds.

    Dividing a raw int64 cast by 1e9 is off by 1000 on one of them, which
    silently emptied every forward-looking RI target.
    """
    import pandas as pd

    t = pd.Series(pd.to_datetime(["2020-01-01", "2020-01-02"]))
    sec = ibtracs.epoch_seconds(t)
    assert abs((sec[1] - sec[0]) - 86400.0) < 1e-6
    assert abs(sec[0] - 1577836800.0) < 1e-6


def test_holland_b_stays_in_observed_range():
    for vmax, pmin in [(35, 998), (65, 985), (110, 960), (140, 925)]:
        assert 0.8 <= synth.holland_b(vmax, pmin) <= 2.5


def test_holland_profile_peaks_at_radius_of_max_wind():
    rmw, vmax = 40.0, 100.0
    r = np.linspace(1.0, 400.0, 800)
    v = synth.holland_wind_kt(r, vmax, rmw, 1.3)
    assert abs(r[int(np.argmax(v))] - rmw) < 6.0
    assert abs(v.max() - vmax) < 1.0
    assert v[-1] < 0.5 * vmax  # decays outward
    assert np.isfinite(v).all()


def test_radius_of_max_wind_shrinks_with_intensity():
    """Willoughby and Rahn: stronger storms have tighter cores."""
    assert synth.radius_max_wind_km(120, 15) < synth.radius_max_wind_km(40, 15)


def test_potential_intensity_rises_with_sst():
    pi = synth.potential_intensity_kt(np.array([26.0, 28.0, 30.0, 31.0]))
    assert np.all(np.diff(pi) > 0)
    # 15.69 + 98.03 at the 30 C reference point.
    assert abs(float(synth.potential_intensity_kt(30.0)) - 113.72) < 0.01


def test_olr_conversion_matches_its_anchors():
    assert abs(float(synth.olr_from_window_tb(np.array(200.0))) - 95.0) < 0.01
    assert abs(float(synth.olr_from_window_tb(np.array(290.0))) - 290.0) < 0.01


def test_colder_tops_at_higher_intensity():
    assert synth.coldest_top_k(130) < synth.coldest_top_k(45)
    assert synth.coldest_top_k(200) >= 185.0  # tropopause floor


def test_solar_zenith_separates_day_from_night():
    """Local noon over the Bay of Bengal must be day, local midnight night."""
    import pandas as pd

    lat = np.array([16.0])
    lon = np.array([88.0])  # local noon near 06:08 UTC
    noon = synth.solar_zenith_deg(lat, lon, pd.Timestamp("2023-06-15 06:00"))[0]
    night = synth.solar_zenith_deg(lat, lon, pd.Timestamp("2023-06-15 18:00"))[0]
    assert noon < 30.0
    assert night > 90.0


def test_scatterometer_rain_flag_is_missing_not_zero():
    """A rain-corrupted cell must be NaN. Zero is a number a model believes."""
    g = StormGrid(16.0, 88.0, size_px=64)
    rng = np.random.default_rng(0)
    land = np.zeros((64, 64), dtype=np.float32)
    ir = synth.ir_field(g, 110, 950, 16.0, 10.0, 250.0, 0.0, land, rng)
    qpe = synth.qpe_field(ir, 110, rng)
    speed, _u, _v = synth.scat_field(g, 110, 950, 16.0, 5.0, 5.0, qpe, land, rng)
    flagged = qpe > synth.SCAT_RAIN_FLAG_MM_H
    assert flagged.any(), "expected some rain-flagged cells in an intense storm"
    assert np.isnan(speed[flagged]).all()
    assert not np.isnan(speed[~flagged]).any()


def test_channel_order_matches_the_specification():
    assert synth.IMAGE_CHANNELS[:3] == ["ir", "wv", "vis"]
    assert synth.IMAGE_CHANNELS[8] == "land"
    assert synth.N_IMAGE_CHANNELS == 9
    assert synth.N_TABULAR == 14


def test_palette_marks_missing_as_transparent():
    from trinetra.tiles.palettes import colourise

    field = np.array([[210.0, np.nan], [290.0, 250.0]])
    rgba = colourise(field, "ir_enhanced")
    assert rgba[0, 1, 3] == 0
    assert tuple(rgba[0, 1, :3]) == (0, 0, 0)
    assert rgba[0, 0, 3] == 255
