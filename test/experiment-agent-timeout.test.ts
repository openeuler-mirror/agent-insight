import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
  MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
  MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
  isValidExperimentAgentTimeoutSeconds,
} from '../src/lib/engine/experiment/constants';

test('experiment wizard exposes and submits the Agent execution timeout', () => {
  const wizard = fs.readFileSync(
    path.join(process.cwd(), 'src/components/eval/ExperimentWizard.tsx'),
    'utf8',
  );
  const skillExperimentRoute = fs.readFileSync(
    path.join(process.cwd(), 'src/app/api/skill-workbench/skills/[name]/experiments/route.ts'),
    'utf8',
  );
  const skillExperimentService = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/skill-workbench/experiment-service.ts'),
    'utf8',
  );

  assert.equal(DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS, 600);
  assert.equal(MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS, 30);
  assert.equal(MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS, 3_600);
  assert.equal(isValidExperimentAgentTimeoutSeconds(30), true);
  assert.equal(isValidExperimentAgentTimeoutSeconds(3_600), true);
  assert.equal(isValidExperimentAgentTimeoutSeconds(29), false);
  assert.equal(isValidExperimentAgentTimeoutSeconds(3_601), false);
  assert.equal(isValidExperimentAgentTimeoutSeconds(30.5), false);
  assert.match(wizard, /Agent 单次执行上限（秒）/);
  assert.match(wizard, /min=\{MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS\}/);
  assert.match(wizard, /max=\{MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS\}/);
  assert.match(wizard, /agentTimeoutSeconds,/);
  assert.match(wizard, /timeoutSeconds: agentTimeoutSeconds/);
  assert.match(wizard, /agentTimeoutRequired = skillPreset === 'skill-ab'/);
  assert.match(wizard, /skillPreset !== 'trigger' \? \{ agentTimeoutSeconds \} : \{\}/);
  assert.match(wizard, /Agent 单次执行上限[\s\S]*\$\{agentTimeoutSeconds\} 秒/);
  assert.match(skillExperimentRoute, /isValidExperimentAgentTimeoutSeconds\(agentTimeoutSeconds\)/);
  assert.match(skillExperimentRoute, /agentTimeoutSeconds: preset === 'trigger' \? undefined : agentTimeoutSeconds/);
  assert.match(skillExperimentService, /timeoutMs: isTriggerExperiment \? 30 \* 1000 : agentTimeoutSeconds \* 1_000/);
  assert.doesNotMatch(skillExperimentService, /10 \* 60 \* 1000/);
});
