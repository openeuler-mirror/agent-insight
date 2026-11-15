import { AsyncLocalStorage } from 'node:async_hooks';
import type { CoreTraceRecorder } from '@/lib/engine/evaluation/evaluator-execution-recorder';
import type { ModelConfig } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';

export interface TrustedCoreAgentContext {
  trustedWorkspaceDir:string;
  trustedModel:ModelConfig;
  recordCoreTrace:CoreTraceRecorder;
  cancelSignal?:AbortSignal;
}
const contextKey=Symbol.for('agent-insight.storage-core.trusted-agent-context');
const globalContexts=globalThis as unknown as Record<symbol,AsyncLocalStorage<TrustedCoreAgentContext>>;
const contexts=globalContexts[contextKey] ||= new AsyncLocalStorage<TrustedCoreAgentContext>();
export function getTrustedCoreAgentContext():TrustedCoreAgentContext|undefined {
  const context=contexts.getStore();
  return context?{...context,trustedModel:structuredClone(context.trustedModel)}:undefined;
}
export function runWithTrustedCoreAgentContext<T>(context:TrustedCoreAgentContext,action:()=>T):T {
  if(!context || typeof context.recordCoreTrace!=='function' || !context.trustedModel)throw new Error('Complete trusted core Agent context required');
  return contexts.run({...context,trustedModel:structuredClone(context.trustedModel)},action);
}
