import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const qwenSettingsPath = join(homedir(), '.qwen', 'settings.json');
export const qwenEnvPath = join(homedir(), '.qwen', '.env');
export const agentInsightEnvPath = join(homedir(), '.agent-insight', '.env');

const nativeTelemetryNames = [
  'QWEN_TELEMETRY_ENABLED',
  'QWEN_TELEMETRY_OTLP_PROTOCOL',
  'QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT',
  'QWEN_TELEMETRY_OTLP_LOGS_ENDPOINT',
  'QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_SERVICE_NAME',
];

function parseEnvironment(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trimStart().startsWith('#')) return [];
    const [, key, rawValue] = match;
    return [[key, rawValue.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')]];
  }));
}

async function readEnvironment(path) {
  try {
    return parseEnvironment(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function otlpEndpoint(host) {
  const normalizedHost = String(host || '').trim().replace(/\/+$/, '');
  if (!normalizedHost) return undefined;
  return `${/^https?:\/\//i.test(normalizedHost) ? normalizedHost : `http://${normalizedHost}`}/api/ingest/otel/v1/traces`;
}

function safeEnvironmentValue(value, name) {
  if (/[\r\n]/.test(value)) throw new Error(`Cannot configure ${name}: the value must not contain a newline.`);
  return value;
}

async function collectorEnvironment(options = {}) {
  const agentInsightEnvironment = await readEnvironment(agentInsightEnvPath);
  const endpoint = options.endpoint
    || process.env.AGENT_INSIGHT_OTLP_ENDPOINT
    || agentInsightEnvironment.AGENT_INSIGHT_OTLP_ENDPOINT
    || otlpEndpoint(options.host || process.env.AGENT_INSIGHT_HOST || agentInsightEnvironment.AGENT_INSIGHT_HOST);
  const apiKey = options.apiKey
    || process.env.AGENT_INSIGHT_API_KEY
    || agentInsightEnvironment.AGENT_INSIGHT_API_KEY;
  return {
    endpoint: endpoint ? safeEnvironmentValue(endpoint, 'QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT') : undefined,
    apiKey: apiKey ? safeEnvironmentValue(apiKey, 'OTEL_EXPORTER_OTLP_HEADERS') : undefined,
  };
}

async function writeQwenEnvironment(environment) {
  if (!environment.endpoint || !environment.apiKey) return false;
  let contents = '';
  try { contents = await readFile(qwenEnvPath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const managed = new Set([...nativeTelemetryNames, 'AGENT_INSIGHT_OTLP_ENDPOINT', 'AGENT_INSIGHT_API_KEY']);
  const retained = contents.split(/\r?\n/).filter((line) => !managed.has(line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]));
  while (retained.at(-1) === '') retained.pop();
  retained.push(
    'QWEN_TELEMETRY_ENABLED=true',
    'QWEN_TELEMETRY_OTLP_PROTOCOL=http',
    `QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT=${environment.endpoint}`,
    `QWEN_TELEMETRY_OTLP_LOGS_ENDPOINT=${environment.endpoint.replace(/\/traces$/, '/logs')}`,
    'QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES=true',
    `OTEL_EXPORTER_OTLP_HEADERS=x-witty-api-key=${environment.apiKey}`,
    'OTEL_SERVICE_NAME=qwencode',
  );
  await mkdir(dirname(qwenEnvPath), { recursive: true });
  const temporaryPath = `${qwenEnvPath}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${retained.join('\n')}\n`, 'utf8');
  await rename(temporaryPath, qwenEnvPath);
  return true;
}

async function removeQwenEnvironment() {
  let contents;
  try { contents = await readFile(qwenEnvPath, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  const managed = new Set([...nativeTelemetryNames, 'AGENT_INSIGHT_OTLP_ENDPOINT', 'AGENT_INSIGHT_API_KEY']);
  const lines = contents.split(/\r?\n/);
  const retained = lines.filter((line) => !managed.has(line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]));
  if (retained.length === lines.length) return false;
  while (retained.at(-1) === '') retained.pop();
  if (!retained.some((line) => line.trim())) { await rm(qwenEnvPath, { force: true }); return true; }
  const temporaryPath = `${qwenEnvPath}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${retained.join('\n')}\n`, 'utf8');
  await rename(temporaryPath, qwenEnvPath);
  return true;
}

function isLegacyCollectorHook(hook) {
  const name = String(hook?.name || '');
  const command = String(hook?.command || '').replaceAll('\\', '/').toLowerCase();
  return name.startsWith('agent-insight-qwencode-') || command.includes('qwencode-collector/index.mjs');
}

export async function readSettings() {
  try { return JSON.parse(await readFile(qwenSettingsPath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new Error(`Cannot configure native telemetry: ${qwenSettingsPath} contains invalid JSON.`);
    throw error;
  }
}

async function writeSettings(settings) {
  await mkdir(dirname(qwenSettingsPath), { recursive: true });
  const backupPath = `${qwenSettingsPath}.agent-insight-backup-${Date.now()}.json`;
  try { await cp(qwenSettingsPath, backupPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const temporaryPath = `${qwenSettingsPath}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, qwenSettingsPath);
  return backupPath;
}

export function removeLegacyCollectorHooks(settings) {
  const next = structuredClone(settings || {});
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const eventName of Object.keys(next.hooks)) {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    const retained = groups.map((group) => ({ ...group, hooks: Array.isArray(group?.hooks) ? group.hooks.filter((hook) => !isLegacyCollectorHook(hook)) : [] }))
      .filter((group) => group.hooks.length > 0);
    if (retained.length) next.hooks[eventName] = retained;
    else delete next.hooks[eventName];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

export async function installCollector(_sourceDir, options = {}) {
  const environment = await collectorEnvironment(options);
  const settings = await readSettings();
  const nextSettings = removeLegacyCollectorHooks(settings);
  const settingsChanged = JSON.stringify(nextSettings) !== JSON.stringify(settings);
  const backupPath = settingsChanged ? await writeSettings(nextSettings) : undefined;
  const environmentConfigured = await writeQwenEnvironment(environment);
  return { qwenSettingsPath, qwenEnvPath, backupPath, environmentConfigured, endpoint: environment.endpoint, nativeTelemetry: true };
}

export async function uninstallCollector() {
  const settings = await readSettings();
  const nextSettings = removeLegacyCollectorHooks(settings);
  const settingsChanged = JSON.stringify(nextSettings) !== JSON.stringify(settings);
  const backupPath = settingsChanged ? await writeSettings(nextSettings) : undefined;
  const environmentRemoved = await removeQwenEnvironment();
  return { qwenSettingsPath, qwenEnvPath, backupPath, environmentRemoved, nativeTelemetry: true };
}
