import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';

const FRAMEWORK = 'deepseek-harness';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

async function setupScript(platform: 'unix' | 'windows'): Promise<string> {
  const response = await getSetup(new Request(
    `https://insight.example/api/ingest/setup?yes=1&frameworks=${FRAMEWORK}&key=test-key`,
    {
      headers: {
        host: 'insight.example',
        'x-forwarded-proto': 'https',
        'x-platform': platform,
      },
    },
  ));
  assert.equal(response.status, 200);
  return response.text();
}

async function autoSetupScript(platform: 'unix' | 'windows'): Promise<string> {
  const response = await getAutoSetup(new Request(
    `https://insight.example/api/setup/auto?frameworks=${FRAMEWORK}&apiKey=test-key&host=insight.example`,
    {
      headers: {
        host: 'insight.example',
        'x-forwarded-proto': 'https',
        'x-platform': platform,
      },
    },
  ));
  assert.equal(response.status, 200);
  return response.text();
}

test('unified install surfaces DeepSeek Harness in the page and both server allowlists', () => {
  for (const relativePath of [
    'src/app/(main)/accessconfig/install/page.tsx',
    'src/app/api/ingest/setup/route.ts',
    'src/app/api/ingest/setup/auto/route.ts',
  ]) {
    assert.match(read(relativePath), /value:\s*['"]deepseek-harness['"],\s*label:\s*['"]DeepSeek Harness['"]/);
  }
});

test('Unix unified installers delegate DeepSeek Harness setup without putting the API key in a URL', async () => {
  for (const script of [await setupScript('unix'), await autoSetupScript('unix')]) {
    assert.match(script, /^\s*INSTALL_DEEPSEEK_HARNESS=true$/m);
    assert.match(script, /api\/ingest\/setup\/deepseek-harness/);
    assert.match(script, /AGENT_INSIGHT_API_KEY="\$(?:FINAL_KEY|AGENT_INSIGHT_API_KEY)"/);
    assert.match(script, /DEEPSEEK_HARNESS_SETUP_OK=true/);
    assert.match(script, /DeepSeek Harness observability/);
    assert.doesNotMatch(script, /deepseek-harness[^\n]*test-key/);

    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
  }
});

test('Windows unified installers recognize DeepSeek Harness but report the current support boundary', async () => {
  for (const script of [await setupScript('windows'), await autoSetupScript('windows')]) {
    assert.match(script, /^\s*\$INSTALL_DEEPSEEK_HARNESS = \$true$/m);
    assert.match(script, /DeepSeek Harness observability is currently supported on macOS\/Linux\. Use WSL on Windows\./);
    assert.doesNotMatch(script, /✅ DeepSeek Harness observability/);
  }
});
