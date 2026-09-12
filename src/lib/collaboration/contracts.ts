import { createHash } from 'node:crypto';

export type Locator = { recordType: 'tool'; name: string } | { recordType: 'shell'; commandContains: string };
export type RelationEvent = {
    collaborationId: string; eventId: string; fromSessionId: string; toSessionId: string;
    description: string; observedAt?: string; content?: string; fromLocator?: Locator;
};
export type Binding = {
    collaborationId: string; sessionId: string; traceSessionId: string;
    eventClock: 'unknown' | 'source_session' | 'synchronized';
};
export class CollaborationError extends Error {
    constructor(public status: number, public code: string, message: string, public field?: string) { super(message); }
}
export function invalid(message: string, field?: string): never {
    throw new CollaborationError(400, field?.startsWith('fromLocator') ? 'INVALID_LOCATOR' : 'INVALID_ARGUMENT', message, field);
}
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

// JSON.parse alone discards duplicate keys before contract validation can see them.
export function strictJson(text: string): unknown {
    let pos = 0;
    const space = () => { while (/[\x20\t\r\n]/.test(text[pos] || '\0')) pos++; };
    function string(): string {
        const start = pos++;
        while (pos < text.length) {
            if (text[pos] === '\\') { pos += 2; continue; }
            if (text[pos++] === '"') return JSON.parse(text.slice(start, pos));
        }
        return invalid('JSON 字符串不完整');
    }
    function value(depth: number): unknown {
        if (depth > 32) invalid('JSON 嵌套过深');
        space();
        if (text[pos] === '"') return string();
        if (text[pos] === '{' || text[pos] === '[') {
            const object = text[pos++] === '{';
            const end = object ? '}' : ']';
            const result: any = object ? Object.create(null) : [];
            const keys = new Set<string>();
            space();
            if (text[pos] === end) { pos++; return result; }
            while (pos < text.length) {
                let key = '';
                if (object) {
                    space();
                    if (text[pos] !== '"') invalid('JSON 对象键格式错误');
                    key = string();
                    if (keys.has(key)) invalid('JSON 不允许重复对象键');
                    keys.add(key);
                    space();
                    if (text[pos++] !== ':') invalid('JSON 缺少冒号');
                }
                const child = value(depth + 1);
                if (object) result[key] = child; else result.push(child);
                space();
                if (text[pos] === end) { pos++; return result; }
                if (text[pos++] !== ',') invalid('JSON 格式错误');
            }
            return invalid('JSON 不完整');
        }
        const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
        if (!token) invalid('JSON 值格式错误');
        pos += token[0].length;
        return JSON.parse(token[0]);
    }
    try {
        const result = value(0);
        space();
        if (pos !== text.length) invalid('JSON 存在额外内容');
        return result;
    } catch (error) {
        if (error instanceof CollaborationError) throw error;
        return invalid('JSON 格式错误');
    }
}
function object(value: unknown, allowed: string[], field = ''): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('必须是对象', field);
    for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid('不支持的字段', field ? `${field}.${key}` : key);
    return value as Record<string, unknown>;
}
function str(value: unknown, field: string, max: number, nonblank = true): string {
    if (typeof value !== 'string' || [...value].length > max || (nonblank && !value.trim())) invalid('字符串为空、类型或长度错误', field);
    return value;
}
export function identifier(value: unknown, field: string): string {
    const result = str(value, field, 128);
    if (!/^[A-Za-z0-9_.-]+$/.test(result)) invalid('编号仅支持 ASCII 字母、数字、点、下划线和短横线', field);
    return result;
}
export function validTime(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!m || !Number.isFinite(Date.parse(value))) return false;
    const [, y, month, day, h, minute, second, zone] = m;
    const days = new Date(Date.UTC(Number(y), Number(month), 0)).getUTCDate();
    return +month >= 1 && +month <= 12 && +day >= 1 && +day <= days && +h < 24 && +minute < 60 && +second < 60 && (zone === 'Z' || (+zone.slice(1, 3) < 24 && +zone.slice(4) < 60));
}
export function parseEvent(value: unknown): RelationEvent {
    const data = object(value, ['collaborationId', 'eventId', 'fromSessionId', 'toSessionId', 'description', 'observedAt', 'content', 'fromLocator']);
    identifier(data.collaborationId, 'collaborationId'); identifier(data.eventId, 'eventId');
    str(data.fromSessionId, 'fromSessionId', 512); str(data.toSessionId, 'toSessionId', 512); str(data.description, 'description', 500);
    if ('content' in data) str(data.content, 'content', 4000, false);
    if ('observedAt' in data && !validTime(data.observedAt)) invalid('必须是有效的带时区 RFC 3339 时间', 'observedAt');
    if ('fromLocator' in data) {
        const loc = object(data.fromLocator, ['recordType', 'name', 'commandContains'], 'fromLocator');
        if (loc.recordType === 'tool') {
            if ('commandContains' in loc) invalid('tool 不允许 commandContains', 'fromLocator.commandContains');
            str(loc.name, 'fromLocator.name', 200);
        } else if (loc.recordType === 'shell') {
            if ('name' in loc) invalid('shell 不允许 name', 'fromLocator.name');
            str(loc.commandContains, 'fromLocator.commandContains', 512);
        } else invalid('仅支持 tool 或 shell', 'fromLocator.recordType');
    }
    return data as RelationEvent;
}
export function parseBinding(value: unknown): Binding {
    const data = object(value, ['collaborationId', 'sessionId', 'traceSessionId', 'eventClock']);
    identifier(data.collaborationId, 'collaborationId');
    str(data.sessionId, 'sessionId', 512); str(data.traceSessionId, 'traceSessionId', 512);
    if ('eventClock' in data && !['unknown', 'source_session', 'synchronized'].includes(data.eventClock as string)) invalid('不支持的时钟依据', 'eventClock');
    return { ...data, eventClock: data.eventClock ?? 'unknown' } as Binding;
}
export async function readBody(request: Request): Promise<unknown> {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new CollaborationError(415, 'UNSUPPORTED_MEDIA_TYPE', '需要 application/json');
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (Number(request.headers.get('content-length')) > 65536) throw new CollaborationError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 64 KiB');
    if (reader) try {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            length += item.value.length;
            if (length > 65536) { await reader.cancel(); throw new CollaborationError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 64 KiB'); }
            chunks.push(item.value);
        }
    } finally { reader.releaseLock(); }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { return invalid('请求体不是有效 UTF-8'); }
    return strictJson(text);
}
