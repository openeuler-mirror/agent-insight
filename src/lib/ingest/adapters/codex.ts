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
  // Codex relay re-aggregates every execution from its complete durable spool.
  // Merging snapshots duplicates child turns and can corrupt their ownership.
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
}
