import { extractSkillsWithVersionsFromTraeSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const traeAdapter: FrameworkAdapter = {
  descriptor: {
    id: "trae",
    aliases: ["trae-cn", "trae-ide", "trae-ai"],
    label: "TRAE AI IDE",
    onboard: "plugin",
    platform: "trae",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
  },
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractSkillsWithVersionsFromTraeSession,
}
