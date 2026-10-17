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
TOP_LIMIT = 10

DWS_COMMANDS: Mapping[str, tuple[str, ...]] = {
    "agenda": ("calendar", "+week"),
    "todos": ("todo", "+get-related-tasks"),
    "groups": ("chat", "+my-groups", "--page-all", "--page-limit", "20"),
    "mentions": ("chat", "+at-me", "--days", "14", "--page-all", "--page-limit", "10",
                 "--max-items", "300", "--no-reactions"),
    "unread": ("chat", "+unread-chats"),
}
KUNPENG_SUBCOMMANDS = frozenset({"customers", "projects", "overview", "top", "mygroups"})
KUNPENG_SKILL_DIR = Path.home() / ".qwenworkcn" / "skills" / "kunpeng-ecid-mcp"
KUNPENG_UV = Path.home() / ".local" / "bin" / "uv"
PROJECT_CATES = {1: "公有云", 2: "混合云", 5: "国际"}
MENTION_TEXT_LIMIT = 140
SECTIONS = ("agenda", "todos", "groups", "mentions", "unread",
            "customers", "projects", "overview", "top", "mygroups")


class SourceError(RuntimeError):
    """A data source failed; ``status`` is a browser-safe classification."""

    def __init__(self, status: str, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


CommandRunner = Callable[[tuple[str, ...]], Mapping[str, Any]]
# ``mygroups`` answers with a top-level JSON array, so the 鲲鹏 runner may return any JSON value
# and every fetch validates the shape it needs.
KunpengRunner = Callable[[tuple[str, ...]], Any]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _json_any(stdout: str) -> Any:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as error:
        raise SourceError("error", "invalid_json") from error


def _parse_json(stdout: str) -> Mapping[str, Any]:
    payload = _json_any(stdout)
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
    # Some chat subcommands exit non-zero while still printing a usable payload:
    # `chat +my-groups` reports pagination gaps as exit 1 with complete:false.
    # A payload carrying an error envelope still takes the failure path.
    try:
        payload = _parse_json(completed.stdout)
    except SourceError:
        payload = None
    if payload is not None and not isinstance(payload.get("error"), Mapping):
        return payload
    raise SourceError("error", _dws_error_code(completed.stdout, completed.stderr) or f"dws_exit_{completed.returncode}")


def run_kunpeng(arguments: Sequence[str]) -> Any:
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
    return _json_any(completed.stdout)


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


def fetch_groups(dws: CommandRunner) -> SectionResult:
    """钉钉群列表；分页无法证明完整时 dws 以 exit 1 + ``complete:false`` 返回全部已抓到的群。

    Such a run must surface as ``partial`` so the UI marks the group↔customer
    matching as based on an incomplete list.
    """
    payload = dws(DWS_COMMANDS["groups"])
    items = [
        {"id": _text(group.get("conversationId")),
         "name": _text(group.get("name")) or "（未命名群）",
         "type": _text(group.get("type")),
         "memberCount": int(_number(group.get("memberCount")) or 0)}
        for group in _mappings(_list(payload, "groups"))
    ]
    return SectionResult(items, payload.get("complete") is not False)


def fetch_mentions(dws: CommandRunner) -> SectionResult:
    """@我 的消息。只保留定位与展示所需字段，正文截断到 ``MENTION_TEXT_LIMIT``。"""
    payload = dws(DWS_COMMANDS["mentions"])
    items: list[dict[str, Any]] = []
    for mention in _mappings(_list(payload, "items")):
        message_id = _text(mention.get("messageId"))
        if not message_id:
            continue
        conversation = mention.get("conversation") if isinstance(mention.get("conversation"), Mapping) else {}
        items.append({
            "id": message_id,
            "conversationId": _text(mention.get("conversationId")),
            "conversationName": _text(conversation.get("name")),
            "sender": _text(mention.get("sender")),
            "text": _text(mention.get("text"), MENTION_TEXT_LIMIT) or "",
            "time": _text(mention.get("time")),
        })
    complete = payload.get("complete") is not False and payload.get("truncated") is not True
    return SectionResult(items, complete)


def fetch_unread(dws: CommandRunner) -> SectionResult:
    """未读会话。``+unread-chats`` 只返回 id 与名称，两者都保留（名称是展示所必需的）。"""
    payload = dws(DWS_COMMANDS["unread"])
    items = [
        {"id": _text(conversation.get("conversationId")),
         "name": _text(conversation.get("name"))}
        for conversation in _mappings(_list(payload, "conversations"))
    ]
    return SectionResult([item for item in items if item["id"]])


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
        # 鲲鹏 customers 响应自带的昨日环比涨跌额（元）；旧快照无此字段，前端按 rate 反推并标「推算值」。
        "yesterdayGaapDiff": _number(row.get("extGaapDDiff")),
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


def _paged_rows(kunpeng: KunpengRunner, base: tuple[str, ...], size: int, max_pages: int) -> tuple[list[Mapping[str, Any]], bool, Any]:
    rows: list[Mapping[str, Any]] = []
    total: Any = None
    for page in range(1, max_pages + 1):
        payload = kunpeng((*base, "--size", str(size), "--page", str(page)))
        if not isinstance(payload, Mapping):
            raise SourceError("error", "unexpected_shape")
        if payload.get("success") is False:
            raise SourceError("error", "kunpeng_not_success")
        batch = _mappings(_list(payload, "rows"))
        rows = [*rows, *batch]
        total = payload.get("total")
        total_number = _number(total)
        if len(batch) < size or (total_number is not None and len(rows) >= total_number):
            return rows, True, total
    return rows, False, total


def fetch_customers(kunpeng: KunpengRunner) -> SectionResult:
    rows, complete, total = _paged_rows(kunpeng, ("customers",), CUSTOMER_PAGE_SIZE, CUSTOMER_MAX_PAGES)
    items = [item for item in (_project_customer(row) for row in rows) if item]
    return SectionResult(items, complete, {"total": total})


def fetch_projects(kunpeng: KunpengRunner) -> SectionResult:
    rows, complete, total = _paged_rows(kunpeng, ("projects", "--state", "normal"), PROJECT_PAGE_SIZE, PROJECT_MAX_PAGES)
    return SectionResult([_project_row(row) for row in rows], complete, {"total": total})


def fetch_overview(kunpeng: KunpengRunner) -> SectionResult:
    """鲲鹏「我的客户」总览指标（支付口径在 metric.category 中标注）。

    The endpoint returns a metric catalog plus ``values``; each value carries the real
    number in ``data`` (the ``value`` field mirrors the metric id). Metrics without a
    ``data`` value (e.g. 混合云环比 when there is no baseline) are skipped instead of
    surfacing a misleading number.
    """
    payload = kunpeng(("overview",))
    if not isinstance(payload, Mapping):
        raise SourceError("error", "unexpected_shape")
    items: list[dict[str, Any]] = []
    for metric in _mappings(payload.get("values") or []):
        value = _number(metric.get("data"))
        label = _text(metric.get("label"))
        if value is None or label is None:
            continue
        items.append({
            "id": _text(metric.get("id")),
            "label": label,
            "value": value,
            "unit": _text(metric.get("unitName")),
            "category": _text(metric.get("categoryCodeName")),
        })
    return SectionResult(items)


def fetch_top(kunpeng: KunpengRunner) -> SectionResult:
    """客户 TOP 榜；``checks`` 是鲲鹏自带的顺序/条数自检，必须原样带到前端告警。"""
    payload = kunpeng(("top", "--limit", str(TOP_LIMIT), "--metric", "last_month_gaap"))
    if not isinstance(payload, Mapping):
        raise SourceError("error", "unexpected_shape")
    checks_raw = payload.get("checks") if isinstance(payload.get("checks"), Mapping) else {}
    checks = {
        "gaapMonotonicDesc": checks_raw.get("gaapMonotonicDesc") is True,
        "countWithinLimit": checks_raw.get("countWithinLimit") is True,
    }
    items = [
        {
            "rank": int(_number(row.get("rank")) or 0),
            "cid": _text(row.get("cid")),
            "name": _text(row.get("name")) or _text(row.get("cid")) or "（未命名客户）",
            "industry": _text(row.get("industry")),
            "area": _text(row.get("area")),
            "level": _text(row.get("gcLevel")),
            "lastMonthGaap": _number(row.get("lastMonthGaap")),
            "yesterdayGaap": _number(row.get("yesterdayGaap")),
        }
        for row in _mappings(_list(payload, "items"))
    ]
    return SectionResult(items, True, {
        "total": payload.get("total"),
        "metric": _text(payload.get("metric")),
        "orderBy": _text(payload.get("orderBy")),
        "queriedAt": _text(payload.get("queriedAt")),
        "checks": checks,
    })


def fetch_mygroups(kunpeng: KunpengRunner) -> SectionResult:
    """「我的客户」分组视图及各自 cidCount；分层卡片只用这里的计数（--view-id 行过滤当前不生效）。"""
    payload = kunpeng(("mygroups",))
    if not isinstance(payload, list):
        raise SourceError("error", "unexpected_shape")
    items: list[dict[str, Any]] = []
    for group in _mappings(payload):
        for view in _mappings(group.get("views") or []):
            items.append({
                "id": _text(view.get("id")),
                "name": _text(view.get("name")) or _text(view.get("id")) or "（未命名视图）",
                "group": _text(group.get("name")),
                "count": int(_number(view.get("cidCount")) or 0),
            })
    return SectionResult(items)


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
    kunpeng: KunpengRunner = run_kunpeng,
    now: Callable[[], str] = _utc_now,
) -> dict[str, Any]:
    previous = _load_previous(output_path)
    timestamp = now()
    fetchers: Mapping[str, Callable[[], SectionResult]] = {
        "agenda": lambda: fetch_agenda(dws),
        "todos": lambda: fetch_todos(dws),
        "groups": lambda: fetch_groups(dws),
        "mentions": lambda: fetch_mentions(dws),
        "unread": lambda: fetch_unread(dws),
        "customers": lambda: fetch_customers(kunpeng),
        "projects": lambda: fetch_projects(kunpeng),
        "overview": lambda: fetch_overview(kunpeng),
        "top": lambda: fetch_top(kunpeng),
        "mygroups": lambda: fetch_mygroups(kunpeng),
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
