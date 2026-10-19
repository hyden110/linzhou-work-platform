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
        # 2026-10-19 真实样本：task list 投影在 result.todoCards，状态用 --status 分桶。
        commands["todos_pending"]: {"ok": True, "outcome": "success", "result": {"todoCards": [
            {"taskId": "t1", "subject": "补方案", "priority": 40,
             "dueTime": 1760500000000, "createdTime": 1760400000000, "finalStatusStage": 0}]}},
        commands["todos_done"]: {"ok": True, "outcome": "success", "result": {"todoCards": [
            {"taskId": "t2", "subject": "已完成事项", "priority": 20,
             "dueTime": 1760600000000, "createdTime": 1760300000000, "finalStatusStage": 2}]}},
        crm_snapshot.TODO_DETAIL_PREFIX + ("t2",): {"result": {"todoDetailModel": {
            "taskId": "t2", "subject": "已完成事项", "isDone": True, "finishTime": 1760700000000,
            "dueTime": 1760600000000, "executorIds": ["u1"]}}},
        # Shape read back from dws on 2026-10-15: pagination that cannot be proven
        # complete exits 1 with `complete:false` while still listing every group.
        commands["groups"]: {"complete": False, "count": 2, "failedCount": 1, "failures": [
            {"error": "我的群列表下层未返回可靠的 hasMore，无法证明结果完整", "page": 6, "stage": "pagination"}],
            "groups": [
                {"conversationId": "cidA==", "memberCount": 16891, "name": "示例科技铁三角", "type": "INTERNAL_GROUP",
                 "secretPreview": "drop me"},
                {"conversationId": "cidB==", "memberCount": 12, "name": "内部闲聊群", "type": "NORMAL_GROUP"}]},
        commands["mentions"]: {"complete": True, "count": 1, "truncated": False, "items": [
            {"conversation": {"name": "示例科技铁三角", "openConversationId": "cidA=="},
             "conversationId": "cidA==", "messageId": "msgX==", "sender": "同事甲",
             "text": "x" * 200, "time": "2026-10-15 09:44:29", "contentExtra": "drop me"},
            {"conversationId": "cidA==", "sender": "同事乙", "text": "缺 messageId 必须被丢弃"}]},
        commands["unread"]: {"conversations": [
            {"conversationId": "cidA==", "name": "示例科技铁三角"},
            {"conversationId": "cidC==", "name": "未读群"}]},
    }


class FakeDws:
    def __init__(self, payloads: dict[tuple[str, ...], dict[str, object]]) -> None:
        self.payloads = payloads

    def __call__(self, arguments: tuple[str, ...]) -> dict[str, object]:
        if arguments not in self.payloads:
            raise AssertionError(f"unexpected dws command {arguments!r}")
        return self.payloads[arguments]


def kunpeng_ok(arguments: tuple[str, ...]) -> object:
    if arguments[0] == "customers":
        return {"success": True, "total": 1, "rows": [{
            "cid": "1001", "name": "示例科技有限公司", "bizCategoryInfo": {"name": "互联网"},
            "extLastMonthGaap": "12,345.6", "extGaapD": 400, "extGaapDRate": -0.4079,
            "extGaapDDiff": "-165.4",
            "customers": [{"secret": "should not leak"}]}]}
    if arguments[0] == "overview":
        # Shape read back from 鲲鹏 on 2026-10-15: the real number sits in `data`
        # (the `value` field mirrors the metric id); a null `data` means no number.
        return {"metrics": [], "values": [
            {"id": 25, "value": "25", "data": 35, "label": "客户数", "unitName": "个", "categoryCodeName": None},
            {"id": 26, "value": "26", "data": 257705.93, "label": "昨日GAAP", "unitName": "元", "categoryCodeName": "支付口径"},
            {"id": 27, "value": "27", "data": 96868.05, "label": "日GAAP环比涨跌额", "unitName": "元", "categoryCodeName": "支付口径"},
            {"id": 28, "value": "28", "data": 60.23, "label": "日GAAP环比", "unitName": "%", "categoryCodeName": "支付口径"},
            {"id": 31, "value": "31", "data": None, "label": "日GAAP环比（混合云）", "unitName": "%", "categoryCodeName": None},
        ]}
    if arguments[0] == "top":
        return {
            "view": {"id": 186, "name": "全部客户"},
            "orderBy": "extLastMonthGaap-DESC", "metric": "last_month_gaap", "limit": 10,
            "total": 35, "queriedAt": "2026-10-15 13:53:51",
            "checks": {"countWithinLimit": True, "gaapMonotonicDesc": True},
            "items": [
                {"rank": 1, "name": "示例科技", "cid": 1001, "industry": "互联网", "area": "浙江省/杭州市",
                 "gcLevel": "GC7", "lastMonthGaap": 2491393.74, "yesterdayGaap": 69888.41},
            ],
        }
    if arguments[0] == "mygroups":
        return [
            {"id": 64, "name": "我的客户", "views": [
                {"id": 186, "name": "全部客户", "cidCount": 35},
                {"id": 187, "name": "商务关联客户", "cidCount": 0},
                {"id": 14156, "name": "待我交接的客户", "cidCount": 0},
            ]},
        ]
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
        self.assertEqual(
            set(crm_snapshot.SECTIONS),
            {"agenda", "todos", "groups", "mentions", "unread",
             "customers", "projects", "overview", "top", "mygroups"},
        )
        for name in crm_snapshot.SECTIONS:
            self.assertIn(name, snapshot)
        customer = snapshot["customers"][0]
        self.assertEqual(customer["industry"], "互联网")
        self.assertEqual(customer["lastMonthGaap"], 12345.6)
        self.assertEqual(customer["yesterdayGaapRate"], -40.79)
        # 昨日环比涨跌额投影（extGaapDDiff），旧快照无此字段时前端按 rate 反推。
        self.assertEqual(customer["yesterdayGaapDiff"], -165.4)
        self.assertNotIn("customers", customer)
        project = snapshot["projects"][0]
        self.assertEqual((project["id"], project["name"], project["cate"]), ("P123", "示例大模型 POC", "公有云"))
        self.assertNotIn("businessManager", project)
        self.assertNotIn("should not leak", self.output.read_text(encoding="utf-8"))
        self.assertNotIn("某同学", self.output.read_text(encoding="utf-8"))
        self.assertNotIn("drop me", self.output.read_text(encoding="utf-8"))

    def test_overview_skips_metrics_without_data(self) -> None:
        overview = self.build()["overview"]
        labels = [metric["label"] for metric in overview]
        self.assertIn("客户数", labels)
        self.assertNotIn("日GAAP环比（混合云）", labels)
        gaap = next(metric for metric in overview if metric["id"] == "26")
        self.assertEqual(gaap["value"], 257705.93)
        self.assertEqual(gaap["category"], "支付口径")

    def test_top_is_queried_and_carries_kunpeng_self_checks(self) -> None:
        calls: list[tuple[str, ...]] = []

        def kunpeng(arguments: tuple[str, ...]) -> object:
            calls.append(arguments)
            return kunpeng_ok(arguments)

        snapshot = self.build(kunpeng=kunpeng)
        self.assertIn(("top", "--limit", str(crm_snapshot.TOP_LIMIT), "--metric", "last_month_gaap"), calls)
        source = snapshot["sources"]["top"]
        self.assertIs(source["checks"]["gaapMonotonicDesc"], True)
        self.assertIs(source["checks"]["countWithinLimit"], True)
        self.assertEqual(source["orderBy"], "extLastMonthGaap-DESC")
        self.assertEqual(source["queriedAt"], "2026-10-15 13:53:51")
        self.assertEqual(snapshot["top"][0]["rank"], 1)
        self.assertEqual(snapshot["top"][0]["cid"], "1001")

    def test_top_failed_self_check_is_preserved_not_silently_passed(self) -> None:
        def kunpeng(arguments: tuple[str, ...]) -> object:
            payload = kunpeng_ok(arguments)
            if arguments[0] == "top":
                assert isinstance(payload, dict)
                payload["checks"] = {"countWithinLimit": True, "gaapMonotonicDesc": False}
            return payload

        source = self.build(kunpeng=kunpeng)["sources"]["top"]
        self.assertIs(source["checks"]["gaapMonotonicDesc"], False)

    def test_mygroups_flattens_views_with_counts(self) -> None:
        mygroups = self.build()["mygroups"]
        self.assertEqual([view["id"] for view in mygroups], ["186", "187", "14156"])
        self.assertEqual(mygroups[0]["count"], 35)
        self.assertEqual(mygroups[0]["group"], "我的客户")

    def test_live_project_rows_use_separate_id_and_name(self) -> None:
        # `projects --state normal` returned projectId (int) + projectName on 2026-10-14,
        # without projectNameAndId; ids must stay unique so the UI keys are stable.
        def kunpeng(arguments: tuple[str, ...]) -> object:
            if arguments[0] == "customers":
                return {"success": True, "total": 0, "rows": []}
            if arguments[0] == "projects":
                return {"success": True, "total": 2, "rows": [
                    {"projectId": 9001, "projectName": "甲项目", "cid": 1001},
                    {"projectId": 9002, "projectName": "乙项目", "cid": 1001}]}
            return kunpeng_ok(arguments)

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
        self.assertEqual(snapshot["sources"]["overview"]["status"], "auth_required")
        self.assertEqual(snapshot["overview"][0]["label"], "客户数")
        self.assertEqual(snapshot["top"][0]["rank"], 1)
        self.assertEqual(snapshot["mygroups"][0]["id"], "186")

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

    def test_group_pagination_gap_is_partial_not_ok(self) -> None:
        snapshot = self.build()
        source = snapshot["sources"]["groups"]
        self.assertEqual(source["status"], "partial")
        self.assertFalse(source["complete"])
        self.assertEqual(source["count"], 2)
        self.assertEqual(snapshot["groups"][0],
                         {"id": "cidA==", "name": "示例科技铁三角", "type": "INTERNAL_GROUP", "memberCount": 16891})

    def test_mentions_truncate_text_and_drop_items_without_id(self) -> None:
        snapshot = self.build()
        mentions = snapshot["mentions"]
        self.assertEqual(len(mentions), 1)
        self.assertEqual(len(mentions[0]["text"]), crm_snapshot.MENTION_TEXT_LIMIT)
        self.assertEqual(mentions[0]["conversationName"], "示例科技铁三角")
        self.assertEqual(mentions[0]["sender"], "同事甲")
        self.assertEqual(mentions[0]["time"], "2026-10-15 09:44:29")
        self.assertNotIn("contentExtra", mentions[0])

    def test_unread_keeps_identifier_and_name_only(self) -> None:
        unread = self.build()["unread"]
        self.assertEqual(unread[0], {"id": "cidA==", "name": "示例科技铁三角"})
        self.assertEqual(len(unread), 2)

    def test_todos_project_status_and_completion_time(self) -> None:
        snapshot = self.build()
        pending, done = snapshot["todos"]
        self.assertEqual(pending, {
            "id": "t1", "title": "补方案", "priority": 40, "dueAt": 1760500000000,
            "done": False, "createdAt": 1760400000000, "finishedAt": None,
        })
        self.assertEqual(done["id"], "t2")
        self.assertIs(done["done"], True)
        self.assertEqual(done["finishedAt"], 1760700000000)
        self.assertEqual(snapshot["sources"]["todos"]["status"], "ok")
        self.assertEqual(snapshot["sources"]["todos"]["pendingCount"], 1)
        self.assertEqual(snapshot["sources"]["todos"]["doneCount"], 1)
        self.assertFalse(snapshot["sources"]["todos"]["pendingTruncated"])
        self.assertFalse(snapshot["sources"]["todos"]["doneTruncated"])
        self.assertEqual(snapshot["sources"]["todos"]["listLimit"], crm_snapshot.TODO_LIST_SIZE)

    def test_todos_full_pending_page_is_partial(self) -> None:
        payloads = dws_payloads()
        size = crm_snapshot.TODO_LIST_SIZE
        payloads[crm_snapshot.DWS_COMMANDS["todos_pending"]] = {
            "ok": True, "outcome": "success", "result": {"todoCards": [
                {"taskId": f"p{index:04d}", "subject": f"合成待办 {index}", "priority": 10,
                 "dueTime": 1760500000000, "createdTime": 1760400000000}
                for index in range(size)
            ]},
        }
        snapshot = self.build(dws=FakeDws(payloads))
        source = snapshot["sources"]["todos"]

        self.assertEqual(source["status"], "partial")
        self.assertFalse(source["complete"])
        self.assertTrue(source["pendingTruncated"])
        self.assertFalse(source["doneTruncated"])
        self.assertEqual(source["pendingCount"], size)
        self.assertEqual(source["listLimit"], size)

    def test_todos_full_done_page_is_partial(self) -> None:
        payloads = dws_payloads()
        size = crm_snapshot.TODO_LIST_SIZE
        done_cards = [
            {"taskId": f"d{index:04d}", "subject": f"合成已完成 {index}", "priority": 10,
             "dueTime": 1760600000000, "createdTime": 1760300000000}
            for index in range(size)
        ]
        payloads[crm_snapshot.DWS_COMMANDS["todos_done"]] = {
            "ok": True, "outcome": "success", "result": {"todoCards": done_cards},
        }
        for card in done_cards:
            payloads[crm_snapshot.TODO_DETAIL_PREFIX + (card["taskId"],)] = {
                "result": {"todoDetailModel": {
                    "taskId": card["taskId"], "isDone": True, "finishTime": 1760700000000,
                }},
            }
        snapshot = self.build(dws=FakeDws(payloads))
        source = snapshot["sources"]["todos"]

        self.assertEqual(source["status"], "partial")
        self.assertFalse(source["complete"])
        self.assertFalse(source["pendingTruncated"])
        self.assertTrue(source["doneTruncated"])
        self.assertEqual(source["detailsFailed"], 0)
        self.assertEqual(source["doneCount"], size)

    def test_todo_detail_failure_is_partial_not_fabricated(self) -> None:
        payloads = dws_payloads()
        payloads.pop(crm_snapshot.TODO_DETAIL_PREFIX + ("t2",))

        def dws(arguments: tuple[str, ...]) -> dict[str, object]:
            if arguments not in payloads:
                raise crm_snapshot.SourceError("error", "dws_not_success")
            return payloads[arguments]

        snapshot = self.build(dws=dws)
        source = snapshot["sources"]["todos"]
        self.assertEqual(source["status"], "partial")
        self.assertEqual(source["detailsFailed"], 1)
        done = snapshot["todos"][1]
        self.assertIs(done["done"], True)
        self.assertIsNone(done["finishedAt"])

    def test_run_dws_allows_only_validated_todo_detail_reads(self) -> None:
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout='{"result": {}}', stderr="")
        with mock.patch.object(crm_snapshot.shutil, "which", return_value="/usr/bin/dws"), mock.patch.object(
            crm_snapshot.subprocess, "run", return_value=completed
        ) as run:
            crm_snapshot.run_dws(("todo", "task", "get", "--task-id", "taskSynthetic001"))
        self.assertIn("todo", run.call_args.args[0])
        for command in (
            ("todo", "task", "get", "--task-id", "a;rm -rf /"),
            ("todo", "task", "delete", "--task-id", "1"),
            ("todo", "+create", "--title", "x", "--executors", "u"),
        ):
            with self.assertRaises(crm_snapshot.SourceError):
                crm_snapshot.run_dws(command)

    def test_run_dws_returns_payload_on_nonzero_exit_without_error_envelope(self) -> None:
        # `chat +my-groups` exits 1 while printing the groups; the partial flag must survive.
        completed = subprocess.CompletedProcess(
            args=[], returncode=1,
            stdout=json.dumps({"complete": False, "count": 2, "failedCount": 1,
                               "groups": [{"conversationId": "cidA==", "name": "群"}]}),
            stderr="",
        )
        with mock.patch.object(crm_snapshot.shutil, "which", return_value="/usr/bin/dws"), mock.patch.object(
            crm_snapshot.subprocess, "run", return_value=completed
        ):
            payload = crm_snapshot.run_dws(crm_snapshot.DWS_COMMANDS["groups"])
        self.assertEqual(payload["count"], 2)
        self.assertIs(payload["complete"], False)

    def test_run_dws_nonzero_exit_without_json_still_fails(self) -> None:
        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="")
        with mock.patch.object(crm_snapshot.shutil, "which", return_value="/usr/bin/dws"), mock.patch.object(
            crm_snapshot.subprocess, "run", return_value=completed
        ):
            with self.assertRaises(crm_snapshot.SourceError) as caught:
                crm_snapshot.run_dws(crm_snapshot.DWS_COMMANDS["unread"])
        self.assertEqual(caught.exception.code, "dws_exit_1")

    def test_customer_paging_stops_at_total(self) -> None:
        calls: list[tuple[str, ...]] = []

        def kunpeng(arguments: tuple[str, ...]) -> object:
            calls.append(arguments)
            if arguments[0] == "projects":
                return {"success": True, "total": 0, "rows": []}
            if arguments[0] == "customers":
                rows = [{"cid": f"{arguments[-1]}-{i}"} for i in range(crm_snapshot.CUSTOMER_PAGE_SIZE)]
                return {"success": True, "total": crm_snapshot.CUSTOMER_PAGE_SIZE * 2, "rows": rows}
            return kunpeng_ok(arguments)

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
                crm_snapshot.run_dws(crm_snapshot.DWS_COMMANDS["todos_pending"])
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
