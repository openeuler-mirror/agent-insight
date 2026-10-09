import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TEMPORARY_HOME_OWNER_FILE = '.agent-insight-temporary-home.json'
type Owner = { version: 1; hostname: string; ownerPid: number; processGroupId: number | null; createdAt: number }
type Event = { kind: 'scanned' | 'deleted' | 'skipped'; bytes?: number; scannedBytes?: number; reason?: string }

export async function markTemporaryHome(root: string, processGroupId: number | null = null): Promise<void> {
  const owner: Owner = { version: 1, hostname: os.hostname(), ownerPid: process.pid, processGroupId, createdAt: Date.now() }
  const file = await fs.open(path.join(root, TEMPORARY_HOME_OWNER_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { await file.writeFile(JSON.stringify(owner)) } finally { await file.close() }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

async function realDirectory(directory: string): Promise<boolean> {
  try { return (await fs.lstat(directory)).isDirectory() && await fs.realpath(directory) === directory }
  catch { return false }
}

async function readOwner(directory: string, meter: { bytes: number }): Promise<Owner | null> {
  try {
    const file = path.join(directory, TEMPORARY_HOME_OWNER_FILE)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > 4096) return null
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let content: string
    try {
      const buffer = Buffer.alloc(4097)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      meter.bytes += bytesRead
      if (bytesRead > 4096) return null
      content = buffer.subarray(0, bytesRead).toString('utf8')
    } finally { await handle.close() }
    const owner = JSON.parse(content) as Owner
    return owner.version === 1 && typeof owner.hostname === 'string'
      && Number.isSafeInteger(owner.ownerPid) && owner.ownerPid > 0
      && Number.isSafeInteger(owner.processGroupId) && owner.processGroupId! > 0
      && Number.isFinite(owner.createdAt) && owner.createdAt > 0 ? owner : null
  } catch { return null }
}

async function stillUnowned(home: string, owner: Owner, meter: { bytes: number }): Promise<boolean> {
  if (!await realDirectory(home)) return false
  const current = await readOwner(home, meter)
  return current !== null && current.ownerPid === owner.ownerPid
    && current.processGroupId === owner.processGroupId && current.createdAt === owner.createdAt
    && current.hostname === owner.hostname && !alive(owner.ownerPid) && !alive(-owner.processGroupId!)
}

async function* removeContents(directory: string, home: string, owner: Owner, dryRun: boolean, meter: { bytes: number }, emit: (event: Event) => Event, depth = 0): AsyncGenerator<Event> {
  if (depth >= 32 || !await realDirectory(directory)) { yield emit({ kind: 'skipped', reason: 'unsafe-path-or-depth' }); return }
  const entries = await fs.opendir(directory, { bufferSize: 8 })
  for await (const entry of entries) {
    if (directory === home && entry.name === TEMPORARY_HOME_OWNER_FILE) continue
    yield emit({ kind: 'scanned' })
    if (!await realDirectory(directory) || !await stillUnowned(home, owner, meter)) {
      yield emit({ kind: 'skipped', reason: 'owner-active-or-path-changed' }); return
    }
    const target = path.join(directory, entry.name)
    try {
      const stat = await fs.lstat(target)
      if (stat.isDirectory()) {
        yield* removeContents(target, home, owner, dryRun, meter, emit, depth + 1)
        if (!await realDirectory(directory) || !await stillUnowned(home, owner, meter)) { yield emit({ kind: 'skipped', reason: 'owner-active-or-path-changed' }); return }
        if (!dryRun) await fs.rmdir(target)
        yield emit({ kind: dryRun ? 'skipped' : 'deleted', bytes: 0, ...(dryRun ? { reason: 'dry-run' } : {}) })
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        if (!await realDirectory(directory) || !await stillUnowned(home, owner, meter)) { yield emit({ kind: 'skipped', reason: 'owner-active-or-path-changed' }); return }
        if (!dryRun) await fs.unlink(target)
        yield emit({ kind: dryRun ? 'skipped' : 'deleted', bytes: stat.size, ...(dryRun ? { reason: 'dry-run' } : {}) })
      } else yield emit({ kind: 'skipped', reason: 'unsupported-file-type' })
    } catch { yield emit({ kind: 'skipped', reason: 'file-changed-or-unavailable' }) }
  }
}

export async function* cleanupTemporaryHomes(options: {
  root: string; now?: number; retentionMs?: number; dryRun?: boolean
}): AsyncGenerator<Event> {
  const meter = { bytes: 0 }
  const emit = (event: Event): Event => {
    const scannedBytes = meter.bytes
    meter.bytes = 0
    return { ...event, scannedBytes }
  }
  const requestedRoot = path.resolve(options.root)
  let root: string
  try {
    if (!(await fs.lstat(requestedRoot)).isDirectory()) { yield emit({ kind: 'skipped', reason: 'unsafe-root' }); return }
    root = await fs.realpath(requestedRoot)
  } catch { yield emit({ kind: 'skipped', reason: 'root-unavailable' }); return }
  const now = options.now ?? Date.now()
  const retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000
  if (!Number.isFinite(now) || !Number.isFinite(retentionMs) || retentionMs <= 0 || !await realDirectory(root)) {
    yield emit({ kind: 'skipped', reason: 'invalid-root-or-retention' }); return
  }
  const users = await fs.opendir(root, { bufferSize: 8 })
  for await (const user of users) {
    yield emit({ kind: 'scanned' })
    const userPath = path.join(root, user.name)
    if (!user.isDirectory() || !await realDirectory(userPath)) continue
    let homes
    try { homes = await fs.opendir(userPath, { bufferSize: 8 }) }
    catch { yield emit({ kind: 'skipped', reason: 'user-directory-unavailable' }); continue }
    for await (const homeEntry of homes) {
      yield emit({ kind: 'scanned' })
      if (!homeEntry.isDirectory() || !homeEntry.name.startsWith('isolated-home-')) continue
      const home = path.join(userPath, homeEntry.name)
      if (!await realDirectory(home)) { yield emit({ kind: 'skipped', reason: 'unsafe-path' }); continue }
      const owner = await readOwner(home, meter)
      if (!owner || owner.hostname !== os.hostname()) { yield emit({ kind: 'skipped', reason: 'unknown-or-foreign-owner' }); continue }
      if (now - owner.createdAt < retentionMs) { yield emit({ kind: 'skipped', reason: 'not-expired' }); continue }
      if (alive(owner.ownerPid) || alive(-owner.processGroupId!)) { yield emit({ kind: 'skipped', reason: 'owner-active' }); continue }
      try {
        yield* removeContents(home, home, owner, options.dryRun ?? false, meter, emit)
        if (options.dryRun) continue
        if (!await stillUnowned(home, owner, meter)) continue
        const remaining = await fs.opendir(home, { bufferSize: 8 })
        let onlyMarker = true
        for await (const entry of remaining) {
          if (entry.name !== TEMPORARY_HOME_OWNER_FILE) { onlyMarker = false; break }
        }
        if (!onlyMarker || !await stillUnowned(home, owner, meter)) continue
        const marker = path.join(home, TEMPORARY_HOME_OWNER_FILE)
        const markerStat = await fs.lstat(marker)
        await fs.unlink(marker)
        await fs.rmdir(home)
        yield emit({ kind: 'deleted', bytes: markerStat.size })
      } catch { yield emit({ kind: 'skipped', reason: 'home-changed-or-unavailable' }) }
    }
  }
}
