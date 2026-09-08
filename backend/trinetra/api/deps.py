"""Application state: the archive, the model, the engine.

Built once at startup and shared. The one thing worth noting is that a missing
model checkpoint is not an error. The API comes up, every head reports itself as
abstaining with a reason, and the Explorer renders observed layers normally.
A stack that returns 500 when the weights are absent cannot be demonstrated
until the last thing is finished, which is exactly when it is most likely to be
broken.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

from .. import config as C
from ..inference.engine import InferenceEngine

log = logging.getLogger(__name__)


class AppState:
    def __init__(self):
        self.labels: pd.DataFrame | None = None
        self.engine: InferenceEngine | None = None
        self.checkpoint: dict = {}
        self.model = None
        self.baselines: dict = {}
        self.train_report: dict = {}
        self.warnings: list[str] = []

    # ------------------------------------------------------------ startup

    def load(self) -> None:
        self._load_labels()
        self._load_model()
        self._load_reports()
        self._build_engine()
        self._load_embeddings()

    def _load_labels(self) -> None:
        # Prefer the cube's own label set, so the archive the API serves is
        # exactly the archive the model was trained and evaluated on. Serving a
        # storm the cube does not contain would produce granules the model has
        # never seen without saying so.
        for path in (C.LABELS_DIR / "cube_labels_archive_96.csv", C.LABELS_CSV):
            if path.exists():
                self.labels = pd.read_csv(path, parse_dates=["valid_time"])
                log.info("labels: %s, %d fixes, %d storms",
                         path.name, len(self.labels), self.labels["sid"].nunique())
                return
        raise FileNotFoundError(
            "No label table found. Run scripts/build_labels.py first."
        )

    def _load_model(self) -> None:
        path = C.MODEL_DIR / "trinetra.pt"
        if not path.exists():
            self.warnings.append(
                "No model checkpoint. Every head reports as abstaining and only "
                "observed layers render. Train one with scripts/train.py."
            )
            log.warning(self.warnings[-1])
            return
        try:
            import torch

            from ..model.nets import ModelConfig, Trinetra

            ckpt = torch.load(path, map_location="cpu", weights_only=False)
            cfg = ModelConfig(**{k: v for k, v in (ckpt.get("config") or {}).items()
                                 if k in ModelConfig.__dataclass_fields__})
            model = Trinetra(cfg)
            model.load_state_dict(ckpt["state_dict"])
            model.eval()
            self.model = model
            self.checkpoint = ckpt
            log.info("model %s loaded, %.2fM parameters",
                     ckpt.get("model_version"), model.param_count() / 1e6)
        except Exception as exc:
            self.warnings.append(f"Model checkpoint failed to load: {exc}")
            log.exception("model load failed")

    def _load_reports(self) -> None:
        for attr, path in (
            ("baselines", C.LABELS_DIR / "baselines.json"),
            ("train_report", C.MODEL_DIR / "train_report.json"),
        ):
            if path.exists():
                setattr(self, attr, json.loads(path.read_text(encoding="utf-8")))
            else:
                self.warnings.append(f"{path.name} missing; /methods will show it absent.")

    def _build_engine(self) -> None:
        size = int((self.checkpoint.get("config") or {}).get("size_px", 96))
        self.engine = InferenceEngine(
            self.labels, model=self.model, checkpoint=self.checkpoint,
            size_px=size, mode=C.MODE,
        )
        log.info("engine ready: mode=%s, size=%d px", C.MODE, size)

    def _load_embeddings(self) -> None:
        """Fit the OOD gate and the analogue index from the saved embeddings."""
        path = C.MODEL_DIR / "embeddings.npz"
        if not path.exists() or self.engine is None:
            self.warnings.append(
                "No embeddings file, so the OOD gate and analogue retrieval are "
                "unavailable. Both are produced by scripts/train.py."
            )
            return
        try:
            z = np.load(path, allow_pickle=True)
            emb = z["embedding"]
            rows = z["row_idx"]
            meta = []
            for r in rows:
                row = self.labels.iloc[int(r)]
                meta.append({
                    "sid": str(row["sid"]),
                    "name": str(row["name"]),
                    "season": int(row["season"]),
                    "valid_time": pd.Timestamp(row["valid_time"]).isoformat() + "Z",
                    "vmax_kt": float(row["vmax_kt"]),
                    "category": row["imd_category"],
                    "regime": str(row["regime"]),
                    "subsequently_ri": (None if not np.isfinite(row["ri_24h"])
                                        else bool(row["ri_24h"])),
                    "dv_24h_kt": (None if not np.isfinite(row["dv_24h_kt"])
                                  else round(float(row["dv_24h_kt"]), 1)),
                })
            self.engine.attach_ood(emb, meta)
            log.info("OOD gate and analogue index built from %d embeddings", len(emb))
        except Exception as exc:
            self.warnings.append(f"Embeddings failed to load: {exc}")
            log.exception("embeddings load failed")


STATE = AppState()
