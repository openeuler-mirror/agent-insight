/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
const wizardFunctions: Record<string, string> = {}
let backClickCode = ''
let backDisabledCode = ''
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ['advanceFromTrace', 'refreshAgents', 'goTo'].includes(node.name.getText(wizard))) {
    const initializer = node.initializer!
    wizardFunctions[node.name.getText(wizard)] = (ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer).getText(wizard)
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(wizard) === 'button' && node.children.some(child => ts.isJsxText(child) && child.text.includes('‹ 返回'))) {
    for (const property of node.openingElement.attributes.properties) {
      if (!ts.isJsxAttribute(property) || !property.initializer || !ts.isJsxExpression(property.initializer)) continue
      if (property.name.getText(wizard) === 'onClick') backClickCode = property.initializer.expression!.getText(wizard)
      if (property.name.getText(wizard) === 'disabled') backDisabledCode = property.initializer.expression!.getText(wizard)
    }
  }
  ts.forEachChild(node, visit)
}
visit(wizard)
function advanceHarness(targets: unknown[], current = true, requiresExecution = true, overrides: { check?: () => Promise<boolean>; refresh?: () => Promise<unknown[]> } = {}) {
  const steps: number[] = []
  const keys: string[] = []
  const errors: string[] = []
  const routes: string[] = []
  const locks: boolean[] = []
  const deps = { step2Valid: true, environmentBusy: false, traceAdvanceRef: { current: false }, agentsRequestIdRef: { current: 0 }, setAdvancingTrace: (value: boolean) => locks.push(value),
    environmentSelection: requiresExecution ? selection : null, setSelectedTargetKey: (key: string) => keys.push(key),
    environment: { check: overrides.check || (async () => true), isCurrent: () => current, fail: (message: string) => errors.push(message) },
    refreshAgents: overrides.refresh || (async () => [{ targets }]), isBenchmarkDataset: false, selectedDataset: null,
    router: { push: (path: string) => routes.push(path), replace: (path: string) => routes.push(path), refresh: () => routes.push('refresh') },
    onBack: () => routes.push('back'),
    setStep: (step: number) => steps.push(step), setMaxVisited: () => {},
  }
  const code = ts.transpileModule(`const advance = ${wizardFunctions.advanceFromTrace}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const advance = new Function(...Object.keys(deps), `${code}; return advance`)(...Object.values(deps)) as () => Promise<void>
  return { advance, steps, keys, errors, routes, locks, deps }
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


function evaluate<T>(expression: string, dependencies: Record<string, unknown>): T {
  const code = ts.transpileModule(`const evaluated = ${expression}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(dependencies), `${code}; return evaluated`)(...Object.values(dependencies)) as T
}

test('preparation and target refresh advance only once to step 3 without list navigation or page refresh', async () => {
  let finishCheck!: (ready: boolean) => void
  let finishRefresh!: (targets: unknown[]) => void
  const target = { workerId: selection.clientId, platform: selection.platform, agent: selection.agent }
  const view = advanceHarness([], true, true, {
    check: () => new Promise(resolve => { finishCheck = resolve }),
    refresh: () => new Promise(resolve => { finishRefresh = resolve }),
  })
  const pending = view.advance()
  await view.advance()
  assert.deepEqual(view.steps, [])
  assert.equal(view.deps.traceAdvanceRef.current, true)
  assert.deepEqual(view.locks, [true])
  finishCheck(true)
  await Promise.resolve()
  assert.deepEqual(view.steps, [])
  assert.equal(view.deps.traceAdvanceRef.current, true)
  finishRefresh([{ targets: [target] }])
  await pending
  assert.deepEqual(view.steps, [3])
  assert.deepEqual(view.routes, [])
  assert.deepEqual(view.locks, [true, false])
  assert.equal(view.deps.traceAdvanceRef.current, false)
})

test('manual action, refresh failure or leaving during refresh cannot navigate away from the wizard', async () => {
  const manual = advanceHarness([], true, true, { check: async () => false })
  await manual.advance()
  assert.deepEqual(manual.steps, [])
  assert.deepEqual(manual.routes, [])
  const failed = advanceHarness([], true, true, { refresh: async () => { throw new Error('offline') } })
  await failed.advance()
  assert.deepEqual(failed.steps, [])
  assert.deepEqual(failed.routes, [])
  assert.match(failed.errors[0], /刷新失败/)
  const left = advanceHarness([], false, true, { refresh: async () => { throw new Error('offline') } })
  await left.advance()
  assert.deepEqual(left.steps, [])
  assert.deepEqual(left.routes, [])
  assert.deepEqual(left.errors, [])
})

test('late host refreshes cannot overwrite a newer result or mutate state after invalidation', async () => {
  const responses: Array<(response: Response) => void> = []
  const snapshots: unknown[][] = []
  const sequence = { current: 0 }
  const preparation = { current: false }
  const refresh = evaluate<(confirmPreparation?: boolean) => Promise<unknown[]>>(wizardFunctions.refreshAgents, {
    user: 'user', agentsRequestIdRef: sequence, traceAdvanceRef: preparation, apiFetch: () => new Promise(resolve => responses.push(resolve)),
    setAgents: (value: unknown[]) => snapshots.push(value),
  })
  const old = refresh()
  const ready = refresh()
  responses[1](new Response(JSON.stringify({ agents: [{ name: 'ready-host' }] })))
  await ready
  responses[0](new Response(JSON.stringify({ agents: [{ name: 'old-host' }] })))
  await old
  assert.deepEqual(snapshots, [[{ name: 'ready-host' }]])
  const unmounted = refresh()
  sequence.current += 1
  responses[2](new Response(JSON.stringify({ agents: [] })))
  await unmounted
  assert.equal(snapshots.length, 1)
  preparation.current = true
  assert.deepEqual(await refresh(), [])
  assert.equal(responses.length, 3)
  const confirmation = refresh(true)
  responses[3](new Response(JSON.stringify({ agents: [{ name: 'confirmed-host' }] })))
  await confirmation
  assert.deepEqual(snapshots[1], [{ name: 'confirmed-host' }])
})

test('header back and step navigation stay locked until preparation and target refresh finish', () => {
  const routes: string[] = []
  const steps: number[] = []
  const traceAdvanceRef = { current: true }
  const dependencies = { environmentBusy: false, traceAdvanceRef, onBack: undefined,
    router: { push: (path: string) => routes.push(path) }, step: 2, step2Valid: true,
    advanceFromTrace: () => assert.fail('unexpected preparation'), setStep: (step: number) => steps.push(step), setMaxVisited: () => {},
  }
  const back = evaluate<() => void>(backClickCode, dependencies)
  const goTo = evaluate<(step: number) => void>(wizardFunctions.goTo, dependencies)
  back(); goTo(1)
  assert.deepEqual(routes, [])
  assert.deepEqual(steps, [])
  assert.equal(evaluate(backDisabledCode, { environmentBusy: true }), true)
  traceAdvanceRef.current = false
  back(); goTo(1)
  assert.deepEqual(routes, ['/experiments'])
  assert.deepEqual(steps, [1])
})
