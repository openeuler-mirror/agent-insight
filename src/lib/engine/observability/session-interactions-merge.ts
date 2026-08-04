type AnyObj = Record<string, any>

function toMsTimestamp(v: any): number | null {
  if (v == null) return null
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const s = v.trim()
    if (!s) return null
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    }
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function stableStringify(v: any): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function hash32(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return (h >>> 0).toString(16)
}

function getToolCallKey(item: AnyObj): string {
  const id = item?.id ?? item?.callID ?? item?.callId ?? item?.call_id
  if (typeof id === "string" && id.trim()) return `id:${id.trim()}`

  const name = item?.function?.name ?? item?.name ?? ""
  const args = item?.function?.arguments ?? item?.arguments ?? ""
  return `sig:${name}:${hash32(stableStringify(args))}`
}

function getInteractionKey(m: AnyObj): string {
  const id = m.id ?? m.message_id ?? m.messageID
  if (typeof id === "string" && id.trim()) return `id:${id.trim()}`

  const role = typeof m.role === "string" ? m.role : "unknown"
  const ts =
    toMsTimestamp(m.timestamp) ??
    toMsTimestamp(m.timeInfo?.created) ??
    toMsTimestamp(m.timeInfo?.completed) ??
    0

  const subSid = typeof m.subagent_session_id === "string" ? m.subagent_session_id : ""
  return `k:${subSid}:${ts}:${role}`
}

function isEmptyValue(v: any): boolean {
  return v === undefined || v === null || v === ""
}

/**
 * 同一次工具调用两份记录的合并。以 incoming 为主、但**空值不许盖掉已有值**。
 *
 * 必须逐字段合并、不能整份二选一:后到的那批常常是对同一次调用的补全(客户端补传把
 * output 补上、tool_result 事件把耗时/状态补上)。整份保留旧的会把补全丢掉,整份用新的
 * 又会把旧的独有字段抹掉 —— 两种都违背 monotonic「只增不减」的本意。
 */
function mergeToolCallPair(existing: AnyObj, incoming: AnyObj): AnyObj {
  const out: AnyObj = { ...existing, ...incoming }
  for (const key of Object.keys(existing)) {
    if (isEmptyValue(out[key]) && !isEmptyValue(existing[key])) out[key] = existing[key]
  }
  if (existing.function || incoming.function) {
    out.function = { ...(existing.function || {}), ...(incoming.function || {}) }
  }
  // output 只增不减:两边都有正文时保留更长的那份,免得后到的截断版把完整正文盖掉
  const existingOutput = typeof existing.output === "string" ? existing.output : ""
  const incomingOutput = typeof incoming.output === "string" ? incoming.output : ""
  if (existingOutput && incomingOutput && incomingOutput.length < existingOutput.length) {
    out.output = existingOutput
  }
  return out
}

function mergeToolCalls(existing: any, incoming: any) {
  const a = Array.isArray(existing) ? existing : []
  const b = Array.isArray(incoming) ? incoming : []
  if (a.length === 0) return b
  if (b.length === 0) return a
  const byKey = new Map<string, AnyObj>()
  const order: string[] = []
  for (const item of [...a, ...b]) {
    const k = getToolCallKey(item)
    const prev = byKey.get(k)
    if (prev) byKey.set(k, mergeToolCallPair(prev, item))
    else {
      byKey.set(k, item)
      order.push(k)
    }
  }
  return order.map((k) => byKey.get(k))
}

function mergeInteractionFields(existing: AnyObj, incoming: AnyObj): AnyObj {
  const out: AnyObj = { ...existing, ...incoming }

  const existingContent = typeof existing.content === "string" ? existing.content : ""
  const incomingContent = typeof incoming.content === "string" ? incoming.content : ""
  if (existingContent && !incomingContent) out.content = existingContent
  else if (existingContent && incomingContent && incomingContent.length < existingContent.length) out.content = existingContent

  if (existing.subagent_name && !incoming.subagent_name) out.subagent_name = existing.subagent_name
  if (existing.agent && !incoming.agent) out.agent = existing.agent
  if (existing.subagent_session_id && !incoming.subagent_session_id) out.subagent_session_id = existing.subagent_session_id

  out.tool_calls = mergeToolCalls(existing.tool_calls, incoming.tool_calls)

  if (existing.usage && !incoming.usage) out.usage = existing.usage
  if (existing.timeInfo && !incoming.timeInfo) out.timeInfo = existing.timeInfo

  return out
}

function interactionTs(v: AnyObj): number {
  return (
    toMsTimestamp(v.timestamp) ??
    toMsTimestamp(v.timeInfo?.created) ??
    toMsTimestamp(v.timeInfo?.completed) ??
    0
  )
}

export function mergeSessionInteractionsMonotonic(existing: AnyObj[], incoming: AnyObj[]) {
  const base = Array.isArray(existing) ? existing : []
  const inc = Array.isArray(incoming) ? incoming : []

  const map = new Map<string, AnyObj>()
  const incomingKeys: string[] = [] // 骨架:incoming 里出现过的 key,保持 incoming 顺序

  for (const m of base) {
    if (!m) continue
    const k = getInteractionKey(m)
    if (!map.has(k)) map.set(k, m)
  }

  for (const m of inc) {
    if (!m) continue
    const k = getInteractionKey(m)
    const prev = map.get(k)
    map.set(k, prev ? mergeInteractionFields(prev, m) : m)
    incomingKeys.push(k)
  }

  // 排序语义:incoming 的相对顺序是权威,只有 existing 独有的条目按 timestamp 插入。
  //
  // 不能整体按 timestamp 重排:聚合器每批都产出完整快照,且会**刻意**把补传合成的
  // 子 agent 轮次追加到父轮 task 调用之后 —— buildAgentCallTree 的认领是顺序敏感的,
  // 子 agent 轮次先于父轮 task 调用出现就认领不到、子节点塌回 root。而这类轮次的
  // timestamp(子 agent 真实完成时间)常常早于"task 调用挂上去的那一轮",按 ts 重排
  // 正好把它排回前面,一次落库合并就把聚合器摆好的顺序毁掉(生产时间戳各不相同,必中)。
  // 对本来就按时间产出的快照(绝大多数框架),incoming 顺序 == 时间顺序,行为不变。
  const result: AnyObj[] = []
  const placed = new Set<string>()
  for (const k of incomingKeys) {
    if (placed.has(k)) continue
    placed.add(k)
    result.push(map.get(k)!)
  }

  // existing 独有的条目(incoming 缺了它们,如乱序上传丢失的子会话):按 timestamp
  // 插到骨架里第一个"时间更晚"的条目之前,彼此保持原有相对顺序。
  for (const m of base) {
    if (!m) continue
    const k = getInteractionKey(m)
    if (placed.has(k)) continue
    placed.add(k)
    const v = map.get(k)!
    const ts = interactionTs(v)
    const at = result.findIndex((item) => interactionTs(item) > ts)
    if (at < 0) result.push(v)
    else result.splice(at, 0, v)
  }

  return result
}
