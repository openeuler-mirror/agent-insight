import fs from 'node:fs'
import path from 'node:path'

import { resolveAgentInsightDataPath } from '@/lib/env'
import {
  defaultEnvelope,
  isRasCapabilityPlatformId,
  type RasCapabilityConfigEnvelope,
  type RasCapabilityPlatformId,
} from '@/lib/ingest/ras/capability-config'

export type CapabilityConfigFile = {
  platforms: Partial<Record<RasCapabilityPlatformId, RasCapabilityConfigEnvelope>>
}

function sanitizeUserKey(user: string): string {
  return user.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 128) || 'anonymous'
}

let testBaseDir: string | undefined

/** 测试注入：覆盖 capability 落盘根目录；传 undefined 恢复默认。 */
export function resetCapabilityConfigStoreForTests(baseDir?: string) {
  testBaseDir = baseDir
}

export function capabilityConfigFilePath(
  user: string,
  baseDir?: string,
): string {
  const root = baseDir ?? testBaseDir ?? resolveAgentInsightDataPath('ras-capability-configs')
  return path.join(root, `${sanitizeUserKey(user)}.json`)
}

export function readCapabilityConfigFile(
  user: string,
  baseDir?: string,
): CapabilityConfigFile {
  const file = capabilityConfigFilePath(user, baseDir)
  try {
    if (!fs.existsSync(file)) return { platforms: {} }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !raw.platforms) return { platforms: {} }
    const platforms: CapabilityConfigFile['platforms'] = {}
    for (const [key, value] of Object.entries(raw.platforms as Record<string, unknown>)) {
      if (!isRasCapabilityPlatformId(key)) continue
      if (!value || typeof value !== 'object') continue
      platforms[key] = value as RasCapabilityConfigEnvelope
    }
    return { platforms }
  } catch {
    return { platforms: {} }
  }
}

export function writeCapabilityConfigFile(
  user: string,
  data: CapabilityConfigFile,
  baseDir?: string,
): void {
  const file = capabilityConfigFilePath(user, baseDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

export function getCapabilityEnvelope(
  user: string,
  platform: RasCapabilityPlatformId,
  baseDir?: string,
): RasCapabilityConfigEnvelope {
  const file = readCapabilityConfigFile(user, baseDir)
  const existing = file.platforms[platform]
  if (existing && existing.platform === platform && existing.config) {
    return {
      ...defaultEnvelope(platform),
      ...existing,
      platform,
      config: existing.config,
    }
  }
  return defaultEnvelope(platform)
}

export function saveCapabilityEnvelope(
  user: string,
  envelope: RasCapabilityConfigEnvelope,
  baseDir?: string,
): RasCapabilityConfigEnvelope {
  const file = readCapabilityConfigFile(user, baseDir)
  file.platforms[envelope.platform] = envelope
  writeCapabilityConfigFile(user, file, baseDir)
  return envelope
}
