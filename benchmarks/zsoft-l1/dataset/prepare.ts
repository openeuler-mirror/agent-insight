import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { canonicalJson, type BenchmarkDatasetPreparer, type JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { resolveAgentInsightHomePath } from '../../../src/lib/env'
import { loadZsoftCases, resolveZsoftRoot } from './index'
import { loadProjectConfig } from '../../../packages/project-config/index.cjs'
import { runtimePackageRoot } from '../../../src/lib/runtime/package-root'

const execFileAsync = promisify(execFile)
export const ZSOFT_OFFICIAL_REPOSITORY = 'https://gitcode.com/linmalin/muyuan-sec.git'
export const ZSOFT_OFFICIAL_REVISION = '7f7d675eff19eec27745ddcd24b1efaf398bb753'

export async function prepareZsoftSource(options: { source?: string; revision?: string; cacheRoot?: string } = {}) {
  const config = loadProjectConfig('platform', { root: runtimePackageRoot() }).benchmarks['zsoft-l1'].dataset
  const source = (options.source ?? config.source)?.trim() || ZSOFT_OFFICIAL_REPOSITORY
  const revision = (options.revision ?? config.revision)?.trim() || ZSOFT_OFFICIAL_REVISION
  if (!/^https?:\/\//i.test(source)) {
    const directory = path.resolve(source.startsWith('~/') ? path.join(os.homedir(), source.slice(2)) : source)
    await resolveZsoftRoot(directory)
    return directory
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('benchmarks.zsoft-l1.dataset.revision 必须是完整的40位官方提交 ID')
  const url = new URL(source)
  if (url.username || url.password) throw new Error('ZSoft 官方数据来源应为无需认证的 HTTP(S) Git 仓库')
  const cacheRoot = options.cacheRoot || resolveAgentInsightHomePath('benchmark-assets', 'zsoft-l1')
  const key = createHash('sha256').update(`${source}\n${revision}\nuserspace-kernel/v1`).digest('hex')
  const cache = path.join(cacheRoot, key)
  const digestCases = async (directory: string) => createHash('sha256').update(canonicalJson(await loadZsoftCases(directory) as JsonValue)).digest('hex')
  try {
    const marker = JSON.parse(await fs.readFile(path.join(cache, '.agent-insight-source.json'), 'utf8'))
    if (marker.source === source && marker.revision === revision && marker.digest === await digestCases(cache)) return cache
    throw new Error('ZSoft 数据缓存与冻结来源不一致，请使用新的缓存目录重新准备')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try { await fs.stat(cache); throw new Error('ZSoft 数据缓存不完整，请使用新的缓存目录重新准备') }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing }
  }
  await fs.mkdir(cacheRoot, { recursive: true })
  const staging = path.join(cacheRoot, `.download-${randomUUID()}`)
  await fs.mkdir(staging)
  const git = (args: string[]) => execFileAsync('git', ['-C', staging, ...args], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  try {
    process.stdout.write(`获取官方 ZSoft 数据：${source} @ ${revision}\n`)
    await git(['init', '--quiet'])
    await git(['fetch', '--depth', '1', '--', source, revision])
    await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'])
    const head = await git(['rev-parse', 'HEAD'])
    if (head.stdout.trim() !== revision) throw new Error('ZSoft 官方提交与固定版本不一致')
    const digest = await digestCases(staging)
    await fs.writeFile(path.join(staging, '.agent-insight-source.json'), JSON.stringify({ source, revision, digest }))
    try { await fs.rename(staging, cache) }
    catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error
      const winner = JSON.parse(await fs.readFile(path.join(cache, '.agent-insight-source.json'), 'utf8'))
      if (winner.source !== source || winner.revision !== revision || winner.digest !== digest) throw error
    }
    return cache
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
}

export const zsoftDatasetPreparer: BenchmarkDatasetPreparer = {
  profileKey: 'l1',
  async prepareSource() { return { sourcePath: await prepareZsoftSource(), name: 'ZSoft L1' } },
}
