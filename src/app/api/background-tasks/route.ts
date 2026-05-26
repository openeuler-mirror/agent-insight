/**
 * GET /api/background-tasks
 *
 * 暴露 concurrency-limiter 的实时任务状态快照，给 Skills 分析页等 UI 用。
 *
 * Query:
 *   user      — 按发起用户过滤
 *   skill     — 按关联 skill 名过滤
 *   version   — 按 skill 版本号过滤
 *   taskType  — 按 taskType 过滤 (trajectory-eval / task-completion-eval /
 *               custom-llm-eval / trigger-eval)
 *
 * 返回：
 *   {
 *     tasks:    TaskRecord[]   // 过滤后的任务列表 (含 queued + running + 最近 5min done/failed)
 *     counts:   { queued, running, done, failed }
 *     snapshot: { max, permitsLeft, active, waiting, ... }  // 全局信号量快照(未过滤)
 *   }
 *
 * 配合 ring-buffer (5 min 内的 done/failed 任务保留在 snapshot 里) UI 可以
 * 在任务刚完成时还能看到 "已完成" 数字短暂出现，符合用户 mental model。
 */
import {
    getAllBackgroundOpencodeTasks,
    getBackgroundOpencodeSemaphoreSnapshot,
    type TaskRecord,
    type TaskStatus,
} from '@/lib/engine/general-agent/concurrency-limiter';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const user = (searchParams.get('user') || '').trim() || undefined;
        const skill = (searchParams.get('skill') || '').trim() || undefined;
        const versionStr = searchParams.get('version');
        const version = versionStr != null && versionStr !== ''
            ? Number(versionStr)
            : undefined;
        const taskType = (searchParams.get('taskType') || '').trim() || undefined;

        let tasks: TaskRecord[] = getAllBackgroundOpencodeTasks();
        if (user) tasks = tasks.filter(t => t.user === user);
        if (skill) tasks = tasks.filter(t => t.skill === skill);
        if (version != null && Number.isFinite(version)) {
            tasks = tasks.filter(t => t.skillVersion === version);
        }
        if (taskType) tasks = tasks.filter(t => t.taskType === taskType);

        const counts: Record<TaskStatus, number> = { queued: 0, running: 0, done: 0, failed: 0 };
        for (const t of tasks) counts[t.status]++;

        return NextResponse.json({
            tasks,
            counts,
            snapshot: getBackgroundOpencodeSemaphoreSnapshot(),
        });
    } catch (err) {
        console.error('[background-tasks] GET error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'failed to load background tasks' },
            { status: 500 },
        );
    }
}
