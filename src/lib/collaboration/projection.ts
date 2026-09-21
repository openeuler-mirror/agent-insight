import { createHash } from 'node:crypto';
import { CollaborationService } from './service';
import { collaborationLog, failureDetails } from './log';
import type { Anchor } from './resolve';

export interface TraceLink { parent: string; child: string; anchor: Anchor; sequential?: boolean; order?: string }
export interface CollaborationProjectionPlan { hiddenChildren: string[]; links: TraceLink[] }

export function resolveTraceForest(links: TraceLink[]): TraceLink[] {
    const parents = new Map<string, Set<string>>();
    for (const link of links) {
        const values = parents.get(link.child) ?? new Set<string>();
        values.add(link.parent);
        parents.set(link.child, values);
    }
    const invalid = new Set<string>();
    for (const start of parents.keys()) {
        const path = new Set<string>();
        let current = start;
        while (parents.has(current)) {
            if (path.has(current) || parents.get(current)!.size !== 1) {
                for (const id of path) invalid.add(id);
                invalid.add(current);
                break;
            }
            path.add(current);
            current = [...parents.get(current)!][0];
        }
    }
    // A conflicting component stays visible in full; never hide one of its ancestors.
    let changed = true;
    while (changed) {
        changed = false;
        for (const { parent, child } of links) {
            if (invalid.has(parent) || invalid.has(child)) {
                for (const id of [parent, child]) if (!invalid.has(id)) { invalid.add(id); changed = true; }
            }
        }
    }
    const unique = new Map<string, TraceLink>();
    for (const link of links) {
        if (invalid.has(link.parent) || invalid.has(link.child)) continue;
        const old = unique.get(link.child);
        if (!old) unique.set(link.child, link);
        else if (old.sequential && !link.sequential) unique.set(link.child, link);
        else if (!old.sequential && link.sequential) continue;
        else if (JSON.stringify(old.anchor) !== JSON.stringify(link.anchor)) {
            unique.set(link.child, { ...old, anchor: { status: 'ambiguous', message: '同一子 Trace 有多个上报位置，在父 Agent 下展示一次' } });
        }
    }
    return [...unique.values()].sort((a, b) => (Date.parse(a.order ?? '') || 0) - (Date.parse(b.order ?? '') || 0));
}

class ProjectionLimitError extends Error {}

export class CollaborationProjection {
    constructor(private service: CollaborationService) {}
    async plan(user: string): Promise<CollaborationProjectionPlan> {
        try {
            const groups = await this.service.store.sql.rows<{ collaborationId: string }>(
                'SELECT "collaborationId" FROM "Collaboration" WHERE "user"=? AND "id" IN (SELECT "collaborationDbId" FROM "CollaborationEvent" WHERE "sourceType"=\'reported\') ORDER BY "collaborationId" LIMIT 201', [user]);
            if (groups.length > 200) throw new ProjectionLimitError('协作组超过 200，保留原列表');
            const claimedGoalPlusChildren = new Set<string>();
            const inputs: Array<{ collaborationId: string; ids: Map<string, string> }> = [];
            for (const group of groups) {
                const snapshot = await this.service.store.snapshot(user, group.collaborationId, 0, 1);
                const bindings = snapshot.bindings;
                const ids = new Map(bindings.map(binding => [binding.sessionId, binding.traceSessionId]));
                if (/^gp\.[a-f0-9]{32}$/.test(group.collaborationId)) {
                    for (const row of snapshot.events) {
                        if (row.sourceType !== 'reported') continue;
                        let event: { fromSessionId?: string; toSessionId?: string };
                        try { event = JSON.parse(row.bodyJson); } catch { continue; }
                        if (event.fromSessionId !== 'main' || !event.toSessionId?.startsWith('worker:')) continue;
                        const child = ids.get(event.toSessionId);
                        if (child) claimedGoalPlusChildren.add(child);
                    }
                }
                inputs.push({ collaborationId: group.collaborationId, ids });
            }
            const links: TraceLink[] = [];
            const unavailable = new Set<string>();
            const sizes = new Map<string, number>();
            try {
                for (const input of inputs) {
                    const graph = await this.service.graph(user, input.collaborationId, 0, 2000);
                    const nodes = new Map(graph.nodes.map(node => [node.sessionId, node]));
                    for (const id of new Set(input.ids.values())) {
                        if (sizes.has(id)) continue;
                        if (sizes.size >= 200) throw new ProjectionLimitError('Trace 投影超过 200 个 Session');
                        const rows = await this.service.store.sql.rows<{ bytes: number; embedded: string | null; isSubagent: boolean | number }>(
                            'SELECT LENGTH(s."interactions") AS bytes, s."langfuseTraceNodes" AS embedded, e."isSubagent" FROM "Session" s JOIN "Execution" e ON e."taskId"=s."taskId" AND e."user"=s."user" WHERE s."user"=? AND s."taskId"=? LIMIT 2', [user, id]);
                        sizes.set(id, Number(rows[0]?.bytes ?? 0));
                        if (rows.length !== 1 || !rows[0].bytes || rows[0].bytes <= 2 || rows[0].isSubagent || (rows[0].embedded && rows[0].embedded !== '[]')) unavailable.add(id);
                    }
                    if ([...sizes.values()].reduce((sum, size) => sum + size, 0) > 32 * 1024 * 1024) throw new ProjectionLimitError('Trace 投影超过 32 MiB');
                    for (const event of graph.events) {
                        const parent = input.ids.get(event.fromSessionId);
                        const child = input.ids.get(event.toSessionId);
                        if (!parent || !child) { if (parent) unavailable.add(parent); if (child) unavailable.add(child); continue; }
                        links.push({ parent, child, anchor: event.fromAnchor as Anchor, sequential: !event.fromLocator, order: event.observedAt ?? event.receivedAt });
                        if (!graph.resolutionComplete || !nodes.get(event.fromSessionId)?.executionId || !nodes.get(event.toSessionId)?.executionId) {
                            unavailable.add(parent); unavailable.add(child);
                        }
                    }
                    if (!graph.resolutionComplete) for (const id of input.ids.values()) unavailable.add(id);
                    if (links.length > 2000) throw new ProjectionLimitError('协作关系超过 2000，保留原列表');
                }
            } catch (error) {
                if (error instanceof ProjectionLimitError) throw error;
                const hiddenChildren = [...claimedGoalPlusChildren];
                collaborationLog.warn('Trace 合并查询失败，已声明 Goal Plus worker 继续隐藏', { user, stage: 'projection', hiddenChildren: hiddenChildren.length, ...failureDetails(error) });
                return { hiddenChildren, links: [] };
            }
            // Generic relationships hide children only when the whole component is mergeable.
            let changed = true;
            while (changed) {
                changed = false;
                for (const { parent, child } of links) if (unavailable.has(parent) || unavailable.has(child)) {
                    for (const id of [parent, child]) if (!unavailable.has(id)) { unavailable.add(id); changed = true; }
                }
            }
            const resolved = resolveTraceForest(links).filter(link => !unavailable.has(link.parent) && !unavailable.has(link.child));
            const hiddenChildren = [...new Set([...claimedGoalPlusChildren, ...resolved.map(link => link.child)])];
            if (links.length || hiddenChildren.length) collaborationLog.info('Trace 合并关系已计算', { user, stage: 'projection', reportedRelations: links.length, hiddenChildren: hiddenChildren.length, mergedChildren: resolved.length, retainedRelations: links.length - resolved.length });
            return { hiddenChildren, links: resolved };
        } catch (error) {
            collaborationLog.warn('Trace 合并查询失败，保留原始列表', { user, stage: 'projection', ...(error instanceof ProjectionLimitError ? { causeCode: 'PROJECTION_LIMIT', reason: error.message } : failureDetails(error)) });
            return { hiddenChildren: [], links: [] };
        }
    }
    async links(user: string): Promise<TraceLink[]> {
        return (await this.plan(user)).links;
    }
    async interactions(user: string, root: string, load: (id: string) => Promise<{ session: { user?: string | null }; interactions: any[]; langfuseTraceNodes?: any[] } | null>) {
        const links = await this.links(user);
        const members = new Map<string, TraceLink | null>([[root, null]]);
        for (let changed = true; changed;) {
            changed = false;
            for (const link of links) if (members.has(link.parent) && !members.has(link.child)) { members.set(link.child, link); changed = true; }
        }
        if (members.size === 1) return null;
        const result: any[] = [];
        for (const [taskId, link] of members) {
            const parsed = await load(taskId);
            if (!parsed || parsed.session.user !== user || !parsed.interactions.length) return null;
            const version = createHash('sha256').update(JSON.stringify(parsed.interactions)).digest('hex');
            parsed.interactions.forEach((item, index) => result.push({ ...item, _collaboration: { taskId, index, version, parent: link?.parent, anchor: link?.anchor, sequential: link?.sequential, order: link?.order } }));
        }
        return result;
    }
}
