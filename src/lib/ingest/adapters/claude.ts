import { normalizeClaudeCodeInteractionsForStorage } from "@/lib/shared/interaction-content"
import { extractSkillsWithVersionsFromClaudeSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const claudeAdapter: FrameworkAdapter = {
  descriptor: {
    id: "claude",
    aliases: ["claudecode"],
    label: "Claude Code",
    onboard: "watcher",
    platform: "claude",
  },
  capabilities: { ownSkillsFromTree: false },
  normalizeForStorage: normalizeClaudeCodeInteractionsForStorage,
  extractSkills: extractSkillsWithVersionsFromClaudeSession,
}
