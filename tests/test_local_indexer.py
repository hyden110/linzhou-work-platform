import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sync import local_indexer


class LocalIndexerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "资料"
        self.root.mkdir()
        self.output = Path(self.temp_dir.name) / "knowledge-index.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_filters_unsupported_temporary_and_excluded_files(self) -> None:
        (self.root / "案例.pdf").write_bytes(b"case")
        (self.root / "notes.md").write_text("notes", encoding="utf-8")
        (self.root / "video.mp4").write_bytes(b"video")
        (self.root / "~$draft.pptx").write_bytes(b"draft")
        hidden = self.root / ".cache"
        hidden.mkdir()
        (hidden / "hidden.pdf").write_bytes(b"hidden")
        dependency = self.root / "node_modules"
        dependency.mkdir()
        (dependency / "dependency.pdf").write_bytes(b"dependency")

        result = local_indexer.build_index(
            roots=(local_indexer.SourceRoot("test", "测试资料", self.root),),
            previous_index={},
        )

        self.assertEqual(
            [document["relativePath"] for document in result["documents"]],
            ["notes.md", "案例.pdf"],
        )
        self.assertEqual(result["stats"]["totalDocuments"], 2)

    def test_ignores_symlink_files_directories_and_root_escape(self) -> None:
        regular = self.root / "inside.md"
        regular.write_bytes(b"inside")
        outside_file = Path(self.temp_dir.name) / "outside.md"
        outside_file.write_bytes(b"private outside content")
        outside_directory = Path(self.temp_dir.name) / "outside-directory"
        outside_directory.mkdir()
        (outside_directory / "nested.pdf").write_bytes(b"nested private content")
        linked_file = self.root / "linked.md"
        linked_file.symlink_to(outside_file)
        (self.root / "linked-directory").symlink_to(outside_directory, target_is_directory=True)
        root = local_indexer.SourceRoot("test", "测试资料", self.root)
        real_hasher = local_indexer.sha256_file

        def guarded_hasher(path: Path) -> str:
            self.assertNotEqual(path.resolve(), outside_file.resolve())
            self.assertNotEqual(path.resolve(), (outside_directory / "nested.pdf").resolve())
            return real_hasher(path)

        with mock.patch.object(local_indexer, "sha256_file", side_effect=guarded_hasher) as hasher:
            result = local_indexer.build_index(roots=(root,), previous_index={})

        self.assertEqual([item["relativePath"] for item in result["documents"]], ["inside.md"])
        hasher.assert_called_once_with(regular)
        with self.assertRaises(ValueError):
            local_indexer.create_document(root, linked_file, None)
        with self.assertRaises(ValueError):
            local_indexer.create_document(root, self.root / "linked-directory" / "nested.pdf", None)

    def test_hashes_only_new_or_changed_files(self) -> None:
        document = self.root / "方案.pdf"
        document.write_bytes(b"v1")
        roots = (local_indexer.SourceRoot("test", "测试资料", self.root),)
        first = local_indexer.build_index(roots=roots, previous_index={})

        with mock.patch.object(local_indexer, "sha256_file", wraps=local_indexer.sha256_file) as hasher:
            unchanged = local_indexer.build_index(roots=roots, previous_index=first)
            hasher.assert_not_called()

        document.write_bytes(b"version-two")
        stat = document.stat()
        os.utime(document, (stat.st_atime, stat.st_mtime + 2))
        with mock.patch.object(local_indexer, "sha256_file", wraps=local_indexer.sha256_file) as hasher:
            changed = local_indexer.build_index(roots=roots, previous_index=unchanged)
            self.assertEqual(hasher.call_count, 1)

        self.assertEqual(changed["syncSummary"]["updated"], 1)
        self.assertNotEqual(
            first["documents"][0]["fingerprint"]["sha256"],
            changed["documents"][0]["fingerprint"]["sha256"],
        )

    def test_isolates_file_errors_and_writes_valid_json_atomically(self) -> None:
        (self.root / "good.pdf").write_bytes(b"good")
        (self.root / "bad.pdf").write_bytes(b"bad")
        roots = (local_indexer.SourceRoot("test", "测试资料", self.root),)
        real_hasher = local_indexer.sha256_file

        def selective_hasher(path: Path) -> str:
            if path.name == "bad.pdf":
                raise PermissionError("denied")
            return real_hasher(path)

        with mock.patch.object(local_indexer, "sha256_file", side_effect=selective_hasher):
            result = local_indexer.generate_index(roots=roots, output_path=self.output)

        persisted = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(persisted["stats"]["totalDocuments"], 1)
        self.assertEqual(result["syncSummary"]["failed"], 1)
        self.assertEqual(result["errors"][0]["relativePath"], "bad.pdf")
        self.assertFalse(self.output.with_suffix(".json.tmp").exists())

    def test_replaces_unpaired_surrogates_in_index_fields_and_errors(self) -> None:
        valid_path = self.root / "方案\udcff.md"
        error_path = self.root / "错误\udcfe.pdf"
        root = local_indexer.SourceRoot("test", "根\ud83d标签", self.root)
        fake_stat = mock.Mock(st_mtime_ns=1, st_size=5, st_mtime=1)

        def selective_hasher(path: Path) -> str:
            if path == error_path:
                raise PermissionError("denied")
            return "hash"

        with mock.patch.object(
            local_indexer, "iter_source_files", return_value=[valid_path, error_path]
        ), mock.patch.object(
            Path, "resolve", autospec=True, side_effect=lambda path, **_kwargs: path
        ), mock.patch.object(
            Path, "is_symlink", autospec=True, return_value=False
        ), mock.patch.object(
            Path, "stat", autospec=True, return_value=fake_stat
        ), mock.patch.object(
            local_indexer, "sha256_file", side_effect=selective_hasher
        ):
            private_index = local_indexer.build_index(roots=(root,), previous_index={})
        result = local_indexer.create_public_index(private_index)
        local_indexer.atomic_write_json(self.output, result)

        persisted = json.loads(self.output.read_bytes().decode("utf-8"))
        self.assertEqual(result, persisted)
        self.assertEqual(persisted["roots"][0]["label"], "根�标签")
        self.assertEqual(persisted["documents"][0]["relativePath"], "方案�.md")
        self.assertEqual(persisted["documents"][0]["title"], "方案�")
        self.assertEqual(persisted["errors"][0]["relativePath"], "错误�.pdf")

    def test_atomic_json_write_replaces_surrogates_at_the_boundary(self) -> None:
        local_indexer.atomic_write_json(self.output, {"nested": {"text": "正常\ud83d文本"}})

        persisted = json.loads(self.output.read_bytes().decode("utf-8"))
        self.assertEqual(persisted, {"nested": {"text": "正常�文本"}})

    def test_keeps_paths_and_hashes_only_in_private_state(self) -> None:
        (self.root / "方案.pdf").write_bytes(b"private")
        roots = (local_indexer.SourceRoot("test", "测试资料", self.root),)
        state_path = Path(self.temp_dir.name) / ".local-cache" / "local-index-state.json"

        public_index = local_indexer.generate_index(
            roots=roots,
            output_path=self.output,
            state_path=state_path,
        )

        private_state = json.loads(state_path.read_text(encoding="utf-8"))
        serialized_public = json.dumps(public_index, ensure_ascii=False)
        self.assertIn(str(self.root), json.dumps(private_state, ensure_ascii=False))
        self.assertIn("sha256", private_state["documents"][0]["fingerprint"])
        self.assertNotIn(str(self.root), serialized_public)
        self.assertNotIn("fingerprint", public_index["documents"][0])
        self.assertEqual(public_index["roots"], [{"id": "test", "label": "测试资料"}])


if __name__ == "__main__":
    unittest.main()
