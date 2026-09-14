import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS } from '../src/lib/engine/experiment/constants';

test('experiment wizard exposes and submits the Agent execution timeout', () => {
  const wizard = fs.readFileSync(
    path.join(process.cwd(), 'src/components/eval/ExperimentWizard.tsx'),
    'utf8',
  );

  assert.equal(DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS, 600);
  assert.match(wizard, /Agent 执行上限（秒）/);
  assert.match(wizard, /min=\{30\}/);
  assert.match(wizard, /max=\{3600\}/);
  assert.match(wizard, /agentTimeoutSeconds,/);
  assert.match(wizard, /timeoutSeconds: agentTimeoutSeconds/);
  assert.match(wizard, /Agent 执行上限[\s\S]*\$\{agentTimeoutSeconds\} 秒/);
});
