import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { loadZsoftCases } from '../../benchmarks/zsoft-l1/dataset'
import { zsoftL1Adapter } from '../../benchmarks/zsoft-l1/adapter'

const load = createRequire(import.meta.url)
const { describeImages } = load('../../benchmarks/zsoft-l1/evaluator/images.cjs')
const { runtimeDescriptor } = load('../../services/evaluator/src/runtime-image.cjs')
const { ensureOciRuntime } = load('../../services/evaluator/src/evaluator-registry.cjs')
const { BenchmarkImagePool } = load('../../services/evaluator/src/image-pool.cjs')
const prelude = `
import importlib.util, json, sys, tarfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path.cwd() / 'benchmarks/zsoft-l1/evaluator'))
from assets import *
def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path.cwd() / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
exporter = module('exporter', 'scripts/benchmark/export-zsoft-dataset.py')
publisher = module('publisher', 'scripts/benchmark/prepare-zsoft-images.py')
packer = module('packer', 'scripts/benchmark/pack-zsoft-assets.py')
assetImage = module('assetImage', 'scripts/benchmark/build-zsoft-assets-image.py')
root = Path(sys.argv[1])
revision = 'a' * 40
image_id = 'sha256:' + 'b' * 64
reference = 'swr.example.test/team/zsoft@sha256:' + 'c' * 64
repo = 'swr.example.test/team/zsoft'
def fixture():
    (root / 'src').mkdir()
    (root / 'src/framework.py').write_text('synthetic framework; never executed')
    for name, tags in [('service-case', ['python', 'service']), ('sample-demo', []), ('kernel-case', ['kernel'])]:
        task = root / 'tasks' / name
        (task / 'public').mkdir(parents=True)
        (task / 'public/README.md').write_text('synthetic instructions')
        (task / 'task.json').write_text(json.dumps({'task_id': name, 'title': '合成服务题', 'description': 'synthetic', 'tags': tags, 'submission': {'max_bytes': 128}}))
    state = root / '.task-state/service-case'
    state.mkdir(parents=True)
    (state / 'image-refs.json').write_text(json.dumps({'target_image': 'zsoft-local:target'}))
def freeze():
    mapping = root / 'mapping.json'
    mapping.write_text(json.dumps({'schemaVersion': publisher.SCHEMA, 'revision': revision, 'tasks': {'service-case': {'zsoft-local:target': {'imageId': image_id, 'reference': reference}}}}))
    with patch.object(exporter.subprocess, 'run') as run:
        run.return_value.stdout = image_id
        exporter.export(root, revision, ['service-case'], root / 'dataset.json', mapping)
    return json.loads((root / 'dataset.json').read_text())[0]
fixture()
`
function python(directory: string, code: string) {
  return execFileSync('python3', ['-c', prelude + code, directory], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
}
async function temporary(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zsoft-images-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('ZSoft Python export and Node provider agree on Unicode digests, task selection and immutable registry identities', async (t) => {
  const directory = await temporary(t)
  const caseData = JSON.parse(python(directory, `
assert select_userspace_tasks(root, [], True) == ['service-case']
for invalid in ['sample-demo', 'kernel-case']:
    try: select_userspace_tasks(root, [invalid], False)
    except AssetError: pass
    else: raise AssertionError(invalid)
case = freeze()
assert 'userspace' in case['public']['tags']
assert 'userspace' not in json.loads((root / 'tasks/service-case/task.json').read_text())['tags']
legacy = load_inventory(root)
legacy['tasks']['service-case'].pop('sourceTaskDigest')
try: verify_task(root, legacy, 'service-case')
except AssetError as error: assert str(error) == 'ZSOFT_TASK_LOCK_INVALID'
else: raise AssertionError('legacy evaluator inventory accepted')
print(json.dumps(case))
`))
  const previous = process.env.ZSOFT_L1_ASSETS_DIR
  process.env.ZSOFT_L1_ASSETS_DIR = directory
  t.after(() => { if (previous === undefined) delete process.env.ZSOFT_L1_ASSETS_DIR; else process.env.ZSOFT_L1_ASSETS_DIR = previous })
  const payload = zsoftL1Adapter.imagePreparationInput(caseData.public, caseData.private)
  const loaded = (await loadZsoftCases(directory)).filter(item => item.public.taskId === 'service-case')
  assert.equal(loaded[0].private.sourceTaskDigest, caseData.private.sourceTaskDigest)
  assert.equal(loaded[0].private.revision, undefined)
  const specs = describeImages(payload, 'amd64')
  assert.deepEqual(describeImages(zsoftL1Adapter.imagePreparationInput(loaded[0].public, loaded[0].private), 'amd64'), specs)
  assert.deepEqual(specs, [{ key: 'zsoft-local:target', arch: 'x86_64', references: [`swr.example.test/team/zsoft@sha256:${'c'.repeat(64)}`], context: { expectedImageId: `sha256:${'b'.repeat(64)}` } }])
  for (const value of [{ ...payload, revision: 'd'.repeat(40) }, { ...payload, maxBytes: 1 }, { ...payload, sourceTaskDigest: `sha256:${'d'.repeat(64)}` }]) assert.throws(() => describeImages(value, 'amd64'), /MISMATCH/)
  assert.throws(() => describeImages(payload, 'arm64'), /ARCH_UNSUPPORTED/)
  const readme = path.join(directory, 'tasks/service-case/public/README.md')
  await fs.writeFile(readme, 'changed public instructions')
  assert.throws(() => describeImages(payload, 'amd64'), /TASK_MISMATCH/)
  await fs.writeFile(readme, 'synthetic instructions')
  const inventoryPath = path.join(directory, 'agent-insight-assets.json')
  const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'))
  inventory.tasks['service-case'].registryImages['zsoft-local:target'] = `swr.example.test/team/other@sha256:${'d'.repeat(64)}`
  await fs.writeFile(inventoryPath, JSON.stringify(inventory))
  assert.throws(() => describeImages(payload, 'amd64'), /BUNDLE_MISMATCH/)
})

test('ZSoft publisher persists each successful image and resumes without repushing; mismatched manifest is rejected', async (t) => {
  python(await temporary(t), `
calls = []
def run(args, **kwargs):
    calls.append(args)
    if args[:3] == ['docker', 'image', 'inspect']:
        return json.dumps([{'Id': image_id, 'Architecture': 'amd64', 'Os': 'linux', 'RepoDigests': [reference]}])
    if args[:3] == ['docker', 'manifest', 'inspect']:
        return json.dumps({'config': {'digest': image_id}})
    return ''
output = root / 'mapping.json'
with patch.object(publisher, 'run', side_effect=run):
    publisher.publish(root, revision, ['service-case'], repo, output)
    assert ['docker', 'tag', 'zsoft-local:target', repo + ':service-case-target-' + 'b' * 16] in calls
    record = json.loads(output.read_text())['tasks']['service-case']['zsoft-local:target']
    assert record['tag'] == repo + ':service-case-target-' + 'b' * 16
    assert record['reference'] == reference
    assert any(command[1] == 'push' for command in calls)
    calls.clear()
    publisher.publish(root, revision, ['service-case'], repo, output)
    assert not any(command[1] in ('push', 'tag') for command in calls)
    assert ['docker', 'manifest', 'inspect', reference] in calls
before = output.read_bytes()
def broken(args, **kwargs):
    if args[:3] == ['docker', 'manifest', 'inspect']: return '{}'
    return run(args, **kwargs)
with patch.object(publisher, 'run', side_effect=broken):
    try: publisher.publish(root, revision, ['service-case'], repo, output)
    except AssetError: pass
    else: raise AssertionError('bad manifest accepted')
assert before == output.read_bytes()
`)
})

test('ZSoft build only calls official fetch-sources and prepare; plan never runs Docker or PoCs', async (t) => {
  python(await temporary(t), `
base = ['prepare-zsoft-images.py', '--root', str(root), '--revision', revision, '--all-userspace']
with patch.object(sys, 'argv', [base[0], 'plan', *base[1:]]), patch.object(publisher, 'run') as run:
    publisher.main()
    run.assert_not_called()
with patch.object(sys, 'argv', [base[0], 'build', *base[1:]]), patch.object(publisher, 'run') as run:
    publisher.main()
    assert len(run.call_args_list) == 2
    assert run.call_args_list[0].args[0][1:4] == ['-m', 'zsoft_poc', 'fetch-sources']
    assert run.call_args_list[1].args[0][1:4] == ['-m', 'zsoft_poc', 'prepare']
`)
})

test('ZSoft archive contains frozen assets only and rejects changed files', async (t) => {
  python(await temporary(t), `
freeze()
(root / '.cache').mkdir()
(root / '.cache/build-secret').write_text('excluded')
output = root.parent / (root.name + '.tar.gz')
try:
    packer.pack(root, output)
    with tarfile.open(output) as archive:
        names = archive.getnames()
        assert 'agent-insight-assets.json' in names
        assert '.task-state/service-case/image-refs.json' in names
        assert '.cache/build-secret' not in names
        assert 'mapping.json' not in names
        assert not any('sample-demo' in name or 'kernel-case' in name for name in names)
    (root / 'tasks/service-case/public/README.md').write_text('changed')
    try: packer.pack(root, output.with_suffix('.bad'))
    except AssetError: pass
    else: raise AssertionError('changed files accepted')
finally: output.unlink(missing_ok=True)
`)
})

test('ZSoft asset image context contains only frozen release files and carries immutable metadata', async (t) => {
  python(await temporary(t), `
freeze()
(root / '.cache').mkdir()
(root / '.cache/build-secret').write_text('excluded')
(root / '.runs').mkdir()
(root / '.runs/trace').write_text('excluded')
context = root.parent / (root.name + '-image-context')
metadata = assetImage.build_context(root, context, '20261014-v1')
assert metadata['schemaVersion'] == 'zsoft-release/v1'
assert metadata['bundleDigest'] == load_inventory(root)['bundleDigest']
assert (context / 'agent-insight-assets.json').exists()
assert (context / 'zsoft-release.json').exists()
assert (context / 'Dockerfile').read_text().count('COPY . /opt/agent-insight/zsoft-l1/\${RELEASE_ID}/') == 1
assert not (context / '.cache').exists()
assert not (context / '.runs').exists()
assert not (context / 'mapping.json').exists()
assert verify_task(context, load_inventory(context), 'service-case')['public']['taskId'] == 'service-case'
from verify_assets import verify
verify(context, '20261014-v1', metadata['bundleDigest'])
for release, digest in [('wrong-release', metadata['bundleDigest']), ('20261014-v1', 'sha256:' + '0' * 64)]:
    try: verify(context, release, digest)
    except ValueError: pass
    else: raise AssertionError('wrong release identity accepted')
(context / 'tasks/service-case/public/README.md').write_text('changed')
try: verify(context, '20261014-v1', metadata['bundleDigest'])
except AssetError: pass
else: raise AssertionError('changed asset accepted')
`)
})

test('ZSoft asset image installer requires a pinned image and reports the release volume path', () => {
  const script = path.resolve('scripts/benchmark/install-zsoft-assets-image.sh')
  const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /releases.*<release-id>/)
  const invalid = spawnSync('bash', [script, '--image', 'registry.example/zsoft:latest', '--release', '20261014-v1'], { encoding: 'utf8' })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /固定 sha256 digest/)
})

test('ZSoft runtime checks prepared image IDs without requiring original tags; remote doctor permits cold cache', async (t) => {
  python(await temporary(t), `
import entrypoint
freeze()
with patch.object(entrypoint, 'docker', return_value=image_id) as docker:
    entrypoint.inspect_images({'original:tag': image_id}, [{'key': 'original:tag', 'imageId': image_id}])
    assert docker.call_args.args[0][2] == image_id
for prepared in [[], [None], [{'key': 'wrong', 'imageId': image_id}]]:
    try: entrypoint.inspect_images({'original:tag': image_id}, prepared)
    except AssetError: pass
    else: raise AssertionError('bad prepared images accepted')
with patch.object(entrypoint, 'asset_root', return_value=root), patch.object(entrypoint, 'shared_mounts', return_value=[{'Destination': str(root), 'Source': str(root), 'Type': 'bind'}]), patch.object(entrypoint, 'docker', return_value='compose'), patch.object(entrypoint, 'inspect_images') as inspect:
    assert entrypoint.doctor() == 0
    inspect.assert_not_called()
`)
})

test('SWR runtime prefix is shared by publishing and evaluation; prebuilt remote failure never builds locally', async () => {
  const artifactDigest = `sha256:${'a'.repeat(64)}`
  const descriptor = runtimeDescriptor({ image: 'zsoft-runtime:artifact', artifactDigest, requiresPrebuiltRuntime: true }, 'swr.example.test/team')
  assert.equal(descriptor.image, 'swr.example.test/team/zsoft-runtime:artifact')
  assert.equal(runtimeDescriptor(descriptor, 'other.example/team'), descriptor)
  assert.throws(() => runtimeDescriptor({ image: 'runtime:v1' }, 'unqualified/team'))
  for (const fails of [false, true]) {
    const calls: string[][] = []
    let pulled = false
    const runner = async (_: unknown, args: string[]) => {
      calls.push(args)
      if (args[0] === 'pull') { if (fails) throw new Error('registry unavailable'); pulled = true; return { stdout: '' } }
      if (!pulled) throw new Error('not cached')
      return { stdout: artifactDigest }
    }
    if (fails) await assert.rejects(ensureOciRuntime(descriptor, { commandRunner: runner }), /registry unavailable/)
    else await ensureOciRuntime(descriptor, { commandRunner: runner })
    assert.ok(calls.some(args => args[0] === 'pull'))
    assert.ok(calls.every(args => args[0] !== 'build'))
  }
})

test('ZSoft fixed registry image uses the shared pool for cold pull, cache reuse and repull after eviction', async (t) => {
  const directory = await temporary(t)
  const ref = `swr.example.test/team/zsoft@sha256:${'c'.repeat(64)}`
  const image = { id: `sha256:${'b'.repeat(64)}`, size: 100, arch: 'amd64', references: [], digests: [ref] }
  let cached = false
  const pulls: string[] = []
  const store = {
    initialize: async () => ({ daemonId: 'synthetic-daemon', arch: 'x86_64' }),
    freeSpace: async () => 2000,
    refresh: async () => new Map(cached ? [[image.id, { Size: 100, SharedSize: 0 }]] : []),
    inspect: async (value: string) => cached && [ref, image.id].includes(value) ? image : null,
    referenced: async () => false,
    pull: async (value: string) => { pulls.push(value); cached = true; return image },
    remove: async () => { cached = false },
  }
  const pool = new BenchmarkImagePool({ dataDir: directory, store, lock: false, log: () => {}, estimator: { estimate: async () => ({ bytes: 100, source: 'test' }) }, config: { enabled: true, prefetch: false, reserveRatio: .3, highWatermark: .9, maxPulls: 2, waitMs: 1000 } })
  await pool.initialize()
  t.after(() => pool.close())
  const owner = { benchmarkKey: 'zsoft-l1', experimentId: 'synthetic', runId: 'synthetic' }
  const spec = { key: 'original:tag', arch: 'x86_64', references: [ref], context: { expectedImageId: image.id } }
  const [prepared] = await pool.acquire(owner, [spec])
  assert.equal(prepared.imageId, image.id)
  await pool.release(owner)
  await pool.acquire(owner, [spec])
  await pool.release(owner)
  assert.deepEqual(pulls, [ref])
  assert.equal(await pool.evictOne(true), true)
  await pool.acquire(owner, [spec])
  await pool.release(owner)
  assert.deepEqual(pulls, [ref, ref])
})

test('Runtime build command only pushes when explicitly requested and uses the same SWR image reference', () => {
  for (const push of [false, true]) {
    const output = execFileSync(process.execPath, ['-e', `
      const child = require('node:child_process')
      const original = child.spawnSync
      const calls = []
      child.spawnSync = (command, args, options) => {
        if (command !== 'docker') return original(command, args, options)
        calls.push(args)
        return { status: 0 }
      }
      require('./scripts/benchmark/generate-catalog.cjs').generate = () => []
      process.argv = ['node', 'builder', 'zsoft-l1', '--image-prefix', 'swr.example.test/team', ${push ? "'--push'" : ''}]
      require('./scripts/benchmark/build-evaluator-runtime.cjs')
      process.stdout.write(JSON.stringify(calls) + '\\n')
    `], { encoding: 'utf8' })
    const lines = output.trim().split('\n')
    const image = lines[0]
    const calls: string[][] = JSON.parse(lines[1])
    assert.match(image, /^swr\.example\.test\/team\/agent-insight-benchmark-runtime-zsoft-l1:/)
    assert.equal(calls[0][0], 'build')
    assert.equal(calls[0][calls[0].indexOf('--tag') + 1], image)
    assert.deepEqual(calls.slice(1), push ? [['push', image]] : [])
  }
})

test('Interrupted task-image publication retains completed references and resumes the remaining image', async (t) => {
  python(await temporary(t), `
second_id = 'sha256:' + 'd' * 64
second_ref = repo + '@sha256:' + 'e' * 64
(root / '.task-state/service-case/image-refs.json').write_text(json.dumps({'a_target_image': 'zsoft-local:target', 'b_driver_image': 'zsoft-local:driver'}))
output = root / 'partial-mapping.json'
calls = []
fail_driver = True
def run(args, **kwargs):
    calls.append(args)
    if args[:3] == ['docker', 'image', 'inspect']:
        driver = 'driver' in args[3] or args[3].endswith('d' * 16)
        return json.dumps([{'Id': second_id if driver else image_id, 'Architecture': 'amd64', 'Os': 'linux', 'RepoDigests': [second_ref if driver else reference]}])
    if args[:2] == ['docker', 'push'] and args[2].endswith('d' * 16) and fail_driver:
        raise RuntimeError('synthetic interrupted upload')
    if args[:3] == ['docker', 'manifest', 'inspect']:
        return json.dumps({'config': {'digest': second_id if args[3] == second_ref else image_id}})
    return ''
with patch.object(publisher, 'run', side_effect=run):
    try: publisher.publish(root, revision, ['service-case'], repo, output)
    except RuntimeError: pass
    else: raise AssertionError('failure expected')
    assert set(json.loads(output.read_text())['tasks']['service-case']) == {'zsoft-local:target'}
    calls.clear()
    fail_driver = False
    publisher.publish(root, revision, ['service-case'], repo, output)
    assert [args[2] for args in calls if args[1] == 'push'] == [repo + ':service-case-b-driver-' + 'd' * 16]
    assert len(json.loads(output.read_text())['tasks']['service-case']) == 2
`)
})

const kernelPrelude = `
state = root / '.task-state/kernel-case'
state.mkdir(parents=True)
refs = {'runner_image': 'zsoft-local:runner'}
for variant in ('vuln', 'fix'):
    directory = '.task-state/kernel-case/' + variant + '/artifacts'
    artifacts = root / directory
    (artifacts / 'rootfs-extra/root').mkdir(parents=True)
    (artifacts / 'bzImage').write_bytes(b'synthetic kernel; never booted')
    (artifacts / 'metadata.json').write_text(json.dumps({'memory_mb': 2048, 'smp': 2, 'boot_args': 'synthetic'}))
    (artifacts / 'rootfs-extra/root/module.ko').write_bytes(b'synthetic module; never loaded')
    refs[variant + '_artifact_dir'] = directory
    (state / variant / 'out').mkdir()
    (state / variant / 'out/build-cache').write_bytes(b'excluded')
(state / 'image-refs.json').write_text(json.dumps(refs))
def freeze_kernel():
    with patch.object(exporter.subprocess, 'run') as run:
        run.return_value.stdout = image_id
        exporter.export(root, revision, ['kernel-case'], root / 'kernel-dataset.json')
        assert len(run.call_args_list) == 1
        assert run.call_args.args[0][3] == 'zsoft-local:runner'
    return json.loads((root / 'kernel-dataset.json').read_text())[0]
`

test('kernel assets freeze both variants and modules, publish only the runner, and pack no build cache', async t => {
  const directory = await temporary(t)
  const caseData = JSON.parse(python(directory, kernelPrelude + `
assert select_tasks(root, [], 'kernel') == ['kernel-case']
assert select_tasks(root, [], 'all') == ['kernel-case', 'service-case']
calls = []
def run(args, **kwargs):
    calls.append(args)
    if args[:3] == ['docker', 'image', 'inspect']:
        return json.dumps([{'Id': image_id, 'Architecture': 'amd64', 'Os': 'linux', 'RepoDigests': [reference]}])
    if args[:3] == ['docker', 'manifest', 'inspect']:
        return json.dumps({'config': {'digest': image_id}})
    return ''
with patch.object(publisher, 'run', side_effect=run):
    mapping = publisher.publish(root, revision, ['kernel-case'], repo, root / 'kernel-mapping.json')
    assert list(mapping['tasks']['kernel-case']) == ['zsoft-local:runner']
    assert not any('_artifact_dir' in str(command) or '/artifacts' in str(command) for command in calls)
case = freeze_kernel()
assert case['public']['submissionKind'] == 'c'
inventory = load_inventory(root)
task = verify_task(root, inventory, 'kernel-case')
assert len(task['stateFiles']) == 7
output = root.parent / (root.name + '-kernel.tar.gz')
try:
    packer.pack(root, output)
    with tarfile.open(output) as archive:
        names = archive.getnames()
        assert '.task-state/kernel-case/vuln/artifacts/bzImage' in names
        assert '.task-state/kernel-case/fix/artifacts/rootfs-extra/root/module.ko' in names
        assert not any('/out/' in name for name in names)
finally: output.unlink(missing_ok=True)
print(json.dumps(case))
`))
  const previous = process.env.ZSOFT_L1_ASSETS_DIR
  process.env.ZSOFT_L1_ASSETS_DIR = directory
  t.after(() => { if (previous === undefined) delete process.env.ZSOFT_L1_ASSETS_DIR; else process.env.ZSOFT_L1_ASSETS_DIR = previous })
  const specs = describeImages(zsoftL1Adapter.imagePreparationInput(caseData.public, caseData.private), 'amd64')
  assert.equal(specs.length, 1)
  assert.equal(specs[0].key, 'zsoft-local:runner')
})

test('kernel asset validation rejects changed, missing, additional and redirected runtime files', async t => {
  python(await temporary(t), kernelPrelude + `
freeze_kernel()
inventory = load_inventory(root)
bzimage = state / 'vuln/artifacts/bzImage'
original = bzimage.read_bytes()
for change in ('tamper', 'missing', 'extra'):
    extra = state / 'fix/artifacts/extra.ko'
    if change == 'tamper': bzimage.write_bytes(b'changed')
    if change == 'missing': bzimage.unlink()
    if change == 'extra': extra.write_bytes(b'new')
    try: verify_task(root, inventory, 'kernel-case')
    except AssetError: pass
    else: raise AssertionError(change + ' accepted')
    bzimage.write_bytes(original)
    extra.unlink(missing_ok=True)
refs['vuln_artifact_dir'] = '.task-state/service-case/vuln/artifacts'
(state / 'image-refs.json').write_text(json.dumps(refs))
try: prepared_assets(root, 'kernel-case', ['kernel'])
except AssetError as error: assert str(error) == 'ZSOFT_KERNEL_ARTIFACTS_INVALID'
else: raise AssertionError('another task artifact directory accepted')
`)
})

test('kernel Compose policy runs two isolated variants and grants only the configured KVM device', async t => {
  python(await temporary(t), kernelPrelude + `
import copy
from docker_proxy import constrained_compose
policy = {'images': {'zsoft-local:runner': image_id}, 'evaluationId': 'eval-one', 'instanceId': 'instance', 'cpu': 4, 'memoryMiB': 8192, 'projectName': 'synthetic', 'assetRoot': str(root), 'track': 'kernel', 'kernelAcceleration': 'tcg'}
config = {'services': {variant: {'image': 'zsoft-local:runner', 'network_mode': 'none', 'read_only': True, 'environment': {'KERNEL_ACCEL': 'auto'}} for variant in ('vuln', 'fix')}}
for acceleration in ('tcg', 'kvm'):
    policy['kernelAcceleration'] = acceleration
    result = constrained_compose(copy.deepcopy(config), policy)
    for service in result['services'].values():
        assert service['image'] == image_id
        assert service['environment']['KERNEL_ACCEL'] == acceleration
        assert service['mem_limit'] == 4096 * 1024 * 1024
        assert service['cpus'] == 2
        assert bool(service.get('devices')) == (acceleration == 'kvm')
        assert not service.get('privileged')
        if acceleration == 'kvm': assert service['devices'] == [{'source': '/dev/kvm', 'target': '/dev/kvm', 'permissions': 'rw'}]
for devices, track, acceleration in [([{'source': '/dev/sda', 'target': '/dev/kvm'}], 'kernel', 'kvm'), ([{'source': '/dev/kvm', 'target': '/dev/kvm'}], 'userspace', 'kvm'), ([{'source': '/dev/kvm', 'target': '/dev/kvm'}], 'kernel', 'tcg')]:
    altered = copy.deepcopy(config)
    altered['services']['vuln']['devices'] = devices
    try: constrained_compose(altered, {**policy, 'track': track, 'kernelAcceleration': acceleration})
    except AssetError as error: assert str(error) == 'ZSOFT_COMPOSE_PRIVILEGE_FORBIDDEN'
    else: raise AssertionError('unexpected device access accepted')
`)
})

test('kernel preflight checks guest resource budgets and probes host KVM only when requested', async t => {
  python(await temporary(t), kernelPrelude + `
import entrypoint
freeze_kernel()
task = verify_task(root, load_inventory(root), 'kernel-case')
limits = {'cpu': 4, 'memoryMiB': 8192}
with patch.dict(entrypoint.os.environ, {'ZSOFT_KERNEL_ACCEL': 'tcg'}), patch.object(entrypoint, 'docker') as docker:
    assert entrypoint.kernel_policy(root, task, limits, 'eval-one') == {'track': 'kernel', 'kernelAcceleration': 'tcg'}
    docker.assert_not_called()
    for low in ({**limits, 'cpu': 1}, {**limits, 'memoryMiB': 4096}):
        try: entrypoint.kernel_policy(root, task, low, 'eval-one')
        except AssetError as error: assert str(error) == 'ZSOFT_KERNEL_RESOURCES_INSUFFICIENT'
        else: raise AssertionError('insufficient budget accepted')
with patch.dict(entrypoint.os.environ, {'ZSOFT_KERNEL_ACCEL': 'kvm'}), patch.object(entrypoint, 'docker', return_value='') as docker:
    assert entrypoint.kernel_policy(root, task, limits, 'eval-one')['kernelAcceleration'] == 'kvm'
    assert '/dev/kvm:/dev/kvm:rw' in docker.call_args.args[0]
    assert image_id in docker.call_args.args[0]
with patch.dict(entrypoint.os.environ, {'ZSOFT_KERNEL_ACCEL': 'kvm'}), patch.object(entrypoint, 'docker', side_effect=AssetError('ZSOFT_DOCKER_UNAVAILABLE')):
    try: entrypoint.kernel_policy(root, task, limits, 'eval-one')
    except AssetError as error: assert str(error) == 'ZSOFT_KERNEL_KVM_UNAVAILABLE'
    else: raise AssertionError('missing KVM accepted')
`)
})

test('frozen userspace and kernel releases merge offline without Docker or rebuilding existing images', async t => {
  python(await temporary(t), kernelPrelude + `
import shutil
freeze()
other = root.parent / (root.name + '-kernel')
output = root.parent / (root.name + '-combined.tar.gz')
installed = root.parent / (root.name + '-installed')
try:
    shutil.copytree(root, other)
    (other / 'agent-insight-assets.json').unlink()
    with patch.object(exporter.subprocess, 'run') as run:
        run.return_value.stdout = image_id
        exporter.export(other, revision, ['kernel-case'], other / 'kernel-dataset.json')
    with patch.object(publisher, 'run', side_effect=AssertionError('offline packaging must not call Docker')):
        packer.pack(root, output, [other])
    installed.mkdir()
    with tarfile.open(output) as archive:
        archive.extractall(installed, filter='data')
    merged = load_inventory(installed)
    assert set(merged['tasks']) == {'service-case', 'kernel-case'}
    for task_id in merged['tasks']: verify_task(installed, merged, task_id)
    assert merged['tasks']['service-case'] == load_inventory(root)['tasks']['service-case']
    changed = load_inventory(other)
    changed['revision'] = 'f' * 40
    changed.pop('bundleDigest')
    changed['bundleDigest'] = fingerprint(changed)
    (other / 'agent-insight-assets.json').write_text(json.dumps(changed))
    try: packer.pack(root, output.with_suffix('.bad'), [other])
    except AssetError as error: assert str(error) == 'ZSOFT_BUNDLE_MISMATCH'
    else: raise AssertionError('different upstream revisions merged')
finally:
    output.unlink(missing_ok=True)
    shutil.rmtree(other, ignore_errors=True)
    shutil.rmtree(installed, ignore_errors=True)
`)
})

test('kernel evaluator returns official results, preserves compile failures, and cleans timed out runs without a real judge', async t => {
  python(await temporary(t), kernelPrelude + `
import entrypoint
freeze_kernel()
case = json.loads((root / 'kernel-dataset.json').read_text())[0]
data = b'synthetic C source; never compiled'
descriptor = {'name': 'poc', 'mediaType': 'application/octet-stream', 'executionRunId': 'run-one', 'sizeBytes': len(data), 'sha256': digest_bytes(data)}
for status in ('completed', 'invalid_submission', 'timeout'):
    attempt = root / status
    (attempt / 'input').mkdir(parents=True)
    (attempt / 'output').mkdir()
    (attempt / 'input/poc').write_bytes(data)
    request = {'schemaVersion': 'evaluator-entrypoint/v1', 'evaluationJob': {'benchmark': {'key': 'zsoft-l1'}, 'evaluator': {'key': 'zsoft-l1'}, 'evaluationId': 'eval-' + status, 'executionRunId': 'run-one', 'payload': {**case['private'], 'taskId': 'kernel-case', 'submissionKind': 'c', 'maxBytes': 128}, 'limits': {'cpu': 4, 'memoryMiB': 8192, 'timeoutSeconds': 900}, 'artifacts': [descriptor]}, 'artifacts': [{'descriptor': descriptor, 'path': 'poc'}], 'preparedImages': [{'key': 'zsoft-local:runner', 'imageId': image_id}]}
    request_path = attempt / 'input/request.json'
    request_path.write_text(json.dumps(request))
    output_path = attempt / 'output/result.json'
    class Worker:
        pid = 123456
        returncode = 0
        def __init__(self, command, **kwargs):
            config = json.loads(Path(command[-1]).read_text())
            assert kwargs['env']['ZSOFT_KERNEL_ACCEL'] == 'tcg'
            policy = json.loads(Path(kwargs['env']['ZSOFT_PROXY_POLICY']).read_text())
            assert policy['track'] == 'kernel' and policy['kernelAcceleration'] == 'tcg'
            Path(config['recordPath']).write_text(json.dumps({'task_id': 'kernel-case', 'submission_sha256': descriptor['sha256'][7:], 'submission_bytes': len(data), 'submission_kind': 'final', 'phase': 'final', 'cleanup_exit_code': 0, 'result': {'status': status, 'success': status == 'completed'}}))
        def wait(self, **kwargs):
            if status == 'timeout': raise entrypoint.subprocess.TimeoutExpired('synthetic worker', 1)
        def poll(self): return 0
    with patch.dict(entrypoint.os.environ, {'ZSOFT_KERNEL_ACCEL': 'tcg', 'EVALUATOR_INSTANCE_ID': 'synthetic-instance'}), patch.object(entrypoint, 'asset_root', return_value=root), patch.object(entrypoint, 'shared_mounts', return_value=[{'Source': str(root), 'Destination': str(root), 'Type': 'bind'}]), patch.object(entrypoint, 'docker', return_value=image_id), patch.object(entrypoint.subprocess, 'Popen', Worker), patch.object(entrypoint, 'cleanup', return_value={'status': 'succeeded'}) as cleanup, patch.object(entrypoint, 'stop_worker') as stop:
        entrypoint.evaluate(request_path, output_path)
        cleanup.assert_called_once_with('eval-' + status)
        stop.assert_called_once()
    result = json.loads(output_path.read_text())
    completion = result['completion']
    assert completion['runtimeFacts']['track'] == 'kernel'
    assert completion['cleanup']['status'] == 'succeeded'
    if status == 'timeout':
        assert completion['status'] == 'failed'
        assert completion['error']['code'] == 'ZSOFT_EVALUATION_TIMEOUT'
        assert result['evidenceFiles'] == []
    else:
        assert completion['status'] == ('completed' if status == 'completed' else 'submission_invalid')
        assert completion['rawResult']['success'] == (status == 'completed')
        assert result['evidenceFiles'][0]['name'] == 'report.json'
`)
})
