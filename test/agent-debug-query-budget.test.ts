import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const inspectScript = path.join(
  process.cwd(),
  'skills/agent-debug-diagnosis/scripts/agentdebug_inspect.py',
);

test('agent-debug inspect keeps large tail, range and contextual search outputs below 50KB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-debug-budget-'));
  const inputPath = path.join(dir, 'agent-debug-input.json');
  const longText = `needle-${'长文本'.repeat(10_000)}`;
  const turns = Array.from({ length: 30 }, (_, index) => ({
    turnIndex: index + 1,
    traceStepIndex: index + 1,
    role: 'assistant',
    text: longText,
    reasoningText: longText,
    toolCalls: Array.from({ length: 5 }, (_, toolIndex) => ({
      name: `tool-${toolIndex}`,
      status: 'ok',
      args: { content: longText },
      output: longText,
    })),
  }));
  fs.writeFileSync(inputPath, JSON.stringify({ turns, traceBundle: {} }));

  const commands = [
    ['tail', '--input', inputPath, '--count', '20'],
    ['range', '--input', inputPath, '--from', '1', '--to', '20'],
    ['search', '--input', inputPath, '--terms', 'needle', '--context', '1', '--limit', '20'],
  ];
  for (const args of commands) {
    const output = execFileSync('python3', [inspectScript, ...args], { encoding: 'utf8' });
    assert.ok(Buffer.byteLength(output, 'utf8') < 50_000, `${args[0]} output should stay below 50KB`);
  }
});
