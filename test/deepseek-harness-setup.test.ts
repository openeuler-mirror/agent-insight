import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { GET as getAsset } from '@/app/api/ingest/setup/deepseek-harness/assets/[asset]/route';
import { deepSeekHarnessPluginFiles } from '@/app/api/ingest/setup/deepseek-harness/files';
import { GET as getInstaller } from '@/app/api/ingest/setup/deepseek-harness/route';

test('Harness plugin files are deterministic, complete, and served from an allow-list', async () => {
  const first = deepSeekHarnessPluginFiles();
  const second = deepSeekHarnessPluginFiles();

  assert.equal(first.sourceDigest, second.sourceDigest);
  assert.deepEqual(first.files.map((file) => file.name), [
    'package.json',
    'index.js',
    'cordis.patch.yml',
  ]);
  for (const file of first.files) {
    assert.equal(file.sha256, createHash('sha256').update(file.content).digest('hex'));
    const response = await getAsset(
      new Request(`https://insight.example/api/ingest/setup/deepseek-harness/assets/${file.name}`),
      { params: Promise.resolve({ asset: file.name }) },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), file.contentType);
    assert.equal(response.headers.get('x-agent-insight-sha256'), file.sha256);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), file.content);
  }
  const missing = await getAsset(
    new Request('https://insight.example/api/ingest/setup/deepseek-harness/assets/secret.txt'),
    { params: Promise.resolve({ asset: 'secret.txt' }) },
  );
  assert.equal(missing.status, 404);
});

test('Harness setup route downloads hash-verified plugin files without a ZIP dependency', async () => {
  const response = await getInstaller(new Request(
    'http://internal:3000/api/ingest/setup/deepseek-harness?key=sk-must-not-leak',
    {
      headers: {
        'x-forwarded-host': 'insight.example:8443',
        'x-forwarded-proto': 'https',
      },
    },
  ));
  const script = await response.text();

  assert.equal(response.status, 200);
  assert.match(script, /BASE_URL="\$\{AGENT_INSIGHT_BASE_URL:-https:\/\/insight\.example:8443\}"/);
  assert.match(script, /api\/ingest\/setup\/deepseek-harness\/assets\/package\.json/);
  assert.match(script, /api\/ingest\/setup\/deepseek-harness\/assets\/index\.js/);
  assert.match(script, /api\/ingest\/setup\/deepseek-harness\/assets\/cordis\.patch\.yml/);
  assert.doesNotMatch(script, /\.zip\b/);
  assert.doesNotMatch(script, /\bunzip\b/);
  assert.doesNotMatch(script, /deepseek-harness\/bundle/);
  assert.match(script, /dsh plugin --profile "\$profile" add/);
  assert.match(script, /AGENT_INSIGHT_API_KEY/);
  assert.doesNotMatch(script, /sk-must-not-leak/);
  assert.doesNotMatch(script, /__AGENT_INSIGHT_/);
  assert.doesNotMatch(script, /__DEEPSEEK_HARNESS_/);
});

test('Harness setup route safely escapes shell-significant forwarded origins', async () => {
  const response = await getInstaller(new Request('https://internal/api/ingest/setup/deepseek-harness', {
    headers: {
      'x-forwarded-host': 'insight.example/$(touch /tmp/harness-injection)',
      'x-forwarded-proto': 'https',
    },
  }));
  const script = await response.text();

  assert.match(script, /\\\$\(touch \/tmp\/harness-injection\)/);
});
