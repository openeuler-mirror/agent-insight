import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectorRoot, configuredApiKey } from './storage.mjs';

const storageRoot = collectorRoot();
const defaultEndpoint = 'http://127.0.0.1:3000/api/ingest/otel/v1/traces';
const sessionLockStaleMs = 60_000;
let qwenEnvPromise;

function safeFilePart(value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function qwenEnvironment() {
  if (!qwenEnvPromise) {
    qwenEnvPromise = readFile(join(homedir(), '.qwen', '.env'), 'utf8')
      .then((contents) => Object.fromEntries(
        contents.split(/\r?\n/).flatMap((line) => {
          const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
          if (!match || line.trimStart().startsWith('#')) return [];
          const [, key, rawValue] = match;
          const value = rawValue.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
          return [[key, value]];
        }),
      ))
      .catch((error) => (error?.code === 'ENOENT' ? {} : Promise.reject(error)));
  }
  return qwenEnvPromise;
}

async function configuredValue(name) {
  if (name === 'AGENT_INSIGHT_API_KEY') return configuredApiKey();
  return process.env[name] || (await qwenEnvironment())[name];
}

function toNanoString(milliseconds) {
  return (BigInt(Math.max(0, Number(milliseconds) || 0)) * BigInt(1_000_000)).toString();
}

function stringAttribute(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function numberAttribute(key, value) {
  return { key, value: { intValue: String(Math.round(Number(value) || 0)) } };
}

function jsonAttribute(key, value) {
  if (value === null || value === undefined) return null;
  return stringAttribute(key, typeof value === 'string' ? value : JSON.stringify(value));
}

function spanAttributes(record) {
  const attributes = [
    stringAttribute('agent.insight.framework', 'qwencode'),
    stringAttribute('agent.insight.trace_type', record.traceType),
    stringAttribute('session.id', record.sessionId),
    stringAttribute(
      'openinference.span.kind',
      record.traceType === 'tool' || record.traceType === 'skill' || record.traceType === 'mcp' || record.traceType === 'plan' || record.traceType === 'team'
        ? 'TOOL'
        : record.traceType === 'llm'
          ? 'LLM'
          : record.traceType === 'hook'
            ? 'INTERNAL'
            : 'AGENT',
    ),
  ];

  if (record.traceType === 'agent') {
    attributes.push(
      stringAttribute('gen_ai.request.model', record.model || 'unknown'),
      jsonAttribute('input.value', record.query),
      jsonAttribute('output.value', record.result),
      numberAttribute('agent.insight.tool_call_count', record.toolCallCount),
    );
  }

  if (record.traceType === 'tool') {
    attributes.push(
      stringAttribute('tool.name', record.toolName),
      jsonAttribute('tool.arguments', record.input),
      jsonAttribute('tool.output', record.output),
      stringAttribute('tool.status', record.status),
    );
  }

  if (record.traceType === 'mcp') {
    attributes.push(
      stringAttribute('tool.name', record.toolName || record.mcpToolName || 'unknown'),
      jsonAttribute('tool.arguments', record.input),
      jsonAttribute('tool.output', record.output),
      stringAttribute('tool.status', record.status),
      stringAttribute('rpc.system', 'mcp'),
      stringAttribute('mcp.server.name', record.mcpServerName || 'unknown'),
      stringAttribute('mcp.tool.name', record.mcpToolName || record.toolName || 'unknown'),
    );
  }

  if (record.traceType === 'skill') {
    attributes.push(
      // Keep the standard Qwen skill tool name so Agent Insight's generic
      // trace parser classifies this interaction as a Skill rather than Tool.
      stringAttribute('tool.name', 'skill'),
      jsonAttribute('tool.arguments', record.input),
      jsonAttribute('tool.output', record.output),
      stringAttribute('tool.status', record.status),
      stringAttribute('skill.name', record.skillName || 'unknown'),
      stringAttribute('skill.trigger_mode', record.triggerMode || 'tool'),
      stringAttribute('skill.source', record.skillSource || 'unknown'),
    );
    if (record.skillVersion !== null && record.skillVersion !== undefined) {
      attributes.push(stringAttribute('skill.version', record.skillVersion));
    }
  }

  if (record.traceType === 'plan') {
    attributes.push(
      stringAttribute('tool.name', record.toolName || 'plan'),
      jsonAttribute('tool.arguments', record.input),
      jsonAttribute('tool.output', record.output),
      stringAttribute('tool.status', record.status),
      stringAttribute('plan.id', record.planId || 'unknown'),
      stringAttribute('plan.phase', record.planPhase || 'unknown'),
      stringAttribute('plan.status', record.planStatus || 'unknown'),
      jsonAttribute('plan.steps', record.planSteps),
      jsonAttribute('plan.content', record.planContent),
      jsonAttribute('plan.original_request', record.originalRequest),
      jsonAttribute('plan.research_summary', record.researchSummary),
    );
  }

  if (record.traceType === 'team') {
    attributes.push(
      stringAttribute('tool.name', record.toolName || 'team'),
      jsonAttribute('tool.arguments', record.input),
      jsonAttribute('tool.output', record.output),
      stringAttribute('tool.status', record.status),
      stringAttribute('team.id', record.teamId || 'unknown'),
      jsonAttribute('team.name', record.teamName),
      stringAttribute('team.action', record.teamAction || 'unknown'),
      jsonAttribute('team.description', record.teamDescription),
      jsonAttribute('team.plan_approval.action', record.teamApprovalAction),
      jsonAttribute('team.plan_approval.request_id', record.teamApprovalRequestId),
    );
  }

  if (record.traceType === 'hook') {
    attributes.push(
      stringAttribute('hook.event.name', record.hookEventName || 'unknown'),
      stringAttribute('hook.status', record.status || 'ok'),
      jsonAttribute('hook.tool.name', record.hookToolName),
      jsonAttribute('hook.tool_use_id', record.hookToolUseId),
      jsonAttribute('hook.agent.id', record.hookAgentId),
      jsonAttribute('hook.agent.type', record.hookAgentType),
    );
  }

  if (record.traceType === 'llm') {
    attributes.push(
      stringAttribute('gen_ai.request.model', record.model || 'unknown'),
      stringAttribute('gen_ai.provider.name', record.provider || 'unknown'),
      stringAttribute('gen_ai.operation.name', record.requestType || 'chat'),
      numberAttribute('gen_ai.usage.input_tokens', record.promptTokens),
      numberAttribute('gen_ai.usage.output_tokens', record.completionTokens),
      numberAttribute('gen_ai.usage.total_tokens', record.totalTokens),
      numberAttribute('gen_ai.usage.reasoning_tokens', record.reasoningTokens),
      numberAttribute('gen_ai.usage.cache_read_input_tokens', record.cachedTokens),
      jsonAttribute('input.value', record.prompt),
      jsonAttribute('output.value', record.response),
    );
  }

  if (record.traceType === 'subagent') {
    attributes.push(
      stringAttribute('agent.id', record.agentId),
      jsonAttribute('agent.name', record.agentName),
      stringAttribute('agent.type', record.agentType || 'subagent'),
      stringAttribute('agent.status', record.status || 'ok'),
      jsonAttribute('team.id', record.teamId),
      jsonAttribute('team.name', record.teamName),
      jsonAttribute('agent.parent_id', record.parentAgentId),
      stringAttribute('agent.fork', record.isFork ? 'true' : 'false'),
      jsonAttribute('agent.forked_from_session_id', record.forkedFromSessionId),
      jsonAttribute('input.value', record.task),
      jsonAttribute('output.value', record.result),
      numberAttribute('gen_ai.usage.input_tokens', record.inputTokens),
      numberAttribute('gen_ai.usage.output_tokens', record.outputTokens),
      numberAttribute('gen_ai.usage.reasoning_tokens', record.reasoningTokens),
      numberAttribute('gen_ai.usage.total_tokens', record.totalTokens),
      numberAttribute('agent.llm_call_count', record.llmCallCount),
    );
  }

  if (record.error) {
    attributes.push(jsonAttribute('error.message', record.error));
  }

  return attributes.filter(Boolean);
}

export function recordsToOtlp(records) {
  if (!records.length) return { resourceSpans: [] };

  const sessionId = records[0].sessionId;
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute('service.name', 'qwencode'),
            stringAttribute('service.version', '0.1.0'),
            stringAttribute('session.id', sessionId),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'agent-insight-qwencode-collector', version: '0.1.0' },
            spans: records.map((record) => ({
              traceId: record.traceId,
              spanId: record.spanId,
              ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
              name: record.name,
              kind: 1,
              startTimeUnixNano: toNanoString(record.startTimeMs),
              endTimeUnixNano: toNanoString(record.endTimeMs),
              attributes: spanAttributes(record),
              status: record.status === 'error'
                ? { code: 2, message: String(record.error || 'Tool execution failed') }
                : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

async function readSpoolRecords(sessionId) {
  const spoolDir = join(storageRoot, 'spool', safeFilePart(sessionId));
  try {
    const names = (await readdir(spoolDir)).filter((name) => name.endsWith('.json')).sort();
    const entries = await Promise.all(names.map(async (name) => ({
      name,
      path: join(spoolDir, name),
      record: JSON.parse(await readFile(join(spoolDir, name), 'utf8')),
    })));
    return entries;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function markUploaded(sessionId, entries) {
  const uploadedDir = join(storageRoot, 'uploaded', safeFilePart(sessionId));
  await mkdir(uploadedDir, { recursive: true });
  await Promise.all(entries.map(async ({ name, path }) => {
    const destination = join(uploadedDir, name);
    try {
      await rename(path, destination);
    } catch (error) {
      // Root Agent snapshots intentionally reuse span/file IDs. Windows may
      // refuse rename-over-existing, so replace only the archived copy; the
      // authoritative pending file remains untouched until the final rename.
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await rm(destination, { force: true });
      await rename(path, destination);
    }
  }));
}

async function endpoint() {
  return (await configuredValue('AGENT_INSIGHT_OTLP_ENDPOINT')) || defaultEndpoint;
}

async function acquireSessionLock(sessionId) {
  await mkdir(join(storageRoot, 'locks'), { recursive: true });
  const lockPath = join(storageRoot, 'locks', `${safeFilePart(sessionId)}.lock`);
  try {
    await mkdir(lockPath, { recursive: false });
    return lockPath;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs <= sessionLockStaleMs) return null;
      await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath, { recursive: false });
      return lockPath;
    } catch (retryError) {
      if (retryError?.code === 'EEXIST' || retryError?.code === 'ENOENT') return null;
      throw retryError;
    }
  }
}

async function uploadEntries(sessionId, entries) {
  if (!entries.length) return { uploaded: 0, skipped: true };

  const apiKey = await configuredValue('AGENT_INSIGHT_API_KEY');
  if (!apiKey) {
    throw new Error('AGENT_INSIGHT_API_KEY is required for OTLP upload');
  }

  const headers = { 'content-type': 'application/json' };
  headers['x-witty-api-key'] = apiKey;

  const response = await fetch(await endpoint(), {
    method: 'POST',
    headers,
    body: JSON.stringify(recordsToOtlp(entries.map(({ record }) => record))),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`OTLP upload failed with HTTP ${response.status}`);
  }

  await markUploaded(sessionId, entries);
  return { uploaded: entries.length, skipped: false, response: await response.json().catch(() => null) };
}

export async function flushSessionSpool(sessionId, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 1);
  const baseDelayMs = Math.max(50, Number(options.baseDelayMs) || 250);
  const lockPath = await acquireSessionLock(sessionId);
  if (!lockPath) return { uploaded: 0, skipped: true, locked: true };

  try {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const entries = await readSpoolRecords(sessionId);
        return { ...(await uploadEntries(sessionId, entries)), attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await delay(baseDelayMs * (2 ** (attempt - 1)));
      }
    }
    throw lastError;
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function flushAllSpool(options = {}) {
  const spoolRoot = join(storageRoot, 'spool');
  try {
    const sessionIds = await readdir(spoolRoot);
    const results = [];
    for (const sessionId of sessionIds) {
      try {
        results.push({ sessionId, ...(await flushSessionSpool(sessionId, options)) });
      } catch (error) {
        results.push({ sessionId, uploaded: 0, skipped: false, error: error.message });
      }
    }
    return results;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}
