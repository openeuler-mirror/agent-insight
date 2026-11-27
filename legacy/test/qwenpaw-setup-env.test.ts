/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';

import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';
import { GET as getQwenPawCollectorArchive } from '@/app/api/ingest/setup/qwenpaw-collector/route';

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

test('QwenPaw is offered and installable from both setup entry points', async () => {
  for (const route of routes) {
    for (const platform of ['unix', 'windows']) {
      const response = await route.get(new Request(route.url, {
        headers: { 'x-platform': platform, host: 'localhost:3000' },
      }));
      assert.equal(response.status, 200, `${route.name} (${platform})`);

      const script = await response.text();
      assert.match(script, /\{ name: 'QwenPaw', value: 'qwenpaw' \}/, `${route.name} (${platform}) should offer QwenPaw`);
      assert.doesNotMatch(script, /QwenPaw \(QwenPaw\)/, `${route.name} (${platform}) should not duplicate the QwenPaw name`);
      assert.match(script, /INSTALL_QWENPAW/, `${route.name} (${platform}) should define the QwenPaw install flag`);
      assert.match(script, /api\/ingest\/setup\/qwenpaw-collector/, `${route.name} (${platform}) should download the bundled QwenPaw collector`);
      assert.match(script, /pip install --disable-pip-version-check --upgrade/, `${route.name} (${platform}) should install the bundled QwenPaw package`);
      assert.match(script, /qwenpaw_insight\.cli install/, `${route.name} (${platform}) should install the QwenPaw collector`);
      assert.match(script, /loaded by QwenPaw hooks/, `${route.name} (${platform}) should describe hook-based plugin loading`);
      const componentsMarker = platform === 'unix'
        ? 'echo "Installed Components:"'
        : 'Write-Host "Installed Components:"';
      assert.ok(
        script.indexOf(componentsMarker) < script.indexOf('QwenPaw Collector: bundled hook plugin'),
        `${route.name} (${platform}) should keep the QwenPaw summary in its own components block`,
      );
    }
  }
});

test('QwenPaw setup endpoint serves a pip-installable collector archive', async () => {
  const response = await getQwenPawCollectorArchive();
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
  assert.ok(entries.includes('qwenpaw_insight/__init__.py'));
  assert.ok(entries.includes('qwenpaw_insight/_plugin_assets/plugin.json'));
  assert.ok(entries.includes('qwenpaw_insight/_plugin_assets/backend.py'));
  assert.ok(!entries.some((name) => name.includes('__pycache__') || name.endsWith('.pyc')));
  assert.ok(!entries.some((name) => name.startsWith('build/') || name.startsWith('dist/')));

  assert.match(archive.readAsText('plugin.json'), /"version": "1\.0\.0"/);
  assert.match(archive.readAsText('qwenpaw_insight/_plugin_assets/plugin.json'), /"version": "1\.0\.0"/);
  assert.match(archive.readAsText('pyproject.toml'), /version = "1\.0\.0"/);
  assert.match(archive.readAsText('qwenpaw_insight/__init__.py'), /__version__ = "1\.0\.0"/);
  assert.match(archive.readAsText('qwenpaw_insight/collector.py'), /COLLECTOR_VERSION = "1\.0\.0"/);
});
