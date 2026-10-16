import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from sync import dingtalk_owned_docs

SELF_PAYLOAD = {
    "success": True,
    "result": [{"orgEmployeeModel": {"userId": "owner-1", "orgEmail": "private@example.com"}}],
}


def search_payload(documents: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "complete": True,
        "count": len(documents),
        "documents": documents,
        "failures": [],
        "hasMore": False,
        "pagesRead": 1,
        "status": "success",
        "stopReason": "source_complete",
        "truncated": False,
    }
    payload.update(overrides)
    return payload


def recording_runner(responses: list[dict[str, Any]], calls: list[list[str]]):
    def run(arguments):
        calls.append(list(arguments))
        return responses[len(calls) - 1]

    return run


class DingTalkOwnedDocsTest(unittest.TestCase):
    def test_extracts_current_user_id_without_persisting_profile(self) -> None:
        payload = {
            "success": True,
            "result": [{"orgEmployeeModel": {"userId": "owner-1", "orgEmail": "private@example.com"}}],
        }

        self.assertEqual(dingtalk_owned_docs.extract_current_user_id(payload), "owner-1")

    def test_searches_documents_by_creator_and_projects_safe_fields(self) -> None:
        calls: list[list[str]] = []
        runner = recording_runner(
            [
                SELF_PAYLOAD,
                search_payload(
                    [
                        {"nodeId": "n1", "name": "方案 A", "docType": "adoc", "url": "https://alidocs.dingtalk.com/i/nodes/n1", "modifiedTime": None, "internalOnly": "drop me"},
                        {"name": "缺少 nodeId"},
                        {"nodeId": "   "},
                    ]
                ),
            ],
            calls,
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "dingtalk-owned-docs.json"
            report = dingtalk_owned_docs.export_owned_documents(output, runner=runner)
            persisted = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(report, persisted)
        self.assertEqual(report["status"], "ok")
        self.assertTrue(report["complete"])
        self.assertEqual(report["ownerUserId"], "owner-1")
        self.assertEqual(report["documentCount"], 1)
        self.assertEqual(
            report["documents"],
            [{"nodeId": "n1", "name": "方案 A", "docType": "adoc", "url": "https://alidocs.dingtalk.com/i/nodes/n1"}],
        )
        self.assertNotIn("drop me", json.dumps(report))
        self.assertNotIn("private@example.com", json.dumps(report))
        self.assertEqual(report["limitation"]["code"], "UNSTABLE_OWNER_ENUMERATION")
        self.assertEqual(report["probe"]["stopReason"], "source_complete")
        self.assertEqual(report["probe"]["failureCount"], 0)

        self.assertEqual(calls[1][:3], ["doc", "+search", "--creator-uids"])
        self.assertIn("owner-1", calls[1])
        self.assertIn("--page-all", calls[1])
        self.assertIn("--max-pages", calls[1])
        self.assertIn("--max-items", calls[1])

    def test_marks_partial_when_search_hits_pagination_bounds(self) -> None:
        calls: list[list[str]] = []
        runner = recording_runner(
            [
                SELF_PAYLOAD,
                search_payload(
                    [{"nodeId": "n1", "name": "方案 A", "docType": "adoc", "url": None}],
                    complete=False,
                    truncated=True,
                    stopReason="max_pages",
                ),
            ],
            calls,
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "dingtalk-owned-docs.json"
            report = dingtalk_owned_docs.export_owned_documents(output, runner=runner)

        self.assertEqual(report["status"], "partial")
        self.assertFalse(report["complete"])
        self.assertEqual(report["documentCount"], 1)
        self.assertEqual(report["probe"]["stopReason"], "max_pages")

    def test_deduplicates_documents_repeated_across_pages(self) -> None:
        calls: list[list[str]] = []
        runner = recording_runner(
            [
                SELF_PAYLOAD,
                search_payload(
                    [
                        {"nodeId": "n1", "name": "first", "docType": "adoc", "url": None},
                        {"nodeId": "n1", "name": "repeat", "docType": "adoc", "url": None},
                        {"nodeId": "n2", "name": "second", "docType": "adoc", "url": None},
                    ],
                    pagesRead=2,
                ),
            ],
            calls,
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "dingtalk-owned-docs.json"
            report = dingtalk_owned_docs.export_owned_documents(output, runner=runner)

        self.assertEqual(report["documentCount"], 2)
        self.assertEqual([document["name"] for document in report["documents"]], ["first", "second"])
        self.assertEqual(report["probe"]["pagesRead"], 2)

    def test_run_dws_accepts_doc_search_status_success_payload(self) -> None:
        completed = subprocess.CompletedProcess([], returncode=0, stdout='{"status": "success", "documents": []}', stderr="")
        with patch("sync.dingtalk_owned_docs.shutil.which", return_value="/fake/dws"), \
             patch("sync.dingtalk_owned_docs.subprocess.run", return_value=completed) as run_mock:
            payload = dingtalk_owned_docs.run_dws(("doc", "+search"))

        self.assertEqual(payload["status"], "success")
        self.assertIn("--format", run_mock.call_args.args[0])

    def test_run_dws_rejects_payload_without_success_marker(self) -> None:
        completed = subprocess.CompletedProcess([], returncode=0, stdout='{"error": "rate limited"}', stderr="")
        with patch("sync.dingtalk_owned_docs.shutil.which", return_value="/fake/dws"), \
             patch("sync.dingtalk_owned_docs.subprocess.run", return_value=completed):
            with self.assertRaises(dingtalk_owned_docs.DingTalkCommandError):
                dingtalk_owned_docs.run_dws(("doc", "+search"))


if __name__ == "__main__":
    unittest.main()
