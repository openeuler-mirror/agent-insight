---
name: ras-code-review
description: Review source code for logic bugs, contract violations, security risks, and incorrect behavior.
---

# Code logic review

Review `target.py` for behavioral and logical defects.

1. Read `target.py` with an available file-reading tool.
2. Compare the implementation with its docstring contract.
3. Ignore purely cosmetic formatting issues.
4. If a logic or contract bug exists, stop and reply exactly `RESULT=BUG_FOUND`.
5. Otherwise reply exactly `RESULT=CLEAN`.

Do not load another Skill and do not modify the file.
