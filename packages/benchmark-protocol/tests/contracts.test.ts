import assert from 'node:assert/strict'
import test from 'node:test'

import {
  benchmarkDispatchDigest,
  canonicalJson,
  type AgentTaskEnvelope,
  validateTaskEnvelope,
} from '../src/contracts'
import {
  createBenchmarkDispatchToken,
  createBenchmarkHealthToken,
  deviceCredentialHash,
  verifyBenchmarkDispatchToken,
} from '../src/executor-contracts'

const context = { runId: 'erun_1', experimentId: 'exp_1', caseId: 'case_1' }
const manifest = {
  adapterKey: 'fixture',
  displayName: 'Fixture',
  protocols: { agentTask: 'agent-task/v1', evaluation: 'benchmark-evaluation/v1' },
  requiredCapabilities: ['git-workspace/v1'],
  defaultTimeoutSeconds: 30,
  requiredArtifacts: [{ name: 'answer.txt', mediaType: 'text/plain', collector: 'file/v1', maxBytes: 1024 }],
  schemas: { case: true, rawResult: true },
  evaluation: {
    evaluatorKey: 'fixture',
    defaultTimeoutSeconds: 30,
    defaultResources: { cpu: 1, memoryMiB: 512 },
  },
  result: {
    primaryMetric: { key: 'passed', aggregation: 'boolean-rate' },
  },
} as const

function task(payload: Record<string, unknown> = { question: 'q' }): AgentTaskEnvelope {
  return {
    schemaVersion: 'agent-task/v1',
    benchmark: { key: 'fixture' },
    context,
    task: { instruction: 'Answer the fixture.', benchmarkPayload: payload as never },
    workspace: {
      provider: 'git',
      repository: 'https://github.com/example/project.git',
      revision: 'a'.repeat(40),
    },
    policy: { workspaceWrite: 'allow', hiddenDataAccess: 'deny', network: 'client-default' },
    submission: { requiredArtifacts: [{ name: 'answer.txt', mediaType: 'text/plain', collector: 'file/v1', maxBytes: 1024 }] },
    agentConfig: { platform: 'opencode', agent: 'fixture-agent', timeoutSeconds: 30 },
  }
}

test('canonical JSON ignores object key order but preserves array order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }))
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
})

test('dispatch digest is deterministic', () => {
  const input = { runId: context.runId, task: task(), callbackBaseUrl: 'https://insight.test/callback', timeoutSeconds: 30 }
  assert.equal(benchmarkDispatchDigest(input), benchmarkDispatchDigest(input))
})

test('task envelope rejects free command fields', () => {
  assert.throws(
    () => validateTaskEnvelope(task({ command: 'rm' }), context, manifest),
    /禁止字段/,
  )
})

test('task envelope rejects context mismatch', () => {
  assert.throws(
    () => validateTaskEnvelope(task(), { ...context, runId: 'other' }, manifest),
    /上下文/,
  )
})

test('dispatch token binds client, run and digest to the device credential', () => {
  const credentialHash = deviceCredentialHash('dc_test')
  const token = createBenchmarkDispatchToken({
    clientId: 'client_1',
    runId: context.runId,
    requestDigest: 'sha256:digest',
    credentialHash,
    expiresAt: 1_000,
  })
  assert.equal(verifyBenchmarkDispatchToken({
    token,
    clientId: 'client_1',
    runId: context.runId,
    requestDigest: 'sha256:digest',
    credentialHash,
    nowSeconds: 900,
  }).purpose, 'execute')
  assert.throws(() => verifyBenchmarkDispatchToken({
    token,
    clientId: 'client_1',
    runId: 'other',
    requestDigest: 'sha256:digest',
    credentialHash,
    nowSeconds: 900,
  }), /token/)
})

test('health token has a separate purpose and omits run data', () => {
  const token = createBenchmarkHealthToken({
    clientId: 'client_1',
    credentialHash: deviceCredentialHash('dc_test'),
    expiresAt: 1_000,
  })
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
  assert.deepEqual(payload, {
    aud: 'benchmark-executor',
    purpose: 'health',
    clientId: 'client_1',
    expiresAt: 1_000,
  })
})
