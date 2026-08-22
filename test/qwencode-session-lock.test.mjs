import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const collectorScript = join(process.cwd(), 'scripts', 'qwencode-collector', 'index.mjs');

function runHook(event, home, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [collectorScript], {
      cwd: process.cwd(),
      env: { ...process.env, USERPROFILE: home, HOME: home, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(event));
  });
}

test('QwenCode collector serializes concurrent session state updates', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'qwencode-session-lock-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const sessionId = 'concurrent-subagents';
  await runHook({
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_use_id: 'setup',
    tool_name: 'read_file',
    tool_input: {},
    timestamp: new Date().toISOString(),
  }, home);

  const agentIds = Array.from({ length: 16 }, (_, index) => `agent-${index}`);
  await Promise.all(agentIds.map((agentId) => runHook({
    hook_event_name: 'SubagentStart',
    session_id: sessionId,
    agent_id: agentId,
    parent_agent_id: 'root-agent',
    agent_type: 'general-purpose',
    timestamp: new Date().toISOString(),
  }, home)));

  const sessionPath = join(home, '.agent-insight', 'otel_data', 'qwencode', 'anonymous', 'sessions', `${sessionId}.json`);
  const session = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.deepEqual(
    session.activeForegroundAgents.map((agent) => agent.agentId).sort(),
    agentIds.sort(),
  );
});

test('QwenCode collector bounds diagnostic probe records', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'qwencode-probe-retention-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  for (let index = 0; index < 8; index += 1) {
    await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'probe-retention',
      tool_use_id: `probe-${index}`,
      tool_name: 'read_file',
      tool_input: {},
      timestamp: new Date().toISOString(),
    }, home, {
      AGENT_INSIGHT_API_KEY: '',
      AGENT_INSIGHT_QWEN_PROBE_MAX_FILES: '5',
    });
  }

  const probeDir = join(home, '.agent-insight', 'otel_data', 'qwencode', 'anonymous', 'probe');
  const records = (await readdir(probeDir)).filter((name) => name.endsWith('.json'));
  assert.equal(records.length, 5);
});
