---
title: "How-to guides"
description: "Organizes available English procedures for platform maintenance and Agent integration, with links to Chinese guides."
keywords: ["Agent Insight", "how-to guides", "platform maintenance", "Agent integration"]
changefreq: "monthly"
---

# How-to guides

See [How-to guides](./navigation.md). The [coverage index](../navigation.md) identifies translated bodies and remaining Chinese-only guides.

Dataset options show the name, type, and case count. When generating a Trace in an ordinary Agent experiment, the Agent chooses from the Skills available in its runtime environment. In Skill use-case experiments, the wizard header shows the selected Skill and version. In A/B experiments, the header shows the Skill and each group shows its version or the no-Skill baseline. See the guides for [ordinary experiments](../../zh/how-to/evaluation/experiments.md), [use-case analysis](../../zh/how-to/evaluation/skills/use-case-analysis.md), and [A/B testing](../../zh/how-to/evaluation/skills/ab-test.md) in Chinese.

Missing platform evaluation models are reported with a model registry link in progress dialogs and evaluator error cards. Add a model, test its connection and set it as default, then return to retry scoring; existing output and Trace can be reused without rerunning the Agent. Authentication, timeout and response-format errors retain their specific messages. See [experiments (Chinese)](../../zh/how-to/evaluation/experiments.md#查看单条-case-详情) and [model registration (Chinese)](../../zh/how-to/platform/settings/model-registry.md).

Skill use-case and A/B experiments list saved custom evaluators regardless of their historical ready/draft status. Custom evaluator cards and list rows no longer show those status badges. Stored status values remain compatible; no data migration is needed. Required reference answers and dataset inputs are still checked, and built-in evaluator status and retirement rules are unchanged. Trigger analysis retains its dedicated evaluator. See the [evaluator guide (Chinese)](../../zh/how-to/evaluation/evaluators.md).

Skill use-case, A/B and trigger experiments share the execution concurrency setting (default 1). Each A/B side consumes one execution slot. Reuse and reruns preserve the saved value. Update and restart the execution client to enable concurrency greater than 1 and keep environment checks and cancellation commands responsive during execution. Existing evaluation limits still apply. See the [Skill execution guide (Chinese)](../../zh/explanation/evaluation/skills/overview.md).

Skill and ordinary experiment lists share automatic refresh: active records refresh every five seconds until all visible experiments finish. The Skill list pauses while creating an experiment or viewing results. Refresh failures retain the last confirmed records and retry automatically.

Trace filtering supports **Time → Custom time range** with optional start/end bounds to the second, interpreted in the displayed browser time zone. Select **Apply** to update the list and statistics together. At least one bound is required; invalid or reversed bounds cannot be applied. **Cancel** discards edits. Presets clear custom bounds. Links and same-tab filter memory preserve the range; reset clears it. See the [Trace guide (Chinese)](../../zh/how-to/observability/view-traces.md#2-筛选区).
