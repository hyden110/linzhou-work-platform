#!/usr/bin/env python3
"""Build an incremental metadata-only index for the local SA knowledge library."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from . import taxonomy
except ImportError:
    import taxonomy

ALLOWED_EXTENSIONS = frozenset({".ppt", ".pptx", ".pdf", ".md", ".doc", ".docx", ".xls", ".xlsx"})
EXCLUDED_DIRECTORIES = frozenset(
    {
        ".cache",
        ".git",
        ".idea",
        ".qmind_import",
        ".svn",
        ".vscode",
        "__pycache__",
        "build",
        "cache",
        "coverage",
        "dist",
        "node_modules",
        "temp",
        "tmp",
        "vendor",
        "venv",
    }
)
TEMPORARY_PREFIXES = ("~$", ".~lock.")
TOPIC_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("AI 与智能体", ("ai", "agent", "智能体", "大模型", "百炼", "通义", "qwen", "aigc")),
    ("制造与工业", ("制造", "工业", "海尔", "海信", "西门子", "三一", "雅迪")),
    ("零售与消费", ("零售", "门店", "快消", "品牌", "商城", "瑞幸", "伊利", "五粮液", "森马")),
    ("医疗健康", ("医疗", "医院", "诊疗", "医生", "医药", "基因", "迪安", "固生堂")),
    ("数据智能", ("数据", "数仓", "湖仓", "数据库", "分析", "中台")),
    ("云与基础设施", ("上云", "云原生", "迁移", "容灾", "网络", "架构", "基础设施")),
    ("安全与治理", ("安全", "合规", "治理", "风控", "隐私")),
    ("开发效能", ("qoder", "coding", "研发", "开发", "devops")),
    ("具身智能", ("具身", "机器人", "多模态")),
    ("客户案例", ("案例", "客户", "实践", "项目")),
)


@dataclass(frozen=True)
class SourceRoot:
    source_id: str
    label: str
    path: Path


DEFAULT_ROOTS = (
    SourceRoot("cases", "案例库", Path("/Users/linzhou/Documents/案例")),
    SourceRoot("scenarios", "场景库", Path("/Users/linzhou/Documents/场景")),
)


def _valid_text(value: str) -> str:
    return value.encode("utf-16", errors="surrogatepass").decode("utf-16", errors="replace")


def _clean_json_text(value: Any) -> Any:
    if isinstance(value, str):
        return _valid_text(value)
    if isinstance(value, Mapping):
        return {
            _valid_text(key) if isinstance(key, str) else key: _clean_json_text(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_clean_json_text(item) for item in value]
    return value


def utc_iso(timestamp: float | None = None) -> str:
    instant = datetime.now(timezone.utc) if timestamp is None else datetime.fromtimestamp(timestamp, timezone.utc)
    return instant.isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_allowed_file(path: Path) -> bool:
    name = path.name
    return (
        not name.startswith(".")
        and not name.startswith(TEMPORARY_PREFIXES)
        and path.suffix.lower() in ALLOWED_EXTENSIONS
    )


def infer_topics(relative_path: str) -> list[str]:
    normalized = relative_path.casefold()
    matched = [topic for topic, terms in TOPIC_RULES if any(term.casefold() in normalized for term in terms)]
    return matched[:3] or ["待整理"]


def document_key(source_id: str, relative_path: str) -> str:
    return f"{_valid_text(source_id)}:{_valid_text(relative_path)}"


def iter_source_files(root: SourceRoot, walk_errors: list[dict[str, str]]) -> list[Path]:
    if not root.path.is_dir():
        walk_errors.append({"source": root.source_id, "relativePath": ".", "stage": "enumerate", "message": "来源目录不可用"})
        return []

    paths: list[Path] = []

    def record_walk_error(error: OSError) -> None:
        relative = Path(error.filename or ".").name
        walk_errors.append({"source": root.source_id, "relativePath": relative, "stage": "enumerate", "message": type(error).__name__})

    for directory, directory_names, file_names in os.walk(root.path, topdown=True, onerror=record_walk_error):
        base = Path(directory)
        directory_names[:] = sorted(
            name
            for name in directory_names
            if not name.startswith(".")
            and name.casefold() not in EXCLUDED_DIRECTORIES
            and not (base / name).is_symlink()
        )
        paths.extend(
            path
            for path in (base / name for name in sorted(file_names))
            if not path.is_symlink() and is_allowed_file(path)
        )
    return paths


def create_document(root: SourceRoot, path: Path, previous: Mapping[str, Any] | None) -> tuple[dict[str, Any], bool]:
    if path.is_symlink():
        raise ValueError("symbolic links are not indexable")
    resolved_root = root.path.resolve()
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError("document path must stay within its source root") from error

    stat = path.stat()
    relative_path = _valid_text(path.relative_to(root.path).as_posix())
    fingerprint = {"mtimeNs": stat.st_mtime_ns, "size": stat.st_size}
    previous_fingerprint = previous.get("fingerprint", {}) if previous else {}
    unchanged = (
        previous is not None
        and previous_fingerprint.get("mtimeNs") == fingerprint["mtimeNs"]
        and previous_fingerprint.get("size") == fingerprint["size"]
        and bool(previous_fingerprint.get("sha256"))
    )
    sha256 = previous_fingerprint["sha256"] if unchanged else sha256_file(path)
    topics = infer_topics(relative_path)
    facets = taxonomy.classify(relative_path, path.stem)
    document = {
        "id": hashlib.sha1(document_key(root.source_id, relative_path).encode("utf-8")).hexdigest()[:16],
        "title": _valid_text(path.stem),
        "source": _valid_text(root.source_id),
        "sourceLabel": _valid_text(root.label),
        "relativePath": relative_path,
        "type": path.suffix[1:].upper(),
        "size": stat.st_size,
        "modifiedAt": utc_iso(stat.st_mtime),
        "topics": topics,
        "solutionTracks": facets["solutionTracks"],
        "customers": facets["customers"],
        "events": facets["events"],
        "status": "indexed",
        "location": "本地文件 · 相对路径",
        "fingerprint": {**fingerprint, "sha256": sha256},
    }
    return document, unchanged


def counter_rows(counter: Counter[str]) -> list[dict[str, Any]]:
    return [{"name": name, "count": count} for name, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))]


def calculate_stats(documents: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    source_counts = Counter(str(document["sourceLabel"]) for document in documents)
    type_counts = Counter(str(document["type"]) for document in documents)
    topic_counts = Counter(topic for document in documents for topic in document["topics"])
    return {
        "totalDocuments": len(documents),
        "totalBytes": sum(int(document["size"]) for document in documents),
        "bySource": counter_rows(source_counts),
        "byType": counter_rows(type_counts),
        "byTopic": counter_rows(topic_counts),
        **taxonomy.all_facet_rows(documents),
    }


def build_index(*, roots: Sequence[SourceRoot], previous_index: Mapping[str, Any]) -> dict[str, Any]:
    previous_documents = {
        document_key(str(item.get("source", "")), str(item.get("relativePath", ""))): item
        for item in previous_index.get("documents", [])
        if item.get("status", "indexed") == "indexed"
    }
    documents: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    added = updated = skipped = 0
    seen_keys: set[str] = set()

    for root in roots:
        for path in iter_source_files(root, errors):
            try:
                relative_path = path.relative_to(root.path).as_posix()
                key = document_key(root.source_id, relative_path)
                previous = previous_documents.get(key)
                document, unchanged = create_document(root, path, previous)
                documents.append(document)
                seen_keys.add(key)
                if unchanged:
                    skipped += 1
                elif previous:
                    updated += 1
                else:
                    added += 1
            except (OSError, ValueError) as error:
                try:
                    relative_path = path.relative_to(root.path).as_posix()
                except ValueError:
                    relative_path = path.name
                errors.append(
                    {
                        "source": _valid_text(root.source_id),
                        "relativePath": _valid_text(relative_path),
                        "stage": "fingerprint",
                        "message": type(error).__name__,
                    }
                )

    documents.sort(key=lambda item: (str(item["relativePath"]).casefold(), str(item["source"])))
    recent_documents = sorted(documents, key=lambda item: str(item["modifiedAt"]), reverse=True)[:12]
    deleted = len(set(previous_documents) - seen_keys)
    stats = calculate_stats(documents)
    return _clean_json_text(
        {
            "schemaVersion": 1,
            "mode": "local-index-preview",
            "label": "本地索引预览",
            "generatedAt": utc_iso(),
            "roots": [
                {
                    "id": _valid_text(root.source_id),
                    "label": _valid_text(root.label),
                    "absolutePath": _valid_text(str(root.path)),
                    "displayMode": "relative",
                }
                for root in roots
            ],
            "allowedExtensions": sorted(extension[1:].upper() for extension in ALLOWED_EXTENSIONS),
            "stats": stats,
            "recentDocuments": recent_documents,
            "documents": documents,
            "syncSummary": {
                "added": added,
                "updated": updated,
                "skipped": skipped,
                "deleted": deleted,
                "failed": len(errors),
            },
            "errors": errors,
        }
    )


PUBLIC_DOCUMENT_FIELDS = (
    "id",
    "title",
    "source",
    "sourceLabel",
    "relativePath",
    "type",
    "size",
    "modifiedAt",
    "topics",
    "solutionTracks",
    "customers",
    "events",
    "status",
    "location",
)


def public_document(document: Mapping[str, Any]) -> dict[str, Any]:
    return {field: document[field] for field in PUBLIC_DOCUMENT_FIELDS if field in document}


def create_public_index(private_index: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": private_index["schemaVersion"],
        "mode": private_index["mode"],
        "label": private_index["label"],
        "generatedAt": private_index["generatedAt"],
        "roots": [
            {"id": root["id"], "label": root["label"]}
            for root in private_index.get("roots", [])
        ],
        "allowedExtensions": list(private_index["allowedExtensions"]),
        "stats": dict(private_index["stats"]),
        "recentDocuments": [
            public_document(document)
            for document in private_index.get("recentDocuments", [])
        ],
        "documents": [
            public_document(document)
            for document in private_index.get("documents", [])
        ],
        "syncSummary": dict(private_index["syncSummary"]),
        "errors": [dict(error) for error in private_index.get("errors", [])],
    }


def load_previous_index(output_path: Path) -> Mapping[str, Any]:
    if not output_path.exists():
        return {}
    try:
        content = json.loads(output_path.read_text(encoding="utf-8"))
        return content if isinstance(content, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def atomic_write_json(output_path: Path, payload: Mapping[str, Any], *, compact: bool = False) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    safe_payload = _clean_json_text(payload)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            if compact:
                json.dump(safe_payload, temporary, ensure_ascii=False, separators=(",", ":"))
            else:
                json.dump(safe_payload, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, output_path)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)


def generate_index(
    *,
    roots: Sequence[SourceRoot],
    output_path: Path,
    state_path: Path | None = None,
) -> dict[str, Any]:
    private_state_path = state_path or output_path.parent / ".local-index-state.json"
    previous_index = load_previous_index(private_state_path)
    private_index = build_index(roots=roots, previous_index=previous_index)
    public_index = create_public_index(private_index)
    atomic_write_json(private_state_path, private_index)
    atomic_write_json(output_path, public_index)
    return public_index


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="生成仅含元数据的本地知识索引")
    parser.add_argument(
        "--output",
        type=Path,
        default=project_root / "public/data/knowledge-index.json",
        help="可展示索引 JSON 输出路径",
    )
    parser.add_argument(
        "--state",
        type=Path,
        default=project_root / ".local-cache/local-index-state.json",
        help="包含路径和指纹的私有增量状态路径",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = generate_index(roots=DEFAULT_ROOTS, output_path=args.output, state_path=args.state)
    summary = result["syncSummary"]
    print(
        "本地索引完成："
        f"总计 {result['stats']['totalDocuments']}，新增 {summary['added']}，"
        f"更新 {summary['updated']}，跳过 {summary['skipped']}，失败 {summary['failed']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
