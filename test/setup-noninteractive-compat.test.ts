import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { GET } from '@/app/api/ingest/setup/route';

const ALL_FRAMEWORKS = 'opencode,openclaw,claude,codeagent,hermes,jiuwen,qwencode';

async function getScript(query: string, platform: 'unix' | 'windows'): Promise<string> {
  const response = await GET(new Request(`http://localhost/api/ingest/setup?${query}`, {
    headers: { 'x-platform': platform, host: 'localhost:3000' },
  }));
  assert.equal(response.status, 200);
  return response.text();
}

test('Bash 恢复 URL、CLI 和环境变量非交互入口，并保留全部框架', async () => {
  const script = await getScript(`yes=1&nokey=1&frameworks=${ALL_FRAMEWORKS}`, 'unix');

  assert.match(script, /^NONINTERACTIVE=true$/m);
  assert.match(script, /^NONINTERACTIVE_FRAMEWORKS="opencode,openclaw,claude,codeagent,hermes,jiuwen,qwencode"$/m);
  assert.match(script, /^FORCE_NO_KEY=true$/m);
  assert.match(script, /-y\|--yes\|--non-interactive\|--noninteractive\) NONINTERACTIVE=true/);
  assert.match(script, /--no-key\|--nokey\) FORCE_NO_KEY=true/);
  assert.match(script, /--frameworks=\*\) NONINTERACTIVE=true; NONINTERACTIVE_FRAMEWORKS=/);
  assert.match(script, /AGENT_INSIGHT_NONINTERACTIVE/);
  assert.match(script, /AGENT_INSIGHT_FRAMEWORKS/);
  assert.match(script, /AGENT_INSIGHT_NO_KEY/);
  assert.match(script, /if \[ "\$FORCE_NO_KEY" = "true" \]; then/);
  assert.match(script, /if \[ "\$NONINTERACTIVE" = "true" \]; then/);

  for (const flag of ['OPENCODE', 'OPENCLAW', 'CLAUDE', 'CODEAGENT', 'HERMES', 'JIUWEN', 'QWENCODE']) {
    assert.match(script, new RegExp(`INSTALL_${flag}=true`));
  }
});

test('PowerShell 恢复 URL 与环境变量非交互入口并可强制清空 key', async () => {
  const script = await getScript(`noninteractive=true&no-key=true&frameworks=${ALL_FRAMEWORKS}`, 'windows');

  assert.match(script, /^\$NONINTERACTIVE = \$true$/m);
  assert.match(script, /^\$NONINTERACTIVE_FRAMEWORKS = "opencode,openclaw,claude,codeagent,hermes,jiuwen,qwencode"$/m);
  assert.match(script, /^\$FORCE_NO_KEY = \$true$/m);
  assert.match(script, /\$env:AGENT_INSIGHT_NONINTERACTIVE/);
  assert.match(script, /\$env:AGENT_INSIGHT_FRAMEWORKS/);
  assert.match(script, /\$env:AGENT_INSIGHT_NO_KEY/);
  assert.match(script, /if \(\$FORCE_NO_KEY\) \{/);
  assert.match(script, /if \(\$NONINTERACTIVE\) \{/);

  for (const flag of ['OPENCODE', 'OPENCLAW', 'CLAUDE', 'CODEAGENT', 'HERMES', 'JIUWEN', 'QWENCODE']) {
    assert.match(script, new RegExp(`\\$INSTALL_${flag} = \\$true`));
  }
});

test('false/no/0 不会误开启非交互或无 key 模式，framework 单数别名仍可用', async () => {
  const script = await getScript('y=0&nokey=no&framework=claude', 'unix');
  assert.match(script, /^NONINTERACTIVE=false$/m);
  assert.match(script, /^FORCE_NO_KEY=false$/m);
  assert.match(script, /^SELECTED_FRAMEWORKS="claude"$/m);
});

test('安装页只在已选框架时生成 yes=1 的全程非交互命令', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../src/app/(main)/accessconfig/install/page.tsx'), 'utf8');
  assert.match(page, /frameworks\.length \? `yes=1` : ''/);
});

test('OpenClaw 纯配置输出与已安装 wrapper 使用相同的 JSON logs/traces 端点', async () => {
  for (const platform of ['unix', 'windows'] as const) {
    const script = await getScript('yes=1&frameworks=openclaw', platform);
    const start = script.indexOf('OpenClaw OTel --');
    const end = script.indexOf('OTel 纯配置方式 与 Watcher 模式互斥', start);
    assert.ok(start >= 0 && end > start, `${platform} should print the OpenClaw config block`);
    const configBlock = script.slice(start, end);

    assert.match(configBlock, /OTEL_EXPORTER_OTLP_LOGS_PROTOCOL[^\n]*http\/json/);
    assert.match(configBlock, /OTEL_EXPORTER_OTLP_LOGS_ENDPOINT[^\n]*\/api\/ingest\/otel\/v1\/logs/);
    assert.match(configBlock, /OTEL_EXPORTER_OTLP_TRACES_PROTOCOL[^\n]*http\/json/);
    assert.match(configBlock, /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT[^\n]*\/api\/ingest\/otel\/v1\/traces/);
    assert.doesNotMatch(configBlock, /http\/protobuf/);
  }
});
