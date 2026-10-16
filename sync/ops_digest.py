#!/usr/bin/env python3
"""Read-only ops digest: Qoder blog / changelog, QwenWork official announcements
and the 千仔运营助手 single-chat messages.

External fetches stay inside an allow-listed set of hosts; dws stays inside a
read-only chat-messages command with validated flags. Only projected fields are
written to the local digest (0600); raw responses never leave this process.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

try:
    from .local_indexer import atomic_write_json
except ImportError:
    from local_indexer import atomic_write_json

SCHEMA_VERSION = 1
BLOG_URL = "https://qoder.com/zh/blog"
CHANGELOG_URL = "https://qoder.com/zh/changelog"
ANNOUNCE_INDEX_URL = "https://help.aliyun.com/zh/qwenwork/official-announcement/"
ALLOWED_FETCH_HOSTS = frozenset({
    "qoder.com", "www.qoder.com", "qoder.com.cn", "www.qoder.com.cn",
    "help.aliyun.com", "qwenwork.cn", "www.qwenwork.cn",
})
USER_AGENT = "sa-workbench-ops-digest/1.0"
FETCH_TIMEOUT_SECONDS = 20
MAX_FETCH_BYTES = 4 * 1024 * 1024
MAX_ANNOUNCE_DOCS = 20
BLOG_KEEP_PER_ROUND = 40
CHANGELOG_KEEP_PER_ROUND = 60
QIANZAI_BACKFILL_DAYS = 7
QIANZAI_MAX_ITEMS = 200
QIANZAI_PAGE_LIMIT = 100
PER_SOURCE_KEEP = 120
TEXT_LIMIT = 140

SOURCE_TYPES = ("blog", "changelog", "announcement", "qianzai")
SOURCE_LABELS: Mapping[str, str] = {
    "blog": "Qoder 博客",
    "changelog": "Qoder 产品更新",
    "announcement": "千问办公公告",
    "qianzai": "千仔讯息",
}
DWS_BASE = ("chat", "+chat-messages")
DWS_FLAGS: Mapping[str, Callable[[str], bool]] = {
    "--open-dingtalk-id": lambda value: bool(re.fullmatch(r"[A-Za-z0-9]+", value)),
    "--start": lambda value: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", value)),
    "--end": lambda value: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", value)),
    "--order": lambda value: value == "asc",
    "--format": lambda value: value == "json",
    "--page-limit": lambda value: bool(re.fullmatch(r"\d{1,3}", value)) and 1 <= int(value) <= 500,
    "--max-items": lambda value: bool(re.fullmatch(r"\d{1,4}", value)),
}


class SourceError(RuntimeError):
    """A data source failed; ``status`` is a browser-safe classification."""

    def __init__(self, status: str, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


Fetcher = Callable[[str], str]
DwsRunner = Callable[[tuple[str, ...]], Mapping[str, Any]]


def _local_now() -> datetime:
    return datetime.now()


def _utc_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _text(value: Any, limit: int = TEXT_LIMIT) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    return text[:limit] or None


def _first_line(value: Any, limit: int = TEXT_LIMIT) -> str | None:
    text = _text(value, 2000)
    if not text:
        return None
    for line in text.splitlines():
        cleaned = re.sub(r"^[\*\-\s]+", "", line).strip()
        if cleaned:
            return cleaned[:limit]
    return None


def _epoch_ms_iso(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        return datetime.fromtimestamp(value / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (OverflowError, OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Fetch allow-list (qoder.com / qoder.com.cn / help.aliyun.com / qwenwork.cn)
# ---------------------------------------------------------------------------
def _validate_fetch_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise SourceError("error", "host_not_allowed")
    if parsed.hostname not in ALLOWED_FETCH_HOSTS:
        raise SourceError("error", "host_not_allowed")


class _WhitelistRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate every 30x hop: a redirect to a foreign host must fail honestly.

    urllib follows redirects by default; without this handler the allow-list
    would only protect the first URL of a request.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        try:
            _validate_fetch_url(newurl)
        except SourceError:
            raise SourceError("error", "redirect_target_not_allowed") from None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _ops_opener() -> urllib.request.OpenerDirector:
    """Opener that keeps the whitelist enforced across the whole redirect chain."""
    return urllib.request.build_opener(_WhitelistRedirectHandler)


def default_fetch(url: str) -> str:
    _validate_fetch_url(url)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with _ops_opener().open(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise SourceError("error", f"http_{response.status}")
        data = response.read(MAX_FETCH_BYTES + 1)
    if len(data) > MAX_FETCH_BYTES:
        raise SourceError("error", "payload_too_large")
    return data.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# qoder.com flight-script extraction (embedded escaped JSON)
# ---------------------------------------------------------------------------
def _unescape_js(text: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text) and text[index + 1] in ('"', "\\"):
            out.append(text[index + 1])
            index += 2
        else:
            out.append(char)
            index += 1
    return "".join(out)


def _flight_json_array(html: str, key: str) -> list[Any]:
    marker = f'\\"{key}\\":'
    start_marker = html.find(marker)
    if start_marker < 0:
        raise SourceError("error", "marker_missing")
    start = html.find("[", start_marker + len(marker))
    if start < 0:
        raise SourceError("error", "marker_missing")
    depth = 0
    index = start
    while index < len(html):
        char = html[index]
        if char == "\\":
            index += 2
            continue
        if char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
            if depth == 0:
                try:
                    payload = json.loads(_unescape_js(html[start:index + 1]))
                except json.JSONDecodeError as error:
                    raise SourceError("error", "invalid_json") from error
                if not isinstance(payload, list):
                    raise SourceError("error", "unexpected_shape")
                return payload
        index += 1
    raise SourceError("error", "unbalanced_json")


def parse_blog(html: str) -> tuple[list[dict[str, Any]], bool]:
    """blogData entries: {title, desc, category, url(slug), published_at, time}.

    Returns the projected items plus whether the round kept every embedded entry
    (a bounded prefix must surface as ``partial``, never as complete).
    """
    entries = [entry for entry in _flight_json_array(html, "blogData") if isinstance(entry, Mapping)]
    items: list[dict[str, Any]] = []
    for entry in entries[:BLOG_KEEP_PER_ROUND]:
        slug = _text(entry.get("url"), 200)
        title = _text(entry.get("title"), 160)
        if not slug or not title:
            continue
        items.append({
            "id": f"blog:{slug}",
            "sourceType": "blog",
            "source": SOURCE_LABELS["blog"],
            "title": title,
            "url": f"https://qoder.com/zh/blog/{slug}",
            "publishedAt": _text(entry.get("published_at") or entry.get("time"), 40),
            "summary": _text(entry.get("desc")),
            "kind": _text(entry.get("category"), 40),
        })
    return items, len(entries) <= BLOG_KEEP_PER_ROUND


def parse_changelog(html: str) -> tuple[list[dict[str, Any]], bool]:
    """initialData entries: {id, title, body, tag_name, published_at, type}."""
    entries = [entry for entry in _flight_json_array(html, "initialData") if isinstance(entry, Mapping)]
    items: list[dict[str, Any]] = []
    for entry in entries[:CHANGELOG_KEEP_PER_ROUND]:
        tag = _text(entry.get("tag_name"), 60) or _text(entry.get("id"), 60)
        title = _text(entry.get("title"), 160)
        if not tag or not title:
            continue
        items.append({
            "id": f"changelog:{tag}",
            "sourceType": "changelog",
            "source": SOURCE_LABELS["changelog"],
            "title": title,
            # The changelog renders every release on one page; there is no per-release URL.
            "url": CHANGELOG_URL,
            "publishedAt": _text(entry.get("published_at"), 40),
            "summary": _first_line(entry.get("body")),
            "kind": _text(entry.get("type"), 40),
        })
    return items, len(entries) <= CHANGELOG_KEEP_PER_ROUND


# ---------------------------------------------------------------------------
# help.aliyun.com announcements (directory + bounded 下一篇 chain)
# ---------------------------------------------------------------------------
def _directory_links(html: str) -> list[tuple[str, str]]:
    block_start = html.find('class="directory"')
    if block_start < 0:
        return []
    block_end = html.find("</div>", block_start)
    block = html[block_start:block_end if block_end > 0 else len(html)]
    links: list[tuple[str, str]] = []
    for match in re.finditer(r'<a\s[^>]*href="(/zh/qwenwork/[^"]+)"[^>]*>([^<]+)</a\s*>', block):
        path, title = match.group(1).strip(), match.group(2).strip()
        if path and title:
            links.append((path, title))
    return links


def _next_link(html: str) -> tuple[str, str] | None:
    """「下一篇」anchor; an empty href (下一篇：无) ends the chain."""
    for match in re.finditer(r"<a\s+([^>]*)>(.*?)</a\s*>", html, re.S):
        attrs, text = match.group(1), re.sub(r"<[^>]+>", "", match.group(2)).strip()
        if not text.startswith("下一篇"):
            continue
        href = re.search(r'href="([^"]*)"', attrs)
        if not href:
            return None
        target = href.group(1).strip()
        return (target, text) if target else None
    return None


def _announcement_doc(fetch: Fetcher, path: str, fallback_title: str) -> dict[str, Any] | None:
    html = fetch(f"https://help.aliyun.com{path}")
    title_match = re.search(r'"docTitle":"((?:[^"\\]|\\.)*)"', html)
    title = None
    if title_match:
        title = _text(title_match.group(1).replace('\\"', '"').replace("\\\\", "\\"), 160)
    modified = re.search(r'"lastModifiedTime":(\d+)', html)
    return {
        "id": f"announcement:{path}",
        "sourceType": "announcement",
        "source": SOURCE_LABELS["announcement"],
        "title": title or fallback_title or path,
        "url": f"https://help.aliyun.com{path}",
        "publishedAt": _epoch_ms_iso(int(modified.group(1))) if modified else None,
        "summary": None,
    }


def collect_announcements(fetch: Fetcher) -> tuple[list[dict[str, Any]], bool]:
    index_html = fetch(ANNOUNCE_INDEX_URL)
    paths: list[tuple[str, str]] = list(_directory_links(index_html))
    known = {path for path, _ in paths}
    chain_html = index_html
    for _ in range(MAX_ANNOUNCE_DOCS):
        link = _next_link(chain_html)
        if not link:
            break
        target, _label = link
        path = target if target.startswith("/") else urlparse(target).path
        if not path.startswith("/zh/qwenwork/") or path in known:
            break
        known.add(path)
        paths.append((path, _label.split("：", 1)[-1].split(":", 1)[-1].strip()))
        if len(paths) >= MAX_ANNOUNCE_DOCS:
            break
        try:
            chain_html = fetch(f"https://help.aliyun.com{path}")
        except SourceError:
            break
    if len(paths) > MAX_ANNOUNCE_DOCS:
        paths = paths[:MAX_ANNOUNCE_DOCS]
        complete = False
    else:
        complete = True
    items: list[dict[str, Any]] = []
    failures = 0
    for path, title in paths:
        try:
            item = _announcement_doc(fetch, path, title)
        except SourceError:
            failures += 1
            continue
        if item:
            items.append(item)
    return items, complete and failures == 0


# ---------------------------------------------------------------------------
# 千仔运营助手 single-chat via dws (read-only, flag-validated)
# ---------------------------------------------------------------------------
def _dws_error_code(*sources: str) -> str | None:
    for source in sources:
        try:
            envelope = json.loads(source)
        except json.JSONDecodeError:
            continue
        if not isinstance(envelope, Mapping):
            continue
        error = envelope.get("error")
        if isinstance(error, Mapping):
            reason = _text(error.get("upstream_code")) or _text(error.get("reason"))
            if reason:
                return f"dws_{reason.lower()}"
    return None


def run_dws_ops(arguments: Sequence[str]) -> Mapping[str, Any]:
    command = tuple(arguments)
    if command[:2] != DWS_BASE:
        raise SourceError("error", "command_not_allowed")
    index = 2
    while index < len(command):
        flag = command[index]
        if flag == "--page-all":
            index += 1
            continue
        if flag not in DWS_FLAGS or index + 1 >= len(command) or not DWS_FLAGS[flag](command[index + 1]):
            raise SourceError("error", "command_not_allowed")
        index += 2
    executable = shutil.which("dws")
    if not executable:
        raise SourceError("error", "dws_missing")
    completed = subprocess.run(
        [executable, *command], check=False, capture_output=True, text=True,
        timeout=180, shell=False,
    )
    if completed.returncode == 0:
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise SourceError("error", "invalid_json") from error
        if not isinstance(payload, Mapping):
            raise SourceError("error", "unexpected_shape")
        return payload
    raise SourceError("error", _dws_error_code(completed.stdout, completed.stderr) or f"dws_exit_{completed.returncode}")


def parse_qianzai(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        raise SourceError("error", "unexpected_shape")
    items: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, Mapping):
            continue
        message_id = _text(message.get("messageId"), 200)
        created = _text(message.get("createTime"), 40)
        text = _text(message.get("text"))
        if not message_id or not created or not text:
            continue
        # 单聊消息没有公开 URL；url 字段如实留空，前端不渲染链接。
        items.append({
            "id": f"qianzai:{message_id}",
            "sourceType": "qianzai",
            "source": SOURCE_LABELS["qianzai"],
            "title": re.split(r"[\n\r]+", text, maxsplit=1)[0].strip()[:80] or "（千仔推送）",
            "url": None,
            "publishedAt": created.replace(" ", "T"),
            "summary": text[:TEXT_LIMIT],
        })
    return items


def _qianzai_open_id() -> str:
    """千仔运营助手单聊定位值只从环境变量读取（见 .env.example），不硬编码在代码里。"""
    open_id = (os.environ.get("OPS_QIANZAI_OPEN_DINGTALK_ID") or "").strip()
    if not open_id:
        raise SourceError("missing", "qianzai_open_id_missing")
    return open_id


def fetch_qianzai(dws: DwsRunner, since: datetime, until: datetime) -> tuple[list[dict[str, Any]], bool]:
    command = (
        "chat", "+chat-messages",
        "--open-dingtalk-id", _qianzai_open_id(),
        "--start", since.strftime("%Y-%m-%d %H:%M:%S"),
        "--end", until.strftime("%Y-%m-%d %H:%M:%S"),
        "--order", "asc", "--format", "json", "--page-all",
        "--page-limit", str(QIANZAI_PAGE_LIMIT), "--max-items", str(QIANZAI_MAX_ITEMS),
    )
    payload = dws(command)
    complete = payload.get("complete") is True and payload.get("partial") is not True
    return parse_qianzai(payload), complete


# ---------------------------------------------------------------------------
# Digest assembly (envelope mirrors crm_snapshot; incremental qianzai cursor)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class SectionResult:
    items: list[Any]
    complete: bool = True
    meta: Mapping[str, Any] = field(default_factory=dict)


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
    old_items = [
        item for item in (previous.get("items") or [])
        if isinstance(item, Mapping) and item.get("sourceType") == name
    ]
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


def _sort_key(item: Mapping[str, Any]) -> tuple[int, str]:
    published = item.get("publishedAt")
    return (0, str(published)) if published else (1, "")


def build_digest(
    *,
    output_path: Path,
    fetch: Fetcher = default_fetch,
    dws: DwsRunner = run_dws_ops,
    now: Callable[[], datetime] = _local_now,
) -> dict[str, Any]:
    previous = _load_previous(output_path)
    now_dt = now()
    timestamp = _utc_iso(now_dt)
    cursors = previous.get("cursors") if isinstance(previous.get("cursors"), Mapping) else {}

    def blog() -> SectionResult:
        items, complete = parse_blog(fetch(BLOG_URL))
        return SectionResult(items, complete)

    def changelog() -> SectionResult:
        items, complete = parse_changelog(fetch(CHANGELOG_URL))
        return SectionResult(items, complete)

    def announcements() -> SectionResult:
        items, complete = collect_announcements(fetch)
        return SectionResult(items, complete)

    qianzai_since_raw = cursors.get("qianzaiSince")
    qianzai_since = None
    if isinstance(qianzai_since_raw, str):
        try:
            qianzai_since = datetime.strptime(qianzai_since_raw, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            qianzai_since = None
    if qianzai_since is None:
        qianzai_since = now_dt - timedelta(days=QIANZAI_BACKFILL_DAYS)

    def qianzai() -> SectionResult:
        items, complete = fetch_qianzai(dws, qianzai_since, now_dt)
        return SectionResult(items, complete, {"since": qianzai_since.strftime("%Y-%m-%d %H:%M:%S")})

    fetchers: Mapping[str, Callable[[], SectionResult]] = {
        "blog": blog, "changelog": changelog, "announcement": announcements, "qianzai": qianzai,
    }
    results = {name: _section(name, fetchers[name], previous, timestamp) for name in SOURCE_TYPES}

    merged: dict[str, Mapping[str, Any]] = {}
    previous_items = previous.get("items") if isinstance(previous.get("items"), list) else []
    for item in previous_items:
        if isinstance(item, Mapping) and isinstance(item.get("id"), str):
            merged[item["id"]] = item
    for name in SOURCE_TYPES:
        for item in results[name][0]:
            if isinstance(item, Mapping) and isinstance(item.get("id"), str):
                merged[item["id"]] = item

    retained: list[Mapping[str, Any]] = []
    for name in SOURCE_TYPES:
        bucket = sorted(
            (item for item in merged.values() if item.get("sourceType") == name),
            key=_sort_key, reverse=True,
        )[:PER_SOURCE_KEEP]
        retained.extend(bucket)
    retained.sort(key=_sort_key, reverse=True)

    new_cursors = dict(cursors)
    qianzai_status = results["qianzai"][1]["status"]
    if qianzai_status == "ok":
        # 完整轮已读到 now，下一轮从 now 起增量。
        new_cursors["qianzaiSince"] = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    elif qianzai_status == "partial":
        # 触顶截断时只推进到最后一条已读消息：直接推进到 now 会漏掉窗口尾部的消息。
        # 没读到任何消息时游标保持不动（下一轮重读同一窗口），重复消息由 id 去重。
        last_published = max(
            (
                str(item["publishedAt"])
                for item in results["qianzai"][0]
                if isinstance(item, Mapping) and item.get("publishedAt")
            ),
            default=None,
        )
        if last_published:
            new_cursors["qianzaiSince"] = last_published.replace("T", " ")

    digest = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": timestamp,
        "readOnly": True,
        "sources": {name: results[name][1] for name in SOURCE_TYPES},
        "cursors": new_cursors,
        "items": retained,
    }
    atomic_write_json(output_path, digest)
    return digest


def _parse_args() -> argparse.Namespace:
    cache = Path(__file__).resolve().parents[1] / ".local-cache"
    parser = argparse.ArgumentParser(description="只读刷新运营推广摘要（Qoder/千问办公/千仔）")
    parser.add_argument("--output", type=Path, default=cache / "ops-digest.json")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    digest = build_digest(output_path=args.output)
    summary = {name: {k: source[k] for k in ("status", "count", "error")}
               for name, source in digest["sources"].items()}
    print(json.dumps({"generatedAt": digest["generatedAt"], "sources": summary,
                      "items": len(digest["items"])}, ensure_ascii=False))
    return 0 if any(source["status"] == "ok" for source in digest["sources"].values()) else 1


if __name__ == "__main__":
    os.umask(0o077)
    raise SystemExit(main())
