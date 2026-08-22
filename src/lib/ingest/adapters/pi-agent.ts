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
  // Pi 的 OTLP consumer 每次都会从同一 task 的完整 spool 重聚合。保存时必须以完整
  // 快照替换旧结果，才能清除 Generic adapter 留下的 agent.pi/subagent 假 Tool。
  sessionMergeStrategy: "snapshot-replace",
  extractSkills: extractSkillsWithVersionsFromOpencodeSession,
}
