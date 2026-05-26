import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';

interface ActiveGrayscaleRun {
    taskId: string;
    runId: string;
    status: 'running' | 'evaluating';
    startedAt: number;
    /** Sibling /[taskId]/route.ts 用它做任务终止信号; 这里类型对齐避免 globalThis 重声明冲突。 */
    abortController?: AbortController;
}

type JsonRecord = Record<string, unknown>;

type GrayscaleTaskRow = {
    id: string;
    user: string;
    skillId: string;
    skillName: string;
    skillVersion: number;
    skillVersionId: string;
    taskName: string;
    configJson: string;
    caseStatesJson: string;
    createdAt: string | Date;
    [key: string]: unknown;
};

type GrayscalePrisma = {
    skill: {
        findFirst(args: {
            where: { id: string; OR: Array<{ user: string } | { user: null }> };
            select: { id: true; name: true };
        }): Promise<BoundSkill | null>;
    };
    skillVersion: {
        findFirst(args: {
            where: { id: string; skillId: string };
            select: { id: true; version: true };
        }): Promise<BoundVersion | null>;
    };
    grayscaleTask: {
        findMany(args: {
            where: { user: string };
            orderBy: { createdAt: 'desc' };
            take: number;
        }): Promise<GrayscaleTaskRow[]>;
        findFirst(args: {
            where: { user: string; skillName: string; skillVersion: number };
        }): Promise<GrayscaleTaskRow | null>;
        create(args: {
            data: {
                user: string;
                skillId: string;
                skillName: string;
                skillVersion: number;
                skillVersionId: string;
                taskName: string;
                configJson: string;
            };
        }): Promise<GrayscaleTaskRow>;
    };
};

declare global {
    var __grayscaleRunStore: Map<string, ActiveGrayscaleRun> | undefined;
}

function activeRuns(): Map<string, ActiveGrayscaleRun> {
    if (!globalThis.__grayscaleRunStore) globalThis.__grayscaleRunStore = new Map();
    return globalThis.__grayscaleRunStore;
}

function hasAnyRunningCaseStates(rawStates: unknown): boolean {
    if (!rawStates || typeof rawStates !== 'object') return false;
    return Object.values(rawStates as Record<string, unknown>).some(state => {
        if (!state || typeof state !== 'object') return false;
        return ['a', 'b'].some(side => {
            const sideState = (state as Record<string, unknown>)[side];
            if (!sideState || typeof sideState !== 'object') return false;
            const status = (sideState as Record<string, unknown>).status;
            if (status === 'running' || status === 'evaluating') return true;
            const runs = (sideState as Record<string, unknown>).runs;
            return Array.isArray(runs) && runs.some(run => {
                if (!run || typeof run !== 'object') return false;
                const runStatus = (run as Record<string, unknown>).status;
                return runStatus === 'running' || runStatus === 'evaluating';
            });
        });
    });
}

function safeParse(value: string | null | undefined): JsonRecord {
    if (!value) return {};
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

type BoundSkill = { id: string; name: string };
type BoundVersion = { id: string; version: number };

async function findBoundSkill(skillId: string, user: string) {
    return (prisma as unknown as GrayscalePrisma).skill.findFirst({
        where: {
            id: skillId,
            OR: [{ user }, { user: null }],
        },
        select: { id: true, name: true },
    });
}

async function findBoundVersion(skillId: string, versionBId: string) {
    return (prisma as unknown as GrayscalePrisma).skillVersion.findFirst({
        where: { id: versionBId, skillId },
        select: { id: true, version: true },
    });
}

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const user = searchParams.get('user');

    if (!user) {
        return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }

    try {
        const tasks = await (prisma as unknown as GrayscalePrisma).grayscaleTask.findMany({
            where: { user },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        const parsed = tasks.map((t) => {
            const configJson = safeParse(t.configJson);
            const caseStatesJson = safeParse(t.caseStatesJson);
            const storeKey = `${user}:${t.id}`;
            const activeRun = activeRuns().get(storeKey) || null;
            if (activeRun && !hasAnyRunningCaseStates(caseStatesJson)) {
                activeRuns().delete(storeKey);
            }
            return {
                ...t,
                configJson: {
                    ...configJson,
                    skillId: configJson.skillId || t.skillId,
                    versionBId: configJson.versionBId || t.skillVersionId,
                },
                caseStatesJson,
                activeRun: activeRuns().get(storeKey) || null,
            };
        });
        return NextResponse.json(parsed);
    } catch (err) {
        console.error('[GRAYSCALE_TASKS_GET] Failed:', err);
        return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { user, taskName } = body;
        const skillId = String(body.skillId || '').trim();
        const versionBId = String(body.versionBId || '').trim();

        if (!user || !taskName?.trim() || !skillId || !versionBId) {
            return NextResponse.json({ error: 'user, taskName, skillId and versionBId are required' }, { status: 400 });
        }

        const skill = await findBoundSkill(skillId, user);
        if (!skill?.name) {
            return NextResponse.json({ error: 'skill not found' }, { status: 404 });
        }
        const version = await findBoundVersion(skill.id, versionBId);
        if (!version) {
            return NextResponse.json({ error: 'skill version not found' }, { status: 404 });
        }

        const existing = await (prisma as unknown as GrayscalePrisma).grayscaleTask.findFirst({
            where: { user, skillName: skill.name, skillVersion: version.version },
        });
        if (existing) {
            return NextResponse.json({
                error: 'A/B task already exists for this skill version',
                existingTask: {
                    ...existing,
                    configJson: {
                        ...safeParse(existing.configJson),
                        skillId: existing.skillId,
                        versionBId: existing.skillVersionId,
                    },
                    caseStatesJson: safeParse(existing.caseStatesJson),
                },
            }, { status: 409 });
        }

        const task = await (prisma as unknown as GrayscalePrisma).grayscaleTask.create({
            data: {
                user,
                skillId: skill.id,
                skillName: skill.name,
                skillVersion: version.version,
                skillVersionId: version.id,
                taskName: taskName.trim(),
                configJson: JSON.stringify({ skillId: skill.id, versionAId: '__NONE__', versionBId: version.id }),
            },
        });
        return NextResponse.json({
            ...task,
            configJson: {
                ...safeParse(task.configJson),
                skillId: task.skillId,
                versionBId: task.skillVersionId,
            },
            caseStatesJson: safeParse(task.caseStatesJson),
        });
    } catch (err) {
        console.error('[GRAYSCALE_TASKS_POST] Failed:', err);
        return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }
}
