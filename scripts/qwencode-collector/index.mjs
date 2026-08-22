import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectorRoot } from './storage.mjs';
import { redactSensitive } from './privacy.mjs';
import { readTranscriptSkillCalls } from './transcript-skills.mjs';

const storageRoot = collectorRoot();
const skillToolNames = new Set(['skill', 'load_skill', 'skill_view']);
const planToolPhases = new Map([
  ['enter_plan_mode', 'enter'],
  ['todo_write', 'steps'],
  ['exit_plan_mode', 'proposal'],
]);
const teamToolActions = new Map([
  ['team_create', 'create'],
  ['team_delete', 'delete'],
  ['team_plan_approval', 'plan_approval'],
]);
const uploaderScript = fileURLToPath(new URL('./flush.mjs', import.meta.url));
const sessionStateLockStaleMs = 90_000;
const sessionStateLockRetryMs = 25;
const probeMaxRecords = Math.max(1, Number.parseInt(process.env.AGENT_INSIGHT_QWEN_PROBE_MAX_FILES || '', 10) || 200);

function kickUploader(watch = false) {
  try {
    const child = spawn(process.execPath, [uploaderScript, ...(watch ? ['--watch'] : [])], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Spool files remain on disk and the next hook/worker will retry them.
  }
}

function planStatus(phase, status, output) {
  if (status === 'error') return 'failed';
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  if (/\b(?:failed|error|unavailable)\b/i.test(text)) return 'failed';
  if (phase === 'enter') {
    return /not entered|stayed in .*mode|cannot enter/i.test(text) ? 'failed' : 'active';
  }
  if (phase === 'steps') return 'updated';
  if (/reject|not approved|cancel|remaining in plan mode/i.test(text)) return 'rejected';
  return 'approved';
}

function mcpToolIdentity(toolName, event = {}) {
  const registeredName = String(toolName ?? '');
  const explicitServer = event.mcp_server_name ?? event.server_name ?? event.serverName;
  const explicitTool = event.mcp_tool_name ?? event.server_tool_name ?? event.serverToolName;
  if (explicitServer || explicitTool) {
    return {
      serverName: String(explicitServer ?? 'unknown'),
      toolName: String(explicitTool ?? registeredName ?? 'unknown'),
    };
  }
  if (!registeredName.toLowerCase().startsWith('mcp__')) return null;
  const [serverName, ...toolParts] = registeredName.slice(5).split('__');
  return {
    serverName: serverName || 'unknown',
    toolName: toolParts.join('__') || 'unknown',
  };
}

function safeFilePart(value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createTraceId() {
  return randomBytes(16).toString('hex');
}

function createSpanId() {
  return randomBytes(8).toString('hex');
}

const redact = redactSensitive;

function timestampMs(value) {
  const result = Date.parse(value ?? '');
  return Number.isFinite(result) ? result : Date.now();
}

async function readStdin() {
  let body = '';

  for await (const chunk of process.stdin) {
    body += chunk;
  }

  return body;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomically(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporaryPath, path);
}

function sessionPath(sessionId) {
  return join(storageRoot, 'sessions', `${safeFilePart(sessionId)}.json`);
}

function sessionStateLockPath(sessionId) {
  return join(storageRoot, 'locks', `session-state-${safeFilePart(sessionId)}.lock`);
}

async function acquireSessionStateLock(sessionId) {
  const lockPath = sessionStateLockPath(sessionId);
  await mkdir(join(storageRoot, 'locks'), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath, { recursive: false });
      return lockPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > sessionStateLockStaleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (retryError) {
        if (retryError?.code === 'ENOENT') continue;
        throw retryError;
      }
      await delay(sessionStateLockRetryMs);
    }
  }
}

async function withSessionStateLock(sessionId, action) {
  const lockPath = await acquireSessionStateLock(sessionId);
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function pendingToolPath(toolUseId) {
  return join(storageRoot, 'pending-tools', `${safeFilePart(toolUseId)}.json`);
}

function subagentPath(sessionId, agentId) {
  return join(storageRoot, 'subagents', safeFilePart(sessionId), `${safeFilePart(agentId)}.json`);
}

async function findPendingAgentInvocation(sessionId, agentId) {
  const pendingDir = join(storageRoot, 'pending-tools');
  try {
    const records = await Promise.all((await readdir(pendingDir))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(join(pendingDir, name))));
    const agentCalls = records.filter((record) => record?.sessionId === sessionId && String(record?.toolName || '').toLowerCase() === 'agent');
    return agentCalls
      .filter((record) => {
        const correlation = String(record?.toolCallId ?? record?.toolUseId ?? '');
        return correlation && String(agentId).includes(correlation);
      })
      .sort((a, b) => Number(b.startTimeMs || 0) - Number(a.startTimeMs || 0))[0]
      ?? agentCalls.sort((a, b) => Number(b.startTimeMs || 0) - Number(a.startTimeMs || 0))[0]
      ?? null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function teamMemberId(teamId, memberName) {
  return `${teamId}:member:${memberName}`;
}

function outputText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

async function emitTeamMemberStart(state, input, output, startTimeMs, endTimeMs) {
  const memberName = String(input?.name ?? '').trim();
  if (!state.activeTeam || !memberName) return;

  const agentId = teamMemberId(state.activeTeam.id, memberName);
  const existing = state.activeTeam.members?.[memberName];
  if (existing) return;

  const agentType = String(input?.subagent_type ?? input?.subagentType ?? 'team-member');
  const member = {
    agentId,
    agentName: memberName,
    agentType,
    spanId: createSpanId(),
    task: redact(input?.prompt ?? input?.description ?? null),
    startTimeMs,
  };
  state.activeTeam.members ??= {};
  state.activeTeam.members[memberName] = member;
  await saveSession(state);

  await writeSpoolRecord(state.sessionId, {
    version: 1,
    traceType: 'subagent',
    traceId: state.traceId,
    spanId: member.spanId,
    parentSpanId: state.rootSpanId,
    sessionId: state.sessionId,
    name: `agent.${memberName}`,
    agentId,
    agentName: memberName,
    agentType,
    parentAgentId: null,
    teamId: state.activeTeam.id,
    teamName: state.activeTeam.name,
    isFork: false,
    forkedFromSessionId: null,
    task: member.task,
    result: outputText(output),
    status: 'running',
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    llmCallCount: 0,
    startTimeMs,
    endTimeMs,
    latencyMs: Math.max(0, endTimeMs - startTimeMs),
  });
}

async function emitTeamMemberCompletion(state, input, output, status, endTimeMs) {
  if (!state.activeTeam || status !== 'ok') return;
  const owner = outputText(output).match(/owner:\s*([a-z0-9_-]+)/i)?.[1];
  const member = owner ? state.activeTeam.members?.[owner] : null;
  if (!member) return;

  await writeSpoolRecord(state.sessionId, {
    version: 1,
    revision: 'completed',
    traceType: 'subagent',
    traceId: state.traceId,
    spanId: createSpanId(),
    parentSpanId: state.rootSpanId,
    sessionId: state.sessionId,
    name: `agent.${member.agentName}`,
    agentId: member.agentId,
    agentName: member.agentName,
    agentType: member.agentType,
    parentAgentId: null,
    teamId: state.activeTeam.id,
    teamName: state.activeTeam.name,
    isFork: false,
    forkedFromSessionId: null,
    task: member.task,
    result: outputText(output),
    status: 'ok',
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    llmCallCount: 0,
    startTimeMs: member.startTimeMs,
    endTimeMs,
    latencyMs: Math.max(0, endTimeMs - member.startTimeMs),
  });
}

async function emitForkStart(state, input, output, toolCallId, startTimeMs, endTimeMs) {
  if (String(input?.subagent_type ?? input?.subagentType ?? '').toLowerCase() !== 'fork') return;
  const agentId = `fork-${toolCallId || randomUUID()}`;
  const path = subagentPath(state.sessionId, agentId);
  const existing = await readJson(path);
  const pendingAgent = existing ?? {
    sessionId: state.sessionId,
    traceId: state.traceId,
    agentId,
    agentType: 'fork',
    isFork: true,
    forkedFromSessionId: state.sessionId,
    teamId: null,
    teamName: null,
    parentAgentId: null,
    parentSpanId: state.rootSpanId,
    spanId: createSpanId(),
    task: redact(input?.prompt ?? input?.description ?? null),
    startedAt: new Date(startTimeMs).toISOString(),
    startTimeMs,
  };
  await writeJsonAtomically(path, pendingAgent);
  await writeSpoolRecord(state.sessionId, {
    version: 1,
    traceType: 'subagent',
    traceId: pendingAgent.traceId,
    spanId: pendingAgent.spanId,
    parentSpanId: pendingAgent.parentSpanId,
    sessionId: state.sessionId,
    name: 'agent.fork',
    agentId,
    agentType: 'fork',
    parentAgentId: null,
    isFork: true,
    forkedFromSessionId: state.sessionId,
    task: pendingAgent.task,
    result: outputText(output),
    status: 'running',
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    llmCallCount: 0,
    startTimeMs: pendingAgent.startTimeMs,
    endTimeMs,
    latencyMs: Math.max(0, endTimeMs - pendingAgent.startTimeMs),
  });
}

async function ensureSession(event) {
  const existing = await readJson(sessionPath(event.session_id));

  if (existing) {
    return existing;
  }

  return {
    version: 1,
    sessionId: event.session_id,
    traceId: createTraceId(),
    rootSpanId: createSpanId(),
    startedAt: event.timestamp ?? new Date().toISOString(),
    cwd: event.cwd ?? null,
    model: event.model ?? null,
    source: event.source ?? null,
    transcriptPath: event.transcript_path ?? null,
    query: null,
    prompts: [],
  };
}

async function saveSession(state) {
  await writeJsonAtomically(sessionPath(state.sessionId), state);
}

async function writeProbeRecord(event) {
  const probeDir = join(storageRoot, 'probe');
  const path = join(probeDir, `${Date.now()}-${randomUUID()}.json`);

  await writeJsonAtomically(path, {
    receivedAt: new Date().toISOString(),
    event: redact(event),
  });

  // Probe records are diagnostic breadcrumbs, not the durable trace spool.
  // Retain only the newest bounded set so long-running hook installations do
  // not grow this directory forever.
  const records = (await readdir(probeDir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  await Promise.all(records.slice(0, Math.max(0, records.length - probeMaxRecords))
    .map((name) => rm(join(probeDir, name), { force: true })));
}

async function writeSpoolRecord(sessionId, record) {
  const spoolDir = join(storageRoot, 'spool', safeFilePart(sessionId));
  const revision = record.revision ? `-${safeFilePart(record.revision)}` : '';
  const path = join(spoolDir, `${record.startTimeMs}-${record.spanId}${revision}.json`);

  await writeJsonAtomically(path, record);
}

async function writeHookTrace(event, state) {
  const endTimeMs = Date.now();
  const startTimeMs = timestampMs(event.timestamp);
  await writeSpoolRecord(state.sessionId, {
    version: 1,
    traceType: 'hook',
    traceId: state.traceId,
    spanId: createSpanId(),
    parentSpanId: state.rootSpanId,
    sessionId: state.sessionId,
    name: `hook.${event.hook_event_name || 'unknown'}`,
    hookEventName: event.hook_event_name || 'unknown',
    hookToolName: event.tool_name ?? null,
    hookToolUseId: event.tool_use_id ?? null,
    hookAgentId: event.agent_id ?? null,
    hookAgentType: event.agent_type ?? null,
    status: 'ok',
    startTimeMs,
    endTimeMs: Math.max(startTimeMs, endTimeMs),
    latencyMs: Math.max(0, endTimeMs - startTimeMs),
  });
}

async function readTranscriptLlmCalls(transcriptPath) {
  if (!transcriptPath) return [];

  try {
    const lines = (await readFile(transcriptPath, 'utf8')).split(/\r?\n/);
    const calls = [];
    let latestPrompt = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user') {
          const text = entry?.message?.parts
            ?.filter((part) => typeof part?.text === 'string')
            .map((part) => part.text)
            .join('\n');
          if (text?.trim()) latestPrompt = redact(text);
        }
        const uiEvent = entry?.systemPayload?.uiEvent;
        if (uiEvent?.['event.name'] !== 'qwen-code.api_response') continue;

        const completedAt = timestampMs(uiEvent['event.timestamp'] ?? entry.timestamp);
        const latencyMs = Math.max(0, Number(uiEvent.duration_ms) || 0);
        calls.push({
          responseId: String(uiEvent.response_id ?? entry.uuid ?? randomUUID()),
          model: uiEvent.model ?? entry.model ?? null,
          provider: uiEvent.auth_type ?? 'unknown',
          subagentName: uiEvent.subagent_name ?? null,
          requestType: 'chat',
          prompt: latestPrompt,
          inputTokens: Math.max(0, Number(uiEvent.input_token_count) || 0),
          outputTokens: Math.max(0, Number(uiEvent.output_token_count) || 0),
          cachedTokens: Math.max(0, Number(uiEvent.cached_content_token_count) || 0),
          reasoningTokens: Math.max(0, Number(uiEvent.thoughts_token_count) || 0),
          totalTokens: Math.max(0, Number(uiEvent.total_token_count) || 0),
          response: redact(uiEvent.response_text ?? null),
          startTimeMs: completedAt - latencyMs,
          endTimeMs: completedAt,
          latencyMs,
        });
      } catch {
        // A partially written transcript line must never break the Qwen session.
        continue;
      }
    }
    return calls;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function handleSessionStart(event) {
  const state = await ensureSession(event);

  state.startedAt ??= event.timestamp ?? new Date().toISOString();
  state.cwd ??= event.cwd ?? null;
  state.model ??= event.model ?? null;
  state.source ??= event.source ?? null;
  state.transcriptPath ??= event.transcript_path ?? null;
  await saveSession(state);
}

async function handleUserPrompt(event) {
  const state = await ensureSession(event);
  const prompt = redact(event.prompt ?? '');

  state.prompts.push({ content: prompt, timestamp: event.timestamp ?? null });
  state.query ??= prompt;
  await saveSession(state);
}

async function handlePreToolUse(event) {
  const state = await ensureSession(event);
  const toolUseId = event.tool_use_id ?? `hook-${randomUUID()}`;

  await writeJsonAtomically(pendingToolPath(toolUseId), {
    sessionId: state.sessionId,
    traceId: state.traceId,
    parentSpanId: state.rootSpanId,
    toolUseId,
    toolCallId: event.tool_call_id ?? null,
    toolName: event.tool_name ?? 'unknown',
    toolInput: redact(event.tool_input ?? {}),
    startedAt: event.timestamp ?? new Date().toISOString(),
    startTimeMs: timestampMs(event.timestamp),
  });
}

async function handleToolCompletion(event, status) {
  const toolUseId = event.tool_use_id ?? null;
  const pending = toolUseId ? await readJson(pendingToolPath(toolUseId)) : null;
  const state = await ensureSession(event);
  const startTimeMs = pending?.startTimeMs ?? timestampMs(event.timestamp);
  const endTimeMs = timestampMs(event.timestamp);
  const toolName = event.tool_name ?? pending?.toolName ?? 'unknown';
  const normalizedToolName = String(toolName).toLowerCase();
  const isSkill = skillToolNames.has(normalizedToolName);
  const planPhase = planToolPhases.get(normalizedToolName) ?? null;
  const teamAction = teamToolActions.get(normalizedToolName) ?? null;
  const mcp = !isSkill ? mcpToolIdentity(toolName, event) : null;
  const input = pending?.toolInput ?? redact(event.tool_input ?? {});
  const output = redact(event.tool_response ?? null);
  const skillName = isSkill
    ? String(input?.skill ?? input?.skill_name ?? input?.skillName ?? input?.name ?? 'unknown')
    : null;
  let planId = null;
  if (planPhase) {
    if (planPhase === 'enter' || !state.activePlanId) {
      state.planSequence = Math.max(0, Number(state.planSequence) || 0) + 1;
      state.activePlanId = `${state.sessionId}:plan:${state.planSequence}`;
    }
    planId = state.activePlanId;
    state.lastPlanId = planId;
    if (planPhase === 'proposal' && planStatus(planPhase, status, output) === 'approved') {
      state.activePlanId = null;
    }
    await saveSession(state);
  }

  // Agent Teams delegate their members through the ordinary `agent` tool,
  // rather than the SubagentStart/SubagentStop hooks.  Materialize those
  // calls as subagent spans so concurrent Team members appear as siblings.
  if (normalizedToolName === 'agent' && status === 'ok') {
    await emitTeamMemberStart(state, input, output, startTimeMs, endTimeMs);
  }
  if (normalizedToolName === 'task_update') {
    await emitTeamMemberCompletion(state, input, output, status, endTimeMs);
  }
  if (normalizedToolName === 'agent' && status === 'ok') {
    await emitForkStart(state, input, output, event.tool_call_id ?? pending?.toolCallId ?? null, startTimeMs, endTimeMs);
  }

  let teamId = null;
  let teamName = null;
  if (teamAction) {
    if (teamAction === 'create') {
      teamName = String(input?.team_name ?? input?.teamName ?? 'unnamed-team');
      teamId = `${state.sessionId}:team:${teamName}`;
      if (status === 'ok') state.activeTeam = { id: teamId, name: teamName };
    } else {
      teamId = state.activeTeam?.id ?? `${state.sessionId}:team:unknown`;
      teamName = state.activeTeam?.name ?? null;
      if (teamAction === 'delete' && status === 'ok') state.activeTeam = null;
    }
    await saveSession(state);
  }

  await writeSpoolRecord(state.sessionId, {
    version: 1,
    traceType: isSkill ? 'skill' : planPhase ? 'plan' : teamAction ? 'team' : mcp ? 'mcp' : 'tool',
    traceId: pending?.traceId ?? state.traceId,
    spanId: createSpanId(),
    parentSpanId: pending?.parentSpanId ?? state.rootSpanId,
    sessionId: state.sessionId,
    name: isSkill
      ? `skill.${skillName}`
      : planPhase
        ? `plan.${planPhase}`
        : teamAction
          ? `team.${teamAction}`
        : mcp
          ? `mcp.${mcp.serverName}.${mcp.toolName}`
          : `tool.${toolName}`,
    toolName,
    toolType: teamAction ? 'team' : mcp ? 'mcp' : 'qwen-code',
    mcpServerName: mcp?.serverName ?? null,
    mcpToolName: mcp?.toolName ?? null,
    skillName,
    skillVersion: isSkill ? (input?.version ?? null) : null,
    triggerMode: isSkill ? (event.trigger_mode ?? 'tool') : null,
    planId,
    planPhase,
    planStatus: planPhase ? planStatus(planPhase, status, output) : null,
    planSteps: planPhase === 'steps' ? (input?.todos ?? []) : null,
    planContent: planPhase === 'proposal' ? (input?.plan ?? null) : null,
    originalRequest: planPhase === 'proposal' ? (input?.originalRequest ?? null) : null,
    researchSummary: planPhase === 'proposal' ? (input?.researchSummary ?? null) : null,
    teamId,
    teamName,
    teamAction,
    teamDescription: teamAction === 'create' ? (input?.description ?? null) : null,
    teamApprovalAction: teamAction === 'plan_approval' ? (input?.action ?? null) : null,
    teamApprovalRequestId: teamAction === 'plan_approval' ? (input?.request_id ?? null) : null,
    toolUseId,
    toolCallId: event.tool_call_id ?? pending?.toolCallId ?? null,
    input,
    output,
    error: status === 'error' ? redact(event.error ?? event.tool_response ?? 'Tool execution failed') : null,
    status,
    startTimeMs,
    endTimeMs,
    latencyMs: Math.max(0, endTimeMs - startTimeMs),
  });

  if (toolUseId) {
    await rm(pendingToolPath(toolUseId), { force: true });
  }
}

async function handleSubagentStart(event) {
  const state = await ensureSession(event);
  const agentId = String(event.agent_id ?? randomUUID());
  const invocation = await findPendingAgentInvocation(state.sessionId, agentId);
  const activeForegroundAgents = Array.isArray(state.activeForegroundAgents) ? state.activeForegroundAgents : [];
  // Qwen 0.20.1 omits parent_agent_id from SubagentStart. A foreground parent
  // blocks the caller until completion, so another agent starting while that
  // frame is active is necessarily its nested child. Background root agents
  // are deliberately not pushed and remain siblings.
  const inferredParentId = activeForegroundAgents.at(-1)?.agentId ?? null;
  const parentAgentId = event.parent_agent_id ?? event.parentAgentId ?? inferredParentId;
  const agentType = String(event.agent_type ?? event.agentType ?? 'subagent');
  // Qwen Code implements `/fork` as a background agent with the reserved
  // subagent type `fork`.  Preserve the inherited-parent relationship rather
  // than treating it as a brand-new root session.
  const isFork = agentType.toLowerCase() === 'fork' || event.is_fork === true || event.isFork === true;
  const parent = parentAgentId ? await readJson(subagentPath(state.sessionId, parentAgentId)) : null;
  const existingPending = await readJson(subagentPath(state.sessionId, agentId));
  const pendingAgent = existingPending ?? {
    sessionId: state.sessionId,
    traceId: state.traceId,
    agentId,
    agentType,
    isFork,
    forkedFromSessionId: event.parent_session_id ?? event.parentSessionId ?? (isFork ? state.sessionId : null),
    teamId: state.activeTeam?.id ?? null,
    teamName: state.activeTeam?.name ?? null,
    parentAgentId,
    parentSpanId: parent?.spanId ?? state.rootSpanId,
    spanId: createSpanId(),
    task: redact(event.task ?? event.description ?? invocation?.toolInput?.prompt ?? invocation?.toolInput?.description ?? null),
    startedAt: event.timestamp ?? new Date().toISOString(),
    startTimeMs: timestampMs(event.timestamp),
  };
  await writeJsonAtomically(subagentPath(state.sessionId, agentId), pendingAgent);

  const isForeground = parentAgentId !== null || invocation?.toolInput?.run_in_background === false;
  if (isForeground) {
    state.activeForegroundAgents = [...activeForegroundAgents, { agentId, spanId: pendingAgent.spanId }];
    await saveSession(state);
  }
}

async function handleSubagentStop(event) {
  const state = await ensureSession(event);
  const agentId = String(event.agent_id ?? 'unknown');
  const pending = await readJson(subagentPath(state.sessionId, agentId));
  const endTimeMs = timestampMs(event.timestamp);
  const startTimeMs = pending?.startTimeMs ?? endTimeMs;
  const parentCalls = await readTranscriptLlmCalls(event.transcript_path);
  const agentType = String(event.agent_type ?? pending?.agentType ?? 'subagent');
  const calls = parentCalls.filter((call) => String(call.subagentName ?? '').toLowerCase() === agentType.toLowerCase());
  const fallbackCalls = calls.length ? calls : await readTranscriptLlmCalls(event.agent_transcript_path);
  const inputTokens = fallbackCalls.reduce((sum, call) => sum + call.inputTokens, 0);
  const outputTokens = fallbackCalls.reduce((sum, call) => sum + call.outputTokens, 0);
  const reasoningTokens = fallbackCalls.reduce((sum, call) => sum + call.reasoningTokens, 0);

  await writeSpoolRecord(state.sessionId, {
    version: 1,
    revision: 'completed',
    traceType: 'subagent',
    traceId: pending?.traceId ?? state.traceId,
    spanId: pending?.isFork ? createSpanId() : (pending?.spanId ?? createSpanId()),
    parentSpanId: pending?.parentSpanId ?? state.rootSpanId,
    sessionId: state.sessionId,
    name: `agent.${event.agent_type ?? pending?.agentType ?? 'subagent'}`,
    agentId,
    agentType,
    parentAgentId: pending?.parentAgentId ?? null,
    isFork: pending?.isFork ?? agentType.toLowerCase() === 'fork',
    forkedFromSessionId: pending?.forkedFromSessionId ?? null,
    task: pending?.task ?? null,
    result: redact(event.last_assistant_message ?? null),
    status: event.error ? 'error' : 'ok',
    error: redact(event.error ?? null),
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    llmCallCount: fallbackCalls.length,
    startTimeMs,
    endTimeMs,
    latencyMs: Math.max(0, endTimeMs - startTimeMs),
  });
  if (Array.isArray(state.activeForegroundAgents)) {
    state.activeForegroundAgents = state.activeForegroundAgents.filter((entry) => entry?.agentId !== agentId);
    await saveSession(state);
  }
  await rm(subagentPath(state.sessionId, agentId), { force: true });
}

async function countToolSpans(sessionId) {
  const spoolDir = join(storageRoot, 'spool', safeFilePart(sessionId));

  try {
    const names = await readdir(spoolDir);
    const records = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readJson(join(spoolDir, name))));
    return records.filter((record) => ['tool', 'mcp', 'plan', 'team'].includes(record?.traceType)).length;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

async function emitTranscriptSkills(state, transcriptPath) {
  const emittedSkillIds = new Set(state.emittedSkillIds ?? []);
  const calls = await readTranscriptSkillCalls(transcriptPath);

  for (const call of calls) {
    if (emittedSkillIds.has(call.invocationId)) continue;
    await writeSpoolRecord(state.sessionId, {
      version: 1,
      traceType: 'skill',
      traceId: state.traceId,
      spanId: createSpanId(),
      parentSpanId: state.rootSpanId,
      sessionId: state.sessionId,
      name: `skill.${call.skillName}`,
      toolName: 'skill',
      skillName: call.skillName,
      skillVersion: call.version,
      skillSource: call.source,
      triggerMode: call.triggerMode,
      input: redact({ command: call.command, arguments: call.arguments, baseDirectory: call.baseDirectory }),
      output: redact(call.result),
      status: 'ok',
      startTimeMs: call.startTimeMs,
      endTimeMs: call.endTimeMs,
      latencyMs: Math.max(0, call.endTimeMs - call.startTimeMs),
    });
    emittedSkillIds.add(call.invocationId);
  }

  state.emittedSkillIds = [...emittedSkillIds];
}

async function handleSessionEnd(event) {
  const state = await ensureSession(event);
  const endTimeMs = timestampMs(event.timestamp);
  const startTimeMs = timestampMs(state.startedAt);
  const llmCalls = (await readTranscriptLlmCalls(event.transcript_path ?? state.transcriptPath)).filter((call) => !call.subagentName);
  state.query ??= llmCalls.find((call) => call.prompt)?.prompt ?? null;
  const emittedResponseIds = new Set(state.emittedResponseIds ?? []);

  for (const call of llmCalls) {
    if (emittedResponseIds.has(call.responseId)) continue;
    await writeSpoolRecord(state.sessionId, {
      version: 1,
      traceType: 'llm',
      traceId: state.traceId,
      spanId: createSpanId(),
      parentSpanId: state.rootSpanId,
      sessionId: state.sessionId,
      name: 'llm.qwen-code.chat',
      model: call.model ?? state.model ?? 'unknown',
      provider: call.provider,
      requestType: call.requestType,
      prompt: call.prompt,
      response: call.response,
      promptTokens: call.inputTokens,
      completionTokens: call.outputTokens,
      cachedTokens: call.cachedTokens,
      reasoningTokens: call.reasoningTokens,
      totalTokens: call.totalTokens || call.inputTokens + call.outputTokens + call.reasoningTokens,
      startTimeMs: call.startTimeMs,
      endTimeMs: call.endTimeMs,
      latencyMs: call.latencyMs,
      status: 'ok',
    });
    emittedResponseIds.add(call.responseId);
    state.model ??= call.model ?? null;
    if (call.response) state.result = call.response;
  }
  state.emittedResponseIds = [...emittedResponseIds];
  await emitTranscriptSkills(state, event.transcript_path ?? state.transcriptPath);
  await saveSession(state);
  const totalTokens = llmCalls.reduce((sum, call) => sum + call.totalTokens, 0);

  await writeSpoolRecord(state.sessionId, {
    version: 1,
    traceType: 'agent',
    traceId: state.traceId,
    spanId: state.rootSpanId,
    parentSpanId: null,
    sessionId: state.sessionId,
    name: 'agent.qwen-code',
    framework: 'qwencode',
    query: state.query,
    prompts: state.prompts,
    model: state.model,
    cwd: state.cwd,
    result: state.result ?? null,
    endReason: event.reason ?? null,
    toolCallCount: await countToolSpans(state.sessionId),
    totalTokens,
    startTimeMs,
    endTimeMs,
    latencyMs: Math.max(0, endTimeMs - startTimeMs),
    status: 'ok',
  });

  kickUploader();
}

async function handleStop(event) {
  const state = await ensureSession(event);
  state.transcriptPath ??= event.transcript_path ?? null;
  const endTimeMs = timestampMs(event.timestamp);
  const startTimeMs = timestampMs(state.startedAt);
  const llmCalls = (await readTranscriptLlmCalls(event.transcript_path ?? state.transcriptPath)).filter((call) => !call.subagentName);
  state.query ??= llmCalls.find((call) => call.prompt)?.prompt ?? null;
  const emittedResponseIds = new Set(state.emittedResponseIds ?? []);

  for (const call of llmCalls) {
    if (emittedResponseIds.has(call.responseId)) continue;
    await writeSpoolRecord(state.sessionId, {
      version: 1, traceType: 'llm', traceId: state.traceId, spanId: createSpanId(), parentSpanId: state.rootSpanId,
      sessionId: state.sessionId, name: 'llm.qwen-code.chat', model: call.model ?? state.model ?? 'unknown',
      provider: call.provider, requestType: call.requestType, prompt: call.prompt, response: call.response,
      promptTokens: call.inputTokens, completionTokens: call.outputTokens, cachedTokens: call.cachedTokens,
      reasoningTokens: call.reasoningTokens, totalTokens: call.totalTokens || call.inputTokens + call.outputTokens + call.reasoningTokens,
      startTimeMs: call.startTimeMs, endTimeMs: call.endTimeMs, latencyMs: call.latencyMs, status: 'ok',
    });
    emittedResponseIds.add(call.responseId);
    state.model ??= call.model ?? null;
    if (call.response) state.result = call.response;
  }
  state.emittedResponseIds = [...emittedResponseIds];
  await emitTranscriptSkills(state, event.transcript_path ?? state.transcriptPath);
  state.result ??= redact(event.last_assistant_message ?? null);
  await saveSession(state);

  await writeSpoolRecord(state.sessionId, {
    version: 1, traceType: 'agent', traceId: state.traceId, spanId: state.rootSpanId, parentSpanId: null,
    sessionId: state.sessionId, name: 'agent.qwen-code', framework: 'qwencode', query: state.query,
    prompts: state.prompts, model: state.model, cwd: state.cwd, result: state.result ?? null,
    endReason: 'turn_stop', toolCallCount: await countToolSpans(state.sessionId), startTimeMs, endTimeMs,
    latencyMs: Math.max(0, endTimeMs - startTimeMs), status: 'ok',
  });
  kickUploader();
}

async function processEvent(event) {
  switch (event.hook_event_name) {
    case 'SessionStart':
      await handleSessionStart(event);
      break;
    case 'UserPromptSubmit':
      await handleUserPrompt(event);
      break;
    case 'PreToolUse':
      await handlePreToolUse(event);
      break;
    case 'PostToolUse':
      await handleToolCompletion(event, 'ok');
      break;
    case 'PostToolUseFailure':
      await handleToolCompletion(event, 'error');
      break;
    case 'SubagentStart':
      await handleSubagentStart(event);
      break;
    case 'SubagentStop':
      await handleSubagentStop(event);
      break;
    case 'Stop':
      await handleStop(event);
      break;
    case 'SessionEnd':
      await handleSessionEnd(event);
      break;
    default:
      break;
  }
}

async function main() {
  const rawInput = await readStdin();

  if (!rawInput.trim()) {
    return;
  }

  const event = JSON.parse(rawInput);
  await withSessionStateLock(event.session_id, async () => {
    await writeProbeRecord(event);
    // Persist the context before writing the hook span. SessionStart is itself a
    // hook, so without this save the following handler could create a second
    // trace/root pair and orphan the lifecycle event.
    const state = await ensureSession(event);
    await saveSession(state);
    await writeHookTrace(event, state);
    await processEvent(event);
    // Qwen 0.20.1 can deadlock its UserPromptSubmit message-bus response when
    // Agent Teams are enabled, so query text is recovered from the transcript.
    // Start the uploader from the asynchronous session hook. Starting a
    // long-lived child from a synchronous PreToolUse hook makes PowerShell keep
    // the hook process tree open on Windows until Qwen's 60-second timeout.
    if (event.hook_event_name === 'SessionStart') kickUploader(true);
  });
}

main()
  .then(() => {
    // Qwen command hooks accept JSON on stdout. This observer never blocks or
    // changes an action, so always return an explicit non-blocking decision.
    process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true })}\n`);
  })
  .catch((error) => {
    console.error('[qwencode-collector] Hook processing failed:', error.message);
    process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true })}\n`);
    process.exitCode = 0;
  });
