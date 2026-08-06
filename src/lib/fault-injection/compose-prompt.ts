/**
 * Compose the user prompt that activates a fault skill scenario.
 * Mirrors agent_fault_injection.fault_inject.catalog.scenarios.compose_fault_prompt.
 */
export function composeFaultPrompt(input: {
  skillName: string
  basePrompt: string
  submode?: { id?: string; name: string } | null
}): string {
  const skillName = String(input.skillName || '').trim()
  const instruction = input.submode?.name
    ? `使用 ${skillName} 技能，执行${input.submode.name}。`
    : `使用 ${skillName} 技能。`
  const base = String(input.basePrompt || '').trim()
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
