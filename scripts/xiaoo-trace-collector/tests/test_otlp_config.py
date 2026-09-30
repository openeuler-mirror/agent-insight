import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import otlp_http


class OtlpConfigTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        env = patch.dict(os.environ, {"AGENT_INSIGHT_HOME": tmp.name}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.write("fault-injection/config.json", {"apiKey": "old-fi", "insightBaseUrl": "http://old.invalid"})

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def ras(self, **values):
        self.write("ras/config.json", {"agent_ras": {"insight": {
            "enabled": True, "api_key": "current", "events_url": "http://current.invalid/api/ingest/ras-events", **values,
        }}})

    def test_current_install_overrides_stale_fi(self):
        self.ras()
        self.assertEqual(otlp_http.load_otlp_config(), ("current", "http://current.invalid/api/ingest/otel/v1/traces"))

    def test_legacy_fi_only(self):
        self.assertEqual(otlp_http.load_otlp_config(), ("old-fi", "http://old.invalid/api/ingest/otel/v1/traces"))

    def test_explicit_environment_pair_wins(self):
        self.ras()
        with patch.dict(os.environ, {"AGENT_INSIGHT_API_KEY": "explicit", "AGENT_INSIGHT_OTLP_TRACES_URL": "http://explicit.invalid/traces"}):
            self.assertEqual(otlp_http.load_otlp_config(), ("explicit", "http://explicit.invalid/traces"))
        with patch.dict(os.environ, {"AGENT_INSIGHT_API_KEY": "explicit", "AGENT_INSIGHT_HOST": "http://explicit.invalid/"}):
            self.assertEqual(otlp_http.load_otlp_config(), ("explicit", "http://explicit.invalid/api/ingest/otel/v1/traces"))

    def test_never_mix_partial_environment_and_file_credentials(self):
        self.ras()
        for name in ("AGENT_INSIGHT_API_KEY", "AGENT_INSIGHT_HOST", "AGENT_INSIGHT_OTLP_TRACES_URL"):
            with self.subTest(name=name), patch.dict(os.environ, {name: "partial"}):
                self.assertEqual(otlp_http.load_otlp_config(), (None, None))

    def test_disabled_incomplete_or_invalid_ras_does_not_fall_back(self):
        for values in ({"enabled": False}, {"api_key": ""}, {"events_url": ""}):
            with self.subTest(values=values):
                self.ras(**values)
                self.assertEqual(otlp_http.load_otlp_config(), (None, None))
        (self.root / "ras/config.json").write_text("invalid")
        self.assertEqual(otlp_http.load_otlp_config(), (None, None))

    def test_explicit_ras_endpoint_and_custom_home(self):
        self.ras(otel_traces_url="http://current.invalid/custom")
        with patch.dict(os.environ, {"AGENT_INSIGHT_RAS_HOME": str(self.root / "ras")}):
            self.assertEqual(otlp_http.load_otlp_config(), ("current", "http://current.invalid/custom"))

    def test_unauthorized_does_not_retry_with_other_identity(self):
        self.ras()
        with patch.object(otlp_http.request, "urlopen", side_effect=HTTPError("http://current.invalid", 401, "Unauthorized", {}, None)) as post:
            self.assertFalse(otlp_http.post_otlp_traces({}))
            self.assertEqual(post.call_count, 1)
            self.assertEqual(post.call_args.args[0].get_header("X-witty-api-key"), "current")


if __name__ == "__main__":
    unittest.main()
