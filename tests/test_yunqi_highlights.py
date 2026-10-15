import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sync import yunqi_highlights as yh

FIXTURE = """<!DOCTYPE html>
<html lang="zh-CN"><head><title>云栖</title></head><body>
<h1>2026 云栖大会 · 六层趋势整理</h1>
<section id="overview">
  <div class="mainline">
    <span class="tag">主线判断</span>
    <p class="thesis">从产业范式到 Agentic Cloud 底座</p>
    <p class="thesis-sub">六层结构 · 本机整理稿</p>
  </div>
  <div class="insight">
    <h3>综合判断一</h3>
    <p>Agent 成为新的交付单元。</p>
    <div class="ev"><a href="#talk-1">讲者卡 1</a><a href="https://example.com/report">官方报告</a></div>
  </div>
  <div class="layer-h"><span class="lv">L1</span><h3>应用与智能体</h3><p>入口层</p></div>
  <div class="ov-grid">
    <div class="ov"><span class="n">趋势 01</span><h3>智能体交付</h3><p>从功能到结果。</p><div class="ev"><a href="#talk-1">证据</a></div></div>
    <div class="ov"><span class="n">趋势 02</span><h3>多 Agent 协作</h3><p>编排成为关键。</p></div>
  </div>
  <div class="layer-h"><span class="lv">L2</span><h3>模型与知识</h3><p>能力底座</p></div>
  <div class="ov-grid">
    <div class="ov"><span class="n">趋势 03</span><h3>知识工程</h3><p>RAG 走向受控证据。</p></div>
  </div>
</section>
<section id="l1">
  <div class="divider"><span class="lv">第一层</span><h2>应用与智能体</h2><p>入口层判断</p></div>
  <table><tr><th>论坛</th></tr>
  <tr><td><a href="#forum-1">智能体主论坛</a><br>Agentic 应用</td><td>10-24 09:00<br>杭州云栖小镇</td><td>面向业务</td><td>发布 A</td><td>案例 B</td></tr></table>
</section>
<section id="forum-1">
  <h2>智能体主论坛</h2>
  <div class="forum-meta"><span>10-24 09:00</span><span>杭州云栖小镇</span></div>
  <div class="mainline"><p class="lead">主线：Agent 交付结果。</p></div>
  <div class="tri">
    <div><h4>技术要点</h4><ul><li>受控证据</li><li>可回溯</li></ul></div>
    <div><h4>方案要点</h4><ul><li>组合能力</li></ul></div>
  </div>
  <div class="talk key" id="talk-1">
    <div class="talk-h"><span class="who">张三</span><span class="role">首席科学家</span><span class="title">Agentic Cloud</span><span class="tag">智能体</span></div>
    <div class="talk-b"><div><ul><li>第一行要点</li><li>第二行要点</li></ul></div></div>
  </div>
  <div class="talk" id="talk-2"><div class="talk-h"><span class="who">李四</span></div><div class="talk-b"></div></div>
  <div class="tnote">现场补充：回放已核验。</div>
  <div class="gap-card">缺口：未给出定价。</div>
</section>
<section id="method">
  <div class="method">
    <h3>采集方式</h3><p>只读取本机整理稿。</p>
    <h3>可信度规则</h3><ul><li>回放核验后才标注</li></ul>
    <table><tr><td>字段</td><td>含义</td></tr></table>
  </div>
  <div class="gap-card">缺口：部分论坛无速记。</div>
</section>
</body></html>
"""


class HighlightsFixtureTest(unittest.TestCase):
    """Shared temp tree: <tmp>/场景/云栖/highlights.html."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base = Path(self.temp_dir.name).resolve()
        self.root = self.base / "场景"
        (self.root / "云栖").mkdir(parents=True)
        self.source = self.root / "云栖" / "highlights.html"
        self.source.write_text(FIXTURE, encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def build(self) -> dict:
        return yh.build_highlights(source_path=self.source, root=self.root)


class TextHelperTest(unittest.TestCase):
    def test_text_of_marks_line_breaks_and_collapses_spaces(self) -> None:
        node = yh.parse_html("<p>第一行　<b>加粗</b><br>第二行</p>")

        self.assertEqual(yh.text_of(yh.find_first(node, tag="p")), "第一行 加粗 ⏎ 第二行")

    def test_one_line_flattens_breaks_and_truncates(self) -> None:
        node = yh.parse_html("<p>甲<br>乙<br>丙</p>")

        self.assertEqual(yh.one_line(yh.find_first(node, tag="p")), "甲 · 乙 · 丙")
        self.assertEqual(yh.one_line(yh.find_first(node, tag="p"), limit=4), "甲 · ")

    def test_one_line_of_missing_node_is_empty(self) -> None:
        self.assertEqual(yh.one_line(None), "")

    def test_split_lines_drops_blank_rows(self) -> None:
        node = yh.parse_html("<td>甲<br><br>  <br>乙</td>")

        self.assertEqual(yh.split_lines(yh.find_first(node, tag="td")), ["甲", "乙"])

    def test_list_items_respects_limit_and_skips_empty(self) -> None:
        node = yh.parse_html("<ul><li>甲</li><li>  </li><li>乙</li><li>丙</li></ul>")

        self.assertEqual(yh.list_items(yh.find_first(node, tag="ul"), limit=2), ["甲", "乙"])

    def test_list_items_of_missing_container_is_empty(self) -> None:
        self.assertEqual(yh.list_items(None), [])

    def test_valid_text_replaces_lone_surrogates(self) -> None:
        self.assertEqual(yh._valid_text("\ud800"), "\ufffd")

    def test_utc_iso_is_zulu_and_second_precision(self) -> None:
        self.assertRegex(yh.utc_iso(1_760_000_000), r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertRegex(yh.utc_iso(), r"Z$")


class FinderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.document = yh.parse_html(
            '<div><section id="a"><span class="tag x">甲</span></section>'
            '<section id="b"><span class="tag">乙</span></section></div>'
        )

    def test_find_all_matches_tag_and_class_independently(self) -> None:
        self.assertEqual(len(yh.find_all(self.document, tag="section")), 2)
        self.assertEqual(len(yh.find_all(self.document, class_name="tag")), 2)
        self.assertEqual(len(yh.find_all(self.document, tag="span", class_name="x")), 1)

    def test_find_first_returns_none_when_absent(self) -> None:
        self.assertIsNone(yh.find_first(self.document, tag="table"))

    def test_section_by_id_and_ordered_sections(self) -> None:
        self.assertEqual(yh.section_by_id(self.document, "b").attrs["id"], "b")
        self.assertIsNone(yh.section_by_id(self.document, "missing"))
        self.assertEqual([node.attrs["id"] for node in yh.ordered_sections(self.document)], ["a", "b"])

    def test_node_class_helpers(self) -> None:
        node = yh.find_first(self.document, class_name="x")

        self.assertEqual(node.classes, {"tag", "x"})
        self.assertTrue(node.has_class("tag"))
        self.assertFalse(node.has_class("missing"))


class EvidenceLinkTest(unittest.TestCase):
    def test_maps_anchor_and_https_targets(self) -> None:
        node = yh.parse_html(
            '<div><a href="#talk-7">讲者卡</a><a href="https://example.com/a">报告</a></div>'
        )

        self.assertEqual(
            yh.evidence_links(node),
            [
                {"label": "讲者卡", "anchor": "talk-7"},
                {"label": "报告", "url": "https://example.com/a"},
            ],
        )

    def test_drops_blank_labels_and_keeps_unsupported_schemes_as_text(self) -> None:
        node = yh.parse_html(
            '<div><a href="#x">  </a><a href="/local">相对</a>'
            '<a href="file:///etc/passwd">文件</a><a>无链接</a></div>'
        )

        self.assertEqual(
            yh.evidence_links(node),
            [{"label": "相对"}, {"label": "文件"}, {"label": "无链接"}],
        )

    def test_caps_lengths_and_item_count(self) -> None:
        markup = "".join(f'<a href="#{"t" * 80}">{"标" * 40}</a>' for _ in range(yh.MAX_LIST_ITEMS + 3))
        links = yh.evidence_links(yh.parse_html(f"<div>{markup}</div>"))

        self.assertEqual(len(links), yh.MAX_LIST_ITEMS)
        self.assertTrue(all(len(link["anchor"]) <= 64 for link in links))
        self.assertTrue(all(len(link["label"]) <= 120 for link in links))

    def test_missing_container_yields_empty_list(self) -> None:
        self.assertEqual(yh.evidence_links(None), [])

    def test_tag_labels_skips_empty_tags(self) -> None:
        node = yh.parse_html('<div><span class="tag">智能体</span><span class="tag"> </span></div>')

        self.assertEqual(yh.tag_labels(node), ["智能体"])
        self.assertEqual(yh.tag_labels(None), [])


class ParserRobustnessTest(unittest.TestCase):
    def test_unclosed_markup_does_not_crash(self) -> None:
        document = yh.parse_html("<div><h1>标题<p>正文")

        self.assertEqual(yh.one_line(yh.find_first(document, tag="p")), "正文")
        self.assertEqual(yh.one_line(yh.find_first(document, tag="h1")), "标题正文")

    def test_end_tag_pops_to_the_matching_ancestor(self) -> None:
        document = yh.parse_html("<div><span><b>甲</b></span>乙</div>丙")

        self.assertEqual(yh.one_line(yh.find_first(document, tag="span")), "甲")
        self.assertEqual(yh.one_line(yh.find_first(document, tag="div")), "甲乙")

    def test_void_tags_do_not_swallow_siblings(self) -> None:
        document = yh.parse_html('<div><img src="a.png"><span>甲</span></div>')

        self.assertEqual(yh.one_line(yh.find_first(document, tag="span")), "甲")
        self.assertEqual(yh.find_first(document, tag="img").attrs["src"], "a.png")

    def test_entities_are_decoded(self) -> None:
        document = yh.parse_html("<p>A &amp; B &lt;C&gt;</p>")

        self.assertEqual(yh.one_line(yh.find_first(document, tag="p")), "A & B <C>")


class TalkAndForumTest(HighlightsFixtureTest):
    def setUp(self) -> None:
        super().setUp()
        self.payload = self.build()
        self.forum = self.payload["forums"][0]

    def test_forum_belongs_to_its_layer(self) -> None:
        self.assertEqual(self.forum["id"], "forum-1")
        self.assertEqual(self.forum["layerId"], "l1")
        self.assertEqual(self.forum["title"], "智能体主论坛")
        self.assertEqual(self.forum["meta"], ["10-24 09:00", "杭州云栖小镇"])
        self.assertEqual(self.forum["lead"], "主线：Agent 交付结果。")

    def test_forum_sections_keep_heading_and_items(self) -> None:
        self.assertEqual(
            self.forum["sections"],
            [
                {"heading": "技术要点", "items": ["受控证据", "可回溯"]},
                {"heading": "方案要点", "items": ["组合能力"]},
            ],
        )

    def test_key_talk_is_flagged_and_headline_is_first_item(self) -> None:
        first, second = self.forum["talks"]

        self.assertEqual(self.forum["talkCount"], 2)
        self.assertEqual(first["id"], "talk-1")
        self.assertTrue(first["key"])
        self.assertEqual(first["who"], "张三")
        self.assertEqual(first["role"], "首席科学家")
        self.assertEqual(first["title"], "Agentic Cloud")
        self.assertEqual(first["tags"], ["智能体"])
        self.assertEqual(first["headline"], "第一行要点")
        self.assertFalse(second["key"])
        self.assertEqual(second["headline"], "")

    def test_notes_and_gaps_are_collected(self) -> None:
        self.assertEqual(self.forum["notes"], ["现场补充：回放已核验。"])
        self.assertEqual(self.forum["gapNotes"], ["缺口：未给出定价。"])

    def test_talks_are_capped_per_forum(self) -> None:
        markup = "".join(f'<div class="talk" id="t{i}"><div class="talk-h"><span class="who">讲者{i}</span></div></div>' for i in range(yh.MAX_TALKS_PER_FORUM + 5))
        document = yh.parse_html(f"<section id='f'>{markup}</section>")
        forum = yh.parse_forum(yh.section_by_id(document, "f"), "l1")

        self.assertEqual(len(forum["talks"]), yh.MAX_TALKS_PER_FORUM)
        self.assertEqual(forum["talkCount"], yh.MAX_TALKS_PER_FORUM + 5)

    def test_section_without_tri_still_parses(self) -> None:
        document = yh.parse_html('<section id="f"><h2>无要点论坛</h2></section>')
        forum = yh.parse_forum(yh.section_by_id(document, "f"), "l2")
        self.assertEqual(forum["id"], "f")

        self.assertEqual(forum["sections"], [])
        self.assertEqual(forum["talks"], [])
        self.assertEqual(forum["gapNotes"], [])


class OverviewAndLayerTest(HighlightsFixtureTest):
    def setUp(self) -> None:
        super().setUp()
        self.payload = self.build()

    def test_thesis_is_extracted(self) -> None:
        self.assertEqual(
            self.payload["thesis"],
            {
                "tag": "主线判断",
                "statement": "从产业范式到 Agentic Cloud 底座",
                "note": "六层结构 · 本机整理稿",
            },
        )

    def test_synthesis_cards_carry_evidence(self) -> None:
        self.assertEqual(
            self.payload["synthesis"],
            [
                {
                    "index": 1,
                    "title": "综合判断一",
                    "body": "Agent 成为新的交付单元。",
                    "evidence": [
                        {"label": "讲者卡 1", "anchor": "talk-1"},
                        {"label": "官方报告", "url": "https://example.com/report"},
                    ],
                }
            ],
        )

    def test_trends_are_grouped_by_layer_position(self) -> None:
        self.assertEqual(
            [(trend["id"], trend["index"], trend["layerId"]) for trend in self.payload["trends"]],
            [("trend-01", 1, "l1"), ("trend-02", 2, "l1"), ("trend-03", 3, "l2")],
        )
        self.assertEqual(self.payload["trends"][0]["groupBadge"], "L1")
        self.assertEqual(self.payload["trends"][2]["groupHeading"], "模型与知识")
        self.assertEqual(self.payload["trends"][2]["body"], "RAG 走向受控证据。")
        self.assertEqual(self.payload["trends"][0]["evidence"], [{"label": "证据", "anchor": "talk-1"}])
        self.assertEqual(self.payload["trends"][1]["evidence"], [])

    def test_trend_without_digits_falls_back_to_position(self) -> None:
        document = yh.parse_html(
            '<section id="overview"><div class="layer-h"><span class="lv">L1</span><h3>层</h3></div>'
            '<div class="ov-grid"><div class="ov"><span class="n">趋势</span><h3>甲</h3></div></div></section>'
        )

        _, _, trends = yh.parse_overview(document)

        self.assertEqual([(trend["id"], trend["index"]) for trend in trends], [("trend-1", 1)])

    def test_layer_divider_and_forum_table(self) -> None:
        layer = self.payload["layers"][0]

        self.assertEqual(layer["id"], "l1")
        self.assertEqual(layer["order"], 1)
        self.assertEqual(layer["label"], "第一层")
        self.assertEqual(layer["title"], "应用与智能体")
        self.assertEqual(layer["summary"], "入口层判断")
        self.assertEqual(layer["trendIds"], ["trend-01", "trend-02"])
        self.assertEqual(layer["forumIds"], ["forum-1"])
        self.assertEqual(
            layer["forums"],
            [
                {
                    "id": "forum-1",
                    "title": "智能体主论坛",
                    "agenda": "Agentic 应用",
                    "when": "10-24 09:00",
                    "where": "杭州云栖小镇",
                    "positioning": "面向业务",
                    "releases": "发布 A",
                    "cases": "案例 B",
                }
            ],
        )

    def test_layer_without_table_has_no_forum_rows(self) -> None:
        document = yh.parse_html('<section id="l1"><div class="divider"><h2>层</h2></div></section>')

        self.assertEqual(yh.parse_forum_table(yh.section_by_id(document, "l1")), [])

    def test_short_table_rows_are_skipped(self) -> None:
        document = yh.parse_html('<section id="l1"><table><tr><td>只有一个单元格</td></tr></table></section>')

        self.assertEqual(yh.parse_forum_table(yh.section_by_id(document, "l1")), [])

    def test_missing_overview_raises(self) -> None:
        source = self.root / "云栖" / "no-overview.html"
        source.write_text("<html><body><h1>缺总览</h1></body></html>", encoding="utf-8")

        with self.assertRaises(yh.YunqiHighlightsError):
            yh.build_highlights(source_path=source, root=self.root)

    def test_missing_method_section_is_tolerated(self) -> None:
        document = yh.parse_html(FIXTURE.replace('<section id="method">', '<section id="notes">'))

        self.assertEqual(yh.parse_method(document), {"sections": [], "gaps": []})


class MethodTest(HighlightsFixtureTest):
    def test_sections_split_on_headings(self) -> None:
        method = self.build()["method"]

        self.assertEqual([section["heading"] for section in method["sections"]], ["采集方式", "可信度规则"])
        self.assertEqual(method["sections"][0]["body"], "只读取本机整理稿。")
        self.assertEqual(method["sections"][0]["rows"], [])
        self.assertEqual(
            method["sections"][1]["rows"],
            ["回放核验后才标注", "字段 ｜ 含义"],
        )
        self.assertEqual(method["gaps"], ["缺口：部分论坛无速记。"])

    def test_table_rows_are_joined_and_truncated(self) -> None:
        document = yh.parse_html(
            '<section id="method"><div class="method"><h3>表</h3>'
            "<table><tr><td>甲</td><td>乙</td></tr><tr><th>表头</th></tr></table></div></section>"
        )

        self.assertEqual(yh.parse_method(document)["sections"][0]["rows"], ["甲 ｜ 乙"])


class BuildHighlightsTest(HighlightsFixtureTest):
    def test_payload_shape_and_stats(self) -> None:
        payload = self.build()

        self.assertEqual(payload["schemaVersion"], yh.SCHEMA_VERSION)
        self.assertEqual(payload["mode"], "local-content-highlights")
        self.assertEqual(payload["label"], "云栖大会重点内容")
        self.assertEqual(
            payload["stats"],
            {
                "layers": 1,
                "trends": 3,
                "synthesis": 1,
                "forums": 1,
                "talks": 2,
                "gaps": 2,
                "methodSections": 2,
            },
        )

    def test_source_metadata_stays_relative_and_fingerprinted(self) -> None:
        source = self.build()["source"]

        self.assertEqual(source["id"], yh.SOURCE_ID)
        self.assertEqual(source["title"], "2026 云栖大会 · 六层趋势整理")
        self.assertEqual(source["relativePath"], "云栖/highlights.html")
        self.assertEqual(source["type"], "HTML")
        self.assertEqual(source["bytes"], self.source.stat().st_size)
        self.assertRegex(source["digest"], r"^sha256:[0-9a-f]{16}$")
        self.assertRegex(source["modifiedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(source["absolutePath"], str(self.source))

    def test_title_falls_back_to_the_file_stem(self) -> None:
        source = self.root / "云栖" / "无标题.html"
        source.write_text(FIXTURE.replace("<h1>2026 云栖大会 · 六层趋势整理</h1>", ""), encoding="utf-8")

        self.assertEqual(
            yh.build_highlights(source_path=source, root=self.root)["source"]["title"],
            "无标题",
        )

    def test_rejects_a_missing_source(self) -> None:
        with self.assertRaises(yh.YunqiHighlightsError):
            yh.build_highlights(source_path=self.root / "云栖" / "missing.html", root=self.root)

    def test_rejects_a_directory_as_source(self) -> None:
        with self.assertRaises(yh.YunqiHighlightsError):
            yh.build_highlights(source_path=self.root / "云栖", root=self.root)

    def test_rejects_a_source_outside_the_root(self) -> None:
        outside = self.base / "outside.html"
        outside.write_text(FIXTURE, encoding="utf-8")

        with self.assertRaises(yh.YunqiHighlightsError):
            yh.build_highlights(source_path=outside, root=self.root)

    def test_rejects_a_symlink_escaping_the_root(self) -> None:
        outside = self.base / "target.html"
        outside.write_text(FIXTURE, encoding="utf-8")
        link = self.root / "云栖" / "link.html"
        link.symlink_to(outside)

        with self.assertRaises(yh.YunqiHighlightsError):
            yh.build_highlights(source_path=link, root=self.root)

    def test_rejects_a_relative_escape_from_the_root(self) -> None:
        outside = self.base / "escape.html"
        outside.write_text(FIXTURE, encoding="utf-8")

        with self.assertRaises(yh.YunqiHighlightsError):
            yh.build_highlights(source_path=self.root / "云栖" / ".." / ".." / "escape.html", root=self.root)

    def test_undecodable_bytes_are_replaced_not_fatal(self) -> None:
        markup = '<html><body><h1>标题</h1><section id="overview"></section></body></html>'
        source = self.root / "云栖" / "latin.html"
        source.write_bytes(markup.encode("utf-8").replace("标题".encode("utf-8"), b"\xff\xfe"))

        payload = yh.build_highlights(source_path=source, root=self.root)

        self.assertEqual(payload["stats"]["layers"], 0)
        self.assertIn("\ufffd", payload["source"]["title"])


class AtomicWriteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_creates_parents_and_writes_valid_json(self) -> None:
        output = self.base / ".local-cache" / "nested" / "yunqi-highlights.json"

        yh.atomic_write_json(output, {"label": "云栖大会重点内容", "layers": [1, 2]})

        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {"label": "云栖大会重点内容", "layers": [1, 2]})

    def test_leaves_no_temporary_files_behind(self) -> None:
        output = self.base / "cache" / "highlights.json"
        yh.atomic_write_json(output, {"ok": True})

        self.assertEqual(sorted(path.name for path in output.parent.iterdir()), ["highlights.json"])

    def test_overwrites_an_existing_payload(self) -> None:
        output = self.base / "highlights.json"
        output.write_text('{"stale": true}', encoding="utf-8")

        yh.atomic_write_json(output, {"fresh": True})

        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {"fresh": True})


class MainTest(HighlightsFixtureTest):
    def run_main(self, output: Path) -> int:
        argv = [
            "yunqi_highlights.py",
            "--source",
            str(self.source),
            "--root",
            str(self.root),
            "--output",
            str(output),
        ]
        with mock.patch("sys.argv", argv), contextlib.redirect_stdout(io.StringIO()) as printed:
            code = yh.main()
        self.output_text = printed.getvalue()
        return code

    def test_writes_the_local_cache_and_reports_stats(self) -> None:
        output = self.base / ".local-cache" / "yunqi-highlights.json"

        self.assertEqual(self.run_main(output), 0)

        payload = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(payload["stats"]["forums"], 1)
        self.assertIn("1 层 / 3 条趋势 / 1 条综合判断 / 1 场论坛 / 2 张讲者卡", self.output_text)

    def test_refuses_to_write_into_public(self) -> None:
        with self.assertRaises(yh.YunqiHighlightsError):
            self.run_main(self.base / "public" / "data" / "yunqi-highlights.json")

    def test_refuses_to_write_into_dist(self) -> None:
        with self.assertRaises(yh.YunqiHighlightsError):
            self.run_main(self.base / "dist" / "yunqi-highlights.json")

    def test_public_or_dist_rejection_happens_before_reading_the_source(self) -> None:
        with self.assertRaises(yh.YunqiHighlightsError):
            self.run_main(self.base / "public" / "never-written.json")
        self.assertFalse((self.base / "public").exists())

    def test_defaults_point_at_the_local_cache(self) -> None:
        project_root = Path(yh.__file__).resolve().parents[1]

        with mock.patch("sys.argv", ["yunqi_highlights.py"]):
            args = yh.parse_args()

        self.assertEqual(args.output, project_root / ".local-cache/yunqi-highlights.json")
        self.assertEqual(args.source, yh.DEFAULT_SOURCE)
        self.assertEqual(args.root, yh.DEFAULT_ROOT)
        self.assertNotIn("public", args.output.parts)
        self.assertNotIn("dist", args.output.parts)


if __name__ == "__main__":
    unittest.main()
