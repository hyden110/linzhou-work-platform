from __future__ import annotations

import json
import unittest
import unittest.mock
from datetime import datetime
from pathlib import Path

from sync import ppl_daily_report as ppl

FIXTURE_NOW = datetime(2026, 10, 16, 9, 15)

# 全合成 fixture：客户全名/CID/项目名均为示例值，不与真实快照 crm-snapshot.json 对应。
CUST_A = "山东示例公司A数字科技有限公司"
CUST_B = "示例公司B科技有限公司"
CUST_C = "青岛示例公司C信息技术有限公司"
CID_A = "990000001"
CID_B = "990000002"
CID_C = "990000003"

PROJECT_A_QW = "FY27-Q3-山东示例公司A数字科技有限公司-千问办公"
PROJECT_C_TY = "FY27-Q3-青岛示例公司C信息技术有限公司-智算-通义"
PROJECT_OTHER = "FY26Q2-示例公司D-一方示例"


def make_snapshot(**overrides: object) -> dict[str, object]:
    snapshot: dict[str, object] = {
        "schemaVersion": 1,
        "generatedAt": "2026-10-15T06:41:13Z",
        "customers": [
            {"cid": CID_A, "name": CUST_A},
            {"cid": CID_B, "name": CUST_B},
            {"cid": CID_C, "name": CUST_C},
        ],
        "projects": [
            {"id": "910000001", "name": PROJECT_A_QW, "customerName": CUST_A, "cid": CID_A},
            {"id": "910000002", "name": PROJECT_C_TY, "customerName": CUST_C, "cid": CID_C},
            {"id": "910000003", "name": PROJECT_OTHER, "customerName": "示例公司D", "cid": "990000009"},
        ],
    }
    snapshot.update(overrides)
    return snapshot


def make_report(content: str, date: str = "2026-10-16 08:12") -> dict[str, object]:
    return {"title": "示例日报", "date": date, "content": content}


class NormalizeTests(unittest.TestCase):
    def test_normalize_strips_fy_prefix_spaces_and_punctuation(self) -> None:
        self.assertEqual(ppl.normalize_name("FY27-Q3-示例公司A -qoder项目"), "示例公司aqoder项目")
        self.assertEqual(ppl.normalize_name("【示例】(2026-10-16)"), "示例")


class CustomerAliasTests(unittest.TestCase):
    def test_alias_generation_and_matching(self) -> None:
        aliases = ppl.customer_aliases(CUST_A)
        self.assertIn("示例公司a", aliases)
        text = "一、跟进：- 示例公司A：PPU 训练对齐"
        hits = ppl.match_customers(text, [{"cid": CID_A, "name": CUST_A}])
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["cid"], CID_A)

    def test_group_shorthand_does_not_match_unrelated_customer(self) -> None:
        # 集团简称不映射到具体子公司：宁可漏报不可误报
        hits = ppl.match_customers("某集团 - 千问办公沟通", [{"cid": CID_C, "name": CUST_C}])
        self.assertEqual(hits, [])


class SegmentationTests(unittest.TestCase):
    """返工 #1：多客户日报按客户分段，绝不跨段取值。"""

    def test_dual_customer_report_segments_amounts_independently(self) -> None:
        snapshot = make_snapshot()
        reports = [make_report(
            "- 示例公司A：千问办公推进，预计 50 万元\n"
            "- 示例公司B：GPU 算力测试，预计投入 30 万元\n"
            "二、下周计划\n"
            "- 完成选型"
        )]
        inspection = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)
        by_customer = {r["customerName"]: r for r in inspection["recommendations"]}
        self.assertEqual(set(by_customer), {CUST_A, CUST_B})
        self.assertEqual(by_customer[CUST_A]["amountYuan"], 500000)
        self.assertEqual(by_customer[CUST_A]["opportunityType"], "智算-通义")
        self.assertEqual(by_customer[CUST_B]["amountYuan"], 300000)
        self.assertEqual(by_customer[CUST_B]["opportunityType"], "智算-GPU")
        # 节标题后的无主内容不串入任何客户段落
        self.assertNotIn("完成选型", by_customer[CUST_A]["changeNote"] or "")
        self.assertNotIn("完成选型", by_customer[CUST_B]["changeNote"] or "")

    def test_amount_missing_in_segment_stays_blocked_no_cross_share(self) -> None:
        # A 段无金额、B 段有金额：B 的金额绝不解除 A 的 blocked
        snapshot = make_snapshot()
        reports = [make_report(
            "- 示例公司A：千问办公推进\n"
            "- 示例公司B：GPU 测试，预计 30 万元"
        )]
        inspection = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)
        by_customer = {r["customerName"]: r for r in inspection["recommendations"]}
        self.assertIsNone(by_customer[CUST_A]["amountYuan"])
        self.assertTrue(by_customer[CUST_A]["blocked"])
        self.assertEqual(by_customer[CUST_A]["blockReason"], "amount_missing")
        self.assertEqual(by_customer[CUST_B]["amountYuan"], 300000)
        self.assertFalse(by_customer[CUST_B]["blocked"])

    def test_indented_continuation_line_attaches_to_current_customer(self) -> None:
        snapshot = make_snapshot()
        reports = [make_report("- 示例公司B：GPU 算力测试\n  预计投入 30 万元")]
        inspection = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)
        self.assertEqual(len(inspection["recommendations"]), 1)
        item = inspection["recommendations"][0]
        self.assertEqual(item["customerName"], CUST_B)
        self.assertEqual(item["amountYuan"], 300000)
        self.assertFalse(item["blocked"])

    def test_realworld_single_line_inline_bullets_segment_correctly(self) -> None:
        # 真实钉钉日报格式回归：单行长段落、条目以「- 」内联分隔（含「- 客户名 - 内容」风格）。
        # 旧逻辑整行错配给命中的客户；分段后各客户只取自身 cell。
        snapshot = make_snapshot()
        reports = [make_report(
            "一、关键阶段目标跟进*：- 示例公司A - 同技术院长交流千问办公方案，预计 50 万元"
            " - 示例公司B：GPU 算力测试，预计投入 30 万元；图片：[]；附件：[]"
        )]
        inspection = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)
        by_customer = {r["customerName"]: r for r in inspection["recommendations"]}
        self.assertEqual(set(by_customer), {CUST_A, CUST_B})
        self.assertEqual(by_customer[CUST_A]["amountYuan"], 500000)
        self.assertEqual(by_customer[CUST_A]["opportunityType"], "智算-通义")
        self.assertEqual(by_customer[CUST_B]["amountYuan"], 300000)
        self.assertEqual(by_customer[CUST_B]["opportunityType"], "智算-GPU")
        # 各客户摘要只含自身内容，不串入对方关键词
        self.assertNotIn("GPU", by_customer[CUST_A]["changeNote"] or "")
        self.assertNotIn("技术院长", by_customer[CUST_B]["changeNote"] or "")
        # 尾部「图片/附件」标记不进入任何客户段落
        for item in by_customer.values():
            self.assertNotIn("图片", item["changeNote"] or "")

    def test_ambiguous_line_marks_segment_uncertain_and_takes_no_cross_values(self) -> None:
        # 一行同时提到两个客户 → 无法可靠分段 → 双双 blocked(segment_uncertain)，
        # 该行的金额绝不归属任何客户。
        snapshot = make_snapshot()
        reports = [make_report("- 与示例公司A、示例公司B召开联合会议，预计 100 万元")]
        inspection = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)
        recs = inspection["recommendations"]
        self.assertEqual(sorted(r["customerName"] for r in recs), sorted([CUST_A, CUST_B]))
        for item in recs:
            self.assertTrue(item["blocked"])
            self.assertEqual(item["blockReason"], "segment_uncertain")
            self.assertIsNone(item["amountYuan"])
            self.assertIsNone(item["changeNote"])


class DedupeThreeStateTests(unittest.TestCase):
    def test_three_states_each_present(self) -> None:
        snapshot = make_snapshot()
        reports = [
            # 已建：建议名与既有项目名归一化后吻合（示例公司C 智算-通义）
            make_report("- 示例公司C：千问办公推进，预计 50 万元"),
            # 疑似：示例公司A 既有千问办公项目，本次主题不同 → 人工判断
            make_report("- 示例公司A：qoder 项目推进，预计 120 万元"),
            # 未建：示例公司B 无任何项目
            make_report("- 示例公司B：GPU 算力测试，预计 30 万元"),
        ]
        inspection = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)
        statuses = sorted(r["dedupe"]["status"] for r in inspection["recommendations"])
        self.assertEqual(statuses, ["exists", "new", "suspected"])
        for expected in ("exists", "suspected", "new"):
            self.assertIn(expected, statuses, f"三分态缺少 {expected}")

    def test_dedupe_evidence_includes_project_name(self) -> None:
        snapshot = make_snapshot()
        reports = [make_report("- 示例公司C：千问办公推进，预计 50 万元")]
        inspection = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)
        exists = [r for r in inspection["recommendations"] if r["dedupe"]["status"] == "exists"]
        self.assertTrue(exists)
        evidence = exists[0]["dedupe"]["evidence"]
        self.assertEqual(evidence["projectName"], PROJECT_C_TY)
        self.assertEqual(evidence["projectId"], "910000002")

    def test_same_customer_different_topic_is_suspected_not_exists(self) -> None:
        # 同客户不同主题 → 降级疑似并附证据，绝不直接判已建
        snapshot = make_snapshot()
        reports = [make_report("- 示例公司A：qoder 项目推进，预计 120 万元")]
        inspection = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)
        item = inspection["recommendations"][0]
        self.assertEqual(item["dedupe"]["status"], "suspected")
        evidence_names = [e["projectName"] for e in item["dedupe"]["evidence"]]
        self.assertIn(PROJECT_A_QW, evidence_names)


class AmountAndBlockTests(unittest.TestCase):
    def test_amount_missing_marks_blocked_and_never_guessed(self) -> None:
        snapshot = make_snapshot()
        reports = [make_report("- 示例公司B：模型选型沟通")]  # 本客户段无金额
        inspection = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)
        self.assertEqual(len(inspection["recommendations"]), 1)
        item = inspection["recommendations"][0]
        self.assertIsNone(item["amountYuan"])
        self.assertTrue(item["blocked"])
        self.assertEqual(item["blockReason"], "amount_missing")

    def test_amount_extraction_with_wan_units(self) -> None:
        self.assertEqual(ppl.extract_amount_yuan("预计投入 120 万元"), 1_200_000.0)
        self.assertEqual(ppl.extract_amount_yuan("约 80万"), 800_000.0)
        self.assertEqual(ppl.extract_amount_yuan("预算 5,000 元"), 5000.0)
        self.assertIsNone(ppl.extract_amount_yuan("没有金额"))


class IdFingerprintTests(unittest.TestCase):
    """返工 #2：稳定 ID + 指纹防错套。"""

    def test_ids_and_fingerprints_are_content_derived_and_stable(self) -> None:
        snapshot = make_snapshot()
        reports = [make_report("- 示例公司B：GPU 算力测试，预计 30 万元")]
        first = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)["recommendations"]
        second = ppl.build_inspection(reports, snapshot, FIXTURE_NOW)["recommendations"]
        self.assertEqual([r["id"] for r in first], [r["id"] for r in second])
        self.assertEqual([r["fingerprint"] for r in first], [r["fingerprint"] for r in second])
        self.assertTrue(first[0]["id"].startswith("r"))
        self.assertNotEqual(first[0]["id"], first[0]["fingerprint"])

    def test_same_id_new_amount_changes_fingerprint(self) -> None:
        # 同客户同主题（id 基底不变）金额变化 → 指纹变化 → 旧决策不可复用
        snapshot = make_snapshot()
        base = ppl.build_inspection(
            [make_report("- 示例公司B：GPU 算力测试，预计 30 万元")], snapshot, FIXTURE_NOW,
        )["recommendations"][0]
        changed = ppl.build_inspection(
            [make_report("- 示例公司B：GPU 算力测试，预计 40 万元")], snapshot, FIXTURE_NOW,
        )["recommendations"][0]
        self.assertEqual(base["id"], changed["id"])
        self.assertNotEqual(base["fingerprint"], changed["fingerprint"])

    def test_different_topic_changes_id(self) -> None:
        snapshot = make_snapshot()
        base = ppl.build_inspection(
            [make_report("- 示例公司B：GPU 算力测试，预计 30 万元")], snapshot, FIXTURE_NOW,
        )["recommendations"][0]
        other = ppl.build_inspection(
            [make_report("- 示例公司B：千问办公推进，预计 30 万元")], snapshot, FIXTURE_NOW,
        )["recommendations"][0]
        self.assertNotEqual(base["id"], other["id"])


class StalenessTests(unittest.TestCase):
    def test_stale_snapshot_is_flagged_not_silent(self) -> None:
        snapshot = make_snapshot(generatedAt="2026-10-01T06:41:13Z")
        inspection = ppl.build_inspection([], snapshot, FIXTURE_NOW)
        self.assertTrue(inspection["snapshotStale"])

    def test_fresh_snapshot_not_stale(self) -> None:
        inspection = ppl.build_inspection([], make_snapshot(), FIXTURE_NOW)
        self.assertFalse(inspection["snapshotStale"])


class DwsWhitelistTests(unittest.TestCase):
    def test_rejects_non_report_commands(self) -> None:
        with self.assertRaises(ppl.SourceError):
            ppl.run_dws_report(["chat", "+messages-send-card", "--content", "x"])

    def test_rejects_unapproved_flags_and_values(self) -> None:
        with self.assertRaises(ppl.SourceError):
            ppl.run_dws_report(["report", "outbox", "list", "--cursor", "abc"])
        with self.assertRaises(ppl.SourceError):
            ppl.run_dws_report(["report", "outbox", "list", "--size", "999"])
        with self.assertRaises(ppl.SourceError):
            ppl.run_dws_report(["report", "outbox", "list", "--template-name", "日报"])


class ReportParsingTests(unittest.TestCase):
    def test_parse_reports_projects_chinese_keys_and_truncates(self) -> None:
        payload = {"count": 1, "result": [
            {"发送人": "示例", "日志内容": "内容" * 5000, "日期": "2026-10-16 08:12", "标题": "示例日报"},
            {"发送人": "示例", "日志内容": "  ", "日期": "x", "标题": "空内容丢弃"},
        ]}
        reports = ppl.parse_reports(payload)
        self.assertEqual(len(reports), 1)
        self.assertLessEqual(len(reports[0]["content"]), ppl.REPORT_MAX_CHARS)


class ZeroCreationGuaranteeTests(unittest.TestCase):
    """铁律：巡检链路绝不包含创建调用（plan §10-2a 静态断言）。"""

    ROOT = Path(__file__).resolve().parent.parent
    SOURCE = (ROOT / "sync" / "ppl_daily_report.py").read_text(encoding="utf-8")
    TS_SOURCES = [
        (ROOT / "dev" / "ppl-inspection-bridge.ts").read_text(encoding="utf-8"),
        (ROOT / "src" / "lib" / "ppl-client.ts").read_text(encoding="utf-8"),
        (ROOT / "src" / "components" / "crm" / "PplInspectionPanel.tsx").read_text(encoding="utf-8"),
    ]

    def test_no_creation_or_browser_or_devata_calls(self) -> None:
        forbidden = [
            "kunpeng-ppl-create", "devata", "playwright", "chromium", "puppeteer",
            "selenium", "messages-send-card", "create_chat", "open -a", "osascript",
        ]
        for keyword in forbidden:
            self.assertNotIn(keyword, self.SOURCE.lower(), f"巡检代码不得包含 {keyword}")
            for index, source in enumerate(self.TS_SOURCES):
                self.assertNotIn(keyword, source.lower(), f"巡检 TS 链路文件 #{index} 不得包含 {keyword}")

    def test_dws_only_report_outbox_list(self) -> None:
        self.assertIn('DWS_BASE = ("report", "outbox", "list")', self.SOURCE)

    def test_bridge_only_runs_inspection_script(self) -> None:
        # 桥仅允许执行 sync/ppl_daily_report.py（只读巡检），不得运行其他脚本。
        self.assertIn('"sync", "ppl_daily_report.py"', self.TS_SOURCES[0])


class MainFlowTests(unittest.TestCase):
    def test_main_writes_latest_and_daily_with_0600(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            argv_backup = __import__("sys").argv
            try:
                __import__("sys").argv = ["ppl_daily_report.py", "--output-dir", str(out_dir), "--now", "2026-10-16T09:15:00+08:00"]
                with unittest.mock.patch.object(ppl, "fetch_daily_reports", return_value=([], None)), \
                     unittest.mock.patch.object(ppl, "load_snapshot", return_value=(make_snapshot(), None)):
                    code = ppl.main()
            finally:
                __import__("sys").argv = argv_backup
            self.assertEqual(code, 0)
            latest = json.loads((out_dir / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["state"], "ok")
            self.assertEqual(latest["schemaVersion"], 1)
            self.assertIn("2026-10-16", (out_dir / "2026-10-16.json").read_text(encoding="utf-8"))
            mode = (out_dir / "latest.json").stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)


class FailedStateTests(unittest.TestCase):
    """返工 #4：失败态诚实落盘（快照缺失 / 日报源失败都不得伪装成 ok）。"""

    def test_main_writes_failed_envelope_when_snapshot_missing(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            argv_backup = __import__("sys").argv
            try:
                __import__("sys").argv = ["ppl_daily_report.py", "--output-dir", str(out_dir), "--now", "2026-10-16T09:15:00+08:00"]
                with unittest.mock.patch.object(ppl, "load_snapshot", return_value=(None, "snapshot_unreadable")):
                    code = ppl.main()
            finally:
                __import__("sys").argv = argv_backup
            self.assertEqual(code, 1)
            latest = json.loads((out_dir / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["state"], "failed")
            self.assertEqual(latest["error"], "snapshot_unreadable")
            self.assertEqual(latest["recommendations"], [])

    def test_main_writes_failed_envelope_when_source_fails(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            argv_backup = __import__("sys").argv
            try:
                __import__("sys").argv = ["ppl_daily_report.py", "--output-dir", str(out_dir), "--now", "2026-10-16T09:15:00+08:00"]
                with unittest.mock.patch.object(ppl, "load_snapshot", return_value=(make_snapshot(), None)), \
                     unittest.mock.patch.object(ppl, "fetch_daily_reports", side_effect=ppl.SourceError("error", "dws_auth")):
                    code = ppl.main()
            finally:
                __import__("sys").argv = argv_backup
            self.assertEqual(code, 1)
            latest = json.loads((out_dir / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["state"], "failed")
            self.assertEqual(latest["error"], "dws_auth")
            self.assertEqual(latest["reportCount"], 0)
            self.assertEqual(latest["recommendations"], [])


if __name__ == "__main__":
    unittest.main()
