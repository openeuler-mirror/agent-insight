# coding: utf-8
"""FI interactions artifact: markers + taskId only (no conversation tree)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent_fault_injection.pipeline.interactions_mapper import (
    InsightInteractionsMapper,
    write_interactions_artifact,
)
from agent_fault_injection.pipeline.models import RunArtifacts


def _artifacts(root: Path) -> RunArtifacts:
    raw = root / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    return RunArtifacts(
        run_id="ras-test",
        root=root,
        raw_dir=raw,
        resolved_fault_dir=root / "resolved_fault",
        events_file=raw / "events.jsonl",
        stdout_file=raw / "stdout.log",
        stderr_file=raw / "stderr.log",
        trajectory_file=root / "trajectory.jsonl",
        interactions_file=root / "interactions.json",
        execution_file=root / "execution.jsonl",
        manifest_file=root / "manifest.json",
        request_file=root / "request.json",
        plugin_ready_file=raw / "plugin-ready.json",
    )


class InteractionsMapperMarkersOnlyTests(unittest.TestCase):
    def test_map_emits_markers_and_empty_interactions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifacts = _artifacts(root)
            events = [
                {
                    "kind": "opencode.event",
                    "sequence": 1,
                    "payload": {
                        "type": "message.updated",
                        "properties": {
                            "info": {
                                "id": "msg_1",
                                "role": "user",
                                "sessionID": "ses_abc",
                            }
                        },
                    },
                },
                {
                    "kind": "fault.activation.requested",
                    "sequence": 2,
                    "recorded_at": 1_700_000_000_000,
                    "run_id": "ras-test",
                    "payload": {"faultSkill": "thinking-dead-loop"},
                },
                {
                    "kind": "fault.activation.completed",
                    "sequence": 3,
                    "recorded_at": 1_700_000_000_100,
                    "payload": {
                        "faultSkill": "thinking-dead-loop",
                        "sessionID": "ses_abc",
                    },
                },
            ]
            with artifacts.events_file.open("w", encoding="utf-8") as stream:
                for row in events:
                    stream.write(json.dumps(row) + "\n")

            doc = InsightInteractionsMapper().map(
                artifacts,
                framework="opencode",
                session_id="ses_abc",
            )
            self.assertEqual(doc.interactions, [])
            self.assertEqual(doc.task_id, "ses_abc")
            labels = [m["label"] for m in doc.markers]
            self.assertIn("Fault activation requested", labels)
            self.assertIn("Fault activation completed", labels)
            # Non-FI noise kind must not become a marker.
            self.assertEqual(len(doc.markers), 2)

            write_interactions_artifact(artifacts, doc)
            saved = json.loads(artifacts.interactions_file.read_text(encoding="utf-8"))
            self.assertEqual(saved["interactions"], [])
            self.assertEqual(saved["taskId"], "ses_abc")


if __name__ == "__main__":
    unittest.main()
