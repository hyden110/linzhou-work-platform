from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sync import crm_snapshot


def dws_payloads() -> dict[tuple[str, ...], dict[str, object]]:
    commands = crm_snapshot.DWS_COMMANDS
    return {
        commands["agenda"]: {"ok": True, "outcome": "success", "data": {"complete": True, "events": [
            {"eventId": "e1", "title": "客户周会", "start": "2026-10-14 09:30", "end": "2026-10-14 10:00"}]}},
        commands["todos"]: {"ok": True, "outcome": "success", "data": {"tasks": [
            {"taskId": "t1", "title": "补方案", "priority": 40, "planFinishDate": 1760500000000}]}},
    }


class FakeDws:
    def __init__(self, payloads: dict[tuple[str, ...], dict[str, object]]) -> None:
        self.payloads = payloads

    def __call__(self, arguments: tuple[str, ...]) -> dict[str, object]:
        if arguments not in self.payloads:
            raise AssertionError(f"unexpected dws command {arguments!r}")
        return self.payloads[arguments]


def kunpeng_ok(arguments: tuple[str, ...]) -> dict[str, object]:
    if arguments[0] == "customers":
        return {"success": True, "total": 1, "rows": [{
            "cid": "1001", "name": "示例科技有限公司", "bizCategoryInfo": {"name": "互联网"},
            "extLastMonthGaap": "12,345.6", "extGaapD": 400, "extGaapDRate": -0.4079,
            "customers": [{"secret": "should not leak"}]}]}
    # Shapes and encodings read back from 鲲鹏 on 2026-10-14: rate is a decimal
    # ratio, winRate and projectStatus are enum codes, dates are epoch millis.
    return {"success": True, "total": 1, "rows": [{
        "projectNameAndId": "示例大模型 POC(P123)", "customerName": "示例科技有限公司", "cid": 1001,
        "projectStage": 3, "projectStageNameCn": "技术方案", "projectPrice": "50000",
        "projectCate": 1, "projectStatus": "PROJECT_STATE_NORMAL", "winRate": "PROJECT_WINRATE_50",
        "gmtCreate": 1791541673000, "expectedGaapStartDate": 1793462400000,
        "businessManager": "某同学"}]}


def kunpeng_logged_out(arguments: tuple[str, ...]) -> dict[str, object]:
    raise crm_snapshot.SourceError("auth_required", "kunpeng_login_required")


class CrmSnapshotTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.output = Path(self.temp_dir.name) / "crm-snapshot.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def build(self, dws=None, kunpeng=kunpeng_ok, now="2026-10-14T00:30:00Z"):
        return crm_snapshot.build_snapshot(
            output_path=self.output, dws=dws or FakeDws(dws_payloads()), kunpeng=kunpeng, now=lambda: now)

    def test_projects_only_safe_fields(self) -> None:
        snapshot = self.build()
        self.assertEqual(set(crm_snapshot.SECTIONS), {"agenda", "todos", "customers", "projects"})
        self.assertNotIn("groups", snapshot)
        customer = snapshot["customers"][0]
        self.assertEqual(customer["industry"], "互联网")
        self.assertEqual(customer["lastMonthGaap"], 12345.6)
        self.assertEqual(customer["yesterdayGaapRate"], -40.79)
        self.assertNotIn("customers", customer)
        project = snapshot["projects"][0]
        self.assertEqual((project["id"], project["name"], project["cate"]), ("P123", "示例大模型 POC", "公有云"))
        self.assertNotIn("businessManager", project)
        self.assertNotIn("should not leak", self.output.read_text(encoding="utf-8"))
        self.assertNotIn("某同学", self.output.read_text(encoding="utf-8"))

    def test_live_project_rows_use_separate_id_and_name(self) -> None:
        # `projects --state normal` returned projectId (int) + projectName on 2026-10-14,
        # without projectNameAndId; ids must stay unique so the UI keys are stable.
        def kunpeng(arguments: tuple[str, ...]) -> dict[str, object]:
            if arguments[0] == "customers":
                return {"success": True, "total": 0, "rows": []}
            return {"success": True, "total": 2, "rows": [
                {"projectId": 9001, "projectName": "甲项目", "cid": 1001},
                {"projectId": 9002, "projectName": "乙项目", "cid": 1001}]}

        projects = self.build(kunpeng=kunpeng)["projects"]
        self.assertEqual([(p["id"], p["name"]) for p in projects], [("9001", "甲项目"), ("9002", "乙项目")])

    def test_kunpeng_encodings_are_normalised(self) -> None:
        project = self.build()["projects"][0]
        self.assertEqual(project["stage"], "3")
        self.assertEqual(project["stageName"], "技术方案")
        self.assertEqual(project["state"], "PROJECT_STATE_NORMAL")
        self.assertEqual(project["winRate"], 50)
        self.assertEqual(project["createdAt"], "2026-10-09T10:27:53Z")
        self.assertEqual(project["expectedGaapStartDate"], "2026-10-31T16:00:00Z")
        self.assertEqual(self.build()["customers"][0]["yesterdayGaapRate"], -40.79)

    def test_kunpeng_login_required_keeps_previous_rows(self) -> None:
        self.build()
        snapshot = self.build(kunpeng=kunpeng_logged_out, now="2026-10-15T00:30:00Z")
        source = snapshot["sources"]["customers"]
        self.assertEqual(source["status"], "auth_required")
        self.assertEqual(source["lastSuccessAt"], "2026-10-14T00:30:00Z")
        self.assertTrue(source["stale"])
        self.assertEqual(snapshot["customers"][0]["cid"], "1001")
        self.assertEqual(snapshot["sources"]["agenda"]["status"], "ok")

    def test_first_run_logged_out_has_no_fake_rows(self) -> None:
        snapshot = self.build(kunpeng=kunpeng_logged_out)
        self.assertEqual(snapshot["customers"], [])
        self.assertEqual(snapshot["projects"], [])
        self.assertIsNone(snapshot["sources"]["projects"]["lastSuccessAt"])

    def test_unsuccessful_dws_payload_marks_error(self) -> None:
        payloads = dws_payloads()
        payloads[crm_snapshot.DWS_COMMANDS["agenda"]] = {"ok": False, "outcome": "error"}
        snapshot = self.build(dws=FakeDws(payloads))
        self.assertEqual(snapshot["sources"]["agenda"]["error"], "dws_not_success")
        self.assertEqual(snapshot["sources"]["todos"]["status"], "ok")

    def test_customer_paging_stops_at_total(self) -> None:
        calls: list[tuple[str, ...]] = []

        def kunpeng(arguments: tuple[str, ...]) -> dict[str, object]:
            calls.append(arguments)
            if arguments[0] == "projects":
                return {"success": True, "total": 0, "rows": []}
            rows = [{"cid": f"{arguments[-1]}-{i}"} for i in range(crm_snapshot.CUSTOMER_PAGE_SIZE)]
            return {"success": True, "total": crm_snapshot.CUSTOMER_PAGE_SIZE * 2, "rows": rows}

        snapshot = self.build(kunpeng=kunpeng)
        self.assertEqual(len(snapshot["customers"]), crm_snapshot.CUSTOMER_PAGE_SIZE * 2)
        self.assertEqual(sum(call[0] == "customers" for call in calls), 2)

    def test_run_dws_rejects_unlisted_command(self) -> None:
        with self.assertRaises(crm_snapshot.SourceError):
            crm_snapshot.run_dws(("chat", "message", "send"))

    def test_run_dws_uses_no_shell(self) -> None:
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout='{"ok": true}', stderr="")
        with mock.patch.object(crm_snapshot.shutil, "which", return_value="/usr/bin/dws"), mock.patch.object(
            crm_snapshot.subprocess, "run", return_value=completed
        ) as run:
            crm_snapshot.run_dws(crm_snapshot.DWS_COMMANDS["agenda"])
        self.assertEqual(run.call_args.args[0], ["/usr/bin/dws", "calendar", "+week", "--format", "json"])
        self.assertIs(run.call_args.kwargs["shell"], False)

    def test_run_dws_reports_upstream_failure_instead_of_partial_data(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[], returncode=1,
            stdout=json.dumps({"ok": False, "outcome": "failure",
                               "error": {"upstream_code": "RATE_LIMIT_ERROR"}}),
            stderr="{}",
        )
        with mock.patch.object(crm_snapshot.shutil, "which", return_value="/usr/bin/dws"), mock.patch.object(
            crm_snapshot.subprocess, "run", return_value=completed
        ):
            with self.assertRaises(crm_snapshot.SourceError) as caught:
                crm_snapshot.run_dws(crm_snapshot.DWS_COMMANDS["todos"])
        self.assertEqual(caught.exception.code, "dws_rate_limit_error")

    def test_run_kunpeng_maps_cookie_exit_to_auth_required(self) -> None:
        completed = subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr='{"error":"cookie"}')
        with mock.patch.object(crm_snapshot, "KUNPENG_UV", Path(__file__)), mock.patch.object(
            crm_snapshot, "KUNPENG_SKILL_DIR", Path(__file__).parent
        ), mock.patch.object(Path, "exists", return_value=True), mock.patch.object(
            crm_snapshot.subprocess, "run", return_value=completed
        ):
            with self.assertRaises(crm_snapshot.SourceError) as caught:
                crm_snapshot.run_kunpeng(("customers", "--size", "200", "--page", "1"))
        self.assertEqual(caught.exception.status, "auth_required")

    def test_run_kunpeng_rejects_injection(self) -> None:
        for arguments in (("info", "1"), ("customers", "--kw", "a;rm")):
            with self.assertRaises(crm_snapshot.SourceError):
                crm_snapshot.run_kunpeng(arguments)

    def test_snapshot_is_valid_json_on_disk(self) -> None:
        self.build()
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8"))["schemaVersion"], 1)


if __name__ == "__main__":
    unittest.main()
