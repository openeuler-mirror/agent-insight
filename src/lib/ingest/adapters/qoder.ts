import { extractSkillsWithVersionsFromOpencodeSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

function extractQoderSkills(interactions: Array<Record<string, unknown>>) {
  const normalized = extractSkillsWithVersionsFromOpencodeSession(interactions)
  const flat = extractSkillsWithVersionsFromOpencodeSession(
    interactions.map((interaction) => ({ responseMessage: interaction, requestMessages: [] })),
  )
  const merged = new Map(normalized.map((skill) => [skill.name, skill]))
  for (const skill of flat) {
    if (!merged.has(skill.name)) merged.set(skill.name, skill)
  }
  return [...merged.values()]
}

export const qoderAdapter: FrameworkAdapter = {
  descriptor: {
    id: "qoder",
    aliases: ["qoder-cli", "qoder-cn", "qoder-desktop", "qoder-jetbrains", "qoder-work"],
    label: "Qoder CN",
    onboard: "plugin",
    platform: "qoder",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
    allowSnapshotShrink: true,
  },
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractQoderSkills,
}
