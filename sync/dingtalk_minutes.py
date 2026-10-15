#!/usr/bin/env python3
"""Fail-closed DingTalk AI minutes synchronization."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

try:
    from .local_indexer import atomic_write_json
except ImportError:
    from local_indexer import atomic_write_json

SCHEMA_VERSION = 1
LIST_COMMAND = ("minutes", "+list-all", "--page-all")
LIMITATION_CODE = "MISSING_COMPLETE_PARTICIPANT_MEMBERSHIP"
_FORBIDDEN_ARGUMENT_PARTS = ("|", ";", "&&", "\n", "\r")


class DingTalkCommandError(RuntimeError):
    """Raised when a safe dws command cannot be completed."""


class MinutesInputError(ValueError):
    """Raised when a private sync input violates its contract."""


CommandRunner = Callable[[tuple[str, ...]], Mapping[str, Any]]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _validated_arguments(arguments: Sequence[str]) -> tuple[str, ...]:
    command = tuple(arguments)
    if not command or any(not isinstance(item, str) or not item for item in command):
        raise DingTalkCommandError("dws command arguments must be non-empty strings")
    if "--format" in command or any(
        fragment in item for item in command for fragment in _FORBIDDEN_ARGUMENT_PARTS
    ):
        raise DingTalkCommandError("dws command contains a forbidden argument")
    return command


def run_dws(arguments: Sequence[str]) -> Mapping[str, Any]:
    """Run the sole approved read-only dws command without invoking a shell."""

    command = _validated_arguments(arguments)
    if command != LIST_COMMAND:
        raise DingTalkCommandError("dws command is not approved for minutes synchronization")
    executable = shutil.which("dws")
    if not executable:
        raise DingTalkCommandError("dws CLI is not installed")
    completed = subprocess.run(
        [executable, *command, "--format", "json"],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        shell=False,
    )
    if completed.returncode != 0:
        raise DingTalkCommandError(f"dws exited with code {completed.returncode}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise DingTalkCommandError("dws returned invalid JSON") from error
    if not _payload_succeeded(payload):
        raise DingTalkCommandError("dws command did not succeed")
    return payload


def _payload_succeeded(payload: Any) -> bool:
    if not isinstance(payload, Mapping):
        return False
    if payload.get("success") is True:
        return True
    return payload.get("ok") is True and payload.get("outcome") == "success"


def _load_json_mapping(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise MinutesInputError(f"unable to read private input ({type(error).__name__})") from error
    except json.JSONDecodeError as error:
        raise MinutesInputError("private input must contain valid JSON") from error
    if not isinstance(value, Mapping):
        raise MinutesInputError("private input must be a JSON object")
    return value


def _load_excluded_task_uuids(path: Path) -> frozenset[str]:
    if not path.exists():
        return frozenset()
    payload = _load_json_mapping(path)
    excluded = payload.get("excluded", [])
    if not isinstance(excluded, list):
        raise MinutesInputError("exclusions.excluded must be an array")
    task_uuids: set[str] = set()
    for item in excluded:
        if not isinstance(item, Mapping):
            raise MinutesInputError("each exclusion must be an object")
        task_uuid = item.get("taskUuid")
        if not isinstance(task_uuid, str) or not task_uuid.strip():
            raise MinutesInputError("each exclusion requires a non-empty taskUuid")
        task_uuids.add(task_uuid.strip())
    return frozenset(task_uuids)


def _load_previous_records(path: Path) -> dict[str, Mapping[str, Any]]:
    if not path.exists():
        return {}
    try:
        payload = _load_json_mapping(path)
    except MinutesInputError:
        return {}
    records = payload.get("records", [])
    if not isinstance(records, list):
        return {}
    return {
        task_uuid: item
        for item in records
        if isinstance(item, Mapping)
        and isinstance((task_uuid := item.get("taskUuid")), str)
        and task_uuid.strip()
    }


def _list_items(payload: Mapping[str, Any]) -> list[Any]:
    result = payload.get("result")
    if isinstance(result, list):
        return result
    if isinstance(result, Mapping) and isinstance(result.get("items"), list):
        return result["items"]
    data = payload.get("data")
    if isinstance(data, Mapping) and isinstance(data.get("minutes"), list):
        return data["minutes"]
    raise DingTalkCommandError("dws minutes list returned an unsupported result")


def _candidate_ids(items: Sequence[Any]) -> tuple[tuple[str, ...], int]:
    identifiers: tuple[str, ...] = ()
    seen: frozenset[str] = frozenset()
    failed = 0
    for item in items:
        task_uuid = item.get("taskUuid") if isinstance(item, Mapping) else None
        if not isinstance(task_uuid, str) or not task_uuid.strip():
            failed += 1
            continue
        normalized = task_uuid.strip()
        if normalized in seen:
            continue
        identifiers = (*identifiers, normalized)
        seen = seen | {normalized}
    return identifiers, failed


def _state_record(
    task_uuid: str, access_status: str, previous: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    old = previous or {}
    return {
        "taskUuid": task_uuid,
        "serverUpdatedAt": old.get("serverUpdatedAt"),
        "contentFingerprint": old.get("contentFingerprint"),
        "lastProcessedAt": old.get("lastProcessedAt"),
        "accessStatus": access_status,
    }


def _build_report(counts: Mapping[str, int]) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": "dingtalk-minutes",
        "generatedAt": _utc_now(),
        "status": "blocked-capability",
        "complete": False,
        "readOnly": True,
        "counts": dict(counts),
        "limitation": {
            "code": LIMITATION_CODE,
            "message": "当前只读列表不提供完整、权威的参会关系，已阻止听记正文读取。",
        },
        "diagnostics": [
            {
                "code": "PARTICIPANT_MEMBERSHIP_UNAVAILABLE",
                "severity": "blocking",
            }
        ],
    }


def sync_minutes(
    *,
    output_path: Path,
    state_path: Path,
    exclusions_path: Path,
    runner: CommandRunner = run_dws,
) -> dict[str, Any]:
    """Enumerate accessible minutes but read no content without authoritative membership."""

    if output_path.resolve() == state_path.resolve():
        raise MinutesInputError("report and private state paths must be distinct")
    excluded_ids = _load_excluded_task_uuids(exclusions_path)
    previous = _load_previous_records(state_path)
    items = _list_items(runner(LIST_COMMAND))
    candidate_ids, malformed_count = _candidate_ids(items)
    current_ids = frozenset(candidate_ids)

    current_records = tuple(
        _state_record(
            task_uuid,
            "excluded" if task_uuid in excluded_ids else "blocked-capability",
            previous.get(task_uuid),
        )
        for task_uuid in candidate_ids
    )
    inaccessible_ids = tuple(sorted(set(previous) - set(current_ids)))
    inaccessible_records = tuple(
        _state_record(task_uuid, "inaccessible", previous[task_uuid])
        for task_uuid in inaccessible_ids
    )
    excluded_count = sum(task_uuid in excluded_ids for task_uuid in candidate_ids)
    counts = {
        "scanned": len(items),
        "excluded": excluded_count,
        "inaccessible": len(inaccessible_ids),
        "processed": 0,
        "failed": malformed_count,
    }
    private_state = {
        "schemaVersion": SCHEMA_VERSION,
        "source": "dingtalk-minutes",
        "cursor": None,
        "records": [*current_records, *inaccessible_records],
        "summary": counts,
    }
    report = _build_report(counts)
    atomic_write_json(state_path, private_state)
    atomic_write_json(output_path, report)
    return report


def _parse_args() -> argparse.Namespace:
    cache = Path(__file__).resolve().parents[1] / ".local-cache"
    parser = argparse.ArgumentParser(description="安全探测钉钉 AI 听记增量同步能力")
    parser.add_argument("--output", type=Path, default=cache / "dingtalk-minutes-report.json")
    parser.add_argument("--state", type=Path, default=cache / "dingtalk-minutes-state.json")
    parser.add_argument("--exclusions", type=Path, default=cache / "dingtalk-minutes-exclusions.json")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        report = sync_minutes(
            output_path=args.output,
            state_path=args.state,
            exclusions_path=args.exclusions,
        )
    except (DingTalkCommandError, MinutesInputError, OSError, subprocess.TimeoutExpired) as error:
        print(f"钉钉听记同步受阻：{type(error).__name__}")
        return 1
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
