import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

import { resolveDefaultDatabaseUrl, getAgentInsightHome } from '@/lib/env';

// 看护"平台默认从 ~/.agent-insight/data 读库"——不再需要任何人手动传 DATABASE_URL,
// 且 server(bash)与手动 node 脚本行为一致(都能展开 ~)。

test('DATABASE_URL 归一:未设置 / 空 / 模板默认相对路径 → ~/.agent-insight/data 绝对路径', () => {
    const home = `file:${path.join(getAgentInsightHome(), 'data', 'witty_insight.db')}`;
    assert.equal(resolveDefaultDatabaseUrl(undefined), home);
    assert.equal(resolveDefaultDatabaseUrl(''), home);
    assert.equal(resolveDefaultDatabaseUrl('file:../data/witty_insight.db'), home);
});

test('DATABASE_URL 归一:file:~/… 展开波浪号(node/dotenv 自己不展开,只有 bash source 会)', () => {
    const expanded = `file:${path.join(os.homedir(), '.agent-insight', 'data', 'witty_insight.db')}`;
    assert.equal(resolveDefaultDatabaseUrl('file:~/.agent-insight/data/witty_insight.db'), expanded);
    assert.equal(resolveDefaultDatabaseUrl('file:~'), `file:${os.homedir()}`);
});

test('DATABASE_URL 归一:已是绝对路径 / 非 file: → 原样返回', () => {
    const abs = 'file:/root/.agent-insight/data/witty_insight.db';
    assert.equal(resolveDefaultDatabaseUrl(abs), abs);
    assert.equal(resolveDefaultDatabaseUrl('postgresql://h:5432/db'), 'postgresql://h:5432/db');
});

test('AGENT_INSIGHT_HOME 展开 HOME，非空旧变量必须报错', () => {
    const previousHome = process.env.AGENT_INSIGHT_HOME;
    const previousLegacy = process.env.AGENT_INSIGHT_DATA_DIR;
    try {
        process.env.AGENT_INSIGHT_HOME = '$HOME/custom-agent-insight';
        delete process.env.AGENT_INSIGHT_DATA_DIR;
        assert.equal(getAgentInsightHome(), path.join(os.homedir(), 'custom-agent-insight'));
        process.env.AGENT_INSIGHT_DATA_DIR = '/tmp/legacy-agent-insight';
        assert.throws(() => getAgentInsightHome(), /AGENT_INSIGHT_DATA_DIR is no longer supported/);
        delete process.env.AGENT_INSIGHT_HOME;
        assert.throws(() => getAgentInsightHome(), /AGENT_INSIGHT_DATA_DIR is no longer supported/);
    } finally {
        if (previousHome == null) delete process.env.AGENT_INSIGHT_HOME;
        else process.env.AGENT_INSIGHT_HOME = previousHome;
        if (previousLegacy == null) delete process.env.AGENT_INSIGHT_DATA_DIR;
        else process.env.AGENT_INSIGHT_DATA_DIR = previousLegacy;
    }
});
