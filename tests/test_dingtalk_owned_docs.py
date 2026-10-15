import json
import tempfile
import unittest
from pathlib import Path

from sync import dingtalk_owned_docs


class DingTalkOwnedDocsTest(unittest.TestCase):
    def test_extracts_current_user_id_without_persisting_profile(self) -> None:
        payload = {
            "success": True,
            "result": [{"orgEmployeeModel": {"userId": "owner-1", "orgEmail": "private@example.com"}}],
        }

        self.assertEqual(dingtalk_owned_docs.extract_current_user_id(payload), "owner-1")

    def test_writes_explicit_capability_block_without_partial_documents(self) -> None:
        responses = iter(
            [
                {"success": True, "result": [{"orgEmployeeModel": {"userId": "owner-1"}}]},
                {"success": True, "result": {"items": [{"name": "unverified"}]}},
            ]
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "dingtalk-owned-docs.json"
            report = dingtalk_owned_docs.export_owned_documents(
                output,
                runner=lambda _args: next(responses),
            )
            persisted = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(report, persisted)
        self.assertEqual(report["status"], "blocked-capability")
        self.assertFalse(report["complete"])
        self.assertEqual(report["documents"], [])
        self.assertEqual(report["ownerUserId"], "owner-1")
        self.assertEqual(report["limitation"]["code"], "MISSING_COMPLETE_OWNER_ENUMERATION")
        self.assertNotIn("private@example.com", json.dumps(report))


if __name__ == "__main__":
    unittest.main()
