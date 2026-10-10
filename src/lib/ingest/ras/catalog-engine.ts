import { spawn, spawnSync } from 'child_process'
import path from 'path'
import { runtimePackageRoot } from '@/lib/runtime/package-root'

function resolvePython(): string {
  return process.env.AGENT_INSIGHT_RAS_PYTHON || process.env.RAS_PYTHON || process.env.PYTHON || 'python3'
}

function agentRasRoot(): string {
  return path.join(runtimePackageRoot(), 'agent_ras')
}

export type RasCatalogPrompt = {
  key: string
  role: string
  severityBand?: string
  label?: { zh?: string; en?: string }
  templateZh?: string | null
  templateEn?: string | null
}

export type RasCatalogSubmode = {
  id: string
  domainId?: string
  parentId: string
  parent: { zh: string; en: string }
  subMode: { zh: string; en: string }
  anomalyKind: string
  severities: string[]
  detects: { zh: string; en: string }
  recoverySummary: { zh: string; en: string }
  recoveryActions: string[]
  runtimeKeys?: Record<string, string>
  prompts: RasCatalogPrompt[]
  primaryFaults?: string[]
}

export type RasCatalogDomain = {
  id: string
  kinds: string[]
  anchor?: string | null
  /** Lower runs first in configure UI. */
  priority?: number
  /** Alias of priority from Python catalog builder. */
  order?: number
  detectionSkill?: string | null
  reviewSkill?: string | null
  streamKinds?: string[]
  kindOverrides?: Record<string, string[]>
  configSchema: Record<string, unknown>
  configDefaults: Record<string, unknown>
  label?: { zh?: string; en?: string } | null
  submodes: RasCatalogSubmode[]
  kindLabels?: Record<string, { zh: string; en: string }>
}

export type RasCapabilityCatalog = {
  version: number
  domains: RasCatalogDomain[]
  submodes: RasCatalogSubmode[]
  recovery: {
    global: Record<string, unknown>
    actions?: string[]
  }
  kindLabels: Record<string, { zh: string; en: string }>
}

let cached: { at: number; catalog: RasCapabilityCatalog } | null = null
const CACHE_MS = 5_000

function catalogPythonCode(root: string): string {
  return `
import json, sys
sys.path.insert(0, ${JSON.stringify(root)})
from detectors.catalog import build_capability_catalog
print(json.dumps(build_capability_catalog(), ensure_ascii=False))
`
}

function normalizeCatalog(raw: RasCapabilityCatalog): RasCapabilityCatalog {
  const catalog = raw
  const kindLabels: Record<string, { zh: string; en: string }> = { ...(catalog.kindLabels || {}) }
  for (const domain of catalog.domains || []) {
    if (domain.label) {
      for (const kind of domain.kinds || []) {
        if (!kindLabels[kind]) {
          kindLabels[kind] = {
            zh: String(domain.label.zh || kind),
            en: String(domain.label.en || kind),
          }
        }
      }
    }
    Object.assign(kindLabels, domain.kindLabels || {})
  }
  catalog.kindLabels = kindLabels
  return catalog
}

export async function getRasCapabilityCatalog(opts?: { force?: boolean }): Promise<RasCapabilityCatalog> {
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.catalog
  }
  const root = agentRasRoot()
  const raw = await runPython(catalogPythonCode(root), root)
  const catalog = normalizeCatalog(JSON.parse(raw) as RasCapabilityCatalog)
  cached = { at: Date.now(), catalog }
  return catalog
}

/** Sync catalog load for request-path validation / form schema (cached). */
export function getRasCapabilityCatalogSync(opts?: { force?: boolean }): RasCapabilityCatalog {
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.catalog
  }
  const root = agentRasRoot()
  const pythonPath = [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
  const result = spawnSync(resolvePython(), ['-c', catalogPythonCode(root)], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: pythonPath },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `catalog spawn exited ${result.status}`)
  }
  const catalog = normalizeCatalog(JSON.parse(String(result.stdout || '').trim()) as RasCapabilityCatalog)
  cached = { at: Date.now(), catalog }
  return catalog
}

function runPython(code: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const pythonPath = [cwd, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
    const child = spawn(resolvePython(), ['-c', code], {
      cwd,
      env: { ...process.env, PYTHONPATH: pythonPath },
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
