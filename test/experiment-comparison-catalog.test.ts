import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const wizard = fs.readFileSync(new URL('../src/components/experiments/ExperimentWizard.tsx', import.meta.url), 'utf8');
const start = wizard.indexOf('  // 对比模式：选定 Agent 后查该 Agent');
const end = wizard.indexOf('  const appendTraceFilters', start);
const effectCode = ts.transpileModule(wizard.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function loadCatalog(type: string, items: unknown[], failed = false) {
  let models: string[] = ['old-model'];
  let skills: string[] = ['old-skill'];
  const requests: string[] = [];
  const effect = new Function('useEffect', 'apiFetch', 'setAgentModels', 'setAgentSkills', 'user', 'agentName', 'expType', effectCode);
  effect((run: () => void) => run(), (url: string) => {
    requests.push(url);
    return failed ? Promise.reject(new Error('catalog unavailable')) : Promise.resolve({ ok: true, json: async () => ({ items }) });
  }, (values: string[]) => { models = values; }, (values: string[]) => { skills = values; }, 'test-user', 'agent-a', type);
  await new Promise<void>(resolve => setImmediate(resolve));
  return { models, skills, requests };
}

test('Skill 对比复用一次目录请求，提取去重的 Skill 和版本候选', async () => {
  const result = await loadCatalog('skill', [
    { model: 'model-a', skillName: 'credit-check', skillVersion: 2 },
    { model: 'model-a', skillName: 'credit-check', skillVersion: 2 },
    { model: 'model-b', skillName: 'credit-check', skillVersion: 1 },
    { model: 'model-b', skillName: 'balance-query', skillVersion: null },
  ]);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.skills, ['credit-check@v2', 'credit-check@v1', 'balance-query']);
  assert.deepEqual(result.models, ['model-a', 'model-b']);
});

test('空、缺失或结构化 Skill 信息不冒充已确认无 Skill 配置', async () => {
  const result = await loadCatalog('skill', [
    {}, { skillName: null }, { skillName: '' }, { skillName: '  ' },
    { skillName: ['a', 'b'] }, { skillName: '["a","b"]' }, { skillName: '{"name":"a"}' },
    { skillName: '__NONE__' },
  ]);
  assert.deepEqual(result.skills, []);
});

test('LLM 对比仍使用原请求，目录失败时不残留旧 Skill 候选', async () => {
  assert.deepEqual((await loadCatalog('llm', [{ model: 'model-a', skillName: 'a' }])).models, ['model-a']);
  const failed = await loadCatalog('skill', [], true);
  assert.deepEqual(failed.models, []);
  assert.deepEqual(failed.skills, []);
});

function datasetSelectionError(dataset: unknown, datasetB?: unknown, comparing = false) {
  const workspace = fs.readFileSync(new URL('../src/components/evaluation-harness/Workspace.tsx', import.meta.url), 'utf8');
  const source = ts.createSourceFile('Workspace.tsx', workspace, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'datasetSelectionError');
  assert.ok(declaration, 'Workspace must check selected dataset availability before continuing');
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${code}; return datasetSelectionError;`)()(dataset, datasetB, comparing) as string;
}

test('删除后的共享数据集保留版本信息并阻止实验继续', () => {
  const selected = { name: '贷款验收集', version: 5, archived: true };
  assert.match(datasetSelectionError(selected), /贷款验收集.*v5.*已删除/);
  assert.equal(selected.archived, true);
  assert.equal(datasetSelectionError({ ...selected, archived: false }), '');
});

test('评测集对比独立检查 B 组删除状态和两组缺失选择', () => {
  const selected = { name: '贷款验收集', version: 5, archived: false };
  assert.match(datasetSelectionError(selected, { ...selected, version: 4, archived: true }, true), /B 组.*v4.*已删除/);
  assert.match(datasetSelectionError(undefined, selected, true), /A 组.*请选择/);
  assert.match(datasetSelectionError(selected, undefined, true), /B 组.*请选择/);
  assert.equal(datasetSelectionError(selected, { ...selected, version: 4 }, true), '');
});
