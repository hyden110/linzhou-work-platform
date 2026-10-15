#!/usr/bin/env python3
"""Build the public, bounded data bundle consumed by hybrid retrieval."""

from __future__ import annotations

import argparse
import json
import re
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

try:
    from .embeddings import EmbeddingError, EmbeddingSpec, api_key_from_environment, bailian_embedder, embed_texts
    from .local_indexer import atomic_write_json
except ImportError:
    from embeddings import EmbeddingError, EmbeddingSpec, api_key_from_environment, bailian_embedder, embed_texts
    from local_indexer import atomic_write_json

SCHEMA_VERSION = 2
MAX_SUMMARY_CHARACTERS = 500
MAX_CITATION_CHARACTERS = 300
MAX_CITATIONS = 12
EXIT_DEGRADED = 3

EmbedTexts = Callable[[Sequence[str]], list[str]]
HOME_PLACEHOLDER = "<HOME>"
REDACTION_PLACEHOLDER = "[REDACTED]"
SECRET_VALUE_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9._-]{16,}"),
    re.compile(r"\bpt-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"\bLTAI[A-Za-z0-9]{12,}\b"),
    re.compile(r"\bgh[oprsu]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}"),
)
SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)\b(api[_ -]?key|access[_ -]?key|secret(?:[_ -]?key)?|token|password)"
    r"([\"']?\s*[:=]\s*[\"']?)[^\s\"',;}\]]{8,}"
)
PRIVATE_KEY_PATTERN = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
    re.DOTALL,
)


class RetrievalBundleError(ValueError):
    """Raised when retrieval bundle inputs violate the safe contract."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _redact_secrets(text: str) -> str:
    redacted = PRIVATE_KEY_PATTERN.sub(REDACTION_PLACEHOLDER, text)
    for pattern in SECRET_VALUE_PATTERNS:
        redacted = pattern.sub(REDACTION_PLACEHOLDER, redacted)
    return SECRET_ASSIGNMENT_PATTERN.sub(
        lambda match: f"{match.group(1)}{match.group(2)}{REDACTION_PLACEHOLDER}",
        redacted,
    )


def _safe_text(value: object, limit: int) -> str:
    text = str(value or "").encode("utf-16", errors="surrogatepass").decode("utf-16", errors="replace")
    home = str(Path.home()).rstrip("/")
    if home:
        text = text.replace(home, HOME_PLACEHOLDER)
    sanitized = _redact_secrets(text.replace("~/", f"{HOME_PLACEHOLDER}/").replace("\x00", ""))
    return sanitized.strip()[:limit]


def _load_mapping(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise RetrievalBundleError(f"unable to read {label} ({type(error).__name__})") from error
    except json.JSONDecodeError as error:
        raise RetrievalBundleError(f"{label} must contain valid JSON") from error
    if not isinstance(value, Mapping):
        raise RetrievalBundleError(f"{label} must be a JSON object")
    return value


def _public_metadata(index: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    documents = index.get("documents")
    if not isinstance(documents, list):
        raise RetrievalBundleError("index.documents must be an array")
    result: dict[str, Mapping[str, Any]] = {}
    for item in documents:
        if not isinstance(item, Mapping):
            continue
        document_id = item.get("id")
        if isinstance(document_id, str) and document_id.strip():
            result = {**result, document_id.strip(): item}
    return result


def _safe_relative_path(value: object) -> str:
    text = _safe_text(value, 600)
    path = Path(text)
    if not text or path.is_absolute() or ".." in path.parts:
        return ""
    return path.as_posix()


def _safe_topics(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [topic for item in value if (topic := _safe_text(item, 80))][:8]


def _safe_citations(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    citations: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        locator = item.get("locator")
        if not isinstance(locator, Mapping):
            continue
        kind = _safe_text(locator.get("kind"), 80)
        locator_value = _safe_text(locator.get("value"), 160)
        text = _safe_text(item.get("text"), MAX_CITATION_CHARACTERS)
        if kind and locator_value and text:
            citations.append(
                {
                    "id": f"c{len(citations) + 1}",
                    "locator": {"kind": kind, "value": locator_value},
                    "text": text,
                }
            )
        if len(citations) == MAX_CITATIONS:
            break
    return citations


def _retrieval_document(payload: Mapping[str, Any], metadata: Mapping[str, Any]) -> dict[str, Any]:
    title = _safe_text(metadata.get("title") or payload.get("title"), 300)
    relative_path = _safe_relative_path(metadata.get("relativePath"))
    topics = _safe_topics(metadata.get("topics"))
    summary = _safe_text(payload.get("summary"), MAX_SUMMARY_CHARACTERS)
    citations = _safe_citations(payload.get("citations"))
    return {
        "id": _safe_text(metadata.get("id"), 160),
        "source": _safe_text(metadata.get("source"), 80),
        "sourceLabel": _safe_text(metadata.get("sourceLabel"), 120),
        "type": _safe_text(metadata.get("type"), 32),
        "title": title,
        "modifiedAt": _safe_text(metadata.get("modifiedAt"), 80),
        "topics": topics,
        "location": _safe_text(metadata.get("location"), 160),
        "relativePath": relative_path,
        "summary": summary,
        "citations": citations,
    }


def _document_embedding_text(document: Mapping[str, Any]) -> str:
    return "\n".join(part for part in (document["title"], " ".join(document["topics"]), document["summary"]) if part)


def _citation_embedding_text(document: Mapping[str, Any], citation: Mapping[str, Any]) -> str:
    return f"{document['title']}\n{citation['text']}"


def _with_vectors(documents: Sequence[dict[str, Any]], embed: EmbedTexts) -> list[dict[str, Any]]:
    """Embed only redacted bundle text; raw source text never reaches the embedder."""

    texts = [
        text
        for document in documents
        for text in (
            _document_embedding_text(document),
            *(_citation_embedding_text(document, citation) for citation in document["citations"]),
        )
    ]
    vectors = iter(embed(texts))
    return [
        {
            **document,
            "vector": next(vectors),
            "citations": [{**citation, "vector": next(vectors)} for citation in document["citations"]],
        }
        for document in documents
    ]


def build_retrieval_bundle(
    *,
    index_path: Path,
    payload_paths: Sequence[Path],
    output_path: Path,
    mirror_paths: Sequence[Path] = (),
    embed: Optional[EmbedTexts] = None,
    embedding: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    resolved_inputs = {index_path.resolve(), *(path.resolve() for path in payload_paths)}
    resolved_outputs = [output_path.resolve(), *(path.resolve() for path in mirror_paths)]
    if any(path in resolved_inputs for path in resolved_outputs):
        raise RetrievalBundleError("output path must be distinct from all input paths")
    if len(set(resolved_outputs)) != len(resolved_outputs):
        raise RetrievalBundleError("retrieval bundle output paths must be distinct")

    index = _load_mapping(index_path, "knowledge index")
    metadata_by_id = _public_metadata(index)
    documents_by_id: dict[str, dict[str, Any]] = {}
    skipped = 0

    for position, payload_path in enumerate(payload_paths):
        payload = _load_mapping(payload_path, f"payload[{position}]")
        documents = payload.get("documents")
        if not isinstance(documents, list):
            raise RetrievalBundleError(f"payload[{position}].documents must be an array")
        for item in documents:
            document_id = item.get("id") if isinstance(item, Mapping) else None
            if not isinstance(document_id, str) or document_id not in metadata_by_id:
                skipped += 1
                continue
            if document_id not in documents_by_id:
                documents_by_id = {
                    **documents_by_id,
                    document_id: _retrieval_document(item, metadata_by_id[document_id]),
                }

    documents = [documents_by_id[key] for key in sorted(documents_by_id)]
    if embed is not None:
        documents = _with_vectors(documents, embed)
    bundle = {
        "schemaVersion": SCHEMA_VERSION,
        "mode": "safe-retrieval-bundle",
        "generatedAt": _utc_now(),
        "documentCount": len(documents),
        "skippedCount": skipped,
        **({"embedding": dict(embedding)} if embed is not None and embedding else {}),
        "documents": documents,
    }
    for destination in (output_path, *mirror_paths):
        atomic_write_json(destination, bundle, compact=True)
    return bundle


def _parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    cache = project_root / ".local-cache"
    parser = argparse.ArgumentParser(description="生成公开、安全、有界的混合检索数据包")
    parser.add_argument("--index", type=Path, default=project_root / "public/data/knowledge-index.json")
    parser.add_argument(
        "--payload",
        type=Path,
        action="append",
        default=None,
        help="可重复指定安全知识处理 payload",
    )
    parser.add_argument("--output", type=Path, default=project_root / "functions/retrieval-bundle.json")
    parser.add_argument(
        "--mirror-output",
        type=Path,
        action="append",
        default=None,
        help="可重复指定仅供受控服务端使用的镜像输出",
    )
    parser.add_argument("--no-embeddings", action="store_true", help="跳过百炼向量，仅保留关键词检索")
    parser.add_argument("--embedding-cache", type=Path, default=cache / "embedding-cache.json")
    parser.set_defaults(default_payload=cache / "knowledge-upload-payload.json")
    return parser.parse_args()


def _bailian_embed(cache_path: Path) -> tuple[EmbedTexts, dict[str, Any]]:
    spec = EmbeddingSpec()
    embed_batch = bailian_embedder(spec, api_key_from_environment())
    return (
        lambda texts: embed_texts(texts, spec=spec, embed_batch=embed_batch, cache_path=cache_path),
        spec.metadata(),
    )


def main() -> int:
    args = _parse_args()
    payload_paths = tuple(args.payload or (args.default_payload,))
    options = {
        "index_path": args.index,
        "payload_paths": payload_paths,
        "output_path": args.output,
        "mirror_paths": tuple(args.mirror_output or ()),
    }
    degraded = ""
    try:
        if args.no_embeddings:
            bundle = build_retrieval_bundle(**options)
        else:
            try:
                embed, embedding = _bailian_embed(args.embedding_cache)
                bundle = build_retrieval_bundle(**options, embed=embed, embedding=embedding)
            except EmbeddingError as error:
                degraded = str(error)
                bundle = build_retrieval_bundle(**options)
    except RetrievalBundleError as error:
        print(f"检索数据包生成失败：{error}")
        return 1
    print(f"检索数据包已生成：{bundle['documentCount']} 条，跳过 {bundle['skippedCount']} 条")
    if degraded:
        print(f"向量生成失败，已降级为仅关键词检索：{degraded}")
        return EXIT_DEGRADED
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
