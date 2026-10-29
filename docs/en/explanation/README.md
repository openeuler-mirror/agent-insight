# Explanation documentation

Optimization-created temporary verification experiments are soft-deleted when their task settles. Cleanup atomically records internal archive IDs and removes report links while preserving verification rows for hash validation. Only internally archived evidence can be reused after deletion; source experiments, explicit retests and cancellation invalidation keep their existing semantics. See the [Chinese optimization loop](../../zh/explanation/optimization/skills/optimization-loop.md).

English translations for this category are pending. This page is a navigation and status entry, not a translation of the existing Chinese documents.

- [Chinese documentation](../../zh/explanation/navigation.md)
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).

Skill optimization verification excludes trigger-routing samples. When a complete matching source experiment exists, only the candidate runs on the original client/model with frozen evaluators, reusing historical baseline scores. Local baseline evidence can be reused for seven days only when execution inputs and configuration match; changed grading criteria re-score cached output. Unchanged candidates reuse the successful static evaluation within the same finalization. Skipped or incomplete behavior verification is shown explicitly and requires experiment retesting. See the [optimization guide](../../zh/how-to/optimization/skills/optimize.md).

Skill optimization now requires per-case non-regression and explicit success for previously failed targets. Verification is linked to the final candidate and reusable only while files, cases, scores and configuration still match. Applied plans do not automatically resolve issues. Skills should use the standard `references/` directory. Targeted follow-up requests keep their scope; fresh optimizer sessions avoid replaying large tool histories, and evaluation retry diagnostics remain inspectable. See the [Chinese optimization guide](../../zh/how-to/optimization/skills/optimize.md) for current behavior.
