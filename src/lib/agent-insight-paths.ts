import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentInsightHome } from './env';

export function getPreferredInsightDir(): string {
  return getAgentInsightHome();
}

export function getLegacyInsightDir(): string {
  return path.join(os.homedir(), '.skill-insight');
}

export function getExistingInsightDir(): string {
  const preferred = getPreferredInsightDir();
  if (process.env.AGENT_INSIGHT_HOME) return preferred;
  const legacy = getLegacyInsightDir();
  if (fs.existsSync(preferred)) return preferred;
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

export function getInsightEnvCandidates(): string[] {
  return [
    path.join(getPreferredInsightDir(), '.env'),
    path.join(getLegacyInsightDir(), '.env'),
  ];
}
