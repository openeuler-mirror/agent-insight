#!/usr/bin/env python3
"""模块里用到的名字必须已导入。

`main.py` 用 `GLOBAL_CONFIG_DIR` 拼 skill 历史目录，但它只从 `constants` 导入了
`ENV_FILE` —— 走到那行就 NameError。这条判据按模块逐个核对：凡是引用了同目录
`constants` 里的公共名字（全大写）的脚本，都必须真的把那个名字导进来。

    python3 skills/skill-optimizer/tests/test_imported_names.py
"""

import ast
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parents[1]   # skills/skill-optimizer
SCRIPTS = HERE / "scripts"
CONSTANTS = SCRIPTS / "constants.py"


def module_level_names(path: pathlib.Path) -> set:
    """模块顶层定义/导入的名字。"""
    out = set()
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out.add(t.id)
        elif isinstance(node, ast.Import):
            out |= {a.asname or a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            out |= {a.asname or a.name for a in node.names}
    return out


def imported_names(path: pathlib.Path) -> set:
    out = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            out |= {a.asname or a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            out |= {a.asname or a.name for a in node.names}
    return out


def main() -> int:
    public = {n for n in module_level_names(CONSTANTS) if n.isupper()}
    fails = []
    for script in sorted(SCRIPTS.glob("*.py")):
        if script.name == "constants.py":
            continue
        text = script.read_text(encoding="utf-8")
        imported = imported_names(script)
        used = {n for n in public if n in text}
        missing = sorted(used - imported)
        if missing:
            fails.append((script.name, missing))
    if fails:
        for name, missing in fails:
            print("FAIL  %s 引用了 constants 里的 %s 但没有导入" % (name, missing), file=sys.stderr)
        return 1
    print("全部通过（引用 constants 公共名字的脚本都已导入它们）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
