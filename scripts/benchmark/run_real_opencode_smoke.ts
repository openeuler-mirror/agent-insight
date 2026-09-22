import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { deviceCredentialHash } from '../../packages/benchmark-protocol/src/executor-contracts'

const require = createRequire(import.meta.url)
const { createBenchmarkExecutor } = require('../../services/executor/src/index.cjs')
const { runExperimentCase } = require('../reliability-client.cjs')

const { getAgentInsightHome } = require('../agent-insight-home.cjs')
const agentInsightHome = getAgentInsightHome()
const databasePath = process.env.BENCHMARK_SMOKE_DATABASE_PATH
  || path.join(agentInsightHome, 'data', 'witty_insight.db')
const platformOrigin = (process.env.BENCHMARK_SMOKE_PLATFORM_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/, '')
const model = process.env.BENCHMARK_SMOKE_MODEL || 'deepseek/deepseek-v4-flash'
const agent = process.env.BENCHMARK_SMOKE_AGENT || 'build'
const caseExternalId = process.env.BENCHMARK_SMOKE_CASE || 'pallets__flask-5014'
const timeoutSeconds = Number(process.env.BENCHMARK_SMOKE_TIMEOUT_SECONDS || 600)
const user = process.env.BENCHMARK_SMOKE_USER || 'admin'

process.env.AGENT_INSIGHT_HOME = agentInsightHome
process.env.DATABASE_URL = `file:${databasePath}`
process.env.PATH = `/usr/local/bin:${process.env.PATH || ''}`

function assertOk(response: Response, body: unknown, operation: string) {
  if (!response.ok) {
    throw new Error(`${operation} failed (${response.status}): ${JSON.stringify(body)}`)
  }
}

async function main() {
  if (!fs.existsSync(databasePath)) throw new Error(`数据库不存在：${databasePath}`)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) throw new Error('timeoutSeconds 不合法')

  const [{ prisma }, { importOfficialSweBenchVerifiedDataset }] = await Promise.all([
    import('../../src/lib/storage/prisma'),
    import('../../benchmarks/swe-bench/dataset'),
  ])

  const suffix = `${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const clientId = `cli_benchmark_smoke_${suffix}`
  const deviceCredential = `dc_${randomBytes(32).toString('base64url')}`
  const executorBaseDir = path.join(agentInsightHome, 'client', 'benchmark-smoke', suffix)
  let terminal = false
  let executor: ReturnType<typeof createBenchmarkExecutor> | null = null
  const commandLoopAbort = new AbortController()
  let commandLoop: Promise<void> | null = null

  try {
    const imported = await importOfficialSweBenchVerifiedDataset({
      user,
      name: 'SWE-bench Verified (official local)',
      description: '由官方 SWE-bench loader 从本地 Verified Parquet 导入。',
    })
    const datasetCase = await prisma.benchmarkDatasetCase.findFirst({
      where: { datasetId: imported.id, externalCaseId: caseExternalId },
    })
    if (!datasetCase) throw new Error(`数据集中不存在 Case：${caseExternalId}`)

    executor = createBenchmarkExecutor({
      clientId,
      deviceCredential,
      insightBaseUrl: platformOrigin,
      baseDir: executorBaseDir,
      runAgent: (payload: Record<string, unknown>) => runExperimentCase({
        clientId,
        workspaceBase: path.join(executorBaseDir, 'fallback-workspace'),
      }, payload),
      logError: (...args: unknown[]) => console.error('[benchmark-smoke executor]', ...args),
    })
    await prisma.reliabilityClient.create({
      data: {
        id: `rclient_${randomUUID().replaceAll('-', '')}`,
        clientId,
        user,
        name: `OpenCode benchmark smoke ${caseExternalId}`,
        status: 'online',
        serviceHealth: 'healthy',
        lastSeenAt: new Date(),
        capabilitiesJson: JSON.stringify({
          platforms: [{
            id: 'opencode',
            models: [model],
            agents: [agent],
            runExperimentCase: { version: 2, returnsTraceId: true },
            actions: ['RUN_EXPERIMENT_CASE', 'RUN_BENCHMARK_CASE'],
          }],
          components: {
            'git-workspace/v1': { ready: true },
            'agent-runtime/opencode/v1': { ready: true },
            'git-patch/v1': { ready: true },
          },
        }),
      },
    })
    await prisma.reliabilityClientCredential.create({
      data: {
        id: `rcred_${randomUUID().replaceAll('-', '')}`,
        clientId,
        credentialHash: deviceCredentialHash(deviceCredential),
      },
    })
    const clientHeaders = {
      authorization: `Bearer ${deviceCredential}`,
      'x-agent-insight-client-id': clientId,
      'content-type': 'application/json',
    }
    const sendCommandStatus = async (
      commandId: string,
      status: string,
      extra: Record<string, unknown> = {},
    ) => {
      const response = await fetch(
        `${platformOrigin}/api/reliability/client/v1/commands/${encodeURIComponent(commandId)}/status`,
        {
          method: 'POST',
          headers: clientHeaders,
          body: JSON.stringify({ status, occurredAt: new Date().toISOString(), ...extra }),
          signal: commandLoopAbort.signal,
        },
      )
      const body = await response.json().catch(() => ({}))
      assertOk(response, body, `command status ${status}`)
    }
    commandLoop = (async () => {
      while (!commandLoopAbort.signal.aborted) {
        const response = await fetch(
          `${platformOrigin}/api/reliability/client/v1/commands/next?waitSeconds=5`,
          { headers: clientHeaders, signal: commandLoopAbort.signal },
        )
        if (response.status === 204) continue
        const frame = await response.json() as {
          commandId: string
          action: string
          payload: { request?: Record<string, unknown> }
        }
        assertOk(response, frame, 'claim command')
        await sendCommandStatus(frame.commandId, 'RECEIVED')
        if (frame.action !== 'RUN_BENCHMARK_CASE' || !frame.payload.request) {
          await sendCommandStatus(frame.commandId, 'FAILED', {
            error: { code: 'ACTION_NOT_ALLOWED', message: frame.action },
          })
          continue
        }
        try {
          const result = await executor!.accept(frame.payload.request)
          await sendCommandStatus(frame.commandId, 'RUNNING', { result: { state: 'ACCEPTED' } })
          await sendCommandStatus(frame.commandId, 'SUCCEEDED', { result })
        } catch (error) {
          await sendCommandStatus(frame.commandId, 'FAILED', {
            error: {
              code: (error as { code?: string }).code || 'BENCHMARK_ACCEPT_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
    })().catch((error) => {
      if (!commandLoopAbort.signal.aborted) throw error
    })

    const createResponse = await fetch(`${platformOrigin}/api/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user,
        scope: 'benchmark',
        name: `OpenCode SWE-bench smoke: ${caseExternalId}`,
        agentName: agent,
        benchmark: {
          datasetId: imported.id,
          caseSelection: { mode: 'explicit', caseIds: [datasetCase.id] },
          executionTarget: { clientId },
          runConfig: {
            platform: 'opencode',
            agent,
            model,
            agentTimeoutSeconds: timeoutSeconds,
            maxParallelAgentCases: 1,
          },
        },
      }),
    })
    const created = await createResponse.json() as Record<string, unknown>
    assertOk(createResponse, created, 'create experiment')
    const experimentId = String(created.id)

    const runResponse = await fetch(
      `${platformOrigin}/api/experiments/${encodeURIComponent(experimentId)}/run?user=${encodeURIComponent(user)}`,
      { method: 'POST' },
    )
    const started = await runResponse.json() as Record<string, unknown>
    assertOk(runResponse, started, 'start experiment')
    const runId = String(started.runId)
    console.error(`[benchmark-smoke] experiment=${experimentId} run=${runId} case=${caseExternalId}`)

    const deadline = Date.now() + (timeoutSeconds + 180) * 1000
    let lastStatus = ''
    let run = null
    while (Date.now() < deadline) {
      run = await prisma.benchmarkCaseRun.findUnique({ where: { id: runId } })
      if (!run) throw new Error(`Run 不存在：${runId}`)
      if (run.status !== lastStatus) {
        lastStatus = run.status
        console.error(`[benchmark-smoke] status=${run.status}`)
      }
      if (['submitted', 'execution_failed', 'dispatch_failed'].includes(run.status)) break
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    if (!run || !['submitted', 'execution_failed', 'dispatch_failed'].includes(run.status)) {
      throw new Error(`等待 Run 终态超时：${runId}`)
    }
    terminal = true

    const facts = run.runFactsJson ? JSON.parse(run.runFactsJson) as Record<string, unknown> : {}
    const traceId = typeof facts.traceId === 'string' ? facts.traceId : null
    const artifact = await prisma.benchmarkArtifact.findFirst({ where: { runId, name: 'model.patch' } })
    const artifactPath = artifact ? path.join(agentInsightHome, 'data', artifact.storagePath) : null
    const patch = artifactPath && fs.existsSync(artifactPath) ? await fsp.readFile(artifactPath, 'utf8') : null

    let sessionExportPath: string | null = null
    let sessionExportError: string | null = null
    if (traceId) {
      const exported = spawnSync('/usr/local/bin/opencode', ['export', traceId, '--pure'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      if (exported.status === 0 && exported.stdout.trim()) {
        try {
          const jsonStart = exported.stdout.indexOf('{')
          if (jsonStart < 0) throw new Error('OpenCode Session 导出未返回 JSON')
          const sessionJson = JSON.stringify(JSON.parse(exported.stdout.slice(jsonStart)), null, 2)
          const outputDir = path.join(agentInsightHome, 'data', 'benchmark-smoke', runId)
          await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 })
          sessionExportPath = path.join(outputDir, 'opencode-session.json')
          await fsp.writeFile(sessionExportPath, sessionJson, { mode: 0o600 })
        } catch (error) {
          sessionExportError = error instanceof Error ? error.message : String(error)
          console.error(`[benchmark-smoke] session export skipped: ${sessionExportError}`)
        }
      } else if (exported.status !== 0) {
        sessionExportError = String(exported.stderr || `opencode export exited with ${exported.status}`).trim()
      }
    }

    const session = traceId
      ? await prisma.session.findUnique({ where: { taskId: traceId } }).catch(() => null)
      : null
    const execution = traceId
      ? await prisma.execution.findFirst({
          where: { OR: [{ taskId: traceId }, { agentSessionId: traceId }] },
          orderBy: { timestamp: 'desc' },
        }).catch(() => null)
      : null

    console.log(JSON.stringify({
      experimentId,
      runId,
      caseExternalId,
      model,
      status: run.status,
      failure: run.failureCode ? { code: run.failureCode, message: run.failureMessage } : null,
      traceId,
      exitCode: facts.exitCode ?? null,
      artifactId: artifact?.id ?? null,
      artifactPath,
      patch,
      sessionExportPath,
      sessionExportError,
      ingestedSession: session ? { id: session.id, taskId: session.taskId, endTime: session.endTime } : null,
      ingestedExecution: execution ? { id: execution.id, taskId: execution.taskId } : null,
      executorStateDir: path.join(executorBaseDir, 'benchmark-runs', runId),
    }, null, 2))
  } finally {
    commandLoopAbort.abort()
    await commandLoop?.catch(() => undefined)
    if (executor) await executor.close().catch(() => undefined)
    await prisma.reliabilityClient.updateMany({
      where: { clientId },
      data: {
        status: 'offline',
        serviceHealth: terminal ? 'stopped' : 'unhealthy',
      },
    }).catch(() => undefined)
    await prisma.reliabilityClientCredential.updateMany({
      where: { clientId, revokedAt: null },
      data: { revokedAt: new Date() },
    }).catch(() => undefined)
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
