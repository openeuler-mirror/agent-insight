export interface InvokedSkill {
  name: string
  version: number | null
}

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_\-\.]+$/

/**
 * jiuwen/jiuwenswarm invokes a skill through its dedicated `skill_tool`, which takes a
 * `skill_name` argument (openjiuwen harness/tools/skills/skill_tool.py). We key skill
 * detection off this tool only — NOT off `read_file` of a SKILL.md (jiuwen can also read a
 * skill that way, but per product decision that path is not counted as a skill invocation).
 *
 * The tool name is jiuwen-specific (`skill_tool`), so this is safe to share with the
 * framework-agnostic agent-trace classifier without affecting other frameworks. Returns the
 * skill name, or null. Note OTLP serializes the tool input as a positional dump like
 * `[[{"skill_name":"x"}], {"session":"..."}]`, so we extract `skill_name` by regex rather
 * than assuming a clean top-level JSON object.
 */
export function jiuwenSkillNameFromToolCall(name: string | undefined, rawArgs: any): string | null {
  if (String(name ?? "").toLowerCase() !== "skill_tool") return null
  const text = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? "")
  const m = text.match(/["']skill_name["']\s*:\s*["']([^"']+)["']/)
  if (!m) return null
  const s = m[1].trim().replace(/^['"]+|['"]+$/g, "")
  return SKILL_NAME_PATTERN.test(s) ? s : null
}

export function normalizeInteractions(messages: any[]): any[] {
  if (!messages || !Array.isArray(messages) || messages.length === 0) return []

  const isInteractions = messages.some((m) => m && (m.requestMessages || m.responseMessage))
  if (isInteractions) return messages

  const normalized: any[] = []
  let turnMessages: any[] = []

  const flushTurn = (msgs: any[]) => {
    if (msgs.length === 0) return

    let lastAssistantIndex = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant" || msgs[i].role === "subagent") {
        lastAssistantIndex = i
        break
      }
    }

    if (lastAssistantIndex !== -1) {
      normalized.push({
        requestMessages: msgs.slice(0, lastAssistantIndex),
        responseMessage: msgs[lastAssistantIndex],
      })
    } else {
      normalized.push({
        requestMessages: msgs,
        responseMessage: null,
      })
    }
  }

  for (const msg of messages) {
    if (!msg) continue
    const role = msg.role || "unknown"
    const isUserBoundary = role === "user" || role === "opencode"

    if (isUserBoundary && turnMessages.length > 0) {
      flushTurn(turnMessages)
      turnMessages = []
    }
    turnMessages.push(msg)
  }

  flushTurn(turnMessages)
  return normalized
}

export function extractSkillsWithVersionsFromOpencodeSession(interactions: any[]): InvokedSkill[] {
  const seen = new Set<string>()
  const skills: InvokedSkill[] = []
  const skillNamePattern = /^[a-zA-Z0-9_\-\.]+$/

  const collectFromMsg = (msg: any) => {
    if (!msg) return
    const calls = msg.tool_calls || msg.toolCalls || []
    for (const tc of calls) {
      const name = (tc?.function?.name ?? tc?.name ?? "").toLowerCase()
      const raw = tc?.function?.arguments ?? tc?.arguments ?? ""
      try {
        const args = typeof raw === "string" ? JSON.parse(raw) : raw

        if (name === "skill" || name === "load_skill") {
          const skillName = args?.name ?? args?.skill_name ?? args?.skillName ?? args?.skill
          if (skillName != null && String(skillName).trim()) {
            const s = String(skillName).trim().replace(/^['"]+|['"]+$/g, "")
            if (skillNamePattern.test(s) && !seen.has(s)) {
              seen.add(s)
              const version = args?.version != null ? Number(args.version) : null
              skills.push({ name: s, version: version !== null && !isNaN(version) ? version : null })
            }
          }
          continue
        }

        if (name === "task") {
          const loaded = args?.load_skills ?? args?.loadSkills ?? []
          if (Array.isArray(loaded)) {
            for (const item of loaded) {
              const rawName =
                typeof item === "string" ? item : item?.name ?? item?.skill ?? item?.skill_name ?? item?.skillName
              if (rawName == null || !String(rawName).trim()) continue
              const s = String(rawName).trim().replace(/^['"]+|['"]+$/g, "")
              if (!skillNamePattern.test(s) || seen.has(s)) continue
              seen.add(s)
              const rawVersion = typeof item === "object" ? item?.version : null
              const version = rawVersion != null ? Number(rawVersion) : null
              skills.push({ name: s, version: version !== null && !isNaN(version) ? version : null })
            }
          }
        }
      } catch {}
    }
  }

  for (const interaction of interactions) {
    collectFromMsg(interaction.responseMessage)
    const reqMsgs = interaction.requestMessages || []
    for (const m of reqMsgs) {
      if (m.role === "assistant" || m.role === "subagent") collectFromMsg(m)
    }
  }
  return skills
}

export function extractSkillsWithVersionsFromHermesSession(interactions: any[]): InvokedSkill[] {
  const seen = new Set<string>()
  const skills: InvokedSkill[] = []
  const skillNamePattern = /^[a-zA-Z0-9_\-\.]+$/

  const collectFromMsg = (msg: any) => {
    if (!msg) return
    const calls = msg.tool_calls || msg.toolCalls || []
    for (const tc of calls) {
      const toolName = String(tc?.function?.name ?? tc?.name ?? "").toLowerCase()
      if (toolName !== "skill_view" && toolName !== "skill" && toolName !== "load_skill") continue
      const raw = tc?.function?.arguments ?? tc?.arguments ?? ""
      try {
        const args = typeof raw === "string" ? JSON.parse(raw) : raw
        const rawName = args?.name ?? args?.skill_name ?? args?.skillName ?? args?.skill
        if (rawName == null || !String(rawName).trim()) continue
        const name = String(rawName).trim().replace(/^['"]+|['"]+$/g, "")
        if (!skillNamePattern.test(name) || seen.has(name)) continue
        seen.add(name)
        const rawVersion = args?.version
        const version = rawVersion != null ? Number(rawVersion) : null
        skills.push({ name, version: version !== null && !Number.isNaN(version) ? version : null })
      } catch {}
    }
  }

  for (const interaction of interactions) {
    collectFromMsg(interaction.responseMessage)
    for (const message of interaction.requestMessages || []) {
      if (message?.role === "assistant" || message?.role === "subagent") collectFromMsg(message)
    }
  }
  return skills
}

export function extractSkillsWithVersionsFromClaudeSession(interactions: any[]): InvokedSkill[] {
  const seen = new Set<string>()
  const skills: InvokedSkill[] = []

  const collect = (content: any) => {
    if (!content || !Array.isArray(content)) return
    for (const block of content) {
      if (block?.type !== "tool_use") continue
      const toolName = (block?.name || "").toLowerCase()
      if (toolName !== "skill" && toolName !== "load_skill") continue
      const input = block.input
      const skillName = input?.skill ?? input?.skill_name ?? input?.skillName ?? input?.name
      if (skillName == null || !String(skillName).trim()) continue
      const s = String(skillName).trim().replace(/^['"]+|['"]+$/g, "")
      const skillNamePattern = /^[a-zA-Z0-9_\-\.]+$/
      if (skillNamePattern.test(s) && !seen.has(s)) {
        seen.add(s)
        const version = input?.version != null ? Number(input.version) : null
        skills.push({ name: s, version: version !== null && !isNaN(version) ? version : null })
      }
    }
  }

  for (const turn of interactions) {
    if (turn.responseMessage?.content) collect(turn.responseMessage.content)
    if (turn.requestMessages) {
      for (const m of turn.requestMessages) {
        if (m.role === "assistant" && m.content) collect(m.content)
      }
    }
  }
  return skills
}

export function extractSkillsWithVersionsFromOpenClawSession(interactions: any[]): InvokedSkill[] {
  const seen = new Set<string>()
  const skills: InvokedSkill[] = []

  const collect = (content: any) => {
    if (!content || !Array.isArray(content)) return
    for (const block of content) {
      if (block?.type !== "toolCall") continue
      const toolName = (block?.name || "").toLowerCase()
      if (toolName !== "skill" && toolName !== "load_skill") continue
      const input = block?.arguments
      const skillName = input?.skill ?? input?.skill_name ?? input?.skillName ?? input?.name
      if (skillName == null || !String(skillName).trim()) continue
      const s = String(skillName).trim().replace(/^['"]+|['"]+$/g, "")
      const skillNamePattern = /^[a-zA-Z0-9_\-\.]+$/
      if (skillNamePattern.test(s) && !seen.has(s)) {
        seen.add(s)
        const version = input?.version != null ? Number(input.version) : null
        skills.push({ name: s, version: version !== null && !isNaN(version) ? version : null })
      }
    }
  }

  for (const turn of interactions) {
    if (turn.responseMessage?.content) collect(turn.responseMessage.content)
    if (turn.requestMessages) {
      for (const m of turn.requestMessages) {
        if (m.role === "assistant" && m.content) collect(m.content)
      }
    }
  }
  return skills
}

export function extractSkillsWithVersionsFromJiuwenSession(interactions: any[]): InvokedSkill[] {
  const seen = new Set<string>()
  const skills: InvokedSkill[] = []

  const collectFromMsg = (msg: any) => {
    if (!msg) return
    const calls = msg.tool_calls || msg.toolCalls || []
    for (const tc of calls) {
      const name = tc?.function?.name ?? tc?.name
      const raw = tc?.function?.arguments ?? tc?.arguments ?? ""
      const skillName = jiuwenSkillNameFromToolCall(name, raw)
      if (skillName && !seen.has(skillName)) {
        seen.add(skillName)
        // jiuwen traces carry no skill version; snapshotSkillVersions fills active version at write time
        skills.push({ name: skillName, version: null })
      }
    }
  }

  for (const interaction of interactions) {
    collectFromMsg(interaction.responseMessage)
    for (const m of interaction.requestMessages || []) {
      if (m.role === "assistant" || m.role === "subagent") collectFromMsg(m)
    }
  }
  return skills
}

export function extractSkillsFromOpencodeSession(interactions: any[]): string[] {
  return extractSkillsWithVersionsFromOpencodeSession(interactions).map((s) => s.name)
}

export function extractSkillsFromClaudeSession(interactions: any[]): string[] {
  return extractSkillsWithVersionsFromClaudeSession(interactions).map((s) => s.name)
}

export function extractSkillsFromOpenClawSession(interactions: any[]): string[] {
  return extractSkillsWithVersionsFromOpenClawSession(interactions).map((s) => s.name)
}

export function extractSkillsFromHermesSession(interactions: any[]): string[] {
  return extractSkillsWithVersionsFromHermesSession(interactions).map((s) => s.name)
}
