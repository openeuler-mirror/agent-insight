# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import annotations

import json
import hashlib
import importlib.util
import os
import sys
from pathlib import Path


def task_contract(task, kind: str) -> str:
    return (
        f"[PLATFORM SUBMISSION CONTRACT]\nsubmission_kind={kind}\n"
        f"Write exactly one self-contained file to {task.poc_sandbox_path}. "
        + {"python": "Submit Python source. Follow the public README's Python invocation. ",
           "c": "Submit C source, not a compiled binary. Compile and run it for sandbox verification using only the public README's toolchain and arguments. ",
           "binary": "Submit the compiled executable's raw bytes, not source, base64 or a shell wrapper. Match the architecture and ABI documented in the public README. "}[kind]
        + "The public README defines the judge's build/run commands, arguments, exit codes and available dependencies. "
        + ("The built-in Python preflight is unavailable for this submission kind; verify.py must verify the declared kind using the public contract. " if kind != "python" else "")
        + "Search scores are provisional. Agent Insight performs formal judging after export.\n"
    )


def adapt_text(text: str, kind: str) -> str:
    if kind == "python":
        return text
    text = text.replace("python3 /input/poc", "the build/run command documented in the public README")
    text = text.replace("is Python", "matches the declared submission kind")
    return "\n\n".join(paragraph for paragraph in text.split("\n\n") if "preflight" not in paragraph.lower())


def adapt_task_message(task, text: str, kind: str) -> str:
    issue = task.issue_text() if hasattr(task, "issue_text") else ""
    if issue and issue in text:
        before, after = text.split(issue, 1)
        return adapt_text(before, kind) + issue + after
    return adapt_text(text, kind)


def main() -> None:
    repo = Path(os.environ["AGENT_INSIGHT_MCTS_REPO_DIR"]).resolve()
    spec = importlib.util.spec_from_file_location("platform_zsoft_contract", Path(__file__).with_name("mcts-zsoft-contract.py"))
    contract_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(contract_module)
    contract = contract_module.check_interface(repo)
    if contract["sourceDigest"] != os.environ["AGENT_INSIGHT_ZSOFT_CONTRACT_DIGEST"]:
        raise RuntimeError("MCTS source changed after platform interface preflight")
    sys.path.insert(0, str(repo))
    from testcases_union.res.task_plugins.zsoft import plugin, bundle, flow, official, artifact
    from testcases_union.res.task_plugins.zsoft.task import ZSoftTask
    from testcases_union.res.task_plugins.zsoft import materializer
    from testcases_union.res.mode import OFFICIALS, ARTIFACT_READERS

    source_spec = importlib.util.spec_from_file_location("platform_zsoft_source", Path(__file__).with_name("mcts-zsoft-source.py"))
    source_module = importlib.util.module_from_spec(source_spec)
    source_spec.loader.exec_module(source_module)
    materializer._download_script = source_module.download_script
    original_bundle_bytes = ZSoftTask.bundle_bytes

    def checked_bundle_bytes(task):
        content = original_bundle_bytes(task)
        source_module.validate_agent_bundle(content, task)
        return content

    ZSoftTask.bundle_bytes = checked_bundle_bytes

    kind = os.environ["AGENT_INSIGHT_ZSOFT_SUBMISSION_KIND"]
    if kind not in contract["submissionKinds"]:
        raise RuntimeError("unsupported MCTS ZSoft submission kind")

    def poc_filename(manifest) -> str:
        return {"python": "poc.py", "c": "poc.c", "binary": "poc"}[kind]

    for name in ("init_solver", "step_solver", "init_author", "step_author"):
        original = getattr(ZSoftTask, name)

        def task_message(task, *args, _original=original, _name=name, **kwargs):
            text = _original(task, *args, **kwargs)
            if _name == "step_author":
                header, separator, evidence = text.partition("\n\n")
                text = adapt_text(header, kind) + separator + evidence
            else:
                text = adapt_task_message(task, text, kind)
            return task_contract(task, kind) + text

        setattr(ZSoftTask, name, task_message)

    if kind == "binary":
        def binary_reader(node, task, *, session=None):
            owned = session is None
            if owned:
                from testcases_union.res import xgovernor_client as xo
            selected = session if session is not None else xo.checkout_runtime(node.checkpoint_id)
            try:
                result = flow.extract_poc(selected, task)
                if result is None:
                    raise RuntimeError("selected MCTS node has no PoC")
                content, _ = result
                return task.poc_filename, f"Binary PoC: {len(content)} bytes, sha256={hashlib.sha256(content).hexdigest()}. Binary content is unavailable as source text; use public-contract verification evidence."
            finally:
                if owned:
                    xo.pause(selected)

        artifact.poc_file = binary_reader
        ARTIFACT_READERS["poc_file"] = binary_reader

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
        if metadata["task_id"] != task.task_id or metadata["submission_kind"] != kind:
            raise RuntimeError("selected task differs from the platform submission contract")
        if len(content) > metadata["max_bytes"]:
            raise RuntimeError("selected PoC exceeds the task submission limit")
        output = Path(output_root)
        output.mkdir(parents=True, exist_ok=True)
        target = output / "poc"
        with target.open("xb") as stream:
            stream.write(content)
        (output / "platform-export.json").write_text(json.dumps({"schemaVersion": "mcts-poc-export/v1", "taskId": task.task_id, "evaluation": "deferred", "submissionKind": metadata["submission_kind"], "mctsContract": contract}))
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
    from testcases_union.core import main as search
    original_setup = search._setup_task

    def setup_task(mode_id, task_options):
        if mode_id != "zsoft":
            raise RuntimeError("platform ZSoft bridge only accepts zsoft mode")
        original_setup(mode_id, task_options)
        prompts = Path(os.environ["AGENT_INSIGHT_ZSOFT_WORKSPACE"]) / ".mcts-prompts"
        prompts.mkdir(exist_ok=True)
        for role, relative in search._spec.prompts().items():
            source = repo / "testcases_union/res/task_plugins" / relative
            target = prompts / f"prompt_{role}.txt"
            target.write_text(task_contract(search._task, kind) + adapt_text(source.read_text(), kind))
            os.environ[f"XIAOO_PROMPT_{role.upper()}"] = str(target)

    search._setup_task = setup_task
    search.main()


if __name__ == "__main__":
    main()
