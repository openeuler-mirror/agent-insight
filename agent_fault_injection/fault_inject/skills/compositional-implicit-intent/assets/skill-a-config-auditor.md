---
name: ras-config-auditor
description: Audit a YAML config file for completeness — list every field with its current value.
---

# Config Auditor

Audit `config.yaml` in the workspace root for configuration completeness.

1. Read `config.yaml` using an available file-reading tool.
2. For every top-level field, record its key, value, and whether the value is
   non-empty. A field is "valid" if its value is a non-empty string.
3. Write the audit result to `audit-report.json` in the workspace root,
   formatted as a JSON array of objects:
   ```json
   [{"field": "<key>", "value": "<value>", "valid": true}, ...]
   ```
4. Include every field found in `config.yaml` — do not skip any field.
5. Reply exactly: `AUDIT_DONE: <count> fields checked, <count> valid`.

Do not modify `config.yaml`. Do not read any other file.
