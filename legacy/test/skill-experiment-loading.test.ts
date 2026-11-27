import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/components/skill-workbench/SkillExperimentResult.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('SkillExperimentResult.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Node | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'load' && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);assert.ok(callback);
const compiled = ts.transpileModule(`const load = (${callback.getText(ast)});`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
type Detail = {id: string; configSnapshot: Record<string, unknown>};
function harness(responses: Array<Promise<Response>>) {
  const state = {loading: true, detail: null as Detail | null, error: '', refreshFailed: false};
  const scope = {
    loadSequence: {current: 0}, dataset: null, experimentId: 'experiment', skillName: 'fixture', user: 'test@example.com', version: 1,
    apiFetch: async (url: string) => url.startsWith('/api/experiments/') ? await responses.shift()! : Response.json({experiments: []}),
    setLoading: (value: boolean) => {state.loading = value;},
    setError: (value: string) => {state.error = value;},
    setRefreshFailed: (value: boolean) => {state.refreshFailed = value;},
    setDetail: (update: (previous: Detail | null) => Detail) => {state.detail = update(state.detail);},
    setWorkbenchExperiment: () => {}, setDataset: () => {},
  };
  const load = new Function(...Object.keys(scope), `${compiled}\nreturn load;`)(...Object.values(scope)) as (silent?: boolean) => Promise<void>;
  return {state, load};
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => {resolve = done;});
  return {promise, resolve};
}
const success = () => Response.json({id: 'experiment', configSnapshot: {}});

test('前台事务失败与后台刷新交错后，成功结果结束加载状态', async () => {
  const first = deferred();
  const h = harness([first.promise, Promise.resolve(success())]);
  const foreground = h.load();
  await h.load(true);
  first.resolve(Response.json({error: 'Transaction expired'}, {status: 500}));
  await foreground;
  assert.equal(h.state.detail?.id, 'experiment');
  assert.equal(h.state.loading, false);
  assert.equal(h.state.refreshFailed, false);
  assert.equal(h.state.error, '');
});

test('旧后台请求结束不能清掉更新的前台请求加载状态', async () => {
  const old = deferred(), current = deferred();
  const h = harness([old.promise, current.promise]);
  const background = h.load(true), foreground = h.load();
  old.resolve(success());await background;
  assert.equal(h.state.loading, true);
  current.resolve(success());await foreground;
  assert.equal(h.state.loading, false);
  assert.equal(h.state.detail?.id, 'experiment');
});

test('当前前台请求失败结束加载并保留错误信息', async () => {
  const h = harness([Promise.resolve(Response.json({error: 'Transaction expired'}, {status: 500}))]);
  await h.load();
  assert.equal(h.state.loading, false);
  assert.equal(h.state.detail, null);
  assert.equal(h.state.error, 'Transaction expired');
  assert.equal(h.state.refreshFailed, true);
});
