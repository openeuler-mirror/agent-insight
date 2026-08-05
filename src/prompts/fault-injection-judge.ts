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

Trusted injection evidence (framework side; prefer over agent self-report):
${JSON.stringify(input.injectionEvidence, null, 2)}

Execution steps / interactions summary:
${input.stepsText}

Return ONLY a JSON object:
{
  "outcome": "occurred" | "not_occurred",
  "fault_containment_status": "unresolved" | "recovered" | "prevented" | "no_trace",
  "reason": "<short justification>"
}

Valid pairs only:
- occurred × unresolved | recovered
- not_occurred × prevented | no_trace

Rules:
1) If structural/runtime injection evidence shows the fault payload was applied and the agent followed the corrupted signal, outcome=occurred.
2) If the agent detected/rejected the injection and stayed correct, prefer recovered or prevented as appropriate.
3) If there is no usable trace of the fault effect, use not_occurred × no_trace.
`
}
