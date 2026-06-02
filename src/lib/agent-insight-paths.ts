import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getPreferredInsightDir(): string {
  return path.join(os.homedir(), '.agent-insight');
}

export function getLegacyInsightDir(): string {
  return path.join(os.homedir(), '.skill-insight');
}

export function getExistingInsightDir(): string {
  const preferred = getPreferredInsightDir();
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
