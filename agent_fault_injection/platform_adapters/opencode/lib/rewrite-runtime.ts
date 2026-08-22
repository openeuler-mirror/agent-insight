/**
 * Table-driven runtime rewrite (OpenCode thin layer).
 * Semantic SoT remains Python `rewrite_engine.py`; keep ops in sync via
 * capability_api.yaml + parity fixtures (tests/unit/test_rewrite_parity_fixtures.py).
 */

export type RuntimeStep = Record<string, unknown>

function toolMatches(pattern: unknown, tool: string): boolean {
  if (pattern == null || pattern === "*" || pattern === "") return true
  try {
    return new RegExp(`^(?:${String(pattern)})$`).test(tool)
  } catch {
    return false
  }
}

function whenMatches(
  when: Record<string, unknown> | undefined,
  tool: string,
  callIndex: number,
): boolean {
  if (!when) return true
  if (!toolMatches(when.tool, tool)) return false
  if ("call_index" in when) {
    const wanted = when.call_index
    if (typeof wanted !== "number" || !Number.isInteger(wanted)) return false
    if (callIndex !== wanted) return false
  }
  return true
}

export function messageRole(message: unknown): string {
  if (!message || typeof message !== "object") return ""
  const row = message as Record<string, unknown>
  if (typeof row.role === "string") return row.role
  const info = row.info
  if (info && typeof info === "object" && typeof (info as { role?: unknown }).role === "string") {
    return String((info as { role: string }).role)
  }
  return ""
}

function mergeText(message: Record<string, unknown>, prefix: string): void {
  if (typeof message.content === "string") {
    message.content = `${prefix}\n${message.content}`
  }
  const parts = message.parts
  if (Array.isArray(parts)) {
    parts.unshift({ type: "text", text: prefix })
    return
  }
  const blocks = message.blocks
  if (Array.isArray(blocks)) {
    blocks.unshift({ type: "text", text: prefix })
    return
  }
  message.content = prefix
}

type HandlerResult = { value: unknown; meta: Record<string, unknown> } | null

const handlers: Record<
  string,
  (ctx: {
    step: RuntimeStep
    args: Record<string, unknown>
    tool?: string
    callIndex?: number
    output?: string
    systemParts?: string[]
    text?: string
    messages?: Array<Record<string, unknown>>
  }) => HandlerResult
> = {
  "tool_result.replace_text": ({ args, tool, callIndex, output }) => {
    const source = args.from
    const dest = args.to
    if (typeof source !== "string" || typeof dest !== "string" || typeof output !== "string") {
      return null
    }
    if (!output.includes(source)) return null
    return {
      value: output.split(source).join(dest),
      meta: {
        applied: true,
        op: "tool_result.replace_text",
        tool,
        call_index: callIndex,
        from: source,
        to: dest,
      },
    }
  },
  "tool_result.replace_all": ({ args, tool, callIndex, output, step }) =>
    handlers["tool_result.replace_text"]!({
      step,
      args,
      tool,
      callIndex,
      output,
    }),
  "system.append": ({ args, systemParts }) => {
    const text = args.text
    if (typeof text !== "string" || !text.trim() || !systemParts) return null
    const parts = [...systemParts]
    const joined = parts.join("\n")
    if (!joined.includes(text)) parts.push(text)
    return { value: parts, meta: { applied: true, op: "system.append", kind: "prompt" } }
  },
  "system.replace_text": ({ args, systemParts }) => {
    const source = args.from
    const dest = args.to
    if (
      typeof source !== "string" ||
      typeof dest !== "string" ||
      !systemParts
    ) {
      return null
    }
    const joined = systemParts.join("\n")
    if (!joined.includes(source)) return null
    return {
      value: joined.split(source).join(dest).split("\n"),
      meta: {
        applied: true,
        op: "system.replace_text",
        kind: "prompt",
        from: source,
        to: dest,
      },
    }
  },
  "assistant.replace_text": ({ args, text, callIndex }) => {
    const source = args.from
    const dest = args.to
    if (typeof source !== "string" || typeof dest !== "string" || typeof text !== "string") {
      return null
    }
    if (!text.includes(source)) return null
    return {
      value: text.split(source).join(dest),
      meta: {
        applied: true,
        op: "assistant.replace_text",
        kind: "assistant",
        call_index: callIndex,
        from: source,
        to: dest,
      },
    }
  },
  "assistant.truncate": ({ args, text, callIndex }) => {
    const maxChars = args.max_chars
    if (typeof maxChars !== "number" || !Number.isInteger(maxChars) || typeof text !== "string") {
      return null
    }
    if (text.length <= maxChars) return null
    return {
      value: text.slice(0, maxChars),
      meta: {
        applied: true,
        op: "assistant.truncate",
        kind: "assistant",
        call_index: callIndex,
      },
    }
  },
  "messages.history.drop": ({ args, messages }) => {
    const count = args.count ?? 1
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0 || !messages) {
      return null
    }
    if (messages.length <= count) return null
    const dropIdx: number[] = []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messageRole(messages[index]).toLowerCase() === "system") continue
      dropIdx.push(index)
      if (dropIdx.length >= count) break
    }
    if (!dropIdx.length) return null
    const drop = new Set(dropIdx)
    const keep = messages.filter((_, index) => !drop.has(index))
    return {
      value: keep,
      meta: {
        applied: true,
        op: "messages.history.drop",
        kind: "messages",
        dropped: dropIdx.length,
      },
    }
  },
  "messages.inject": ({ args, messages }) => {
    if (!messages) return null
    const role = typeof args.role === "string" ? args.role : "user"
    const text = args.text
    const position = String(args.position || "merge_user")
    if (typeof text !== "string" || !text.trim() || !role.trim()) return null
    const current = messages.map((item) => ({ ...item }))
    if (position === "merge_user" || position === "prepend" || position === "append") {
      const blob = JSON.stringify(current)
      if (blob.includes(text.trim())) return null
      let targetIndex: number | null = null
      for (let index = 0; index < current.length; index += 1) {
        if (messageRole(current[index]).toLowerCase() === "user") {
          targetIndex = index
          if (position !== "append") break
        }
      }
      if (targetIndex == null) return null
      const target = { ...current[targetIndex]! }
      if (Array.isArray(target.parts)) target.parts = [...(target.parts as unknown[])]
      if (Array.isArray(target.blocks)) target.blocks = [...(target.blocks as unknown[])]
      if (target.info && typeof target.info === "object") {
        target.info = { ...(target.info as object) }
      }
      mergeText(target, text.trim())
      current[targetIndex] = target
      return {
        value: current,
        meta: {
          applied: true,
          op: "messages.inject",
          kind: "messages",
          role: role.trim(),
          position: "merge_user",
        },
      }
    }
    current.push({
      role: role.trim(),
      content: text,
      blocks: [{ type: "text", text }],
      message_id: null,
      timestamp_ms: 0,
      api_usage_tokens: null,
      info: { role: role.trim() },
      parts: [{ type: "text", text }],
    })
    return {
      value: current,
      meta: {
        applied: true,
        op: "messages.inject",
        kind: "messages",
        role: role.trim(),
        position,
      },
    }
  },
}

export function applyToolResultRewrite(
  plan: RuntimeStep[],
  tool: string,
  callIndex: number,
  output: string,
): { output: string; meta: Record<string, unknown> } {
  for (const step of plan) {
    const op = String(step.op || "")
    if (!op.startsWith("tool_result.")) continue
    const when =
      step.when && typeof step.when === "object"
        ? (step.when as Record<string, unknown>)
        : undefined
    if (!whenMatches(when, tool, callIndex)) continue
    const args =
      step.args && typeof step.args === "object"
        ? (step.args as Record<string, unknown>)
        : {}
    const handler = handlers[op]
    if (!handler) continue
    const result = handler({ step, args, tool, callIndex, output })
    if (result) return { output: String(result.value), meta: result.meta }
  }
  return { output, meta: { applied: false, op: null } }
}

export function applySystemRewrite(
  plan: RuntimeStep[],
  systemParts: string[],
): { parts: string[]; meta: Record<string, unknown> } {
  for (const step of plan) {
    const op = String(step.op || "")
    const args =
      step.args && typeof step.args === "object"
        ? (step.args as Record<string, unknown>)
        : {}
    const handler = handlers[op]
    if (!handler || !op.startsWith("system.")) continue
    const result = handler({ step, args, systemParts })
    if (result) return { parts: result.value as string[], meta: result.meta }
  }
  return { parts: systemParts, meta: { applied: false, op: null } }
}

export function applyAssistantTextRewrite(
  plan: RuntimeStep[],
  text: string,
  callIndex = 1,
): { text: string; meta: Record<string, unknown> } {
  for (const step of plan) {
    const op = String(step.op || "")
    if (!op.startsWith("assistant.")) continue
    const when =
      step.when && typeof step.when === "object"
        ? (step.when as Record<string, unknown>)
        : undefined
    if (when && "call_index" in when) {
      const wanted = when.call_index
      if (typeof wanted !== "number" || !Number.isInteger(wanted) || callIndex !== wanted) {
        continue
      }
    }
    const args =
      step.args && typeof step.args === "object"
        ? (step.args as Record<string, unknown>)
        : {}
    const handler = handlers[op]
    if (!handler) continue
    const result = handler({ step, args, text, callIndex })
    if (result) return { text: String(result.value), meta: result.meta }
  }
  return { text, meta: { applied: false, op: null } }
}

export function applyMessagesRewrite(
  plan: RuntimeStep[],
  messages: Array<Record<string, unknown>>,
): { messages: Array<Record<string, unknown>>; meta: Record<string, unknown> } {
  for (const step of plan) {
    const op = String(step.op || "")
    if (!op.startsWith("messages.")) continue
    const args =
      step.args && typeof step.args === "object"
        ? (step.args as Record<string, unknown>)
        : {}
    const handler = handlers[op]
    if (!handler) continue
    const result = handler({ step, args, messages })
    if (result) {
      return {
        messages: result.value as Array<Record<string, unknown>>,
        meta: result.meta,
      }
    }
  }
  return { messages, meta: { applied: false, op: null } }
}
