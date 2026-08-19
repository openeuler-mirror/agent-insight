export const AGENT_PLATFORMS = [
  'opencode',
  'openclaw',
  'hermes',
  'llamaindex',
  'trae',
  'qoder',
  'codex',
  'qwencode',
  'unknown',
] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

export function normalizeAgentPlatform(value: unknown): AgentPlatform {
  const normalized = String(value || '').trim().toLowerCase();
  return AGENT_PLATFORMS.includes(normalized as AgentPlatform)
    ? normalized as AgentPlatform
    : 'unknown';
}
