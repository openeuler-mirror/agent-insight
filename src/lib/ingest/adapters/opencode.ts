import { extractSkillsWithVersionsFromOpencodeSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const opencodeAdapter: FrameworkAdapter = {
  descriptor: {
    id: "opencode",
    label: "OpenCode",
    onboard: "plugin",
    platform: "opencode",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
    skillScope: "agent-tree",
  },
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
}
