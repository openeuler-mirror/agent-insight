import { spawn } from 'child_process'
import path from 'path'

export type CollectPayload = {
  runId: string
  taskId: string
  framework: string
  fault: string
  injectionMethod?: string
  faultActivated?: boolean
  faultActivatedAt?: number | null
  interactions: unknown[]
  markers?: unknown[]
  injectionEvidence?: Record<string, unknown>
}

function resolvePython(): string {
  return process.env.AGENT_INSIGHT_FI_PYTHON || process.env.PYTHON || 'python3'
}

function packageRoot(): string {
  return path.join(process.cwd(), 'agent_fault_injection')
}

export async function listFaultsViaPython(platform?: string): Promise<unknown[]> {
  const script = `
import json
from agent_fault_injection.fault_inject.registry import FaultRegistry
from agent_fault_injection.fault_inject.ui_catalog import (
    get_fault_ui_catalog,
    injection_method_label,
    resolve_fault_labels,
    resolve_fault_platforms,
    resolve_fault_submodes,
)
reg = FaultRegistry()
catalog = get_fault_ui_catalog()
rows = []
for name in catalog.ordered_ids(list(reg.names())):
    fault = reg.get(name)
    label_zh, label_en = resolve_fault_labels(
        fault_id=fault.name,
        skill_file=fault.skill_file,
        catalog=catalog,
    )
    method = getattr(fault, "injection_method", None) or "skill_inject"
    submodes = resolve_fault_submodes(
        fault_id=fault.name,
        skill_file=fault.skill_file,
        catalog=catalog,
    )
    rows.append({
        "id": fault.name,
        "name": fault.name,
        "skillName": fault.skill_name,
        "skill_name": fault.skill_name,
        "description": fault.description or "",
        "injectionMethod": method,
        "injection_method": method,
        "injectionMethodLabel": injection_method_label(method, catalog),
        "injection_method_label": injection_method_label(method, catalog),
        "platforms": resolve_fault_platforms(fault_id=fault.name, catalog=catalog),
        "label": label_zh or fault.name,
        "labelZh": label_zh,
        "label_zh": label_zh,
        "labelEn": label_en,
        "label_en": label_en,
        "submodes": submodes,
    })
print(json.dumps(rows, ensure_ascii=False))
`
  const raw = await runPython(script)
  const rows = JSON.parse(raw) as unknown[]
  if (!platform) return rows
  return rows.filter((row) => {
    const platforms = (row as { platforms?: string[] | null }).platforms
    if (!platforms || !platforms.length) return true
    return platforms.includes(platform)
  })
}

export async function readSkillMarkdown(faultName: string): Promise<{
  name: string
  skillName: string
  injectionMethod: string
  path: string
  filename: string
  content: string
}> {
  const script = `
import json
from pathlib import Path
from agent_fault_injection.fault_inject.registry import FaultRegistry
fault = FaultRegistry().get(${JSON.stringify(faultName)})
skill = Path(fault.skill_file)
print(json.dumps({
    "name": fault.name,
    "skillName": fault.skill_name,
    "injectionMethod": getattr(fault, "injection_method", None) or "skill_inject",
    "path": str(skill),
    "filename": skill.name,
    "content": skill.read_text(encoding="utf-8"),
}, ensure_ascii=False))
`
  return JSON.parse(await runPython(script))
}

/** Dry-run collect for E2E without launching a real agent. */
export function buildStubCollectPayload(input: {
  runId: string
  fault: string
  platform: string
  prompt: string
}): CollectPayload {
  const now = Date.now()
  const sessionId = `fi-session-${input.runId}`
  return {
    runId: input.runId,
    taskId: sessionId,
    framework: input.platform,
    fault: input.fault,
    injectionMethod: 'skill_inject',
    faultActivated: true,
    faultActivatedAt: now,
    interactions: [
      {
        messageID: `${sessionId}-user`,
        role: 'user',
        content: input.prompt,
        timestamp: now,
      },
      {
        messageID: `${sessionId}-assistant`,
        role: 'assistant',
        content: `Stub run for fault ${input.fault}: simulated agent output.`,
        timestamp: now + 1000,
      },
    ],
    markers: [
      {
        id: `${input.runId}-activation`,
        kind: 'fault_activation',
        label: 'Fault activated (stub)',
        timestamp: now,
        severity: 'warning',
        payload: { trace_anchor: { message_id: `${sessionId}-assistant` } },
      },
    ],
    injectionEvidence: {
      runtime: { stub: true, note: 'E2E stub collector' },
    },
  }
}

function runPython(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePython(), ['-c', code], {
      cwd: packageRoot(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr || stdout || `process exited ${code}`))
    })
  })
}
