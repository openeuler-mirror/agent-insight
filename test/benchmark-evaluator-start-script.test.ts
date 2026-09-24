import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = path.resolve(__dirname, '..')
const startScript = path.join(repositoryRoot, 'scripts', 'start-evaluator.sh')
const evaluatorDockerfile = path.join(repositoryRoot, 'services', 'evaluator', 'Dockerfile')
const sweBenchDockerfile = path.join(repositoryRoot, 'benchmarks', 'swe-bench', 'evaluator', 'Dockerfile')

test('optional image pool binds the daemon data filesystem read-only and keeps its secret out of Runtime env', () => {
  const source = fs.readFileSync(startScript, 'utf8')
  const storage = fs.readFileSync(path.join(repositoryRoot, 'scripts/evaluator-image-pool.sh'), 'utf8')
  assert.match(storage, /POOL_ENABLED=true/)
  assert.match(storage, /docker info --format '\{\{\.DockerRootDir\}\}'/)
  assert.match(storage, /dst=\/host-docker,readonly/)
  assert.match(storage, /IMAGE_POOL_DISK_PATH=\/host-docker/)
  assert.match(source, /IMAGE_POOL_\*\) continue/)
})

test('one-command evaluator script exposes the phase-one CLI and rejects deferred registration flags', () => {
  const help = spawnSync('bash', [startScript, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.doesNotMatch(help.stdout, /--auth-mode|--token/)
  assert.match(help.stdout, /--platform-base-url URL/)
  assert.match(help.stdout, /Defaults: --bind-address 0\.0\.0\.0 --port 3001/)
  assert.doesNotMatch(help.stdout, /--benchmark/)
  assert.match(help.stdout, /--evaluator-env NAME=VALUE/)
  assert.match(help.stdout, /Linux or macOS/)

  const deferred = spawnSync('bash', [startScript, '--server', 'https://example.test'], { encoding: 'utf8' })
  assert.notEqual(deferred.status, 0)
  assert.match(deferred.stderr, /不支持的参数：--server/)

  const benchmark = spawnSync('bash', [startScript, '--benchmark', 'swe-bench'], { encoding: 'utf8' })
  assert.notEqual(benchmark.status, 0)
  assert.match(benchmark.stderr, /不支持的参数：--benchmark/)

  for (const removedFlag of ['--auth-mode', '--token']) {
    const removed = spawnSync('bash', [startScript, removedFlag, 'removed'], { encoding: 'utf8' })
    assert.notEqual(removed.status, 0)
    assert.match(removed.stderr, new RegExp(`不支持的参数：${removedFlag}`))
  }
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
  assert.doesNotMatch(source, /BENCHMARK_KEY|BENCHMARK_EVALUATOR_KEY|benchmarks\/\$BENCHMARK_KEY/)
  assert.match(source, /services\/evaluator\/Dockerfile/)
  assert.match(source, /^BIND_ADDRESS=0\.0\.0\.0$/m)
  assert.match(source, /EVALUATOR_HOST_PORT=\$\{EVALUATOR_HOST_PORT:-\$\{FILE_EVALUATOR_PORT:-3001\}\}/)
  assert.match(source, /--evaluator-env/)
  assert.doesNotMatch(source, /printf 'SWE_BENCH_/)
  assert.doesNotMatch(source, /EVALUATOR_AUTH_MODE|EVALUATOR_PLATFORM_TOKEN/)
  assert.match(source, /printf 'EVALUATOR_AGENT_INSIGHT_BASE_URL=%s\\n'/)
  assert.doesNotMatch(source, /systemctl|launchctl/)
  assert.match(source, /Linux\) HOST_OS=linux/)
  assert.match(source, /Darwin\) HOST_OS=darwin/)
})

test('one-command evaluator script recreates the Controller and removes only old Controller images after Doctor', () => {
  const source = fs.readFileSync(startScript, 'utf8')
  const removeContainerIndex = source.indexOf('evaluator_management_run "$IMAGE_ID"')
  const runContainerIndex = source.indexOf('docker run --detach --pull never')
  const doctorIndex = source.indexOf('bash "$SCRIPT_DIR/evaluator-doctor.sh"')
  const removeOldImageIndex = source.indexOf('docker image rm "$OLD_CONTROLLER_REF"')

  assert.ok(removeContainerIndex >= 0)
  assert.ok(runContainerIndex > removeContainerIndex)
  assert.ok(doctorIndex > runContainerIndex)
  assert.ok(removeOldImageIndex > doctorIndex)
  assert.match(source, /docker image ls --format .*"\$IMAGE_REPOSITORY"/)
  assert.match(source, /PREVIOUS_CONTROLLER_IMAGE_IDS=/)
  assert.doesNotMatch(source, /docker image prune|docker system prune/)
  assert.doesNotMatch(source, /docker start "\$CONTAINER_NAME"/)
})

test('generic Controller image excludes SWE-bench dependencies and its package image owns them', () => {
  const genericSource = fs.readFileSync(evaluatorDockerfile, 'utf8')
  const sweSource = fs.readFileSync(sweBenchDockerfile, 'utf8')
  assert.doesNotMatch(genericSource, /SWE_BENCH|swebench-venv|SWE-bench/)
  assert.match(sweSource, /ARG DEBIAN_MIRROR=http:\/\/repo\.huaweicloud\.com\/debian/)
  assert.match(sweSource, /ARG DEBIAN_SECURITY_MIRROR=http:\/\/repo\.huaweicloud\.com\/debian-security/)
  assert.match(sweSource, /ARG PIP_INDEX_URL=https:\/\/repo\.huaweicloud\.com\/repository\/pypi\/simple/)
  assert.match(sweSource, /debian\.sources\.official/)
  assert.match(sweSource, /https:\/\/pypi\.org\/simple/)
  assert.match(sweSource, /ARG SWE_BENCH_ARCHIVE_URL=https:\/\/codeload\.github\.com\/swe-bench\/SWE-bench\/tar\.gz/)
  assert.match(sweSource, /ARG EVALUATOR_ARTIFACT_DIGEST=unknown/)
  assert.match(sweSource, /agent-insight\.evaluator\.artifact-digest=\$EVALUATOR_ARTIFACT_DIGEST/)
  assert.match(sweSource, /ARG SWE_BENCH_ARCHIVE_SHA256=[a-f0-9]{64}/)
  assert.match(sweSource, /"\$SWE_BENCH_ARCHIVE_URL\/\$SWE_BENCH_SOURCE_COMMIT"/)
  assert.match(sweSource, /sha256sum --check/)
  assert.doesNotMatch(sweSource, /git clone/)
  assert.doesNotMatch(sweSource, /git .*fetch/)
  assert.doesNotMatch(sweSource, /services\/evaluator\/src\/index\.cjs/)
})
