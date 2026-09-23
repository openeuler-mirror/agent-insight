import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = path.resolve(__dirname, '..')
const configureScript = path.join(repositoryRoot, 'scripts', 'configure-evaluator-target.js')

test('configure command exposes only address and transport options', () => {
  const help = spawnSync(process.execPath, [configureScript, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.doesNotMatch(help.stdout, /--public-base-url|--auth-mode|--token-file|--previous-token-file/)

  for (const option of ['--public-base-url', '--auth-mode', '--token-file', '--previous-token-file']) {
    const removed = spawnSync(process.execPath, [configureScript, option, 'removed'], { encoding: 'utf8' })
    assert.notEqual(removed.status, 0)
    assert.match(removed.stderr, new RegExp(`不支持的参数：${option}`))
  }
})

test('configure command writes a 0600 runtime file atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-configure-evaluator-'))
  const configFile = path.join(root, 'data', 'config', 'benchmark-evaluator.env')
  try {
    const result = spawnSync(process.execPath, [
      configureScript,
      '--executor-callback-base-url', 'http://127.0.0.1:3000',
      '--evaluator-base-url', 'https://evaluator.example.test',
      '--config-file', configFile,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600)
    const content = fs.readFileSync(configFile, 'utf8')
    assert.match(content, /AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL="http:\/\/127\.0\.0\.1:3000"/)
    assert.doesNotMatch(content, /AUTH_MODE|TOKEN|PREVIOUS_TOKENS/)
    assert.equal(fs.readdirSync(path.dirname(configFile)).filter((name) => name.includes('.tmp')).length, 0)

    const reset = spawnSync(process.execPath, [
      configureScript,
      '--evaluator-base-url', 'https://evaluator.example.test',
      '--config-file', configFile,
    ], { encoding: 'utf8' })
    assert.equal(reset.status, 0, reset.stderr)
    assert.doesNotMatch(
      fs.readFileSync(configFile, 'utf8'),
      /AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('configure command allows controlled HTTP by default without auth settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-configure-no-auth-'))
  const configFile = path.join(root, 'benchmark-evaluator.env')
  try {
    const result = spawnSync(process.execPath, [
      configureScript,
      '--executor-callback-base-url', 'http://localhost:3000',
      '--evaluator-base-url', 'http://119.3.152.42:3001',
      '--config-file', configFile,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const content = fs.readFileSync(configFile, 'utf8')
    assert.doesNotMatch(content, /AGENT_INSIGHT_PUBLIC_BASE_URL/)
    assert.match(content, /AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP=true/)
    assert.doesNotMatch(content, /AUTH_MODE|TOKEN/)
    assert.match(result.stdout, /白名单、安全组或防火墙/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
