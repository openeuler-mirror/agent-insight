import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

import type {
  BenchmarkDatasetLoader,
  JsonValue,
} from '../../../packages/benchmark-protocol/src/contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { resolveAgentInsightDataPath, resolveAgentInsightHomePath } from '../../../src/lib/env'

const execFileAsync = promisify(execFile)
const MAX_DATASET_BYTES = 100 * 1024 * 1024
const MAX_BRIDGE_OUTPUT_BYTES = 256 * 1024 * 1024
const OFFICIAL_VERIFIED_CASE_COUNT = 500

const BridgeOutputSchema = z.object({
  cases: z.array(z.record(z.unknown())),
})

export type OfficialSweBenchDataset = {
  cases: Record<string, unknown>[]
  caseCount: number
  sourceSha256: `sha256:${string}`
}

type OfficialLoaderOptions = {
  datasetPath?: string
  pythonPath?: string
  bridgePath?: string
}

function resolveConfiguredPath(value: string): string {
  const expanded = value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value
  return path.resolve(expanded)
}

function defaultPythonPath(): string {
  return resolveAgentInsightHomePath(
    'vendor',
    'SWE-bench',
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
}

async function assertRegularFile(filePath: string, label: string): Promise<fs.Stats> {
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) throw new Error('not a file')
    return stat
  } catch {
    throw new BenchmarkProtocolError(
      'SWE_OFFICIAL_RUNTIME_MISSING',
      `${label}不存在或不是普通文件：${filePath}`,
      500,
    )
  }
}

async function sha256File(filePath: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

export function resolveOfficialSweBenchPaths(options: OfficialLoaderOptions = {}) {
  return {
    datasetPath: resolveConfiguredPath(
      options.datasetPath
        || process.env.SWE_BENCH_DATASET_PATH
        || resolveAgentInsightDataPath('imports', 'swe-bench-verified', 'test.parquet'),
    ),
    pythonPath: resolveConfiguredPath(
      options.pythonPath || process.env.SWE_BENCH_PYTHON || defaultPythonPath(),
    ),
    bridgePath: resolveConfiguredPath(
      options.bridgePath
        || path.join(process.cwd(), 'scripts', 'benchmark', 'load_official_swebench_dataset.py'),
    ),
  }
}

export async function loadOfficialSweBenchVerifiedDataset(
  options: OfficialLoaderOptions = {},
): Promise<OfficialSweBenchDataset> {
  const paths = resolveOfficialSweBenchPaths(options)
  const datasetStat = await assertRegularFile(paths.datasetPath, 'SWE-bench Verified 数据集')
  await assertRegularFile(paths.pythonPath, 'SWE-bench 官方 Python 环境')
  await assertRegularFile(paths.bridgePath, 'SWE-bench 官方 loader 桥接脚本')

  if (path.extname(paths.datasetPath).toLowerCase() !== '.parquet') {
    throw new BenchmarkProtocolError(
      'SWE_DATASET_FORMAT_INVALID',
      'SWE-bench Verified 数据集必须是本地 Parquet 文件',
      400,
    )
  }
  if (datasetStat.size > MAX_DATASET_BYTES) {
    throw new BenchmarkProtocolError(
      'SWE_DATASET_TOO_LARGE',
      `SWE-bench 数据集文件超过 ${MAX_DATASET_BYTES} 字节限制`,
      400,
    )
  }

  let stdout: string
  try {
    const result = await execFileAsync(paths.pythonPath, [paths.bridgePath, paths.datasetPath], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: MAX_BRIDGE_OUTPUT_BYTES,
      env: {
        ...process.env,
        HF_DATASETS_OFFLINE: '1',
        HF_HUB_OFFLINE: '1',
      },
    })
    stdout = result.stdout
  } catch (error) {
    throw new BenchmarkProtocolError(
      'SWE_OFFICIAL_LOADER_FAILED',
      `SWE-bench 官方 loader 执行失败：${error instanceof Error ? error.message : String(error)}`,
      500,
    )
  }

  let output: z.infer<typeof BridgeOutputSchema>
  try {
    output = BridgeOutputSchema.parse(JSON.parse(stdout))
  } catch (error) {
    throw new BenchmarkProtocolError(
      'SWE_OFFICIAL_OUTPUT_INVALID',
      `SWE-bench 官方 loader 输出不合法：${error instanceof Error ? error.message : String(error)}`,
      500,
    )
  }

  const instanceIds = output.cases.map((item) => item.instance_id)
  const uniqueIds = new Set(instanceIds)
  if (
    output.cases.length !== OFFICIAL_VERIFIED_CASE_COUNT
    || uniqueIds.size !== OFFICIAL_VERIFIED_CASE_COUNT
    || instanceIds.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new BenchmarkProtocolError(
      'SWE_VERIFIED_PROFILE_INVALID',
      `SWE-bench Verified 必须包含 ${OFFICIAL_VERIFIED_CASE_COUNT} 个唯一 Case，实际为 ${output.cases.length} 条/${uniqueIds.size} 个唯一标识`,
      400,
    )
  }

  return {
    cases: output.cases,
    caseCount: output.cases.length,
    sourceSha256: await sha256File(paths.datasetPath),
  }
}

export const sweBenchDatasetLoader: BenchmarkDatasetLoader = {
  async *loadCases(sourcePath: string) {
    const loaded = await loadOfficialSweBenchVerifiedDataset({ datasetPath: sourcePath })
    for (const rawCase of loaded.cases) yield rawCase as JsonValue
  },
}

export async function importOfficialSweBenchVerifiedDataset(input: {
  user: string
  name: string
  description?: string
  datasetPath?: string
  pythonPath?: string
}) {
  const loaded = await loadOfficialSweBenchVerifiedDataset(input)
  const { importBenchmarkDataset } = await import('../../../src/lib/benchmark/dataset-service')
  return importBenchmarkDataset({
    user: input.user,
    name: input.name,
    description: input.description,
    adapterKey: 'swe-bench',
    source: {
      kind: 'official-swebench-local-parquet',
      loader: 'swebench.harness.utils.load_swebench_dataset',
      sha256: loaded.sourceSha256,
      caseCount: loaded.caseCount,
    } satisfies Record<string, JsonValue>,
    cases: loaded.cases,
  })
}
