import { extractSkillsWithVersionsFromOpencodeSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const piAgentAdapter: FrameworkAdapter = {
  descriptor: {
    id: "pi-agent",
    label: "Pi Agent",
    onboard: "plugin",
    platform: "pi",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
    skillScope: "agent-tree",
  },
  sessionMergeStrategy: "monotonic",
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
}
