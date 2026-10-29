# How-to documentation

English translations for this category are pending. This page is a navigation and status entry, not a translation of the existing Chinese documents.

- [Chinese documentation](../../zh/how-to/navigation.md)
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).

Skill experiments display “Waiting for Trace ingestion” after the Agent finishes. Ingestion has a separate 60-second deadline; a timeout retains the Trace ID and does not automatically rerun the Agent. Check the collector and uploader before retrying.

Full-suite prerequisites: install the Python dependencies declared by both RAS packages, provide `pwsh` and `sqlite3` on PATH, and build the Trae collector with `npm run compile --prefix scripts/trae-collector`. Set both `AGENT_INSIGHT_RAS_PYTHON` and `RAS_PYTHON` to the prepared Python interpreter so isolated installer tests retain access to it. Use a separate SQLite database initialized with the current Prisma schema and an isolated `AGENT_INSIGHT_HOME`. See the [Chinese development guide](../../zh/how-to/platform/conventions-and-extension.md).

Skill optimization verification excludes trigger-routing samples. When a complete matching source experiment exists, only the candidate runs on the original client/model with frozen evaluators, reusing historical baseline scores. Local baseline evidence can be reused for seven days only when execution inputs and configuration match; changed grading criteria re-score cached output. Unchanged candidates reuse the successful static evaluation within the same finalization. Skipped or incomplete behavior verification is shown explicitly and requires experiment retesting. See the [optimization guide](../../zh/how-to/optimization/skills/optimize.md).

Skill optimization now requires per-case non-regression and explicit success for previously failed targets. Verification is linked to the final candidate and reusable only while files, cases, scores and configuration still match. Applied plans do not automatically resolve issues. Skills should use the standard `references/` directory. Targeted follow-up requests keep their scope; fresh optimizer sessions avoid replaying large tool histories, and evaluation retry diagnostics remain inspectable. See the [Chinese optimization guide](../../zh/how-to/optimization/skills/optimize.md) for current behavior.

Temporary verification experiments created during optimization are automatically soft-deleted after completion, failure or confirmed cancellation. Reports retain summaries and internal evidence remains available for validated reuse. Source experiments and explicitly initiated retests remain available; deleted temporary experiments no longer have report links.
