import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

type Node = { type: string; props: { children?: Node | Node[] | string; [key: string]: unknown } }
function harness(fetcher: (url: string, options?: RequestInit) => Promise<Response>, browserCrypto: Partial<Crypto> = globalThis.crypto) {
  const slots: unknown[] = []
  let cursor = 0
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  let pending: Array<() => void> = []
  const storage = new Map<string, string>()
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
  const jsx = (type: string, props: Node['props']) => ({ type, props })
  const modules: Record<string, unknown> = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@/lib/client/api': { apiFetch: fetcher }, './api': { apiFetch: fetcher } }
  function load(file: string) {
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const exports: Record<string, unknown> = {}
    new Function('require', 'exports', 'window', 'sessionStorage', 'crypto', code)(
      (id: string) => { assert(id in modules, id); return modules[id] }, exports,
      { setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout },
      { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, browserCrypto,
    )
    return exports
  }
  modules['@/lib/safe-uuid'] = load('src/lib/safe-uuid.ts')
  modules['@/lib/client/use-execution-environment'] = load('src/lib/client/use-execution-environment.ts')
  modules['@/lib/client/start-same-config-experiment'] = load('src/lib/client/start-same-config-experiment.ts')
  const { SameConfigExperimentAction } = load('src/components/eval/SameConfigExperimentAction.tsx') as { SameConfigExperimentAction: (props: unknown) => Node }
  const started: string[] = []
  let busy = false
  return {
    started, storage,
    unmount: () => { for (const effect of effects.values()) effect.cleanup?.() },
    render: () => {
      cursor = 0
      const tree = SameConfigExperimentAction({ user: 'user', sourceExperimentId: 'source', disabled: busy, onBusyChange: (value: boolean) => { busy = value }, onStarted: (id: string) => started.push(id) })
      const callbacks = pending; pending = []; callbacks.forEach(fn => fn())
      const nodes: Node[] = []
      const visit = (node: unknown) => {
        if (!node || typeof node !== 'object') return
        const item = node as Node
        nodes.push(item)
        const children = item.props.children
        if (Array.isArray(children)) children.forEach(visit); else visit(children)
      }
      visit(tree)
      const button = nodes.find(node => node.type === 'button')!
      const notice = nodes.find(node => node.type === 'p')
      return { label: button.props.children, disabled: button.props.disabled, message: notice?.props.children, role: notice?.props.role,
        click: () => (button.props.onClick as () => void)() }
    },
  }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const task = (state: string, message = '') => json({ taskId: 'env-task', contextDigest: 'digest', state, message, issues: [] })
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)) }
  assert.fail('condition not reached')
}

test('same-config waits through preparation, ignores repeated clicks, then creates and starts once', async () => {
  const calls: string[] = []
  let release!: (value: Response) => void
  const view = harness(async (url, options) => {
    calls.push(`${options?.method || 'GET'} ${url}`)
    if (url.includes('environment-preparations?')) {
      assert.deepEqual(Object.keys(JSON.parse(String(options?.body))).sort(), ['requestId', 'sourceExperimentId'])
      return task('preparing', '正在准备运行环境，首次可能需要几分钟。')
    }
    if (url.includes('environment-preparations/')) return new Promise(resolve => { release = resolve })
    if (url === '/api/experiments') return json({ id: 'new' })
    return json({})
  })
  const initial = view.render()
  assert.equal(initial.label, '同配置实验')
  initial.click(); initial.click()
  assert.equal(view.render().label, '环境检查中…')
  assert.equal(view.render().message, undefined)
  await until(() => Boolean(release))
  assert.equal(view.render().label, '环境准备中…')
  assert.equal(view.render().disabled, true)
  assert.match(String(view.render().message), /首次可能需要几分钟/)
  assert.equal(calls.length, 2)
  release(task('ready'))
  await until(() => view.started.length === 1)
  assert.deepEqual(view.started, ['new'])
  assert.deepEqual(calls.slice(2), ['POST /api/experiments', 'POST /api/experiments/new/run?user=user'])
  assert.equal(view.storage.size, 0)
})

test('manual-action and failed results stay on the row; retry rechecks with a fresh request', async () => {
  for (const state of ['needs_action', 'failed']) {
    const requests: string[] = []
    const view = harness(async (url, options) => {
      if (url.includes('environment-preparations')) {
        requests.push(JSON.parse(String(options?.body)).requestId)
        return requests.length === 1 ? task(state, '主机 119：请配置 API 凭据后点击“下一步”。') : task('ready')
      }
      if (url === '/api/experiments') return json({ id: 'new' })
      return json({})
    })
    view.render().click()
    await until(() => view.render().label === '重试')
    assert.deepEqual(view.started, [])
    assert.equal(view.render().role, 'alert')
    assert.match(String(view.render().message), /119.*重试/)
    view.render().click()
    await until(() => view.started.length === 1)
    assert.notEqual(requests[0], requests[1])
  }
})

test('ready and existing-Trace skip immediately start without an environment notice', async () => {
  for (const response of [() => task('ready'), () => json({ state: 'skipped' })]) {
    const view = harness(async url => url.includes('environment-preparations') ? response() : json(url === '/api/experiments' ? { id: 'new' } : {}))
    view.render().click()
    await until(() => view.started.length === 1)
    assert.equal(view.render().message, undefined)
  }
})

test('ordinary preparation does not invent a first-install duration; leaving prevents delayed start', async () => {
  const calls: string[] = []
  let release!: (value: Response) => void
  const view = harness(async url => {
    calls.push(url)
    return calls.length === 1 ? task('preparing', '正在准备运行环境…') : new Promise(resolve => { release = resolve })
  })
  view.render().click()
  await until(() => Boolean(release))
  assert.doesNotMatch(String(view.render().message), /几分钟/)
  view.unmount()
  release(task('ready'))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(calls.length, 2)
  assert.deepEqual(view.started, [])
})

test('Skill clone starts its independent task and explicit start rejection cleans up the new draft', async () => {
  for (const fail of [false, true]) {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    const view = harness(async (url, options) => {
      calls.push({ url, method: options?.method, body: options?.body ? JSON.parse(String(options.body)) : undefined })
      if (url.includes('environment-preparations')) return task('ready')
      if (url === '/api/experiments') return json({ id: 'new', grayscaleTaskId: 'skill-task', caseIds: ['c'], evaluatorIds: ['e'] })
      if (url.includes('/api/debug/')) return fail ? json({ error: '模型配置失效' }, 409) : json({})
      return json({})
    })
    view.render().click()
    await until(() => fail ? view.render().label === '重试' : view.started.length === 1)
    assert.deepEqual(calls[2], { url: '/api/debug/grayscale-tasks/skill-task', method: 'POST', body: { user: 'user', action: 'start', caseIds: ['c'], evaluators: ['e'] } })
    if (fail) {
      assert.equal(calls[3].method, 'DELETE')
      assert.match(String(view.render().message), /模型配置失效/)
      assert.deepEqual(view.started, [])
    }
  }
})


test('same-config also checks and starts over HTTP without crypto.randomUUID', async () => {
  const requests: string[] = []
  const view = harness(async (url, options) => {
    if (url.includes('environment-preparations')) {
      requests.push(JSON.parse(String(options?.body)).requestId)
      return task('ready')
    }
    return json(url === '/api/experiments' ? { id: 'new' } : {})
  }, { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
  view.render().click()
  await until(() => view.started.length === 1)
  assert.equal(requests.length, 1)
  assert.match(requests[0], /^[A-Za-z0-9_-]{8,100}$/)
})
