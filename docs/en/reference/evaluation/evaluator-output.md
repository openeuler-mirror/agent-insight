---
title: "Evaluator output and runtime contract"
description: "Output fields, normalization, human corrections, and execution-state boundaries."
---

This contract applies to one result from a built-in or custom platform evaluator. For scoring methodology, identity, registration, and implementation steps, see the [evaluator development guide, Chinese](../../../zh/how-to/evaluation/develop-evaluator.md).

## Output fields

The definition is in `src/lib/evaluators/eval-output.ts`. All five top-level fields are optional and may be combined:

```ts
type EvaluatorOutput = {
  verdict?: 'pass' | 'warn' | 'fail'
  summary?: string
  score?: number
  points?: EvalPoint[]
  evidence?: { md: string } | { json: unknown }
}

type EvalPoint = {
  label: string
  score?: number
  status?: 'covered' | 'partial' | 'missing'
  evidence?: { md: string } | { json: unknown }
  skillAttributable?: boolean
  suggestion?: string
  anchors?: string[]
}
```

| Field | Constraint |
| --- | --- |
| `verdict` | `pass/warn/fail`, representing met/partially met/not met |
| `summary` | One concrete conclusion, at most 200 characters after normalization; evaluator prompts ask for at most 80 |
| `score` | Overall `0`–`100` score; omit for a qualitative result |
| `points` | At most 64 items. Each requires a nonempty `label` of at most 120 characters; an item's optional score is also `0`–`100` |
| `evidence` | Either Markdown `{ md }` or structured JSON `{ json }` |
| `anchors` | Up to 32 strings per point, such as `step-N`, for related Trace steps |

Include `verdict` and `summary` when possible. The result card initially shows the conclusion, summary, and score. Expanding it reveals rationale, human correction, and comments; point-level details require another expansion. Most users first see only the summary, so explain the specific issue instead of listing vague evaluation dimensions.

When `verdict` is absent, the display derives it from score: at least `80` means `pass`, at least `60` means `warn`, otherwise `fail`. The derived verdict is not stored. Prefer an evaluator's explicit success judgment when that is more meaningful than score bands.

For older results without `summary`, the UI can fall back to the first paragraph of `evidence.md`; new evaluators should supply their own summary. Evidence identical to the summary is hidden as redundant, so provide additional detail when useful. Task completion uses its reason as conclusion, while trajectory quality has a separate conclusion rather than using the full execution-analysis text.

## Tolerant normalization

`normalizeEvaluatorOutput()` accepts loose model output and normalizes it:

- Finite scores are clamped to `[0,100]`; nonnumeric values are omitted.
- Scores in `(0,1]` are multiplied by `100`: `0.85` becomes `85`, and `1` becomes `100`. This includes an exact value of `1`.
- Known English and Chinese verdict aliases are accepted; an unknown verdict is omitted.
- Summary whitespace is collapsed and long summaries are truncated to 200 characters.
- Invalid points are discarded individually instead of failing the entire result.

The schema and tolerant normalizer have different roles. Emit valid, explicit output rather than depending on repair behavior. Point evidence can be Markdown or JSON; `skillAttributable`, `suggestion`, and `anchors` support the Skill improvement flow without changing ordinary evaluators.

## Human corrections

Human correction is a platform field, outside evaluator output. The platform stores `humanScore` and a required `humanReason`; the machine `score` remains available. Aggregation uses the effective score `humanScore ?? score`. Evaluators should not overwrite machine output with human judgments. Re-evaluating a row clears that row's human correction, so check the intended scope before retrying it.

## Runtime settings and execution state

Runtime settings and result output are separate contracts. `attemptTimeoutSeconds` controls one evaluation attempt; `maxRetries` counts additional retries, not total attempts. `evaluator-execution-config.ts` validates submitted settings and resolves platform defaults, uniform overrides, and per-evaluator overrides. The model-connection test timeout is unrelated. See the [experiment guide, Chinese](../../../zh/how-to/evaluation/experiments.md).

| Runtime field | Validation and meaning |
| --- | --- |
| `attemptTimeoutSeconds` | Integer `30`–`3600`, one attempt's deadline |
| `maxRetries` | Integer `0`–`3`, additional retry count |
| `mode` | `system` or `uniform`, plus optional per-evaluator `overrides` |
| Initial uniform values | 600 seconds and 2 retries; individual system presets need not share these values |

The platform records result-row state, such as `pending/running/done/failed/cancelled`. `status: failed` means evaluation did not complete successfully; a valid `verdict: fail` can be the output of a successful evaluation. Do not represent timeout, cancellation, or exhausted retries as a normal score.

`evaluatorId` and registration metadata determine the interpretation of historical results. Review migration implications before changing identity or category; result payloads cannot redefine them on every run. Independent Benchmark dispatch, native results, and Adapter normalization use the [Benchmark protocol](./benchmark-protocol.md).

## Human-correction API

`PATCH /api/experiments/:id/results/:resultId` accepts `{ humanScore, humanReason }`. A score is `0`–`100`, stored with one decimal place. Setting one requires a reason, trimmed and retained up to 1000 characters; `humanScore: null` clears the correction. Only `status: done` rows can be corrected. An unfinished row returns `409`, a missing/differently owned row returns `404`, and invalid parameters or missing identity return `400`. Success returns updated machine/human scores and correction metadata without changing the machine score.

## Implementation

- [Output schema and normalization](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/evaluators/eval-output.ts)
- [Runtime configuration](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/evaluators/evaluator-execution-config.ts)
- [Aggregation](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/engine/experiment/detail-agg.ts)

[中文权威版本](../../../zh/reference/evaluation/evaluator-output.md)
