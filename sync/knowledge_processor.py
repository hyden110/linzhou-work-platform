#!/usr/bin/env python3
"""Build private processing state and a bounded local upload payload."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

try:
    from .content_extractors import ExtractionResult, extract_content
    from .passages import select_passages, summary_text
except ImportError:
    from content_extractors import ExtractionResult, extract_content
    from passages import select_passages, summary_text

SCHEMA_VERSION = 2
PROCESSOR_VERSION = "passages-v3"
MAX_SUMMARY_CHARACTERS = 500
MAX_CITATION_CHARACTERS = 300
MAX_CITATIONS = 12
MAX_WINDOWS_PER_SEGMENT = 2
MAX_EXTRACTED_CHARACTERS = 200_000
MAX_ERROR_MESSAGE_CHARACTERS = 200
HOME_PLACEHOLDER = "<HOME>"


class InputValidationError(ValueError):
    """Raised when the local index does not satisfy the processor contract."""


@dataclass(frozen=True)
class _Root:
    source_id: str
    path: Path


@dataclass(frozen=True)
class _Document:
    document_id: Optional[str]
    source_id: str
    relative_path: str
    fingerprint: Mapping[str, Any]
    path: Path


def _mapping(value: object, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise InputValidationError(f"{location} must be an object")
    return value


def _sequence(value: object, location: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise InputValidationError(f"{location} must be an array")
    return value


def _required_string(container: Mapping[str, Any], field: str, location: str) -> str:
    value = container.get(field)
    if not isinstance(value, str) or not value.strip():
        raise InputValidationError(f"{location}.{field} must be a non-empty string")
    return value


def _optional_string(container: Mapping[str, Any], field: str, location: str) -> Optional[str]:
    value = container.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise InputValidationError(f"{location}.{field} must be a non-empty string when present")
    return value


def _load_input(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise InputValidationError(f"unable to read index ({type(error).__name__})") from error
    except json.JSONDecodeError as error:
        raise InputValidationError("index must contain valid JSON") from error
    return _mapping(value, "index")


def _validated_roots(value: object) -> dict[str, _Root]:
    roots: dict[str, _Root] = {}
    for position, item in enumerate(_sequence(value, "index.roots")):
        location = f"index.roots[{position}]"
        source = _mapping(item, location)
        source_id = _required_string(source, "id", location)
        absolute_path = Path(_required_string(source, "absolutePath", location))
        if not absolute_path.is_absolute():
            raise InputValidationError(f"{location}.absolutePath must be absolute")
        if source_id in roots:
            raise InputValidationError(f"duplicate root id: {source_id}")
        roots = {**roots, source_id: _Root(source_id, absolute_path.resolve())}
    return roots


def _validated_fingerprint(value: object, location: str) -> dict[str, Any]:
    fingerprint = _mapping(value, f"{location}.fingerprint")
    if not fingerprint or not all(isinstance(key, str) for key in fingerprint):
        raise InputValidationError(f"{location}.fingerprint must be a non-empty JSON object")
    try:
        return json.loads(json.dumps(fingerprint, ensure_ascii=False))
    except (TypeError, ValueError) as error:
        raise InputValidationError(f"{location}.fingerprint must contain JSON values") from error


def _source_path(root: _Root, relative_path: str, location: str) -> Path:
    relative = Path(relative_path)
    if relative_path in ("", ".") or relative.is_absolute() or ".." in relative.parts:
        raise InputValidationError(f"{location}.relativePath must stay within its source root")
    candidate = (root.path / relative).resolve()
    try:
        candidate.relative_to(root.path)
    except ValueError as error:
        raise InputValidationError(f"{location}.relativePath must stay within its source root") from error
    return candidate


def _validated_documents(value: object, roots: Mapping[str, _Root]) -> tuple[_Document, ...]:
    documents = []
    seen = set()
    for position, item in enumerate(_sequence(value, "index.documents")):
        location = f"index.documents[{position}]"
        source = _mapping(item, location)
        source_id = _required_string(source, "source", location)
        if source_id not in roots:
            raise InputValidationError(f"{location}.source does not match a root")
        relative_path = _required_string(source, "relativePath", location)
        key = (source_id, relative_path)
        if key in seen:
            raise InputValidationError(f"duplicate document: {source_id}:{relative_path}")
        seen = {*seen, key}
        documents.append(
            _Document(
                document_id=_optional_string(source, "id", location),
                source_id=source_id,
                relative_path=relative_path,
                fingerprint=_validated_fingerprint(source.get("fingerprint"), location),
                path=_source_path(roots[source_id], relative_path, location),
            )
        )
    return tuple(documents)


def _read_index(path: Path) -> tuple[_Document, ...]:
    index = _load_input(path)
    roots = _validated_roots(index.get("roots"))
    return _validated_documents(index.get("documents"), roots)


def _load_previous_state(path: Path) -> Mapping[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _previous_by_key(state: Mapping[str, Any]) -> dict[tuple[str, str], Mapping[str, Any]]:
    documents = state.get("documents", [])
    if not isinstance(documents, list):
        return {}
    return {
        (item["source"], item["relativePath"]): item
        for item in documents
        if isinstance(item, dict)
        and isinstance(item.get("source"), str)
        and isinstance(item.get("relativePath"), str)
    }


def _redact_home_paths(text: str) -> str:
    home = str(Path.home()).rstrip("/")
    redacted = text.replace(home, HOME_PLACEHOLDER) if home else text
    return redacted.replace("~/", f"{HOME_PLACEHOLDER}/")


def _bounded_text(value: object, limit: int) -> str:
    text = str(value or "").encode("utf-16", errors="surrogatepass").decode("utf-16", errors="replace")
    return _redact_home_paths(text).replace("\x00", "").strip()[:limit]


def _clean_locator(value: object) -> Optional[dict[str, str]]:
    if not isinstance(value, Mapping):
        return None
    kind = _bounded_text(value.get("kind"), MAX_CITATION_CHARACTERS)
    locator_value = _bounded_text(value.get("value"), MAX_CITATION_CHARACTERS)
    return {"kind": kind, "value": locator_value} if kind and locator_value else None


def _clean_cached_result(value: object) -> Optional[dict[str, Any]]:
    if not isinstance(value, Mapping) or value.get("status") != "processed":
        return None
    citations = []
    source_citations = value.get("citations", [])
    if not isinstance(source_citations, list):
        return None
    for item in source_citations[:MAX_CITATIONS]:
        if not isinstance(item, Mapping):
            continue
        locator = _clean_locator(item.get("locator"))
        text = _bounded_text(item.get("text"), MAX_CITATION_CHARACTERS)
        if locator and text:
            citations.append({"locator": locator, "text": text})
    return {
        "status": "processed",
        "title": _bounded_text(value.get("title"), MAX_SUMMARY_CHARACTERS),
        "summary": _bounded_text(value.get("summary"), MAX_SUMMARY_CHARACTERS),
        "citations": citations,
        "truncated": bool(value.get("truncated", False)),
    }


def _reusable_result(previous: Optional[Mapping[str, Any]], document: _Document) -> Optional[dict[str, Any]]:
    if not previous or previous.get("fingerprint") != document.fingerprint:
        return None
    if previous.get("processorVersion") != PROCESSOR_VERSION:
        return None
    return _clean_cached_result(previous.get("result"))


def _summary(result: ExtractionResult) -> str:
    return _bounded_text(summary_text(result.segments, MAX_SUMMARY_CHARACTERS), MAX_SUMMARY_CHARACTERS)


def _citations(result: ExtractionResult) -> list[dict[str, Any]]:
    passages = select_passages(
        result.segments,
        max_passages=MAX_CITATIONS,
        max_characters=MAX_CITATION_CHARACTERS,
        max_windows_per_section=MAX_WINDOWS_PER_SEGMENT,
    )
    citations = []
    for passage in passages:
        text = _bounded_text(passage.text, MAX_CITATION_CHARACTERS)
        kind = _bounded_text(passage.locator_kind, MAX_CITATION_CHARACTERS)
        value = _bounded_text(passage.locator, MAX_CITATION_CHARACTERS)
        if text and kind and value:
            citations.append({"locator": {"kind": kind, "value": value}, "text": text})
    return citations


def _error_result(code: object, message: object) -> dict[str, Any]:
    return {
        "status": "error",
        "errorCode": _bounded_text(code, MAX_ERROR_MESSAGE_CHARACTERS) or "processing_error",
        "errorMessage": _bounded_text(message, MAX_ERROR_MESSAGE_CHARACTERS) or "Content processing failed.",
    }


def _process_document(document: _Document) -> dict[str, Any]:
    try:
        extraction = extract_content(document.path, max_total_characters=MAX_EXTRACTED_CHARACTERS)
        if extraction.status != "extracted":
            return _error_result(extraction.error_code, extraction.error_message)
        return {
            "status": "processed",
            "title": _bounded_text(extraction.title, MAX_SUMMARY_CHARACTERS),
            "summary": _summary(extraction),
            "citations": _citations(extraction),
            "truncated": bool(extraction.truncated),
        }
    except Exception as error:
        return _error_result("processing_exception", f"Content processing failed ({type(error).__name__}).")


def _private_document(document: _Document, result: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": document.document_id,
        "source": document.source_id,
        "relativePath": document.relative_path,
        "fingerprint": dict(document.fingerprint),
        "processorVersion": PROCESSOR_VERSION,
        "result": dict(result),
    }


def _upload_document(document: _Document, result: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": document.document_id,
        "source": document.source_id,
        "relativePath": document.relative_path,
        "title": result["title"],
        "summary": result["summary"],
        "citations": list(result["citations"]),
    }


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            json.dump(payload, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)


def _validate_output_paths(index_path: Path, state_path: Path, payload_path: Path) -> None:
    paths = (index_path.resolve(), state_path.resolve(), payload_path.resolve())
    if len(set(paths)) != len(paths):
        raise InputValidationError("index, state, and payload paths must be distinct")


def process_knowledge_index(*, index_path: Path, state_path: Path, payload_path: Path) -> dict[str, Any]:
    """Process an index locally; this function performs no network operations."""

    _validate_output_paths(index_path, state_path, payload_path)
    documents = _read_index(index_path)
    previous = _previous_by_key(_load_previous_state(state_path))
    private_documents = []
    upload_documents = []
    processed = reused = failed = 0

    for document in documents:
        cached = _reusable_result(previous.get((document.source_id, document.relative_path)), document)
        result = cached or _process_document(document)
        private_documents.append(_private_document(document, result))
        if result["status"] == "processed":
            upload_documents.append(_upload_document(document, result))
            if cached:
                reused += 1
            else:
                processed += 1
        else:
            failed += 1

    summary = {"processed": processed, "reused": reused, "failed": failed}
    private_state = {
        "schemaVersion": SCHEMA_VERSION,
        "documents": private_documents,
        "summary": summary,
    }
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "mode": "local-knowledge-upload-payload",
        "documents": upload_documents,
        "summary": summary,
    }
    _atomic_write_json(state_path, private_state)
    _atomic_write_json(payload_path, payload)
    return payload


def _parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    cache = project_root / ".local-cache"
    parser = argparse.ArgumentParser(description="在本地提取知识摘要和有限引用片段")
    parser.add_argument("--index", type=Path, default=cache / "local-index-state.json")
    parser.add_argument("--state", type=Path, default=cache / "knowledge-processing-state.json")
    parser.add_argument("--payload", type=Path, default=cache / "knowledge-upload-payload.json")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    payload = process_knowledge_index(
        index_path=args.index,
        state_path=args.state,
        payload_path=args.payload,
    )
    summary = payload["summary"]
    print(
        f"本地知识处理完成：处理 {summary['processed']}，"
        f"复用 {summary['reused']}，失败 {summary['failed']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
