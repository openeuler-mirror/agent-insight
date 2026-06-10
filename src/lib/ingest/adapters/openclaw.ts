import { extractSkillsWithVersionsFromOpenClawSession } from "@/lib/shared/interaction-utils"
import type { FrameworkAdapter } from "./types"

export const openclawAdapter: FrameworkAdapter = {
  descriptor: {
    id: "openclaw",
    label: "OpenClaw",
    onboard: "plugin",
    platform: "openclaw",
  },
  extractSkills: extractSkillsWithVersionsFromOpenClawSession,
}
