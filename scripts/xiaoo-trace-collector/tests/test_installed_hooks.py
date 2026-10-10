import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class InstalledHooksTests(unittest.TestCase):
    def test_installed_subprocess_hooks_keep_interleaved_sessions_separate(self):
        with tempfile.TemporaryDirectory(prefix="xiaoo-'hooks-") as tmp:
            root = Path(tmp)
            data = root / "data"
            env = {**os.environ, "HOME": tmp, "XDG_CONFIG_HOME": str(root / "config"),
                   "AGENT_INSIGHT_HOME": str(data), "AGENT_INSIGHT_XIAOO_OTEL_BUF": str(root / "buf")}
            for key in ("AGENT_INSIGHT_API_KEY", "AGENT_INSIGHT_HOST", "AGENT_INSIGHT_OTLP_TRACES_URL", "AGENT_INSIGHT_RAS_HOME"):
                env.pop(key, None)
            config = root / "config/xiaoo/config.toml"
            config.parent.mkdir(parents=True)
            config.write_text('[llm]\nmodel = "keep-existing-model"\n')
            for _ in range(2):
                subprocess.run([shutil.which("node"), str(ROOT / "install.js")], env=env, check=True, capture_output=True)
            plugins = json.loads((data / "xiaoo-trace-collector/plugin.json").read_text())
            self.assertEqual(config.read_text().count("plugin.json"), 1)
            self.assertIn('model = "keep-existing-model"', config.read_text())
            commands = {entry["id"].removeprefix("insight_xiaoo_"): entry["command"] for entry in plugins}
            self.assertTrue(all(command.startswith("exec python3 ") for command in commands.values()))

            # Supply deterministic process metadata; all other hook code runs as installed.
            bin_dir = root / "bin"
            bin_dir.mkdir()
            ps = bin_dir / "ps"
            ps.write_text('#!/bin/sh\nprintf "Wed Sep 16 16:00:00 2026 /bin/xiaoo-%s\\n" "$XIAOO_TEST_PROCESS"\n')
            ps.chmod(0o755)
            env["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]

            def hook(process, op, payload):
                result = subprocess.run(["sh", "-c", commands[op]], input=json.dumps(payload),
                                        text=True, capture_output=True, check=True,
                                        env={**env, "XIAOO_TEST_PROCESS": process})
                self.assertEqual(json.loads(result.stdout)["result"], "accept")

            hook("cli", "chat_received", {"session_id": "experiment", "message": {"text": "fix Flask"}})
            hook("tui", "chat_received", {"session_id": "tui", "message": {"text": "hello xiaoo"}})
            hook("cli", "tool_post", {"call": {"tool_name": "file_edit", "input": {"file": "flask.py"}}, "outcome": {"output": "fixed"}})
            hook("tui", "llm_complete_post", {"response": {"message": {"text": "hello user"}}})
            hook("cli", "llm_complete_post", {"response": {"message": {"text": "patch done"}}})
            experiment = json.loads((root / "buf/experiment.json").read_text())
            tui = json.loads((root / "buf/tui.json").read_text())
            self.assertIn("patch done", json.dumps(experiment))
            self.assertNotIn("hello user", json.dumps(experiment))
            self.assertIn("hello user", json.dumps(tui))
            self.assertNotIn("flask.py", json.dumps(tui))
            self.assertFalse((root / "buf/_active_session.json").exists())


if __name__ == "__main__":
    unittest.main()
