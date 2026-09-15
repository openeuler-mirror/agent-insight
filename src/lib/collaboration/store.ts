import { randomUUID } from 'node:crypto';
import { Binding, canonical, CollaborationError, digest, RelationEvent } from './contracts';

export interface SqlConnection {
    rows<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]>;
    execute(sql: string, values?: unknown[]): Promise<void>;
}
export interface SqlDatabase extends SqlConnection { transaction<T>(work: (connection: SqlConnection) => Promise<T>): Promise<T>; }

type SqlClient = {
    connect?: () => Promise<SqlClient>;
    query?: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
    release?: () => void;
    $queryRawUnsafe?: <T>(sql: string, ...values: unknown[]) => Promise<T>;
    $executeRawUnsafe?: (sql: string, ...values: unknown[]) => Promise<unknown>;
    $transaction?: <T>(work: (client: SqlClient) => Promise<T>, options: { maxWait: number; timeout: number }) => Promise<T>;
};

export function sqlDatabase(client: SqlClient): SqlDatabase {
    const postgres = typeof client.connect === 'function';
    const wrap = (connection: SqlClient): SqlConnection => {
        const statement = (sql: string) => { let index = 0; return postgres ? sql.replace(/\?/g, () => `$${++index}`) : sql; };
        return {
            async rows<T>(sql: string, values: unknown[] = []): Promise<T[]> {
                if (postgres) return (await connection.query!(statement(sql), values)).rows as T[];
                return connection.$queryRawUnsafe!<T[]>(sql, ...values);
            },
            async execute(sql, values = []) {
                if (postgres) await connection.query!(statement(sql), values);
                else await connection.$executeRawUnsafe!(sql, ...values);
            },
        };
    };
    return {
        ...wrap(client),
        async transaction<T>(work: (connection: SqlConnection) => Promise<T>): Promise<T> {
            if (!postgres) return client.$transaction!(tx => work(wrap(tx)), { maxWait: 10000, timeout: 15000 });
            const connection = await client.connect!();
            try {
                await connection.query!('BEGIN');
                const result = await work(wrap(connection));
                await connection.query!('COMMIT');
                return result;
            } catch (error) { await connection.query!('ROLLBACK'); throw error; }
            finally { connection.release!(); }
        },
    };
}
export type SavedEvent = { id: string; eventId: string; bodyJson: string; bodyHash: string; receivedAt: string; sourceType: string };
export type SavedBinding = Binding & { id: string; createdAt: string };
export type SavedResolution = {
    eventDbId: string; side: 'from' | 'to'; executionId: string | null; linkState: string;
    linkMethod: string | null; evidenceJson: string; anchorState: string | null; anchorJson: string | null;
};
export const MAX_GROUP_EVENTS = 2000;
export const MAX_TRACE_SESSIONS = 200;
export class CollaborationStore {
    constructor(public sql: SqlDatabase) {}
    private async ensure(connection: SqlConnection, user: string, id: string): Promise<string> {
        const [existing] = await connection.rows<{ id: string }>('SELECT "id" FROM "Collaboration" WHERE "user"=? AND "collaborationId"=?', [user, id]);
        if (existing) return existing.id;
        const dbId = randomUUID();
        const now = new Date().toISOString();
        await connection.execute('INSERT INTO "Collaboration" ("id","user","collaborationId","createdAt","updatedAt") VALUES (?,?,?,?,?) ON CONFLICT ("user","collaborationId") DO NOTHING', [dbId, user, id, now, now]);
        const [saved] = await connection.rows<{ id: string }>('SELECT "id" FROM "Collaboration" WHERE "user"=? AND "collaborationId"=?', [user, id]);
        return saved.id;
    }
    async saveEvent(user: string, event: RelationEvent) {
        return this.sql.transaction(async tx => {
            const collaborationDbId = await this.ensure(tx, user, event.collaborationId);
            const id = randomUUID();
            const now = new Date().toISOString();
            const bodyJson = canonical(event);
            const bodyHash = digest(event);
            await tx.execute('INSERT INTO "CollaborationEvent" ("id","collaborationDbId","user","collaborationId","eventId","fromSessionId","toSessionId","description","observedAt","content","fromLocatorJson","sourceType","bodyJson","bodyHash","receivedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT ("user","collaborationId","eventId") DO NOTHING', [id, collaborationDbId, user, event.collaborationId, event.eventId, event.fromSessionId, event.toSessionId, event.description, event.observedAt ?? null, event.content ?? null, event.fromLocator ? canonical(event.fromLocator) : null, 'reported', bodyJson, bodyHash, now]);
            const [saved] = await tx.rows<SavedEvent>('SELECT "id","eventId","bodyJson","bodyHash","receivedAt","sourceType" FROM "CollaborationEvent" WHERE "user"=? AND "collaborationId"=? AND "eventId"=?', [user, event.collaborationId, event.eventId]);
            if (saved.bodyHash !== digest(event) || saved.bodyJson !== canonical(event)) throw new CollaborationError(409, 'EVENT_CONFLICT', '该事件编号已保存不同内容，不能覆盖');
            if (saved.id === id) {
                for (const side of ['from', 'to']) {
                    await tx.execute('INSERT INTO "CollaborationEndpointResolution" ("id","eventDbId","side","linkState","evidenceJson","updatedAt") VALUES (?,?,?,?,?,?) ON CONFLICT ("eventDbId","side") DO NOTHING', [randomUUID(), id, side, 'pending', '{}', now]);
                }
                await tx.execute('UPDATE "Collaboration" SET "updatedAt"=? WHERE "id"=?', [now, collaborationDbId]);
            }
            return { saved, result: saved.id === id ? 'created' as const : 'duplicate' as const };
        });
    }
    async bind(user: string, binding: Binding) {
        return this.sql.transaction(async tx => {
            await this.ensure(tx, user, binding.collaborationId);
            const existing = await tx.rows<{ user: string }>('SELECT "user" FROM "Session" WHERE "taskId"=?', [binding.traceSessionId]);
            if (existing.length && existing[0].user !== user) throw new CollaborationError(403, 'FORBIDDEN', '无权绑定该 Trace');
            const id = randomUUID();
            await tx.execute('INSERT INTO "CollaborationSessionBinding" ("id","user","collaborationId","sessionId","traceSessionId","eventClock","createdAt") VALUES (?,?,?,?,?,?,?) ON CONFLICT ("user","collaborationId","sessionId") DO NOTHING', [id, user, binding.collaborationId, binding.sessionId, binding.traceSessionId, binding.eventClock, new Date().toISOString()]);
            const [saved] = await tx.rows<SavedBinding>('SELECT * FROM "CollaborationSessionBinding" WHERE "user"=? AND "collaborationId"=? AND "sessionId"=?', [user, binding.collaborationId, binding.sessionId]);
            if (saved.traceSessionId !== binding.traceSessionId || saved.eventClock !== binding.eventClock) throw new CollaborationError(409, 'BINDING_CONFLICT', '会话绑定或时钟依据已存在，不能覆盖');
            return { ...binding, createdAt: saved.createdAt, result: saved.id === id ? 'created' : 'duplicate' };
        });
    }
    async snapshot(user: string, id: string, offset: number, limit: number) {
        const entries = await this.sql.rows('SELECT "id" FROM "Collaboration" WHERE "user"=? AND "collaborationId"=?', [user, id]);
        if (!entries.length) throw new CollaborationError(404, 'NOT_FOUND', '协作不存在或无权访问');
        return this.sql.transaction(async tx => {
            const [count] = await tx.rows<{ total: number | bigint }>('SELECT COUNT(*) AS total FROM "CollaborationEvent" WHERE "user"=? AND "collaborationId"=?', [user, id]);
            const total = Number(count.total);
            const page = await tx.rows<SavedEvent>('SELECT "id","eventId","bodyJson","bodyHash","receivedAt","sourceType" FROM "CollaborationEvent" WHERE "user"=? AND "collaborationId"=? ORDER BY "receivedAt","id" LIMIT ? OFFSET ?', [user, id, limit, offset]);
            const events = total <= MAX_GROUP_EVENTS ? await tx.rows<SavedEvent>('SELECT "id","eventId","bodyJson","bodyHash","receivedAt","sourceType" FROM "CollaborationEvent" WHERE "user"=? AND "collaborationId"=? ORDER BY "receivedAt","id" LIMIT ?', [user, id, MAX_GROUP_EVENTS + 1]) : [];
            const bindings = await tx.rows<SavedBinding>('SELECT * FROM "CollaborationSessionBinding" WHERE "user"=? AND "collaborationId"=? ORDER BY "id" LIMIT ?', [user, id, MAX_TRACE_SESSIONS + 1]);
            return { total, page, events, bindings, complete: total <= MAX_GROUP_EVENTS && events.length === total && bindings.length <= MAX_TRACE_SESSIONS };
        });
    }
    async resolutions(eventIds: string[]): Promise<SavedResolution[]> {
        if (!eventIds.length) return [];
        const placeholders = eventIds.map(() => '?').join(',');
        return this.sql.rows<SavedResolution>(`SELECT "eventDbId","side","executionId","linkState","linkMethod","evidenceJson","anchorState","anchorJson" FROM "CollaborationEndpointResolution" WHERE "eventDbId" IN (${placeholders})`, eventIds);
    }
    async trace(user: string, binding: Binding) {
        const [session] = await this.sql.rows<{ taskId: string; interactions: string | null; byteSize: number | bigint; user: string }>('SELECT "taskId","user", CASE WHEN LENGTH("interactions") <= 8388608 THEN "interactions" ELSE NULL END AS "interactions", LENGTH("interactions") AS "byteSize" FROM "Session" WHERE "taskId"=? AND "user"=?', [binding.traceSessionId, user]);
        if (!session) return null;
        if (!session.interactions || Buffer.byteLength(session.interactions) > 8388608) return { state: 'pending' as const, message: 'Trace 无正文或超过 8 MiB 解析限制' };
        const executions = await this.sql.rows<{ id: string; agentName: string | null; framework: string | null; agentSessionId: string | null }>('SELECT "id","agentName","framework","agentSessionId" FROM "Execution" WHERE "taskId"=? AND "user"=? ORDER BY "id" LIMIT 2', [binding.traceSessionId, user]);
        const interactions: unknown = JSON.parse(session.interactions);
        if (!Array.isArray(interactions) || interactions.length > 20000) return { state: 'pending' as const, message: 'Trace 结构无效或超过 20000 条交互限制' };
        return { state: 'resolved' as const, interactions, byteCount: Buffer.byteLength(session.interactions), execution: executions.length === 1 ? executions[0] : undefined };
    }
}
