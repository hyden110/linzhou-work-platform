#!/usr/bin/env python3
"""Read-only daily digest of unread DingTalk group messages.

Boundary rules (plan: docs/dingtalk-todos-unread-summary-plan.md):

* Only unread *groups* from the snapshot are read; single chats are counted only.
* The only dws command this file can build is ``chat +chat-messages`` with an
  explicit ascending time window, bounded paging and reaction stripping. It can
  never mark a chat read, clear a red dot, send, recall or update anything.
* Message bodies are projected to messageId/sender/time/text and cached under
  ``.local-cache/dingtalk-daily/raw`` (0600). Nothing is sent to a remote model
  except the qodercli prompt (a local CLI call with ``--tools ""``); when that
  CLI is unavailable the run degrades to deterministic keyword extraction and is
  explicitly labelled as not-summarised instead of inventing content.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

SCHEMA_VERSION = 1
MAX_CHATS = 20
MAX_MESSAGES = 200
PAGE_LIMIT = 100
FIRST_WINDOW_HOURS = 24
MAX_WINDOW_HOURS = 72
MESSAGE_TEXT_LIMIT = 4000
MAX_TICKETS = 20
MAX_FALLBACK_TICKETS = 5
SUMMARY_TEXT_LIMIT = 500
PROBLEM_TEXT_LIMIT = 300
SOLUTION_TEXT_LIMIT = 300
QODERCLI_TIMEOUT_S = 120
DWS_TIMEOUT_S = 120

CHAT_ID_PATTERN = re.compile(r"[A-Za-z0-9_=+/:.-]{1,128}")
ISO_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")
CHAT_COMMAND_PREFIX = ("chat", "+chat-messages")

PROBLEM_HINTS = (
    "？", "?", "报错", "异常", "失败", "无法", "不能", "超时", "卡住", "卡死",
    "问题", "帮忙", "请问", "怎么", "不通", "断开", "闪退", "不可用", "没反应",
)
STRONG_PROBLEM_HINTS = (
    "报错", "异常", "失败", "无法", "不能", "超时", "卡住", "卡死", "不通",
    "断开", "闪退", "不可用", "没反应",
)
RESOLVE_HINTS = (
    "已解决", "解决了", "已修复", "修复了", "恢复", "好了", "搞定", "可以了",
    "正常了", "已处理", "没问题了", "已恢复",
)


class SourceError(RuntimeError):
    """A read-only source failed; the code is browser-safe."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Summarizer(Protocol):
    def available(self) -> bool: ...

    def complete(self, prompt: str) -> str | None: ...


# ---------------------------------------------------------------------------
# Time / text helpers
# ---------------------------------------------------------------------------
def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _local_date(moment: datetime) -> str:
    return moment.astimezone().strftime("%Y-%m-%d")


def _parse_time(value: Any) -> datetime | None:
    text = str(value).strip() if value is not None else ""
    if not text:
        return None
    for suffix in ("Z", "+00:00"):
        if text.endswith(suffix):
            try:
                parsed = datetime.fromisoformat(text[:-1] + "+00:00" if suffix == "Z" else text)
            except ValueError:
                continue
            return parsed.astimezone(timezone.utc)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _text(value: Any, limit: int = 200) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).strip()
    return text[:limit] or None


def _mappings(items: Any) -> list[Mapping[str, Any]]:
    return [item for item in items if isinstance(item, Mapping)] if isinstance(items, list) else []


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_json_atomic(path: Path, value: Any, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(temporary, mode)
    temporary.replace(path)


# ---------------------------------------------------------------------------
# dws read-only runner
# ---------------------------------------------------------------------------
def build_chat_messages_command(chat_id: str, start: str, end: str) -> tuple[str, ...]:
    return (
        "chat", "+chat-messages",
        "--group", chat_id,
        "--start", start,
        "--end", end,
        "--order", "asc",
        "--page-all",
        "--page-limit", str(PAGE_LIMIT),
        "--max-items", str(MAX_MESSAGES),
        "--no-reactions",
        "--format", "json",
    )


def _validate_chat_command(command: tuple[str, ...]) -> None:
    """Defence in depth: only the exact read-only shape built above is runnable."""
    if len(command) != len(build_chat_messages_command("x", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")):
        raise SourceError("command_not_allowed")
    if command[:2] != CHAT_COMMAND_PREFIX:
        raise SourceError("command_not_allowed")
    chat_id, start, end = command[3], command[5], command[7]
    if not CHAT_ID_PATTERN.fullmatch(chat_id):
        raise SourceError("command_not_allowed")
    if not ISO_PATTERN.fullmatch(start) or not ISO_PATTERN.fullmatch(end):
        raise SourceError("command_not_allowed")
    if command != build_chat_messages_command(chat_id, start, end):
        raise SourceError("command_not_allowed")


def _json_any(stdout: str) -> Any:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as error:
        raise SourceError("invalid_json") from error


def run_dws(arguments: Sequence[str]) -> Mapping[str, Any]:
    command = tuple(arguments)
    _validate_chat_command(command)
    executable = shutil.which("dws")
    if not executable:
        raise SourceError("dws_missing")
    completed = subprocess.run(
        [executable, *command], check=False, capture_output=True, text=True,
        timeout=DWS_TIMEOUT_S, shell=False,
    )
    payload: Any = None
    try:
        payload = _json_any(completed.stdout)
    except SourceError:
        payload = None
    if completed.returncode == 0:
        if not isinstance(payload, Mapping):
            raise SourceError("invalid_json")
        return payload
    # A partial page can exit non-zero while still carrying the messages read so far.
    if isinstance(payload, Mapping) and isinstance(payload.get("messages"), list):
        return payload
    if isinstance(payload, Mapping):
        error = payload.get("error")
        if isinstance(error, Mapping):
            code = _text(error.get("code") or error.get("subtype") or error.get("type"))
            if code:
                raise SourceError(f"dws_{code.lower()}")
    raise SourceError(f"dws_exit_{completed.returncode}")


# ---------------------------------------------------------------------------
# Snapshot / watermarks
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ChatRef:
    chat_id: str
    name: str


def load_unread_targets(snapshot_path: Path) -> tuple[list[ChatRef], list[ChatRef], int]:
    payload = _read_json(snapshot_path)
    if not isinstance(payload, Mapping):
        raise SourceError("snapshot_unavailable")
    groups = {
        str(group.get("id")): _text(group.get("name")) or "（未命名群）"
        for group in _mappings(payload.get("groups"))
        if group.get("id")
    }
    unread = [item for item in _mappings(payload.get("unread")) if item.get("id")]
    group_refs: list[ChatRef] = []
    single_refs: list[ChatRef] = []
    seen: set[str] = set()
    for item in unread:
        chat_id = str(item.get("id"))
        if chat_id in seen:
            continue
        seen.add(chat_id)
        name = _text(item.get("name")) or groups.get(chat_id) or "（未命名会话）"
        ref = ChatRef(chat_id=chat_id, name=name)
        if chat_id in groups:
            group_refs.append(ref)
        else:
            single_refs.append(ref)
    selected = group_refs[:MAX_CHATS]
    return selected, single_refs, max(0, len(group_refs) - len(selected))


def load_watermarks(path: Path) -> dict[str, Any]:
    payload = _read_json(path)
    if not isinstance(payload, Mapping) or payload.get("schemaVersion") != SCHEMA_VERSION:
        return {"schemaVersion": SCHEMA_VERSION, "chats": {}}
    chats = payload.get("chats")
    return {"schemaVersion": SCHEMA_VERSION, "chats": chats if isinstance(chats, Mapping) else {}}


def window_for(watermark: Any, now: datetime) -> tuple[datetime, datetime, bool]:
    """First run = last 24h; later runs continue from the watermark, capped at 72h."""
    floor = now - timedelta(hours=MAX_WINDOW_HOURS)
    start = now - timedelta(hours=FIRST_WINDOW_HOURS)
    capped = False
    if isinstance(watermark, Mapping):
        previous = _parse_time(watermark.get("lastMessageTime"))
        if previous is not None:
            start = previous
            if start < floor:
                start = floor
                capped = True
    if start >= now:
        start = now - timedelta(hours=FIRST_WINDOW_HOURS)
    return start, now, capped


# ---------------------------------------------------------------------------
# Message projection
# ---------------------------------------------------------------------------
def project_messages(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    messages: dict[str, dict[str, Any]] = {}
    for message in _mappings(payload.get("messages")):
        message_id = _text(message.get("messageId"))
        if not message_id:
            continue
        text = _text(message.get("text"), MESSAGE_TEXT_LIMIT) or ""
        sender = _text(message.get("sender")) or _text(message.get("senderId")) or "未知发送人"
        time = _text(message.get("createTime")) or ""
        messages[message_id] = {
            "messageId": message_id,
            "sender": sender,
            "time": time,
            "text": text,
        }
    return sorted(messages.values(), key=lambda item: (item["time"], item["messageId"]))


def payload_complete(payload: Mapping[str, Any], messages: Sequence[Any]) -> bool:
    if payload.get("complete") is False or payload.get("partial") is True:
        return False
    for flag in ("hasMore", "truncated", "truncatedByPageLimit", "truncatedByResultLimit"):
        if payload.get(flag) is True:
            return False
    return len(messages) < MAX_MESSAGES


def raw_path(cache_dir: Path, date: str, chat_id: str) -> Path:
    digest = hashlib.sha256(chat_id.encode("utf-8")).hexdigest()[:24]
    return cache_dir / "dingtalk-daily" / "raw" / date / f"chat_{digest}.json"


# ---------------------------------------------------------------------------
# qodercli summariser
# ---------------------------------------------------------------------------
def default_qodercli_bin() -> Path:
    override = os.environ.get("QODERCLI_BIN", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".qoder" / "bin" / "qodercli" / "qodercli-1.0.34"


class QodercliSummarizer:
    """Local CLI summary channel: ``-p`` plus ``--tools ""`` and no MCP allow-list.

    ``qodercli login`` stores credentials in the default user config, so a fixed
    ``--config-dir`` would hide a successful browser login. The probe therefore
    tries, in order: ``QODERCLI_CONFIG_DIR`` (explicit override), the isolated
    cache directory (no ambient state), then the default config (no flag).
    The first candidate whose probe answers ``{"ok":true}`` is used for every
    prompt in this run; only its label is reported, never the path.
    """

    PROBE_PROMPT = '只输出一行 JSON，不要解释：{"ok":true}'

    def __init__(
        self,
        config_dir: Path,
        cwd: Path,
        *,
        binary: Path | None = None,
        runner: Callable[[Sequence[str], Mapping[str, str]], subprocess.CompletedProcess[str]] | None = None,
        timeout_s: int = QODERCLI_TIMEOUT_S,
    ) -> None:
        self.config_dir = config_dir
        self.cwd = cwd
        self.binary = binary or default_qodercli_bin()
        self.runner = runner or self._run
        self.timeout_s = timeout_s
        self._available: bool | None = None
        self._selected_config_dir: str | None = None
        self.selected_source: str | None = None

    def _environment(self) -> dict[str, str]:
        env = {key: value for key, value in os.environ.items()}
        # The host app marks itself as an Agent-SDK entrypoint; qodercli would then
        # demand stream-json flags and abort before printing anything.
        env.pop("QODER_AGENT_SDK_ENTRYPOINT", None)
        env.pop("QODER_AGENT_SDK_VERSION", None)
        env["NO_COLOR"] = "1"
        return env

    def _run(self, arguments: Sequence[str], env: Mapping[str, str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            list(arguments), cwd=str(self.cwd), env=dict(env), check=False,
            capture_output=True, text=True, timeout=self.timeout_s, shell=False,
        )

    def _candidates(self) -> list[tuple[str, str | None]]:
        self.config_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.config_dir, 0o700)
        except OSError:
            pass
        candidates: list[tuple[str, str | None]] = []
        override = os.environ.get("QODERCLI_CONFIG_DIR", "").strip()
        if override:
            candidates.append(("env", str(Path(override).expanduser())))
        candidates.append(("isolated", str(self.config_dir)))
        candidates.append(("default", None))
        unique: list[tuple[str, str | None]] = []
        seen: set[str | None] = set()
        for source, directory in candidates:
            if directory in seen:
                continue
            seen.add(directory)
            unique.append((source, directory))
        return unique

    def command(self, prompt: str, *, config_dir: str | None = None) -> tuple[str, ...]:
        arguments = [str(self.binary)]
        if config_dir is not None:
            arguments.extend(("--config-dir", config_dir))
        arguments.extend(("-p", prompt, "--tools", "", "-w", str(self.cwd)))
        return tuple(arguments)

    def available(self) -> bool:
        if self._available is not None:
            return self._available
        if not self.binary.exists():
            self._available = False
            return False
        for source, directory in self._candidates():
            try:
                result = self.runner(self.command(self.PROBE_PROMPT, config_dir=directory), self._environment())
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0 and _probe_ok(result.stdout):
                self._selected_config_dir = directory
                self.selected_source = source
                self._available = True
                return True
        self._available = False
        return False

    def complete(self, prompt: str) -> str | None:
        if self._available is None and not self.available():
            return None
        if not self._available:
            return None
        try:
            result = self.runner(
                self.command(prompt, config_dir=self._selected_config_dir), self._environment(),
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        return result.stdout if result.returncode == 0 else None


# ---------------------------------------------------------------------------
# Prompt / parsing / fallback
# ---------------------------------------------------------------------------
def build_prompt(chat_name: str, messages: Sequence[Mapping[str, Any]], truncated: bool) -> str:
    compact = [
        {
            "messageId": message.get("messageId"),
            "sender": message.get("sender"),
            "time": message.get("time"),
            "text": message.get("text"),
        }
        for message in messages
    ]
    truncation_note = (
        "注意：本群消息已达到读取上限，后续消息缺失；不得据此判定问题已解决。"
        if truncated else "本窗口内消息已完整读取。"
    )
    return (
        "你是钉钉客户群的消息分析助手。只输出一个 JSON 对象，不要 markdown 代码块，不要解释。\n"
        "输入：一个客户群的钉钉消息数组（字段 messageId/sender/time/text）。\n"
        f"群名：{chat_name}\n{truncation_note}\n"
        "要求：\n"
        "1. summary：不超过 120 字，概括讨论与需要跟进的事项，不得编造未出现的事实。\n"
        "2. tickets：识别客户问题/工单，数组项格式："
        '{"problem":string,"firstSeenAt":string,"lastSeenAt":string,'
        '"status":"resolved|unresolved|unconfirmed","solution":string|null,"evidence":[messageId]}。\n'
        "3. 只有消息中明确出现“已解决/已修复/恢复了/可以了”等解决表述，且 evidence 含该条消息的 "
        "messageId，才可 status=resolved；否则 resolved 一律改为 unconfirmed。\n"
        "4. 没有明确证据时 status=unconfirmed；没有问题时 tickets=[]。\n"
        "5. evidence 必须是输入中出现过的 messageId，最多 5 个。\n"
        "消息：\n"
        + json.dumps(compact, ensure_ascii=False)
    )


def _probe_ok(stdout: str) -> bool:
    """Liveness probe answer: ``{"ok":true}`` only, not a summary payload."""
    text = stdout.strip()
    candidates = [text]
    first, last = text.find("{"), text.rfind("}")
    if first >= 0 and last > first:
        candidates.append(text[first:last + 1])
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, Mapping) and payload.get("ok") is True:
            return True
    return False


def _parse_llm_json(stdout: str) -> dict[str, Any] | None:
    text = stdout.strip()
    candidates = [text]
    first, last = text.find("{"), text.rfind("}")
    if first >= 0 and last > first:
        candidates.append(text[first:last + 1])
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, Mapping):
            continue
        summary = payload.get("summary")
        tickets = payload.get("tickets")
        if not isinstance(summary, str) or not isinstance(tickets, list):
            continue
        return {"summary": summary, "tickets": tickets}
    return None


def normalise_tickets(
    raw_tickets: Sequence[Any],
    messages: Sequence[Mapping[str, Any]],
    window_start: str,
    window_end: str,
) -> list[dict[str, Any]]:
    by_id = {str(message["messageId"]): message for message in messages}
    tickets: list[dict[str, Any]] = []
    for raw in raw_tickets[:MAX_TICKETS]:
        if not isinstance(raw, Mapping):
            continue
        problem = _text(raw.get("problem"), PROBLEM_TEXT_LIMIT)
        status = raw.get("status")
        if not problem or status not in ("resolved", "unresolved", "unconfirmed"):
            continue
        evidence = [
            item for item in (raw.get("evidence") if isinstance(raw.get("evidence"), list) else [])
            if isinstance(item, str) and item in by_id
        ][:5]
        solution = _text(raw.get("solution"), SOLUTION_TEXT_LIMIT)
        if status == "resolved" and not evidence:
            status = "unconfirmed"
            solution = None
        evidence_messages = [by_id[message_id] for message_id in evidence]
        first_seen = _text(raw.get("firstSeenAt"), 40)
        last_seen = _text(raw.get("lastSeenAt"), 40)
        if evidence_messages:
            first_seen = first_seen or (evidence_messages[0].get("time") or window_start)
            last_seen = last_seen or (evidence_messages[-1].get("time") or window_end)
        tickets.append({
            "problem": problem,
            "firstSeenAt": first_seen or window_start,
            "lastSeenAt": last_seen or window_end,
            "status": status,
            "solution": solution,
            "evidence": evidence,
        })
    return tickets


def fallback_extract(messages: Sequence[Mapping[str, Any]], window_start: str, window_end: str) -> list[dict[str, Any]]:
    """Deterministic keyword extraction used only when the model channel fails."""
    tickets: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, message in enumerate(messages):
        text = str(message.get("text") or "")
        if len(text) < 6 or not any(hint in text for hint in PROBLEM_HINTS):
            continue
        key = text[:40]
        if key in seen:
            continue
        seen.add(key)
        resolution = next(
            (later for later in messages[index + 1:]
             if any(hint in str(later.get("text") or "") for hint in RESOLVE_HINTS)),
            None,
        )
        evidence = [str(message["messageId"])]
        if resolution is not None:
            evidence.append(str(resolution["messageId"]))
            status = "resolved"
            solution = _text(resolution.get("text"), SOLUTION_TEXT_LIMIT)
            last_seen = str(resolution.get("time") or window_end)
        else:
            status = "unresolved" if any(hint in text for hint in STRONG_PROBLEM_HINTS) else "unconfirmed"
            solution = None
            last_seen = str(message.get("time") or window_end)
        tickets.append({
            "problem": _text(text, PROBLEM_TEXT_LIMIT) or "（无内容）",
            "firstSeenAt": str(message.get("time") or window_start),
            "lastSeenAt": last_seen,
            "status": status,
            "solution": solution,
            "evidence": evidence,
        })
        if len(tickets) >= MAX_FALLBACK_TICKETS:
            break
    return tickets


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
def _read_runs(path: Path) -> dict[str, Any]:
    payload = _read_json(path)
    return payload if isinstance(payload, Mapping) else {}


def _write_runs(path: Path, value: Mapping[str, Any]) -> None:
    _write_json_atomic(path, {"schemaVersion": SCHEMA_VERSION, **dict(value)})


def tighten_isolated_permissions(directory: Path) -> list[str]:
    """Restrict the bridge-owned qodercli tree to 0700 dirs / 0600 files.

    qodercli writes prompt-bearing logs under ``--config-dir`` with ambient
    permissions (0644/0755 observed). Only this isolated directory is walked;
    the default ``~/.qoder`` source is the user's own and is never touched.
    Symlinks are skipped so the walk cannot escape the tree. Failures are
    reported as a browser-safe code (no paths) and never fail the summary.
    """
    warnings: list[str] = []
    try:
        os.chmod(directory, 0o700)
    except FileNotFoundError:
        return warnings
    except OSError:
        warnings.append("isolated_log_chmod_failed")
    for root, dirs, files in os.walk(directory, topdown=False, followlinks=False):
        for name in files:
            path = Path(root) / name
            if path.is_symlink():
                continue
            try:
                os.chmod(path, 0o600)
            except OSError:
                warnings.append("isolated_log_chmod_failed")
        for name in dirs:
            path = Path(root) / name
            if path.is_symlink():
                continue
            try:
                os.chmod(path, 0o700)
            except OSError:
                warnings.append("isolated_log_chmod_failed")
    return sorted(set(warnings))


def build_daily(
    *,
    cache_dir: Path,
    snapshot_path: Path,
    date: str | None = None,
    now: Callable[[], datetime] = _utc_now,
    dws: Callable[[Sequence[str]], Mapping[str, Any]] = run_dws,
    summarizer: Summarizer | None = None,
    project_root: Path | None = None,
) -> dict[str, Any]:
    if date is not None and not DATE_PATTERN.fullmatch(date):
        raise SourceError("invalid_date")
    moment = now().astimezone(timezone.utc)
    run_date = date or _local_date(moment)
    daily_dir = cache_dir / "dingtalk-daily"
    runs_path = daily_dir / "runs.json"
    isolated_config = daily_dir / "qodercli-config"
    warnings: list[str] = []
    model_source: str | None = None
    _write_runs(runs_path, {
        "date": run_date, "state": "running", "startedAt": _iso(moment),
        "finishedAt": None, "error": None, "modelSource": None, "elapsedMs": None,
        "warnings": [],
    })

    try:
        groups, singles, skipped = load_unread_targets(snapshot_path)
        watermarks = load_watermarks(daily_dir / "watermarks.json")
        root = project_root or Path(__file__).resolve().parents[1]
        client = summarizer or QodercliSummarizer(
            daily_dir / "qodercli-config", root,
        )
        model_available = client.available()
        model_source = getattr(client, "selected_source", None) if model_available else None
        chats: list[dict[str, Any]] = []
        total_messages = 0
        for ref in groups:
            watermark = (watermarks.get("chats") or {}).get(ref.chat_id)
            start, end, capped = window_for(watermark, moment)
            start_iso, end_iso = _iso(start), _iso(end)
            entry: dict[str, Any] = {
                "chatId": ref.chat_id,
                "chatName": ref.name,
                "messageCount": 0,
                "complete": False,
                "partial": True,
                "truncated": False,
                "windowCapped": capped,
                "windowStart": start_iso,
                "windowEnd": end_iso,
                "summaryState": "failed",
                "summaryNote": None,
                "summary": "消息读取失败，未生成摘要。",
                "tickets": [],
                "error": None,
            }
            try:
                payload = dws(build_chat_messages_command(ref.chat_id, start_iso, end_iso))
                messages = project_messages(payload)
                complete = payload_complete(payload, messages)
                _write_json_atomic(raw_path(cache_dir, run_date, ref.chat_id), {
                    "schemaVersion": SCHEMA_VERSION,
                    "date": run_date,
                    "chatId": ref.chat_id,
                    "fetchedAt": _iso(moment),
                    "windowStart": start_iso,
                    "windowEnd": end_iso,
                    "complete": complete,
                    "messages": messages,
                })
                total_messages += len(messages)
                entry.update({
                    "messageCount": len(messages),
                    "complete": complete,
                    "partial": not complete,
                    "truncated": not complete and len(messages) >= MAX_MESSAGES,
                })
                if model_available:
                    prompt = build_prompt(ref.name, messages, truncated=entry["truncated"])
                    parsed: dict[str, Any] | None = None
                    # One bounded retry; a still-broken answer never becomes fake data.
                    for _attempt in range(2):
                        try:
                            answer = client.complete(prompt) or ""
                        except (OSError, subprocess.TimeoutExpired):
                            answer = ""
                        parsed = _parse_llm_json(answer)
                        if parsed is not None:
                            break
                    if parsed is not None:
                        entry.update({
                            "summaryState": "llm",
                            "summary": parsed["summary"].strip()[:SUMMARY_TEXT_LIMIT] or "（摘要为空）",
                            "tickets": normalise_tickets(
                                parsed["tickets"], messages, start_iso, end_iso,
                            ),
                        })
                    else:
                        entry.update({
                            "summaryState": "fallback",
                            "summaryNote": "模型摘要不可用或解析失败，以下为规则抽取，仅供参考。",
                            "summary": "未生成摘要（模型调用失败），已按关键词抽取问题。",
                            "tickets": fallback_extract(messages, start_iso, end_iso),
                        })
                else:
                    entry.update({
                        "summaryState": "fallback",
                        "summaryNote": "qodercli 不可用（未登录或未安装），以下为规则抽取，仅供参考。",
                        "summary": "未生成摘要（摘要通道不可用），已按关键词抽取问题。",
                        "tickets": fallback_extract(messages, start_iso, end_iso),
                    })
                # Watermark: complete advances to window end; partial only to the read tail.
                if complete or not messages:
                    advance_to, advance_id = end_iso, (messages[-1]["messageId"] if messages else None)
                else:
                    advance_to, advance_id = messages[-1]["time"] or start_iso, messages[-1]["messageId"]
                chats_map = watermarks.setdefault("chats", {})
                chats_map[ref.chat_id] = {
                    "lastMessageTime": advance_to,
                    "lastMessageId": advance_id,
                    "lastSummarizedAt": _iso(moment),
                }
            except (SourceError, OSError, subprocess.TimeoutExpired) as error:
                entry["error"] = getattr(error, "code", type(error).__name__)
                entry["summaryNote"] = "读取失败，水位未推进，下一轮会重试。"
            chats.append(entry)

        _write_json_atomic(daily_dir / "watermarks.json", watermarks)
        unresolved = sum(
            1 for chat in chats for ticket in chat["tickets"] if ticket["status"] == "unresolved"
        )
        unconfirmed = sum(
            1 for chat in chats for ticket in chat["tickets"] if ticket["status"] == "unconfirmed"
        )
        failed = sum(1 for chat in chats if chat["error"])
        incomplete = sum(
            1 for chat in chats if not chat["error"] and (not chat["complete"] or chat["windowCapped"])
        )
        state = (
            "failed" if chats and failed == len(chats)
            else ("partial" if failed or skipped or incomplete else "ok")
        )
        finished = now().astimezone(timezone.utc)
        elapsed_ms = max(0, int((finished - moment).total_seconds() * 1000))
        warnings = tighten_isolated_permissions(isolated_config)
        artifact = {
            "schemaVersion": SCHEMA_VERSION,
            "date": run_date,
            "generatedAt": _iso(moment),
            "modelSource": model_source,
            "elapsedMs": elapsed_ms,
            "warnings": warnings,
            "windowStart": _iso(moment - timedelta(hours=MAX_WINDOW_HOURS)),
            "windowEnd": _iso(moment),
            "state": state,
            "model": "qodercli" if model_available else "fallback",
            "chats": chats,
            "singleChats": [
                {"chatId": ref.chat_id, "name": ref.name} for ref in singles
            ],
            "skippedGroups": skipped,
            "counts": {
                "groups": len(chats),
                "messages": total_messages,
                "tickets": sum(len(chat["tickets"]) for chat in chats),
                "unresolved": unresolved,
                "unconfirmed": unconfirmed,
                "singleChats": len(singles),
                "failedChats": failed,
                "incompleteChats": incomplete,
            },
            "error": "all_chats_failed" if state == "failed" else None,
        }
        _write_json_atomic(daily_dir / f"summary-{run_date}.json", artifact)
        _write_runs(daily_dir / "runs.json", {
            "date": run_date, "state": "succeeded" if state != "failed" else "failed",
            "startedAt": _iso(moment), "finishedAt": _iso(finished),
            "error": artifact["error"], "modelSource": model_source, "elapsedMs": elapsed_ms,
            "warnings": warnings,
        })
        return artifact
    except Exception as error:
        finished = now().astimezone(timezone.utc)
        warnings = tighten_isolated_permissions(isolated_config)
        _write_runs(runs_path, {
            "date": run_date, "state": "failed", "startedAt": _iso(moment),
            "finishedAt": _iso(finished),
            "error": getattr(error, "code", type(error).__name__),
            "modelSource": model_source,
            "elapsedMs": max(0, int((finished - moment).total_seconds() * 1000)),
            "warnings": warnings,
        })
        raise
    finally:
        # Safety net for every exit path, including errors raised before the
        # branches above. Idempotent, and never allowed to mask the real error.
        tighten_isolated_permissions(isolated_config)


def _parse_args() -> argparse.Namespace:
    cache = Path(__file__).resolve().parents[1] / ".local-cache"
    parser = argparse.ArgumentParser(description="只读生成未读钉群的每日消息总结")
    parser.add_argument("--date", default=None, help="产物日期 YYYY-MM-DD（默认本机今天）")
    parser.add_argument("--cache-dir", type=Path, default=cache)
    parser.add_argument("--snapshot", type=Path, default=cache / "crm-snapshot.json")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        artifact = build_daily(
            cache_dir=args.cache_dir, snapshot_path=args.snapshot, date=args.date,
        )
    except Exception as error:  # noqa: BLE001 - CLI must print a safe failure envelope
        print(json.dumps({"state": "failed", "error": getattr(error, "code", type(error).__name__)}))
        return 1
    print(json.dumps({
        "date": artifact["date"],
        "state": artifact["state"],
        "counts": artifact["counts"],
    }, ensure_ascii=False))
    return 0 if artifact["state"] != "failed" else 1


if __name__ == "__main__":
    os.umask(0o077)
    raise SystemExit(main())
