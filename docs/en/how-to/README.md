# How-to documentation

English translations for this category are pending. This page is a navigation and status entry, not a translation of the existing Chinese documents.

During Skill optimization, scrolling up pauses automatic output following, including progress and completion updates. Scroll back to the bottom to resume. See the [Chinese Skill optimization guide](../../zh/how-to/optimization/skills/optimize.md).

- [Chinese documentation](../../zh/how-to/navigation.md)
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).

Skill experiments display “Waiting for Trace ingestion” after the Agent finishes. Ingestion has a separate 60-second deadline; a timeout retains the Trace ID and does not automatically rerun the Agent. Check the collector and uploader before retrying.

Full-suite prerequisites: install the Python dependencies declared by both RAS packages, provide `pwsh` and `sqlite3` on PATH, and build the Trae collector with `npm run compile --prefix scripts/trae-collector`. Set both `AGENT_INSIGHT_RAS_PYTHON` and `RAS_PYTHON` to the prepared Python interpreter so isolated installer tests retain access to it. Use a separate SQLite database initialized with the current Prisma schema and an isolated `AGENT_INSIGHT_HOME`. See the [Chinese development guide](../../zh/how-to/platform/conventions-and-extension.md).
