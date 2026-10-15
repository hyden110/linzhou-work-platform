from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sync import dingtalk_minutes


class FakeRunner:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload
        self.commands: tuple[tuple[str, ...], ...] = ()

    def __call__(self, arguments: tuple[str, ...]) -> dict[str, object]:
        self.commands = (*self.commands, tuple(arguments))
        if tuple(arguments) != ("minutes", "+list-all", "--page-all"):
            raise AssertionError(f"unexpected command: {arguments!r}")
        return self.payload


class DingTalkMinutesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base = Path(self.temp_dir.name)
        self.output_path = self.base / "minutes-sync-report.json"
        self.state_path = self.base / "private" / "minutes-state.json"
        self.exclusions_path = self.base / "private" / "minutes-exclusions.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def sync(self, runner: FakeRunner) -> dict[str, object]:
        return dingtalk_minutes.sync_minutes(
            output_path=self.output_path,
            state_path=self.state_path,
            exclusions_path=self.exclusions_path,
            runner=runner,
        )

    def test_run_dws_executes_one_json_command_without_a_shell(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout='{"success": true, "result": []}', stderr=""
        )

        with mock.patch.object(dingtalk_minutes.shutil, "which", return_value="/usr/bin/dws"), mock.patch.object(
            dingtalk_minutes.subprocess, "run", return_value=completed
        ) as run:
            payload = dingtalk_minutes.run_dws(("minutes", "+list-all", "--page-all"))

        self.assertEqual(payload["result"], [])
        run.assert_called_once_with(
            ["/usr/bin/dws", "minutes", "+list-all", "--page-all", "--format", "json"],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
            shell=False,
        )
        with self.assertRaises(dingtalk_minutes.DingTalkCommandError):
            dingtalk_minutes.run_dws(("minutes", "+list-all", "|", "cat"))
        with mock.patch.object(dingtalk_minutes.shutil, "which", return_value="/usr/bin/dws"), mock.patch.object(
            dingtalk_minutes.subprocess, "run", return_value=completed
        ) as write_run:
            with self.assertRaises(dingtalk_minutes.DingTalkCommandError):
                dingtalk_minutes.run_dws(("minutes", "delete", "candidate-task"))
        write_run.assert_not_called()

    def test_run_dws_accepts_ok_outcome_envelope_and_rejects_failures(self) -> None:
        envelope = {"ok": True, "outcome": "success", "data": {"minutes": []}}
        failures = (
            {"ok": True, "outcome": "partial", "data": {"minutes": []}},
            {"ok": False, "outcome": "success", "data": {"minutes": []}},
            {"outcome": "success", "data": {"minutes": []}},
        )

        def completed(payload: dict[str, object]) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(
                args=[], returncode=0, stdout=json.dumps(payload), stderr=""
            )

        with mock.patch.object(dingtalk_minutes.shutil, "which", return_value="/usr/bin/dws"):
            with mock.patch.object(dingtalk_minutes.subprocess, "run", return_value=completed(envelope)):
                payload = dingtalk_minutes.run_dws(("minutes", "+list-all", "--page-all"))
            for failure in failures:
                with mock.patch.object(dingtalk_minutes.subprocess, "run", return_value=completed(failure)):
                    with self.assertRaises(dingtalk_minutes.DingTalkCommandError):
                        dingtalk_minutes.run_dws(("minutes", "+list-all", "--page-all"))

        self.assertEqual(payload["data"], {"minutes": []})

    def test_data_minutes_envelope_stays_blocked_without_reading_content(self) -> None:
        runner = FakeRunner(
            {
                "ok": True,
                "outcome": "success",
                "data": {
                    "complete": True,
                    "scope": "all",
                    "minutes": [
                        {"taskUuid": "mine-task", "title": "不得输出的会议标题", "url": "https://example.invalid/m"},
                        {"title": "缺少标识"},
                    ],
                },
            }
        )

        report = self.sync(runner)
        private_state = json.loads(self.state_path.read_text(encoding="utf-8"))

        self.assertEqual(report["status"], "blocked-capability")
        self.assertEqual(report["limitation"]["code"], "MISSING_COMPLETE_PARTICIPANT_MEMBERSHIP")
        self.assertEqual(
            report["counts"],
            {"scanned": 2, "excluded": 0, "inaccessible": 0, "processed": 0, "failed": 1},
        )
        self.assertNotIn("不得输出的会议标题", json.dumps(report, ensure_ascii=False))
        self.assertNotIn("不得输出的会议标题", json.dumps(private_state, ensure_ascii=False))
        self.assertEqual(
            [item["accessStatus"] for item in private_state["records"]], ["blocked-capability"]
        )

    def test_blocks_without_membership_and_excludes_before_any_content_read(self) -> None:
        home = str(Path.home())
        self.exclusions_path.parent.mkdir(parents=True)
        self.exclusions_path.write_text(
            json.dumps(
                {
                    "excluded": [
                        {"taskUuid": "excluded-task", "note": f"private {home}/meeting"}
                    ]
                }
            ),
            encoding="utf-8",
        )
        runner = FakeRunner(
            {
                "success": True,
                "result": [
                    {
                        "taskUuid": "excluded-task",
                        "title": "不得泄露的排除会议",
                        "startTime": "2026-10-08T08:00:00Z",
                        "status": "FINISHED",
                        "url": "https://example.invalid/excluded?token=secret-token",
                    },
                    {
                        "taskUuid": "candidate-task",
                        "title": "不得冒充参与关系的可访问会议",
                        "startTime": "2026-10-08T09:00:00Z",
                        "status": "FINISHED",
                        "participants": ["private@example.com"],
                        "summary": "正文绝不能读取或输出",
                    },
                ],
            }
        )

        report = self.sync(runner)
        persisted_report = json.loads(self.output_path.read_text(encoding="utf-8"))
        private_state = json.loads(self.state_path.read_text(encoding="utf-8"))

        self.assertEqual(runner.commands, (("minutes", "+list-all", "--page-all"),))
        self.assertEqual(report, persisted_report)
        self.assertEqual(report["status"], "blocked-capability")
        self.assertFalse(report["complete"])
        self.assertEqual(
            report["limitation"]["code"], "MISSING_COMPLETE_PARTICIPANT_MEMBERSHIP"
        )
        self.assertEqual(
            report["counts"],
            {"scanned": 2, "excluded": 1, "inaccessible": 0, "processed": 0, "failed": 0},
        )
        serialized_report = json.dumps(report, ensure_ascii=False)
        for secret in (
            "不得泄露的排除会议",
            "不得冒充参与关系的可访问会议",
            "private@example.com",
            "正文绝不能读取或输出",
            "secret-token",
            home,
            "excluded-task",
            "candidate-task",
        ):
            self.assertNotIn(secret, serialized_report)
        self.assertEqual(
            {item["taskUuid"]: item["accessStatus"] for item in private_state["records"]},
            {"excluded-task": "excluded", "candidate-task": "blocked-capability"},
        )
        self.assertNotIn("note", json.dumps(private_state, ensure_ascii=False))

    def test_atomically_persists_unicode_safe_incremental_state(self) -> None:
        self.state_path.parent.mkdir(parents=True)
        self.state_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "records": [
                        {
                            "taskUuid": "previous-task",
                            "serverUpdatedAt": None,
                            "contentFingerprint": None,
                            "lastProcessedAt": None,
                            "accessStatus": "blocked-capability",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        runner = FakeRunner(
            {
                "success": True,
                "result": [
                    {
                        "taskUuid": "new\ud83d-task",
                        "title": "private\ud83dtitle",
                        "startTime": "2026-10-08T09:00:00Z",
                        "status": "FINISHED",
                        "url": "https://example.invalid/private",
                    }
                ],
            }
        )

        report = self.sync(runner)
        persisted_state = json.loads(self.state_path.read_bytes().decode("utf-8"))

        self.assertEqual(report["counts"]["inaccessible"], 1)
        self.assertEqual(persisted_state["cursor"], None)
        self.assertEqual(
            set(persisted_state["records"][0]),
            {
                "taskUuid",
                "serverUpdatedAt",
                "contentFingerprint",
                "lastProcessedAt",
                "accessStatus",
            },
        )
        statuses = {item["taskUuid"]: item["accessStatus"] for item in persisted_state["records"]}
        self.assertEqual(statuses["previous-task"], "inaccessible")
        self.assertEqual(statuses["new�-task"], "blocked-capability")
        self.assertNotIn("private�title", json.dumps(persisted_state, ensure_ascii=False))
        self.assertFalse(any(self.state_path.parent.glob(".*.tmp")))


if __name__ == "__main__":
    unittest.main()
