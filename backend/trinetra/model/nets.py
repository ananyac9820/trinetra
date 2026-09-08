"""The TRINETRA network. Late fusion, per-source encoders, nine heads.

The architecture exists to serve three input regimes with one set of weights:
the archive tier with Level 1 imagery, the live tier with Level 2 products and
no Level 1, and whatever a user uploads. That is only possible because the
availability mask is an input rather than a build-time constant, so every design
choice below follows from wanting the same weights to degrade honestly instead
of failing when a channel goes missing.

Four mechanisms carry that.

Per-channel stems. Each of the nine image channels gets its own first
convolution rather than being stacked into one nine-channel input. A stacked
input learns a single filter bank over a fixed channel set, and removing a
channel then shifts the statistics of everything downstream. Separate stems mean
a missing channel contributes nothing instead of contributing zeros, which are
not the same thing.

Masked pooling. Channel features are combined by a weighted mean using the
availability mask as the weight, so the fused representation has the same scale
whether eight channels or three arrived. Summing and dividing by a constant would
make the live tier look systematically quieter than the archive tier.

Time-offset conditioning. Every channel carries minutes since its own last
observation. A microwave overpass four hours old and one four minutes old are
both present, and the model should not treat them alike. The offset is embedded
and added to the channel's features so it can learn to discount staleness.

Modality dropout at training time, at rates matching real availability. This is
what makes the degradation honest rather than merely possible.

Heads follow the specification: detection, centre-fix, Dvorak scene, IMD
category, VMAX, PMIN, RI probability, regime, and re-intensification over land.
Each returns its own uncertainty where it can, because nothing downstream is
allowed to render a derived field without one.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import torch
import torch.nn as nn
import torch.nn.functional as F

from .. import config as C
from ..ingest.synth import IMAGE_CHANNELS, N_IMAGE_CHANNELS, N_TABULAR

# Training-time modality dropout rates, chosen to match what the archive
# actually contains rather than to be convenient.
#
# Microwave is absent at most timesteps in reality, so it is dropped hard: a
# model trained with microwave almost always present learns to depend on it and
# then collapses on the live tier. Visible is already gated by solar zenith
# angle in the data, so its dropout here is small and covers instrument
# outages rather than night.
MODALITY_DROPOUT = {
    "ir": 0.10,
    "wv": 0.10,
    "vis": 0.15,
    "olr": 0.10,
    "pmw89": 0.55,
    "pmw37": 0.55,
    "scat": 0.45,
    "soil": 0.30,
    "land": 0.0,  # static, always available
}


@dataclass
class ModelConfig:
    size_px: int = 128
    seq_len: int = C.SEQ_LEN
    width: int = 32
    embed_dim: int = 192
    tabular_dim: int = N_TABULAR
    n_basins: int = len(C.BASINS)
    heatmap_px: int = 32
    dropout: float = 0.1
    backbone: str = "builtin"  # "builtin" or a timm model name
    heads: tuple = field(default_factory=lambda: (
        "detection", "centre", "dvorak", "category", "vmax", "pmin",
        "ri", "regime", "reintensify",
    ))


# Regression targets are standardised before the loss sees them, and the
# network's regression heads therefore work in standardised units.
#
# This is not cosmetic. Minimum central pressure is around 980 hPa and maximum
# wind around 60 kt, so a Gaussian negative log likelihood on the raw values is
# dominated almost entirely by the pressure head: a 980-scale squared residual
# against a 60-scale one puts the total loss in the tens of thousands and the
# wind head contributes almost nothing to the gradient. Standardising puts both
# heads on the same footing.
VMAX_MEAN, VMAX_STD = 45.0, 30.0
PMIN_MEAN, PMIN_STD = 990.0, 20.0


def denorm_vmax(x):
    return x * VMAX_STD + VMAX_MEAN


def denorm_pmin(x):
    return x * PMIN_STD + PMIN_MEAN


def norm_vmax(x):
    return (x - VMAX_MEAN) / VMAX_STD


def norm_pmin(x):
    return (x - PMIN_MEAN) / PMIN_STD


def _conv_block(cin: int, cout: int, stride: int = 2) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, stride=stride, padding=1, bias=False),
        nn.GroupNorm(min(8, cout), cout),
        nn.SiLU(inplace=True),
    )


class ChannelStems(nn.Module):
    """Independent per-channel stems, computed as grouped convolutions.

    Semantically this is nine separate stems: with `groups=9`, each group of
    output channels depends only on its own input channel, so the weights are
    per-channel exactly as intended. Written as one grouped op rather than a
    Python loop over nine modules because the loop was the forward pass
    bottleneck, and nine small convolutions launched separately do not use the
    hardware anywhere near as well as one wide grouped convolution.

    Kept deliberately narrow. Nine stems at full width would be nine times the
    parameters in the early layers, which is where the least channel-specific
    work happens.
    """

    def __init__(self, n_channels: int, width: int):
        super().__init__()
        self.n = n_channels
        self.width = width
        mid = width // 2
        self.net = nn.Sequential(
            nn.Conv2d(n_channels, n_channels * mid, 3, stride=2, padding=1,
                      groups=n_channels, bias=False),
            nn.GroupNorm(n_channels, n_channels * mid),
            nn.SiLU(inplace=True),
            nn.Conv2d(n_channels * mid, n_channels * width, 3, stride=2, padding=1,
                      groups=n_channels, bias=False),
            nn.GroupNorm(n_channels, n_channels * width),
            nn.SiLU(inplace=True),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """(N, C, H, W) to (N, C, width, H/4, W/4)."""
        n = x.shape[0]
        out = self.net(x)
        return out.reshape(n, self.n, self.width, out.shape[-2], out.shape[-1])


class ImageEncoder(nn.Module):
    """Per-channel stems, mask-weighted fusion, then a shared trunk."""

    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.cfg = cfg
        w = cfg.width
        self.stems = ChannelStems(N_IMAGE_CHANNELS, w)
        # Staleness embedding, added to the channel's own features.
        self.offset_embed = nn.Sequential(nn.Linear(1, w), nn.SiLU(), nn.Linear(w, w))
        self.trunk = nn.Sequential(
            _conv_block(w, w * 2, stride=2),
            _conv_block(w * 2, w * 4, stride=2),
            _conv_block(w * 4, w * 4, stride=1),
        )
        # Keypoint branch taps the fused features before the trunk downsamples
        # them. At 128 px input the fused map is 32 by 32, so one cell is about
        # 31 km; after the trunk it would be 16 by 16 and 62 km. The spatial
        # softmax recovers sub-cell precision from the expectation, but it
        # cannot recover detail that was already pooled away, and beating a
        # 30 km centre fix is the entire purpose of this head.
        self.keypoint = nn.Sequential(
            nn.Conv2d(w, w, 3, padding=1), nn.SiLU(),
            nn.Conv2d(w, 1, 1),
        )
        self.proj = nn.Linear(w * 4, cfg.embed_dim)

    def forward(self, frames: torch.Tensor, mask: torch.Tensor,
                offsets: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """
        frames  (B, T, C, H, W)
        mask    (B, T, C)   1 where the channel is present
        offsets (B, T, C)   minutes since that channel's observation
        Returns per-frame embeddings (B, T, D) and a centre heatmap (B, T, h, w).
        """
        b, t, c, h, w = frames.shape
        flat = frames.reshape(b * t, c, h, w)
        m = mask.reshape(b * t, c)
        # Log-scaled staleness: the difference between 5 and 30 minutes matters
        # more than between 300 and 325.
        off = torch.log1p(offsets.clamp(min=0.0) / 60.0).reshape(b * t, c, 1)

        stacked = self.stems(flat)  # (B*T, C, w, h', w')
        # Staleness embedding, one vector per channel, broadcast over space.
        stacked = stacked + self.offset_embed(off)[:, :, :, None, None]

        # Mask-weighted mean over channels, so the scale does not depend on how
        # many channels arrived. A dropped channel contributes nothing rather
        # than contributing zeros.
        weight = m[:, :, None, None, None]
        denom = weight.sum(dim=1).clamp(min=1e-3)
        fused = stacked.mul(weight).sum(dim=1) / denom

        keypoint = self.keypoint(fused)
        deep = self.trunk(fused)
        pooled = F.adaptive_avg_pool2d(deep, 1).flatten(1)
        emb = self.proj(pooled).reshape(b, t, -1)
        kp = keypoint.reshape(b, t, keypoint.shape[-2], keypoint.shape[-1])
        return emb, kp


class TemporalAttention(nn.Module):
    """Attention pooling over frames, with frames that have no data masked out.

    Chosen over a ConvLSTM and over a neural ODE for the reason the model
    specification gives: a fixed time grid with a mask channel and a
    time-since-observation feature captures irregular sampling at this scale
    without the complexity being repaid.
    """

    def __init__(self, dim: int, dropout: float = 0.1):
        super().__init__()
        self.score = nn.Sequential(nn.Linear(dim, dim // 2), nn.Tanh(),
                                   nn.Linear(dim // 2, 1))
        self.norm = nn.LayerNorm(dim)
        self.drop = nn.Dropout(dropout)

    def forward(self, seq: torch.Tensor, frame_valid: torch.Tensor) -> torch.Tensor:
        logits = self.score(seq).squeeze(-1)
        logits = logits.masked_fill(frame_valid < 0.5, float("-inf"))
        # A sample with no valid frame at all would give all -inf and NaN out of
        # softmax, so fall back to uniform and let the mask features say the
        # input was empty.
        empty = (frame_valid.sum(dim=1) < 0.5)[:, None]
        logits = torch.where(empty.expand_as(logits), torch.zeros_like(logits), logits)
        attn = torch.softmax(logits, dim=1)
        return self.drop(self.norm((seq * attn[:, :, None]).sum(dim=1)))


class TabularBranch(nn.Module):
    """The environmental predictors. Kept separate so it can run alone.

    An upload with a CSV of predictors and no imagery runs this branch only,
    which is upload mode B, and the image channels are marked absent rather
    than zero-filled.
    """

    def __init__(self, dim_in: int, dim_out: int, dropout: float = 0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(dim_in, 128), nn.SiLU(), nn.Dropout(dropout),
            nn.Linear(128, 128), nn.SiLU(), nn.Dropout(dropout),
            nn.Linear(128, dim_out),
        )
        # A present-flag per feature, so a missing predictor is distinguishable
        # from a predictor that happens to be zero.
        self.present = nn.Linear(dim_in, dim_out)

    def forward(self, x: torch.Tensor, valid: torch.Tensor) -> torch.Tensor:
        return self.net(torch.nan_to_num(x) * valid) + self.present(valid)


class Trinetra(nn.Module):
    """The full model."""

    def __init__(self, cfg: ModelConfig | None = None):
        super().__init__()
        self.cfg = cfg or ModelConfig()
        d = self.cfg.embed_dim

        self.image = ImageEncoder(self.cfg)
        self.temporal = TemporalAttention(d, self.cfg.dropout)
        self.tabular = TabularBranch(self.cfg.tabular_dim, d, self.cfg.dropout)
        self.basin = nn.Embedding(self.cfg.n_basins, 32)

        # Availability summary as an explicit input to the fusion. The model is
        # told which sensors it had, not left to infer it from the features.
        self.avail = nn.Sequential(
            nn.Linear(N_IMAGE_CHANNELS * 2, 64), nn.SiLU(), nn.Linear(64, 64)
        )

        fused_dim = d + d + 32 + 64
        self.fuse = nn.Sequential(
            nn.Linear(fused_dim, 256), nn.SiLU(), nn.Dropout(self.cfg.dropout),
            nn.Linear(256, 256), nn.SiLU(),
        )

        h = 256
        self.head_detection = nn.Linear(h, len(C.DETECTION_CLASSES))
        self.head_dvorak = nn.Linear(h, len(C.DVORAK_SCENES))
        self.head_category = nn.Linear(h, len(C.IMD_CATEGORIES))
        self.head_regime = nn.Linear(h, len(C.REGIMES))
        self.head_ri = nn.Linear(h, 1)
        self.head_reintensify = nn.Linear(h, 1)
        # Regression heads emit a mean and a log variance, so the network can
        # say it is unsure rather than only being wrong.
        self.head_vmax = nn.Linear(h, 2)
        self.head_pmin = nn.Linear(h, 2)

    def forward(self, batch: dict) -> dict:
        frames = batch["frames"]
        mask = batch["mask"]
        offsets = batch["offsets"]

        emb, heatmap = self.image(frames, mask, offsets)
        frame_valid = (mask.sum(dim=2) > 0).float()
        img_vec = self.temporal(emb, frame_valid)

        tab_vec = self.tabular(batch["tabular"], batch["tabular_valid"])
        basin_vec = self.basin(batch["basin"])

        # Fraction of frames each channel was present for, and its mean log age.
        pres = mask.mean(dim=1)
        age = torch.log1p(offsets.clamp(min=0, max=10_000) / 60.0).mean(dim=1)
        avail_vec = self.avail(torch.cat([pres, age], dim=1))

        z = self.fuse(torch.cat([img_vec, tab_vec, basin_vec, avail_vec], dim=1))

        vmax = self.head_vmax(z)
        pmin = self.head_pmin(z)
        centre, sigma = self._centre_from_heatmap(heatmap)

        # Heads emit standardised values; the physical-unit versions are derived
        # here so that callers never have to remember to convert. The loss uses
        # the standardised pair, everything else uses the physical pair.
        vmax_norm, vmax_logvar = vmax[:, 0], vmax[:, 1].clamp(-6.0, 6.0)
        pmin_norm, pmin_logvar = pmin[:, 0], pmin[:, 1].clamp(-6.0, 6.0)

        return {
            "embedding": z,
            "detection": self.head_detection(z),
            "dvorak": self.head_dvorak(z),
            "category": self.head_category(z),
            "regime": self.head_regime(z),
            "ri_logit": self.head_ri(z).squeeze(-1),
            "reintensify_logit": self.head_reintensify(z).squeeze(-1),
            "vmax_norm": vmax_norm,
            "vmax_logvar": vmax_logvar,
            "pmin_norm": pmin_norm,
            "pmin_logvar": pmin_logvar,
            "vmax": denorm_vmax(vmax_norm),
            "pmin": denorm_pmin(pmin_norm),
            "vmax_sigma_kt": torch.exp(0.5 * vmax_logvar) * VMAX_STD,
            "pmin_sigma_hpa": torch.exp(0.5 * pmin_logvar) * PMIN_STD,
            "heatmap": heatmap,
            "centre_offset": centre,
            "centre_sigma": sigma,
        }

    @staticmethod
    def _centre_from_heatmap(heatmap: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Spatial softmax over the last frame's heatmap.

        Returns the expected position in normalised grid coordinates and the
        spread of that distribution, which is where the centre-fix uncertainty
        comes from. Taking an argmax would give a position and no uncertainty,
        and every downstream head needs the uncertainty.
        """
        last = heatmap[:, -1]
        b, h, w = last.shape
        prob = torch.softmax(last.reshape(b, -1), dim=1).reshape(b, h, w)

        ys = torch.linspace(-1, 1, h, device=last.device)[None, :, None]
        xs = torch.linspace(-1, 1, w, device=last.device)[None, None, :]
        ex = (prob * xs).sum(dim=(1, 2))
        ey = (prob * ys).sum(dim=(1, 2))
        varx = (prob * (xs - ex[:, None, None]) ** 2).sum(dim=(1, 2))
        vary = (prob * (ys - ey[:, None, None]) ** 2).sum(dim=(1, 2))
        return torch.stack([ex, ey], dim=1), torch.sqrt(varx + vary + 1e-8)

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())


def apply_modality_dropout(mask: torch.Tensor, offsets: torch.Tensor,
                           generator: torch.Generator | None = None
                           ) -> tuple[torch.Tensor, torch.Tensor]:
    """Drop channels at the rates real availability produces.

    Applied per sample and per channel, not per frame, so a channel goes missing
    for a whole sequence the way a satellite outage actually behaves. Dropping
    per frame would teach the model that gaps are always one frame long.

    Dropped channels get their offset pushed far out as well as their mask
    cleared, so the staleness input stays consistent with the availability
    input. Leaving a fresh offset on a dropped channel is a small
    inconsistency the model will happily exploit.
    """
    b, t, c = mask.shape
    rates = torch.tensor(
        [MODALITY_DROPOUT[name] for name in IMAGE_CHANNELS],
        device=mask.device, dtype=mask.dtype,
    )
    keep = (torch.rand(b, c, generator=generator, device=mask.device) >= rates).to(mask.dtype)
    keep = keep[:, None, :].expand(b, t, c)

    new_mask = mask * keep
    new_offsets = torch.where(keep > 0.5, offsets, torch.full_like(offsets, 10_000.0))

    # Mandatory channels: if both IR and WV were dropped and OLR too, the sample
    # has no structural information at all and the loss would be meaningless.
    # Restore IR in that case, which mirrors the real constraint that IR and WV
    # are mandatory training channels.
    ir, wv, olr = IMAGE_CHANNELS.index("ir"), IMAGE_CHANNELS.index("wv"), IMAGE_CHANNELS.index("olr")
    dead = (new_mask[:, :, [ir, wv, olr]].sum(dim=(1, 2)) == 0)
    if dead.any():
        new_mask[dead, :, ir] = mask[dead, :, ir]
        new_offsets[dead, :, ir] = offsets[dead, :, ir]
    return new_mask, new_offsets
