import { extractSkillsWithVersionsFromQwenPawSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const qwenpawAdapter: FrameworkAdapter = {
  descriptor: {
    id: "qwenpaw",
    aliases: ["qwenpaw"],
    label: "QwenPaw",
    onboard: "plugin",
    platform: "qwenpaw",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
    skillScope: "session",
  },
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractSkillsWithVersionsFromQwenPawSession,
  isPlaceholderQuery: (query) => query.toLowerCase() === "qwenpaw session",
}
