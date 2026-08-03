/**
 * OpenCode Host L3 Judge: independent session + ras-judge subagent.
 * Zero tools / limited steps — does not nest RAS on the judge session.
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, "..", "..")

const SKILL_PATHS = {
  detection: join(
    REPO_ROOT,
    "core",
    "detectors",
    "skills",
    "llm-loop-detection",
    "SKILL.md",
  ),
  recovery: join(
    REPO_ROOT,
    "core",
    "recovery",
    "skills",
    "llm-loop-review",
    "SKILL.md",
  ),
}

export function loadSkillBody(role, skillName) {
  const keyed =
    role === "recovery" ? SKILL_PATHS.recovery : SKILL_PATHS.detection
  const path = keyed
  if (!existsSync(path)) {
    return `(SKILL \`${skillName || role}\` 未能从本地包路径加载: ${path})`
  }
  return readFileSync(path, "utf8")
}

export function buildInlineSkillQuery({ role, skillName, payload }) {
  const body = loadSkillBody(role, skillName).trim()
  const task =
    role === "recovery"
      ? `恢复材料:\n${payload}`
      : `待判定 excerpt:\n${payload}`
  return (
    `## Skill \`${skillName}\`（已内联，禁止调用任何工具）\n` +
    `${body}\n\n` +
    `## 任务\n` +
    `${task}\n\n` +
    `按上述 Skill 要求，最终回复只输出 JSON 对象。`
  )
}

function extractJsonObject(text) {
  const raw = String(text || "").trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    /* fall through */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      /* fall through */
    }
  }
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      return null
    }
  }
  return null
}

function collectAssistantText(promptRaw) {
  if (!promptRaw || typeof promptRaw !== "object") return ""
  const parts =
    promptRaw.parts ||
    promptRaw.data?.parts ||
    promptRaw.message?.parts ||
    []
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p && (p.type === "text" || p.text))
    .map((p) => String(p.text || ""))
    .join("\n")
}

function sdkSessionId(created) {
  return (
    created?.data?.id ||
    created?.id ||
    created?.data?.sessionID ||
    created?.sessionID ||
    null
  )
}

/**
 * @param {{ client: any, directory?: string }} opts
 * @param {{ role: string, skillName: string, payload: string, timeoutMs?: number }} req
 */
export async function runSkillJudge(opts, req) {
  const client = opts?.client
  const directory = opts?.directory || ""
  const role = String(req?.role || "detection")
  const skillName = String(req?.skillName || "llm-loop-detection")
  const payload = String(req?.payload || "")
  const timeoutMs = Number(req?.timeoutMs) > 0 ? Number(req.timeoutMs) : 30000

  if (!client?.session?.create || !client?.session?.prompt) {
    return { ok: false, error: "session_api_missing", sessionID: null, result: null }
  }

  const query = buildInlineSkillQuery({ role, skillName, payload })
  let sessionID = null
  try {
    const createArgs = directory
      ? { title: "insight-ras-judge", directory }
      : { title: "insight-ras-judge" }
    const created = await client.session.create(createArgs)
    sessionID = sdkSessionId(created)
    if (!sessionID) {
      return { ok: false, error: "session_create_failed", sessionID: null, result: null }
    }

    const promptPromise = client.session.prompt({
      path: { id: sessionID },
      body: {
        agent: "ras-judge",
        parts: [{ type: "text", text: query }],
      },
    }).catch(async () =>
      client.session.prompt({
        sessionID,
        agent: "ras-judge",
        parts: [{ type: "text", text: query }],
      }),
    )

    const timed = await Promise.race([
      promptPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("judge_timeout")), timeoutMs),
      ),
    ])

    const text = collectAssistantText(timed?.data || timed)
    const result = extractJsonObject(text)
    if (!result) {
      return {
        ok: false,
        error: "invalid_judge_json",
        sessionID,
        result: null,
        rawText: text.slice(0, 500),
      }
    }
    return { ok: true, sessionID, result, error: null }
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e),
      sessionID,
      result: null,
    }
  }
}

export const RAS_JUDGE_AGENT_NAME = "ras-judge"
