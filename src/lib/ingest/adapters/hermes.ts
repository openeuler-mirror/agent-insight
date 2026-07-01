import { extractSkillsWithVersionsFromHermesSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const hermesAdapter: FrameworkAdapter = {
  descriptor: {
    id: "hermes",
    label: "Hermes",
    onboard: "plugin",
    platform: "hermes",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
  },
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractSkillsWithVersionsFromHermesSession,
}
