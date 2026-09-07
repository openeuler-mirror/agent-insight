import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = path.resolve(__dirname, '..')
const startScript = path.join(repositoryRoot, 'scripts', 'start-evaluator.sh')

test('one-command evaluator script exposes the phase-one CLI and rejects deferred registration flags', () => {
  const help = spawnSync('bash', [startScript, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--token TOKEN/)
  assert.match(help.stdout, /Linux or macOS/)

  const deferred = spawnSync('bash', [startScript, '--server', 'https://example.test'], { encoding: 'utf8' })
  assert.notEqual(deferred.status, 0)
  assert.match(deferred.stderr, /不支持的参数：--server/)

  const oneTime = spawnSync('bash', [startScript, '--token', 'eval_once_example'], { encoding: 'utf8' })
  assert.notEqual(oneTime.status, 0)
  assert.match(oneTime.stderr, /不接受一次性/)
})

test('one-command evaluator script preserves the Docker lifecycle and on-demand image boundary', () => {
  const source = fs.readFileSync(startScript, 'utf8')
  assert.match(source, /--restart unless-stopped/)
  assert.match(source, /--pull never/)
  assert.match(source, /agent-insight-benchmark-evaluator-data/)
  assert.match(source, /status --porcelain --untracked-files=normal/)
  assert.match(source, /DIRTY_SUFFIX=-dirty/)
  assert.match(source, /EVALUATOR_SOURCE_DIRTY/)
  assert.doesNotMatch(source, /含未提交内容，无法/)
  assert.doesNotMatch(source, /docker pull/)
  assert.doesNotMatch(source, /systemctl|launchctl/)
  assert.match(source, /Linux\) HOST_OS=linux/)
  assert.match(source, /Darwin\) HOST_OS=darwin/)
})
