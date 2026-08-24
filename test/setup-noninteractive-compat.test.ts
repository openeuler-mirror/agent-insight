import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { GET } from '@/app/api/ingest/setup/route';
import { prismaRaw } from '@/lib/storage/prisma';

const ALL_FRAMEWORKS = 'opencode,openclaw,claude,codeagent,hermes,jiuwen,qoder,trae,actrail,qwencode,deepseek-harness';

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
  assert.ok(script.includes(`NONINTERACTIVE_FRAMEWORKS="${ALL_FRAMEWORKS}"`));
  assert.match(script, /^FORCE_NO_KEY=true$/m);
  assert.match(script, /-y\|--yes\|--non-interactive\|--noninteractive\) NONINTERACTIVE=true/);
  assert.match(script, /--no-key\|--nokey\) FORCE_NO_KEY=true/);
  assert.match(script, /--frameworks=\*\) NONINTERACTIVE=true; NONINTERACTIVE_FRAMEWORKS=/);
  assert.match(script, /AGENT_INSIGHT_NONINTERACTIVE/);
  assert.match(script, /AGENT_INSIGHT_FRAMEWORKS/);
  assert.match(script, /AGENT_INSIGHT_NO_KEY/);
  assert.match(script, /if \[ "\$FORCE_NO_KEY" = "true" \]; then/);
  assert.match(script, /if \[ "\$NONINTERACTIVE" = "true" \]; then/);

  for (const flag of ['OPENCODE', 'OPENCLAW', 'CLAUDE', 'CODEAGENT', 'HERMES', 'JIUWEN', 'QODER', 'TRAE', 'ACTRAIL', 'QWENCODE', 'DEEPSEEK_HARNESS']) {
    assert.match(script, new RegExp(`INSTALL_${flag}=true`));
  }
});

test('PowerShell 恢复 URL 与环境变量非交互入口并可强制清空 key', async () => {
  const script = await getScript(`noninteractive=true&no-key=true&frameworks=${ALL_FRAMEWORKS}`, 'windows');

  assert.match(script, /^\$NONINTERACTIVE = \$true$/m);
  assert.ok(script.includes(`$NONINTERACTIVE_FRAMEWORKS = "${ALL_FRAMEWORKS}"`));
  assert.match(script, /^\$FORCE_NO_KEY = \$true$/m);
  assert.match(script, /\$env:AGENT_INSIGHT_NONINTERACTIVE/);
  assert.match(script, /\$env:AGENT_INSIGHT_FRAMEWORKS/);
  assert.match(script, /\$env:AGENT_INSIGHT_NO_KEY/);
  assert.match(script, /if \(\$FORCE_NO_KEY\) \{/);
  assert.match(script, /if \(\$NONINTERACTIVE\) \{/);

  for (const flag of ['OPENCODE', 'OPENCLAW', 'CLAUDE', 'CODEAGENT', 'HERMES', 'JIUWEN', 'QODER', 'TRAE', 'ACTRAIL', 'QWENCODE', 'DEEPSEEK_HARNESS']) {
    assert.match(script, new RegExp(`\\$INSTALL_${flag} = \\$true`));
  }
});

test('false/no/0 不会误开启非交互或无 key 模式，framework 单数别名仍可用', async () => {
  const script = await getScript('y=0&nokey=no&framework=claude', 'unix');
  assert.match(script, /^NONINTERACTIVE=false$/m);
  assert.match(script, /^FORCE_NO_KEY=false$/m);
  assert.match(script, /^SELECTED_FRAMEWORKS="claude"$/m);
});

test('常驻客户端默认使用服务端 bundle，本地 checkout 只能显式启用', async () => {
  const script = await getScript('yes=1&frameworks=opencode', 'unix');
  const start = script.indexOf('install_agent_insight_client() {');
  const end = script.indexOf('echo "🖥️  Registering resident client..."', start);
  assert.ok(start >= 0 && end > start);
  const clientBlock = script.slice(start, end);

  assert.match(clientBlock, /if \[ "\$\{AGENT_INSIGHT_CLIENT_SOURCE:-server\}" = "local" \]; then/);
  assert.match(clientBlock, /if \[ ! -f "\.\/scripts\/install-ras-client\.js" \]; then/);
  assert.doesNotMatch(clientBlock, /if \[ -f "\.\/scripts\/install-ras-client\.js" \]; then/);
  assert.ok(
    clientBlock.indexOf('/api/ingest/setup/bundle?name=client') < clientBlock.indexOf('npm pack'),
    '服务端 bundle 应先于 npm 兜底',
  );
});

test('安装页为已选框架生成 yes=1，并单独保留 LlamaIndex Python 选择', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../src/app/(main)/accessconfig/install/page.tsx'), 'utf8');
  assert.match(page, /frameworks\.length \? `yes=1` : ''/);
  assert.match(page, /frameworks\.includes\('llamaindex'\) \? 'llamaindexPromptPython=1' : ''/);
  assert.match(page, /apiKey, authReady/);
  assert.match(page, /if \(!authReady \|\| !apiKey\)/);
  assert.doesNotMatch(page, /localStorage/);
});

test('历史浏览器登录态会刷新服务端 API Key，安装脚本拒绝无效 Key', async () => {
  const auth = fs.readFileSync(path.resolve(__dirname, '../src/lib/auth/auth-context.tsx'), 'utf8');
  assert.match(auth, /apiFetch\('\/api\/auth\/apikey'/);
  assert.match(auth, /localStorage\.setItem\('api_key', nextApiKey\)/);
  assert.match(auth, /authReady/);

  const username = `setup-auth-${process.pid}-${Date.now()}`;
  const apiKey = `wi_setup_auth_${process.pid}_${Date.now()}`;
  try {
    await prismaRaw.user.create({ data: { username, apiKey } });

    const accepted = await GET(new Request(
      `http://localhost/api/ingest/setup?yes=1&frameworks=opencode&key=${encodeURIComponent(apiKey)}`,
      { headers: { host: 'localhost:3000', 'x-platform': 'unix' } },
    ));
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');

    const rejected = await GET(new Request(
      'http://localhost/api/ingest/setup?yes=1&frameworks=opencode&key=wi_stale_key',
      { headers: { host: 'localhost:3000', 'x-platform': 'unix' } },
    ));
    assert.equal(rejected.status, 401);
    assert.match(await rejected.text(), /Invalid API key/);
  } finally {
    await prismaRaw.user.deleteMany({ where: { username } });
  }
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
