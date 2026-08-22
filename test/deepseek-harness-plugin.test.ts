import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const pluginRoot = path.join(process.cwd(), 'scripts', 'agent-trace-collectors', 'deepseek-harness');

test('Harness telemetry policy redacts recursively before Unicode-safe truncation', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const original = {
    channel: 'ledger',
    time: 1,
    severity: 'info',
    attributes: {
      'session.id': 'session-1',
      authorization: 'Bearer secret-header',
      'x-witty-api-key': 'platform-secret',
    },
    body: {
      apiKey: 'sk-direct-secret',
      command: 'DEEPSEEK_API_KEY=sk-env-secret run',
      url: 'https://example.test/path?access_token=url-secret&ok=1',
      nested: [{ password: 'hunter2' }],
      long: '甲乙丙丁戊己庚辛壬癸',
    },
  };

  const transformed = plugin.redactTelemetryRecord(original, { maxStringChars: 6 });

  assert.notEqual(transformed, original);
  assert.equal(original.body.apiKey, 'sk-direct-secret');
  assert.equal(transformed.attributes.authorization, '[REDACTED]');
  assert.equal(transformed.attributes['x-witty-api-key'], '[REDACTED]');
  assert.equal(transformed.body.apiKey, '[REDACTED]');
  assert.equal(transformed.body.nested[0].password, '[REDACTED]');
  assert.doesNotMatch(transformed.body.command, /sk-env-secret/);
  assert.doesNotMatch(transformed.body.url, /url-secret/);
  assert.match(transformed.body.long, /^甲乙丙丁戊己…\[truncated chars=10 sha256=[0-9a-f]{16}\]$/);
  assert.equal(transformed.attributes['agent.insight.integration.name'], 'deepseek-harness');
  assert.equal(transformed.attributes['agent.insight.integration.version'], '0.1.0');
  assert.equal(transformed.attributes['agent.insight.redaction.policy'], 'v1');
});

test('Harness telemetry policy preserves ordinary prompts, Tool schema, and token accounting', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const record = plugin.redactTelemetryRecord({
    channel: 'ledger',
    time: 1,
    severity: 'info',
    attributes: { 'session.id': 'session-2', 'event.type': 'request/header', 'event.seq': 0 },
    body: {
      header: {
        config: { model: 'deepseek-chat', maxTokens: 4096 },
        system: 'You are a coding agent.',
        tools: [{ name: 'read', description: 'Read a file' }],
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    },
  });

  assert.equal(record.body.header.system, 'You are a coding agent.');
  assert.equal(record.body.header.tools[0].description, 'Read a file');
  assert.equal(record.body.usage.inputTokens, 10);
  assert.equal(record.body.usage.outputTokens, 2);
});

test('Harness plugin mounts the official synchronous waterfall', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  let eventName = '';
  let listener: any;
  const ctx = {
    on(name: string, callback: any) {
      eventName = name;
      listener = callback;
    },
  };

  plugin.apply(ctx, { maxStringChars: 64 });
  const transformed = listener(null, () => ({
    channel: 'ledger',
    time: 1,
    severity: 'info',
    attributes: {},
    body: { secret: 'do-not-export' },
  }));

  assert.equal(eventName, 'session-telemetry/record');
  assert.equal(transformed.body.secret, '[REDACTED]');
});

test('Harness bundle replaces the official telemetry row without embedding secrets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  const patch = fs.readFileSync(path.join(pluginRoot, 'cordis.patch.yml'), 'utf8');

  assert.equal(packageJson.name, 'agent-insight-deepseek-harness-observability');
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
  assert.match(patch, /^- id: session-telemetry-otel/m);
  assert.match(patch, /name: '@deepseek-ai\/dsh-session-telemetry-otel'/);
  assert.match(patch, /mode: FULL/);
  assert.match(patch, /url: !!js "/);
  assert.match(patch, /process\.env\.AGENT_INSIGHT_BASE_URL/);
  assert.match(patch, /process\.env\.AGENT_INSIGHT_API_KEY/);
  assert.match(patch, /x-witty-api-key/);
  assert.match(patch, /compression: gzip/);
  assert.doesNotMatch(patch, /replace\(\/\//);
  assert.doesNotMatch(patch, /harness-telemetry\.deepseeksvc\.com/);
  assert.doesNotMatch(patch, /sk-[a-zA-Z0-9]/);
});
