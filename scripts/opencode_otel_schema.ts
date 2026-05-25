import crypto from "node:crypto"

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [k: string]: JsonValue }

export type OTelCaptureKind =
  | "plugin.start"
  | "plugin.error"
  | "system.prompt"
  | "chat.message"
  | "text.complete"
  | "event"
  | "uploader.checkpoint"

export type OTelCaptureRecord = {
  t: string
  kind: OTelCaptureKind
  sessionID?: string
  parentID?: string
  projectID?: string
  agent?: string
  providerID?: string
  modelID?: string
  trace_id?: string
  span_id?: string
  parent_span_id?: string
  payload?: JsonValue
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

const SECRET_KEYS = new Set(
  [
    "apiKey",
    "api_key",
    "apikey",
    "authorization",
    "Authorization",
    "token",
    "accessToken",
    "refreshToken",
    "secret",
    "clientSecret",
    "privateKey",
    "password",
  ].map((s) => s.toLowerCase()),
)

export function isSecretKey(key: string): boolean {
  const k = (key || "").toLowerCase()
  if (SECRET_KEYS.has(k)) return true
  if (k.endsWith("_key") || k.endsWith("_token") || k.endsWith("_secret")) return true
  return false
}

export function redactJson(value: JsonValue): JsonValue {
  if (value === null) return value
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map(redactJson)

  const out: JsonObject = {}
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) {
      out[k] = "***"
      continue
    }
    out[k] = redactJson(v as JsonValue)
  }
  return out
}
