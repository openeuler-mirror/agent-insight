/**
 * Provider fetch interception for assistant.tool_call.replace_argument.
 * Ported from agent-fault-injection (agent-ras-eval) OpenCode plugin.
 */

export const ASSISTANT_TOOL_CALL_REWRITE_OP =
  "assistant.tool_call.replace_argument"

export const AGENT_FI_CONTEXT_HEADER = "x-agent-fi-eval-context"

function toolMatches(pattern: unknown, tool: string): boolean {
  if (pattern == null || pattern === "*" || pattern === "") {
    return true
  }
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
  const clause = when && typeof when === "object" ? when : {}
  if (!toolMatches(clause.tool, tool)) {
    return false
  }
  if ("call_index" in clause) {
    if (typeof clause.call_index !== "number" || clause.call_index !== callIndex) {
      return false
    }
  }
  return true
}

export function hasAssistantToolCallRewrite(
  plan: Array<Record<string, unknown>>,
): boolean {
  return plan.some(
    (step) => String(step.op || "") === ASSISTANT_TOOL_CALL_REWRITE_OP,
  )
}

function argumentPath(value: unknown): string[] | undefined {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(".")
      : []
  if (
    !parts.length ||
    parts.some(
      (part) =>
        typeof part !== "string" ||
        !part ||
        part === "__proto__" ||
        part === "prototype" ||
        part === "constructor",
    )
  ) {
    return undefined
  }
  return parts as string[]
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function applyAssistantToolCallRewrite(
  plan: Array<Record<string, unknown>>,
  toolName: string,
  callIndex: number,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; meta: Record<string, unknown> } {
  for (const step of plan) {
    if (String(step.op || "") !== ASSISTANT_TOOL_CALL_REWRITE_OP) {
      continue
    }
    const when =
      step.when && typeof step.when === "object"
        ? (step.when as Record<string, unknown>)
        : undefined
    if (!whenMatches(when, toolName, callIndex)) {
      continue
    }
    const args =
      step.args && typeof step.args === "object"
        ? (step.args as Record<string, unknown>)
        : {}
    const pathParts = argumentPath(args.path)
    if (!pathParts || !("from" in args) || !("to" in args)) {
      continue
    }

    const rewritten = JSON.parse(JSON.stringify(input)) as Record<string, unknown>
    let parent: Record<string, unknown> = rewritten
    let valid = true
    for (const part of pathParts.slice(0, -1)) {
      const child = parent[part]
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        valid = false
        break
      }
      parent = child as Record<string, unknown>
    }
    if (!valid) {
      continue
    }
    const leaf = pathParts[pathParts.length - 1]!
    if (!Object.prototype.hasOwnProperty.call(parent, leaf)) {
      continue
    }
    const before = parent[leaf]
    if (!jsonEqual(before, args.from) || jsonEqual(before, args.to)) {
      continue
    }
    parent[leaf] = args.to
    return {
      input: rewritten,
      meta: {
        applied: true,
        op: ASSISTANT_TOOL_CALL_REWRITE_OP,
        kind: "assistant_tool_call",
        tool: toolName,
        call_index: callIndex,
        argument_path: pathParts.join("."),
        from: args.from,
        to: args.to,
      },
    }
  }
  return { input, meta: { applied: false, op: null } }
}

type RewriteToolCall = (
  toolName: string,
  input: Record<string, unknown>,
  callID?: string,
) => Promise<Record<string, unknown>>

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string") {
    return undefined
  }
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

async export function providerRequestToolNames(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Set<string>> {
  let raw: string | undefined
  if (typeof init?.body === "string") {
    raw = init.body
  } else if (typeof Request !== "undefined" && input instanceof Request) {
    try {
      raw = await input.clone().text()
    } catch {
      // A non-cloneable request is treated as having no declared tools.
    }
  }
  if (!raw) {
    return new Set()
  }
  try {
    const payload = JSON.parse(raw)
    const tools = payload && typeof payload === "object" && Array.isArray(payload.tools)
      ? payload.tools
      : []
    const names = new Set<string>()
    for (const item of tools) {
      if (!item || typeof item !== "object") {
        continue
      }
      const row = item as Record<string, unknown>
      const fn = row.function
      const name =
        typeof row.name === "string"
          ? row.name
          : fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string"
            ? String((fn as { name: string }).name)
            : undefined
      if (name) {
        names.add(name)
      }
    }
    return names
  } catch {
    return new Set()
  }
}

async function rewriteJsonResponse(
  payload: Record<string, unknown>,
  rewrite: RewriteToolCall,
): Promise<boolean> {
  let changed = false

  const content = Array.isArray(payload.content) ? payload.content : []
  for (const block of content) {
    if (
      !block ||
      typeof block !== "object" ||
      (block as { type?: unknown }).type !== "tool_use"
    ) {
      continue
    }
    const row = block as Record<string, unknown>
    if (typeof row.name !== "string") {
      continue
    }
    const input = parseArguments(row.input)
    if (!input) {
      continue
    }
    const rewritten = await rewrite(row.name, input, String(row.id || "") || undefined)
    if (!jsonEqual(input, rewritten)) {
      row.input = rewritten
      changed = true
    }
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : []
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") {
      continue
    }
    const message = (choice as Record<string, unknown>).message
    if (!message || typeof message !== "object") {
      continue
    }
    const calls = Array.isArray((message as Record<string, unknown>).tool_calls)
      ? ((message as Record<string, unknown>).tool_calls as unknown[])
      : []
    for (const call of calls) {
      if (!call || typeof call !== "object") {
        continue
      }
      const callRow = call as Record<string, unknown>
      const fn = callRow.function
      if (!fn || typeof fn !== "object") {
        continue
      }
      const fnRow = fn as Record<string, unknown>
      if (typeof fnRow.name !== "string") {
        continue
      }
      const input = parseArguments(fnRow.arguments)
      if (!input) {
        continue
      }
      const rewritten = await rewrite(
        fnRow.name,
        input,
        String(callRow.id || "") || undefined,
      )
      if (!jsonEqual(input, rewritten)) {
        fnRow.arguments = JSON.stringify(rewritten)
        changed = true
      }
    }
  }

  const output = Array.isArray(payload.output) ? payload.output : []
  for (const item of output) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "function_call"
    ) {
      continue
    }
    const row = item as Record<string, unknown>
    if (typeof row.name !== "string") {
      continue
    }
    const input = parseArguments(row.arguments)
    if (!input) {
      continue
    }
    const rewritten = await rewrite(row.name, input, String(row.call_id || row.id || "") || undefined)
    if (!jsonEqual(input, rewritten)) {
      row.arguments = JSON.stringify(rewritten)
      changed = true
    }
  }
  return changed
}

type SseEntry = {
  lineIndex: number
  payload: Record<string, unknown>
}

type FragmentRef = {
  owner: Record<string, unknown>
  key: string
}

type BufferedToolCall = {
  name: string
  callID?: string
  fragments: FragmentRef[]
  complete: FragmentRef[]
  objectInputs: Array<{ owner: Record<string, unknown>; key: string }>
}

function bufferedCall(
  calls: Map<string, BufferedToolCall>,
  key: string,
): BufferedToolCall {
  const existing = calls.get(key)
  if (existing) {
    return existing
  }
  const created: BufferedToolCall = {
    name: "",
    fragments: [],
    complete: [],
    objectInputs: [],
  }
  calls.set(key, created)
  return created
}

async function rewriteBufferedCalls(
  calls: Map<string, BufferedToolCall>,
  rewrite: RewriteToolCall,
): Promise<boolean> {
  let changed = false
  for (const call of calls.values()) {
    if (!call.name) {
      continue
    }
    const fragmentText = call.fragments
      .map((ref) => String(ref.owner[ref.key] ?? ""))
      .join("")
    const completeText = call.complete
      .map((ref) => String(ref.owner[ref.key] ?? ""))
      .find((value) => value)
    const objectInput = call.objectInputs
      .map((ref) => parseArguments(ref.owner[ref.key]))
      .find((value) => value !== undefined)
    const input =
      parseArguments(fragmentText) ?? parseArguments(completeText) ?? objectInput
    if (!input) {
      continue
    }
    const rewritten = await rewrite(call.name, input, call.callID)
    if (jsonEqual(input, rewritten)) {
      continue
    }
    const encoded = JSON.stringify(rewritten)
    if (call.fragments.length) {
      call.fragments[0]!.owner[call.fragments[0]!.key] = encoded
      for (const ref of call.fragments.slice(1)) {
        ref.owner[ref.key] = ""
      }
    }
    for (const ref of call.complete) {
      ref.owner[ref.key] = encoded
    }
    if (!call.fragments.length) {
      for (const ref of call.objectInputs) {
        ref.owner[ref.key] = rewritten
      }
    }
    changed = true
  }
  return changed
}

async function rewriteSseResponse(
  text: string,
  rewrite: RewriteToolCall,
): Promise<{ text: string; changed: boolean }> {
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.split(/\r?\n/)
  const entries: SseEntry[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!line.startsWith("data:")) {
      continue
    }
    const raw = line.slice(5).trimStart()
    if (!raw || raw === "[DONE]") {
      continue
    }
    try {
      const payload = JSON.parse(raw)
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        entries.push({ lineIndex: index, payload })
      }
    } catch {
      // Preserve unknown SSE data unchanged.
    }
  }

  const calls = new Map<string, BufferedToolCall>()
  for (const entry of entries) {
    const payload = entry.payload
    const type = String(payload.type || "")

    if (type === "content_block_start") {
      const block = payload.content_block
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_use"
      ) {
        const blockRow = block as Record<string, unknown>
        const key = `anthropic:${String(payload.index ?? blockRow.id ?? "")}`
        const call = bufferedCall(calls, key)
        call.name = String(blockRow.name || "")
        call.callID = String(blockRow.id || "") || undefined
        if (blockRow.input && typeof blockRow.input === "object") {
          call.objectInputs.push({ owner: blockRow, key: "input" })
        }
      }
    } else if (type === "content_block_delta") {
      const delta = payload.delta
      if (
        delta &&
        typeof delta === "object" &&
        (delta as { type?: unknown }).type === "input_json_delta"
      ) {
        const key = `anthropic:${String(payload.index ?? "")}`
        bufferedCall(calls, key).fragments.push({
          owner: delta as Record<string, unknown>,
          key: "partial_json",
        })
      }
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : []
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") {
        continue
      }
      const choiceRow = choice as Record<string, unknown>
      const delta = choiceRow.delta
      if (!delta || typeof delta !== "object") {
        continue
      }
      const toolCalls = Array.isArray((delta as Record<string, unknown>).tool_calls)
        ? ((delta as Record<string, unknown>).tool_calls as unknown[])
        : []
      for (const item of toolCalls) {
        if (!item || typeof item !== "object") {
          continue
        }
        const row = item as Record<string, unknown>
        const key = `chat:${String(choiceRow.index ?? 0)}:${String(row.index ?? 0)}`
        const call = bufferedCall(calls, key)
        if (typeof row.id === "string" && row.id) {
          call.callID = row.id
        }
        const fn = row.function
        if (!fn || typeof fn !== "object") {
          continue
        }
        const fnRow = fn as Record<string, unknown>
        if (typeof fnRow.name === "string") {
          call.name += fnRow.name
        }
        if (typeof fnRow.arguments === "string") {
          call.fragments.push({ owner: fnRow, key: "arguments" })
        }
      }
    }

    const responseKey = (row: Record<string, unknown>): string =>
      `responses:${String(row.item_id ?? row.output_index ?? "")}`
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = payload.item
      if (
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "function_call"
      ) {
        const itemRow = item as Record<string, unknown>
        const call = bufferedCall(calls, responseKey({
          item_id: itemRow.id,
          output_index: payload.output_index,
        }))
        call.name = String(itemRow.name || call.name)
        call.callID = String(itemRow.call_id || itemRow.id || "") || call.callID
        if (typeof itemRow.arguments === "string") {
          call.complete.push({ owner: itemRow, key: "arguments" })
        }
      }
    } else if (type === "response.function_call_arguments.delta") {
      bufferedCall(calls, responseKey(payload)).fragments.push({
        owner: payload,
        key: "delta",
      })
    } else if (type === "response.function_call_arguments.done") {
      bufferedCall(calls, responseKey(payload)).complete.push({
        owner: payload,
        key: "arguments",
      })
    } else if (type === "response.completed") {
      const response = payload.response
      const output =
        response && typeof response === "object" && Array.isArray((response as Record<string, unknown>).output)
          ? ((response as Record<string, unknown>).output as unknown[])
          : []
      for (const item of output) {
        if (
          !item ||
          typeof item !== "object" ||
          (item as { type?: unknown }).type !== "function_call"
        ) {
          continue
        }
        const itemRow = item as Record<string, unknown>
        const call = bufferedCall(calls, responseKey({ item_id: itemRow.id }))
        call.name = String(itemRow.name || call.name)
        call.callID = String(itemRow.call_id || itemRow.id || "") || call.callID
        if (typeof itemRow.arguments === "string") {
          call.complete.push({ owner: itemRow, key: "arguments" })
        }
      }
    }
  }

  const changed = await rewriteBufferedCalls(calls, rewrite)
  if (!changed) {
    return { text, changed: false }
  }
  for (const entry of entries) {
    lines[entry.lineIndex] = `data: ${JSON.stringify(entry.payload)}`
  }
  return { text: lines.join(newline), changed: true }
}

async export function rewriteProviderResponse(
  response: Response,
  rewrite: RewriteToolCall,
): Promise<{ response: Response; changed: boolean; format: string }> {
  const contentType = response.headers.get("content-type")?.toLowerCase() || ""
  if (!response.body || response.status === 204) {
    return { response, changed: false, format: "empty" }
  }
  if (!contentType.includes("text/event-stream") && !contentType.includes("json")) {
    return { response, changed: false, format: "unsupported" }
  }

  const body = await response.text()
  let rewrittenBody = body
  let changed = false
  let format = "json"
  if (contentType.includes("text/event-stream")) {
    format = "sse"
    const rewritten = await rewriteSseResponse(body, rewrite)
    rewrittenBody = rewritten.text
    changed = rewritten.changed
  } else {
    try {
      const payload = JSON.parse(body)
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        changed = await rewriteJsonResponse(payload, rewrite)
        if (changed) {
          rewrittenBody = JSON.stringify(payload)
        }
      }
    } catch {
      return {
        response: new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
        changed: false,
        format: "invalid_json",
      }
    }
  }

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return {
    response: new Response(rewrittenBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    changed,
    format,
  }
}
