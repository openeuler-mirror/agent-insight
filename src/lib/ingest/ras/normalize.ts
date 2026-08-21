/** Normalize RAS ingest payloads (flat JSON aligned with insight_push). */

export type RasEventRow = {
  id: string;
  deliveryId: string;
  type: string;
  taskId: string;
  framework?: string | null;
  platform?: string | null;
  anomalyKind: string | null;
  severity: string | null;
  summary: string | null;
  actionTypes: string | null;
  payloadJson: string;
  ts: string;
};

export type RasEventType =
  | "anomaly"
  | "actions"
  | "action_result"
  | "skill_requests"
  | "skill_request"
  | "skill_result"
  | string

export interface RasIngestRecord {
  taskId: string
  deliveryId: string
  type: RasEventType
  framework: string | null
  anomalyKind: string | null
  severity: string | null
  summary: string | null
  actionTypes: string | null
  payloadJson: string
  ts: Date
  rasSessionKey: string | null
}

/** Filled from GET /api/agent-ras/catalog kindLabels when available. */
let anomalyKindLabelOverrides: Record<string, { zh: string; en: string }> = {}

export function setAnomalyKindLabelOverrides(
  labels: Record<string, { zh: string; en: string }>,
): void {
  anomalyKindLabelOverrides = { ...labels }
}

export function rasKindLabel(kind: string, locale: "zh" | "en" = "zh"): string {
  const hit = anomalyKindLabelOverrides[kind]
  return hit ? hit[locale] : kind
}

export const SEVERITY_LABEL: Record<string, { zh: string; en: string }> = {
  low: { zh: "低危", en: "Low" },
  medium: { zh: "中危", en: "Medium" },
  high: { zh: "高危", en: "High" },
  critical: { zh: "严重", en: "Critical" },
}

export function rasSeverityLabel(severity: string | null | undefined, locale: "zh" | "en" = "zh"): string {
  const k = String(severity || "").toLowerCase()
  const hit = SEVERITY_LABEL[k]
  return hit ? hit[locale] : (severity || "-")
}

export type RasRecoveryOutcome = "none" | "success" | "failed" | "unknown"

/** Single-column RAS fault → recovery pipeline label for reliability list. */
export function rasRecoveryPipelineLabel(opts: {
  hasFault: boolean
  recoveryStarted: boolean
  recoveryOutcome: RasRecoveryOutcome
  abortedStream?: boolean
  locale?: "zh" | "en"
}): { label: string; hint: string | null; badgeStatus: "success" | "warning" | "error" | "pending" } {
  const locale = opts.locale ?? "zh"
  const zh = locale === "zh"
  if (!opts.hasFault) {
    return {
      label: zh ? "无故障" : "No fault",
      hint: null,
      badgeStatus: "success",
    }
  }
  if (!opts.recoveryStarted || opts.recoveryOutcome === "none") {
    return {
      label: zh ? "有故障 · 未启动恢复" : "Fault · recovery not started",
      hint: null,
      badgeStatus: "warning",
    }
  }
  const hint = opts.abortedStream
    ? (zh ? "含流中断动作" : "Includes abort_stream")
    : null
  if (opts.recoveryOutcome === "success") {
    return {
      label: zh ? "有故障 · 已启动 · 恢复成功" : "Fault · started · recovered",
      hint,
      badgeStatus: "success",
    }
  }
  if (opts.recoveryOutcome === "failed") {
    return {
      label: zh ? "有故障 · 已启动 · 恢复失败" : "Fault · started · recovery failed",
      hint,
      badgeStatus: "error",
    }
  }
  return {
    label: zh ? "有故障 · 已启动 · 结果未知" : "Fault · started · outcome unknown",
    hint,
    badgeStatus: "pending",
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

function extractActionTypes(payload: unknown): string | null {
  const p = asRecord(payload)
  if (!p) return null
  const actions = p.actions
  if (!Array.isArray(actions)) return null
  const types = actions
    .map((a) => {
      const o = asRecord(a)
      return o ? str(o.type) : null
    })
    .filter(Boolean) as string[]
  return types.length ? types.join(",") : null
}

export function buildRasIngestRecord(input: {
  taskId: string
  type: string
  deliveryId: string
  framework?: string | null
  anomalyKind?: string | null
  severity?: string | null
  summary?: string | null
  actionTypes?: string | null
  payload?: unknown
  ts?: Date | string | number | null
  rasSessionKey?: string | null
}): RasIngestRecord {
  const payload = input.payload ?? {}
  const ts =
    input.ts instanceof Date
      ? input.ts
      : typeof input.ts === "number"
        ? new Date(input.ts * (input.ts < 1e12 ? 1000 : 1))
        : typeof input.ts === "string" && input.ts
          ? new Date(input.ts)
          : new Date()

  return {
    taskId: input.taskId,
    deliveryId: input.deliveryId,
    type: input.type,
    framework: input.framework ?? null,
    anomalyKind: input.anomalyKind ?? null,
    severity: input.severity ?? null,
    summary: input.summary ?? null,
    actionTypes: input.actionTypes ?? null,
    payloadJson: JSON.stringify(payload),
    ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
    rasSessionKey: input.rasSessionKey ?? null,
  }
}

function normalizeOne(
  raw: Record<string, unknown>,
): { ok: true; record: RasIngestRecord } | { ok: false; error: string } {
  const taskId = str(raw.taskId) || str(raw.task_id)
  if (!taskId) {
    return { ok: false, error: "missing taskId" }
  }
  const type = str(raw.type) || str(raw.event_type)
  if (!type) {
    return { ok: false, error: "missing type" }
  }
  const deliveryId = str(raw.deliveryId) || str(raw.delivery_id)
  if (!deliveryId) {
    return { ok: false, error: "missing deliveryId" }
  }

  const payload = raw.payload ?? raw.data ?? {}
  const p = asRecord(payload) || {}

  const anomalyKind =
    str(raw.anomalyKind) ||
    str(raw.anomaly_kind) ||
    str(p.kind) ||
    null
  const severity = str(raw.severity) || str(p.severity) || null
  const summary = str(raw.summary) || str(p.summary) || null
  const actionTypes =
    str(raw.actionTypes) ||
    str(raw.action_types) ||
    extractActionTypes(payload)
  const framework =
    str(raw.framework) ||
    str(raw.platform) ||
    null
  const rasSessionKey =
    str(raw.rasSessionKey) ||
    str(raw.ras_session_key) ||
    (raw.platform && raw.session_id
      ? `${raw.platform}:${raw.session_id}`
      : raw.platform && taskId
        ? `${raw.platform}:${taskId}`
        : null)

  const tsRaw = raw.ts ?? raw.timestamp
  const record = buildRasIngestRecord({
    taskId,
    deliveryId,
    type,
    framework,
    anomalyKind,
    severity,
    summary,
    actionTypes,
    payload,
    ts: tsRaw as string | number | Date | null,
    rasSessionKey,
  })
  return { ok: true, record }
}

export type NormalizeResult =
  | { ok: true; record: RasIngestRecord; records?: RasIngestRecord[] }
  | { ok: false; error: string }

export function severityToStatusKind(
  severity: string | null | undefined,
): "pending" | "warning" | "error" | "success" {
  const s = String(severity || "").toLowerCase()
  if (s === "critical" || s === "high") return "error"
  if (s === "medium") return "warning"
  return "pending"
}

export function normalizeRasIngestBody(body: unknown): NormalizeResult {
  const root = asRecord(body)
  if (!root) return { ok: false, error: "body must be a JSON object" }

  if (Array.isArray(root.events)) {
    const records: RasIngestRecord[] = []
    for (const item of root.events) {
      const one = asRecord(item)
      if (!one) return { ok: false, error: "events[] items must be objects" }
      const r = normalizeOne(one)
      if (!r.ok) return r
      records.push(r.record)
    }
    if (!records.length) return { ok: false, error: "events[] is empty" }
    return { ok: true, record: records[0], records }
  }

  return normalizeOne(root)
}
