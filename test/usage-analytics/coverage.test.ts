import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { USAGE_FEATURES } from '@/lib/usage-analytics/catalog';

/**
 * 埋点覆盖率守卫。
 *
 * 之前漏接了 29 个事件却没有任何测试报警 —— 因为原来的测试只校验
 * "已写的埋点是否合法"，没有校验"注册表里的事件是否都被写了"。
 * 这个方向的缺失才是用户实际看到的 bug（功能排行恒为 0）。
 */

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
    }
    return out;
}

const ALL_SOURCES = walk(SRC).filter((p) => !p.includes(`${path.sep}usage-analytics${path.sep}`));

const SOURCE_TEXT = ALL_SOURCES.map((p) => fs.readFileSync(p, 'utf8')).join('\n');

/**
 * 收集源码里所有被实际使用的 event key。
 *
 * 不能只匹配 `eventKey: 'x'` —— 有些调用点用三元表达式选 key（首条消息算 run、
 * 后续算 message），字面量并不紧跟在 eventKey: 后面。这里退一步：
 * 只要文件里出现了形如 'a.b.c' 且是注册表已知的 key，就算接入。
 */
function collectInstrumentedEventKeys(known: Set<string>): Set<string> {
    const keys = new Set<string>();
    for (const m of SOURCE_TEXT.matchAll(/'([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)'/gi)) {
        if (known.has(m[1])) keys.add(m[1]);
    }
    return keys;
}

const ALL_KEYS = new Set(USAGE_FEATURES.flatMap((f) => f.uses.map((u) => u.key)));

test('注册表里的每个 event key 都必须有对应的埋点调用点', () => {
    const instrumented = collectInstrumentedEventKeys(ALL_KEYS);
    const missing: string[] = [];

    for (const feature of USAGE_FEATURES) {
        for (const use of feature.uses) {
            if (!instrumented.has(use.key)) missing.push(`${feature.label} / ${use.key}`);
        }
    }

    assert.deepEqual(
        missing,
        [],
        `以下事件只写进了注册表但没有任何埋点，功能排行里会恒为 0：\n  ${missing.join('\n  ')}`
    );
});

test('埋点不得落在失败分支里（否则失败请求也会计数）', () => {
    // 真踩过：trace.draft.save 曾被插进 400 校验分支，
    // 结果"参数非法"会计数、"保存成功"反而不计。
    const offenders: string[] = [];

    for (const file of ALL_SOURCES) {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n');

        lines.forEach((line, i) => {
            if (!/recordUsageEvent\s*\(/.test(line)) return;

            // 往下找紧跟其后的第一个 return：若它是 4xx/5xx，说明埋点在失败分支内。
            // 遇到 } / catch 就停 —— 那说明当前块已经结束，后面的 500 是 catch 的，不算。
            for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
                const l = lines[j];
                if (/^\s*\}/.test(l) || /catch\s*\(/.test(l)) break;
                if (/return NextResponse\.json\(/.test(l)) {
                    // 只看这条 return 语句本身（到它的分号为止），不能把下一句
                    // catch 里的 500 也算进来。
                    let stmt = l;
                    for (let k = j + 1; k < Math.min(j + 4, lines.length) && !/;\s*$/.test(stmt); k++) {
                        if (/^\s*\}/.test(lines[k]) || /catch\s*\(/.test(lines[k])) break;
                        stmt += ' ' + lines[k];
                    }
                    if (/status:\s*(4\d\d|5\d\d)/.test(stmt)) {
                        offenders.push(`${file.replace(process.cwd() + '/', '')}:${i + 1}`);
                    }
                    break;
                }
            }
        });
    }

    assert.deepEqual(offenders, [], `以下埋点位于失败分支，会把失败请求计成有效使用：\n  ${offenders.join('\n  ')}`);
});

test('注册表声明的 source 必须与实际埋点方式一致', () => {
    // source 写错会让事件被静默丢弃：客户端上报 source='server' 的事件会被
    // /api/usage/events 拒收；服务端 recordUsageEvent 记 source='client' 则口径错乱。
    const clientReported = new Set<string>();
    for (const m of SOURCE_TEXT.matchAll(
        /(?:reportClientUsage|createOnceReporter)\(\s*'[^']+'\s*,\s*'([^']+)'/g
    )) {
        clientReported.add(m[1]);
    }

    const wrong: string[] = [];
    for (const feature of USAGE_FEATURES) {
        for (const use of feature.uses) {
            const isClientCall = clientReported.has(use.key);
            if (isClientCall && use.source !== 'client') {
                wrong.push(`${use.key}: 实际是客户端上报，注册表却声明 source='${use.source}'（会被 API 拒收）`);
            }
            if (!isClientCall && use.source === 'client') {
                wrong.push(`${use.key}: 注册表声明 source='client'，但没有对应的客户端上报调用`);
            }
        }
    }

    assert.deepEqual(wrong, [], `source 声明与实现不符：\n  ${wrong.join('\n  ')}`);
});

test('每个可统计功能至少有一个事件被真正接入', () => {
    const instrumented = collectInstrumentedEventKeys(ALL_KEYS);
    const dead = USAGE_FEATURES.filter((f) => !f.uses.some((u) => instrumented.has(u.key))).map(
        (f) => f.label
    );

    assert.deepEqual(dead, [], `以下功能没有任何埋点，永远不会出现在排行里：${dead.join('、')}`);
});
