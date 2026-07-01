import { extractSkillsWithVersionsFromOpencodeSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const langfuseLangGraphAdapter: FrameworkAdapter = {
  descriptor: {
    id: "langfuse-langgraph",
    label: "Langfuse-Langgraph",
    onboard: "env",
    platform: "langfuse",
  },
  capabilities: {
    skills: true,
    subagentTree: true,
  },
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
}
