export interface InvokedSkill {
  name: string
  version: number | null
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

export function extractSkillsFromOpencodeSession(interactions: any[]): string[] {
  return extractSkillsWithVersionsFromOpencodeSession(interactions).map((s) => s.name)
}

export function extractSkillsFromClaudeSession(interactions: any[]): string[] {
  return extractSkillsWithVersionsFromClaudeSession(interactions).map((s) => s.name)
}

export function extractSkillsFromOpenClawSession(interactions: any[]): string[] {
  return extractSkillsWithVersionsFromOpenClawSession(interactions).map((s) => s.name)
}
