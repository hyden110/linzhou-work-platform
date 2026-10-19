from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence
from unittest import mock

from sync import dingtalk_daily as daily

NOW = datetime(2026, 10, 19, 1, 30, tzinfo=timezone.utc)
DATE = "2026-10-19"
CACHE = "dingtalk-daily"


def chat_id(index: int) -> str:
    return f"cidSynthetic{index:02d}=="


def message(message_id: str, time: str, text: str, sender: str = "合成同事") -> dict[str, Any]:
    return {
        "messageId": message_id,
        "sender": sender,
        "senderId": "sender-1",
        "text": text,
        "createTime": time,
        "conversationId": "cidSynthetic00==",
        "contentExtra": "DROP-EXTRA",
    }


class FakeDws:
    def __init__(
        self,
        *,
        default: Mapping[str, Any] | None = None,
        by_chat: Mapping[str, Any] | None = None,
    ) -> None:
        self.default = default if default is not None else {"complete": True, "messages": []}
        self.by_chat = dict(by_chat or {})
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, arguments: Sequence[str]) -> Mapping[str, Any]:
        command = tuple(arguments)
        self.calls.append(command)
        result = self.by_chat.get(command[3], self.default)
        if isinstance(result, Exception):
            raise result
        return result


class FakeSummarizer:
    def __init__(
        self,
        *,
        available: bool,
        answers: Sequence[str] | None = None,
        source: str | None = None,
    ) -> None:
        self._available = available
        self.answers = list(answers or [])
        self.selected_source = source
        self.prompts: list[str] = []

    def available(self) -> bool:
        return self._available

    def complete(self, prompt: str) -> str | None:
        self.prompts.append(prompt)
        return self.answers.pop(0) if self.answers else None


def summary_answer(**overrides: Any) -> str:
    payload = {
        "summary": "合成摘要：客户在讨论部署问题。",
        "tickets": [{
            "problem": "部署失败",
            "firstSeenAt": "2026-10-19T00:00:30Z",
            "lastSeenAt": "2026-10-19T00:00:30Z",
            "status": "unresolved",
            "solution": None,
            "evidence": ["m-1"],
        }],
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


class DingtalkDailyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.cache = self.root / "cache"
        self.snapshot = self.root / "crm-snapshot.json"
        self.write_snapshot(
            groups=[{"id": chat_id(0), "name": "合成客户群零"}],
            unread=[{"id": chat_id(0), "name": "合成客户群零"}],
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_snapshot(self, *, groups: list[dict[str, Any]], unread: list[dict[str, Any]]) -> None:
        self.snapshot.write_text(
            json.dumps({"schemaVersion": 1, "groups": groups, "unread": unread}, ensure_ascii=False),
            encoding="utf-8",
        )

    def build(
        self,
        dws: FakeDws,
        summarizer: FakeSummarizer | None = None,
        *,
        now: datetime = NOW,
    ) -> dict[str, Any]:
        return daily.build_daily(
            cache_dir=self.cache,
            snapshot_path=self.snapshot,
            date=DATE,
            now=lambda: now,
            dws=dws,
            summarizer=summarizer or FakeSummarizer(available=False),
            project_root=self.root,
        )

    def read(self, relative: str) -> Any:
        return json.loads((self.cache / relative).read_text(encoding="utf-8"))

    # -- collection scope ---------------------------------------------------
    def test_single_chats_are_counted_but_never_read(self) -> None:
        self.write_snapshot(
            groups=[{"id": chat_id(0), "name": "合成客户群零"}, {"id": chat_id(1), "name": "合成客户群一"}],
            unread=[
                {"id": chat_id(1), "name": "合成客户群一"},
                {"id": "singleSynthetic==", "name": "合成单聊"},
                {"id": chat_id(0), "name": "合成客户群零"},
                {"id": chat_id(0), "name": "重复项"},
            ],
        )
        dws = FakeDws()
        artifact = self.build(dws)

        self.assertEqual(sorted(chat["chatId"] for chat in artifact["chats"]), [chat_id(0), chat_id(1)])
        self.assertEqual(artifact["counts"]["groups"], 2)
        self.assertEqual(artifact["counts"]["singleChats"], 1)
        self.assertEqual([item["chatId"] for item in artifact["singleChats"]], ["singleSynthetic=="])
        self.assertEqual(sorted(call[3] for call in dws.calls), [chat_id(0), chat_id(1)])
        self.assertTrue(all(call[:2] == ("chat", "+chat-messages") for call in dws.calls))

    def test_more_than_twenty_groups_marks_run_partial(self) -> None:
        groups = [{"id": chat_id(index), "name": f"合成客户群{index}"} for index in range(25)]
        self.write_snapshot(groups=groups, unread=groups)
        dws = FakeDws()
        artifact = self.build(dws)

        self.assertEqual(len(dws.calls), daily.MAX_CHATS)
        self.assertEqual(artifact["counts"]["groups"], daily.MAX_CHATS)
        self.assertEqual(artifact["skippedGroups"], 5)
        self.assertEqual(artifact["state"], "partial")
        self.assertEqual(len({call[3] for call in dws.calls}), daily.MAX_CHATS)

    # -- window / caps ------------------------------------------------------
    def test_first_window_is_24h_and_later_window_capped_at_72h(self) -> None:
        start, end, capped = daily.window_for(None, NOW)
        self.assertEqual(start, NOW - timedelta(hours=24))
        self.assertEqual(end, NOW)
        self.assertFalse(capped)

        old = {"lastMessageTime": (NOW - timedelta(hours=100)).strftime("%Y-%m-%dT%H:%M:%SZ")}
        start, _, capped = daily.window_for(old, NOW)
        self.assertEqual(start, NOW - timedelta(hours=72))
        self.assertTrue(capped)

        future = {"lastMessageTime": (NOW + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")}
        start, _, capped = daily.window_for(future, NOW)
        self.assertEqual(start, NOW - timedelta(hours=24))
        self.assertFalse(capped)

    def test_old_watermark_caps_command_window_and_run_state(self) -> None:
        daily._write_json_atomic(self.cache / CACHE / "watermarks.json", {
            "schemaVersion": 1,
            "chats": {chat_id(0): {
                "lastMessageTime": (NOW - timedelta(hours=100)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "lastMessageId": "old-message",
            }},
        })
        dws = FakeDws()
        artifact = self.build(dws)

        chat = artifact["chats"][0]
        self.assertTrue(chat["windowCapped"])
        self.assertEqual(artifact["state"], "partial")
        self.assertEqual(artifact["counts"]["incompleteChats"], 1)
        self.assertEqual(dws.calls[0][5], (NOW - timedelta(hours=72)).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.assertEqual(dws.calls[0][7], NOW.strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.assertEqual(dws.calls[0][8:10], ("--order", "asc"))

    def test_two_hundred_messages_is_partial_and_watermark_stops_at_tail(self) -> None:
        messages = [
            message(f"m-{index:03d}", f"2026-10-19T00:{index // 60:02d}:{index % 60:02d}Z", f"合成消息 {index}")
            for index in range(daily.MAX_MESSAGES)
        ]
        dws = FakeDws(default={"complete": True, "messages": messages})
        artifact = self.build(dws)

        chat = artifact["chats"][0]
        self.assertEqual(chat["messageCount"], daily.MAX_MESSAGES)
        self.assertFalse(chat["complete"])
        self.assertTrue(chat["partial"])
        self.assertTrue(chat["truncated"])
        self.assertEqual(artifact["state"], "partial")
        self.assertEqual(dws.calls[0][13:15], ("--max-items", str(daily.MAX_MESSAGES)))

        watermarks = self.read(f"{CACHE}/watermarks.json")
        stored = watermarks["chats"][chat_id(0)]
        self.assertEqual(stored["lastMessageTime"], "2026-10-19T00:03:19Z")
        self.assertEqual(stored["lastMessageId"], "m-199")

    def test_complete_empty_window_advances_watermark_to_window_end(self) -> None:
        artifact = self.build(FakeDws())
        chat = artifact["chats"][0]
        stored = self.read(f"{CACHE}/watermarks.json")["chats"][chat_id(0)]

        self.assertTrue(chat["complete"])
        self.assertEqual(artifact["state"], "ok")
        self.assertEqual(stored["lastMessageTime"], chat["windowEnd"])
        self.assertIsNone(stored["lastMessageId"])

    # -- projection / prompt ------------------------------------------------
    def test_projection_keeps_only_safe_fields_and_orders_messages(self) -> None:
        projected = daily.project_messages({"messages": [
            message("m-2", "2026-10-19T00:02:00Z", "后一条"),
            message("m-1", "2026-10-19T00:01:00Z", "前一条"),
            message("m-1", "2026-10-19T00:01:00Z", "重复但被覆盖"),
            {"text": "没有 messageId，必须丢弃"},
            {"messageId": "m-3", "senderId": "only-id", "createTime": "2026-10-19T00:03:00Z", "text": "x" * 9000},
        ]})

        self.assertEqual([item["messageId"] for item in projected], ["m-1", "m-2", "m-3"])
        self.assertEqual(set(projected[0]), {"messageId", "sender", "time", "text"})
        self.assertEqual(projected[0]["text"], "重复但被覆盖")
        self.assertEqual(projected[2]["sender"], "only-id")
        self.assertEqual(len(projected[2]["text"]), daily.MESSAGE_TEXT_LIMIT)
        self.assertNotIn("DROP-EXTRA", json.dumps(projected, ensure_ascii=False))

    def test_prompt_contains_only_projected_sentinel_content(self) -> None:
        from sync import dingtalk_daily

        summarizer = FakeSummarizer(available=True, answers=[summary_answer(
            tickets=[{
                "problem": "合成哨兵问题",
                "status": "unknown-value",
                "evidence": ["m-1"],
            }],
        )])
        messages = [message("m-1", "2026-10-19T00:00:30Z", "合成哨兵：部署失败，请协助")]
        dws = FakeDws(default={"complete": True, "messages": messages})
        artifact = self.build(dws, summarizer)

        self.assertEqual(len(summarizer.prompts), 1)
        prompt = summarizer.prompts[0]
        self.assertIn("合成哨兵：部署失败，请协助", prompt)
        self.assertIn("合成客户群零", prompt)
        self.assertNotIn("DROP-EXTRA", prompt)
        self.assertIn("resolved", prompt)
        self.assertEqual(artifact["chats"][0]["summaryState"], "llm")
        self.assertEqual(artifact["chats"][0]["tickets"], [])
        self.assertEqual(dingtalk_daily.MESSAGE_TEXT_LIMIT, 4000)

    # -- model failure / evidence rules -------------------------------------
    def test_invalid_model_json_retries_once_then_falls_back_honestly(self) -> None:
        summarizer = FakeSummarizer(available=True, answers=["不是 JSON", "仍然不是 JSON"])
        messages = [message("m-1", "2026-10-19T00:00:30Z", "合成服务报错，无法连接")]
        dws = FakeDws(default={"complete": True, "messages": messages})
        artifact = self.build(dws, summarizer)

        chat = artifact["chats"][0]
        self.assertEqual(len(summarizer.prompts), 2)
        self.assertEqual(chat["summaryState"], "fallback")
        self.assertTrue(chat["summary"].startswith("未生成摘要"))
        self.assertIn("解析失败", chat["summaryNote"])
        self.assertEqual([ticket["status"] for ticket in chat["tickets"]], ["unresolved"])
        self.assertEqual(chat["tickets"][0]["evidence"], ["m-1"])

    def test_resolved_ticket_requires_evidence_message_id(self) -> None:
        through = [{"messageId": "m-1", "time": "2026-10-19T00:00:30Z"}]
        tickets = daily.normalise_tickets(
            [
                {"problem": "有证据", "status": "resolved", "solution": "已重启", "evidence": ["m-1"]},
                {"problem": "证据不存在", "status": "resolved", "solution": "已优化", "evidence": ["ghost"]},
                {"problem": "没有证据", "status": "resolved", "solution": "已处理", "evidence": []},
                {"problem": "状态非法", "status": "done", "evidence": ["m-1"]},
            ],
            through,
            "2026-10-19T00:00:00Z",
            "2026-10-19T01:30:00Z",
        )

        self.assertEqual([ticket["problem"] for ticket in tickets], ["有证据", "证据不存在", "没有证据"])
        self.assertEqual(tickets[0]["status"], "resolved")
        self.assertEqual(tickets[1]["status"], "unconfirmed")
        self.assertIsNone(tickets[1]["solution"])
        self.assertEqual(tickets[1]["evidence"], [])
        self.assertEqual(tickets[2]["status"], "unconfirmed")
        self.assertEqual(tickets[0]["firstSeenAt"], "2026-10-19T00:00:30Z")

    def test_fallback_extraction_marks_resolution_and_strong_problems(self) -> None:
        messages = [
            {"messageId": "m-1", "time": "2026-10-19T00:01:00Z", "text": "合成环境部署失败，无法启动"},
            {"messageId": "m-2", "time": "2026-10-19T00:02:00Z", "text": "已经恢复了，可以了"},
            {"messageId": "m-3", "time": "2026-10-19T00:03:00Z", "text": "想了解一下报价"},
        ]
        tickets = daily.fallback_extract(messages, "2026-10-19T00:00:00Z", "2026-10-19T01:30:00Z")

        self.assertEqual(len(tickets), 1)
        self.assertEqual(tickets[0]["status"], "resolved")
        self.assertEqual(tickets[0]["evidence"], ["m-1", "m-2"])
        self.assertEqual(tickets[0]["lastSeenAt"], "2026-10-19T00:02:00Z")

    # -- read failure + permissions ----------------------------------------
    def test_failed_chat_retains_no_watermark_and_no_fake_summary(self) -> None:
        self.write_snapshot(
            groups=[{"id": chat_id(0), "name": "合成客户群零"}, {"id": chat_id(1), "name": "合成客户群一"}],
            unread=[{"id": chat_id(0), "name": "合成客户群零"}, {"id": chat_id(1), "name": "合成客户群一"}],
        )
        dws = FakeDws(by_chat={chat_id(0): daily.SourceError("dws_exit_1")})
        artifact = self.build(dws)

        failed = next(chat for chat in artifact["chats"] if chat["chatId"] == chat_id(0))
        self.assertEqual(failed["error"], "dws_exit_1")
        self.assertIn("未生成摘要", failed["summary"])
        self.assertEqual(artifact["state"], "partial")
        self.assertEqual(artifact["counts"]["failedChats"], 1)
        self.assertNotIn(chat_id(0), self.read(f"{CACHE}/watermarks.json")["chats"])
        self.assertIn(chat_id(1), self.read(f"{CACHE}/watermarks.json")["chats"])

    def test_all_chats_failed_marks_run_failed(self) -> None:
        dws = FakeDws(default=daily.SourceError("dws_timeout"))
        artifact = self.build(dws)

        self.assertEqual(artifact["state"], "failed")
        self.assertEqual(artifact["error"], "all_chats_failed")
        self.assertEqual(self.read(f"{CACHE}/runs.json")["state"], "failed")

    def test_artifacts_are_private(self) -> None:
        messages = [message("m-1", "2026-10-19T00:00:30Z", "合成消息")]
        self.build(FakeDws(default={"complete": True, "messages": messages}))

        raw_files = list((self.cache / CACHE / "raw" / DATE).glob("*.json"))
        self.assertEqual(len(raw_files), 1)
        for path in [
            raw_files[0],
            self.cache / CACHE / "watermarks.json",
            self.cache / CACHE / f"summary-{DATE}.json",
            self.cache / CACHE / "runs.json",
        ]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, path)
        self.assertEqual(raw_files[0].parent.stat().st_mode & 0o777, 0o700)

    # -- isolated qodercli log permissions ----------------------------------
    def make_isolated_tree(self) -> tuple[Path, Path, Path]:
        config = self.cache / CACHE / "qodercli-config"
        logs = config / "logs"
        logs.mkdir(parents=True)
        log_file = logs / "session.log"
        log_file.write_text("合成 prompt：部署失败", encoding="utf-8")
        os.chmod(config, 0o755)
        os.chmod(logs, 0o755)
        os.chmod(log_file, 0o644)
        return config, logs, log_file

    def test_isolated_config_permissions_are_tightened(self) -> None:
        config, logs, log_file = self.make_isolated_tree()
        artifact = self.build(FakeDws())

        self.assertEqual(config.stat().st_mode & 0o777, 0o700)
        self.assertEqual(logs.stat().st_mode & 0o777, 0o700)
        self.assertEqual(log_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(artifact["warnings"], [])
        self.assertEqual(self.read(f"{CACHE}/runs.json")["warnings"], [])

    def test_isolated_permissions_are_tightened_on_the_error_path(self) -> None:
        config, logs, log_file = self.make_isolated_tree()
        with self.assertRaises(daily.SourceError):
            daily.build_daily(
                cache_dir=self.cache,
                snapshot_path=self.root / "missing-snapshot.json",
                date=DATE,
                now=lambda: NOW,
                dws=FakeDws(),
                summarizer=FakeSummarizer(available=False),
                project_root=self.root,
            )

        self.assertEqual(config.stat().st_mode & 0o777, 0o700)
        self.assertEqual(logs.stat().st_mode & 0o777, 0o700)
        self.assertEqual(log_file.stat().st_mode & 0o777, 0o600)
        runs = self.read(f"{CACHE}/runs.json")
        self.assertEqual(runs["state"], "failed")
        self.assertEqual(runs["warnings"], [])

    def test_chmod_failure_warns_without_failing_the_summary(self) -> None:
        _, _, log_file = self.make_isolated_tree()
        real_chmod = os.chmod

        def flaky(path: Any, mode: int, *args: Any, **kwargs: Any) -> None:
            if Path(path) == log_file:
                raise PermissionError(str(path))
            real_chmod(path, mode, *args, **kwargs)

        with mock.patch.object(daily.os, "chmod", side_effect=flaky):
            artifact = self.build(FakeDws())

        self.assertEqual(artifact["state"], "ok")
        self.assertEqual(artifact["warnings"], ["isolated_log_chmod_failed"])
        self.assertEqual(self.read(f"{CACHE}/runs.json")["warnings"], ["isolated_log_chmod_failed"])
        self.assertEqual(log_file.stat().st_mode & 0o777, 0o644)

    def test_default_source_only_tightens_the_isolated_directory(self) -> None:
        isolated = self.cache / CACHE / "qodercli-config"
        with mock.patch.object(daily, "tighten_isolated_permissions", return_value=[]) as tighten:
            artifact = self.build(
                FakeDws(),
                FakeSummarizer(available=True, answers=[summary_answer()], source="default"),
            )

        self.assertEqual(artifact["modelSource"], "default")
        self.assertTrue(tighten.call_args_list)
        for call in tighten.call_args_list:
            self.assertEqual(call.args[0], isolated)

    # -- command guard / CLI wiring ----------------------------------------
    def test_only_the_read_only_chat_shape_is_runnable(self) -> None:
        good = daily.build_chat_messages_command(
            chat_id(0), "2026-10-19T00:00:00Z", "2026-10-19T01:00:00Z",
        )
        daily._validate_chat_command(good)

        for bad in (
            ("todo", "+create"),
            ("chat", "+mark-read", "--group", chat_id(0)),
            tuple("999" if token == "200" else token for token in good),
            tuple("2026-10-19T00:00:00+08:00" if token == "2026-10-19T00:00:00Z" else token for token in good),
            tuple("bad id" if token == chat_id(0) else token for token in good),
        ):
            with self.assertRaises(daily.SourceError) as caught:
                daily.run_dws(bad)
            self.assertEqual(caught.exception.code, "command_not_allowed")

    def test_summary_pipeline_source_has_no_write_subcommands(self) -> None:
        source = Path(daily.__file__).read_text(encoding="utf-8")
        for token in (
            '"+complete"', '"+mark', '"+send"', '"+recall"', '"+update"', '"+delete"',
            '"+remove"', '"+finish"', '"+close"', '"mark-read"', '"clear-red-dot"',
        ):
            self.assertNotIn(token, source)
        self.assertIn('"--tools", ""', source)
        self.assertNotIn("--allowed-mcp-server-names", source)

    def test_qodercli_probe_accepts_plain_ok_and_strips_sdk_env(self) -> None:
        captured: dict[str, Any] = {}

        def runner(arguments: Sequence[str], env: Mapping[str, str]) -> subprocess.CompletedProcess[str]:
            captured["arguments"] = list(arguments)
            captured["env"] = dict(env)
            return subprocess.CompletedProcess(list(arguments), 0, '{"ok":true}', "")

        with mock.patch.dict(
            os.environ,
            {
                "QODER_AGENT_SDK_ENTRYPOINT": "agent-sdk",
                "QODER_AGENT_SDK_VERSION": "9",
                "QODERCLI_CONFIG_DIR": "",
            },
        ):
            summarizer = daily.QodercliSummarizer(
                self.root / "qodercli-config", self.root,
                binary=Path(daily.__file__), runner=runner,
            )
            self.assertTrue(summarizer.available())

        self.assertIn("--config-dir", captured["arguments"])
        self.assertIn("--tools", captured["arguments"])
        self.assertEqual(captured["arguments"][captured["arguments"].index("--tools") + 1], "")
        self.assertNotIn("--allowed-mcp-server-names", captured["arguments"])
        self.assertNotIn("QODER_AGENT_SDK_ENTRYPOINT", captured["env"])
        self.assertNotIn("QODER_AGENT_SDK_VERSION", captured["env"])
        self.assertEqual(summarizer.selected_source, "isolated")

    def test_qodercli_probe_rejects_logged_out_output(self) -> None:
        runner = lambda arguments, env: subprocess.CompletedProcess(  # noqa: E731
            list(arguments), 1, "Not logged in", "",
        )
        summarizer = daily.QodercliSummarizer(
            self.root / "qodercli-config", self.root,
            binary=Path(daily.__file__), runner=runner,
        )
        with mock.patch.dict(os.environ, {"QODERCLI_CONFIG_DIR": ""}):
            self.assertFalse(summarizer.available())
        self.assertIsNone(summarizer.selected_source)

    def test_qodercli_explicit_config_dir_env_wins(self) -> None:
        override = self.root / "explicit-config"
        calls: list[list[str]] = []

        def runner(arguments: Sequence[str], env: Mapping[str, str]) -> subprocess.CompletedProcess[str]:
            calls.append(list(arguments))
            return subprocess.CompletedProcess(list(arguments), 0, '{"ok":true}', "")

        with mock.patch.dict(os.environ, {"QODERCLI_CONFIG_DIR": str(override)}):
            summarizer = daily.QodercliSummarizer(
                self.root / "qodercli-config", self.root,
                binary=Path(daily.__file__), runner=runner,
            )
            self.assertTrue(summarizer.available())
            self.assertEqual(summarizer.complete("合成提示"), '{"ok":true}')

        self.assertEqual(summarizer.selected_source, "env")
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual(call[call.index("--config-dir") + 1], str(override))

    def test_qodercli_falls_back_to_default_config_after_isolated_probe_fails(self) -> None:
        calls: list[list[str]] = []

        def runner(arguments: Sequence[str], env: Mapping[str, str]) -> subprocess.CompletedProcess[str]:
            calls.append(list(arguments))
            if "--config-dir" in arguments:
                return subprocess.CompletedProcess(list(arguments), 1, "Not logged in", "")
            return subprocess.CompletedProcess(list(arguments), 0, '{"ok":true}', "")

        with mock.patch.dict(os.environ, {"QODERCLI_CONFIG_DIR": ""}):
            summarizer = daily.QodercliSummarizer(
                self.root / "qodercli-config", self.root,
                binary=Path(daily.__file__), runner=runner,
            )
            self.assertTrue(summarizer.available())
            self.assertEqual(summarizer.complete("合成提示"), '{"ok":true}')

        self.assertEqual(summarizer.selected_source, "default")
        self.assertEqual(len(calls), 3)
        self.assertIn("--config-dir", calls[0])
        self.assertNotIn("--config-dir", calls[1])
        self.assertNotIn("--config-dir", calls[2])
        for call in calls:
            self.assertEqual(call[call.index("--tools") + 1], "")
            self.assertNotIn("--allowed-mcp-server-names", call)

    def test_artifact_and_runs_record_model_source_and_elapsed_ms(self) -> None:
        summarizer = FakeSummarizer(available=True, answers=[summary_answer()], source="default")
        moments = iter([NOW, NOW + timedelta(seconds=3)])
        artifact = daily.build_daily(
            cache_dir=self.cache,
            snapshot_path=self.snapshot,
            date=DATE,
            now=lambda: next(moments),
            dws=FakeDws(),
            summarizer=summarizer,
            project_root=self.root,
        )

        self.assertEqual(artifact["modelSource"], "default")
        self.assertEqual(artifact["elapsedMs"], 3000)
        runs = self.read(f"{CACHE}/runs.json")
        self.assertEqual(runs["state"], "succeeded")
        self.assertEqual(runs["modelSource"], "default")
        self.assertEqual(runs["elapsedMs"], 3000)

    def test_failure_runs_record_elapsed_ms(self) -> None:
        moments = iter([NOW, NOW + timedelta(seconds=2)])
        with self.assertRaises(daily.SourceError):
            daily.build_daily(
                cache_dir=self.cache,
                snapshot_path=self.root / "missing-snapshot.json",
                date=DATE,
                now=lambda: next(moments),
                dws=FakeDws(),
                summarizer=FakeSummarizer(available=False),
                project_root=self.root,
            )

        runs = self.read(f"{CACHE}/runs.json")
        self.assertEqual(runs["state"], "failed")
        self.assertEqual(runs["error"], "snapshot_unavailable")
        self.assertEqual(runs["elapsedMs"], 2000)
        self.assertIsNone(runs["modelSource"])


if __name__ == "__main__":
    unittest.main()
