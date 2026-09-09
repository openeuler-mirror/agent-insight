import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = path.resolve(__dirname, '..')
const startScript = path.join(repositoryRoot, 'scripts', 'start-evaluator.sh')
const evaluatorDockerfile = path.join(repositoryRoot, 'services', 'evaluator', 'Dockerfile')

test('one-command evaluator script exposes the phase-one CLI and rejects deferred registration flags', () => {
  const help = spawnSync('bash', [startScript, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--auth-mode token --token TOKEN/)
  assert.match(help.stdout, /--auth-mode none/)
  assert.match(help.stdout, /Linux or macOS/)

  const deferred = spawnSync('bash', [startScript, '--server', 'https://example.test'], { encoding: 'utf8' })
  assert.notEqual(deferred.status, 0)
  assert.match(deferred.stderr, /不支持的参数：--server/)

  const oneTime = spawnSync('bash', [startScript, '--token', 'eval_once_example'], { encoding: 'utf8' })
  assert.notEqual(oneTime.status, 0)
  assert.match(oneTime.stderr, /不接受一次性/)

  const conflicting = spawnSync('bash', [
    startScript, '--auth-mode', 'none', '--token', 'not-used',
  ], { encoding: 'utf8' })
  assert.notEqual(conflicting.status, 0)
  assert.match(conflicting.stderr, /none 模式不接受 --token/)
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
  assert.match(source, /CASE_IMAGE_PROXY_PREFIX=\$\{SWE_BENCH_IMAGE_PROXY_PREFIX:-\}/)
  assert.doesNotMatch(source, /SWE_BENCH_IMAGE_PROXY_PREFIX-docker\.1ms\.run/)
  assert.match(source, /printf 'SWE_BENCH_IMAGE_PROXY_PREFIX=%s\\n'/)
  assert.match(source, /printf 'EVALUATOR_AUTH_MODE=%s\\n'/)
  assert.doesNotMatch(source, /systemctl|launchctl/)
  assert.match(source, /Linux\) HOST_OS=linux/)
  assert.match(source, /Darwin\) HOST_OS=darwin/)
})

test('one-command evaluator script recreates the Controller and removes only old Controller images after Doctor', () => {
  const source = fs.readFileSync(startScript, 'utf8')
  const removeContainerIndex = source.indexOf('docker rm -f "$CONTAINER_NAME"')
  const runContainerIndex = source.indexOf('docker run --detach --pull never')
  const doctorIndex = source.indexOf('bash "$SCRIPT_DIR/evaluator-doctor.sh"')
  const removeOldImageIndex = source.indexOf('docker image rm "$OLD_CONTROLLER_REF"')

  assert.ok(removeContainerIndex >= 0)
  assert.ok(runContainerIndex > removeContainerIndex)
  assert.ok(doctorIndex > runContainerIndex)
  assert.ok(removeOldImageIndex > doctorIndex)
  assert.match(source, /docker image ls --format .*"\$CONTAINER_NAME"/)
  assert.match(source, /PREVIOUS_CONTROLLER_IMAGE_IDS=/)
  assert.doesNotMatch(source, /docker image prune|docker system prune/)
  assert.doesNotMatch(source, /docker start "\$CONTAINER_NAME"/)
})

test('evaluator image build uses fast package sources with official fallbacks and a verified Harness archive', () => {
  const source = fs.readFileSync(evaluatorDockerfile, 'utf8')
  assert.match(source, /ARG DEBIAN_MIRROR=http:\/\/repo\.huaweicloud\.com\/debian/)
  assert.match(source, /ARG DEBIAN_SECURITY_MIRROR=http:\/\/repo\.huaweicloud\.com\/debian-security/)
  assert.match(source, /ARG PIP_INDEX_URL=https:\/\/repo\.huaweicloud\.com\/repository\/pypi\/simple/)
  assert.match(source, /debian\.sources\.official/)
  assert.match(source, /https:\/\/pypi\.org\/simple/)
  assert.match(source, /ARG SWE_BENCH_ARCHIVE_URL=https:\/\/codeload\.github\.com\/swe-bench\/SWE-bench\/tar\.gz/)
  assert.match(source, /ARG SWE_BENCH_ARCHIVE_SHA256=[a-f0-9]{64}/)
  assert.match(source, /"\$SWE_BENCH_ARCHIVE_URL\/\$SWE_BENCH_SOURCE_COMMIT"/)
  assert.match(source, /sha256sum --check/)
  assert.doesNotMatch(source, /git clone/)
  assert.doesNotMatch(source, /git .*fetch/)
})
