import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  EvaluatorRuntimeConfigProvider,
} from '@/lib/benchmark/evaluator-runtime-config'
import {
  authenticateBenchmarkEvaluator,
  EnvEvaluatorTargetResolver,
} from '@/lib/benchmark/evaluator-target'

function writeConfig(filePath: string, input: {
  publicBaseUrl?: string
  evaluatorBaseUrl?: string
  token?: string
  previousTokens?: string
  allowInsecure?: string
}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    `AGENT_INSIGHT_PUBLIC_BASE_URL=${input.publicBaseUrl || 'https://agent-insight.example.test'}`,
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL=${input.evaluatorBaseUrl || 'https://evaluator.example.test'}`,
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN=${input.token || 'active-token'}`,
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_PREVIOUS_TOKENS=${input.previousTokens || ''}`,
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP=${input.allowInsecure || 'false'}`,
    '',
  ].join('\n'), { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

test('runtime config hot-loads an atomic file and keeps the previous valid snapshot on invalid update', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-config-'))
  const configPath = path.join(root, 'benchmark-evaluator.env')
  const warnings: string[] = []
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    AGENT_INSIGHT_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL: 'http://127.0.0.1:8080',
    AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN: 'environment-token',
  }
  const provider = new EvaluatorRuntimeConfigProvider({
    configPath,
    environment,
    onInvalidUpdate(message) { warnings.push(message) },
  })
  try {
    const fallback = provider.snapshot()
    assert.equal(fallback.source, 'environment')
    assert.equal(fallback.activeToken, 'environment-token')

    writeConfig(configPath, { token: 'file-token', previousTokens: 'old-a,old-b' })
    const first = provider.snapshot()
    assert.equal(first.source, 'file')
    assert.equal(first.activeToken, 'file-token')
    assert.deepEqual(first.previousTokens, ['old-a', 'old-b'])

    writeConfig(configPath, { token: 'rotated-token' })
    const rotated = provider.snapshot()
    assert.equal(rotated.activeToken, 'rotated-token')
    assert.notEqual(rotated.revision, first.revision)

    fs.writeFileSync(configPath, 'AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN=partial\n', { mode: 0o600 })
    fs.chmodSync(configPath, 0o600)
    const retained = provider.snapshot()
    assert.equal(retained.activeToken, 'rotated-token')
    assert.equal(warnings.length, 1)
    assert.doesNotMatch(warnings[0], /rotated-token|partial/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime config rejects broad permissions and non-loopback HTTP without explicit opt-in', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-config-mode-'))
  const configPath = path.join(root, 'benchmark-evaluator.env')
  const warnings: string[] = []
  const provider = new EvaluatorRuntimeConfigProvider({
    configPath,
    environment: { NODE_ENV: 'test' },
    onInvalidUpdate(message) { warnings.push(message) },
  })
  try {
    writeConfig(configPath, {
      evaluatorBaseUrl: 'http://10.0.0.8:8080',
      allowInsecure: 'false',
    })
    assert.equal(provider.snapshot().evaluatorBaseUrl, undefined)
    assert.match(warnings.at(-1) || '', /HTTPS/)

    writeConfig(configPath, { token: 'mode-token' })
    fs.chmodSync(configPath, 0o644)
    assert.equal(provider.snapshot().activeToken, undefined)
    assert.match(warnings.at(-1) || '', /0600/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('target resolver returns URL and sending token from one runtime snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-target-'))
  const configPath = path.join(root, 'benchmark-evaluator.env')
  try {
    writeConfig(configPath, { token: 'snapshot-token' })
    const provider = new EvaluatorRuntimeConfigProvider({
      configPath,
      environment: { NODE_ENV: 'test' },
    })
    const target = new EnvEvaluatorTargetResolver(provider).resolve('swe-bench')
    assert.equal(target.baseUrl, 'https://evaluator.example.test')
    assert.equal(target.token, 'snapshot-token')
    assert.match(target.targetKey, /^runtime:[0-9a-f]{24}:swe-bench$/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime authentication accepts the active and previous rotation tokens', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-auth-'))
  const configPath = path.join(root, 'benchmark-evaluator.env')
  try {
    writeConfig(configPath, { token: 'active-token', previousTokens: 'previous-token' })
    const provider = new EvaluatorRuntimeConfigProvider({
      configPath,
      environment: { NODE_ENV: 'test' },
    })

    assert.doesNotThrow(() => authenticateBenchmarkEvaluator(new Request('http://localhost', {
      headers: { authorization: 'Bearer active-token' },
    }), provider))
    assert.doesNotThrow(() => authenticateBenchmarkEvaluator(new Request('http://localhost', {
      headers: { authorization: 'Bearer previous-token' },
    }), provider))
    assert.throws(() => authenticateBenchmarkEvaluator(new Request('http://localhost', {
      headers: { authorization: 'Bearer rejected-token' },
    }), provider), /评测服务凭证无效/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
