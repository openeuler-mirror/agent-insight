import test from 'node:test';
import assert from 'node:assert/strict';

import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';

const routes: { name: string; get: (request: Request) => Promise<Response>; url: string }[] = [
  {
    name: 'setup',
    get: getSetup,
    url: 'http://localhost/api/ingest/setup?key=test-key',
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
      assert.match(script, /agent-insight-copaw install/, `${route.name} (${platform}) should install the CoPaw collector`);
      assert.match(script, /import copaw; copaw\.setup\(\)/, `${route.name} (${platform}) should use the short CoPaw module name`);
      const componentsMarker = platform === 'unix'
        ? 'echo "Installed Components:"'
        : 'Write-Host "Installed Components:"';
      assert.ok(
        script.indexOf(componentsMarker) < script.indexOf('CoPaw (QwenPaw) Collector: pip package'),
        `${route.name} (${platform}) should keep the CoPaw summary in its own components block`,
      );
    }
  }
});
