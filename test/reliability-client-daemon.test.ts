import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const client = require_('../scripts/reliability-client.cjs') as {
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
  ) => {
    platforms: Array<{
      id: string
      agents: string[]
      runExperimentCase?: { version: number; returnsTraceId: boolean }
    }>
    faultInjection: { ready: boolean; note?: string }
  }
  buildExperimentCaseInvocation: (
    executable: string,
    input: {
      platform: string
      agent: string
      model: string | null
      input: string
      correlation?: Record<string, unknown>
    },
  ) => { args: string[]; stdin: string | null }
  parseOpencodeSlashCommand: (input: string) => { command: string; arguments: string } | null
  capabilityDiscoveryFingerprint: () => string
  refreshCapabilityReports: (
    cfg: Record<string, unknown>,
    opts?: { force?: boolean },
  ) => Promise<boolean>
  normalizeModelIds: (models: unknown) => string[]
  extractTraceIdFromJsonLine: (line: string) => string | null
  controlUrls: (cfg: Record<string, unknown>) => { websocketUrl: string; pollUrl: string }
  rasRuntimeConfigPath: () => string
  writeRasRuntimeConfig: (snapshot: Record<string, unknown>) => Promise<void>
  sdNotify: (payload: string) => boolean
  notifyReady: () => boolean
  notifyWatchdog: () => boolean
  WATCHDOG_MS: number
  CAPABILITY_DISCOVERY_SCAN_MS: number
}
const installer = require_('../scripts/install-ras-client.js') as {
  CLIENT_SCRIPT: string
  RUNTIME_DIR: string
  installRuntime?: () => void
  buildSystemdUnit?: () => string
  writeSystemdUnit: () => string
  writeLaunchdPlist?: () => string
  bootstrapLaunchdService?: (
    plistPath: string,
    options: {
      uid: number
      runner: (command: string, args: string[], options: Record<string, unknown>) => {
        status: number | null
        stdout?: string
        stderr?: string
      }
      wait: (ms: number) => void
    },
  ) => { ok: boolean; uid: number; detail?: string }
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
  assert.equal(args[0], '-I')
  assert.equal(args[1], '-m')
  assert.equal(args[2], 'agent_fault_injection.cli')
  assert.equal(args[3], 'run')
  // prompt 作为独立 argv 元素传递，不拼进 shell 字符串。
  const promptIdx = args.indexOf('--prompt')
  assert.ok(promptIdx > 0)
  assert.equal(args[promptIdx + 1], 'do it; rm -rf /')
  assert.ok(args.includes('--model'))
  assert.ok(args.includes('--timeout-seconds'))
})

test('OpenCode slash-command input uses the native command path without adding wrapper quotes', () => {
  const input = '/aet-design https://example.com/PRD.md\n第二行  保留连续空格和 "原生引号"'
  const invocation = client.buildExperimentCaseInvocation('/usr/local/bin/opencode', {
    platform: 'opencode',
    agent: 'aet-design',
    model: 'provider/model',
    input,
    correlation: { caseRunId: 'case-1' },
  })

  assert.equal(invocation.stdin, null)
  assert.deepEqual(invocation.args.filter((arg) => arg !== '--auto'), [
    'run',
    '--format',
    'json',
    '--agent',
    'aet-design',
    '--title',
    'case-1',
    '--model',
    'provider/model',
    '--command',
    'aet-design',
    'https://example.com/PRD.md\n第二行  保留连续空格和 "原生引号"',
  ])
  assert.ok(!invocation.args.includes(input))
})

test('ordinary OpenCode input is still piped verbatim through stdin', () => {
  const input = '普通输入\n第二行  保留连续空格和 "原生引号"'
  const invocation = client.buildExperimentCaseInvocation('/usr/local/bin/opencode', {
    platform: 'opencode',
    agent: 'build',
    model: null,
    input,
  })

  assert.equal(invocation.stdin, input)
  assert.ok(!invocation.args.includes('--command'))
  assert.ok(!invocation.args.includes(input))
})

test('OpenCode slash-command parser only accepts a command at the start of the input', () => {
  assert.deepEqual(client.parseOpencodeSlashCommand('/aet-design  keep spacing'), {
    command: 'aet-design',
    arguments: ' keep spacing',
  })
  assert.equal(client.parseOpencodeSlashCommand('请执行 /aet-design task'), null)
  assert.equal(client.parseOpencodeSlashCommand('/'), null)
})

test('non-OpenCode experiment input keeps the existing positional argument path', () => {
  const input = 'ordinary agent input'
  const invocation = client.buildExperimentCaseInvocation('/usr/local/bin/other-agent', {
    platform: 'other-agent',
    agent: 'build',
    model: null,
    input,
  })

  assert.equal(invocation.stdin, null)
  assert.equal(invocation.args.at(-1), input)
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

test('OpenCode capability fingerprint follows plugin target changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-capabilities-'))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = root
  try {
    const configRoot = path.join(root, 'opencode')
    const plugins = path.join(configRoot, 'plugins')
    const pluginTarget = path.join(root, 'dynamic-plugin.js')
    fs.mkdirSync(plugins, { recursive: true })
    fs.writeFileSync(path.join(configRoot, 'opencode.json'), JSON.stringify({ plugin: ['./plugins/aet.js'] }))
    fs.writeFileSync(pluginTarget, 'export default 1')
    fs.symlinkSync(pluginTarget, path.join(plugins, 'aet.js'))

    const before = client.capabilityDiscoveryFingerprint()
    fs.writeFileSync(pluginTarget, 'export default 22')
    const after = client.capabilityDiscoveryFingerprint()
    assert.notEqual(after, before)
    assert.equal(client.CAPABILITY_DISCOVERY_SCAN_MS, 30_000)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('manual and automatic capability refresh bypass the cached probe', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts/reliability-client.cjs'),
    'utf8',
  )
  assert.match(source, /REFRESH_CAPABILITIES[\s\S]*?refreshCapabilityReports\(cfg, \{ force: true \}\)/)
  assert.match(source, /cachedProbe = await probeFaultInjectionIsolated\(cfg\)[\s\S]*?reportCapabilities\(cfg\)/)
  assert.match(source, /const refreshCapabilities[\s\S]*?refreshCapabilityReports\(cfg, \{ force: true \}\)/)
  assert.match(source, /setTimeout\([\s\S]*?setInterval\(refreshCapabilities, CAPABILITY_DISCOVERY_SCAN_MS\)[\s\S]*?CAPABILITY_DISCOVERY_SCAN_MS \/ 2/)
})

test('capability probe runs outside the daemon event loop', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts/reliability-client.cjs'),
    'utf8',
  )
  assert.match(source, /function probeFaultInjectionIsolated[\s\S]*?spawn\(process\.execPath, \[__filename, FI_PROBE_CHILD_ARG\]/)
  assert.match(source, /initialCapabilityRefresh\.then\(\(\) => fiLoop\(cfg\)\)/)
  assert.match(source, /process\.argv\.includes\(FI_PROBE_CHILD_ARG\)[\s\S]*?probeFaultInjection\(cfg\)/)
})

test('FI inventory uses an isolated launchd helper with aligned PWD on macOS', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts/reliability-client.cjs'),
    'utf8',
  )
  assert.match(
    source,
    /function runFiInventory[\s\S]*?process\.platform !== 'darwin'[\s\S]*?'launchctl'[\s\S]*?'submit'[\s\S]*?`PWD=\$\{cwd\}`[\s\S]*?'remove', label/,
  )
})

test('OpenCode JSON events expose the platform Trace ID', () => {
  assert.equal(
    client.extractTraceIdFromJsonLine(JSON.stringify({
      type: 'step_start',
      sessionID: 'ses_trace_01',
      part: { id: 'part_01' },
    })),
    'ses_trace_01',
  )
  assert.equal(client.extractTraceIdFromJsonLine('not-json'), null)
})

test('generic execution reports Trace ID before exit and force-kills timed-out process groups', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts/reliability-client.cjs'),
    'utf8',
  )
  assert.match(source, /state: 'TRACE_STARTED', traceId, startedAt/)
  assert.match(source, /detached: process\.platform !== 'win32'/)
  assert.match(source, /signalProcessTree\(child, 'SIGTERM'\)/)
  assert.match(source, /signalProcessTree\(child, 'SIGKILL'\)/)
  assert.match(source, /if \(reliabilityChild\) signalProcessTree\(reliabilityChild, 'SIGKILL'\)/)
})

test('client advertises Trace-ID-safe generic execution only for supported platforms', () => {
  const caps = client.buildCapabilities(
    { fiPackageRoot: '/definitely/not/here', maxParallelFi: 5 },
    { refresh: true },
  )
  const opencode = caps.platforms.find((platform) => platform.id === 'opencode')
  const xiaoo = caps.platforms.find((platform) => platform.id === 'xiaoo')
  assert.deepEqual(opencode?.runExperimentCase, { version: 2, returnsTraceId: true })
  assert.equal(xiaoo?.runExperimentCase?.returnsTraceId, false)
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

test('systemd unit preserves the installer PATH and keeps service directives valid', () => {
  assert.equal(typeof installer.buildSystemdUnit, 'function')
  assert.match(String(installer.writeSystemdUnit), /buildSystemdUnit\(\)/)
  const previousPath = process.env.PATH
  process.env.PATH = '/home/alice/.opencode/bin:/opt/Agent Tools/bin:/tmp/%h/"quoted"/\\'
  try {
    const unit = installer.buildSystemdUnit?.() || ''
    assert.match(
      unit,
      /^\[Unit\][\s\S]*StartLimitIntervalSec=300[\s\S]*StartLimitBurst=5[\s\S]*\[Service\]/m,
    )
    assert.match(unit, /Type=notify/)
    assert.match(unit, /WatchdogSec=30s/)
    assert.ok(
      unit.includes(
        'Environment="PATH=/home/alice/.opencode/bin:/opt/Agent Tools/bin:/tmp/%%h/\\"quoted\\"/\\\\"',
      ),
      'systemd PATH 必须保留用户级 Agent 目录并安全转义',
    )
    assert.doesNotMatch(
      unit,
      /\[Service\][\s\S]*StartLimitIntervalSec/,
      'StartLimit* 不得写在 [Service]',
    )
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})

test('sd_notify READY precedes capabilities and watchdog is faster than WatchdogSec/2', () => {
  assert.equal(typeof client.sdNotify, 'function')
  assert.equal(typeof client.notifyReady, 'function')
  assert.equal(typeof client.notifyWatchdog, 'function')
  assert.ok(client.WATCHDOG_MS > 0 && client.WATCHDOG_MS <= 15_000)

  const prev = process.env.NOTIFY_SOCKET
  delete process.env.NOTIFY_SOCKET
  try {
    assert.equal(client.sdNotify('READY=1'), false)
  } finally {
    if (prev === undefined) delete process.env.NOTIFY_SOCKET
    else process.env.NOTIFY_SOCKET = prev
  }

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'reliability-client.cjs'),
    'utf8',
  )
  const mainBody = /async function main\(\) \{[\s\S]*?\n\}/.exec(src)?.[0] || ''
  assert.match(mainBody, /notifyReady\(\)/)
  assert.match(mainBody, /setInterval\(notifyWatchdog,\s*WATCHDOG_MS\)/)
  const readyAt = mainBody.indexOf('notifyReady()')
  const capsAt = mainBody.indexOf('refreshCapabilityReports(')
  assert.ok(readyAt >= 0 && capsAt > readyAt, 'READY 必须早于 reportCapabilities')
  assert.doesNotMatch(mainBody, /await refreshCapabilityReports/)
  // Node dgram 无 unix_dgram；必须经 systemd-notify 且带本进程 pid。
  assert.match(src, /systemd-notify/)
  assert.match(src, /--pid=\$\{process\.pid\}/)
})

test('service points at a stable runtime path, never a temp extraction dir', () => {
  // 安装器可能从服务端制品解压到 /tmp 后执行，装完临时目录即被删除。
  // 若 systemd/launchd 指向那里，服务会以 MODULE_NOT_FOUND 反复崩溃。
  const unit = installer.writeSystemdUnit
    ? String(installer.writeSystemdUnit.toString())
    : ''
  assert.ok(
    !/__dirname/.test(unit) || /RUNTIME_DIR|CLIENT_SCRIPT/.test(unit),
    'unit 必须引用固化路径',
  )
  // CLIENT_SCRIPT 应位于 ~/.agent-insight/client/runtime 下，而非包目录或临时目录。
  const script = installer.CLIENT_SCRIPT || ''
  assert.match(
    script,
    /\.agent-insight[/\\]client[/\\]runtime[/\\]reliability-client\.cjs$/,
    `服务入口应在稳定目录，实际: ${script}`,
  )
  assert.ok(!/\/(tmp|T)\//.test(script), '服务入口不得位于临时目录')
})

test('launchd service preserves the installer PATH for Agent executables', () => {
  assert.equal(typeof installer.writeLaunchdPlist, 'function')
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'install-ras-client.js'),
    'utf8',
  )
  assert.match(source, /<key>PATH<\/key>/)
  assert.match(source, /function servicePath\(\)[\s\S]*?process\.env\.PATH/)
})

test('launchd bootstrap retries Operation already in progress and verifies the service', () => {
  assert.equal(typeof installer.bootstrapLaunchdService, 'function')
  let removalChecks = 0
  let bootstrapCalls = 0
  let loaded = false
  const waits: number[] = []
  const runner = (_command: string, args: string[]) => {
    const action = args[0]
    if (action === 'bootout') return { status: 0 }
    if (action === 'print') {
      if (loaded) return { status: 0 }
      removalChecks += 1
      return { status: removalChecks <= 2 ? 0 : 1 }
    }
    if (action === 'bootstrap') {
      bootstrapCalls += 1
      if (bootstrapCalls === 1) {
        return { status: 37, stderr: 'Bootstrap failed: 37: Operation already in progress' }
      }
      loaded = true
      return { status: 0 }
    }
    if (action === 'load') return { status: 1, stderr: 'fallback must not run' }
    return { status: 0 }
  }

  const result = installer.bootstrapLaunchdService?.('/tmp/client.plist', {
    uid: 501,
    runner,
    wait: (ms: number) => waits.push(ms),
  })
  assert.equal(result?.ok, true)
  assert.equal(bootstrapCalls, 2)
  assert.ok(waits.length >= 3)
})

test('runtime bundle carries config_sync.js next to the client script', () => {
  // 客户端被固化到 runtime/ 后，__dirname/../agent_ras 不再存在。
  // 若 config_sync.js 没跟着走，写 RAS 运行时配置会静默跳过 ——
  // 页面显示「已写入」，RAS 却永远读到旧值。
  const runtimeDir = installer.RUNTIME_DIR || ''
  assert.match(runtimeDir, /\.agent-insight[/\\]client[/\\]runtime$/)
  const src = installer.installRuntime ? String(installer.installRuntime.toString()) : ''
  assert.match(src, /config_sync\.js/, 'installRuntime 必须固化 config_sync.js')
})

test('server client bundle includes the managed FI runtime helper', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/app/api/ingest/setup/bundle/route.ts'),
    'utf8',
  )
  assert.match(source, /scripts\/lib\/fi-python-runtime\.js/)
})

test('long-poll cadence stays under the server command TTL', () => {
  // 退避只该作用于 WSS 重连。若长轮询夹在重连退避之间，backoff 涨到 60s 上限后
  // 轮询空窗会超过指令 TTL（默认 30s），指令还没被取走就 COMMAND_EXPIRED。
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'reliability-client.cjs'),
    'utf8',
  )
  assert.match(src, /async function pollLoop/, '长轮询必须是独立循环')
  assert.match(src, /pollLoop\(cfg\)/, '必须在 main 里启动')

  // 最坏一轮 = 服务端 long-poll 等待 + 失败重试间隔，须小于 TTL。
  const retryMs = Number(/POLL_RETRY_MS = ([\d_]+)/.exec(src)?.[1]?.replace(/_/g, '') || 0)
  const waitSec = Number(/waitSeconds=(\d+)/.exec(src)?.[1] || 0)
  const ttlSec = 30
  assert.ok(retryMs > 0 && waitSec > 0, '应能解析出轮询参数')
  assert.ok(
    waitSec + retryMs / 1000 < ttlSec,
    `最坏轮询间隔 ${waitSec + retryMs / 1000}s 必须小于指令 TTL ${ttlSec}s`,
  )

  // 退避常量不得出现在轮询循环里，否则又会把两件事耦合回去。
  const pollBody = /async function pollLoop[\s\S]*?\n}/.exec(src)?.[0] || ''
  assert.doesNotMatch(pollBody, /backoff|RECONNECT_MAX_MS/, '轮询不得受重连退避影响')
})
