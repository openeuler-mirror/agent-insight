/**
 * Compose the user prompt that activates a fault skill scenario.
 * Insight task creation SoT — not mirrored in Python CLI.
 */
export function composeFaultPrompt(input: {
  skillName: string
  basePrompt: string
  submode?: { id?: string; name: string } | null
  /**
   * Hidden faults (intercept_rewrite with assistant.tool_call.* runtime ops)
   * must not expose the fault skill name to the Agent. When true, the
   * taskPrompt is used as the user message instead of the skill template.
   */
  hidden?: boolean
  /** Business-scenario prompt for hidden faults; replaces the skill template. */
  taskPrompt?: string
}): string {
  const skillName = String(input.skillName || '').trim()
  const base = String(input.basePrompt || '').trim()

  // Hidden faults: the fault skill is not exposed to the Agent, so asking
  // it to "use skill X" references a non-existent skill. Use taskPrompt instead.
  if (input.hidden) {
    const task = String(input.taskPrompt || '').trim()
    if (!task) {
      // Fallback: no task_prompt defined — should not happen for hidden faults,
      // but degrade gracefully with submode name as a last resort.
      return input.submode?.name || skillName
    }
    if (base && !base.includes(task)) return `${task}\n\n${base}`
    return task
  }

  const instruction = input.submode?.name
    ? `使用 ${skillName} 技能，执行${input.submode.name}。`
    : `使用 ${skillName} 技能。`
  if (!base) return instruction
  if (base.includes(instruction.replace(/。$/, ''))) return base
  return `${instruction}\n\n${base}`
}

export function findSubmode(
  submodes: Array<{ id: string; name: string }>,
  submodeId: string | null | undefined,
): { id: string; name: string } | null {
  if (!submodeId) return null
  const needle = String(submodeId).trim()
  const exact = submodes.find((item) => item.id === needle || item.name === needle)
  if (exact) return exact
  const lowered = needle.toLowerCase()
  return (
    submodes.find(
      (item) => item.id.toLowerCase() === lowered || item.name.toLowerCase() === lowered,
    ) || null
  )
}
