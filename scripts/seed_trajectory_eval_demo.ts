/**
 * Seed demo data for the trajectory evaluator UI.
 *
 * 幂等：每次执行先按 demo 标识清理旧数据，再插入。
 * 用户：skill-insight@huawei.com（user 默认登录账号）。
 *
 * 跑法：
 *   node --import tsx scripts/seed_trajectory_eval_demo.ts
 */
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
config();

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const USER = 'skill-insight@huawei.com';
const DATASET_ID = 'demo_traj_dataset_001';
const DEMO_RUN_ID = `trun_demo_${Date.now()}`;
const TASK_PREFIX = 'demo_traj_'; // session.taskId 都用这个前缀

// 时间基准：3 小时前 → 现在
const T0 = Date.now() - 3 * 3600 * 1000;
const STEP = 1500; // 每步间隔 ms

interface CaseSeed {
    suffix: string;          // 用于生成 taskId / 标识
    input: string;
    expectedOutput: string;
    evaluationFocus: string;
    referenceTrajectory: string;
    interactions: any[];     // Session.interactions
    sessionQuery: string;
}

function mkInteractions(traceTemplate: Array<
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string }
    | { role: 'assistant'; tool: string; args: any; output?: string }
>): any[] {
    return traceTemplate.map((t, i) => {
        const ts = T0 + i * STEP;
        if (t.role === 'user') {
            return { role: 'user', content: t.content, timestamp: ts, agent: 'demo-agent' };
        }
        if ('tool' in t) {
            return {
                role: 'assistant',
                agent: 'demo-agent',
                content: '',
                tool_calls: [
                    {
                        id: `c_${i}`,
                        function: { name: t.tool, arguments: JSON.stringify(t.args) },
                        timing: { started_at: ts, completed_at: ts + 800 },
                        output: t.output ?? '',
                    },
                ],
                timestamp: ts,
            };
        }
        return {
            role: 'assistant',
            agent: 'demo-agent',
            content: t.content,
            timestamp: ts,
            usage: { input: 120, output: 80, total: 200 },
        };
    });
}

const cases: CaseSeed[] = [
    // ---------- Case 1: 高分（按参考完整执行）----------
    {
        suffix: '001',
        input: '系统昨晚 03:14 出现 OOM，请定位是哪个进程触发，并给出原因。',
        expectedOutput: 'java 应用 (PID 4321) 因 RSS 持续增长触发 oom-killer，建议调整 -Xmx 或加内存。',
        evaluationFocus: '工具调用顺序合理 + 根因明确',
        referenceTrajectory: `理想步骤：
1. grep oom-killer /var/log/messages → 定位时间点
2. dmesg | grep -i "killed process" → 拿到进程 PID 和 RSS
3. 综合给出根因 + 建议
约 3-5 步`,
        sessionQuery: '系统昨晚 03:14 出现 OOM，请定位是哪个进程触发，并给出原因。',
        interactions: mkInteractions([
            { role: 'user', content: '系统昨晚 03:14 出现 OOM，请定位是哪个进程触发，并给出原因。' },
            { role: 'assistant', content: '我先 grep 系统日志找 oom-killer 触发记录。' },
            { role: 'assistant', tool: 'bash', args: { command: 'grep oom-killer /var/log/messages | tail -20' }, output: 'Mar  4 03:14:22 host kernel: oom-killer: gfp_mask=0x...' },
            { role: 'assistant', tool: 'bash', args: { command: 'dmesg | grep -i "Killed process" | tail -5' }, output: '[Mar 4 03:14] Killed process 4321 (java) total-vm:8123MB, anon-rss:7123MB' },
            { role: 'assistant', content: '定位完成：03:14:22 oom-killer 触发，被杀进程是 PID 4321 java 应用，anon-rss=7.1G 超出可用内存。建议把 -Xmx 调到 5G 以内或加 8G 内存。' },
        ]),
    },

    // ---------- Case 2: 中分（缺步骤，工具选择有问题）----------
    {
        suffix: '002',
        input: 'nginx 服务启动失败，请定位原因。',
        expectedOutput: '配置文件 /etc/nginx/nginx.conf 第 42 行 server_name 重复，删除其中一行后启动成功。',
        evaluationFocus: '诊断路径完整 + 找到具体配置问题',
        referenceTrajectory: `理想步骤：
1. systemctl status nginx → 拿启动失败概要
2. journalctl -u nginx -n 50 → 拿详细错误
3. nginx -t → 验证配置语法
4. 修复并验证
约 4-6 步`,
        sessionQuery: 'nginx 服务启动失败，请定位原因。',
        interactions: mkInteractions([
            { role: 'user', content: 'nginx 服务启动失败，请定位原因。' },
            { role: 'assistant', content: '我直接看 nginx 错误日志。' },
            { role: 'assistant', tool: 'bash', args: { command: 'cat /var/log/nginx/error.log | tail -50' }, output: '2026/04/29 ... [emerg] duplicate "server_name" ... in /etc/nginx/nginx.conf:42' },
            { role: 'assistant', tool: 'bash', args: { command: 'cat /etc/nginx/nginx.conf' }, output: 'http { ... server_name a.com; server_name a.com; ... }' },
            { role: 'assistant', tool: 'bash', args: { command: 'wc -l /etc/nginx/nginx.conf' }, output: '120' },
            { role: 'assistant', content: 'nginx.conf 第 42 行 server_name 重复，删掉一行就能启动。' },
        ]),
    },

    // ---------- Case 3: 低分（死循环 + 严重偏离）----------
    {
        suffix: '003',
        input: '/data 分区 95% 占用，请找出最大的 5 个目录或文件。',
        expectedOutput: '/data/logs/2026 占 80GB；建议清理或归档。',
        evaluationFocus: '高效定位大目录 + 不陷入循环',
        referenceTrajectory: `理想步骤：
1. df -h /data → 确认占用
2. du -sh /data/* | sort -hr | head -5 → 一行定位 top5
3. 输出建议
约 2-4 步`,
        sessionQuery: '/data 分区 95% 占用，请找出最大的 5 个目录或文件。',
        interactions: mkInteractions([
            { role: 'user', content: '/data 分区 95% 占用，请找出最大的 5 个目录或文件。' },
            { role: 'assistant', content: '我先 ls /data 看看目录结构。' },
            { role: 'assistant', tool: 'bash', args: { command: 'ls /data' }, output: 'logs  apps  backups  tmp' },
            { role: 'assistant', tool: 'bash', args: { command: 'ls /data/logs' }, output: '2024 2025 2026' },
            { role: 'assistant', tool: 'bash', args: { command: 'ls /data/apps' }, output: 'app1 app2' },
            { role: 'assistant', tool: 'bash', args: { command: 'ls /data/backups' }, output: 'b1 b2' },
            { role: 'assistant', tool: 'bash', args: { command: 'ls /data/tmp' }, output: '(empty)' },
            { role: 'assistant', tool: 'bash', args: { command: 'ls /data/logs/2026' }, output: '01 02 03 04' },
            { role: 'assistant', tool: 'bash', args: { command: 'ls /data/logs/2026/04' }, output: 'access.log error.log ...' },
            { role: 'assistant', content: '我看到 /data/logs/2026 下应该是占用大头，但需要确认大小，让我再看看。' },
            { role: 'assistant', tool: 'bash', args: { command: 'ls -la /data/logs/2026/04' }, output: '...' },
            { role: 'assistant', content: '/data/logs/2026 看起来是占用大头，建议清理。' },
        ]),
    },

    // ---------- Case 4: 浅尝辄止（应得低-中分：找到现象但没定位根因）----------
    {
        suffix: '004',
        input: '诊断网络间歇性丢包问题。',
        expectedOutput: 'eth0 接口 TX errors 持续累积，更换网线后恢复。',
        evaluationFocus: '能否定位到硬件层问题',
        referenceTrajectory: `理想步骤：
1. ping <gw> -c 100 → 量化丢包率
2. ip -s link show eth0 → 查 TX/RX errors 计数
3. ethtool eth0 → 链路速率/双工/连接质量
4. 综合判断硬件 vs 配置，给出修复建议
约 4-5 步`,
        sessionQuery: '诊断网络间歇性丢包问题。',
        interactions: mkInteractions([
            { role: 'user', content: '诊断网络间歇性丢包问题。' },
            { role: 'assistant', tool: 'bash', args: { command: 'ping -c 20 baidu.com' }, output: '20 packets transmitted, 19 received, 5% packet loss' },
            { role: 'assistant', content: '当前丢包率约 5%。建议联系网络管理员排查。' },
        ]),
    },

    // ---------- Case 5: 完整诊断（应得中-高分）----------
    {
        suffix: '005',
        input: 'CPU 持续 100%，请定位是哪个进程。',
        expectedOutput: 'PID 8821 数据导入脚本正则回溯，导致单核 100%。',
        evaluationFocus: '快速锁定 hot process',
        referenceTrajectory: `理想步骤：
1. top -b -n 1 | head -20 → 拿到进程列表
2. ps -p <pid> -o cmd → 看进程命令行
3. py-spy / strace -p <pid> → 看 hot stack
4. 给出根因（具体函数 / 正则）
约 3-4 步`,
        sessionQuery: 'CPU 持续 100%，请定位是哪个进程。',
        interactions: mkInteractions([
            { role: 'user', content: 'CPU 持续 100%，请定位是哪个进程。' },
            { role: 'assistant', tool: 'bash', args: { command: 'top -b -n 1 | head -20' }, output: 'PID 8821 100% python /opt/imp.py' },
            { role: 'assistant', tool: 'bash', args: { command: 'ps -p 8821 -o cmd' }, output: 'python /opt/imp.py --regex "..."' },
            { role: 'assistant', tool: 'bash', args: { command: 'py-spy dump --pid 8821' }, output: 'Thread 1: 99% in regex.fullmatch (line 142)' },
            { role: 'assistant', content: 'PID 8821 是 imp.py 数据导入脚本，hot stack 显示 99% 时间在第 142 行 regex.fullmatch —— 大概率是正则灾难性回溯。建议改写正则或用更精确的字符类。' },
        ]),
    },
];

async function main() {
    console.log(`[seed] cleaning previous demo data...`);

    // 1. 删旧 dataset
    await prisma.agentEvalDataset.deleteMany({ where: { id: DATASET_ID } });

    // 2. 删旧 trajectory eval results（按 evaluatorRunId 前缀 / dataset 关联）
    await prisma.trajectoryEvalResult.deleteMany({
        where: { OR: [{ datasetId: DATASET_ID }, { evaluatorRunId: { startsWith: 'trun_demo_' } }] },
    });

    // 3. 删旧 sessions（按 taskId 前缀）
    const oldSessions = await prisma.session.findMany({ where: { taskId: { startsWith: TASK_PREFIX } } });
    for (const s of oldSessions) {
        await prisma.session.delete({ where: { taskId: s.taskId } }).catch(() => undefined);
    }

    // 4. 删旧 executions（按 taskId 前缀）
    const delExec = await prisma.execution.deleteMany({ where: { taskId: { startsWith: TASK_PREFIX } } });

    console.log(`[seed] previous demo cleaned (sessions: ${oldSessions.length}, executions: ${delExec.count}).`);

    // 4. 准备 cases（生成稳定 caseId）
    const caseObjs = cases.map(c => ({
        id: randomUUID(),
        input: c.input,
        expectedOutput: c.expectedOutput,
        evaluationFocus: c.evaluationFocus,
        tags: [],
        trajectory: c.referenceTrajectory,
        _seed: c,
    }));

    const now = new Date();

    // 5. 插入 dataset
    await prisma.agentEvalDataset.create({
        data: {
            id: DATASET_ID,
            user: USER,
            name: '[DEMO] 运维诊断 Agent · 轨迹评测集',
            description: '由 seed_trajectory_eval_demo.ts 生成的演示数据，覆盖 5 种状态（高分 / 中分 / 低分 / 失败 / 评测中）。',
            targetAgent: 'build',
            tagsJson: JSON.stringify(['demo', 'ops', 'trajectory']),
            casesJson: JSON.stringify(caseObjs.map(c => ({
                id: c.id,
                input: c.input,
                expectedOutput: c.expectedOutput,
                evaluationFocus: c.evaluationFocus,
                tags: c.tags,
                trajectory: c.trajectory,
            }))),
            datasetKind: 'trajectory',
            createdAt: now,
            updatedAt: now,
        },
    });
    console.log(`[seed] dataset created: ${DATASET_ID} (${caseObjs.length} cases)`);

    // 6. 为每个 case 插入 Session + Execution（这样 /api/observe/data 能查到）
    let sessionsCreated = 0;
    let executionsCreated = 0;
    for (const c of caseObjs) {
        const taskId = `${TASK_PREFIX}${c._seed.suffix}`;
        if (c._seed.interactions.length > 0) {
            await prisma.session.create({
                data: {
                    taskId,
                    label: `[DEMO] ${c._seed.suffix}`,
                    query: c._seed.sessionQuery,
                    interactions: JSON.stringify(c._seed.interactions),
                    user: USER,
                    model: 'demo-model',
                    startTime: new Date(T0),
                },
            });
            sessionsCreated++;
        }
        // 不论是否有 interactions，都给 Execution 一条记录（包括 case 4 失败案例，让它能在执行记录列表中显示，提示 user 它没 trace 数据）
        await prisma.execution.create({
            data: {
                taskId,
                user: USER,
                framework: 'build',
                agentName: 'build',
                model: 'demo-model',
                query: c._seed.sessionQuery,
                latency: c._seed.suffix === '004' ? 0.45 : 1.5 + Math.random() * 6,
                tokens: 800 + Math.floor(Math.random() * 1500),
                cost: 0.001 + Math.random() * 0.01,
                isAnswerCorrect: c._seed.suffix !== '003',
                answerScore: c._seed.suffix === '001' ? 0.9 : c._seed.suffix === '002' ? 0.7 : c._seed.suffix === '003' ? 0.4 : null,
                timestamp: new Date(T0 + 60_000 * Number(c._seed.suffix.replace(/^0+/, '') || 0)),
                label: `[DEMO]`,
            },
        });
        executionsCreated++;
    }
    console.log(`[seed] sessions created: ${sessionsCreated} · executions created: ${executionsCreated}`);

    // 7. 不再 mock TrajectoryEvalResult —— 让用户在 /eval/trajectory 自己点开始评测，由 deepagents 真实跑
    console.log(`[seed] (skipped mock TrajectoryEvalResult — go to /eval/trajectory and click "开始评测" to trigger real LLM run)`);

    console.log('\n[seed] DONE.');
    console.log(`---`);
    console.log(`访问 http://localhost:3000/eval/trajectory`);
    console.log(`数据集：[DEMO] 运维诊断 Agent · 轨迹评测集`);
    console.log(`---`);
    console.log(`5 条 trace 全部待评测，预期真实评测结果：`);
    console.log(`  - 001 OOM 根因：完整覆盖参考路径 → 应得高分 (≥0.8)`);
    console.log(`  - 002 nginx 启动：跳步 systemctl/journalctl → 应得中分 (~0.5)`);
    console.log(`  - 003 磁盘空间：连续 6 次 ls 死循环 → 应得低分 (~0.3) + redundancy 检测命中`);
    console.log(`  - 004 网络丢包：浅尝辄止只 ping 一次 → 应得中-低分`);
    console.log(`  - 005 CPU 100%：top → ps → py-spy 完整诊断 → 应得高分 (≥0.7)`);
    console.log(`---`);
    console.log(`提示：评测会真实调用你激活的 LLM（看 /modelconfig/defaults），消耗 token；每条 4-5 次 LLM 调用，总耗时约 30-90s。`);
}

main()
    .catch(err => {
        console.error('[seed] FAILED:', err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
