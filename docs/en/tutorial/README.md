# Tutorial documentation

English translations for this category are pending. This page is a navigation and status entry, not a translation of the existing Chinese documents.

- [Chinese documentation](../../zh/tutorial/navigation.md)
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).

The SQLite multi-turn walkthrough uses the original experiment wizard: save Case drafts, publish a dataset version, select an OpenCode v2 execution target and Agent version, then select evaluator versions. Inspect per-turn points in the existing trajectory results. See the [Chinese first-experiment tutorial](../../zh/tutorial/evaluation/01-first-experiment.md#继续尝试带版本的多轮评测sqlite). Dedicated Skill generation/A/B and FI generation retain single-turn execution; existing complete Traces can still be evaluated.
