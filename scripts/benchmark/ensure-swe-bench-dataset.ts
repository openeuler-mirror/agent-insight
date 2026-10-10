import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  getAgentInsightDataDir,
  getAgentInsightHome,
  loadAgentInsightEnv,
} from '../../src/lib/env'

const execFileAsync = promisify(execFile)

export const SWE_BENCH_SOURCE_COMMIT = '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e'
export const SWE_BENCH_SOURCE_ARCHIVE_SHA256 = 'd06181d5365b51fc7ff490171581b9ee87d77e19b3a739a8d574bf25d9ef9479'
export const SWE_BENCH_DATASET_REVISION = '78f471bf655a3137b2e8a75af1501690ec009ec3'
export const SWE_BENCH_DATASET_SHA256 = '030cfd7f2a704c4c0226e7f104c725a3b41230b1d3517f9c915ad7ea5be3fa25'
export const SWE_BENCH_VERIFIED_CASE_COUNT = 500

const DEFAULT_SOURCE_ARCHIVE_URL = `https://codeload.github.com/swe-bench/SWE-bench/tar.gz/${SWE_BENCH_SOURCE_COMMIT}`
const DEFAULT_DATASET_URL = `https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified/resolve/${SWE_BENCH_DATASET_REVISION}/data/test-00000-of-00001.parquet?download=true`

export type SweBenchProvisionPaths = {
  vendorRoot: string
  sourceArchivePath: string
  sourcePath: string
  pythonPath: string
  datasetPath: string
  sourceArchiveSource: string
  datasetSource: string
  customPythonPath: boolean
}

function expandConfiguredPath(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  if (value.startsWith('$HOME/')) return path.join(os.homedir(), value.slice(6))
  if (value.startsWith('${HOME}/')) return path.join(os.homedir(), value.slice(8))
  return path.resolve(value)
}

function isRemoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source)
}

function resolveSource(value: string): string {
  if (isRemoteSource(value)) {
    new URL(value)
    return value
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    throw new Error('SWE-bench 来源必须是 HTTP(S) 下载地址或本机文件路径')
  }
  return expandConfiguredPath(value)
}

export function resolveSweBenchProvisionPaths(): SweBenchProvisionPaths {
  const vendorRoot = path.join(getAgentInsightHome(), 'vendor', 'SWE-bench')
  const customPythonPath = Boolean(process.env.SWE_BENCH_PYTHON?.trim())
  // 新变量显式留空时使用官方来源，不再回退到旧变量。
  const datasetSource = resolveSource((process.env.SWE_BENCH_DATASET_SOURCE
    ?? (process.env.SWE_BENCH_DATASET_PATH?.trim() || process.env.SWE_BENCH_DATASET_URL))?.trim()
    || DEFAULT_DATASET_URL)
  const sourceArchiveSource = resolveSource((process.env.SWE_BENCH_SOURCE_ARCHIVE_SOURCE
    ?? process.env.SWE_BENCH_SOURCE_ARCHIVE_URL)?.trim() || DEFAULT_SOURCE_ARCHIVE_URL)
  return {
    vendorRoot,
    sourceArchivePath: isRemoteSource(sourceArchiveSource)
      ? path.join(vendorRoot, 'downloads', `${SWE_BENCH_SOURCE_COMMIT}.tar.gz`)
      : sourceArchiveSource,
    sourcePath: path.join(vendorRoot, `source-${SWE_BENCH_SOURCE_COMMIT}`),
    pythonPath: customPythonPath
      ? expandConfiguredPath(process.env.SWE_BENCH_PYTHON!.trim())
      : path.join(vendorRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    datasetPath: isRemoteSource(datasetSource)
      ? path.join(getAgentInsightDataDir(), 'imports', 'swe-bench-verified', 'test.parquet')
      : datasetSource,
    sourceArchiveSource,
    datasetSource,
    customPythonPath,
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

async function run(command: string, args: string[], timeout = 600_000): Promise<void> {
  try {
    await execFileAsync(command, args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    })
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr || '').trim()
      : ''
    throw new Error(`${command} 执行失败${detail ? `：${detail}` : ''}`, { cause: error })
  }
}

async function ensureCommand(command: string, versionArgs: string[]): Promise<void> {
  try {
    await execFileAsync(command, versionArgs, { timeout: 10_000, maxBuffer: 1024 * 1024 })
  } catch (error) {
    throw new Error(`自动准备 SWE-bench 需要可执行命令：${command}`, { cause: error })
  }
}

export async function ensurePinnedFile(input: {
  label: string
  source: string
  sha256: string
  targetPath: string
}): Promise<void> {
  const remote = isRemoteSource(input.source)
  const filePath = remote ? input.targetPath : input.source
  if (await isRegularFile(filePath)) {
    const actual = await sha256File(filePath)
    if (actual === input.sha256) {
      process.stdout.write(`复用已校验的${input.label}：${filePath}\n`)
      return
    }
    if (!remote) {
      throw new Error(`${input.label}哈希不匹配，拒绝覆盖本机文件：${filePath}`)
    }
  }
  if (!remote) {
    throw new Error(`${input.label}本机文件不存在或不是普通文件：${filePath}`)
  }

  await ensureCommand('curl', ['--version'])
  await fs.promises.mkdir(path.dirname(input.targetPath), { recursive: true })
  const temporaryPath = `${input.targetPath}.download-${process.pid}`
  await fs.promises.rm(temporaryPath, { force: true })
  process.stdout.write(`下载${input.label}：${input.source}\n`)
  try {
    await run('curl', [
      '--fail',
      '--location',
      '--proto', '=http,https',
      '--proto-redir', '=http,https',
      '--retry', '5',
      '--retry-delay', '2',
      '--connect-timeout', '20',
      '--max-time', '600',
      input.source,
      '--output', temporaryPath,
    ])
    const actual = await sha256File(temporaryPath)
    if (actual !== input.sha256) {
      throw new Error(`${input.label}哈希校验失败：期望 ${input.sha256}，实际 ${actual}`)
    }
    await fs.promises.rename(temporaryPath, input.targetPath)
  } finally {
    await fs.promises.rm(temporaryPath, { force: true })
  }
}

async function pythonCanLoadSweBench(pythonPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(pythonPath)
    if (!stat.isFile()) return false
    await execFileAsync(pythonPath, [
      '-c',
      'from swebench.harness.utils import load_swebench_dataset',
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    return true
  } catch {
    return false
  }
}

async function ensureOfficialSource(paths: SweBenchProvisionPaths): Promise<void> {
  const markerPath = path.join(paths.sourcePath, '.agent-insight-source.json')
  try {
    const marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as {
      commit?: unknown
      archiveSha256?: unknown
    }
    if (
      marker.commit === SWE_BENCH_SOURCE_COMMIT
      && marker.archiveSha256 === SWE_BENCH_SOURCE_ARCHIVE_SHA256
      && await isRegularFile(path.join(paths.sourcePath, 'pyproject.toml'))
    ) return
  } catch {
    // The managed source cache is rebuilt below when absent or incomplete.
  }

  await ensurePinnedFile({
    label: 'SWE-bench 官方源码',
    source: paths.sourceArchiveSource,
    sha256: SWE_BENCH_SOURCE_ARCHIVE_SHA256,
    targetPath: paths.sourceArchivePath,
  })
  await ensureCommand('tar', ['--version'])
  const stagingPath = `${paths.sourcePath}.extract-${process.pid}`
  await fs.promises.rm(stagingPath, { recursive: true, force: true })
  await fs.promises.mkdir(stagingPath, { recursive: true })
  try {
    await run('tar', [
      '-xzf', paths.sourceArchivePath,
      '--strip-components=1',
      '-C', stagingPath,
    ])
    if (!(await isRegularFile(path.join(stagingPath, 'pyproject.toml')))) {
      throw new Error('SWE-bench 官方源码归档缺少 pyproject.toml')
    }
    await fs.promises.writeFile(
      path.join(stagingPath, '.agent-insight-source.json'),
      `${JSON.stringify({
        commit: SWE_BENCH_SOURCE_COMMIT,
        archiveSha256: SWE_BENCH_SOURCE_ARCHIVE_SHA256,
      }, null, 2)}\n`,
      'utf8',
    )
    await fs.promises.rm(paths.sourcePath, { recursive: true, force: true })
    await fs.promises.rename(stagingPath, paths.sourcePath)
  } finally {
    await fs.promises.rm(stagingPath, { recursive: true, force: true })
  }
}

async function ensureOfficialPython(paths: SweBenchProvisionPaths): Promise<void> {
  if (await pythonCanLoadSweBench(paths.pythonPath)) {
    process.stdout.write(`复用 SWE-bench Python 环境：${paths.pythonPath}\n`)
    return
  }
  if (paths.customPythonPath) {
    throw new Error(`SWE_BENCH_PYTHON 无法加载官方 SWE-bench：${paths.pythonPath}`)
  }

  await ensureCommand('python3', ['--version'])
  await ensureOfficialSource(paths)
  const venvPath = path.dirname(path.dirname(paths.pythonPath))
  await fs.promises.rm(venvPath, { recursive: true, force: true })
  await fs.promises.mkdir(path.dirname(venvPath), { recursive: true })
  process.stdout.write(`创建 SWE-bench Python 环境：${venvPath}\n`)
  try {
    try {
      await run('python3', ['-m', 'venv', venvPath], 120_000)
    } catch (error) {
      throw new Error('无法创建 Python 虚拟环境，可能缺少 python3-venv，请安装后重试。', { cause: error })
    }
    await run(paths.pythonPath, [
      '-m', 'pip', 'install',
      '--no-cache-dir',
      '--retries', '2',
      '--timeout', '20',
      paths.sourcePath,
    ])
    if (!(await pythonCanLoadSweBench(paths.pythonPath))) {
      throw new Error('SWE-bench Python 环境安装完成后仍无法加载官方 Loader')
    }
  } catch (error) {
    await fs.promises.rm(venvPath, { recursive: true, force: true })
    throw error
  }
}

export async function ensureSweBenchDataset(): Promise<{
  action: 'already-installed' | 'imported'
  id: string
  caseCount: number
}> {
  const [{ findInstalledSystemBenchmarkDataset, installBenchmarkDataset }, { prisma }] = await Promise.all([
    import('../../src/lib/benchmark/dataset-admin-service'),
    import('../../src/lib/storage/prisma'),
  ])
  try {
    const installed = await findInstalledSystemBenchmarkDataset({
      benchmarkKey: 'swe-bench',
      profileKey: 'verified',
    })
    if (installed) {
      return { action: 'already-installed', id: installed.id, caseCount: installed.caseCount }
    }

    const paths = resolveSweBenchProvisionPaths()
    await ensurePinnedFile({
      label: 'SWE-bench Verified 数据集',
      source: paths.datasetSource,
      sha256: SWE_BENCH_DATASET_SHA256,
      targetPath: paths.datasetPath,
    })
    await ensureOfficialPython(paths)
    process.env.SWE_BENCH_DATASET_PATH = paths.datasetPath
    process.env.SWE_BENCH_PYTHON = paths.pythonPath

    const imported = await installBenchmarkDataset({
      benchmarkKey: 'swe-bench',
      profileKey: 'verified',
      sourcePath: paths.datasetPath,
      name: 'SWE-bench Verified',
    })
    if (imported.caseCount !== SWE_BENCH_VERIFIED_CASE_COUNT) {
      throw new Error(`SWE-bench Verified 导入后应有 ${SWE_BENCH_VERIFIED_CASE_COUNT} 个 Case，实际为 ${imported.caseCount}`)
    }
    return { action: 'imported', id: imported.id, caseCount: imported.caseCount }
  } finally {
    await prisma.$disconnect()
  }
}

async function main(): Promise<void> {
  loadAgentInsightEnv()
  const result = await ensureSweBenchDataset()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
