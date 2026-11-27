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

const source = fs.readFileSync(
    new URL('../src/app/api/skills/[id]/versions/route.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('versions-route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
    let result: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (!result && predicate(node)) result = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(result, 'production p95 declaration must exist');
    return result;
}

function expression(node: ts.Node, scope: Record<string, unknown>): unknown {
    const js = ts.transpileModule(`const value = ${node.getText(ast)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(...Object.keys(scope), `${js}; return value;`)(...Object.values(scope));
}

const p95Initializer = ((): ts.Expression => {
    const declaration = findNode(node => ts.isVariableDeclaration(node)
        && node.name.getText(ast) === 'p95'
        && node.initializer !== undefined) as ts.VariableDeclaration;
    assert.ok(declaration.initializer, 'p95 must be initialized');
    return declaration.initializer;
})();

function productionP95(latencies: number[]): number | null {
    const sorted = [...latencies].sort((a, b) => a - b);
    return expression(p95Initializer, { latencies: sorted }) as number | null;
}

function nearestRank(values: number[], p: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function latenciesOf(n: number): number[] {
    let seed = (n * 2654435761) % 4294967296;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        out.push(20 + Math.floor(seed / 4294967296 * 1800));
    }
    return out;
}

test('n 为 20 的倍数时 P95 取最近秩而非更高一档 rank', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(productionP95(twenty), 19);
    assert.equal(productionP95(twenty), nearestRank(twenty, 0.95));

    const forty = Array.from({ length: 40 }, (_, i) => i + 1);
    assert.equal(productionP95(forty), 38);
    assert.equal(productionP95(forty), nearestRank(forty, 0.95));

    // n=100 同样是 20 的倍数，与上面两类共用一条断言组。
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(productionP95(hundred), 95);
    assert.equal(productionP95(hundred), nearestRank(hundred, 0.95));
});

test('样本量非 20 的倍数时 P95 与最近秩逐位一致', () => {
    for (const n of [1, 2, 3, 4, 5, 9, 11, 19, 21, 39, 41, 63, 99, 121]) {
        const latencies = latenciesOf(n);
        assert.equal(productionP95(latencies), nearestRank(latencies, 0.95), `n=${n}`);
    }
});

test('空样本返回 null 的守卫不变', () => {
    assert.equal(productionP95([]), null);
});

test('含小数的延迟取整后仍与最近秩一致', () => {
    const decimal = latenciesOf(37).map((v, i) => v + (i % 10) / 10);
    assert.equal(productionP95(decimal), Math.round(nearestRank(decimal, 0.95)));

    const longTail = [12.4, 8.2, 30.75, 15.8, 44.45, 3.6, 27.05, 61.9, 55.1, 90.3, 7.7, 120.6];
    assert.equal(productionP95(longTail), Math.round(nearestRank(longTail, 0.95)));
});
