import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  benchmarkDispatchDigest,
  type AgentTaskEnvelope,
} from '../packages/benchmark-protocol/src/contracts'

const executorModule = require('../services/executor/src/index.cjs') as {
  createBenchmarkExecutor(options: Record<string, unknown>): {
    accept(request: Record<string, unknown>): Promise<Record<string, unknown>>
    close(): Promise<void>
    setAgentPlatforms(platforms: string[]): string[]
    readonly agentPlatforms: string[]
  }
}

const clientModule = require('../scripts/reliability-client.cjs') as {
  syncBenchmarkExecutorCapabilities(
    executor: { setAgentPlatforms(platforms: string[]): string[] },
    capabilities: Record<string, unknown>,
  ): string[]
}

function requestFor(runId: string, platform: string) {
  const task: AgentTaskEnvelope = {
    schemaVersion: 'agent-task/v1',
    benchmark: { key: 'swe-bench' },
    context: { runId, experimentId: `exp_${runId}`, caseId: `case_${runId}` },
    task: {
      instruction: 'Fix the issue.',
      benchmarkPayload: { instanceId: 'example__project-1' },
    },
    workspace: {
      provider: 'git',
      repository: 'https://github.com/example/project.git',
      revision: 'a'.repeat(40),
    },
    policy: { workspaceWrite: 'allow', hiddenDataAccess: 'deny', network: 'client-default' },
    submission: {
      requiredArtifacts: [{
        name: 'model.patch',
        mediaType: 'text/x-diff',
        collector: 'git-patch/v1',
        maxBytes: 1024,
      }],
    },
    agentConfig: { platform, agent: platform === 'pi-agent' ? 'pi-agent' : 'build', timeoutSeconds: 60 },
  }
  const body = {
    runId,
    task,
    callbackBaseUrl: `http://127.0.0.1:3000/api/benchmark/v1/runs/${runId}`,
    timeoutSeconds: 60,
  }
  return { ...body, requestDigest: benchmarkDispatchDigest(body) }
}

test('Benchmark executor accepts a runtime added after startup and rejects it after removal', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-capability-refresh-'))
  const executed: string[] = []
  let resolveExecution!: () => void
  const execution = new Promise<void>((resolve) => { resolveExecution = resolve })
  const executor = executorModule.createBenchmarkExecutor({
    clientId: 'client_capability_refresh',
    deviceCredential: 'device_capability_refresh',
    insightBaseUrl: 'http://127.0.0.1:3000',
    baseDir,
    agentPlatforms: ['opencode'],
    runner: {
      async execute(request: { task: AgentTaskEnvelope }) {
        executed.push(request.task.agentConfig.platform)
        resolveExecution()
      },
      async resume() {},
    },
  })

  try {
    await assert.rejects(
      executor.accept(requestFor('erun_pi_before_refresh', 'pi-agent')),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'EXECUTOR_CAPABILITY_MISSING')
        return true
      },
    )

    assert.deepEqual(executor.setAgentPlatforms(['opencode', 'pi-agent', 'pi-agent']), [
      'opencode',
      'pi-agent',
    ])
    assert.deepEqual(executor.agentPlatforms, ['opencode', 'pi-agent'])

    await executor.accept(requestFor('erun_pi_after_refresh', 'pi-agent'))
    await execution
    assert.deepEqual(executed, ['pi-agent'])

    executor.setAgentPlatforms(['opencode'])
    await assert.rejects(
      executor.accept(requestFor('erun_pi_after_removal', 'pi-agent')),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'EXECUTOR_CAPABILITY_MISSING')
        return true
      },
    )
  } finally {
    await executor.close()
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
})

test('client refresh synchronizes trace-safe runtimes before capability reporting', () => {
  const synchronized: string[][] = []
  const platforms = clientModule.syncBenchmarkExecutorCapabilities({
    setAgentPlatforms(next) {
      synchronized.push(next)
      return next
    },
  }, {
    platforms: [
      { id: 'opencode', runExperimentCase: { version: 2, returnsTraceId: true } },
      { id: 'pi-agent', runExperimentCase: { version: 2, returnsTraceId: true } },
      { id: 'xiaoo', runExperimentCase: { version: 2, returnsTraceId: false } },
    ],
    components: {
      'agent-runtime/opencode/v1': { ready: true },
      'agent-runtime/pi-agent/v1': { ready: true },
      'agent-runtime/xiaoo/v1': { ready: true },
    },
  })

  assert.deepEqual(platforms, ['opencode', 'pi-agent'])
  assert.deepEqual(synchronized, [['opencode', 'pi-agent']])

  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts', 'reliability-client.cjs'),
    'utf8',
  )
  const refreshBody = /async function refreshCapabilityReports[\s\S]*?\n\}/.exec(source)?.[0] || ''
  const synchronizeAt = refreshBody.indexOf('syncBenchmarkExecutorCapabilities(')
  const reportAt = refreshBody.indexOf('await reportCapabilities(')
  assert.ok(synchronizeAt >= 0 && reportAt > synchronizeAt)
})
