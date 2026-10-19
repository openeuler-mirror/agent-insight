import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { type BenchmarkDatasetLoader, type JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import type { ZsoftCase } from '../adapter'
import { fingerprintSource } from '../evaluator/source-identity.cjs'

const execFileAsync = promisify(execFile)

export async function resolveZsoftRoot(sourcePath: string) {
  for (const root of [sourcePath, path.join(sourcePath, 'benchmarks/vulnerability/zsoft-l1')]) {
    try { if ((await fs.stat(path.join(root, 'tasks'))).isDirectory()) return root } catch { /* Try the repository root next. */ }
  }
  throw new BenchmarkProtocolError('ZSOFT_DATASET_DIRECTORY_INVALID', '请指定包含 tasks/ 的官方 ZSoft L1 目录或官方仓库根目录', 400)
}

export async function sourceTaskDigest(root: string, taskId: string, manifest: JsonValue) {
  const files: Record<string, string> = {}
  const visit = async (relative: string) => {
    const target = path.join(root, relative)
    const stat = await fs.lstat(target)
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(target)).sort()) await visit(`${relative}/${name}`)
    } else if (stat.isFile()) {
      files[relative] = `sha256:${createHash('sha256').update(await fs.readFile(target)).digest('hex')}`
    } else throw new BenchmarkProtocolError('ZSOFT_DATASET_FILE_INVALID', '官方题目资料必须是普通文件或目录', 400)
  }
  await visit(`tasks/${taskId}/public`)
  if (!files[`tasks/${taskId}/public/README.md`]) throw new BenchmarkProtocolError('ZSOFT_DATASET_PUBLIC_MISSING', `题目 ${taskId} 缺少 public/README.md`, 400)
  return fingerprintSource({ manifest, publicFiles: files })
}

export async function loadZsoftCases(sourcePath: string): Promise<ZsoftCase[]> {
  const root = await resolveZsoftRoot(sourcePath)
  let revision: string | undefined
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { timeout: 10_000 })
    const gitRoot = await fs.realpath(stdout.trim())
    // A copied directory inside an unrelated checkout is not that checkout's revision.
    if (gitRoot === await fs.realpath(sourcePath) || gitRoot === await fs.realpath(root)) {
      const result = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 10_000 })
      if (/^[a-f0-9]{40}$/.test(result.stdout.trim())) revision = result.stdout.trim()
    }
  } catch { /* Offline extracted directories are identified by content. */ }
  const cases: ZsoftCase[] = []
  for (const entry of (await fs.readdir(path.join(root, 'tasks'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskId = entry.name
    if (!entry.isDirectory() || taskId.startsWith('sample-')) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) throw new BenchmarkProtocolError('ZSOFT_DATASET_TASK_INVALID', '官方目录中存在非法题目 ID', 400)
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'tasks', taskId, 'task.json'), 'utf8'))
    if (manifest.task_id !== taskId || !Array.isArray(manifest.tags)) throw new BenchmarkProtocolError('ZSOFT_DATASET_TASK_INVALID', `题目 ${taskId} 元数据不一致`, 400)
    const tags = [...manifest.tags]
    const track = tags.includes('kernel') || taskId.startsWith('linux-rxrpc-') ? 'kernel' : 'userspace'
    if (tags.includes(track === 'kernel' ? 'userspace' : 'kernel')) throw new BenchmarkProtocolError('ZSOFT_DATASET_TASK_INVALID', `题目 ${taskId} 轨道冲突`, 400)
    if (!tags.includes(track)) tags.push(track)
    cases.push({
      public: { taskId, title: manifest.title, description: manifest.description,
        submissionKind: track === 'kernel' ? 'c' : tags.includes('python') ? 'python' : tags.includes('c') ? 'c' : 'binary',
        maxBytes: manifest.submission?.max_bytes, tags },
      private: { ...(revision ? { revision } : {}), sourceTaskDigest: await sourceTaskDigest(root, taskId, manifest) },
    })
  }
  if (!cases.length) throw new BenchmarkProtocolError('DATASET_EMPTY', '官方目录中没有正式 ZSoft 题目', 400)
  return cases
}

export const zsoftDatasetLoader: BenchmarkDatasetLoader = {
  async *loadCases(sourcePath) { for (const item of await loadZsoftCases(sourcePath)) yield item as JsonValue },
}
