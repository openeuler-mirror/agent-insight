import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import type { EnvironmentSelection } from '../src/lib/client/use-execution-environment'

const hookCode = ts.transpileModule(fs.readFileSync('src/lib/client/use-execution-environment.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const selection: EnvironmentSelection = { datasetId: 'dataset', clientId: 'host-a', platform: 'opencode', agent: 'build', model: '', caseIds: ['case'], mode: 'generate', timeoutSeconds: 600, concurrency: 1 }
const task = (state: string) => new Response(JSON.stringify({ taskId: 'task', contextDigest: 'digest', state, message: state === 'needs_action' ? '配置 API Key' : '' }))
function harness(fetcher: (url: string, options?: RequestInit) => Promise<Response>, browserCrypto: Partial<Crypto> | undefined = globalThis.crypto) {
  const slots: unknown[] = []
  let cursor = 0
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  let pending: Array<() => void> = []
  const storage = new Map<string, string>()
  const exports: Record<string, typeof import('../src/lib/client/use-execution-environment').useExecutionEnvironment> = {}
  const react = {
    useRef: (initial: unknown) => { const i = cursor++; return slots[i] ||= { current: initial } },
    useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: unknown) => { slots[i] = value }] },
    useCallback: (callback: unknown) => { cursor++; return callback },
    useEffect: (callback: () => (() => void) | undefined, deps: unknown[]) => {
      const i = cursor++
      const old = effects.get(i)
      if (!old || deps.some((value, index) => value !== old.deps[index])) pending.push(() => { old?.cleanup?.(); effects.set(i, { deps, cleanup: callback() }) })
    },
  }
  const uuidCode = ts.transpileModule(fs.readFileSync('src/lib/safe-uuid.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const uuid = {}
  new Function('exports', 'crypto', uuidCode)(uuid, browserCrypto)
  new Function('require', 'exports', 'window', 'sessionStorage', 'crypto', hookCode)(
    (name: string) => name === 'react' ? react : name === '@/lib/safe-uuid' ? uuid : { apiFetch: fetcher }, exports,
    { setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout },
    { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, browserCrypto,
  )
  return { storage, render: (value: EnvironmentSelection = selection) => { cursor = 0; const result = exports.useExecutionEnvironment('user', value); const callbacks = pending; pending = []; callbacks.forEach(fn => fn()); return result } }
}

test('selection alone never checks; manual configuration retries use a new request', async () => {
  const requests: string[] = []
  const view = harness(async (_url, options) => { requests.push(JSON.parse(String(options?.body)).requestId); return task(requests.length === 1 ? 'needs_action' : 'ready') })
  let hook = view.render()
  assert.equal(requests.length, 0)
  assert.equal(await hook.check(), false)
  hook = view.render()
  assert.equal(hook.failed, true)
  assert.match(hook.message, /API Key/)
  assert.equal(await hook.check(), true)
  assert.notEqual(requests[0], requests[1])
})

test('automatic preparation polls until ready and repeated clicks do not create a second task', async () => {
  const methods: string[] = []
  const states = ['checking', 'preparing', 'ready']
  const view = harness(async (_url, options) => { methods.push(options?.method || 'GET'); return task(states[methods.length - 1]) })
  const hook = view.render()
  const pending = hook.check()
  assert.equal(await hook.check(), false)
  assert.equal(await pending, true)
  assert.deepEqual(methods, ['POST', 'GET', 'GET'])
  assert.equal(view.render().busy, false)
  assert.equal(view.render().message, '')
})

test('missing or conflicting tasks can be retried instead of permanently reusing their ids', async () => {
  for (const status of [404, 409, 410]) {
    const methods: string[] = []
    const view = harness(async (_url, options) => { methods.push(options?.method || 'GET'); return methods.length === 1 ? new Response('{}', { status }) : task('ready') })
    view.storage.set('experiment-environment:user', JSON.stringify({ key: JSON.stringify(selection), taskId: 'lost', requestId: 'old-request' }))
    assert.equal(await view.render().check(), false)
    assert.equal(await view.render().check(), true)
    assert.deepEqual(methods, ['GET', 'POST'])
  }
})

test('restored terminal tasks are checked again and uncertain POST retries preserve idempotency', async () => {
  for (const state of ['ready', 'needs_action', 'failed']) {
    const methods: string[] = []
    const view = harness(async (_url, options) => { methods.push(options?.method || 'GET'); return task(methods.length === 1 ? state : 'ready') })
    view.storage.set('experiment-environment:user', JSON.stringify({ key: JSON.stringify(selection), taskId: 'old', requestId: 'old-request' }))
    assert.equal(await view.render().check(), true)
    assert.deepEqual(methods, ['GET', 'POST'])
  }
  const ids: string[] = []
  const view = harness(async (_url, options) => { ids.push(JSON.parse(String(options?.body)).requestId); if (ids.length === 1) throw new Error('connection interrupted'); return task('ready') })
  assert.equal(await view.render().check(), false)
  assert.equal(await view.render().check(), true)
  assert.equal(ids[0], ids[1])
})

test('late results cannot advance a changed selection or overwrite its saved task', async () => {
  let resolveFirst!: (value: Response) => void
  let calls = 0
  const view = harness(async () => ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve }) : task('ready'))
  const old = view.render()
  const pending = old.check()
  const next = view.render({ ...selection, clientId: 'host-b' })
  assert.equal(await next.check(), true)
  resolveFirst(task('ready'))
  assert.equal(await pending, false)
  assert.equal(old.isCurrent(), false)
  assert.equal(view.storage.size, 0)
})

const wizard = ts.createSourceFile('wizard.tsx', fs.readFileSync('src/components/eval/ExperimentWizard.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let advanceCode = ''
function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(wizard) === 'advanceFromTrace') advanceCode = node.initializer!.getText(wizard); ts.forEachChild(node, visit) }
visit(wizard)
function advanceHarness(targets: unknown[], current = true, requiresExecution = true) {
  const steps: number[] = []
  const keys: string[] = []
  const errors: string[] = []
  const deps = { step2Valid: true, environmentBusy: false, traceAdvanceRef: { current: false }, setAdvancingTrace: () => {},
    environmentSelection: requiresExecution ? selection : null, setSelectedTargetKey: (key: string) => keys.push(key),
    environment: { check: async () => true, isCurrent: () => current, fail: (message: string) => errors.push(message) },
    refreshAgents: async () => [{ targets }], isBenchmarkDataset: false, selectedDataset: null,
    setStep: (step: number) => steps.push(step), setMaxVisited: () => {},
  }
  const code = ts.transpileModule(`const advance = ${advanceCode}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const advance = new Function(...Object.keys(deps), `${code}; return advance`)(...Object.values(deps)) as () => Promise<void>
  return { advance, steps, keys, errors }
}

test('post-check target refresh keeps the checked host and rejects disappearing or stale targets', async () => {
  const target = { workerId: selection.clientId, platform: selection.platform, agent: selection.agent }
  const valid = advanceHarness([{ ...target, workerId: 'host-b' }, target])
  await valid.advance()
  assert.deepEqual(valid.steps, [3])
  assert.deepEqual(valid.keys, ['host-a::opencode'])
  const missing = advanceHarness([{ ...target, workerId: 'host-b' }])
  await missing.advance()
  assert.deepEqual(missing.steps, [])
  assert.equal(missing.errors.length, 1)
  const stale = advanceHarness([target], false)
  await stale.advance()
  assert.deepEqual(stale.steps, [])
  const traces = advanceHarness([], true, false)
  await traces.advance()
  assert.deepEqual(traces.steps, [3])
})


test('HTTP browsers without randomUUID can submit, retry and recover environment checks', async () => {
  const browserCrypto = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) }
  const ids: string[] = []
  const view = harness(async (_url, options) => {
    ids.push(JSON.parse(String(options?.body)).requestId)
    return task(ids.length === 1 ? 'needs_action' : 'ready')
  }, browserCrypto)
  assert.equal(await view.render().check(), false)
  assert.equal(await view.render().check(), true)
  assert.notEqual(ids[0], ids[1])
  ids.forEach(id => assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
  const methods: string[] = []
  const restored = harness(async (_url, options) => { methods.push(options?.method || 'GET'); return task('ready') }, browserCrypto)
  restored.storage.set('experiment-environment:user', JSON.stringify({ key: JSON.stringify(selection), taskId: 'old-ready', requestId: 'old-request' }))
  assert.equal(await restored.render().check(), true)
  assert.deepEqual(methods, ['GET', 'POST'])
})
