"""Out-of-distribution gate and nearest-analogue retrieval.

These two things are the same machinery used for opposite purposes, which is why
they live together. Both work on the fused embedding.

The gate answers "is this input inside the envelope the model was validated on".
Above the threshold the system abstains from a numeric estimate. That behaviour
is what makes the upload feature defensible rather than a toy: handed Himawari
data over the Western Pacific, the system says out of basin and declines,
instead of returning a confident number for a storm in a basin it has never
scored itself on.

Retrieval answers "what did the closest historical cases do". When the gate
refuses to produce a number, analogues are what it returns instead. Retrieving
and presenting a real precedent is honest in a way that fabricating a
probability for a rare event is not.

Mahalanobis distance over the training embeddings, with a shrunk covariance
because 256 dimensions against a few thousand samples makes the sample
covariance badly conditioned. FAISS is used for retrieval when installed;
otherwise exact search, which at this archive size is a millisecond.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

log = logging.getLogger(__name__)


@dataclass
class MahalanobisOOD:
    """Distance from the training embedding distribution."""

    mean: np.ndarray
    precision: np.ndarray
    threshold: float
    calibration: dict

    @classmethod
    def fit(cls, embeddings: np.ndarray, quantile: float = 0.99,
            shrinkage: float | None = None) -> MahalanobisOOD:
        x = np.asarray(embeddings, dtype=np.float64)
        n, d = x.shape
        mean = x.mean(axis=0)
        centred = x - mean
        cov = centred.T @ centred / max(n - 1, 1)

        # Ledoit-Wolf style shrinkage toward a scaled identity. With d = 256 and
        # n in the low thousands the sample covariance is nearly singular, and
        # inverting it directly produces enormous distances driven by the
        # smallest eigenvalues rather than by anything about the input.
        if shrinkage is None:
            shrinkage = float(np.clip(d / max(n, 1) * 0.5, 0.02, 0.6))
        target = np.trace(cov) / d * np.eye(d)
        cov = (1.0 - shrinkage) * cov + shrinkage * target
        precision = np.linalg.pinv(cov)

        dist = cls._distance(x, mean, precision)
        threshold = float(np.quantile(dist, quantile))
        calib = {
            "n_train": int(n),
            "dim": int(d),
            "shrinkage": round(shrinkage, 4),
            "quantile": quantile,
            "train_median": round(float(np.median(dist)), 4),
            "train_p95": round(float(np.quantile(dist, 0.95)), 4),
            "train_p99": round(float(np.quantile(dist, 0.99)), 4),
        }
        log.info("OOD fitted: threshold %.3f at q%.2f over %d embeddings",
                 threshold, quantile, n)
        return cls(mean, precision, threshold, calib)

    @staticmethod
    def _distance(x: np.ndarray, mean: np.ndarray, precision: np.ndarray) -> np.ndarray:
        c = np.asarray(x, dtype=np.float64) - mean
        # Square root of the squared Mahalanobis distance, so the number is on
        # the scale of standard deviations and the threshold is interpretable.
        return np.sqrt(np.maximum(np.einsum("ij,jk,ik->i", c, precision, c), 0.0))

    def score(self, embeddings: np.ndarray) -> np.ndarray:
        x = np.atleast_2d(np.asarray(embeddings, dtype=np.float64))
        return self._distance(x, self.mean, self.precision)

    def check(self, embedding: np.ndarray) -> dict:
        """The gate result, in the shape the API and the upload page render."""
        s = float(self.score(embedding)[0])
        return {
            "score": round(s, 4),
            "threshold": round(self.threshold, 4),
            "in_distribution": bool(s <= self.threshold),
            "ratio": round(s / self.threshold, 4) if self.threshold > 0 else None,
        }

    def as_dict(self) -> dict:
        return {"threshold": self.threshold, "calibration": self.calibration}


@dataclass
class AnalogueIndex:
    """Nearest historical cases by embedding similarity.

    Cheap to build and disproportionately useful to a forecaster. Rare events do
    not have enough cases to support a calibrated probability, so the honest
    move is to retrieve the closest precedents and present them, rather than to
    manufacture a number from four historical analogues.
    """

    embeddings: np.ndarray
    meta: list[dict]
    _index: object = None

    @classmethod
    def build(cls, embeddings: np.ndarray, meta: list[dict]) -> AnalogueIndex:
        x = np.asarray(embeddings, dtype=np.float32)
        # L2-normalise so inner product is cosine similarity, which behaves
        # better than raw distance on embeddings whose norm tracks intensity.
        norms = np.linalg.norm(x, axis=1, keepdims=True)
        x = x / np.maximum(norms, 1e-8)

        index = None
        try:
            import faiss

            index = faiss.IndexFlatIP(x.shape[1])
            index.add(x)
            log.info("analogue index: FAISS, %d vectors", len(x))
        except ImportError:
            log.info("analogue index: exact search, %d vectors", len(x))
        return cls(x, list(meta), index)

    def query(self, embedding: np.ndarray, k: int = 5,
              exclude_sid: str | None = None) -> list[dict]:
        q = np.asarray(embedding, dtype=np.float32).reshape(1, -1)
        q = q / max(float(np.linalg.norm(q)), 1e-8)

        # Over-fetch, because excluding the query's own storm can otherwise
        # leave fewer than k results. A storm retrieved as its own analogue is
        # not a precedent.
        fetch = min(len(self.embeddings), k * 6 + 10)
        if self._index is not None:
            sims, idx = self._index.search(q, fetch)
            sims, idx = sims[0], idx[0]
        else:
            sims_all = (self.embeddings @ q.T).ravel()
            idx = np.argsort(-sims_all)[:fetch]
            sims = sims_all[idx]

        out = []
        for sim, i in zip(sims, idx):
            if i < 0 or i >= len(self.meta):
                continue
            m = self.meta[int(i)]
            if exclude_sid is not None and m.get("sid") == exclude_sid:
                continue
            out.append({**m, "similarity": round(float(sim), 4)})
            if len(out) >= k:
                break
        return out
