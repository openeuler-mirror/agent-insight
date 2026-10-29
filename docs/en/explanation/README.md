# Explanation documentation

English translations for this category are pending. This page is a navigation and status entry, not a translation of the existing Chinese documents.

- [Chinese documentation](../../zh/explanation/navigation.md)
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).

SQLite asset versions use immutable version records and separate dataset drafts with revision checks. Experiments resolve version references on the server and preserve frozen Cases and evaluator Skill snapshots. Agent versions are user declarations rather than verified external code revisions. The per-turn rules evaluator replays original Trace evidence; missing evidence remains unscored. The original Trace-tag analysis is retained alongside experiment asset trends grouped by recorded fixed execution conditions. See the [Chinese evaluation architecture](../../zh/explanation/evaluation/overview.md#资产版本实验冻结与多轮执行).
