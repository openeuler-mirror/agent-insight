import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(__dirname, '..');
const platformScript = path.join(root, 'scripts/start.sh');
const evaluatorScript = path.join(root, 'scripts/start-evaluator.sh');

function fixture(t: any, config = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'service-port-config-'));
  fs.writeFileSync(path.join(home, '.env'), config);
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: home, AGENT_INSIGHT_EVALUATOR_HOME: path.join(home, 'evaluator') };
  for (const key of ['PORT', 'AGENT_INSIGHT_PORT', 'AGENT_INSIGHT_EVALUATOR_PORT', 'AGENT_INSIGHT_DATA_DIR', 'DOCKER_HOST']) delete env[key];
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, env };
}

function resolvePort(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const source = fs.readFileSync(script, 'utf8');
  const marker = script === platformScript ? 'echo "Checking port' : 'for command_name in git docker df';
  const offset = source.indexOf(marker);
  assert.ok(offset > 0);
  const variable = script === platformScript ? 'PLATFORM_PORT' : 'EVALUATOR_HOST_PORT';
  return spawnSync('bash', ['-c', `${source.slice(0, offset)}\nprintf 'RESOLVED=%s\\n' "$${variable}"`, script, ...args], { env, encoding: 'utf8' });
}

for (const [label, script, variable, defaultPort] of [
  ['platform', platformScript, 'AGENT_INSIGHT_PORT', '3000'],
  ['evaluator', evaluatorScript, 'AGENT_INSIGHT_EVALUATOR_PORT', '3001'],
] as const) {
  test(`${label} port: CLI > process environment > managed .env > default, with independent names`, (t) => {
    const f = fixture(t, 'AGENT_INSIGHT_PORT=3200\nAGENT_INSIGHT_EVALUATOR_PORT=3201\n');
    const check = (expected: string, env = f.env, args: string[] = []) => {
      const result = resolvePort(script, env, args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`RESOLVED=${expected}\\s*$`));
    };
    check(label === 'platform' ? '3200' : '3201');
    check('3300', { ...f.env, [variable]: '3300' });
    check('3400', { ...f.env, [variable]: '3300' }, ['--port', '3400']);
    check(defaultPort, { ...f.env, [variable]: '' });
    fs.writeFileSync(path.join(f.home, '.env'), '');
    check(defaultPort);
  });

  test(`${label} rejects old PORT and invalid ports before startup side effects`, (t) => {
    const f = fixture(t);
    for (const invalid of ['0', '65536', '-1', '3.5', '3000abc', '99999999999999999999999999']) {
      const result = resolvePort(script, { ...f.env, [variable]: invalid });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /1.*65535/);
    }
    assert.notEqual(resolvePort(script, f.env, ['--port', '']).status, 0);
    assert.notEqual(resolvePort(script, f.env, ['--port', '3100', '--port', '3101']).status, 0);
    for (const env of [{ ...f.env, PORT: '3999' }, f.env]) {
      if (!env.PORT) fs.writeFileSync(path.join(f.home, '.env'), 'PORT=3999\n');
      const result = resolvePort(script, env, ['--port', '3100']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PORT 已移除/);
      assert.doesNotMatch(result.stdout, /RESOLVED=/);
    }
  });
}

test('npm start/stop/status share the new platform variable and do not read cwd .env or legacy PORT', (t) => {
  const f = fixture(t, 'AGENT_INSIGHT_PORT="3500" # platform\nAGENT_INSIGHT_EVALUATOR_PORT=3501\n');
  const invoke = (env: NodeJS.ProcessEnv, options = {}) => spawnSync(process.execPath, ['-e',
    `console.log(require(${JSON.stringify(path.join(root, 'scripts/utils.js'))}).getPort(${JSON.stringify(options)}))`], { env, encoding: 'utf8', cwd: os.tmpdir() });
  for (const [env, options, expected] of [
    [f.env, {}, '3500'], [{ ...f.env, AGENT_INSIGHT_PORT: '3600' }, {}, '3600'],
    [{ ...f.env, AGENT_INSIGHT_PORT: '3600' }, { port: 3700 }, '3700'],
    [{ ...f.env, AGENT_INSIGHT_PORT: '' }, {}, '3000'],
  ] as const) {
    const result = invoke(env, options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
  for (const value of ['0', '65536', '3100oops']) assert.notEqual(invoke({ ...f.env, AGENT_INSIGHT_PORT: value }).status, 0);
  assert.match(invoke({ ...f.env, PORT: '3999' }, { port: 3100 }).stderr, /PORT 已移除/);
  fs.writeFileSync(path.join(f.home, '.env'), 'PORT=3999\n');
  assert.match(invoke(f.env).stderr, /PORT 已移除/);
});

test('evaluator blocks container-port overrides through runtime env', (t) => {
  const f = fixture(t);
  for (const key of ['PORT', 'EVALUATOR_PORT', 'AGENT_INSIGHT_PORT', 'AGENT_INSIGHT_EVALUATOR_PORT']) {
    const result = resolvePort(evaluatorScript, f.env, ['--evaluator-env', `${key}=9000`]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /端口不能通过 --evaluator-env 设置/);
  }
  const source = fs.readFileSync(evaluatorScript, 'utf8');
  assert.match(source, /--publish "\$BIND_ADDRESS:\$EVALUATOR_HOST_PORT:8080"/);
  assert.match(source, /printf 'EVALUATOR_PORT=8080\\n'/);
  assert.match(fs.readFileSync(platformScript, 'utf8'), /PORT="\$PLATFORM_PORT" NODE_OPTIONS/);
});

test('stop/purge locates the evaluator by instance even if the configured external port changes', (t) => {
  const f = fixture(t);
  const bin = path.join(f.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$PORT_TEST_CALLS"
case "$1 $2" in
  'info --format') echo test-daemon ;;
  'context show') echo default ;;
  'context inspect') echo unix:///tmp/port-test.sock ;;
  'container inspect'|'image inspect') echo sha256:test-image ;;
  'run --rm') echo '{"stopped":true,"skipped":[]}' ;;
esac
`, { mode: 0o755 });
  const calls = path.join(f.home, 'docker-calls');
  for (const args of [[], ['--purge-images'], ['--purge-images', '--dry-run']]) {
    const result = spawnSync('bash', [path.join(root, 'scripts/stop-evaluator.sh'), ...args], {
      env: { ...f.env, PATH: `${bin}:${process.env.PATH}`, PORT_TEST_CALLS: calls, AGENT_INSIGHT_EVALUATOR_PORT: '4201' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const log = fs.readFileSync(calls, 'utf8');
  assert.match(log, /container inspect agent-insight-benchmark-evaluator/);
  assert.match(log, /EVALUATOR_INSTANCE_ID=agent-insight-benchmark-evaluator/);
  assert.match(log, /--purge-images/);
  assert.doesNotMatch(log, /4201|prune|publish/);
});
