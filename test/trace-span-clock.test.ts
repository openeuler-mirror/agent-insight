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

function formatSpanClock(): (ts?: number, dayRef?: number) => { clock: string; ms: string } | null {
    const file = new URL('../src/components/observe/AgentTraceView.tsx', import.meta.url);
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile('AgentTraceView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'formatSpanClock');
    assert.ok(node);
    const code = ts.transpileModule(node.getText(ast), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(`${code}; return formatSpanClock;`)() as ReturnType<typeof formatSpanClock>;
}

// 本地时间构造，避免测试结果依赖运行机器的时区。
const local = (month: number, day: number, hour: number, minute: number, second: number, ms: number) =>
    new Date(2026, month - 1, day, hour, minute, second, ms).getTime();

test('span row clock renders local HH:MM:SS.mmm', () => {
    const clock = formatSpanClock();
    assert.deepEqual(clock(local(11, 24, 9, 5, 7, 42), local(11, 24, 9, 0, 0, 0)), {
        clock: '09:05:07',
        ms: '042',
    });
});

test('span row clock keeps the time only when the row shares the trace start day', () => {
    const clock = formatSpanClock();
    assert.deepEqual(clock(local(11, 24, 23, 59, 59, 999), local(11, 24, 0, 0, 0, 0)), {
        clock: '23:59:59',
        ms: '999',
    });
});

test('span row clock prefixes MM-DD when the row crosses a day', () => {
    const clock = formatSpanClock();
    assert.deepEqual(clock(local(11, 25, 0, 0, 1, 5), local(11, 24, 23, 30, 0, 0)), {
        clock: '11-25 00:00:01',
        ms: '005',
    });
});

test('span row clock returns null when the start time is missing or invalid', () => {
    const clock = formatSpanClock();
    assert.equal(clock(undefined, local(11, 24, 0, 0, 0, 0)), null);
    assert.equal(clock(Number.NaN, local(11, 24, 0, 0, 0, 0)), null);
});
