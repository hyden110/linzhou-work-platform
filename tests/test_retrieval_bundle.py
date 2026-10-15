from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from sync import retrieval_bundle


class RetrievalBundleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base = Path(self.temp_dir.name)
        self.index_path = self.base / "knowledge-index.json"
        self.payload_path = self.base / "knowledge-upload-payload.json"
        self.output_path = self.base / "public" / "retrieval-bundle.json"
        self.function_output_path = self.base / "functions" / "retrieval-bundle.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_inputs(self) -> None:
        home = str(Path.home())
        self.index_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "mode": "local-index-preview",
                    "documents": [
                        {
                            "id": "doc-1",
                            "title": "零售 Agent 方案",
                            "source": "cases",
                            "sourceLabel": "案例库",
                            "relativePath": "零售/agent方案.pdf",
                            "type": "PDF",
                            "modifiedAt": "2026-10-08T09:00:00Z",
                            "topics": ["零售与消费", "AI 与智能体"],
                            "location": "本地文件 · 相对路径",
                            "absolutePath": f"{home}/secret.pdf",
                            "fingerprint": {"sha256": "secret-hash"},
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.payload_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "mode": "local-knowledge-upload-payload",
                    "documents": [
                        {
                            "id": "doc-1",
                            "source": "cases",
                            "relativePath": "零售/agent方案.pdf",
                            "title": "零售 Agent 方案",
                            "summary": (
                                f"总结包含本地路径 {home}/private、sk-abcdefghijklmnopqrstuv、"
                                "github_pat_abcdefghijklmnopqrstuvwxyz123456、API_KEY=example-secret-value "
                                "以及 JSON 配置 \"api_key\": \"json-secret-value\""
                            ),
                            "citations": [
                                {"locator": {"kind": "page", "value": "1"}, "text": "引用一 token: abcdefghijklmnop"},
                                {"locator": {"kind": "page", "value": "2"}, "text": "引用二"},
                                {"locator": {"kind": "page", "value": "3"}, "text": "引用三"},
                                *(
                                    {"locator": {"kind": "page", "value": str(page)}, "text": f"引用{page}"}
                                    for page in range(4, 13)
                                ),
                                {"locator": {"kind": "page", "value": "13"}, "text": "不应出现"},
                            ],
                            "rawText": "完整正文不得进入数据包",
                            "credential": "secret-token",
                        }
                    ],
                },
                ensure_ascii=True,
            ),
            encoding="utf-8",
        )

    def test_builds_bounded_safe_retrieval_bundle(self) -> None:
        self.write_inputs()

        bundle = retrieval_bundle.build_retrieval_bundle(
            index_path=self.index_path,
            payload_paths=(self.payload_path,),
            output_path=self.output_path,
            mirror_paths=(self.function_output_path,),
        )
        persisted = json.loads(self.output_path.read_text(encoding="utf-8"))
        function_bundle = json.loads(self.function_output_path.read_text(encoding="utf-8"))

        self.assertEqual(bundle, persisted)
        self.assertEqual(bundle, function_bundle)
        self.assertEqual(bundle["mode"], "safe-retrieval-bundle")
        self.assertEqual(bundle["documentCount"], 1)
        document = bundle["documents"][0]
        self.assertEqual(document["id"], "doc-1")
        self.assertEqual(document["sourceLabel"], "案例库")
        self.assertEqual(document["topics"], ["零售与消费", "AI 与智能体"])
        self.assertEqual(len(document["citations"]), retrieval_bundle.MAX_CITATIONS)
        self.assertIn("<HOME>", document["summary"])
        self.assertIn("[REDACTED]", document["summary"])
        self.assertIn("[REDACTED]", document["citations"][0]["text"])
        self.assertNotIn("vector", document)
        self.assertNotIn("embedding", bundle)
        serialized = json.dumps(bundle, ensure_ascii=False)
        for forbidden in (
            str(Path.home()),
            "sk-abcdefghijklmnopqrstuv",
            "github_pat_abcdefghijklmnopqrstuvwxyz123456",
            "example-secret-value",
            "json-secret-value",
            "abcdefghijklmnop",
            "secret-hash",
            "secret-token",
            "完整正文不得进入数据包",
            "不应出现",
            "absolutePath",
            "fingerprint",
            "rawText",
            "credential",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_embeds_only_redacted_bundle_text(self) -> None:
        self.write_inputs()
        seen: list[str] = []

        def fake_embed(texts):
            seen.extend(texts)
            return [f"v{position}" for position in range(len(texts))]

        bundle = retrieval_bundle.build_retrieval_bundle(
            index_path=self.index_path,
            payload_paths=(self.payload_path,),
            output_path=self.output_path,
            embed=fake_embed,
            embedding={"model": "fake", "dimensions": 4},
        )

        document = bundle["documents"][0]
        self.assertEqual(bundle["embedding"], {"model": "fake", "dimensions": 4})
        self.assertEqual(document["vector"], "v0")
        self.assertEqual([item["vector"] for item in document["citations"]], [f"v{n}" for n in range(1, 13)])
        sent = "\n".join(seen)
        self.assertIn("零售 Agent 方案", sent)
        for forbidden in (str(Path.home()), "sk-abcdefghijklmnopqrstuv", "完整正文不得进入数据包", "不应出现"):
            self.assertNotIn(forbidden, sent)

    def test_ignores_payload_documents_missing_from_public_index(self) -> None:
        self.write_inputs()
        payload = json.loads(self.payload_path.read_text(encoding="utf-8"))
        payload["documents"].append(
            {
                "id": "private-only",
                "source": "private",
                "relativePath": "hidden.pdf",
                "title": "Hidden",
                "summary": "不得公开",
                "citations": [],
            }
        )
        self.payload_path.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")

        bundle = retrieval_bundle.build_retrieval_bundle(
            index_path=self.index_path,
            payload_paths=(self.payload_path,),
            output_path=self.output_path,
        )

        self.assertEqual([item["id"] for item in bundle["documents"]], ["doc-1"])
        self.assertEqual(bundle["skippedCount"], 1)
        self.assertNotIn("不得公开", json.dumps(bundle, ensure_ascii=False))

    def test_rejects_non_distinct_output_path(self) -> None:
        self.write_inputs()

        with self.assertRaises(retrieval_bundle.RetrievalBundleError):
            retrieval_bundle.build_retrieval_bundle(
                index_path=self.index_path,
                payload_paths=(self.payload_path,),
                output_path=self.payload_path,
            )


if __name__ == "__main__":
    unittest.main()
