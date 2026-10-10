from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> None:
    repo = Path(os.environ["AGENT_INSIGHT_MCTS_REPO_DIR"]).resolve()
    sys.path.insert(0, str(repo))
    from testcases_union.res.task_plugins.zsoft import plugin, bundle, flow, official
    from testcases_union.res.mode import OFFICIALS

    def poc_filename(manifest) -> str:
        return "poc.py"

    def export_selected(node, task, output_root):
        if node.session is None:
            raise RuntimeError("selected MCTS node has no live session")
        result = flow.extract_poc(node.session, task)
        if result is None:
            raise RuntimeError("selected MCTS node has no PoC")
        content, _ = result
        if not isinstance(content, bytes) or not 0 < len(content) <= 1048576:
            raise RuntimeError("selected PoC is empty or exceeds the submission limit")
        metadata = json.loads((task.tasks_dir / task.task_id / "task.json").read_text())
        if len(content) > metadata["max_bytes"]:
            raise RuntimeError("selected PoC exceeds the task submission limit")
        output = Path(output_root)
        output.mkdir(parents=True, exist_ok=True)
        target = output / "poc.py"
        with target.open("xb") as stream:
            stream.write(content)
        (output / "platform-export.json").write_text(json.dumps({"schemaVersion": "mcts-poc-export/v1", "taskId": task.task_id, "evaluation": "deferred"}))
        # The upstream callback expects a boolean. False keeps it from claiming an official pass.
        return False, target

    def prohibit_native_judge(*_args, **_kwargs):
        raise RuntimeError("official judging is owned by Agent Insight")

    bundle.poc_filename_for = poc_filename
    official.evaluate = export_selected
    official._local = prohibit_native_judge
    official._post = prohibit_native_judge
    plugin.evaluate = export_selected
    OFFICIALS["zsoft_official"] = export_selected
    from testcases_union.core.main import main as run_search
    run_search()


if __name__ == "__main__":
    main()
