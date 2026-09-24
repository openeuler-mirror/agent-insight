import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(__dirname, '..')
const helper = path.join(root, 'scripts/evaluator-image-pool.sh')

test('mount planning supports Desktop classic/containerd and keeps Linux and disabled modes independent', () => {
  const run = (host: string, backend: string, enabled = 'default', operatingSystem = 'Docker Desktop') => spawnSync('bash', ['-c', `
set -eu
source "$1"
fail() { printf '%s\\n' "$*" >&2; exit 1; }
docker() {
  case "$3" in
    '{{.DockerRootDir}}') printf '%s\\n' /tmp ;;
    '{{.OperatingSystem}}') printf '%s\\n' "$TEST_DESKTOP_OS" ;;
    '{{json .DriverStatus}}') printf '%s\\n' "$TEST_BACKEND" ;;
    *) return 1 ;;
  esac
}
evaluator_image_pool_mac_path() { POOL_MAC_DISK_PATH='/Users/test/space probe'; }
HOST_OS=$2
TEST_BACKEND=$3
TEST_DESKTOP_OS=$5
EVALUATOR_ENV=()
if [ "$4" != default ]; then EVALUATOR_ENV=("IMAGE_POOL_ENABLED=$4"); fi
evaluator_image_pool_mounts
printf '<%s>\\n' "\${POOL_ARGS[@]}"
evaluator_image_pool_env
`, 'test', helper, host, backend, enabled, operatingSystem], { encoding: 'utf8' })
  for (const backend of ['classic', 'io.containerd.snapshotter.v1']) {
    const result = run('darwin', backend)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /IMAGE_POOL_DISK_MODE=desktop-mac/)
    assert.match(result.stdout, /IMAGE_POOL_ENABLED=true/)
    assert.match(result.stdout, /src=\/Users\/test\/space probe,dst=\/host-mac-space,readonly/)
    assert.match(result.stdout, /IMAGE_POOL_HOST_DISK_PATH=\/host-mac-space/)
    assert.equal(result.stdout.includes('src=/var/lib/desktop-containerd'), backend !== 'classic')
  }
  const linux = run('linux', 'classic')
  assert.equal(linux.status, 0, linux.stderr)
  assert.match(linux.stdout, /IMAGE_POOL_DISK_MODE=linux/)
  assert.doesNotMatch(linux.stdout, /host-mac-space|host-containerd/)
  const disabled = run('darwin', 'snapshotter', 'false', 'Colima')
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.match(disabled.stdout, /IMAGE_POOL_ENABLED=false/)
  assert.doesNotMatch(disabled.stdout, /--mount|IMAGE_POOL_DISK_MODE/)
  assert.notEqual(run('darwin', 'snapshotter', 'true', 'Colima').status, 0)
})

test('Mac disk location uses Desktop settings, follows symlinks, and rejects a different filesystem', { skip: process.platform !== 'darwin' }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-space-test-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const data = path.join(temp, 'disk image')
  const probe = path.join(temp, 'shared probe')
  fs.mkdirSync(data)
  fs.mkdirSync(probe)
  fs.writeFileSync(path.join(data, 'Docker.raw'), '')
  const settings = path.join(temp, 'settings-store.json')
  const invoke = (mismatch = false) => spawnSync('bash', ['-c', `
set -eu
source "$1"
fail() { printf '%s\\n' "$*" >&2; exit 1; }
POOL_MAC_DISK_PATH=$3
${mismatch ? `stat() { case "$*" in *Docker.raw) echo 999 ;; *) echo 1 ;; esac; }` : ''}
evaluator_image_pool_mac_path "$2"
printf '%s\\n' "$POOL_MAC_DISK_PATH"
`, 'test', helper, settings, probe], { encoding: 'utf8' })
  for (const key of ['DataFolder', 'dataFolder']) {
    fs.writeFileSync(settings, JSON.stringify({ [key]: data }))
    const result = invoke()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), fs.realpathSync(probe))
    assert.match(invoke(true).stderr, /不在同一文件系统/)
  }
  fs.writeFileSync(settings, JSON.stringify({ DataFolder: path.join(temp, 'missing') }))
  const missing = invoke()
  assert.match(missing.stderr, /Docker.raw/, JSON.stringify(missing))
  fs.writeFileSync(settings, '{invalid json')
  assert.match(invoke().stderr, /无法解析/)
})

test('storage preflight happens before replacing configuration or stopping the old Controller', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/start-evaluator.sh'), 'utf8')
  const preflight = source.indexOf('const store=new DockerImageStore({checkManagers:false})')
  assert.ok(preflight > 0)
  assert.ok(preflight < source.indexOf('mv -f "$TEMP_CONFIG" "$CONFIG_FILE"'))
  assert.ok(preflight < source.indexOf('evaluator_management_run "$IMAGE_ID"'))
  assert.match(source, /--env EVALUATOR_CONTROLLER_CONTAINER_ID=/)
  assert.match(source, /--network none --read-only/)
})

test('internal storage variables cannot be overridden through user evaluator env', () => {
  for (const name of ['IMAGE_POOL_DISK_MODE', 'IMAGE_POOL_DISK_PATH', 'IMAGE_POOL_HOST_DISK_PATH', 'IMAGE_POOL_CONTAINERD_PATH']) {
    const result = spawnSync('bash', ['-c', `
set -eu
source "$1"
fail() { printf '%s\\n' "$*" >&2; exit 1; }
EVALUATOR_ENV=("$2=unexpected")
evaluator_image_pool_mounts
`, 'test', helper, name], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /不接受/)
  }
})
