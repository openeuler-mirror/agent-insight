import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

test('OpenClaw fast sync and delayed evaluation preserve the same collection receipt time', async () => {
  const source = fs.readFileSync(new URL('../src/lib/ingest/openclaw-watcher.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('watcher.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'OpenClawLogWatcher');
  assert.ok(declaration);
  const js = ts.transpileModule(declaration.getText(ast).replace('export class', 'class'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const timers: Array<() => Promise<void>> = [];
  const receipts: Array<Date | undefined> = [];
  const evaluations: boolean[] = [];
  const scope = {
    OpenClawParser: class {
      async parseFile() { return { task_id: 'watcher-receipt', query: 'question', final_result: 'answer' }; }
    },
    saveExecutionRecord: async (data: { skip_evaluation: boolean }, options?: { receivedAt?: Date }) => {
      receipts.push(options?.receivedAt);
      evaluations.push(data.skip_evaluation);
    },
    setTimeout: (callback: () => Promise<void>) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
    console: { log: () => {}, error: (...args: unknown[]) => { throw new Error(String(args)); } },
  };
  const Watcher = new Function(...Object.keys(scope), `${js}; return OpenClawLogWatcher;`)(...Object.values(scope));
  const startedAt = Date.now();
  new Watcher().scheduleParse('session.jsonl', 'change');
  assert.equal(timers.length, 2);
  await timers[0]();
  await new Promise(resolve => setTimeout(resolve, 10));
  await timers[1]();
  assert.deepEqual(evaluations, [true, false]);
  assert.ok(receipts[0] instanceof Date, 'persist the collection receipt time');
  assert.ok(receipts[0].getTime() >= startedAt);
  assert.equal(receipts[1]?.getTime(), receipts[0].getTime(), 'delayed analysis must not postpone inactivity timeout');
});
