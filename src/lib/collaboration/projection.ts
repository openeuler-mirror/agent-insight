import { createHash } from 'node:crypto';
import { CollaborationService } from './service';
import { collaborationLog, failureDetails } from './log';
import type { Anchor } from './resolve';
import type { ParentAgentReference } from '@/lib/trace/parent-agent';

export interface TraceLink { parent: string; child: string; anchor: Anchor; sequential?: boolean; order?: string; independent?: boolean }
export interface CollaborationProjectionPlan {
    hiddenChildren: string[];
    pendingChildren: string[];
    links: TraceLink[];
    parentAgents?: Record<string, ParentAgentReference>;
    unavailable?: boolean;
}

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
    private async *groups(user: string) {
        let cursor = '';
        while (true) {
            const groups = await this.service.store.sql.rows<{ collaborationId: string }>(
                'SELECT "collaborationId" FROM "Collaboration" WHERE "user"=? AND "collaborationId">? AND "id" IN (SELECT "collaborationDbId" FROM "CollaborationEvent" WHERE "sourceType"=\'reported\') ORDER BY "collaborationId" LIMIT 200', [user, cursor]);
            for (const group of groups) yield group;
            if (groups.length < 200) return;
            cursor = groups[groups.length - 1].collaborationId;
        }
    }
    private async groupMembers(user: string, collaborationId: string) {
        return this.service.store.sql.rows<{ traceSessionId: string; goalPlusChild: number | bigint }>(`
            WITH endpoints AS (
                SELECT "fromSessionId" AS "sessionId" FROM "CollaborationEvent" WHERE "user"=? AND "collaborationId"=?
                UNION SELECT "toSessionId" FROM "CollaborationEvent" WHERE "user"=? AND "collaborationId"=?
            )
            SELECT b."traceSessionId", CASE WHEN EXISTS (
                SELECT 1 FROM "CollaborationEvent" e WHERE e."user"=b."user" AND e."collaborationId"=b."collaborationId"
                    AND e."sourceType"='reported' AND e."fromSessionId"='main' AND e."toSessionId"=b."sessionId"
                    AND e."toSessionId" LIKE 'worker:%'
            ) THEN 1 ELSE 0 END AS "goalPlusChild" FROM "CollaborationSessionBinding" b WHERE b."user"=? AND b."collaborationId"=?
            UNION SELECT "taskId" AS "traceSessionId", 0 AS "goalPlusChild" FROM "Execution" WHERE "user"=? AND "taskId" IS NOT NULL
                AND ("taskId" IN (SELECT "sessionId" FROM endpoints) OR "agentSessionId" IN (SELECT "sessionId" FROM endpoints))`,
        [user, collaborationId, user, collaborationId, user, collaborationId, user]);
    }
    async plan(user: string): Promise<CollaborationProjectionPlan> {
        try {
            const claimedGoalPlusChildren = new Set<string>();
            const declaredLinks: TraceLink[] = [];
            const missingParents = new Set<string>();
            const strictLinks: TraceLink[] = [];
            const independentLinks: TraceLink[] = [];
            const unavailable = new Set<string>();
            const failed = new Set<string>();
            const memberships: Set<string>[] = [];
            const summaries = new Map<string, { id: string; agentName: string | null; subagentName: string | null; framework: string | null }>();
            for await (const group of this.groups(user)) {
                const members = new Set<string>();
                memberships.push(members);
                try {
                    const snapshot = await this.service.store.snapshot(user, group.collaborationId, 0, 1);
                    const ids = new Map(snapshot.bindings.map(binding => [binding.sessionId, binding.traceSessionId]));
                    for (const id of ids.values()) members.add(id);
                    if (!snapshot.complete) throw new ProjectionLimitError('协作组超过事件或绑定解析上限');
                    const input = { collaborationId: group.collaborationId, ids, goalPlus: /^gp\.[a-f0-9]{32}$/.test(group.collaborationId) };
                    if (input.goalPlus) {
                        for (const row of snapshot.events) {
                            if (row.sourceType !== 'reported') continue;
                            let event: { fromSessionId?: string; toSessionId?: string };
                            try { event = JSON.parse(row.bodyJson); } catch { continue; }
                            if (event.fromSessionId !== 'main' || !event.toSessionId?.startsWith('worker:')) continue;
                            const child = ids.get(event.toSessionId);
                            if (child) {
                                claimedGoalPlusChildren.add(child);
                                const parent = ids.get(event.fromSessionId);
                                if (parent) declaredLinks.push({ parent, child, anchor: { status: 'not_provided', message: '' } });
                                else missingParents.add(child);
                            }
                        }
                    }
                    const sizes = new Map<string, number>();
                    const ready = new Map<string, boolean>();
                    const graph = await this.service.graph(user, input.collaborationId, 0, 2000);
                    const nodes = new Map(graph.nodes.map(node => [node.sessionId, node]));
                    const resolvedIds = input.goalPlus ? input.ids : new Map(graph.nodes.flatMap(node => node.traceSessionId ? [[node.sessionId, node.traceSessionId] as const] : []));
                    for (const id of resolvedIds.values()) members.add(id);
                    if (!graph.resolutionComplete) throw new ProjectionLimitError('协作组超过图解析上限');
                    if (graph.events.length > 2000) throw new ProjectionLimitError('协作组超过 2000 条关系');
                    const groupLinks: TraceLink[] = [];
                    for (const id of new Set(resolvedIds.values())) {
                        if (!sizes.has(id)) {
                            if (sizes.size >= 200) throw new ProjectionLimitError('Trace 投影超过 200 个 Session');
                            const rows = await this.service.store.sql.rows<{ bytes: number; embedded: string | null; isSubagent: boolean | number; id: string; agentName: string | null; subagentName: string | null; framework: string | null }>(
                                'SELECT LENGTH(s."interactions") AS bytes, s."langfuseTraceNodes" AS embedded, e."isSubagent", e."id", e."agentName", e."subagentName", e."framework" FROM "Session" s JOIN "Execution" e ON e."taskId"=s."taskId" AND e."user"=s."user" WHERE s."user"=? AND s."taskId"=? LIMIT 2', [user, id]);
                            sizes.set(id, Number(rows[0]?.bytes ?? 0));
                            ready.set(id, rows.length === 1 && Boolean(rows[0].bytes && rows[0].bytes > 2 && !rows[0].isSubagent && (!rows[0].embedded || rows[0].embedded === '[]')));
                            if (rows.length === 1) summaries.set(id, rows[0]);
                        }
                        if (!input.goalPlus && !ready.get(id)) unavailable.add(id);
                    }
                    if ([...sizes.values()].reduce((sum, size) => sum + size, 0) > 32 * 1024 * 1024) throw new ProjectionLimitError('Trace 投影超过 32 MiB');
                    for (const event of graph.events) {
                        const parent = resolvedIds.get(event.fromSessionId);
                        const child = resolvedIds.get(event.toSessionId);
                        if (input.goalPlus) {
                            if (event.fromSessionId !== 'main' || !event.toSessionId.startsWith('worker:')
                                || !parent || !child
                                || !nodes.get(event.fromSessionId)?.executionId || !nodes.get(event.toSessionId)?.executionId
                                || !ready.get(parent) || !ready.get(child)) continue;
                            independentLinks.push({ parent, child, anchor: event.fromAnchor as Anchor, sequential: !event.fromLocator, order: event.observedAt ?? event.receivedAt, independent: true });
                            continue;
                        }
                        if (!parent || !child) { if (parent) unavailable.add(parent); if (child) unavailable.add(child); continue; }
                        groupLinks.push({ parent, child, anchor: event.fromAnchor as Anchor, sequential: !event.fromLocator, order: event.observedAt ?? event.receivedAt });
                        if (!nodes.get(event.fromSessionId)?.executionId || !nodes.get(event.toSessionId)?.executionId) {
                            unavailable.add(parent); unavailable.add(child);
                        }
                    }
                    if (!input.goalPlus) {
                        const members = [...new Set(graph.events.flatMap(event => [resolvedIds.get(event.fromSessionId), resolvedIds.get(event.toSessionId)]).filter((id): id is string => Boolean(id)))];
                        const anchored = resolveTraceForest(groupLinks.filter(link => !link.sequential && link.parent !== link.child && Boolean(link.anchor.position || (link.anchor.status === 'candidate' && link.anchor.candidates?.length === 1))));
                        const children = new Set(anchored.map(link => link.child));
                        const root = members.find(id => !children.has(id));
                        if (root) {
                            strictLinks.push(...anchored);
                            for (const member of members) {
                                if (member === root || children.has(member)) continue;
                                const first = groupLinks.find(link => link.parent === member || link.child === member);
                                strictLinks.push({ parent: root, child: member, sequential: true, order: first?.order,
                                    anchor: { status: 'not_provided', message: '无唯一调用父级，按上报顺序并列展示' } });
                            }
                        }
                    }
                } catch (error) {
                    for (const member of await this.groupMembers(user, group.collaborationId)) {
                        members.add(member.traceSessionId);
                        if (/^gp\.[a-f0-9]{32}$/.test(group.collaborationId) && Number(member.goalPlusChild)) {
                            claimedGoalPlusChildren.add(member.traceSessionId);
                        }
                    }
                    for (const id of members) failed.add(id);
                    collaborationLog.warn('协作组 Trace 合并失败，仅相关链路保留原始列表', {
                        user, collaborationId: group.collaborationId, stage: 'projection',
                        ...(error instanceof ProjectionLimitError ? { causeCode: 'PROJECTION_LIMIT', reason: error.message } : failureDetails(error)),
                    });
                }
            }
            let failedChanged = true;
            while (failedChanged) {
                failedChanged = false;
                for (const members of memberships) {
                    if (![...members].some(id => failed.has(id))) continue;
                    for (const id of members) if (!failed.has(id)) { failed.add(id); failedChanged = true; }
                }
            }
            // Generic relationships hide children only when the whole component is mergeable.
            let changed = true;
            while (changed) {
                changed = false;
                for (const { parent, child } of strictLinks) if (unavailable.has(parent) || unavailable.has(child)) {
                    for (const id of [parent, child]) if (!unavailable.has(id)) { unavailable.add(id); changed = true; }
                }
            }
            const safeDeclarations = resolveTraceForest([...strictLinks, ...declaredLinks]);
            const safeChildren = new Set(safeDeclarations.map(link => link.child));
            const resolved = resolveTraceForest([...strictLinks, ...independentLinks])
                .filter(link => !failed.has(link.parent) && !failed.has(link.child))
                .filter(link => link.independent
                    ? safeChildren.has(link.child) && !missingParents.has(link.child)
                    : !unavailable.has(link.parent) && !unavailable.has(link.child));
            const parentAgents: Record<string, ParentAgentReference> = Object.create(null);
            for (const child of claimedGoalPlusChildren) {
                const declared = declaredLinks.some(link => link.child === child);
                const relation = resolved.find(link => link.independent && link.child === child);
                const parent = relation && summaries.get(relation.parent);
                parentAgents[child] = failed.has(child) ? { state: 'unavailable' } : declared && !safeChildren.has(child) ? { state: 'ambiguous' }
                    : relation && parent ? { state: 'resolved', taskId: relation.parent, executionId: parent.id,
                        agentName: parent.agentName || parent.subagentName || parent.framework || 'Agent', framework: parent.framework }
                    : { state: 'pending' };
            }
            const hiddenChildren = [...new Set([...claimedGoalPlusChildren, ...resolved.map(link => link.child)])].filter(id => !failed.has(id));
            const mergedChildren = new Set(resolved.filter(link => link.independent).map(link => link.child));
            const pendingChildren = [...claimedGoalPlusChildren].filter(child => !failed.has(child) && !mergedChildren.has(child));
            const reportedRelations = strictLinks.length + independentLinks.length;
            if (reportedRelations || hiddenChildren.length) collaborationLog.info('Trace 合并关系已计算', { user, stage: 'projection', reportedRelations, hiddenChildren: hiddenChildren.length, pendingChildren: pendingChildren.length, mergedChildren: resolved.length, retainedRelations: reportedRelations - resolved.length });
            return { hiddenChildren, pendingChildren, links: resolved, parentAgents };
        } catch (error) {
            collaborationLog.warn('Trace 合并查询失败，保留原始列表', { user, stage: 'projection', ...(error instanceof ProjectionLimitError ? { causeCode: 'PROJECTION_LIMIT', reason: error.message } : failureDetails(error)) });
            return { hiddenChildren: [], pendingChildren: [], links: [], unavailable: true };
        }
    }
    async links(user: string): Promise<TraceLink[]> {
        return (await this.plan(user)).links;
    }
    async interactions(user: string, root: string, load: (id: string) => Promise<{ session: { user?: string | null }; interactions: any[]; langfuseTraceNodes?: any[] } | null>, plan?: CollaborationProjectionPlan) {
        const links = plan?.links ?? await this.links(user);
        const members = new Map<string, TraceLink | null>([[root, null]]);
        for (let changed = true; changed;) {
            changed = false;
            for (const link of links) if (members.has(link.parent) && !members.has(link.child)) { members.set(link.child, link); changed = true; }
        }
        if (members.size === 1) return null;
        const result: any[] = [];
        let includedChildren = 0;
        for (const [taskId, link] of members) {
            const parsed = await load(taskId);
            if (!parsed || parsed.session.user !== user || !parsed.interactions.length) {
                if (link?.independent) continue;
                return null;
            }
            const version = createHash('sha256').update(JSON.stringify(parsed.interactions)).digest('hex');
            parsed.interactions.forEach((item, index) => result.push({ ...item, _collaboration: { taskId, index, version, parent: link?.parent, anchor: link?.anchor, sequential: link?.sequential, order: link?.order } }));
            if (link) includedChildren += 1;
        }
        return includedChildren ? result : null;
    }
}
