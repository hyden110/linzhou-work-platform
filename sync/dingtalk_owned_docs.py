#!/usr/bin/env python3
"""Enumerate DingTalk documents created by the signed-in user via read-only search.

Uses `dws doc +search --creator-uids <userId>` with bounded pagination. The command is
read-only and returns metadata (nodeId/name/docType/url) only; no document content and no
credentials are persisted.
"""

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

DWS_TIMEOUT_SECONDS = 180
OWNER_SEARCH_LIMIT = 30
OWNER_SEARCH_MAX_PAGES = 60
OWNER_SEARCH_MAX_ITEMS = 2_000


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
        timeout=DWS_TIMEOUT_SECONDS,
    )
    if completed.returncode != 0:
        raise DingTalkCommandError(f"dws exited with code {completed.returncode}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise DingTalkCommandError("dws returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise DingTalkCommandError("dws command did not succeed")
    # `contact user get-self` reports `success: true`; `doc +search` reports `status: "success"`.
    if payload.get("success") is not True and payload.get("status") != "success":
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


def project_document(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    node_id = raw.get("nodeId")
    if not isinstance(node_id, str) or not node_id.strip():
        return None
    name = raw.get("name")
    doc_type = raw.get("docType")
    url = raw.get("url")
    return {
        "nodeId": node_id.strip(),
        "name": name.strip() if isinstance(name, str) and name.strip() else None,
        "docType": doc_type if isinstance(doc_type, str) else None,
        "url": url if isinstance(url, str) else None,
    }


def owner_search_arguments(owner_user_id: str) -> tuple[str, ...]:
    return (
        "doc",
        "+search",
        "--creator-uids",
        owner_user_id,
        "--page-all",
        "--max-pages",
        str(OWNER_SEARCH_MAX_PAGES),
        "--max-items",
        str(OWNER_SEARCH_MAX_ITEMS),
        "--limit",
        str(OWNER_SEARCH_LIMIT),
    )


def export_owned_documents(output_path: Path, runner: CommandRunner = run_dws) -> dict[str, Any]:
    user_payload = runner(("contact", "user", "get-self"))
    owner_user_id = extract_current_user_id(user_payload)
    search_arguments = owner_search_arguments(owner_user_id)
    search_payload = runner(search_arguments)

    documents: list[dict[str, Any]] = []
    seen_node_ids: set[str] = set()
    raw_documents = search_payload.get("documents")
    for item in raw_documents if isinstance(raw_documents, list) else []:
        document = project_document(item)
        if document is None or document["nodeId"] in seen_node_ids:
            continue
        seen_node_ids.add(document["nodeId"])
        documents.append(document)

    failures = search_payload.get("failures")
    failure_count = len(failures) if isinstance(failures, list) else 0
    pages_read = search_payload.get("pagesRead")
    stop_reason = search_payload.get("stopReason")
    truncated = search_payload.get("truncated") is True
    complete = search_payload.get("complete") is True and not truncated

    report = {
        "schemaVersion": 1,
        "source": "dingtalk",
        "generatedAt": utc_now(),
        "status": "ok" if complete else "partial",
        "complete": complete,
        "readOnly": True,
        "scope": "current-user-created-documents",
        "ownerUserId": owner_user_id,
        "documentCount": len(documents),
        "documents": documents,
        "probe": {
            "commands": [
                "contact user get-self",
                " ".join(search_arguments),
            ],
            "pagesRead": pages_read if isinstance(pages_read, int) else None,
            "stopReason": stop_reason if isinstance(stop_reason, str) else None,
            "failureCount": failure_count,
        },
        "limitation": {
            "code": "UNSTABLE_OWNER_ENUMERATION",
            "message": "doc +search --creator-uids 可检索本人创建文档并返回本轮命中，但同一过滤条件的多次运行命中数量不一致（实测 85–275 条；单次运行自报 complete 也不能跨运行复现），不能视为跨运行稳定的完整枚举。",
            "requiredCapability": "按创建者过滤且跨运行结果稳定的完整文档枚举接口",
        },
    }
    atomic_write_json(output_path, report)
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="只读同步本人创建的钉钉文档清单")
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
        print(f"钉钉只读同步失败：{error}")
        return 1
    print(json.dumps({
        "status": report["status"],
        "complete": report["complete"],
        "documentCount": report["documentCount"],
        "limitationCode": report["limitation"]["code"],
        "output": str(args.output),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
