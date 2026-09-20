"""Offline generator tests: no live API calls or generated media."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("audio", ROOT / "scripts/generate-ui-audio.py")
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


class AudioPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="admitflow-audio-test-")
        self.addCleanup(self.temp.cleanup)
        self.records = Path(self.temp.name) / "records"
        self.output = Path(self.temp.name) / "output"
        for name, value in [("RECORDS", self.records), ("OUTPUT", self.output)]:
            mock = patch.object(audio, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        mock = patch.dict(os.environ, {}, clear=True)
        mock.start()
        self.addCleanup(mock.stop)

    def test_missing_key_leaves_no_record_and_makes_no_request(self):
        with patch.object(audio.images.OPENER, "open", side_effect=AssertionError("No network")) as opener:
            with self.assertRaises(RuntimeError):
                audio.generate()
            opener.assert_not_called()
        self.assertFalse(self.records.exists())

    def test_request_construction_failure_leaves_no_submission_marker(self):
        os.environ["ELEVENLABS_API_KEY"] = "synthetic-test-only"
        with patch.object(audio.images, "api", return_value={"max_credit_limit_extension": 0, "character_limit": 100000}), patch.object(audio.urllib.request, "Request", side_effect=ValueError("invalid local request")), patch.object(audio.images.OPENER, "open") as opener:
            with self.assertRaises(ValueError):
                audio.generate()
            opener.assert_not_called()
        self.assertEqual(list(self.records.glob("*.json")), [])

    def test_lost_response_keeps_marker_and_refuses_automatic_replay(self):
        os.environ["ELEVENLABS_API_KEY"] = "synthetic-test-only"

        def lost_response(*_args, **_kwargs):
            records = list(self.records.glob("*.json"))
            self.assertEqual(len(records), 1)
            self.assertEqual(json.loads(records[0].read_text())["status"], "submitting")
            raise TimeoutError("private provider text")

        with patch.object(audio.images, "api", return_value={"max_credit_limit_extension": 0, "character_limit": 100000}), patch.object(audio.images.OPENER, "open", side_effect=lost_response) as opener:
            with self.assertRaisesRegex(RuntimeError, "uncertain"):
                audio.generate()
            with self.assertRaisesRegex(RuntimeError, "reconciliation"):
                audio.generate()
            self.assertEqual(opener.call_count, 1)
        saved = list(self.records.glob("*.json"))[0].read_text()
        self.assertEqual(json.loads(saved)["status"], "submission_unconfirmed")
        self.assertNotIn("private provider text", saved)
        self.assertNotIn("synthetic-test-only", saved)


if __name__ == "__main__":
    unittest.main()
