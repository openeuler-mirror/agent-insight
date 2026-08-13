import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const client = require_('../scripts/reliability-client.js') as {
  buildCollectorArgs: (
    run: Record<string, unknown>,
    workspace: string,
    artifactsDir: string,
  ) => string[]
  readCollectResult: (artifactsDir: string, runId: string) => unknown
  configTargetPath: (
    platform: string,
    scope: string,
    correlation?: Record<string, unknown>,
  ) => string
  atomicWriteJson: (target: string, data: unknown) => void
  WHITELIST: Set<string>
  CONFIG_FORBIDDEN: string[]
  RUN_FORBIDDEN: string[]
  buildFiInventory: (
    cfg: Record<string, unknown>,
    opts?: { refresh?: boolean },
  ) => { platforms: Record<string, { ready: boolean; note?: string; agents: unknown[]; models: unknown[] }>; reportedIp?: string }
  buildCapabilities: (
    cfg: Record<string, unknown>,
    opts?: { refresh?: boolean },
  ) => { faultInjection: { ready: boolean; note?: string } }
  normalizeModelIds: (models: unknown) => string[]
  controlUrls: (cfg: Record<string, unknown>) => { websocketUrl: string; pollUrl: string }
  rasRuntimeConfigPath: () => string
  writeRasRuntimeConfig: (snapshot: Record<string, unknown>) => Promise<void>
}
const installer = require_('../scripts/install-ras-client.js') as {
  parseArgs: (argv: string[]) => Record<string, unknown>
  SERVICE_NAME: string
  LAUNCHD_LABEL: string
}

test('client whitelist matches the server-side action set', () => {
  assert.deepEqual(
    [...client.WHITELIST].sort(),
    ['APPLY_CLIENT_CONFIG', 'PREPARE_EXPERIMENT_CASE', 'REFRESH_CAPABILITIES', 'RUN_EXPERIMENT_CASE'],
  )
  // 客户端自带一份禁字段表，不能只依赖服务端校验。
  for (const key of ['url', 'config', 'path']) {
    assert.ok(client.CONFIG_FORBIDDEN.includes(key), `${key} missing from CONFIG_FORBIDDEN`)
  }
  for (const key of ['command', 'shell', 'args', 'cwd', 'executable']) {
    assert.ok(client.RUN_FORBIDDEN.includes(key), `${key} missing from RUN_FORBIDDEN`)
  }
})

test('config target path is derived locally and never taken from the server', () => {
  const clientPath = client.configTargetPath('opencode', 'client')
  assert.ok(clientPath.endsWith(path.join('ras', 'opencode', 'client-config.json')))
  assert.ok(clientPath.startsWith(os.homedir()))

  const expPath = client.configTargetPath('opencode', 'experiment', { caseRunId: 'case_run_01' })
  assert.ok(expPath.includes(path.join('ras', 'opencode', 'experiments')))
  assert.ok(expPath.endsWith('case_run_01.json'))

  // 路径穿越必须被清洗掉，否则实验 correlation 就成了任意写入口。
  const evil = client.configTargetPath('opencode', 'experiment', {
    caseRunId: '../../../../etc/passwd',
  })
  assert.ok(!evil.includes('..'))
  assert.ok(evil.includes(path.join('ras', 'opencode', 'experiments')))
})

test('atomic write leaves no partial file and overwrites cleanly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-atomic-'))
  try {
    const target = path.join(dir, 'nested', 'client-config.json')
    client.atomicWriteJson(target, { configVersion: 'cfg_1', enabled: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
      configVersion: 'cfg_1',
      enabled: true,
    })

    client.atomicWriteJson(target, { configVersion: 'cfg_2', enabled: false })
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).configVersion, 'cfg_2')

    // 不留临时文件——RAS 只应看到完整 JSON。
    const leftovers = fs.readdirSync(path.dirname(target)).filter((f) => f.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('collector args carry no shell string', () => {
  const args = client.buildCollectorArgs(
    {
      platform: 'opencode',
      agent: 'build',
      fault: 'model_timeout',
      prompt: 'do it; rm -rf /',
      runId: 'ras-1',
      model: 'qwen3-32b',
      timeoutSeconds: 60,
    },
    '/tmp/ws',
    '/tmp/artifacts',
  )
  assert.equal(args[0], '-m')
  assert.equal(args[1], 'agent_fault_injection.cli')
  assert.equal(args[2], 'run')
  // prompt 作为独立 argv 元素传递，不拼进 shell 字符串。
  const promptIdx = args.indexOf('--prompt')
  assert.ok(promptIdx > 0)
  assert.equal(args[promptIdx + 1], 'do it; rm -rf /')
  assert.ok(args.includes('--model'))
  assert.ok(args.includes('--timeout-seconds'))
})

test('readCollectResult finds the nested artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-artifacts-'))
  try {
    const runDir = path.join(dir, 'ras-2', 'session-abc')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      path.join(runDir, 'collect-result.json'),
      JSON.stringify({ interactions: [{ ok: true }] }),
    )
    const result = client.readCollectResult(dir, 'ras-2') as { interactions: unknown[] }
    assert.equal(result.interactions.length, 1)

    assert.throws(() => client.readCollectResult(dir, 'ras-missing'), /artifact dir missing/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('installer arg parsing', () => {
  const args = installer.parseArgs(['--host', 'https://x.test', '--token', 'rit_1', '--no-start'])
  assert.equal(args.host, 'https://x.test')
  assert.equal(args.token, 'rit_1')
  assert.equal(args.start, false)

  assert.equal(installer.parseArgs(['--status']).status, true)
  assert.equal(installer.parseArgs(['--uninstall']).uninstall, true)
  // 默认启动服务
  assert.equal(installer.parseArgs(['--host', 'h', '--token', 't']).start, true)
})

// ---------------------------------------------------------------- FI 桥接

test('FI inventory keeps both platforms even when components are missing', () => {
  // 缺 Python 时仍必须上报 —— 否则实验页会把「装了但没装 Python」显示成「没装客户端」。
  const inv = client.buildFiInventory(
    { fiPackageRoot: '/definitely/not/here', maxParallelFi: 5 },
    { refresh: true },
  )
  assert.ok(inv.platforms.opencode, 'opencode entry must exist')
  assert.ok(inv.platforms.xiaoo, 'xiaoo entry must exist')
  assert.equal(inv.platforms.opencode.ready, false)
  assert.ok(String(inv.platforms.opencode.note || '').length > 0, 'note explains why not ready')
  assert.ok(Array.isArray(inv.platforms.opencode.agents))
  assert.ok(Array.isArray(inv.platforms.opencode.models))
})

test('capabilities and FI inventory agree on readiness', () => {
  const cfg = { fiPackageRoot: '/definitely/not/here', maxParallelFi: 5 }
  const caps = client.buildCapabilities(cfg, { refresh: true })
  const inv = client.buildFiInventory(cfg)
  // 两份上报必须同源，否则两个页面会各说各话。
  assert.equal(caps.faultInjection.ready, false)
  assert.equal(inv.platforms.opencode.ready, false)
  assert.equal(caps.faultInjection.note, inv.platforms.opencode.note)
})

test('model ids normalize from strings and objects alike', () => {
  assert.deepEqual(
    client.normalizeModelIds(['qwen3-32b', { id: 'deepseek-v3' }, { name: 'glm-4' }, '', null]),
    ['qwen3-32b', 'deepseek-v3', 'glm-4'],
  )
  assert.deepEqual(client.normalizeModelIds(undefined), [])
})

test('installer defaults to installing FI, and --no-fi opts out', () => {
  assert.equal(installer.parseArgs(['--host', 'h', '--token', 't']).withFi, true)
  assert.equal(installer.parseArgs(['--host', 'h', '--token', 't', '--no-fi']).withFi, false)
  assert.equal(installer.parseArgs(['--with-fi']).withFi, true)
})

// ------------------------------------------------- start.sh（无 WSS）部署路径

test('control urls follow the current base, not the stale registered value', () => {
  // 服务端换端口后，注册时写死的地址会指向旧实例 —— 必须以 base 重算。
  const urls = client.controlUrls({
    insightBaseUrl: 'http://insight.example:3000',
    websocketUrl: 'ws://127.0.0.1:3117/api/reliability/client/v1/control',
    pollUrl: 'http://127.0.0.1:3117/api/reliability/client/v1/commands/next',
  })
  assert.equal(urls.websocketUrl, 'ws://insight.example:3000/api/reliability/client/v1/control')
  assert.equal(urls.pollUrl, 'http://insight.example:3000/api/reliability/client/v1/commands/next')
})

test('https base maps to wss', () => {
  assert.equal(
    client.controlUrls({ insightBaseUrl: 'https://insight.example' }).websocketUrl,
    'wss://insight.example/api/reliability/client/v1/control',
  )
})

test('client writes the config.json that RAS actually reads', async () => {
  const rasHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-home-'))
  const prev = process.env.AGENT_INSIGHT_RAS_HOME
  process.env.AGENT_INSIGHT_RAS_HOME = rasHome
  try {
    // 预置一份 RAS 既有配置：合并不能把它抹掉。
    const target = path.join(rasHome, 'config.json')
    fs.writeFileSync(target, JSON.stringify({ python: '/usr/bin/python3', agent_ras: { enabled: false } }))

    await client.writeRasRuntimeConfig({
      platform: 'opencode',
      scope: 'client',
      config: {
        capability: {
          enabled: true,
          detectors: {
            llm_thinking_loop: { enabled: true, detection_start_chars: 300 },
            repeat_tool: { enabled: false, warning_threshold: 5 },
          },
          recovery: { notify_user_on_warning: false },
        },
      },
    })

    const written = JSON.parse(fs.readFileSync(target, 'utf8'))
    assert.equal(written.python, '/usr/bin/python3', 'RAS 既有字段必须保留')
    assert.equal(written.agent_ras.enabled, true, '能力段被下发值覆盖')
    assert.ok(written.agent_ras.platforms.opencode, '按平台分片写入')
  } finally {
    if (prev === undefined) delete process.env.AGENT_INSIGHT_RAS_HOME
    else process.env.AGENT_INSIGHT_RAS_HOME = prev
    fs.rmSync(rasHome, { recursive: true, force: true })
  }
})
