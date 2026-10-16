from __future__ import annotations

import email.message
import io
import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from unittest import mock

from sync import ops_digest


def flight(payload: dict[str, object]) -> str:
    """Reproduce qoder.com's flight-script escaping: JSON inside a JS string literal."""
    inner = json.dumps(payload, ensure_ascii=False)
    escaped = inner.replace("\\", "\\\\").replace('"', '\\"')
    head = 'self.__next_f.push([1,"23:[[\\\"$\\",\\\"$L2d\\",null,{\\\"x\\":1,'
    return head + escaped + '}]}])'


BLOG_HTML = flight({"blogData": [
    {"title": "FAST 快速档位: 让反馈跟上你的思路", "desc": "Qoder Fast 快速档位上线：生成速度提升超150%",
     "category": "产品", "url": "qoder-fast", "published_at": "2026-10-14T08:37:46Z", "time": "2026-10-14T08:37:46Z"},
    {"title": "项目与讨论：人类与智能体的协同工作空间", "desc": "项目是人与智能体一起工作的地方",
     "category": "产品", "url": "project-and-discussion", "published_at": "2026-09-24T08:59:49Z",
     "time": "2026-09-24T08:59:49Z"},
    {"title": "缺 slug 的条目必须被丢弃", "desc": "x", "category": "产品", "url": "", "published_at": "2026-09-01T00:00:00Z"},
]})

CHANGELOG_HTML = flight({"initialData": [
    {"id": "413786226", "title": "Windows 子 Agent 启动修复与空会话退出清理",
     "body": "* 修复 Windows 上输出符号链接创建失败时，子 Agent 无法启动的问题\n* 空会话退出时不再显示无法使用的恢复命令",
     "tag_name": "1.1.72", "published_at": "2026-10-15T12:30:15Z", "type": "cli"},
    {"id": "413558738", "title": "快", "body": "* 第一条\\n* 第二条", "tag_name": "1.1.71",
     "published_at": "2026-10-14T10:00:00Z", "type": "app"},
]})

ANNOUNCE_INDEX_HTML = (
    '<div class="markdown-body">\n <div class="directory">\n<ul>\n'
    ' <li><a href="/zh/qwenwork/qwenwork-is-live">千问办公正式上线，多重惊喜福利！</a></li>\n'
    ' <li><a href="/zh/qwenwork/qw-活动">示例活动公告</a></li>\n'
    '</ul>\n</div>\n'
    '<a href="/zh/qwenwork/qw-faq" title="常见问题"\n>上一篇: 常见问题</a\n>\n'
    '<a href="/zh/qwenwork/qw-chain" title="链式新公告"\n>下一篇: 链式新公告</a\n>\n'
    ' </div>\n</div>'
)

ANNOUNCE_DOC_HTML = (
    'window.__ICE_PAGE_PROPS__={"docDetailData":{"storeData":{"data":{'
    '"lastModifiedTime":1788182101000,"docTitle":"千问办公正式上线，多重惊喜福利！"}}}}'
)


def announce_doc(title: str, epoch_ms: int = 1788182101000) -> str:
    return (
        'window.__ICE_PAGE_PROPS__={"docDetailData":{"storeData":{"data":{'
        f'"lastModifiedTime":{epoch_ms},"docTitle":"{title}"}}}}'
    )


def announce_doc_undated(title: str) -> str:
    """Doc page without lastModifiedTime: the item must stay, date stays None."""
    return (
        'window.__ICE_PAGE_PROPS__={"docDetailData":{"storeData":{"data":{'
        f'"docTitle":"{title}"}}}}'
    )


def qianzai_payload(*messages: dict[str, object], complete: bool = True) -> dict[str, object]:
    return {"complete": complete, "count": len(messages), "messages": list(messages), "partial": False}


class FakeDws:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload
        self.commands: list[tuple[str, ...]] = []

    def __call__(self, arguments: tuple[str, ...]) -> dict[str, object]:
        assert arguments[:2] == ("chat", "+chat-messages"), f"unexpected dws command {arguments!r}"
        self.commands.append(arguments)
        return self.payload


class FakeFetch:
    def __init__(self, pages: dict[str, str]) -> None:
        self.pages = pages
        self.calls: list[str] = []

    def __call__(self, url: str) -> str:
        self.calls.append(url)
        if url not in self.pages:
            raise ops_digest.SourceError("error", "fetch_failed")
        return self.pages[url]


class ParserTests(unittest.TestCase):
    def test_parses_blog_flight_json_and_projects_safe_fields(self) -> None:
        items, complete = ops_digest.parse_blog(BLOG_HTML)
        self.assertTrue(complete)
        self.assertEqual(len(items), 2)
        first = items[0]
        self.assertEqual(first["id"], "blog:qoder-fast")
        self.assertEqual(first["url"], "https://qoder.com/zh/blog/qoder-fast")
        self.assertEqual(first["publishedAt"], "2026-10-14T08:37:46Z")
        self.assertEqual(first["summary"], "Qoder Fast 快速档位上线：生成速度提升超150%")
        self.assertEqual(first["sourceType"], "blog")

    def test_parses_changelog_entries_with_first_bullet_as_summary(self) -> None:
        items, complete = ops_digest.parse_changelog(CHANGELOG_HTML)
        self.assertTrue(complete)
        self.assertEqual(len(items), 2)
        first = items[0]
        self.assertEqual(first["id"], "changelog:1.1.72")
        self.assertEqual(first["url"], ops_digest.CHANGELOG_URL)
        self.assertEqual(first["kind"], "cli")
        self.assertEqual(first["summary"], "修复 Windows 上输出符号链接创建失败时，子 Agent 无法启动的问题")
        self.assertTrue(first["publishedAt"].startswith("2026-10-15"))

    def test_flight_extraction_rejects_missing_or_broken_markers(self) -> None:
        with self.assertRaises(ops_digest.SourceError):
            ops_digest.parse_blog("<html>没有嵌入数据</html>")
        with self.assertRaises(ops_digest.SourceError):
            ops_digest.parse_blog('self.__next_f.push([1,"x:\\"blogData\\":[{\\\\ Broken')

    def test_announcement_directory_and_chain_are_collected_with_real_dates(self) -> None:
        pages = {
            ops_digest.ANNOUNCE_INDEX_URL: ANNOUNCE_INDEX_HTML,
            "https://help.aliyun.com/zh/qwenwork/qwenwork-is-live": ANNOUNCE_DOC_HTML,
            "https://help.aliyun.com/zh/qwenwork/qw-活动": announce_doc_undated("示例活动公告"),
            "https://help.aliyun.com/zh/qwenwork/qw-chain": announce_doc("链式新公告", 1788100000000),
        }
        items, complete = ops_digest.collect_announcements(FakeFetch(pages))
        self.assertTrue(complete)
        self.assertEqual({item["id"] for item in items}, {
            "announcement:/zh/qwenwork/qwenwork-is-live",
            "announcement:/zh/qwenwork/qw-活动",
            "announcement:/zh/qwenwork/qw-chain",
        })
        by_id = {item["id"]: item for item in items}
        self.assertEqual(by_id["announcement:/zh/qwenwork/qw-活动"]["title"], "示例活动公告")
        # 无 lastModifiedTime 的公告如实保留（日期为空，进前端「无日期」桶），不算失败。
        self.assertIsNone(by_id["announcement:/zh/qwenwork/qw-活动"]["publishedAt"])
        self.assertTrue(by_id["announcement:/zh/qwenwork/qwenwork-is-live"]["publishedAt"].startswith("2026-"))

    def test_announcement_round_is_capped_at_twenty_docs(self) -> None:
        paths = [f"/zh/qwenwork/doc-{index}" for index in range(1, 26)]
        directory = '<div class="directory"><ul>' + "".join(
            f'<li><a href="{path}">标题 {index}</a></li>' for index, path in enumerate(paths, start=1)
        ) + "</ul></div>"
        pages = {ops_digest.ANNOUNCE_INDEX_URL: directory}
        for index, path in enumerate(paths, start=1):
            pages[f"https://help.aliyun.com{path}"] = announce_doc(f"标题 {index}")
        items, complete = ops_digest.collect_announcements(FakeFetch(pages))
        self.assertEqual(len(items), ops_digest.MAX_ANNOUNCE_DOCS)
        self.assertFalse(complete)

    def test_qianzai_messages_are_projected_without_urls(self) -> None:
        payload = qianzai_payload(
            {"messageId": "msgDv3mHcKYNCbtiBWi/AeuGg==", "createTime": "2026-10-15 15:02:30",
             "sender": "千仔运营助手", "text": "**第二期来啦！**\n让每一分 Credits 都出活"},
            {"messageId": "msgNoText==", "createTime": "2026-10-15 16:00:00", "sender": "千仔运营助手", "text": ""},
        )
        items = ops_digest.parse_qianzai(payload)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "qianzai:msgDv3mHcKYNCbtiBWi/AeuGg==")
        self.assertIsNone(items[0]["url"])
        self.assertEqual(items[0]["publishedAt"], "2026-10-15T15:02:30")
        self.assertEqual(items[0]["title"], "**第二期来啦！**")

    def test_dws_command_whitelist_rejects_unapproved_flags_and_values(self) -> None:
        for command in (
            ("todo", "+get-related-tasks"),
            ("chat", "+chat-messages", "--open-dingtalk-id", "x", "--start", "2026-10-15 00:00:00",
             "--end", "2026-10-16 00:00:00", "--order", "desc", "--format", "json"),
            ("chat", "+chat-messages", "--open-dingtalk-id", "x y", "--format", "json"),
            ("chat", "+chat-messages", "--open-dingtalk-id", "x", "--send", "boom"),
        ):
            with self.subTest(command=command[:4]):
                with self.assertRaises(ops_digest.SourceError):
                    ops_digest.run_dws_ops(command)


class FakeHttpsHandler(urllib.request.HTTPSHandler):
    """Serves canned HTTPError responses per URL so the real redirect chain runs."""

    def __init__(self, responses: list[tuple[str, urllib.error.HTTPError]]) -> None:
        super().__init__()
        self.responses = responses
        self.requests: list[str] = []

    def https_open(self, req):
        self.requests.append(req.full_url)
        for prefix, response in self.responses:
            if req.full_url.startswith(prefix):
                return response
        raise AssertionError(f"unexpected https request {req.full_url!r}")


def fake_response(url: str, code: int, location: str | None = None, body: bytes = b"") -> urllib.error.HTTPError:
    headers = email.message.Message()
    if location:
        headers["location"] = location
    return urllib.error.HTTPError(url, code, "Found" if location else "OK", headers, io.BytesIO(body))


def patched_opener(handler: FakeHttpsHandler) -> urllib.request.OpenerDirector:
    """Opener whose redirect hops still run the production whitelist handler."""
    return urllib.request.build_opener(ops_digest._WhitelistRedirectHandler, handler)


class FetchWhitelistTests(unittest.TestCase):
    def test_rejects_foreign_hosts_schemes_and_credentials(self) -> None:
        for url in (
            "https://evil.example/blog",
            "http://qoder.com/zh/blog",
            "https://user:pass@qoder.com/zh/blog",
            "https://qoder.com.evil.example/zh/blog",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ops_digest.SourceError):
                    ops_digest.default_fetch(url)

    def test_allows_whitelisted_hosts_and_reads_body(self) -> None:
        context = mock.Mock(status=200, read=mock.Mock(return_value=b"{}"))
        context.__enter__ = mock.Mock(return_value=context)
        context.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.return_value = context
        with mock.patch.object(ops_digest, "_ops_opener", return_value=opener):
            self.assertEqual(ops_digest.default_fetch("https://qoder.com/zh/blog"), "{}")
        opener.open.assert_called_once()

    def test_whitelisted_host_redirecting_to_foreign_host_is_rejected(self) -> None:
        handler = FakeHttpsHandler([
            ("https://qoder.com/zh/blog",
             fake_response("https://qoder.com/zh/blog", 302, location="https://evil.example/landing")),
        ])
        with mock.patch.object(ops_digest, "_ops_opener", return_value=patched_opener(handler)):
            with self.assertRaises(ops_digest.SourceError) as raised:
                ops_digest.default_fetch("https://qoder.com/zh/blog")
        self.assertEqual(raised.exception.code, "redirect_target_not_allowed")
        # 逐跳复验：对外域目标的后续请求根本不会发出。
        self.assertEqual(handler.requests, ["https://qoder.com/zh/blog"])

    def test_allowed_redirect_hop_is_followed_and_body_read(self) -> None:
        handler = FakeHttpsHandler([
            ("https://qoder.com/zh/blog",
             fake_response("https://qoder.com/zh/blog", 302, location="https://help.aliyun.com/zh/landing")),
            ("https://help.aliyun.com/zh/landing",
             fake_response("https://help.aliyun.com/zh/landing", 200, body=b'{"ok":true}')),
        ])
        with mock.patch.object(ops_digest, "_ops_opener", return_value=patched_opener(handler)):
            self.assertEqual(ops_digest.default_fetch("https://qoder.com/zh/blog"), '{"ok":true}')
        self.assertEqual(handler.requests, ["https://qoder.com/zh/blog", "https://help.aliyun.com/zh/landing"])


class BuildDigestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name) / "ops-digest.json"
        self.now = datetime(2026, 10, 16, 15, 0, 0)
        env = mock.patch.dict(os.environ, {"OPS_QIANZAI_OPEN_DINGTALK_ID": "testOpenId"})
        env.start()
        self.addCleanup(env.stop)

    def pages(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        pages = {
            ops_digest.BLOG_URL: BLOG_HTML,
            ops_digest.CHANGELOG_URL: CHANGELOG_HTML,
            ops_digest.ANNOUNCE_INDEX_URL: ANNOUNCE_INDEX_HTML,
            "https://help.aliyun.com/zh/qwenwork/qwenwork-is-live": ANNOUNCE_DOC_HTML,
            "https://help.aliyun.com/zh/qwenwork/qw-活动": announce_doc("示例活动公告", 1788000000000),
            "https://help.aliyun.com/zh/qwenwork/qw-chain": announce_doc("链式新公告", 1788100000000),
        }
        pages.update(extra or {})
        return pages

    def test_first_round_backfills_seven_days_and_writes_full_envelope(self) -> None:
        fetch = FakeFetch(self.pages())
        dws = FakeDws(qianzai_payload(
            {"messageId": "msg1==", "createTime": "2026-10-15 15:02:30",
             "sender": "千仔运营助手", "text": "第一期推送"},
        ))
        digest = ops_digest.build_digest(
            output_path=self.output, fetch=fetch, dws=dws, now=lambda: self.now)
        self.assertEqual(set(digest["sources"]), {"blog", "changelog", "announcement", "qianzai"})
        for name, source in digest["sources"].items():
            self.assertEqual(source["status"], "ok", name)
            self.assertTrue(source["complete"], name)
            self.assertIsNotNone(source["fetchedAt"])
        self.assertEqual(len(digest["items"]), 2 + 2 + 3 + 1)
        self.assertEqual(digest["cursors"]["qianzaiSince"], "2026-10-16 15:00:00")
        start = [value for value in dws.commands[0] if value == "2026-10-09 15:00:00"]
        self.assertEqual(start, ["2026-10-09 15:00:00"])
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)

    def test_second_round_uses_cursor_and_merges_without_duplicates(self) -> None:
        fetch = FakeFetch(self.pages())
        first = ops_digest.build_digest(
            output_path=self.output, fetch=fetch,
            dws=FakeDws(qianzai_payload(
                {"messageId": "msg1==", "createTime": "2026-10-15 15:02:30",
                 "sender": "千仔运营助手", "text": "第一期推送"})),
            now=lambda: self.now)
        later = datetime(2026, 10, 16, 18, 30, 0)
        dws = FakeDws(qianzai_payload(
            {"messageId": "msg2==", "createTime": "2026-10-16 17:00:00",
             "sender": "千仔运营助手", "text": "第二期推送"}))
        digest = ops_digest.build_digest(
            output_path=self.output, fetch=fetch, dws=dws, now=lambda: later)
        self.assertIn("--start", dws.commands[0])
        self.assertIn("2026-10-16 15:00:00", dws.commands[0])
        ids = [item["id"] for item in digest["items"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn("qianzai:msg1==", ids)
        self.assertIn("qianzai:msg2==", ids)
        self.assertEqual(digest["cursors"]["qianzaiSince"], "2026-10-16 18:30:00")
        self.assertLess(first["generatedAt"], digest["generatedAt"])

    def test_failed_sources_keep_previous_items_and_stay_honest(self) -> None:
        pages = self.pages()
        ops_digest.build_digest(
            output_path=self.output, fetch=FakeFetch(pages),
            dws=FakeDws(qianzai_payload(
                {"messageId": "msg1==", "createTime": "2026-10-15 15:02:30",
                 "sender": "千仔运营助手", "text": "第一期推送"})),
            now=lambda: self.now)

        def failing(url: str) -> str:
            raise ops_digest.SourceError("error", "fetch_failed")

        def failing_dws(arguments: tuple[str, ...]) -> dict[str, object]:
            raise ops_digest.SourceError("error", "dws_exit_1")

        digest = ops_digest.build_digest(
            output_path=self.output, fetch=failing, dws=failing_dws, now=lambda: self.now)
        for name, source in digest["sources"].items():
            self.assertEqual(source["status"], "error", name)
            self.assertTrue(source["stale"], name)
            self.assertGreater(source["count"], 0, name)
        self.assertEqual(digest["cursors"]["qianzaiSince"], "2026-10-16 15:00:00")
        self.assertEqual(len(digest["items"]), 8)

    def test_partial_qianzai_round_advances_cursor_to_last_message_only(self) -> None:
        fetch = FakeFetch(self.pages())
        dws = FakeDws(qianzai_payload(
            {"messageId": "msg1==", "createTime": "2026-10-15 15:02:30",
             "sender": "千仔运营助手", "text": "第一期推送"},
            {"messageId": "msg2==", "createTime": "2026-10-16 10:30:00",
             "sender": "千仔运营助手", "text": "触顶前的最后一条"},
            complete=False,
        ))
        digest = ops_digest.build_digest(
            output_path=self.output, fetch=fetch, dws=dws, now=lambda: self.now)
        self.assertEqual(digest["sources"]["qianzai"]["status"], "partial")
        # 触顶时游标只推进到最后一条已读消息，绝不推进到 now（会漏窗口尾部）。
        self.assertEqual(digest["cursors"]["qianzaiSince"], "2026-10-16 10:30:00")

    def test_partial_qianzai_round_without_messages_keeps_previous_cursor(self) -> None:
        fetch = FakeFetch(self.pages())
        ops_digest.build_digest(
            output_path=self.output, fetch=fetch,
            dws=FakeDws(qianzai_payload(
                {"messageId": "msg1==", "createTime": "2026-10-15 15:02:30",
                 "sender": "千仔运营助手", "text": "第一期推送"})),
            now=lambda: self.now)
        later = datetime(2026, 10, 16, 18, 30, 0)
        dws = FakeDws(qianzai_payload(complete=False))
        digest = ops_digest.build_digest(
            output_path=self.output, fetch=fetch, dws=dws, now=lambda: later)
        self.assertEqual(digest["sources"]["qianzai"]["status"], "partial")
        self.assertEqual(digest["cursors"]["qianzaiSince"], "2026-10-16 15:00:00")

    def test_missing_open_id_marks_qianzai_missing_without_dws_call(self) -> None:
        fetch = FakeFetch(self.pages())
        dws = FakeDws(qianzai_payload())
        with mock.patch.dict(os.environ):
            os.environ.pop("OPS_QIANZAI_OPEN_DINGTALK_ID", None)
            digest = ops_digest.build_digest(
                output_path=self.output, fetch=fetch, dws=dws, now=lambda: self.now)
        self.assertEqual(digest["sources"]["qianzai"]["status"], "missing")
        self.assertEqual(digest["sources"]["qianzai"]["error"], "qianzai_open_id_missing")
        self.assertEqual(dws.commands, [])

    def test_retention_caps_each_source_bucket(self) -> None:
        entries = [
            {"id": str(index), "title": f"更新 {index}", "body": "* 说明", "tag_name": f"0.0.{index}",
             "published_at": f"2026-09-{(index % 28) + 1:02d}T00:00:00Z", "type": "cli"}
            for index in range(1, ops_digest.CHANGELOG_KEEP_PER_ROUND + 12)
        ]
        pages = self.pages({ops_digest.CHANGELOG_URL: flight({"initialData": entries})})
        digest = ops_digest.build_digest(
            output_path=self.output, fetch=FakeFetch(pages),
            dws=FakeDws(qianzai_payload()),
            now=lambda: self.now)
        changelog_items = [item for item in digest["items"] if item["sourceType"] == "changelog"]
        self.assertEqual(len(changelog_items), ops_digest.CHANGELOG_KEEP_PER_ROUND)
        self.assertFalse(digest["sources"]["changelog"]["complete"])
        self.assertEqual(digest["sources"]["changelog"]["status"], "partial")


if __name__ == "__main__":
    unittest.main()
