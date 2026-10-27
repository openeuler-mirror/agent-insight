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
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ensureExampleMessagesFile } from '@/server/builtin-example/ensure-example-file';

function mktmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function seedRepoSource(cwd: string, content: string): void {
    fs.mkdirSync(path.join(cwd, 'public', 'example'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'public', 'example', 'messages'), content);
}
const destOf = (home: string) => path.join(home, '.agent-insight', 'example', 'messages');

test('缺失时从 public/example/messages 复制一份 → copied', () => {
    const home = mktmp('home-'); const cwd = mktmp('cwd-');
    try {
        seedRepoSource(cwd, 'LOG-CONTENT');
        assert.equal(ensureExampleMessagesFile({ home, cwd }), 'copied');
        assert.equal(fs.readFileSync(destOf(home), 'utf-8'), 'LOG-CONTENT');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('已存在 → exists, 且绝不覆盖原内容(语义 A 的核心)', () => {
    const home = mktmp('home-'); const cwd = mktmp('cwd-');
    try {
        seedRepoSource(cwd, 'NEW-FROM-REPO');
        fs.mkdirSync(path.dirname(destOf(home)), { recursive: true });
        fs.writeFileSync(destOf(home), 'ALREADY-THERE');
        assert.equal(ensureExampleMessagesFile({ home, cwd }), 'exists');
        assert.equal(fs.readFileSync(destOf(home), 'utf-8'), 'ALREADY-THERE'); // 没被覆盖
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('重复调用幂等: 第二次是 exists, 不重复写', () => {
    const home = mktmp('home-'); const cwd = mktmp('cwd-');
    try {
        seedRepoSource(cwd, 'X');
        assert.equal(ensureExampleMessagesFile({ home, cwd }), 'copied');
        assert.equal(ensureExampleMessagesFile({ home, cwd }), 'exists');
        assert.equal(ensureExampleMessagesFile({ home, cwd }), 'exists');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('仓库源不存在 → skipped, 不创建任何东西', () => {
    const home = mktmp('home-'); const cwd = mktmp('cwd-');
    try {
        assert.equal(ensureExampleMessagesFile({ home, cwd }), 'skipped');
        assert.equal(fs.existsSync(destOf(home)), false);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
