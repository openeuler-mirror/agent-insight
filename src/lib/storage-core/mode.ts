export function isStorageCoreEnabled(env: Record<string, string | undefined> = { AGENT_INSIGHT_TRACE_STORAGE: process.env.AGENT_INSIGHT_TRACE_STORAGE, NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE: process.env.NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE }): boolean {
  return (env.AGENT_INSIGHT_TRACE_STORAGE ?? env.NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE) === 'core';
}
