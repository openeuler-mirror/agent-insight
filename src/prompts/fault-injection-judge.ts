export function buildFaultInjectionJudgePrompt(input: {
  fault: string
  injectionMethod?: string | null
  submode?: string | null
  stepsText: string
  injectionEvidence: Record<string, unknown>
}): string {
  return `Evaluate whether the injected fault manifested and how it was contained.

Fault: ${input.fault}
Injection method: ${input.injectionMethod || 'unknown'}
Submode: ${input.submode || 'n/a'}

Optional framework injection markers (may be empty; prefer trajectory / final answer):
${JSON.stringify(input.injectionEvidence, null, 2)}

Execution steps / interactions summary:
${input.stepsText}

Return ONLY a JSON object:
{
  "outcome": "occurred" | "not_occurred",
  "fault_containment_status": "unresolved" | "recovered" | "prevented" | "inconclusive",
  "reason": "<short justification>"
}

Valid pairs only:
- occurred × unresolved | recovered
- not_occurred × prevented | inconclusive

Rules:
1) Prefer trajectory, final answer, and workspace end-state over optional structural/runtime injection evidence.
2) If the agent followed the corrupted signal (missing memory, rewritten tool result, injected history, etc.), outcome=occurred.
3) If the agent detected/rejected the injection and stayed correct, prefer recovered or prevented as appropriate.
4) If there is no usable evidence of the fault effect and no explicit prevention, use not_occurred × inconclusive (insufficient containment evidence — not "missing trajectory").
`
}
