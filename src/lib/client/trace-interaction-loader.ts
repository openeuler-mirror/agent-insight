import { sameCollaborationSource } from '../collaboration/display-tree';
import type { RawInteraction } from '../engine/observability/agent-trace';

type Interaction = RawInteraction & { _payloadDeferred?: boolean };
type Pending = {
    index: number;
    generation: number;
    expected: Interaction;
    controller: AbortController;
    promise: Promise<void>;
};

function sameBody(left: RawInteraction | undefined, right: RawInteraction | undefined): boolean {
    return Boolean(left?._payloadVersion && right?._payloadVersion
        && left._payloadVersion === right._payloadVersion
        && left.role === right.role && left.messageID === right.messageID);
}

export function sameTraceInteraction(left: RawInteraction | undefined, right: RawInteraction | undefined): boolean {
    return sameBody(left, right) && sameCollaborationSource(left, right);
}

export function createTraceInteractionLoader({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}) {
    let trace: string | undefined;
    let generation = 0;
    let source: Interaction[] = [];
    const pending = new Map<number, Pending>();
    const isCurrent = (entry: Pending) => !entry.controller.signal.aborted
        && entry.generation === generation && sameTraceInteraction(source[entry.index], entry.expected);
    const cancel = () => {
        for (const entry of pending.values()) entry.controller.abort();
        pending.clear();
    };
    return {
        sync(identity: string | undefined, interactions: Interaction[]) {
            if (trace !== identity) { generation++; trace = identity; }
            source = interactions;
        },
        reconcile() {
            for (const [index, entry] of pending) {
                if (!isCurrent(entry)) { entry.controller.abort(); pending.delete(index); }
            }
        },
        cancel,
        load(
            index: number,
            transport: (index: number, signal: AbortSignal) => Promise<RawInteraction>,
            apply: (loaded: RawInteraction) => void,
            fail: (error: Error) => void,
        ): Promise<void> {
            const existing = pending.get(index);
            if (existing && isCurrent(existing)) return existing.promise;
            if (existing) { existing.controller.abort(); pending.delete(index); }
            const expected = source[index];
            if (!expected?._payloadVersion) return Promise.resolve();
            const entry: Pending = { index, generation, expected: { ...expected }, controller: new AbortController(), promise: Promise.resolve() };
            let timedOut = false;
            let timer: ReturnType<typeof setTimeout>;
            const timeout = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    const error = new Error('Trace detail request timed out. Please retry.');
                    error.name = 'TimeoutError';
                    reject(error);
                }, timeoutMs);
            });
            const response = Promise.resolve()
                .then(() => entry.controller.signal.aborted ? undefined : transport(index, entry.controller.signal));
            let rejectAbort: () => void;
            const aborted = new Promise<never>((_resolve, reject) => {
                rejectAbort = () => reject(new Error('Trace detail request cancelled'));
                entry.controller.signal.addEventListener('abort', rejectAbort, { once: true });
            });
            entry.promise = Promise.race([response, timeout, aborted])
                .then(loaded => {
                    if (!isCurrent(entry)) return;
                    if (!sameBody(expected, loaded)) throw new Error('Trace content changed. Refresh and retry.');
                    apply(loaded!);
                })
                .catch(error => {
                    if (isCurrent(entry)) fail(error instanceof Error ? error : new Error(String(error)));
                    if (timedOut) entry.controller.abort();
                })
                .finally(() => {
                    clearTimeout(timer);
                    entry.controller.signal.removeEventListener('abort', rejectAbort);
                    if (pending.get(index) === entry) pending.delete(index);
                });
            pending.set(index, entry);
            return entry.promise;
        },
    };
}
