import { extractSkillsWithVersionsFromQwenPawSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const qwenpawAdapter: FrameworkAdapter = {
  descriptor: {
    id: "qwenpaw",
    aliases: ["copaw"],
    label: "CoPaw (QwenPaw)",
    onboard: "plugin",
    platform: "qwenpaw",
  },
  capabilities: {
    skills: true,
    skillScope: "session",
  },
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractSkillsWithVersionsFromQwenPawSession,
}
