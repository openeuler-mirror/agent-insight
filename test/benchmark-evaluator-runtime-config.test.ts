import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  EvaluatorRuntimeConfigProvider,
} from '@/lib/benchmark/evaluator-runtime-config'
import {
  EnvEvaluatorTargetResolver,
} from '@/lib/benchmark/evaluator-target'

function writeConfig(filePath: string, input: {
  executorCallbackBaseUrl?: string
  evaluatorBaseUrl?: string
  allowInsecure?: string
}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    ...(input.executorCallbackBaseUrl
      ? [`AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL=${input.executorCallbackBaseUrl}`]
      : []),
    `AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL=${input.evaluatorBaseUrl || 'https://evaluator.example.test'}`,
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
    AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL: 'http://127.0.0.1:3000/local-prefix/',
    AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL: 'http://127.0.0.1:8080',
  }
  const provider = new EvaluatorRuntimeConfigProvider({
    configPath,
    environment,
    onInvalidUpdate(message) { warnings.push(message) },
  })
  try {
    const fallback = provider.snapshot()
    assert.equal(fallback.source, 'environment')
    assert.equal(fallback.allowInsecureHttp, true)
    assert.equal(fallback.executorCallbackBaseUrl, 'http://127.0.0.1:3000/local-prefix')

    writeConfig(configPath, {
      executorCallbackBaseUrl: 'http://127.0.0.1:3000',
    })
    const first = provider.snapshot()
    assert.equal(first.source, 'file')
    assert.equal(first.executorCallbackBaseUrl, 'http://127.0.0.1:3000')

    writeConfig(configPath, { evaluatorBaseUrl: 'https://rotated.example.test' })
    const rotated = provider.snapshot()
    assert.equal(rotated.evaluatorBaseUrl, 'https://rotated.example.test')
    assert.equal(rotated.executorCallbackBaseUrl, undefined)
    assert.notEqual(rotated.revision, first.revision)

    fs.writeFileSync(configPath, 'AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP=true\n', { mode: 0o600 })
    fs.chmodSync(configPath, 0o600)
    const retained = provider.snapshot()
    assert.equal(retained.evaluatorBaseUrl, 'https://rotated.example.test')
    assert.equal(warnings.length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime config rejects broad permissions and non-loopback HTTP when insecure HTTP is disabled', () => {
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

    writeConfig(configPath, {})
    fs.chmodSync(configPath, 0o644)
    assert.equal(provider.snapshot().evaluatorBaseUrl, undefined)
    assert.match(warnings.at(-1) || '', /0600/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('target resolver returns the URL from one runtime snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-target-'))
  const configPath = path.join(root, 'benchmark-evaluator.env')
  try {
    writeConfig(configPath, {})
    const provider = new EvaluatorRuntimeConfigProvider({
      configPath,
      environment: { NODE_ENV: 'test' },
    })
    const target = new EnvEvaluatorTargetResolver(provider).resolve('swe-bench')
    assert.equal(target.baseUrl, 'https://evaluator.example.test')
    assert.match(target.targetKey, /^runtime:[0-9a-f]{24}:swe-bench$/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
