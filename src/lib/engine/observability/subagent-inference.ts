type AnyObj = Record<string, any>

export function inferSubagentNamesFromInteractions(interactions: AnyObj[]) {
  let lastSubagentType: string | null = null
  return (interactions || []).map((m) => {
    if (!m) return m
    let setByTask = false
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc?.function?.name || tc?.name
        if (fn !== "task") continue
        const argRaw = tc?.function?.arguments
        if (typeof argRaw !== "string") continue
        try {
          const parsed = JSON.parse(argRaw)
          const t = parsed?.subagent_type
          if (typeof t === "string" && t.trim()) {
            lastSubagentType = t.trim()
            setByTask = true
          }
        } catch {}
      }
    }

    let out = m
    if (m.role === "subagent" && !m.subagent_name && lastSubagentType) {
      out = { ...m, subagent_name: lastSubagentType }
    }
    if (m.role === "assistant" && !setByTask) lastSubagentType = null
    return out
  })
}
