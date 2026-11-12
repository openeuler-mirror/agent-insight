export type CoreNumber = string | number | null | undefined;

export interface CoreTrace {
    workspace_id?: string;
    trace_id: string;
    trace_bucket?: string;
    native_trace_id?: string | null;
    agent_name?: string | null;
    framework?: string | null;
    execution_status?: string | null;
    owner_principal_id?: string | null;
    owner_display_name?: string | null;
    span_count?: CoreNumber;
    input_tokens?: CoreNumber;
    output_tokens?: CoreNumber;
    started_at_ms?: CoreNumber;
    ended_at_ms?: CoreNumber;
    created_at_ms?: CoreNumber;
}

export interface CoreSpan {
    span_id: string;
    parent_span_id?: string | null;
    name?: string | null;
    kind?: string | null;
    execution_status?: string | null;
    started_at_ms?: CoreNumber;
    ended_at_ms?: CoreNumber;
    duration_us?: CoreNumber;
    model?: string | null;
    tool_name?: string | null;
    input_tokens?: CoreNumber;
    output_tokens?: CoreNumber;
    payload_revision?: string | null;
    attributes_json?: string | null;
}

export function formatCoreCount(value: CoreNumber): string {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return '—';
    if (value == null || !/^\d+$/.test(String(value))) return '—';
    return BigInt(value).toLocaleString();
}

function finite(value: CoreNumber): number | null {
    if (value == null || value === '') return null;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : null;
}

export function coreDurationMs(value: Pick<CoreSpan, 'duration_us' | 'started_at_ms' | 'ended_at_ms'>): number | null {
    const microseconds = finite(value.duration_us);
    if (microseconds != null) return microseconds / 1000;
    const start = finite(value.started_at_ms);
    const end = finite(value.ended_at_ms);
    return start != null && end != null && Number.isSafeInteger(start) && Number.isSafeInteger(end) && end <= 8.64e15 && end >= start ? end - start : null;
}

export function formatCoreDuration(value: Pick<CoreSpan, 'duration_us' | 'started_at_ms' | 'ended_at_ms'>): string {
    const ms = coreDurationMs(value);
    if (ms == null) return '—';
    if (ms > 0 && ms < 1) return `${(ms * 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} µs`;
    const [amount, unit] = ms < 1000 ? [ms, 'ms'] : ms < 60000 ? [ms / 1000, 's'] : ms < 3600000 ? [ms / 60000, 'min'] : [ms / 3600000, 'h'];
    return `${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}

export function formatCoreTime(value: CoreNumber): string {
    const ms = finite(value);
    if (ms == null || !Number.isSafeInteger(ms) || ms > 8.64e15) return '—';
    return new Date(ms).toLocaleString();
}

export class LatestCoreRequest {
    private controller: AbortController | null = null;
    private version = 0;

    begin() {
        this.cancel();
        const controller = new AbortController();
        this.controller = controller;
        const version = this.version;
        return { signal: controller.signal, isCurrent: () => this.version === version && !controller.signal.aborted };
    }

    cancel() {
        this.version += 1;
        this.controller?.abort();
        this.controller = null;
    }
}

export class CoreRequestError extends Error {
    constructor(public readonly status: number) {
        super(status === 401 ? '登录已过期，请重新登录。' : status === 403 ? '没有访问此数据的权限，或权限已被撤销。' : status === 404 ? '数据不存在或已被删除。' : status === 503 ? '存储服务暂时不可用，请稍后重试。' : '数据加载失败，请重试。');
    }
}

export type PayloadViewPage = { after: number; previous: readonly number[] };

export function initialPayloadPage(): PayloadViewPage {
    return { after: -1, previous: [] };
}

export function nextPayloadPage(page: PayloadViewPage, next: number | null): PayloadViewPage {
    if (next == null || !Number.isSafeInteger(next) || next < 0 || next <= page.after) return page;
    return { after: next, previous: [...page.previous, page.after] };
}

export function previousPayloadPage(page: PayloadViewPage): PayloadViewPage {
    if (!page.previous.length) return page;
    return { after: page.previous[page.previous.length - 1], previous: page.previous.slice(0, -1) };
}

export async function readCoreJSON<T>(fetcher: (url: string, options?: RequestInit) => Promise<Response>, url: string, signal: AbortSignal): Promise<T> {
    const response = await fetcher(url, { signal, credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new CoreRequestError(response.status);
    try {
        return await response.json() as T;
    } catch {
        throw new CoreRequestError(502);
    }
}
