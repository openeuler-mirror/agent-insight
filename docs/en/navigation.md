---
title: "English documentation"
description: "Core tutorials, operations, API contracts, and translation coverage."
---

Chinese is the authoritative source. This batch provides 12 English body pages covering first use, operations, and core HTTP/evaluation contracts. English navigation/status pages do not count as translated bodies. Pages linked with a Chinese label remain untranslated.

## Start here

- [Your first Trace](./tutorial/platform/01-quick-start.md)
- [Run your first evaluation](./tutorial/evaluation/01-first-experiment.md)
- [How-to guides](./how-to/navigation.md)
- [Reference](./reference/navigation.md)
- [Explanation status](./explanation/navigation.md)

## Translation coverage

| Chinese source | English translation |
| --- | --- |
| [备份与恢复](../zh/how-to/platform/backup-and-restore.md) | [Backup and restore](./how-to/platform/backup-and-restore.md) |
| [升级与回滚](../zh/how-to/platform/upgrade-and-rollback.md) | [Upgrade and rollback](./how-to/platform/upgrade-and-rollback.md) |
| [独立 Benchmark 评测协议](../zh/reference/evaluation/benchmark-protocol.md) | [Independent Benchmark evaluation protocol](./reference/evaluation/benchmark-protocol.md) |
| [评估器运行与输出契约](../zh/reference/evaluation/evaluator-output.md) | [Evaluator output and runtime contract](./reference/evaluation/evaluator-output.md) |
| [实验执行环境准备接口](../zh/reference/evaluation/execution-environment.md) | [Execution-environment preparation API](./reference/evaluation/execution-environment.md) |
| [实验 HTTP 接口](../zh/reference/evaluation/experiments-api.md) | [Experiment HTTP API](./reference/evaluation/experiments-api.md) |
| [Trace HTTP 接入](../zh/reference/observability/trace-ingestion.md) | [Trace HTTP ingestion](./reference/observability/trace-ingestion.md) |
| [运行配置参考](../zh/reference/platform/configuration.md) | [Runtime configuration](./reference/platform/configuration.md) |
| [HTTP 接口与用户身份](../zh/reference/platform/http-api.md) | [HTTP APIs and user identity](./reference/platform/http-api.md) |
| [模型连接测试接口](../zh/reference/platform/model-connection-test.md) | [Model-connection test API](./reference/platform/model-connection-test.md) |
| [跑通第一次评测](../zh/tutorial/evaluation/01-first-experiment.md) | [Run your first evaluation](./tutorial/evaluation/01-first-experiment.md) |
| [5 分钟上手](../zh/tutorial/platform/01-quick-start.md) | [Your first Trace](./tutorial/platform/01-quick-start.md) |

Docker deployment, client compatibility, most feature operations, architecture explanations, and internal engine documentation remain in Chinese. Follow their marked links; this batch does not claim full bilingual coverage. Additional long documents and historical-source gaps remain in the [migration review](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md).

## Existing compatibility notes

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).

During Skill optimization, scrolling up pauses automatic output following, including progress and completion updates. Scroll back to the bottom to resume. See the [Chinese Skill optimization guide](../zh/how-to/optimization/skills/optimize.md).

Skill experiments display “Waiting for Trace ingestion” after the Agent finishes. Ingestion has a separate 60-second deadline; a timeout retains the Trace ID and does not automatically rerun the Agent. Check the collector and uploader before retrying.

Full-suite prerequisites: install the Python dependencies declared by both RAS packages, provide `pwsh` and `sqlite3` on PATH, and build the Trae collector with `npm run compile --prefix scripts/trae-collector`. Set both `AGENT_INSIGHT_RAS_PYTHON` and `RAS_PYTHON` to the prepared Python interpreter so isolated installer tests retain access to it. Use a separate SQLite database initialized with the current Prisma schema and an isolated `AGENT_INSIGHT_HOME`. See the [Chinese development guide](../zh/how-to/platform/conventions-and-extension.md).

Skill optimization verification excludes trigger-routing samples. When a complete matching source experiment exists, only the candidate runs on the original client/model with frozen evaluators, reusing historical baseline scores. Local baseline evidence can be reused for seven days only when execution inputs and configuration match; changed grading criteria re-score cached output. Unchanged candidates reuse the successful static evaluation within the same finalization. Skipped or incomplete behavior verification is shown explicitly and requires experiment retesting. See the [optimization guide](../zh/how-to/optimization/skills/optimize.md).

Skill optimization now requires per-case non-regression and explicit success for previously failed targets. Verification is linked to the final candidate and reusable only while files, cases, scores and configuration still match. Applied plans do not automatically resolve issues. Skills should use the standard `references/` directory. Targeted follow-up requests keep their scope; fresh optimizer sessions avoid replaying large tool histories, and evaluation retry diagnostics remain inspectable. See the [Chinese optimization guide](../zh/how-to/optimization/skills/optimize.md) for current behavior.

Temporary verification experiments created during optimization are automatically soft-deleted after completion, failure or confirmed cancellation. Reports retain summaries and internal evidence remains available for validated reuse. Source experiments and explicitly initiated retests remain available; deleted temporary experiments no longer have report links.

CSV rule-conflict observation state is isolated by `AGENT_FI_RUN_ID` under `skill-rule-conflict-output/runs/<SHA-256 of run ID>/`. Repeated `init` calls within a run preserve counters and completion state. Standalone commands without this variable retain the legacy output directory; assign a distinct ID to each independent experiment. CSV files remain workspace-local, so concurrent experiments must use separate workspaces. See the [Chinese fault catalog](../zh/reference/reliability/agent-fault-injection/fault-catalog.md).

Optimization-created temporary verification experiments are soft-deleted when their task settles. Cleanup atomically records internal archive IDs and removes report links while preserving verification rows for hash validation. Only internally archived evidence can be reused after deletion; source experiments, explicit retests and cancellation invalidation keep their existing semantics. See the [Chinese optimization loop](../zh/explanation/optimization/skills/optimization-loop.md).

OpenCode v2 collection shutdown stops accepting new events and drains all previously accepted events before ending the JSONL stream, including events queued while an earlier write callback was pending. See the [Chinese collection overview](../zh/explanation/observability/overview.md).
