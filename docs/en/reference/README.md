# Reference documentation

English translations for this category are pending. This page is a navigation and status entry, not a translation of the existing Chinese documents.

- [Chinese documentation](../../zh/reference/navigation.md)
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).

CSV rule-conflict observation state is isolated by `AGENT_FI_RUN_ID` under `skill-rule-conflict-output/runs/<SHA-256 of run ID>/`. Repeated `init` calls within a run preserve counters and completion state. Standalone commands without this variable retain the legacy output directory; assign a distinct ID to each independent experiment. CSV files remain workspace-local, so concurrent experiments must use separate workspaces. See the [Chinese fault catalog](../../zh/reference/reliability/agent-fault-injection/fault-catalog.md).
