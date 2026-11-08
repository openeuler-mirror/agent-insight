---
title: "Tutorials"
description: "Provides step-by-step tutorials for connecting an Agent, inspecting a Trace, and running an initial evaluation."
keywords: ["Agent Insight", "getting started", "Agent integration", "evaluation"]
changefreq: "monthly"
---

# Tutorials

See [Tutorials](./navigation.md). The [coverage index](../navigation.md) identifies translated bodies and remaining Chinese-only guides.

When a platform evaluator has no model configured, **Go to model registry** opens registration in a new tab. Add a model, test the connection, set it as default, then return and retry scoring with the existing output and Trace. Code-only evaluators do not require a platform model. See the [first evaluation tutorial (Chinese)](../../zh/tutorial/evaluation/01-first-experiment.md).

Saved custom evaluators can be selected in Skill use-case and A/B experiments without a draft-to-ready transition. Required-input checks still apply. See the [evaluator guide (Chinese)](../../zh/how-to/evaluation/evaluators.md).

Skill use-case, A/B and trigger experiments share the execution concurrency setting (default 1). Each A/B side consumes one execution slot. Reuse and reruns preserve the saved value. Update and restart the execution client to enable concurrency greater than 1 and keep environment checks and cancellation commands responsive during execution. Existing evaluation limits still apply. See the [Skill execution guide (Chinese)](../../zh/explanation/evaluation/skills/overview.md).

Skill and ordinary experiment lists share automatic refresh: active records refresh every five seconds until all visible experiments finish. The Skill list pauses while creating an experiment or viewing results. Refresh failures retain the last confirmed records and retry automatically.

The [first Trace tutorial](./platform/01-quick-start.md#step-5-verify-a-trace) also covers custom time ranges.
