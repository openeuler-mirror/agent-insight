import http.server
import json
import tempfile
import threading
import unittest
from pathlib import Path

from agent_insight_copaw.config import CollectorConfig
from agent_insight_copaw.exporter import DeltaExporter, account_hash
from agent_insight_copaw.otlp import otlp_payload


class _CaptureHandler(http.server.BaseHTTPRequestHandler):
    received: list[bytes] = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        self.received.append(self.rfile.read(length))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):  # noqa: D401
        pass


class ExporterTest(unittest.TestCase):
    def setUp(self):
        _CaptureHandler.received = []
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _CaptureHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def _config(self, endpoint: str, **kwargs) -> CollectorConfig:
        values = dict(
            endpoint=endpoint,
            spool_dir=str(Path(self.tmp.name) / "spool"),
            log_file=str(Path(self.tmp.name) / "plugin.log"),
        )
        values.update(kwargs)
        return CollectorConfig(**values)

    def test_exporter_uploads_and_marks_sent(self):
        port = self.server.server_address[1]
        exporter = DeltaExporter(self._config(f"http://127.0.0.1:{port}/v1/traces"))
        payload = otlp_payload("qwenpaw", "session-a", "alice", "0.2.0", [])
        exporter.submit("session-a:span-1", payload)
        exporter.flush(timeout=3)
        exporter.close()

        self.assertEqual(len(_CaptureHandler.received), 1)
        body = json.loads(_CaptureHandler.received[0].decode("utf-8"))
        self.assertIn("resourceSpans", body)
        # AC22: uploaded file is not re-uploaded after restart (`.sent` marker).
        sent_files = list(Path(self.tmp.name, "spool").rglob("*.json.sent"))
        self.assertEqual(len(sent_files), 1)
        pending_files = list(Path(self.tmp.name, "spool").rglob("*.json"))
        self.assertEqual(pending_files, [])

    def test_exporter_keeps_spool_file_without_endpoint(self):
        exporter = DeltaExporter(self._config(""))
        exporter.submit("session-a:span-2", otlp_payload("qwenpaw", "session-a", "", "0.2.0", []))
        exporter.flush(timeout=3)
        exporter.close()

        spool_files = list(Path(self.tmp.name, "spool").rglob("*.json"))
        self.assertEqual(len(spool_files), 1)

    def test_account_isolation_by_api_key(self):
        """AC4: different API keys write to different sub-directories."""
        exporter_a = DeltaExporter(self._config("", api_key="wi_key_a"))
        exporter_b = DeltaExporter(self._config("", api_key="wi_key_b"))
        exporter_a.submit("s1", otlp_payload("qwenpaw", "s1", "", "0.2.0", []))
        exporter_b.submit("s2", otlp_payload("qwenpaw", "s2", "", "0.2.0", []))
        exporter_a.close()
        exporter_b.close()

        base = Path(self.tmp.name, "spool")
        dir_a = base / account_hash("wi_key_a")
        dir_b = base / account_hash("wi_key_b")
        self.assertTrue(any(dir_a.glob("*.json")))
        self.assertTrue(any(dir_b.glob("*.json")))
        self.assertEqual(len(list(dir_a.glob("*.json"))), 1)
        self.assertEqual(len(list(dir_b.glob("*.json"))), 1)

    def test_resume_after_restart(self):
        """AC22: spool files written by a previous process are uploaded on start."""
        port = self.server.server_address[1]
        config = self._config(f"http://127.0.0.1:{port}/v1/traces")
        first = DeltaExporter(config)
        first.submit("session-old:span-1", otlp_payload("qwenpaw", "session-old", "", "0.2.0", []))
        first.flush(timeout=3)
        first.close()
        _CaptureHandler.received.clear()

        second = DeltaExporter(config)
        second.flush(timeout=3)
        second.close()
        self.assertEqual(len(_CaptureHandler.received), 0)  # already marked .sent

        # Simulate a crash after spool write but before upload: a plain .json
        # file must be picked up by the new process and uploaded.
        pending = Path(self.tmp.name, "spool") / account_hash("") / "deadbeef.json"
        pending.write_text(json.dumps(otlp_payload("qwenpaw", "session-crash", "", "0.2.0", [])), encoding="utf-8")
        third = DeltaExporter(config)
        third.flush(timeout=3)
        third.close()
        self.assertEqual(len(_CaptureHandler.received), 1)

    def test_backoff_starts_after_three_failures(self):
        """AC23: fixed delay for first 2 failures, exponential from the 3rd."""
        exporter = DeltaExporter(self._config(""))
        delays = [exporter.backoff_delay(1.0, 60.0, attempt) for attempt in (1, 2, 3, 4, 5, 20)]
        self.assertEqual(delays[:3], [1.0, 1.0, 2.0])
        self.assertEqual(delays[3], 4.0)
        self.assertEqual(delays[4], 8.0)
        self.assertEqual(delays[5], 60.0)  # capped at retry_max
        exporter.close()


if __name__ == "__main__":
    unittest.main()
