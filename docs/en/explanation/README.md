# Explanation documentation

English translations for this category are pending. This page is a navigation and status entry, not a translation of the existing Chinese documents.

The [Benchmark onboarding Skill](../../../skills/benchmark-onboarding/SKILL.md) guides the host coding Agent and bundles deterministic validation helpers. Its bundled protocol snapshot records stable contracts and provenance; compare it with the authoritative target revision and discover dynamic capabilities separately. Validation progresses from endpoint contracts to real execution/evaluation segments and then a complete end-to-end run, with independent evidence for each layer and bounded waiting/cleanup. It reuses Agent Insight's existing execution and evaluation roles, keeps run records outside the Skill, and resumes only when invoked again. It does not introduce a workflow service or remove a Benchmark's container, sandbox or state requirements. See the [Chinese architecture guide](../../zh/explanation/evaluation/benchmarks/navigation.md).

- [Chinese documentation](../../zh/explanation/navigation.md)
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).
