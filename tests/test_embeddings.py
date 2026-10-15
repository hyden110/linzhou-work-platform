from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from sync import embeddings


class EmbeddingsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_path = Path(self.temp_dir.name) / "embedding-cache.json"
        self.spec = embeddings.EmbeddingSpec(model="fake", dimensions=2)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_encode_int8_normalizes_and_quantizes(self) -> None:
        raw = base64.b64decode(embeddings.encode_int8([3.0, -4.0]))
        values = [byte - 256 if byte > 127 else byte for byte in raw]
        self.assertEqual(values, [76, -102])

    def test_embed_texts_batches_misses_and_reuses_cache(self) -> None:
        calls: list[list[str]] = []

        def fake_batch(texts):
            calls.append(list(texts))
            return [[1.0, float(len(text))] for text in texts]

        texts = [f"text-{n}" for n in range(12)] + ["text-0"]
        first = embeddings.embed_texts(texts, spec=self.spec, embed_batch=fake_batch, cache_path=self.cache_path)
        self.assertEqual(len(first), 13)
        self.assertEqual(first[0], first[-1])
        self.assertEqual(sorted(len(batch) for batch in calls), [2, 10])

        calls.clear()
        second = embeddings.embed_texts(texts, spec=self.spec, embed_batch=fake_batch, cache_path=self.cache_path)
        self.assertEqual(first, second)
        self.assertEqual(calls, [])
        self.assertNotIn("text-0", self.cache_path.read_text(encoding="utf-8"))

    def test_bailian_embedder_requires_api_key(self) -> None:
        with self.assertRaises(embeddings.EmbeddingError):
            embeddings.bailian_embedder(self.spec, "")


if __name__ == "__main__":
    unittest.main()
