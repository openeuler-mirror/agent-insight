from __future__ import annotations

import json
import sys
from pathlib import Path

from zsoft_poc.runner import EvaluationRunner

config = json.loads(Path(sys.argv[1]).read_text())
runner = EvaluationRunner(Path(config["tasksDir"]), Path(config["runsDir"]), Path(config["stateDir"]))
record = runner.evaluate_file(config["taskId"], Path(config["submissionPath"]), phase="final", submission_kind="final")
Path(config["recordPath"]).write_text(record.model_dump_json())
