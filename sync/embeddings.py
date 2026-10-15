"""Bailian text embeddings for already-redacted retrieval text, with a local vector cache."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from .local_indexer import atomic_write_json
except ImportError:
    from local_indexer import atomic_write_json

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "text-embedding-v4"
DEFAULT_DIMENSIONS = 256
BATCH_SIZE = 10
MAX_WORKERS = 4
MAX_ATTEMPTS = 4
REQUEST_TIMEOUT_SECONDS = 30
MAX_INPUT_CHARACTERS = 2_000
INT8_SCALE = 127
CACHE_SCHEMA_VERSION = 1
ENV_FILE = Path(__file__).resolve().parents[1] / ".env.local"

EmbedBatch = Callable[[Sequence[str]], list[list[float]]]


class EmbeddingError(RuntimeError):
    """Raised when embeddings cannot be produced; never carries the API key."""


@dataclass(frozen=True)
class EmbeddingSpec:
    model: str = DEFAULT_MODEL
    dimensions: int = DEFAULT_DIMENSIONS

    def metadata(self) -> dict[str, Any]:
        return {
            "provider": "bailian",
            "model": self.model,
            "dimensions": self.dimensions,
            "encoding": "int8-base64",
            "scale": INT8_SCALE,
        }


def encode_int8(vector: Sequence[float]) -> str:
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    quantized = bytes(
        max(-INT8_SCALE, min(INT8_SCALE, round(value / norm * INT8_SCALE))) & 0xFF for value in vector
    )
    return base64.b64encode(quantized).decode("ascii")


def _env_file_value(name: str, path: Path) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for line in lines:
        key, separator, value = line.partition("=")
        if separator and key.strip() == name:
            return value.strip().strip("\"'")
    return ""


def api_key_from_environment(env_file: Path = ENV_FILE) -> str:
    return os.environ.get("DASHSCOPE_API_KEY", "").strip() or _env_file_value("DASHSCOPE_API_KEY", env_file)


def _post_json(url: str, api_key: str, body: Mapping[str, Any]) -> Mapping[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(MAX_ATTEMPTS):
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            retryable = error.code == 429 or error.code >= 500
            if not retryable or attempt == MAX_ATTEMPTS - 1:
                raise EmbeddingError(f"embedding request failed (HTTP {error.code})") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            if attempt == MAX_ATTEMPTS - 1:
                raise EmbeddingError(f"embedding request failed ({type(error).__name__})") from None
        time.sleep(2**attempt)
    raise EmbeddingError("embedding request failed")


def bailian_embedder(spec: EmbeddingSpec, api_key: str, base_url: str = DEFAULT_BASE_URL) -> EmbedBatch:
    if not api_key:
        raise EmbeddingError("DASHSCOPE_API_KEY is not configured")

    def embed(texts: Sequence[str]) -> list[list[float]]:
        response = _post_json(
            f"{base_url}/embeddings",
            api_key,
            {"model": spec.model, "input": list(texts), "dimensions": spec.dimensions, "encoding_format": "float"},
        )
        data = response.get("data")
        if not isinstance(data, list) or len(data) != len(texts):
            raise EmbeddingError("embedding response has an unexpected shape")
        ordered = sorted(data, key=lambda item: item.get("index", 0))
        vectors = [item.get("embedding") for item in ordered]
        if not all(isinstance(vector, list) and len(vector) == spec.dimensions for vector in vectors):
            raise EmbeddingError("embedding response has unexpected dimensions")
        return vectors

    return embed


def _cache_key(spec: EmbeddingSpec, text: str) -> str:
    return hashlib.sha256(f"{spec.model}\n{spec.dimensions}\n{text}".encode("utf-8")).hexdigest()


def _load_cache(path: Path) -> dict[str, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(value, dict) or value.get("schemaVersion") != CACHE_SCHEMA_VERSION:
        return {}
    vectors = value.get("vectors")
    return {key: item for key, item in vectors.items() if isinstance(item, str)} if isinstance(vectors, dict) else {}


def embed_texts(
    texts: Sequence[str],
    *,
    spec: EmbeddingSpec,
    embed_batch: EmbedBatch,
    cache_path: Path,
) -> list[str]:
    """Return int8-base64 vectors aligned with ``texts``; only cache misses are sent upstream."""

    bounded = [text[:MAX_INPUT_CHARACTERS] for text in texts]
    cache = _load_cache(cache_path)
    keys = [_cache_key(spec, text) for text in bounded]
    missing = list(dict.fromkeys(key for key in keys if key not in cache))
    text_by_key = dict(zip(keys, bounded))
    batches = [missing[start : start + BATCH_SIZE] for start in range(0, len(missing), BATCH_SIZE)]

    def run(batch: list[str]) -> dict[str, str]:
        vectors = embed_batch([text_by_key[key] for key in batch])
        return {key: encode_int8(vector) for key, vector in zip(batch, vectors)}

    fresh: dict[str, str] = {}
    try:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            for result in executor.map(run, batches):
                fresh = {**fresh, **result}
    finally:
        if fresh:
            atomic_write_json(
                cache_path,
                {"schemaVersion": CACHE_SCHEMA_VERSION, "vectors": {**cache, **fresh}},
                compact=True,
            )
    merged = {**cache, **fresh}
    return [merged[key] for key in keys]
