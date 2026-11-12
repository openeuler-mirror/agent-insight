import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function handlers(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const filename = 'src/components/skill-workbench/OptimizationRecordsPanel.tsx'
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const component = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'OptimizationRecordsPanel') as ts.FunctionDeclaration
  const statements = component.body!.statements
  const names = ['readError', 'previewDeployment', 'confirmDeployment']
  const functions = statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text || '')).map(n => n.getText(source)).join('\n')
  const declarations = statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
    .filter(d => ['deploymentEndpoint', 'deploymentBody'].includes(d.name.getText(source)))
    .map(d => `const ${d.getText(source)};`).join('\n')
  const states: any[] = []
  const context = vm.createContext({ exports: {}, process: { env: { NEXT_PUBLIC_URL_PREFIX: '/insight' } }, Headers, Error,
    fetch: fetcher, selected: { id: 'optimization-fixture', skillName: 'my skill' }, user: 'fixture-user',
    deployment: { preview: { deployable: true } }, setDeployment: (value: any) => states.push(value),
    setTimeout: (fn: () => void) => { fn(); return 0 }, crypto: { randomUUID: () => 'fixed-request-id' } })
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInContext(compile(fs.readFileSync('src/lib/client/api.ts', 'utf8')), context)
  vm.runInContext(compile(declarations + '\n' + functions), context)
  return { context, states, run: (name: string) => vm.runInContext(`${name}()`, context) as Promise<void> }
}

test('Skill deployment preview, create and status use the configured URL prefix', async () => {
  const requests: Array<{ url: string; method: string }> = []
  const h = handlers(async (url, init) => {
    requests.push({ url, method: init?.method || 'GET' })
    if (url.endsWith('/preview')) return Response.json({ deployable: true })
    return Response.json({ deployment: { deploymentId: 'deployment-fixture', status: 'SUCCEEDED' } })
  })
  await h.run('previewDeployment')
  await h.run('confirmDeployment')
  assert.equal(requests.length, 3)
  assert.ok(requests.every(r => r.url.startsWith('/insight/api/skills/by-name/my%20skill/deployments')), JSON.stringify(requests))
  assert.equal(requests[2].method, 'GET')
  assert.equal(h.states.at(-1).phase, 'succeeded')
})

test('Skill deployment network errors leave a recoverable failed state', async () => {
  for (const action of ['previewDeployment', 'confirmDeployment']) {
    const h = handlers(async () => { throw new Error('network unreachable') })
    await assert.doesNotReject(h.run(action))
    assert.equal(h.states.at(-1).phase, 'failed')
    assert.match(h.states.at(-1).error, /network unreachable/)
  }
})
