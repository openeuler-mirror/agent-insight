import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sidebarSource = fs.readFileSync(
  path.resolve(here, '../src/components/shell/AppSidebar.tsx'),
  'utf8',
);

function definition(name: string, nextName: string): string {
  const start = sidebarSource.indexOf(`const ${name}`);
  const end = sidebarSource.indexOf(`const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} definition must exist`);
  assert.notEqual(end, -1, `${nextName} definition must follow ${name}`);
  return sidebarSource.slice(start, end);
}

function visibleHrefs(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .flatMap((line) => [...line.matchAll(/href: '([^']+)'/g)].map((match) => match[1]));
}

test('830 transfer sidebar exposes Trace and Evaluation under Agent Workspace', () => {
  const observeTree = definition('OBSERVE_TREE', 'AGENT_GROUP');
  assert.match(observeTree, /href: '\/trace'/);
  assert.doesNotMatch(observeTree, /href: '\/fault'/);

  const agentGroup = definition('AGENT_GROUP', 'CONFIG_GROUP');
  assert.match(agentGroup, /items:\s*\[\s*OBSERVE_TREE,\s*EVAL_TREE,?\s*\][\s\S]*?};/);
});

test('830 transfer sidebar exposes only Model Registry and Installation under Configuration', () => {
  const configGroup = definition('CONFIG_GROUP', 'GROUPS');
  assert.deepEqual(visibleHrefs(configGroup), [
    '/modelconfig/registry',
    '/accessconfig/install',
  ]);
});

test('evaluation entry retains Experiment, Dataset, and Evaluator children', () => {
  const evalTree = definition('EVAL_TREE', 'OBSERVE_TREE');
  assert.deepEqual(visibleHrefs(evalTree), [
    '/experiments',
    '/dataset',
    '/metrics',
  ]);
});
