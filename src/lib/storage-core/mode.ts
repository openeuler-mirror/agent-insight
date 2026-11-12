export function isStorageCoreEnabled(env: Record<string, string | undefined> = { NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE: process.env.NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE }): boolean {
  return env.NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE === 'core';
}
