#!/usr/bin/env python3
"""Read-only CRM snapshot: DingTalk agenda/todos plus Kunpeng customers/projects.

Every external call is an allow-listed, shell-free subprocess. Only projected fields are
written to the local snapshot; raw responses, cookies and tokens never leave the CLIs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

try:
    from .local_indexer import atomic_write_json
except ImportError:
    from local_indexer import atomic_write_json

SCHEMA_VERSION = 1
CUSTOMER_PAGE_SIZE = 200
CUSTOMER_MAX_PAGES = 10
PROJECT_PAGE_SIZE = 100
PROJECT_MAX_PAGES = 5

DWS_COMMANDS: Mapping[str, tuple[str, ...]] = {
    "agenda": ("calendar", "+week"),
    "todos": ("todo", "+get-related-tasks"),
}
KUNPENG_SUBCOMMANDS = frozenset({"customers", "projects"})
KUNPENG_SKILL_DIR = Path.home() / ".qwenworkcn" / "skills" / "kunpeng-ecid-mcp"
KUNPENG_UV = Path.home() / ".local" / "bin" / "uv"
PROJECT_CATES = {1: "公有云", 2: "混合云", 5: "国际"}
SECTIONS = ("agenda", "todos", "customers", "projects")


class SourceError(RuntimeError):
    """A data source failed; ``status`` is a browser-safe classification."""

    def __init__(self, status: str, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


CommandRunner = Callable[[tuple[str, ...]], Mapping[str, Any]]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_json(stdout: str) -> Mapping[str, Any]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise SourceError("error", "invalid_json") from error
    if not isinstance(payload, Mapping):
        raise SourceError("error", "invalid_json")
    return payload


def _dws_error_code(*sources: str) -> str | None:
    """Keep the upstream reason (e.g. RATE_LIMIT_ERROR) as the browser-safe code.

    dws may put its error envelope on either stream, so both are inspected.
    """
    for source in sources:
        try:
            envelope = json.loads(source)
        except json.JSONDecodeError:
            continue
        if not isinstance(envelope, Mapping):
            continue
        error = envelope.get("error")
        if not isinstance(error, Mapping):
            continue
        reason = _text(error.get("upstream_code")) or _text(error.get("reason"))
        if reason:
            return f"dws_{reason.lower()}"
    return None


def run_dws(arguments: Sequence[str]) -> Mapping[str, Any]:
    command = tuple(arguments)
    if command not in DWS_COMMANDS.values():
        raise SourceError("error", "command_not_allowed")
    executable = shutil.which("dws")
    if not executable:
        raise SourceError("error", "dws_missing")
    completed = subprocess.run(
        [executable, *command, "--format", "json"],
        check=False, capture_output=True, text=True, timeout=180, shell=False,
    )
    if completed.returncode == 0:
        return _parse_json(completed.stdout)
    raise SourceError("error", _dws_error_code(completed.stdout, completed.stderr) or f"dws_exit_{completed.returncode}")


def run_kunpeng(arguments: Sequence[str]) -> Mapping[str, Any]:
    command = tuple(arguments)
    if not command or command[0] not in KUNPENG_SUBCOMMANDS:
        raise SourceError("error", "command_not_allowed")
    if any(not re.fullmatch(r"[A-Za-z0-9_,\-]+", item) for item in command):
        raise SourceError("error", "command_not_allowed")
    if not KUNPENG_UV.exists() or not (KUNPENG_SKILL_DIR / "kunpeng_ecid.py").exists():
        raise SourceError("error", "kunpeng_missing")
    completed = subprocess.run(
        [str(KUNPENG_UV), "run", "kunpeng_ecid.py", *command],
        cwd=KUNPENG_SKILL_DIR, check=False, capture_output=True, text=True,
        timeout=180, shell=False,
    )
    if completed.returncode == 2:
        raise SourceError("auth_required", "kunpeng_login_required")
    if completed.returncode != 0:
        raise SourceError("error", f"kunpeng_exit_{completed.returncode}")
    return _parse_json(completed.stdout)


# ---------------------------------------------------------------------------
# Projection helpers
# ---------------------------------------------------------------------------
def _text(value: Any, limit: int = 200) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, Mapping):
        for key in ("name", "label", "text", "value", "zhName"):
            if value.get(key) not in (None, ""):
                return _text(value.get(key), limit)
        return None
    if isinstance(value, (list, tuple)):
        parts = [part for part in (_text(item, limit) for item in value) if part]
        return "/".join(parts)[:limit] or None
    text = str(value).strip()
    return text[:limit] or None


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, Mapping):
        return _number(value.get("value"))
    cleaned = str(value).replace(",", "").replace("¥", "").replace("%", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def _list(payload: Mapping[str, Any], *path: str) -> list[Any]:
    current: Any = payload
    for key in path:
        current = current.get(key) if isinstance(current, Mapping) else None
    if not isinstance(current, list):
        raise SourceError("error", "unexpected_shape")
    return current


def _mappings(items: Sequence[Any]) -> list[Mapping[str, Any]]:
    return [item for item in items if isinstance(item, Mapping)]


def _utc_iso(value: Any) -> str | None:
    """鲲鹏 returns epoch millis; the browser formats an explicit UTC instant."""
    number = _number(value)
    if number is None:
        return None
    try:
        return datetime.fromtimestamp(number / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (OverflowError, OSError, ValueError):
        return None


def _percent(value: Any) -> float | None:
    """``extGaapDRate`` is a decimal ratio (-0.41 == -41%); the UI renders percents."""
    number = _number(value)
    return None if number is None else round(number * 100, 2)


def _enum_percent(value: Any) -> float | None:
    """``winRate`` arrives as ``PROJECT_WINRATE_50``."""
    number = _number(value)
    if number is not None:
        return number
    text = _text(value) or ""
    match = re.search(r"(\d+(?:\.\d+)?)\s*$", text)
    return float(match.group(1)) if match else None


@dataclass(frozen=True)
class SectionResult:
    items: list[Any]
    complete: bool = True
    meta: Mapping[str, Any] = field(default_factory=dict)


def _require_success(payload: Mapping[str, Any]) -> None:
    if not (payload.get("ok") is True and payload.get("outcome") == "success"):
        raise SourceError("error", "dws_not_success")


def fetch_agenda(dws: CommandRunner) -> SectionResult:
    payload = dws(DWS_COMMANDS["agenda"])
    _require_success(payload)
    items = [
        {"id": _text(e.get("eventId")), "title": _text(e.get("title")) or "（无标题）",
         "start": _text(e.get("start")), "end": _text(e.get("end"))}
        for e in _mappings(_list(payload, "data", "events"))
    ]
    data = payload.get("data") if isinstance(payload.get("data"), Mapping) else {}
    return SectionResult(items, data.get("complete") is not False)


def fetch_todos(dws: CommandRunner) -> SectionResult:
    payload = dws(DWS_COMMANDS["todos"])
    _require_success(payload)
    items = [
        {"id": _text(t.get("taskId")), "title": _text(t.get("title")) or "（无标题）",
         "priority": int(_number(t.get("priority")) or 0),
         "dueAt": int(_number(t.get("planFinishDate")) or 0) or None}
        for t in _mappings(_list(payload, "data", "tasks"))
    ]
    return SectionResult(items)


def _project_customer(row: Mapping[str, Any]) -> dict[str, Any] | None:
    cid = _text(row.get("cid"))
    if not cid:
        return None
    return {
        "cid": cid,
        "name": _text(row.get("name")) or cid,
        "industry": _text(row.get("bizCategoryInfo")),
        "area": _text(row.get("areaInfo")),
        "level": _text(row.get("extGcLevel")),
        "formal": _text(row.get("isFormal")),
        "opportunity": _text(row.get("oppCategory")),
        "lastMonthGaap": _number(row.get("extLastMonthGaap")),
        "yesterdayGaap": _number(row.get("extGaapD")),
        "yesterdayGaapRate": _percent(row.get("extGaapDRate")),
        "lastNoteAt": _text(row.get("extLastNoteDate")),
        "relatedAt": _text(row.get("gmtRelateDate")),
    }


def _project_id_and_name(value: Any) -> tuple[str | None, str | None]:
    if isinstance(value, Mapping):
        return _text(value.get("id") or value.get("projectId")), _text(value.get("name") or value.get("projectName"))
    text = _text(value)
    if not text:
        return None, None
    match = re.search(r"[(（]\s*([A-Za-z0-9_-]+)\s*[)）]\s*$", text)
    return (match.group(1), text[: match.start()].strip()) if match else (None, text)


def _project_row(row: Mapping[str, Any]) -> dict[str, Any]:
    combined_id, combined_name = _project_id_and_name(row.get("projectNameAndId"))
    project_id = _text(row.get("projectId")) or combined_id
    name = _text(row.get("projectName")) or combined_name
    cate = _number(row.get("projectCate"))
    return {
        "id": project_id or name,
        "name": name or "（未命名项目）",
        "customerName": _text(row.get("customerName")),
        "cid": _text(row.get("cid")),
        "stage": _text(row.get("projectStage")),
        "stageName": _text(row.get("projectStageNameCn")) or _text(row.get("projectStageNameEn")),
        "price": _number(row.get("projectPrice")),
        "cate": PROJECT_CATES.get(int(cate)) if cate is not None else _text(row.get("projectCate")),
        "state": _text(row.get("projectStatus")),
        "winRate": _enum_percent(row.get("winRate")),
        "expectedContractDate": _utc_iso(row.get("expectedContractDate")),
        "expectedGaapStartDate": _utc_iso(row.get("expectedGaapStartDate")),
        "createdAt": _utc_iso(row.get("gmtCreate")),
    }


def _paged_rows(kunpeng: CommandRunner, base: tuple[str, ...], size: int, max_pages: int) -> tuple[list[Mapping[str, Any]], bool, Any]:
    rows: list[Mapping[str, Any]] = []
    total: Any = None
    for page in range(1, max_pages + 1):
        payload = kunpeng((*base, "--size", str(size), "--page", str(page)))
        if payload.get("success") is False:
            raise SourceError("error", "kunpeng_not_success")
        batch = _mappings(_list(payload, "rows"))
        rows = [*rows, *batch]
        total = payload.get("total")
        total_number = _number(total)
        if len(batch) < size or (total_number is not None and len(rows) >= total_number):
            return rows, True, total
    return rows, False, total


def fetch_customers(kunpeng: CommandRunner) -> SectionResult:
    rows, complete, total = _paged_rows(kunpeng, ("customers",), CUSTOMER_PAGE_SIZE, CUSTOMER_MAX_PAGES)
    items = [item for item in (_project_customer(row) for row in rows) if item]
    return SectionResult(items, complete, {"total": total})


def fetch_projects(kunpeng: CommandRunner) -> SectionResult:
    rows, complete, total = _paged_rows(kunpeng, ("projects", "--state", "normal"), PROJECT_PAGE_SIZE, PROJECT_MAX_PAGES)
    return SectionResult([_project_row(row) for row in rows], complete, {"total": total})


# ---------------------------------------------------------------------------
# Snapshot assembly
# ---------------------------------------------------------------------------
def _load_previous(path: Path) -> Mapping[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, Mapping) and payload.get("schemaVersion") == SCHEMA_VERSION else {}


def _section(
    name: str, fetch: Callable[[], SectionResult], previous: Mapping[str, Any], now: str
) -> tuple[list[Any], dict[str, Any]]:
    old_sources = previous.get("sources") if isinstance(previous.get("sources"), Mapping) else {}
    old_source = old_sources.get(name) if isinstance(old_sources.get(name), Mapping) else {}
    old_items = previous.get(name) if isinstance(previous.get(name), list) else []
    try:
        result = fetch()
    except SourceError as error:
        return old_items, {
            "status": error.status, "error": error.code, "fetchedAt": now,
            "lastSuccessAt": old_source.get("lastSuccessAt"), "count": len(old_items),
            "complete": False, "stale": bool(old_items),
        }
    except (OSError, subprocess.TimeoutExpired) as error:
        return old_items, {
            "status": "error", "error": type(error).__name__, "fetchedAt": now,
            "lastSuccessAt": old_source.get("lastSuccessAt"), "count": len(old_items),
            "complete": False, "stale": bool(old_items),
        }
    return result.items, {
        "status": "ok" if result.complete else "partial", "error": None, "fetchedAt": now,
        "lastSuccessAt": now, "count": len(result.items), "complete": result.complete,
        "stale": False, **dict(result.meta),
    }


def build_snapshot(
    *,
    output_path: Path,
    dws: CommandRunner = run_dws,
    kunpeng: CommandRunner = run_kunpeng,
    now: Callable[[], str] = _utc_now,
) -> dict[str, Any]:
    previous = _load_previous(output_path)
    timestamp = now()
    fetchers: Mapping[str, Callable[[], SectionResult]] = {
        "agenda": lambda: fetch_agenda(dws),
        "todos": lambda: fetch_todos(dws),
        "customers": lambda: fetch_customers(kunpeng),
        "projects": lambda: fetch_projects(kunpeng),
    }
    results = {name: _section(name, fetchers[name], previous, timestamp) for name in SECTIONS}
    snapshot = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": timestamp,
        "readOnly": True,
        "sources": {name: results[name][1] for name in SECTIONS},
        **{name: results[name][0] for name in SECTIONS},
    }
    atomic_write_json(output_path, snapshot)
    return snapshot


def _parse_args() -> argparse.Namespace:
    cache = Path(__file__).resolve().parents[1] / ".local-cache"
    parser = argparse.ArgumentParser(description="只读刷新本地 CRM 快照（钉钉 + 鲲鹏）")
    parser.add_argument("--output", type=Path, default=cache / "crm-snapshot.json")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    snapshot = build_snapshot(output_path=args.output)
    summary = {name: {k: source[k] for k in ("status", "count", "error")} for name, source in snapshot["sources"].items()}
    print(json.dumps({"generatedAt": snapshot["generatedAt"], "sources": summary}, ensure_ascii=False))
    return 0 if any(source["status"] == "ok" for source in snapshot["sources"].values()) else 1


if __name__ == "__main__":
    os.umask(0o077)
    raise SystemExit(main())
