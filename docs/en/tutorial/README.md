---
title: "Tutorials"
description: "Provides step-by-step tutorials for connecting an Agent, inspecting a Trace, and running an initial evaluation."
keywords: ["Agent Insight", "getting started", "Agent integration", "evaluation"]
changefreq: "monthly"
---

# Tutorials

See [Tutorials](./navigation.md). The [coverage index](../navigation.md) identifies translated bodies and remaining Chinese-only guides.

- [Chinese documentation](../../zh/tutorial/navigation.md)
- [Start a Benchmark integration with the bundled Skill (Chinese)](../../zh/how-to/evaluation/benchmarks/onboard-custom-benchmark.md#21-使用自动接入-skill): provide the Agent Insight project address and official Benchmark source; the Skill compares its versioned protocol snapshot with the target before discovering runtime capabilities. Validation then covers endpoint contracts, real segments and a full end-to-end run. Live validation is a separate requirement from package self-tests.
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).

After retesting and publishing an optimized Skill, continue with [deployment to the source client (Chinese)](../../zh/how-to/optimization/skills/optimize.md#6-下发已发布版本). Existing client content is backed up with its version before installation.

When a platform evaluator has no model configured, **Go to model registry** opens registration in a new tab. Add a model, test the connection, set it as default, then return and retry scoring with the existing output and Trace. Code-only evaluators do not require a platform model. See the [first evaluation tutorial (Chinese)](../../zh/tutorial/evaluation/01-first-experiment.md).

Saved custom evaluators can be selected in Skill use-case and A/B experiments without a draft-to-ready transition. Required-input checks still apply. See the [evaluator guide (Chinese)](../../zh/how-to/evaluation/evaluators.md).

Skill use-case, A/B and trigger experiments share the execution concurrency setting (default 1). Each A/B side consumes one execution slot. Reuse and reruns preserve the saved value. Update and restart the execution client to enable concurrency greater than 1 and keep environment checks and cancellation commands responsive during execution. Existing evaluation limits still apply. See the [Skill execution guide (Chinese)](../../zh/explanation/evaluation/skills/overview.md).

Skill and ordinary experiment lists share automatic refresh: active records refresh every five seconds until all visible experiments finish. The Skill list pauses while creating an experiment or viewing results. Refresh failures retain the last confirmed records and retry automatically.


The [first Trace tutorial](./platform/01-quick-start.md#step-5-verify-a-trace) also covers custom time ranges.

After a JiuwenSwarm upgrade, update its observability extension and restart AgentServer, then check input, response, model calls, tool results, and usage. See [JiuwenSwarm compatibility](../reference/observability/client-compatibility.md#jiuwenswarm).

After collector setup, follow [explicit model forwarding](../how-to/observability/inference-gateway.md) to correlate inference analysis.

Administrators (default: `admin` when `AGENT_INSIGHT_ADMIN_USERS` is empty) can read all users’ Traces. Their Trace list includes a **User** column and an administrator-only **User** filter (default: **All users**). Selecting an owner filters the list and statistics together and supports links, same-tab filter memory, and reset. Their dashboard continues to aggregate all users’ Traces. Ordinary users continue to see their own data. An explicit administrator list replaces the default. See the [Trace visibility guide (Chinese)](../../zh/how-to/observability/view-traces.md#列表页总览).
