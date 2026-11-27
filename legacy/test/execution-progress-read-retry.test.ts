import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/engine/experiment/execution-progress-service.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('execution-progress-service.ts', source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['loadCaseExecutionProgress', 'readExecutionProgressSnapshot'].includes(node.name?.text || ''));
const compiled = ts.transpileModule(functions.map(node => node.getText(ast).replace('export ', '')).join('\n'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
}).outputText;
function harness(failures: Array<{code: string; delayMs: number}>) {
  let now = 1000;
  const output = new Map([['case', {progress: {status: 'done'}}]]);
  const attempts: Array<{at: number; options: {timeout: number; maxWait: number} | undefined}> = [];
  const prisma = {$transaction: async (read: (tx: unknown) => Promise<unknown>, options?: {timeout: number; maxWait: number}) => {
    attempts.push({at: now, options});
    const failure = failures.shift();
    if (failure) {now += failure.delayMs;throw Object.assign(new Error('Read transaction failed'), {code: failure.code});}
    return read({});
  }};
  const load = new Function('prisma', 'Date', 'setTimeout', 'loadCaseExecutionProgressInTransaction', `${compiled}\nreturn loadCaseExecutionProgress;`)(
    prisma, {now: () => now}, (resolve: () => void, delay: number) => {now += delay;resolve();}, async () => output,
  ) as (...args: unknown[]) => Promise<unknown>;
  return {attempts, output, run: () => load('experiment', 'test@example.com', ['case'], ['judge'], false)};
}

for (const code of ['P1008', 'P2028', 'P2034']) {
  test(`${code} 后仅重新读取一次一致性快照，两个尝试共享等待预算`, async () => {
    const h = harness([{code, delayMs: 5512}]);
    assert.equal(await h.run(), h.output);
    assert.equal(h.attempts.length, 2);
    for (const attempt of h.attempts) {
      assert.ok(attempt.options);
      assert.ok(attempt.options.timeout <= 30000);
      assert.ok(attempt.options.maxWait + attempt.options.timeout <= 35000 - (attempt.at - 1000));
    }
  });
}

test('持续事务失败最多两次，仍向调用方报错', async () => {
  const h = harness([{code: 'P1008', delayMs: 100}, {code: 'P1008', delayMs: 100}]);
  await assert.rejects(h.run(), {code: 'P1008'});
  assert.equal(h.attempts.length, 2);
});

test('非瞬时数据库错误不自动重读', async () => {
  const h = harness([{code: 'P2002', delayMs: 100}]);
  await assert.rejects(h.run(), {code: 'P2002'});
  assert.equal(h.attempts.length, 1);
});

test('等待预算耗尽时不再启动第二个事务', async () => {
  const h = harness([{code: 'P1008', delayMs: 35000}]);
  await assert.rejects(h.run(), {code: 'P1008'});
  assert.equal(h.attempts.length, 1);
});
