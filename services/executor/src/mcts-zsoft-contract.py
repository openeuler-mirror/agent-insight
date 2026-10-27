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

import argparse
import ast
import hashlib
import inspect
import json
import sys
from pathlib import Path


def check_interface(repo: Path) -> dict:
    digest = hashlib.sha256()
    trees = {}
    files = {
        "main": "core/main.py",
        "mode": "res/mode.py",
        **{name: f"res/task_plugins/zsoft/{name}.py" for name in
           ("plugin", "bundle", "flow", "official", "task", "artifact", "materializer")},
    }
    for name, relative in files.items():
        data = (repo / "testcases_union" / relative).read_bytes()
        digest.update(relative.encode() + b"\0" + data + b"\0")
        trees[name] = ast.parse(data, filename=relative)

    def function(tree, name, positional, keywords=()):
        fn = next((item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == name), None)
        if fn is None:
            raise ValueError(f"missing function: {name}")
        args = fn.args
        parameters = []
        pos = args.posonlyargs + args.args
        required = len(pos) - len(args.defaults)
        for index, arg in enumerate(pos):
            kind = inspect.Parameter.POSITIONAL_ONLY if index < len(args.posonlyargs) else inspect.Parameter.POSITIONAL_OR_KEYWORD
            parameters.append(inspect.Parameter(arg.arg, kind, default=inspect.Parameter.empty if index < required else None))
        if args.vararg:
            parameters.append(inspect.Parameter(args.vararg.arg, inspect.Parameter.VAR_POSITIONAL))
        for arg, default in zip(args.kwonlyargs, args.kw_defaults):
            parameters.append(inspect.Parameter(arg.arg, inspect.Parameter.KEYWORD_ONLY,
                                                default=inspect.Parameter.empty if default is None else None))
        if args.kwarg:
            parameters.append(inspect.Parameter(args.kwarg.arg, inspect.Parameter.VAR_KEYWORD))
        inspect.Signature(parameters).bind(*([None] * positional), **dict.fromkeys(keywords))
        return fn

    function(trees["bundle"], "poc_filename_for", 1)
    function(trees["flow"], "extract_poc", 2)
    function(trees["official"], "evaluate", 3)
    function(trees["official"], "_local", 2)
    function(trees["official"], "_post", 4)
    function(trees["artifact"], "poc_file", 2, ("session",))
    function(trees["main"], "main", 0)
    function(trees["main"], "_setup_task", 2)
    task = next((item for item in trees["task"].body if isinstance(item, ast.ClassDef) and item.name == "ZSoftTask"), None)
    if task is None:
        raise ValueError("missing ZSoftTask")
    for name, count, keys in (("init_solver", 1, ()), ("step_solver", 2, ()),
                              ("init_author", 1, ("reference_example_paths",)),
                              ("step_author", 2, ("node_id",))):
        function(task, name, count, keys)
    for name in ("poc_filename", "poc_sandbox_path"):
        getter = function(task, name, 1)
        if not any(isinstance(item, ast.Name) and item.id == "property" for item in getter.decorator_list):
            raise ValueError(f"missing property: {name}")
    function(task, "issue_text", 1)
    function(task, "bundle_bytes", 1)
    function(trees["materializer"], "_download_script", 1)

    plugin = trees["plugin"]
    if not any(isinstance(item, ast.ImportFrom) and item.module == "official"
               and any(alias.name == "evaluate" and alias.asname in (None, "evaluate") for alias in item.names)
               for item in plugin.body):
        raise ValueError("plugin must import official.evaluate")
    submit = function(plugin, "submit", 3)
    returned = next((item.value for item in submit.body if isinstance(item, ast.Return)), None)
    if not (isinstance(returned, ast.Call) and isinstance(returned.func, ast.Name)
            and returned.func.id == "evaluate" and len(returned.args) == 3):
        raise ValueError("submit must delegate to evaluate")
    if not any(isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Name)
               and decorator.func.id == "register" and len(decorator.args) == 2
               and isinstance(decorator.args[0], ast.Name) and decorator.args[0].id == "OFFICIALS"
               and ast.literal_eval(decorator.args[1]) == "zsoft_official" for decorator in submit.decorator_list):
        raise ValueError("missing official registry hook")
    specs = [item for item in ast.walk(plugin) if isinstance(item, ast.Call)
             and isinstance(item.func, ast.Name) and item.func.id == "ModeSpec"]
    if len(specs) != 1:
        raise ValueError("expected one ZSoft mode specification")
    if not any(isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute)
               and isinstance(item.func.value, ast.Name) and item.func.value.id == "MODES"
               and item.func.attr == "register" and item.args == [specs[0]] for item in ast.walk(plugin)):
        raise ValueError("missing ZSoft mode registration")
    fields = {item.arg: item.value for item in specs[0].keywords}
    for name, value in {"id": "zsoft", "official_eval": "zsoft_official", "artifact_reader": "poc_file"}.items():
        if ast.literal_eval(fields[name]) != value:
            raise ValueError(f"incompatible mode field: {name}")
    if not isinstance(fields.get("configure_cli"), ast.Name) or fields["configure_cli"].id != "configure_cli":
        raise ValueError("missing CLI registration")
    mode_spec = next((item for item in trees["mode"].body if isinstance(item, ast.ClassDef) and item.name == "ModeSpec"), None)
    if mode_spec is None:
        raise ValueError("missing ModeSpec")
    function(mode_spec, "prompts", 1)
    function(mode_spec, "official_fn", 1)

    # Reconstruct argument declarations only; never import or execute upstream code.
    parser = argparse.ArgumentParser(exit_on_error=False)
    cli = function(plugin, "configure_cli", 1)
    main = function(trees["main"], "main", 0)
    for fn, receiver in ((cli, cli.args.args[0].arg), (main, "p")):
        for call in ast.walk(fn):
            if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                    and call.func.attr == "add_argument" and isinstance(call.func.value, ast.Name)
                    and call.func.value.id == receiver):
                continue
            flags = [ast.literal_eval(arg) for arg in call.args]
            options = {}
            for keyword in call.keywords:
                if keyword.arg in ("action", "nargs", "required"):
                    options[keyword.arg] = ast.literal_eval(keyword.value)
                elif keyword.arg == "choices" and isinstance(keyword.value, (ast.Tuple, ast.List)):
                    options["choices"] = ast.literal_eval(keyword.value)
                elif keyword.arg == "type":
                    if not isinstance(keyword.value, ast.Name) or keyword.value.id not in ("str", "int", "float"):
                        raise ValueError("unsupported CLI type")
                    options["type"] = {"str": str, "int": int, "float": float}[keyword.value.id]
            parser.add_argument(*flags, **options)
    argv = ["--mode", "zsoft", "--runtime", "pi", "--task-id", "synthetic", "--output-dir", "synthetic"]
    for flag in ("--max-iters", "--branching", "--max-turns-init", "--max-turns-step",
                 "--max-turns-author", "--max-turns-author-step", "--token-fuse-limit"):
        argv += [flag, "1"]
    parsed = parser.parse_args(argv)
    if parsed.task_id != "synthetic" or parsed.output_dir != "synthetic":
        raise ValueError("CLI destination mismatch")
    for role in ("solver_init", "solver_step", "author_init", "author_step", "submission_selector"):
        relative = f"res/task_plugins/zsoft/prompts/prompt_{role}.txt"
        data = (repo / "testcases_union" / relative).read_bytes()
        if not data.strip():
            raise ValueError("empty role prompt")
        digest.update(relative.encode() + b"\0" + data + b"\0")
    return {"schemaVersion": "mcts-zsoft-contract/v1", "sourceDigest": "sha256:" + digest.hexdigest(),
            "submissionKinds": ["python", "c", "binary"]}


if __name__ == "__main__":
    try:
        print(json.dumps(check_interface(Path(sys.argv[1]))))
    except (Exception, SystemExit):
        print(json.dumps({"schemaVersion": "mcts-zsoft-contract/v1", "compatible": False}))
        sys.exit(1)
