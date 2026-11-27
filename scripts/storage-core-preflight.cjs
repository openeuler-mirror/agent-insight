const fs = require('node:fs');
const path = require('node:path');

function loadEnvironment() {
  const { getAgentInsightHome } = require('./agent-insight-home.cjs');
  require('dotenv').config({ path: path.join(getAgentInsightHome(), '.env'), quiet: true });
  require('dotenv').config({ quiet: true });
}

function validateConfiguration(env = process.env) {
  for (const key of ['AGENT_INSIGHT_TRACE_STORAGE', 'NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE']) {
    if (env[key] && env[key] !== 'core') throw new Error('Legacy storage is no longer supported; configure Storage Core and ClickHouse');
  }
  let origin;
  try { origin = new URL(env.AGENT_INSIGHT_STORAGE_CORE_URL); } catch { throw new Error('AGENT_INSIGHT_STORAGE_CORE_URL must specify the local Storage Core origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Storage Core requires an explicit loopback HTTP(S) origin without credentials or a path');
  }
  const controller = env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;
  if (!controller || !path.isAbsolute(controller)) throw new Error('AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE must specify a private absolute file');
  const stat = fs.lstatSync(controller);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Storage Core controller file must be private (0600)');
  return origin.origin;
}

async function preflight(env = process.env, fetcher = fetch) {
  const origin = validateConfiguration(env);
  const response = await fetcher(origin + '/v1/health', { redirect: 'error', signal: AbortSignal.timeout(15000), cache: 'no-store' });
  if (!response.ok) throw new Error('Storage Core is not ready; check the transactional database and ClickHouse');
  const health = await response.json();
  if (health.status !== 'ready' || health.schema_version !== 21 || health.clickhouse?.schema_version !== 4 || health.clickhouse?.tables !== 19) {
    throw new Error('Storage Core must verify transaction schema 021 and all 19 ClickHouse tables (004); upgrade the Core service before starting Web');
  }
  return health;
}

function diagnostic(error) {
  if (error?.code === 'ENOENT') return 'controller file is missing';
  if (error?.code === 'EACCES') return 'controller file is not readable';
  if (error?.cause?.code === 'ECONNREFUSED') return 'Storage Core connection refused; check that the service is running';
  if (error?.name === 'TimeoutError') return 'Storage Core health check timed out';
  return error?.message || 'unknown readiness failure';
}

if (require.main === module) {
  loadEnvironment();
  preflight().then(() => console.log('Storage Core ready: transactional database + ClickHouse')).catch(error => {
    console.error(`Storage Core startup check failed: ${diagnostic(error)}. Legacy database fallback is disabled.`);
    process.exitCode = 1;
  });
}

module.exports = { loadEnvironment, validateConfiguration, preflight };
