from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sync import knowledge_processor
from sync.content_extractors import ContentSegment, ExtractionResult


class KnowledgeProcessorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base = Path(self.temp_dir.name)
        self.root = self.base / "资料"
        self.root.mkdir()
        self.index_path = self.base / "local-index-state.json"
        self.state_path = self.base / "knowledge-processing-state.json"
        self.payload_path = self.base / "knowledge-upload-payload.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_index(self, documents: list[dict[str, object]]) -> None:
        payload = {
            "roots": [{"id": "source-a", "absolutePath": str(self.root)}],
            "documents": documents,
        }
        self.index_path.write_text(json.dumps(payload), encoding="utf-8")

    @staticmethod
    def document(relative_path: str, fingerprint: dict[str, object] | None = None) -> dict[str, object]:
        return {
            "id": f"id-{relative_path}",
            "source": "source-a",
            "relativePath": relative_path,
            "fingerprint": fingerprint or {"mtimeNs": 1, "size": 10, "sha256": "private-hash"},
        }

    @staticmethod
    def extracted(*segments: ContentSegment) -> ExtractionResult:
        return ExtractionResult(
            status="extracted",
            file_type=".md",
            title="文档标题",
            segments=segments,
            total_characters=sum(len(segment.text) for segment in segments),
        )

    def process(self) -> dict[str, object]:
        return knowledge_processor.process_knowledge_index(
            index_path=self.index_path,
            state_path=self.state_path,
            payload_path=self.payload_path,
        )

    def test_upload_payload_never_leaks_sensitive_fields(self) -> None:
        relative_path = "案例/方案.md"
        source = self.root / relative_path
        source.parent.mkdir()
        source.write_text("# 方案\n\n客户价值和实施路径。", encoding="utf-8")
        self.write_index([self.document(relative_path)])

        payload = self.process()

        persisted_payload = json.loads(self.payload_path.read_text(encoding="utf-8"))
        private_state = json.loads(self.state_path.read_text(encoding="utf-8"))
        serialized = json.dumps(persisted_payload, ensure_ascii=False)
        self.assertEqual(payload, persisted_payload)
        self.assertNotIn(str(self.root), serialized)
        self.assertNotIn("absolutePath", serialized)
        self.assertNotIn("fingerprint", serialized)
        self.assertNotIn("sha256", serialized)
        self.assertIn("fingerprint", private_state["documents"][0])
        self.assertEqual(
            persisted_payload["documents"][0]["citations"][0]["locator"],
            {"kind": "section", "value": "方案"},
        )

    def test_replaces_unpaired_surrogates_before_persisting_payload(self) -> None:
        relative_path = "invalid-unicode.md"
        (self.root / relative_path).write_text("content", encoding="utf-8")
        self.write_index([self.document(relative_path)])
        extraction = ExtractionResult(
            status="extracted",
            file_type=".md",
            title="文档\ud83d标题",
            segments=(ContentSegment("段落", "section", "段落", "正文\ud83d内容"),),
            total_characters=5,
        )

        with mock.patch.object(knowledge_processor, "extract_content", return_value=extraction):
            payload = self.process()

        persisted_payload = json.loads(self.payload_path.read_bytes().decode("utf-8"))
        persisted_document = persisted_payload["documents"][0]
        self.assertEqual(payload, persisted_payload)
        self.assertEqual(persisted_document["title"], "文档�标题")
        self.assertEqual(persisted_document["summary"], "正文�内容")
        self.assertNotIn("\\ud83d", json.dumps(persisted_payload))

    def test_redacts_home_paths_from_extracted_and_cached_text(self) -> None:
        relative_path = "private.md"
        (self.root / relative_path).write_text("content", encoding="utf-8")
        self.write_index([self.document(relative_path)])
        home = str(Path.home())
        private_path = f"{home}/Documents/private.md"
        extraction = ExtractionResult(
            status="extracted",
            file_type=".md",
            title="参考 ~/Documents/private.md",
            segments=(ContentSegment("引用", "section", private_path, f"摘要来自 {private_path}"),),
            total_characters=len(private_path),
        )

        with mock.patch.object(knowledge_processor, "extract_content", return_value=extraction):
            payload = self.process()

        persisted_payload = json.loads(self.payload_path.read_text(encoding="utf-8"))
        private_state = json.loads(self.state_path.read_text(encoding="utf-8"))
        for value in (payload, persisted_payload, private_state):
            serialized = json.dumps(value, ensure_ascii=False)
            self.assertNotIn(home, serialized)
            self.assertIn("<HOME>/Documents/private.md", serialized)

        private_state["documents"][0]["result"]["summary"] = private_path
        self.state_path.write_text(json.dumps(private_state, ensure_ascii=False), encoding="utf-8")
        with mock.patch.object(
            knowledge_processor,
            "extract_content",
            side_effect=AssertionError("matching cached content must not be extracted"),
        ) as extractor:
            cached_payload = self.process()
        extractor.assert_not_called()
        cached_state = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertNotIn(home, json.dumps(cached_payload, ensure_ascii=False))
        self.assertNotIn(home, json.dumps(cached_state, ensure_ascii=False))
        self.assertIn("<HOME>/Documents/private.md", cached_payload["documents"][0]["summary"])

    def test_reuses_previous_result_when_fingerprint_is_unchanged(self) -> None:
        relative_path = "reuse.md"
        (self.root / relative_path).write_text("content", encoding="utf-8")
        self.write_index([self.document(relative_path)])
        result = self.extracted(ContentSegment("A", "section", "A", "reusable text"))

        with mock.patch.object(knowledge_processor, "extract_content", return_value=result) as extractor:
            first = self.process()
        extractor.assert_called_once_with(
            (self.root / relative_path).resolve(),
            max_total_characters=knowledge_processor.MAX_EXTRACTED_CHARACTERS,
        )

        with mock.patch.object(
            knowledge_processor,
            "extract_content",
            side_effect=AssertionError("unchanged content must not be extracted"),
        ) as extractor:
            second = self.process()
        extractor.assert_not_called()
        self.assertEqual(first["documents"], second["documents"])
        self.assertEqual(second["summary"], {"processed": 0, "reused": 1, "failed": 0})

    def test_limits_upload_to_bounded_citations_covering_the_whole_document(self) -> None:
        relative_path = "many.md"
        (self.root / relative_path).write_text("content", encoding="utf-8")
        self.write_index([self.document(relative_path)])
        segments = tuple(
            ContentSegment(f"S{number}", "slide", str(number), f"第{number}页内容。" * 60)
            for number in range(1, 31)
        )

        with mock.patch.object(knowledge_processor, "extract_content", return_value=self.extracted(*segments)):
            payload = self.process()

        document = payload["documents"][0]
        locators = [citation["locator"]["value"] for citation in document["citations"]]
        self.assertLessEqual(len(document["summary"]), knowledge_processor.MAX_SUMMARY_CHARACTERS)
        self.assertEqual(len(document["citations"]), knowledge_processor.MAX_CITATIONS)
        self.assertEqual(locators[0], "1")
        self.assertEqual(locators[-1], "30")
        self.assertEqual(len(set(locators)), len(locators))
        self.assertTrue(
            all(
                len(citation["text"]) <= knowledge_processor.MAX_CITATION_CHARACTERS
                for citation in document["citations"]
            )
        )

    def test_short_documents_use_additional_windows_per_segment(self) -> None:
        relative_path = "short.md"
        (self.root / relative_path).write_text("content", encoding="utf-8")
        self.write_index([self.document(relative_path)])
        long_text = "".join(f"第{number}句说明了架构要点。" for number in range(80))
        segments = (ContentSegment("A", "section", "A", long_text),)

        with mock.patch.object(knowledge_processor, "extract_content", return_value=self.extracted(*segments)):
            payload = self.process()

        citations = payload["documents"][0]["citations"]
        self.assertEqual(len(citations), knowledge_processor.MAX_WINDOWS_PER_SEGMENT)
        self.assertNotEqual(citations[0]["text"], citations[1]["text"])
        self.assertTrue(citations[0]["text"].endswith("。"))

    def test_strips_markup_noise_and_table_of_contents(self) -> None:
        relative_path = "noisy.md"
        (self.root / relative_path).write_text("content", encoding="utf-8")
        self.write_index([self.document(relative_path)])
        segments = (
            ContentSegment("性能分析", "section", "性能分析", "<cite>\n- [a.yml](file://x/a.yml)\n</cite>\n"),
            ContentSegment("目录", "section", "性能分析 / 目录", "1. [简介](#简介)\n2. [结构](#结构)"),
            ContentSegment("简介", "section", "性能分析 / 简介", "系统通过 [SLS](file://sls.java) 采集指标并告警，支撑容量规划。"),
        )

        with mock.patch.object(knowledge_processor, "extract_content", return_value=self.extracted(*segments)):
            payload = self.process()

        document = payload["documents"][0]
        serialized = json.dumps(document, ensure_ascii=False)
        self.assertNotIn("<cite>", serialized)
        self.assertNotIn("file://", serialized)
        self.assertEqual([item["locator"]["value"] for item in document["citations"]], ["性能分析 / 简介"])
        self.assertIn("系统通过 SLS 采集指标", document["summary"])

    def test_cached_results_from_older_processor_versions_are_reprocessed(self) -> None:
        relative_path = "legacy.md"
        (self.root / relative_path).write_text("content", encoding="utf-8")
        self.write_index([self.document(relative_path)])
        result = self.extracted(ContentSegment("A", "section", "A", "新版本内容"))
        with mock.patch.object(knowledge_processor, "extract_content", return_value=result):
            self.process()
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        state["documents"][0]["processorVersion"] = "legacy"
        self.state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")

        with mock.patch.object(knowledge_processor, "extract_content", return_value=result) as extractor:
            payload = self.process()

        extractor.assert_called_once()
        self.assertEqual(payload["summary"], {"processed": 1, "reused": 0, "failed": 0})

    def test_isolates_single_file_errors_and_processes_remaining_files(self) -> None:
        for name in ("bad.md", "good.md"):
            (self.root / name).write_text(name, encoding="utf-8")
        self.write_index([self.document("bad.md"), self.document("good.md")])

        def selective_extract(path: Path, **_: object) -> ExtractionResult:
            if path.name == "bad.md":
                raise PermissionError("secret local detail")
            return self.extracted(ContentSegment("Good", "section", "Good", "usable"))

        with mock.patch.object(knowledge_processor, "extract_content", side_effect=selective_extract):
            payload = self.process()

        private_state = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual([item["relativePath"] for item in payload["documents"]], ["good.md"])
        self.assertEqual(payload["summary"], {"processed": 1, "reused": 0, "failed": 1})
        self.assertEqual(
            {item["relativePath"]: item["result"]["status"] for item in private_state["documents"]},
            {"bad.md": "error", "good.md": "processed"},
        )
        self.assertNotIn("secret local detail", json.dumps(payload))
        self.assertFalse(any(self.base.glob(".*.tmp")))

    def test_rejects_invalid_input_at_the_boundary_without_writing_outputs(self) -> None:
        self.write_index([self.document("../outside.md")])

        with self.assertRaisesRegex(knowledge_processor.InputValidationError, "relativePath"):
            self.process()

        self.assertFalse(self.state_path.exists())
        self.assertFalse(self.payload_path.exists())


if __name__ == "__main__":
    unittest.main()
