import { extractSkillsWithVersionsFromToolInteractions } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const qwencodeAdapter: FrameworkAdapter = {
  descriptor: {
    id: "qwencode",
    aliases: ["qwen-code", "qwen_code"],
    label: "Qwen Code",
    onboard: "plugin",
    platform: "qwencode",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
    skillScope: "agent-tree",
  },
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractSkillsWithVersionsFromToolInteractions,
  isPlaceholderQuery: (query) => query.toLowerCase() === "qwen code session",
}
