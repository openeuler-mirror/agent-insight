import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = path.resolve(__dirname, '..')
const configureScript = path.join(repositoryRoot, 'scripts', 'configure-evaluator-target.js')

test('configure command writes a 0600 runtime file atomically without echoing tokens', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-configure-evaluator-'))
  const tokenFile = path.join(root, 'token')
  const previousTokenFile = path.join(root, 'previous-token')
  const configFile = path.join(root, 'data', 'config', 'benchmark-evaluator.env')
  fs.writeFileSync(tokenFile, 'new-shared-secret\n', { mode: 0o600 })
  fs.writeFileSync(previousTokenFile, 'old-shared-secret\n', { mode: 0o600 })
  fs.chmodSync(tokenFile, 0o600)
  fs.chmodSync(previousTokenFile, 0o600)
  try {
    const result = spawnSync(process.execPath, [
      configureScript,
      '--public-base-url', 'https://agent-insight.example.test',
      '--executor-callback-base-url', 'http://127.0.0.1:3000',
      '--evaluator-base-url', 'https://evaluator.example.test',
      '--token-file', tokenFile,
      '--previous-token-file', previousTokenFile,
      '--config-file', configFile,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /new-shared-secret|old-shared-secret/)
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600)
    const content = fs.readFileSync(configFile, 'utf8')
    assert.match(content, /AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL="http:\/\/127\.0\.0\.1:3000"/)
    assert.match(content, /AGENT_INSIGHT_BENCHMARK_EVALUATOR_TOKEN="new-shared-secret"/)
    assert.match(content, /AGENT_INSIGHT_BENCHMARK_EVALUATOR_PREVIOUS_TOKENS="old-shared-secret"/)
    assert.equal(fs.readdirSync(path.dirname(configFile)).filter((name) => name.includes('.tmp')).length, 0)

    const reset = spawnSync(process.execPath, [
      configureScript,
      '--public-base-url', 'https://agent-insight.example.test',
      '--evaluator-base-url', 'https://evaluator.example.test',
      '--token-file', tokenFile,
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

test('configure command rejects broadly readable token files', () => {
  if (process.platform === 'win32') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-configure-mode-'))
  const tokenFile = path.join(root, 'token')
  fs.writeFileSync(tokenFile, 'unsafe-shared-secret\n', { mode: 0o644 })
  fs.chmodSync(tokenFile, 0o644)
  try {
    const result = spawnSync(process.execPath, [
      configureScript,
      '--public-base-url', 'https://agent-insight.example.test',
      '--evaluator-base-url', 'https://evaluator.example.test',
      '--token-file', tokenFile,
      '--config-file', path.join(root, 'runtime.env'),
    ], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /0600/)
    assert.doesNotMatch(result.stderr, /unsafe-shared-secret/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
