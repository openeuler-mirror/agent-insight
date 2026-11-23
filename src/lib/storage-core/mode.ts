export function isStorageCoreEnabled(env: Record<string, string | undefined> = {
  AGENT_INSIGHT_TRACE_STORAGE: process.env.AGENT_INSIGHT_TRACE_STORAGE,
  NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE: process.env.NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE,
}): boolean {
  for (const value of [env.AGENT_INSIGHT_TRACE_STORAGE, env.NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE]) {
    if (value && value !== 'core') throw new Error('Legacy storage is no longer supported; configure Storage Core and ClickHouse');
  }
  return true;
}
