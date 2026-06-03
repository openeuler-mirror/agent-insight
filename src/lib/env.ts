import { config } from 'dotenv';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DATABASE_URL = 'file:../data/witty_insight.db';

export function getAgentInsightHome(): string {
  return process.env.AGENT_INSIGHT_DATA_DIR || path.join(os.homedir(), '.agent-insight');
}

export function getAgentInsightEnvPath(): string {
  return path.join(getAgentInsightHome(), '.env');
}

export function resolveDefaultDatabaseUrl(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl || databaseUrl !== DEFAULT_DATABASE_URL) {
    return databaseUrl;
  }

  return `file:${path.join(getAgentInsightHome(), 'data', 'witty_insight.db')}`;
}

export function loadAgentInsightEnv(): void {
  config({ path: getAgentInsightEnvPath() });
  config();

  const resolvedDatabaseUrl = resolveDefaultDatabaseUrl(process.env.DATABASE_URL);
  if (resolvedDatabaseUrl) {
    process.env.DATABASE_URL = resolvedDatabaseUrl;
  }
}
