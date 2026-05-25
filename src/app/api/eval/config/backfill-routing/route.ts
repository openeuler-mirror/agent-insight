import { configSupportsDatasetType } from '@/lib/engine/evaluation/config-dataset';
import { readConfig } from '@/lib/storage/data-service';
import { db } from '@/lib/storage/prisma';
import { deriveRoutingSignature } from '@/lib/ingest/routing-signature';
import { getActiveConfig } from '@/lib/storage/server-config';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface BackfillTask {
    id: string;
    query: string;
}

async function runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number
): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const current = nextIndex;
            nextIndex += 1;
            if (current >= tasks.length) return;
            results[current] = await tasks[current]();
        }
    }

    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, () => worker())
    );

    return results;
}

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const actorUser = typeof body.user === 'string' && body.user.trim() ? body.user.trim() : null;
        const limit = Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 50) : 10;
        const concurrency = Number.isInteger(body.concurrency) && body.concurrency > 0 ? Math.min(body.concurrency, 4) : 3;
        const includeCompleted = Boolean(body.includeCompleted);
        const allUsers = Boolean(body.allUsers);

        if (!actorUser) {
            return NextResponse.json({ error: 'user is required' }, { status: 400 });
        }

        const activeConfig = await getActiveConfig(actorUser);
        if (!activeConfig) {
            return NextResponse.json({ error: `No active model configuration found for ${actorUser}` }, { status: 400 });
        }

        const configs = await readConfig(allUsers ? undefined : actorUser);
        const pendingConfigs = configs
            .filter(config => configSupportsDatasetType(config.dataset_type, 'routing'))
            .filter(config => typeof config.query === 'string' && config.query.trim())
            .filter(config => includeCompleted || !config.routing_intent?.trim() || !config.routing_anchors?.length)
            .slice(0, limit);

        const tasks: Array<() => Promise<{
            id: string;
            query: string;
            intent?: string;
            anchors?: string[];
            status: 'updated' | 'failed';
            error?: string;
        }>> = pendingConfigs.map((config) => {
            const task: BackfillTask = {
                id: config.id,
                query: config.query!.trim(),
            };

            return async () => {
                try {
                    const signature = await deriveRoutingSignature(task.query, actorUser);
                    if (!signature) {
                        throw new Error('Empty routing signature');
                    }

                    await db.updateConfig(task.id, {
                        routingIntent: signature.intent,
                        routingAnchors: JSON.stringify(signature.anchors),
                    });

                    return {
                        id: task.id,
                        query: task.query,
                        intent: signature.intent,
                        anchors: signature.anchors,
                        status: 'updated' as const,
                    };
                } catch (error: any) {
                    return {
                        id: task.id,
                        query: task.query,
                        status: 'failed' as const,
                        error: error?.message || 'Unknown error',
                    };
                }
            };
        });

        const results = await runWithConcurrency(tasks, concurrency);
        const updated = results.filter(item => item.status === 'updated');
        const failed = results.filter(item => item.status === 'failed');

        return NextResponse.json({
            success: true,
            actor_user: actorUser,
            all_users: allUsers,
            processed: results.length,
            updated: updated.length,
            failed: failed.length,
            remaining_estimate: Math.max(0, pendingConfigs.length < limit ? 0 : configs.filter(config =>
                configSupportsDatasetType(config.dataset_type, 'routing')
                && typeof config.query === 'string'
                && config.query.trim()
                && (includeCompleted || !config.routing_intent?.trim() || !config.routing_anchors?.length)
            ).length - results.length),
            results,
        });
    } catch (error: any) {
        console.error('[ConfigBackfillRouting] Error:', error);
        return NextResponse.json({ error: error?.message || 'Failed to backfill routing signatures' }, { status: 500 });
    }
}
