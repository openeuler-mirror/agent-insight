# AgentDebug Skills Analysis Decoupling

## Context

AgentDebug currently displays Skills analysis by reading completed trajectory evaluation rows. This couples the AgentDebug detail card to the trajectory evaluation page and makes failed or stale trajectory rows leak into AgentDebug behavior.

## Decision

AgentDebug should own its Skills analysis result. The AgentDebug UI will read and write `report.skillsAnalysis` inside `AgentDebugReport.reportJson`.

The key-action analysis logic itself should stay shared:

- Extract invoked/root skill for the trace.
- Extract reference key actions from parsed Skill flow.
- Extract actual flattened trace steps.
- Call `evaluateTrajectoryViaOpencode` with `comparisonMode: 'skill_key_actions'`.

The shared extraction logic will live in `src/lib/engine/evaluation/key-action-trace-analysis.ts`. AgentDebug will call it through a dedicated endpoint:

`POST /api/observe/executions/[executionId]/agent-debug/skills-analysis`

## Scope

- Do not read `TrajectoryEvalResult` from AgentDebug.
- Do not trigger `analyze-match`.
- Do not write trajectory evaluation rows or SkillIssue records.
- Preserve the generated Skills analysis in AgentDebug report JSON.
- When AgentDebug diagnosis reruns, include the saved Skills analysis through a small file reference in the agent workspace instead of inlining the full payload into the prompt.

