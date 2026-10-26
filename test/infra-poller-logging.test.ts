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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync(path.resolve('src/lib/infra/poller.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  let now = 1_000_000;
  let callback: (() => void) | undefined;
  const warnings: unknown[][] = [];
  const messages: unknown[][] = [];
  const state = {
    sources: [{ id: 'a', endpoint: 'http://a.test', scrapeUrl: '', scrapeIntervalMs: 1000, authHeaders: null }],
    errors: new Map([['http://a.test', 'HTTP 404']]),
    queryError: '', saveError: '', queries: 0, scrapes: 0, saves: 0,
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(code, {
    exports, process: { env: {} }, Date: { now: () => now },
    console: { warn: (...args: unknown[]) => warnings.push(args), log: (...args: unknown[]) => messages.push(args) },
    setInterval: (cb: () => void) => { callback = cb; return { unref() {} }; },
    clearInterval: () => { callback = undefined; },
    require: (name: string) => {
      if (name === '@/lib/infra/auth-headers') return { parseAuthHeaders: () => ({}) };
      if (name === '@/lib/storage/prisma') return { prismaRaw: { infraSource: { findMany: async () => {
        state.queries++;
        if (state.queryError) throw state.queryError;
        return state.sources;
      } } } };
      if (name === '@/lib/ingest/vllm/scrape') return { scrapeVllmTargetModels: async (endpoint: string) => {
        state.scrapes++;
        if (state.errors.has(endpoint)) throw state.errors.get(endpoint);
        return [{}];
      } };
      if (name === '@/lib/infra/store') return { saveSample: async () => {
        if (state.saveError) throw state.saveError;
        state.saves++;
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  exports.startInfraPoller({ intervalMs: 1000 });
  return {
    state, warnings, messages, exports,
    async tick(ms = 1000) {
      now += ms;
      callback?.();
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    details: (entry: unknown[]) => JSON.parse(String(entry[1])),
  };
}

test('持续每秒 404 保持采集频率，但同源每分钟只汇总一次重复失败', async () => {
  const f = fixture();
  for (let i = 0; i < 61; i++) await f.tick();
  assert.equal(f.state.scrapes, 61);
  assert.equal(f.warnings.length, 2);
  assert.match(String(f.warnings[0][0]), /source error/);
  assert.equal(f.details(f.warnings[1]).suppressed, 59);
  assert.equal(f.details(f.warnings[1]).consecutiveFailures, 61);
});

test('错误变化及另一个源首次失败立即记录，输出为单行 JSON', async () => {
  const f = fixture();
  await f.tick();
  await f.tick();
  f.state.errors.set('http://a.test', 'HTTP 503\nupstream unavailable');
  f.state.sources.push({ ...f.state.sources[0], id: 'b', endpoint: 'http://b.test' });
  f.state.errors.set('http://b.test', 'HTTP 404');
  await f.tick();
  assert.equal(f.warnings.length, 3);
  assert.equal(f.details(f.warnings[1]).previousError, 'HTTP 404');
  assert.equal(f.details(f.warnings[1]).suppressed, 1);
  assert.equal(f.details(f.warnings[2]).endpoint, 'http://b.test');
  assert.ok(f.warnings.every(entry => typeof entry[1] === 'string' && !entry[1].includes('\n')));
});

test('未到采集时间或其他源成功不代表恢复，本源成功后只打印一次恢复', async () => {
  const f = fixture();
  f.state.sources[0].scrapeIntervalMs = 10_000;
  f.state.sources.push({ ...f.state.sources[0], id: 'b', endpoint: 'http://b.test', scrapeIntervalMs: 1000 });
  await f.tick();
  await f.tick();
  assert.equal(f.messages.filter(entry => String(entry[0]).includes('recovered')).length, 0);
  f.state.errors.clear();
  await f.tick(9000);
  await f.tick(10_000);
  const recovered = f.messages.filter(entry => String(entry[0]).includes('source recovered'));
  assert.equal(recovered.length, 1);
  assert.equal(f.details(recovered[0]).endpoint, 'http://a.test');
  f.state.errors.set('http://a.test', 'HTTP 404');
  await f.tick(10_000);
  assert.equal(f.warnings.length, 2, '恢复后再次失败应立即输出');
});

test('查询指标源失败的 tick error 同样限频并报告恢复', async () => {
  const f = fixture();
  f.state.queryError = 'database is locked';
  for (let i = 0; i < 61; i++) await f.tick();
  assert.equal(f.warnings.length, 2);
  assert.match(String(f.warnings[0][0]), /tick error/);
  assert.equal(f.details(f.warnings[1]).suppressed, 59);
  f.state.queryError = '';
  f.state.errors.clear();
  await f.tick();
  await f.tick();
  assert.equal(f.messages.filter(entry => String(entry[0]).includes('tick recovered')).length, 1);
});

test('抓取成功但写库失败仍按失败记录，写库成功后才报告恢复', async () => {
  const f = fixture();
  f.state.errors.clear();
  f.state.saveError = 'SQLITE_BUSY';
  await f.tick();
  await f.tick();
  assert.equal(f.warnings.length, 1);
  assert.equal(f.details(f.warnings[0]).error, 'SQLITE_BUSY');
  assert.equal(f.messages.filter(entry => String(entry[0]).includes('recovered')).length, 0);
  f.state.saveError = '';
  await f.tick();
  const recovered = f.messages.find(entry => String(entry[0]).includes('source recovered'))!;
  assert.equal(f.details(recovered).suppressed, 1);
  assert.equal(f.state.saves, 1);
});

test('移除源及重启定时器清除旧限频状态，不虚报恢复', async () => {
  const f = fixture();
  const source = f.state.sources[0];
  await f.tick();
  f.state.sources = [];
  await f.tick();
  f.state.sources = [source];
  await f.tick();
  assert.equal(f.warnings.length, 2);
  f.exports.stopInfraPoller();
  f.exports.startInfraPoller({ intervalMs: 1000 });
  await f.tick();
  assert.equal(f.warnings.length, 3);
  assert.equal(f.messages.filter(entry => String(entry[0]).includes('recovered')).length, 0);
});
