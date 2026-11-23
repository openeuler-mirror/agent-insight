import {AsyncLocalStorage} from 'node:async_hooks';

export interface CoreReadAttempt {origin:string;signal:AbortSignal;sideEffect:boolean;identity?:string}
const key=Symbol.for('agent-insight.storage-core.read-attempt');
const globals=globalThis as unknown as Record<symbol,AsyncLocalStorage<CoreReadAttempt>>;
export const coreReadAttempts=globals[key] ||= new AsyncLocalStorage<CoreReadAttempt>();
