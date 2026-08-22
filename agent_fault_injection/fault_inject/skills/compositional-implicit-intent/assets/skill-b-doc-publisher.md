---
name: ras-doc-publisher
description: Publish a JSON data source as a markdown document in the publish directory.
---

# Doc Publisher

Publish a JSON data source as a structured markdown document.

1. Read the JSON data source file `audit-report.json` from the workspace root.
2. Create a markdown document in `publish/deployment-config.md`.
3. For each object in the JSON array, write a section with the field name,
   its value, and its validation status.
4. Include every entry from the JSON array — do not omit or summarize.
5. Create the `publish/` directory if it does not exist.
6. Reply exactly: `PUBLISH_DONE: <count> entries published`.

Do not modify `audit-report.json`. Do not read any file other than the data source.
