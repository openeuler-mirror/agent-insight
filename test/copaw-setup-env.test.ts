import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';

import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';
import { GET as getCopawCollectorArchive } from '@/app/api/ingest/setup/copaw-collector/route';

const routes: { name: string; get: (request: Request) => Promise<Response>; url: string }[] = [
  {
    name: 'setup',
    get: getSetup,
    url: 'http://localhost/api/ingest/setup?nokey=1',
  },
  {
    name: 'auto setup',
    get: getAutoSetup,
    url: 'http://localhost/api/setup/auto?apiKey=test-key&host=http%3A%2F%2Flocalhost%3A3000',
  },
];

test('CoPaw is offered and installable from both setup entry points', async () => {
  for (const route of routes) {
    for (const platform of ['unix', 'windows']) {
      const response = await route.get(new Request(route.url, {
        headers: { 'x-platform': platform, host: 'localhost:3000' },
      }));
      assert.equal(response.status, 200, `${route.name} (${platform})`);

      const script = await response.text();
      assert.match(script, /CoPaw \(QwenPaw\)/, `${route.name} (${platform}) should offer CoPaw`);
      assert.match(script, /INSTALL_COPAW/, `${route.name} (${platform}) should define the CoPaw install flag`);
      assert.match(script, /api\/ingest\/setup\/copaw-collector/, `${route.name} (${platform}) should download the bundled CoPaw collector`);
      assert.match(script, /pip install --disable-pip-version-check --upgrade/, `${route.name} (${platform}) should install the bundled CoPaw package`);
      assert.match(script, /copaw\.cli install/, `${route.name} (${platform}) should install the CoPaw collector`);
      assert.match(script, /loaded by QwenPaw hooks/, `${route.name} (${platform}) should describe hook-based plugin loading`);
      const componentsMarker = platform === 'unix'
        ? 'echo "Installed Components:"'
        : 'Write-Host "Installed Components:"';
      assert.ok(
        script.indexOf(componentsMarker) < script.indexOf('CoPaw (QwenPaw) Collector: bundled hook plugin'),
        `${route.name} (${platform}) should keep the CoPaw summary in its own components block`,
      );
    }
  }
});

test('CoPaw setup endpoint serves a pip-installable collector archive', async () => {
  const response = await getCopawCollectorArchive();
  const bytes = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.deepEqual(Array.from(bytes.slice(0, 2)), [0x50, 0x4b]);

  const archive = new AdmZip(Buffer.from(bytes));
  const entries = archive.getEntries().map((entry) => entry.entryName);
  assert.ok(entries.includes('pyproject.toml'));
  assert.ok(entries.includes('README.md'));
  assert.ok(entries.includes('plugin.json'));
  assert.ok(entries.includes('backend.py'));
  assert.ok(entries.includes('copaw/__init__.py'));
  assert.ok(entries.includes('copaw/_plugin_assets/plugin.json'));
  assert.ok(entries.includes('copaw/_plugin_assets/backend.py'));
  assert.ok(!entries.some((name) => name.includes('__pycache__') || name.endsWith('.pyc')));
  assert.ok(!entries.some((name) => name.startsWith('build/') || name.startsWith('dist/')));
});
