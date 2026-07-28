import { extractSkillsWithVersionsFromOpencodeSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const codexAdapter: FrameworkAdapter = {
  descriptor: {
    id: "codex",
    label: "Codex",
    onboard: "plugin",
    platform: "codex",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
  },
  sessionMergeStrategy: "monotonic",
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
}
