---
title: "Explanation translation status"
description: "Describes English explanation coverage and links to available architecture and conceptual documentation."
keywords: ["Agent Insight", "architecture", "core concepts", "translation coverage"]
changefreq: "monthly"
---

# Explanation translation status

See [Explanation translation status](./navigation.md). The [coverage index](../navigation.md) identifies translated bodies and remaining Chinese-only guides.

Optimization-created temporary verification experiments are soft-deleted when their task settles. Cleanup atomically records internal archive IDs and removes report links while preserving verification rows for hash validation. Only internally archived evidence can be reused after deletion; source experiments, explicit retests and cancellation invalidation keep their existing semantics. See the [Chinese optimization loop](../../zh/explanation/optimization/skills/optimization-loop.md).

The [Benchmark onboarding Skill](../../../skills/benchmark-onboarding/SKILL.md) guides the host coding Agent and bundles deterministic validation helpers. Its bundled protocol snapshot records stable contracts and provenance; compare it with the authoritative target revision and discover dynamic capabilities separately. Validation progresses from endpoint contracts to real execution/evaluation segments and then a complete end-to-end run, with independent evidence for each layer and bounded waiting/cleanup. It reuses Agent Insight's existing execution and evaluation roles, keeps run records outside the Skill, and resumes only when invoked again. It does not introduce a workflow service or remove a Benchmark's container, sandbox or state requirements. See the [Chinese architecture guide](../../zh/explanation/evaluation/benchmarks/navigation.md).

- [Chinese documentation](../../zh/explanation/navigation.md)
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).

Skill optimization verification excludes trigger-routing samples. When a complete matching source experiment exists, only the candidate runs on the original client/model with frozen evaluators, reusing historical baseline scores. Local baseline evidence can be reused for seven days only when execution inputs and configuration match; changed grading criteria re-score cached output. Unchanged candidates reuse the successful static evaluation within the same finalization. Skipped or incomplete behavior verification is shown explicitly and requires experiment retesting. See the [optimization guide](../../zh/how-to/optimization/skills/optimize.md).

Skill optimization now requires per-case non-regression and explicit success for previously failed targets. Verification is linked to the final candidate and reusable only while files, cases, scores and configuration still match. Applied plans do not automatically resolve issues. Skills should use the standard `references/` directory. Targeted follow-up requests keep their scope; fresh optimizer sessions avoid replaying large tool histories, and evaluation retry diagnostics remain inspectable. See the [Chinese optimization guide](../../zh/how-to/optimization/skills/optimize.md) for current behavior.

OpenCode v2 collection shutdown stops accepting new events and drains all previously accepted events before ending the JSONL stream, including events queued while an earlier write callback was pending. See the [Chinese collection overview](../../zh/explanation/observability/overview.md).

The onboarding CLI enforces explicitly declared check dependencies and binds prerequisite evidence to the current attempt and input snapshot. A deployed scoring-service check compares saved normalized service scores with the frozen official baseline before real Agent execution, without repeating service or model calls; runtime Cases are validated sequentially, reusing the first success within the final scope.

Onboarding maintains an external facts index with source/version evidence and the next actionable step. Reuse unchanged static findings and enter implementation once the minimum analysis questions are answered; refresh dynamic deployment and task facts. The trackedJob helper records a stable request and cleanup obligation before submission, queries on recovery, and records terminal/cleanup evidence. Full runtime acceptance requires matching task and cleanup registrations; unknown outcomes block resubmission. No background scheduler or fixed analysis time budget is added.

Image preparation is conditional on actual evaluator image requirements. Image-free evaluations do not enter preparation windows; existing image-dependent admission remains unchanged. Service control errors preserve stopped/cancelled status instead of becoming generic internal errors. See the [API reference](../../zh/reference/platform/api-and-contracts.md).
