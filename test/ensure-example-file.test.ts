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
