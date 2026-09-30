import { Prisma } from '@prisma/client';
import { TRACE_INACTIVITY_TIMEOUT_MS } from '@/lib/observe/trace-lifecycle';
import { BUILTIN_MODEL_PRICING, DEFAULT_CACHE_CREATION_RATIO, DEFAULT_CACHE_READ_RATIO, getCustomModels } from '@/lib/shared/model-config';
import { prismaRaw } from '@/lib/storage/prisma';
import type { ComputedRecordPageOptions } from './computed-record-page';

const executionFields = new Map(Prisma.dmmf.datamodel.models.find(model => model.name === 'Execution')!
    .fields.filter(field => field.kind !== 'object').map(field => [field.name, field.type]));

function scalar(value: unknown, type?: string): string | number | bigint | null {
    if (value === null) return null;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
    if (type === 'DateTime' && typeof value === 'string') {
        const timestamp = Date.parse(value);
        if (!Number.isFinite(timestamp)) throw new Error('Unsupported Execution datetime filter value');
        return timestamp;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' || typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw new Error('Unsupported Execution filter value');
}

function combine(parts: Prisma.Sql[], separator: 'AND' | 'OR'): Prisma.Sql {
    if (!parts.length) return Prisma.raw(separator === 'AND' ? '1=1' : '1=0');
    return Prisma.sql`(${Prisma.join(parts, ` ${separator} `)})`;
}

function fieldFilter(field: Prisma.Sql, value: unknown, type?: string, inverted = false): Prisma.Sql | null {
    if (value === null) return Prisma.sql`${field} ${Prisma.raw(inverted ? 'IS NOT NULL' : 'IS NULL')}`;
    if (value instanceof Date || typeof value !== 'object') return Prisma.sql`${field} ${Prisma.raw(inverted ? '<>' : '=')} ${scalar(value, type)}`;
    if (Array.isArray(value)) throw new Error('Unsupported Execution field filter');
    const conditions: Prisma.Sql[] = [];
    for (const [operator, operand] of Object.entries(value as Record<string, unknown>)) {
        if (operand === undefined) continue;
        if (operator === 'not') {
            // Prisma keeps scalar inversion enabled through nested `not` and negates each enclosed operator.
            const inner = fieldFilter(field, operand, type, true);
            if (inner) conditions.push(inner);
        } else if (operator === 'equals') {
            conditions.push(operand === null ? Prisma.sql`${field} ${Prisma.raw(inverted ? 'IS NOT NULL' : 'IS NULL')}`
                : Prisma.sql`${field} ${Prisma.raw(inverted ? '<>' : '=')} ${scalar(operand, type)}`);
        } else if (operator === 'in' || operator === 'notIn') {
            const includes = (operator === 'in') !== inverted;
            if (operand === null) {
                conditions.push(Prisma.sql`${field} ${Prisma.raw(includes ? 'IS NULL' : 'IS NOT NULL')}`);
                continue;
            }
            if (!Array.isArray(operand)) throw new Error(`Unsupported Execution operator value: ${operator}`);
            const values = operand.map(item => {
                const parsed = scalar(item, type);
                if (parsed === null) throw new Error('Null is not supported inside Execution membership filters');
                return typeof parsed === 'bigint' ? parsed.toString() : parsed;
            });
            conditions.push(!values.length ? Prisma.raw(includes ? '1=0' : '1=1')
                : Prisma.sql`${field} ${Prisma.raw(includes ? 'IN' : 'NOT IN')} (SELECT value FROM json_each(${JSON.stringify(values)}))`);
        } else if (operator === 'contains' || operator === 'startsWith' || operator === 'endsWith') {
            if (typeof operand !== 'string') throw new Error(`Unsupported Execution operator value: ${operator}`);
            const pattern = `${operator !== 'startsWith' ? '%' : ''}${operand}${operator !== 'endsWith' ? '%' : ''}`;
            conditions.push(Prisma.sql`${field} ${Prisma.raw(inverted ? 'NOT LIKE' : 'LIKE')} ${pattern}`);
        } else if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
            const comparison = (inverted ? { gt: '<=', gte: '<', lt: '>=', lte: '>' } : { gt: '>', gte: '>=', lt: '<', lte: '<=' })[operator];
            conditions.push(Prisma.sql`${field} ${Prisma.raw(comparison)} ${scalar(operand, type)}`);
        } else {
            throw new Error(`Unsupported Execution filter operator: ${operator}`);
        }
    }
    return conditions.length ? combine(conditions, 'AND') : null;
}

function compileWhere(where: unknown, nested = false): Prisma.Sql | null {
    if (!where || typeof where !== 'object' || Array.isArray(where)) throw new Error('Invalid Execution where');
    const conditions: Prisma.Sql[] = [];
    for (const [key, value] of Object.entries(where)) {
        if (value === undefined) continue;
        if (key === 'AND' || key === 'OR' || key === 'NOT') {
            const children = Array.isArray(value) ? value : [value];
            const parts = children.map(child => compileWhere(child, true)).filter((part): part is Prisma.Sql => part !== null);
            // Prisma omits empty logical groups inside a parent group, including empty OR.
            if ((key === 'OR' && !nested) || parts.length) conditions.push(key === 'NOT'
                ? combine(parts.map(part => Prisma.sql`NOT (${part})`), 'AND') : combine(parts, key));
        } else {
            if (!executionFields.has(key)) throw new Error(`Unsupported Execution filter field: ${key}`);
            const condition = fieldFilter(Prisma.raw(`e."${key}"`), value, executionFields.get(key));
            if (condition) conditions.push(condition);
        }
    }
    return conditions.length ? combine(conditions, 'AND') : null;
}

export function compileExecutionWhere(where: Prisma.ExecutionWhereInput): Prisma.Sql {
    return compileWhere(where) ?? Prisma.sql`1=1`;
}

function timestampMs(value: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`(CASE WHEN typeof(${value}) IN ('integer', 'real') THEN ${value}
        ELSE ROUND((julianday(${value}) - 2440587.5) * 86400000) END)`;
}

const taskKey = Prisma.sql`COALESCE(NULLIF(e."taskId", ''), e.id)`;
const from = Prisma.sql`FROM "Execution" e LEFT JOIN "Session" s ON s."taskId" = ${taskKey}`;
const completedAt = timestampMs(Prisma.sql`s."endTime"`);
const failed = Prisma.sql`EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(e.failures) THEN
        CASE WHEN json_type(e.failures) = 'array' THEN e.failures ELSE '[]' END ELSE '[]' END) failure
    WHERE json_extract(CASE WHEN failure.type = 'object' THEN failure.value ELSE '{}' END, '$.failure_type') = 'goal_plus_pi_session_failed'
       OR (e.framework = 'actrail' AND json_extract(CASE WHEN failure.type = 'object' THEN failure.value ELSE '{}' END, '$.failure_type') = 'agent-process-exit')
)`;

function lifecycle(now: number): Prisma.Sql {
    const received = timestampMs(Prisma.sql`e."lastIngestedAt"`);
    const created = timestampMs(Prisma.sql`e.timestamp`);
    const latest = Prisma.sql`CASE WHEN ${received} > 0 THEN ${received} WHEN ${created} > 0 THEN ${created} ELSE NULL END`;
    return Prisma.sql`(CASE WHEN ${completedAt} > 0 THEN CASE WHEN ${failed} THEN 'failed' ELSE 'success' END
        WHEN ${latest} <= ${now - TRACE_INACTIVITY_TIMEOUT_MS} THEN 'timed_out' ELSE 'running' END)`;
}

function anomaly(): Prisma.Sql {
    return Prisma.sql`(EXISTS (SELECT 1 FROM "RasAnomalyEvent" a WHERE a."taskId" = ${taskKey})
        OR EXISTS (SELECT 1 FROM "RasAnomalyEvent" a WHERE a."executionId" = e.id))`;
}

type ComputedFilters = Pick<ComputedRecordPageOptions, 'status' | 'anomaly' | 'lifecycleNow'>;

function predicate(where: Prisma.ExecutionWhereInput, options: Partial<ComputedFilters>): Prisma.Sql {
    const parts = [compileExecutionWhere(where)];
    if (options.status && options.status !== 'all') parts.push(Prisma.sql`${lifecycle(options.lifecycleNow ?? Date.now())} = ${options.status}`);
    if (options.anomaly === 'abnormal') parts.push(anomaly());
    else if (options.anomaly === 'unknown') parts.push(Prisma.sql`NOT ${anomaly()}`);
    else if (options.anomaly && options.anomaly !== 'all') parts.push(Prisma.sql`1=0`);
    return combine(parts, 'AND');
}

export async function aggregateExecutionList(
    where: Prisma.ExecutionWhereInput,
    options: Partial<ComputedFilters> & { avgNullAsZero?: boolean } = {},
    client: Pick<typeof prismaRaw, '$queryRaw'> = prismaRaw,
) {
    const latency = options.avgNullAsZero ? Prisma.sql`COALESCE(e.latency, 0)` : Prisma.sql`e.latency`;
    const [row] = await client.$queryRaw<Array<{
        total: bigint; failedCount: bigint; avgLatencyMs: number | null; totalTools: number | null; totalToolErrors: number | null;
    }>>(Prisma.sql`SELECT COUNT(*) AS total,
        SUM(CASE WHEN ${completedAt} > 0 AND ${failed} THEN 1 ELSE 0 END) AS "failedCount",
        AVG(${latency}) AS "avgLatencyMs", SUM(e."toolCallCount") AS "totalTools", SUM(e."toolCallErrorCount") AS "totalToolErrors"
        ${from} WHERE ${predicate(where, options)}`);
    const totalTools = Number(row.totalTools ?? 0);
    const totalToolErrors = Number(row.totalToolErrors ?? 0);
    return {
        total: Number(row.total), failedCount: Number(row.failedCount ?? 0), avgLatencyMs: Number(row.avgLatencyMs ?? 0),
        toolErrorRate: totalTools > 0 ? Math.round(totalToolErrors / totalTools * 1000) / 10 : 0,
    };
}

function cost(): Prisma.Sql {
    const prices = [getCustomModels().pricing, BUILTIN_MODEL_PRICING].flatMap((table, priority) =>
        Object.entries(table).map(([prefix, pricing]) => ({
            prefix, priority, input: pricing.inputTokenPrice, output: pricing.outputTokenPrice,
            cacheRead: pricing.cacheReadInputTokenPrice ?? pricing.inputTokenPrice * DEFAULT_CACHE_READ_RATIO,
            cacheCreation: pricing.cacheCreationInputTokenPrice ?? pricing.inputTokenPrice * DEFAULT_CACHE_CREATION_RATIO,
        }))).sort((a, b) => a.priority - b.priority || b.prefix.length - a.prefix.length);
    const branches = prices.map(price => Prisma.sql`WHEN substr(e.model, 1, length(${price.prefix})) = ${price.prefix} THEN
        (CAST(e."inputTokens" AS REAL) * ${price.input}
            + CAST(COALESCE(e."cacheReadInputTokens", 0) AS REAL) * ${price.cacheRead}
            + CAST(COALESCE(e."cacheCreationInputTokens", 0) AS REAL) * ${price.cacheCreation}
            + CAST(e."outputTokens" AS REAL) * ${price.output}) / 1000000.0`);
    return Prisma.sql`(CASE WHEN e."inputTokens" IS NOT NULL AND e."outputTokens" IS NOT NULL THEN
        CASE ${Prisma.join(branches, ' ')} ELSE 0 END ELSE 0 END)`;
}

export async function selectExecutionListPage(where: Prisma.ExecutionWhereInput, options: ComputedRecordPageOptions) {
    if (!['timestamp', 'agentName', 'latency', 'tokens', 'cost', 'status'].includes(options.sortKey)) {
        throw new Error(`Unsupported Execution sort field: ${options.sortKey}`);
    }
    const fixedOptions = { ...options, lifecycleNow: options.lifecycleNow ?? Date.now() };
    const status = lifecycle(fixedOptions.lifecycleNow);
    const sort = options.sortKey === 'status'
        ? Prisma.sql`CASE ${status} WHEN 'running' THEN 0 WHEN 'timed_out' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END`
        : options.sortKey === 'cost' ? cost()
            : options.sortKey === 'timestamp' || options.sortKey === 'agentName' ? Prisma.raw(`e."${options.sortKey}"`)
                : Prisma.sql`COALESCE(${Prisma.raw(`e."${options.sortKey}"`)}, 0)`;
    return prismaRaw.$transaction(async transaction => {
        const stats = await aggregateExecutionList(where, { ...fixedOptions, avgNullAsZero: true }, transaction);
        const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT e.id ${from} WHERE ${predicate(where, fixedOptions)}
            ORDER BY ${sort} ${Prisma.raw(options.sortDir === 'asc' ? 'ASC' : 'DESC')}, e.timestamp DESC, e.id DESC
            LIMIT ${options.pageSize} OFFSET ${(options.page - 1) * options.pageSize}`);
        return { ids: rows.map(row => row.id), total: stats.total, stats };
    });
}
