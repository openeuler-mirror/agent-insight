import assert from 'node:assert/strict';
import test from 'node:test';

import { expandHomePathsInText } from '@/lib/engine/general-agent/expand-home';

const HOME = '/home/alice';

test('内置 messages case 的 "：~/" 形态 → 展开成绝对路径', () => {
    const q = '请分析如下 messages 日志：~/.agent-insight/example/messages。有没有攻击?';
    assert.equal(
        expandHomePathsInText(q, HOME),
        '请分析如下 messages 日志：/home/alice/.agent-insight/example/messages。有没有攻击?',
    );
});

test('行首 / 空白前 的 ~/ 都展开', () => {
    assert.equal(expandHomePathsInText('~/.agent-insight/x', HOME), '/home/alice/.agent-insight/x');
    assert.equal(expandHomePathsInText('cat ~/.agent-insight/x', HOME), 'cat /home/alice/.agent-insight/x');
});

test('引号 / 括号 / 等号 后的 ~/ 也展开(正是 fs 读取/加引号会挂的那些)', () => {
    assert.equal(expandHomePathsInText('"~/a/b"', HOME), '"/home/alice/a/b"');
    assert.equal(expandHomePathsInText('path=~/a', HOME), 'path=/home/alice/a');
    assert.equal(expandHomePathsInText('（~/a）', HOME), '（/home/alice/a）');
});

test('多个 ~/ 全部展开', () => {
    assert.equal(
        expandHomePathsInText('比较 ~/a/log 和 ~/b/log', HOME),
        '比较 /home/alice/a/log 和 /home/alice/b/log',
    );
});

test('不动非路径的 ~: 词中间 / 约等于 / 不带斜杠的孤立 ~', () => {
    assert.equal(expandHomePathsInText('大约 ~100 次', HOME), '大约 ~100 次');
    assert.equal(expandHomePathsInText('a~b', HOME), 'a~b');
    assert.equal(expandHomePathsInText('user~/x', HOME), 'user~/x'); // ~ 前是字母, 非边界 → 不动
    assert.equal(expandHomePathsInText('在 ~ 目录下', HOME), '在 ~ 目录下'); // 不带斜杠 → 不动
});

test('没有 ~ / 空串 → 原样返回', () => {
    assert.equal(expandHomePathsInText('/abs/path', HOME), '/abs/path');
    assert.equal(expandHomePathsInText('', HOME), '');
});

test('home 为空时不炸, 原样返回', () => {
    assert.equal(expandHomePathsInText('~/x', ''), '~/x');
});
