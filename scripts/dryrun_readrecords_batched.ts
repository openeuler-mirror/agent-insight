#!/usr/bin/env -S node --import tsx
/**
 * 等价性验证:readRecords 的批处理(按 READ_RECORDS_HYDRATE_BATCH_SIZE 切批 hydrate)
 * 对**返回结果**必须与批大小无关——批大小只影响峰值内存与查询次数。
 *
 * 用法(两进程、不同批大小、对真实 DB 各跑一遍,再 diff 两份 digest):
 *   READ_RECORDS_HYDRATE_BATCH_SIZE=7      node --import tsx scripts/dryrun_readrecords_batched.ts /tmp/a.json
 *   READ_RECORDS_HYDRATE_BATCH_SIZE=100000 node --import tsx scripts/dryrun_readrecords_batched.ts /tmp/b.json
 *   diff /tmp/a.json /tmp/b.json   # 必须完全一致
 *
 * 第一个参数 = digest 输出文件;第二个参数(可选)= user,缺省自动选 root execution 最多的 user
 * (最贴近非分页 heavy 路径的 OOM 高危场景)。digest 覆盖所有 hydrate 派生字段:
 * agents / skills / invokedSkills / rootSkill / final_result 长度 / skill_version / ownership /
 * execution_match 命中——任一随批大小变化都会让 diff 失败。
 */
import fs from 'node:fs';
import path from 'node:path';

// 防御:DATABASE_URL 未注入时回落到仓库内 SQLite(Prisma 相对 file: 以 schema.prisma 目录为基准)。
if (!process.env.DATABASE_URL) {
    const dbPath = path.resolve(process.cwd(), 'data/witty_insight.db');
    process.env.DATABASE_URL = `file:${dbPath}`;
}

function digestRecord(r: any) {
    // 只取随批大小可能漂移的派生字段,构造稳定 key 顺序。
    return {
        upload_id: r.upload_id ?? null,
        task_id: r.task_id ?? null,
        timestamp: r.timestamp ?? null,
        framework: r.framework ?? null,
        agent: r.agentName ?? r.agent ?? null,
        agents: r.agents ?? [],
        agentOwnership: r.agentOwnership ?? null,
        skills: r.skills ?? null,
        invokedSkills: (r.invokedSkills ?? []).map((s: any) => `${s.name}@${s.version ?? ''}`),
        rootSkill: r.rootSkill ? `${r.rootSkill.name}@${r.rootSkill.version ?? ''}` : null,
        final_result_len: typeof r.final_result === 'string' ? r.final_result.length : 0,
        skill_version: r.skill_version ?? null,
        is_subagent: r.is_subagent ?? false,
        execution_match: r.execution_match ? (r.execution_match.matchJson != null) : null,
    };
}

const SEED_USER = 'dryrun-batched@example.com';

// 在(临时)DB 里塞一批合成数据,专门压 hydrate 的新代码:
//   - finalResult 每条长度各异 → 按批回取/merge 一旦 id 错位,digest 的 final_result_len 立刻不一致;
//   - 部分 taskId 有重复行(含 id===taskId 的 canonical + 更旧的重复)→ 压 dedup;
//   - agentName 轮换 → 压 ownership(无 RegisteredAgent 时统一 'user',跨批仍须一致);
//   - 行数 24,batch=3 → 8 批,跨批边界充分。
async function seed(prisma: any) {
    await prisma.execution.deleteMany({ where: { user: SEED_USER } });
    await prisma.session.deleteMany({ where: { user: SEED_USER } });
    const agents = ['claude-agent', 'build', 'kuafu-agent'];
    const frameworks = ['opencode', 'claude'];
    const rows: any[] = [];
    for (let i = 0; i < 24; i++) {
        const taskId = `seed-t${String(i).padStart(2, '0')}`;
        rows.push({
            id: taskId, // canonical: id===taskId
            taskId,
            query: `q${i}`,
            framework: frameworks[i % frameworks.length],
            agentName: agents[i % agents.length],
            finalResult: 'x'.repeat(i * 7), // 每条长度唯一
            skill: i % 4 === 0 ? `skill-${i}` : null,
            skillVersion: i % 8 === 0 ? 3 : null,
            user: SEED_USER,
            isSubagent: false,
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), // 递增 → 返回按 desc 稳定
        });
        // 每 5 条插一条同 taskId 的"重复上报"行(非 canonical,更旧),dedup 必须丢弃它。
        if (i % 5 === 0) {
            rows.push({
                id: `${taskId}-dup`,
                taskId,
                query: `q${i}-dup`,
                framework: frameworks[i % frameworks.length],
                agentName: agents[i % agents.length],
                finalResult: 'y'.repeat(i * 99), // 故意更长:若错选它,final_result_len 会暴露
                user: SEED_USER,
                isSubagent: false,
                timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, i)),
            });
        }
    }
    await prisma.execution.createMany({ data: rows });
    // 给前几条塞 Session(interactions 触发 heavy 的解析路径,跨批须确定性一致)。
    for (let i = 0; i < 6; i++) {
        const taskId = `seed-t${String(i).padStart(2, '0')}`;
        await prisma.session.create({
            data: {
                taskId,
                user: SEED_USER,
                interactions: JSON.stringify([{ role: 'user', content: `hello ${i}` }]),
            },
        });
    }
    console.error(`[dryrun] seeded ${rows.length} executions + 6 sessions for ${SEED_USER}`);
}

async function main() {
    const { readRecords } = await import('@/lib/storage/data-service');
    const { prismaRaw: prisma } = await import('@/lib/storage/prisma');

    if (process.argv[2] === '--seed') {
        await seed(prisma);
        process.exit(0);
    }

    const outFile = process.argv[2];
    if (!outFile) {
        console.error('usage: dryrun_readrecords_batched.ts <out.json> [user]   |   --seed');
        process.exit(2);
    }

    let user: string | undefined = process.argv[3];
    if (!user) {
        const rows: Array<{ user: string | null }> = await (prisma as any).execution.groupBy({
            by: ['user'],
            where: { isSubagent: false, user: { not: null } },
            _count: { _all: true },
            orderBy: { _count: { id: 'desc' } },
            take: 1,
        });
        user = rows[0]?.user ?? undefined;
    }

    const batchSize = process.env.READ_RECORDS_HYDRATE_BATCH_SIZE || '(default 100)';
    console.error(`[dryrun] user=${user ?? '(none)'} batchSize=${batchSize} — heavy non-paginated readRecords ...`);

    const t0 = Date.now();
    // heavy(不带 lightweight)、非分页——正是会触发"全历史 session 进内存"的高危调用形态。
    const records = await readRecords(user, {}, { attachEvaluations: false });
    const ms = Date.now() - t0;

    const digest = {
        user: user ?? null,
        count: records.length,
        records: records.map(digestRecord),
    };
    fs.writeFileSync(outFile, JSON.stringify(digest, null, 2));
    console.error(`[dryrun] count=${records.length} in ${ms}ms, heapUsed=${Math.round(process.memoryUsage().heapUsed / 1e6)}MB → ${outFile}`);
    process.exit(0);
}

main().catch((e) => {
    console.error('[dryrun] FAILED:', e);
    process.exit(1);
});
