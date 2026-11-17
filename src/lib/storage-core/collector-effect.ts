import {AsyncLocalStorage} from 'node:async_hooks';
import type {CoreCollectorIdentity} from './collector-identity';
type Row=Record<string,any>;
export interface CollectorEffect {identity:CoreCollectorIdentity;session?:Row;endedAt?:number;save:(record:Row)=>Promise<any>;check:()=>Promise<void>;flow:(taskId:string,skill?:{id:string;version:number;name?:string})=>Promise<any>;}
const key=Symbol.for('agent-insight.storage-core.collector-effect');
const globals=globalThis as unknown as Record<symbol,AsyncLocalStorage<CollectorEffect>>;
const scopes=globals[key] ||= new AsyncLocalStorage<CollectorEffect>();
export const getCollectorEffect=()=>scopes.getStore();
export function withCollectorEffect<T>(effect:CollectorEffect,action:()=>Promise<T>){return scopes.run(effect,action);}
