#!/usr/bin/env python3
"""Probe DingTalk's read-only discovery surface without widening document scope."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

try:
    from .local_indexer import atomic_write_json
except ImportError:
    from local_indexer import atomic_write_json

CommandRunner = Callable[[Sequence[str]], Mapping[str, Any]]


class DingTalkCommandError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def run_dws(arguments: Sequence[str]) -> Mapping[str, Any]:
    executable = shutil.which("dws")
    if not executable:
        raise DingTalkCommandError("dws CLI is not installed")
    completed = subprocess.run(
        [executable, *arguments, "--format", "json"],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if completed.returncode != 0:
        raise DingTalkCommandError(f"dws exited with code {completed.returncode}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise DingTalkCommandError("dws returned invalid JSON") from error
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise DingTalkCommandError("dws command did not succeed")
    return payload


def extract_current_user_id(payload: Mapping[str, Any]) -> str:
    result = payload.get("result")
    if not isinstance(result, list) or not result:
        raise DingTalkCommandError("current DingTalk user is unavailable")
    employee = result[0].get("orgEmployeeModel") if isinstance(result[0], dict) else None
    user_id = employee.get("userId") if isinstance(employee, dict) else None
    if not isinstance(user_id, str) or not user_id.strip():
        raise DingTalkCommandError("current DingTalk userId is unavailable")
    return user_id.strip()


def export_owned_documents(output_path: Path, runner: CommandRunner = run_dws) -> dict[str, Any]:
    user_payload = runner(("contact", "user", "get-self"))
    owner_user_id = extract_current_user_id(user_payload)
    root_payload = runner(("drive", "list", "--limit", "50"))
    result = root_payload.get("result")
    root_items = result.get("items", []) if isinstance(result, dict) else []
    root_item_count = len(root_items) if isinstance(root_items, list) else 0

    report = {
        "schemaVersion": 1,
        "source": "dingtalk",
        "generatedAt": utc_now(),
        "status": "blocked-capability",
        "complete": False,
        "readOnly": True,
        "scope": "current-user-created-documents",
        "ownerUserId": owner_user_id,
        "documents": [],
        "probe": {
            "personalRootItems": root_item_count,
            "commands": ["contact user get-self", "drive list --limit 50"],
        },
        "limitation": {
            "code": "MISSING_COMPLETE_OWNER_ENUMERATION",
            "message": "当前接口只能按关键词和创建者搜索，或读取本人最近访问文档，无法无关键词枚举本人创建的全部文档。",
            "requiredCapability": "按当前用户创建者过滤并支持完整分页的文档枚举接口",
        },
    }
    atomic_write_json(output_path, report)
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="探测并导出本人创建钉钉文档的只读同步状态")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / ".local-cache/dingtalk-owned-docs.json",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = export_owned_documents(args.output)
    except (DingTalkCommandError, OSError, subprocess.TimeoutExpired) as error:
        print(f"钉钉只读探测失败：{error}")
        return 1
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
