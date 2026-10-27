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
import test from 'node:test';
import ts from 'typescript';
import { parseAsInteger, parseAsString } from 'nuqs';
import { casePagination, caseRowId, experimentCaseHref, experimentDetailHref, locateCasePage } from '../src/lib/engine/experiment/case-navigation';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/lib/client/use-experiment-case-pagination.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function paginationHarness(initialQuery: string, embedded = false) {
  let query = new URLSearchParams(initialQuery);
  let local: unknown;
  let result: ReturnType<typeof import('../src/lib/client/use-experiment-case-pagination').useExperimentCasePagination>;
  const writes: Array<Record<string, unknown>> = [];
  const setQuery = (next: Record<string, string | number | null>) => {
    for (const [key, value] of Object.entries(next)) {
      if (value === null) query.delete(key);
      else query.set(key, String(value));
    }
    writes.push(next);
    return Promise.resolve(query);
  };
  const exports: Record<string, (embedded: boolean) => typeof result> = {};
  const require = (name: string) => {
    if (name === 'react') return {
      useCallback: (callback: unknown) => callback,
      useState: (initial: () => unknown) => {
        local ??= initial();
        return [local, (next: unknown) => { local = typeof next === 'function' ? next(local) : next; }];
      },
    };
    if (name === 'nuqs') return { parseAsInteger, parseAsString,
      useQueryStates: (_parsers: unknown, options: unknown) => {
        assert.deepEqual(options, { history: 'replace', scroll: false });
        return [{ casePage: Number(query.get('casePage')) || 1, casePageSize: Number(query.get('casePageSize')) || 20,
          focusCaseId: query.get('focusCaseId') }, setQuery];
      },
    };
    if (name === '@/lib/engine/experiment/case-navigation') return { casePagination };
    throw new Error(`Unexpected import ${name}`);
  };
  new Function('require', 'exports', compiled)(require, exports);
  const render = () => { result = exports.useExperimentCasePagination(embedded); return result; };
  return { render, query: () => query, writes, visit: (value: string) => { query = new URLSearchParams(value); return render(); } };
}

test('Case links round trip page size and focus without treating IDs as URLs', () => {
  const caseHref = new URL(experimentCaseHref('exp / 1', 'case?=# /', 3, 50), 'http://fixture.invalid');
  assert.equal(caseHref.pathname, '/experiments/exp%20%2F%201/cases/case%3F%3D%23%20%2F');
  assert.equal(caseHref.searchParams.get('casePage'), '3');
  assert.equal(caseHref.searchParams.get('casePageSize'), '50');
  const backHref = new URL(experimentDetailHref('exp / 1', 'case?=# /', 4, 50), caseHref);
  assert.equal(backHref.pathname, '/experiments/exp%20%2F%201');
  assert.equal(backHref.searchParams.get('casePage'), '4');
  assert.equal(backHref.searchParams.get('casePageSize'), '50');
  assert.equal(backHref.searchParams.get('focusCaseId'), 'case?=# /');
  assert.notEqual(caseRowId('case/a'), caseRowId('case%2Fa'));
});

test('Case pagination rejects fractions and non-finite values, caps size and clamps missing targets', () => {
  assert.deepEqual(casePagination(), { casePage: 1, casePageSize: 20 });
  assert.deepEqual(casePagination('-2', '300'), { casePage: 1, casePageSize: 100 });
  assert.deepEqual(casePagination('1.5', 'Infinity'), { casePage: 1, casePageSize: 20 });
  assert.deepEqual(casePagination('1e99', ''), { casePage: 1, casePageSize: 20 });
  const ids = Array.from({ length: 45 }, (_, index) => `case-${index}`);
  assert.deepEqual(locateCasePage(ids, 1, 20, 'case-42'), { casePage: 3, locatedCaseId: 'case-42' });
  assert.deepEqual(locateCasePage(ids.slice(5), 3, 20, 'case-42'), { casePage: 2, locatedCaseId: 'case-42' });
  assert.deepEqual(locateCasePage(ids, 99, 20, 'missing'), { casePage: 3, locatedCaseId: null });
  assert.deepEqual(locateCasePage([], 99, 20, 'missing'), { casePage: 1, locatedCaseId: null });
});

test('pagination survives remount and back navigation and waits for a response before correcting the URL', () => {
  const harness = paginationHarness('casePage=3&casePageSize=50&focusCaseId=case-120&other=keep');
  assert.equal(harness.render().casePage, 3);
  assert.equal(harness.writes.length, 0);
  assert.equal(paginationHarness(harness.query().toString()).render().casePageSize, 50);
  harness.render().acceptPagination({ casePage: 2, casePageSize: 50 });
  assert.equal(harness.render().casePage, 2);
  assert.equal(harness.render().focusCaseId, 'case-120');
  harness.render().updatePagination(3, 20);
  assert.equal(harness.render().casePage, 3);
  assert.equal(harness.render().focusCaseId, null);
  assert.equal(harness.query().get('other'), 'keep');
  const back = harness.visit('casePage=2&casePageSize=50&focusCaseId=case-120');
  assert.equal(back.casePage, 2);
  assert.equal(back.focusCaseId, 'case-120');
  harness.render().acceptPagination({});
  assert.equal(harness.render().casePage, 2);
});

test('embedded Case navigation keeps its pagination local and leaves the parent URL intact', () => {
  const harness = paginationHarness('casePage=9&casePageSize=100&focusCaseId=parent-case', true);
  assert.equal(harness.render().casePage, 1);
  assert.equal(harness.render().focusCaseId, null);
  harness.render().updatePagination(3, 50);
  assert.equal(harness.render().casePage, 3);
  harness.render().acceptPagination({ casePage: 2, casePageSize: 50 });
  assert.equal(harness.render().casePage, 2);
  assert.equal(harness.query().get('casePage'), '9');
  assert.equal(harness.writes.length, 0);
});
