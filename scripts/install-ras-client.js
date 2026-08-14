#!/usr/bin/env node
/**
 * 统一安装入口：注册常驻客户端服务并交由 systemd / launchd 守护。
 *
 * 用法：
 *   node scripts/install-ras-client.js --host <url> --token <installToken> [--start]
 *   node scripts/install-ras-client.js --status | --uninstall
 *
 * 本期只支持 Linux (systemd user unit) 与 macOS (launchd LaunchAgent)。
 * Windows Service 注册通常需要管理员权限并依赖外部工具，与「不依赖外部下载源」冲突，
 * 因此不在本期范围 —— 在 Windows 上给出明确提示而不是静默降级。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const CLIENT_HOME = path.join(os.homedir(), '.agent-insight', 'client')
const CONFIG_PATH = path.join(CLIENT_HOME, 'config.json')
const PACKAGE_ROOT = path.join(__dirname, '..')
/**
 * 常驻进程的运行位置。
 *
 * **不能**直接用 __dirname：安装器可能是从服务端制品解压到 /tmp 后执行的，
 * 装完临时目录就被删，systemd/launchd 会指向一个不存在的文件而反复崩溃。
 * 因此把运行时拷到这个稳定目录，服务只引用它。
 */
const RUNTIME_DIR = path.join(CLIENT_HOME, 'runtime')
const CLIENT_SCRIPT = path.join(RUNTIME_DIR, 'reliability-client.cjs')

/** 常驻进程自身及其本地依赖 —— 少拷一个都会在启动时 MODULE_NOT_FOUND。 */
const RUNTIME_FILES = ['reliability-client.cjs', 'ws-client.cjs']

function installRuntime() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  for (const name of RUNTIME_FILES) {
    const src = path.join(PACKAGE_ROOT, 'scripts', name)
    if (!fs.existsSync(src)) {
      fail(`缺少运行时文件: ${src}`, '制品不完整；请重新执行安装命令。')
    }
    fs.copyFileSync(src, path.join(RUNTIME_DIR, name))
  }
  // 配置合并要用 OpenCode 插件自己的 config_sync.js（复用它保证两条写入路径
  // 结构一致）。运行时被搬到 RUNTIME_DIR 后相对路径失效，故与主脚本放在一起。
  const syncSrc = path.join(
    PACKAGE_ROOT,
    'agent_ras',
    'platform_adapter',
    'opencode',
    'config_sync.js',
  )
  if (fs.existsSync(syncSrc)) {
    fs.copyFileSync(syncSrc, path.join(RUNTIME_DIR, 'config_sync.js'))
  } else {
    console.warn('[install-ras-client] ⚠ 未找到 config_sync.js，RAS 运行时配置将无法写入')
  }

  // FI 采集要用到 agent_fault_injection 源码；解压目录会被删，故一并固化。
  const fiSrc = path.join(PACKAGE_ROOT, 'agent_fault_injection')
  const fiDest = path.join(CLIENT_HOME, 'agent_fault_injection')
  if (fs.existsSync(fiSrc) && path.resolve(fiSrc) !== path.resolve(fiDest)) {
    fs.rmSync(fiDest, { recursive: true, force: true })
    fs.cpSync(fiSrc, fiDest, { recursive: true })
  }
  log(`✓ 运行时已部署到 ${RUNTIME_DIR}`)
}

const SERVICE_NAME = 'agent-insight-client'
const LAUNCHD_LABEL = 'ai.agent-insight.client'

function parseArgs(argv) {
  // withFi 默认 true：默认尝试安装故障注入组件，失败只告警不中断。
  const out = { start: true, withFi: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--host') out.host = argv[++i]
    else if (arg === '--token') out.token = argv[++i]
    else if (arg === '--name') out.name = argv[++i]
    else if (arg === '--no-start') out.start = false
    else if (arg === '--start') out.start = true
    else if (arg === '--no-fi') out.withFi = false
    else if (arg === '--with-fi') out.withFi = true
    else if (arg === '--status') out.status = true
    else if (arg === '--uninstall') out.uninstall = true
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

function log(...args) {
  console.log('[install-ras-client]', ...args)
}

function fail(message, hint) {
  console.error(`[install-ras-client] ✗ ${message}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(1)
}

function pickReportedIp() {
  const nets = os.networkInterfaces() || {}
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      const isV4 = entry.family === 'IPv4' || entry.family === 4
      if (!isV4 || entry.internal) continue
      const address = String(entry.address || '').trim()
      if (address && !address.startsWith('127.')) return address
    }
  }
  return null
}

// ------------------------------------------------------------- register

async function register({ host, token, name }) {
  const base = String(host || '').replace(/\/$/, '')
  const res = await fetch(`${base}/api/reliability/client/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installToken: token,
      client: {
        name: name || null,
        hostname: os.hostname(),
        ip: pickReportedIp(),
        os: process.platform,
        arch: process.arch,
        agentVersion: '1.0.0',
        supervisor: process.platform === 'darwin' ? 'launchd' : 'systemd',
      },
      capabilities: { platforms: [], actions: [] },
    }),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const code = json?.error?.code || `HTTP ${res.status}`
    const message = json?.error?.message || text
    fail(`注册失败 (${code}): ${message}`, '安装令牌一次性且有短有效期；请在页面重新生成。')
  }

  fs.mkdirSync(CLIENT_HOME, { recursive: true, mode: 0o700 })
  const config = {
    insightBaseUrl: base,
    clientId: json.clientId,
    // 设备凭证只返回一次，且只能当前用户可读。
    deviceCredential: json.deviceCredential,
    websocketUrl: json.control?.websocketUrl || '',
    pollUrl: json.control?.pollUrl || '',
  }
  const tmp = `${CONFIG_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_PATH)
  fs.chmodSync(CONFIG_PATH, 0o600)
  log(`✓ 注册成功: clientId=${json.clientId}`)
  return config
}

// ------------------------------------------------------------- fault injection

function resolvePythonExecutable(runner = spawnSync) {
  const probe = runner(
    'python3',
    ['-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const executable = probe.status === 0 ? String(probe.stdout || '').trim() : ''
  return executable && path.isAbsolute(executable) ? executable : null
}

/**
 * 安装故障注入组件（Python 包 + 数据目录）。
 *
 * **不带 --start**：注入任务的领取与采集由常驻客户端接管，
 * 不再另起一个 fi-worker 独立进程 —— 一台机器只应有一个常驻服务。
 *
 * 失败只告警不中断：没有 Python 的机器仍应能作为纯可靠性客户端上线，
 * 届时客户端心跳会上报 faultInjection.ready=false，页面据此提示。
 */
function installFaultInjection() {
  const installer = path.join(PACKAGE_ROOT, 'scripts', 'install-fault-injection.js')
  if (!fs.existsSync(installer)) {
    console.warn('[install-ras-client] ⚠ 未找到故障注入安装器，跳过（客户端仍可用于配置下发与观测）')
    return false
  }
  const python = resolvePythonExecutable()
  if (!python) {
    console.warn('[install-ras-client] ⚠ 未找到 python3，跳过故障注入组件')
    console.warn('  客户端仍会上线；实验页会显示「FI 未就绪」。装好 python3 后重跑本命令即可。')
    return false
  }

  log('正在安装故障注入组件…')
  // 独立子进程：install-fault-injection.js 内部会 process.exit()，不能直接 require。
  const r = spawnSync(process.execPath, [installer], {
    stdio: 'inherit',
    env: { ...process.env, AGENT_FI_PYTHON: python },
  })
  if (r.status === 0) {
    // 同 venv 分支：探测目录必须是固化副本，不能是临时解压目录。
    patchClientConfig({
      fiPython: python,
      fiPackageRoot: path.join(CLIENT_HOME, 'agent_fault_injection'),
    })
    log('✓ 故障注入组件已安装（由常驻客户端统一领取任务，不另起 fi-worker 进程）')
    return true
  }

  // 全局 pip 装不上通常是 PEP 668（Homebrew / Debian 管控的 Python）。
  // 这类环境里 venv 是官方推荐做法，回退一次再判失败。
  console.warn(`[install-ras-client] ⚠ 全局安装失败（exit ${r.status}），改用独立 venv 重试…`)
  if (installFaultInjectionViaVenv()) return true

  console.warn('[install-ras-client] ⚠ 故障注入组件安装失败，已跳过')
  console.warn('  客户端仍会上线；实验页会显示「FI 未就绪」。修复 Python 环境后重跑本命令即可。')
  return false
}

/** PEP 668 回退：装进 ~/.agent-insight/fault-injection/venv，并把解释器路径写进客户端配置。 */
function installFaultInjectionViaVenv() {
  const fiHome = path.join(os.homedir(), '.agent-insight', 'fault-injection')
  const venv = path.join(fiHome, 'venv')
  const venvPython = path.join(venv, 'bin', 'python')
  const sourceRoot = path.join(PACKAGE_ROOT, 'agent_fault_injection')
  if (!fs.existsSync(sourceRoot)) return false

  fs.mkdirSync(fiHome, { recursive: true })
  if (!fs.existsSync(venvPython)) {
    const mk = spawnSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' })
    if (mk.status !== 0) return false
  }
  const pip = spawnSync(venvPython, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', sourceRoot], {
    stdio: 'inherit',
  })
  if (pip.status !== 0) return false

  const verify = spawnSync(venvPython, ['-c', 'import agent_fault_injection'], { stdio: 'ignore' })
  if (verify.status !== 0) return false

  // 客户端后续 spawn 采集器必须用同一个解释器，否则又会 import 不到。
  // fiPackageRoot 指向固化副本而非安装源：后者可能是稍后被删的临时目录。
  patchClientConfig({
    fiPython: venvPython,
    fiPackageRoot: path.join(CLIENT_HOME, 'agent_fault_injection'),
  })
  log(`✓ 故障注入组件已安装到 venv: ${venv}`)
  return true
}

function patchClientConfig(patch) {
  try {
    const prev = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {}
    const tmp = `${CONFIG_PATH}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...prev, ...patch }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, CONFIG_PATH)
  } catch (err) {
    console.warn(`[install-ras-client] ⚠ 写入客户端配置失败: ${err.message}`)
  }
}

// ------------------------------------------------------------- systemd

function systemdUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`)
}

function writeSystemdUnit() {
  const unitPath = systemdUnitPath()
  fs.mkdirSync(path.dirname(unitPath), { recursive: true })
  const nodeBin = process.execPath
  // WatchdogSec 配合客户端心跳里的 sd_notify(WATCHDOG=1)：
  // 进程假死（心跳停但进程还在）时由 systemd 重启，这是客户端自身做不到的。
  const unit = `[Unit]
Description=Agent Insight Reliability Client
After=network-online.target

[Service]
Type=notify
NotifyAccess=all
ExecStart=${nodeBin} ${CLIENT_SCRIPT}
Environment=AGENT_INSIGHT_SUPERVISOR=systemd
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=300
StartLimitBurst=5
WatchdogSec=30s
StandardOutput=append:${path.join(CLIENT_HOME, 'client.log')}
StandardError=append:${path.join(CLIENT_HOME, 'client.log')}

[Install]
WantedBy=default.target
`
  fs.writeFileSync(unitPath, unit)
  log(`✓ 已写入 systemd unit: ${unitPath}`)
  return unitPath
}

function systemctl(...args) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function installSystemd(start) {
  writeSystemdUnit()
  systemctl('daemon-reload')
  systemctl('enable', `${SERVICE_NAME}.service`)
  if (start) {
    const r = systemctl('restart', `${SERVICE_NAME}.service`)
    if (r.status !== 0) {
      console.error((r.stderr || '').trim())
      fail('systemd 启动失败', `查看日志: journalctl --user -u ${SERVICE_NAME} -n 50`)
    }
    log('✓ 服务已启动 (systemd)')
  }
  log(`  状态: systemctl --user status ${SERVICE_NAME}`)
  log(`  日志: journalctl --user -u ${SERVICE_NAME} -f`)
}

// ------------------------------------------------------------- launchd

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

function writeLaunchdPlist() {
  const plistPath = launchdPlistPath()
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  const logPath = path.join(CLIENT_HOME, 'client.log')
  const servicePath = String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
  // launchd 没有 watchdog 概念；KeepAlive.SuccessfulExit=false 覆盖崩溃重启，
  // 假死检测由服务端心跳窗口体现为 offline，需人工介入。
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${CLIENT_SCRIPT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_INSIGHT_SUPERVISOR</key><string>launchd</string>
    <key>PATH</key><string>${servicePath}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`
  fs.writeFileSync(plistPath, plist)
  log(`✓ 已写入 launchd plist: ${plistPath}`)
  return plistPath
}

function installLaunchd(start) {
  const plistPath = writeLaunchdPlist()
  const uid = process.getuid ? process.getuid() : 501
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' })
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (r.status !== 0 && !(r.stderr || '').includes('already')) {
    // 老版本 macOS 没有 bootstrap，退回 load。
    spawnSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' })
  }
  if (start) {
    spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' })
    log('✓ 服务已启动 (launchd)')
  }
  log(`  状态: launchctl print gui/${uid}/${LAUNCHD_LABEL} | head -20`)
  log(`  日志: tail -f ${path.join(CLIENT_HOME, 'client.log')}`)
}

// ------------------------------------------------------------- status / uninstall

function status() {
  if (!fs.existsSync(CONFIG_PATH)) {
    log('未注册（缺少 config.json）')
    return
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  log(`clientId: ${cfg.clientId}`)
  log(`host:     ${cfg.insightBaseUrl}`)
  if (process.platform === 'linux') {
    const r = systemctl('is-active', `${SERVICE_NAME}.service`)
    log(`systemd:  ${(r.stdout || r.stderr || '').trim() || 'unknown'}`)
  } else if (process.platform === 'darwin') {
    const uid = process.getuid ? process.getuid() : 501
    const r = spawnSync('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`], { encoding: 'utf8' })
    log(`launchd:  ${r.status === 0 ? 'loaded' : 'not loaded'}`)
  }
}

function uninstall() {
  if (process.platform === 'linux') {
    systemctl('stop', `${SERVICE_NAME}.service`)
    systemctl('disable', `${SERVICE_NAME}.service`)
    const unitPath = systemdUnitPath()
    if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath)
    systemctl('daemon-reload')
    log('✓ 已卸载 systemd 服务')
  } else if (process.platform === 'darwin') {
    const uid = process.getuid ? process.getuid() : 501
    spawnSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' })
    const plistPath = launchdPlistPath()
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath)
    log('✓ 已卸载 launchd 服务')
  }
  log(`  配置保留在 ${CLIENT_HOME}，如需彻底清理请手动删除`)
}

// ------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(`用法:
  install-ras-client --host <url> --token <installToken> [--no-start] [--no-fi]
  install-ras-client --status
  install-ras-client --uninstall

说明:
  默认同时安装故障注入组件（失败仅告警不中断）；--no-fi 可跳过。
  注入任务由常驻客户端统一领取，不再单独启动 fi-worker 进程。`)
    return
  }
  if (args.status) return status()
  if (args.uninstall) return uninstall()

  if (process.platform === 'win32') {
    fail(
      'Windows 暂不支持自动注册为系统服务',
      '本期仅支持 Linux (systemd) 与 macOS (launchd)。' +
        `Windows 上可手动运行: node ${CLIENT_SCRIPT}`,
    )
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    fail(`不支持的平台: ${process.platform}`)
  }
  if (process.platform === 'linux' && spawnSync('systemctl', ['--version']).status !== 0) {
    fail('未找到 systemctl', `该系统没有 systemd，可手动运行: node ${CLIENT_SCRIPT}`)
  }

  if (args.token) {
    if (!args.host) fail('缺少 --host')
    await register({ host: args.host, token: args.token, name: args.name })
  } else if (!fs.existsSync(CONFIG_PATH)) {
    fail('缺少 --token 且本机尚未注册', '请在「客户端安装」页生成安装命令。')
  } else {
    log('已存在注册信息，跳过注册')
  }

  // 必须先固化运行时：安装器可能跑在稍后被删除的临时解压目录里。
  installRuntime()

  const fiOk = args.withFi ? installFaultInjection() : false
  if (!args.withFi) log('已按 --no-fi 跳过故障注入组件')

  if (process.platform === 'linux') installSystemd(args.start)
  else installLaunchd(args.start)

  log('')
  log('安装完成。客户端独立于 Agent 平台运行，崩溃后由系统进程管理器自动拉起。')
  log(
    fiOk
      ? '故障注入已就绪：本机同时出现在「客户端配置」与「实验 / 故障注入」页面。'
      : '故障注入未就绪：本机仍会出现在「客户端配置」与实验页，但标记为 FI 不可用。',
  )
}

module.exports = {
  CLIENT_SCRIPT,
  installRuntime,
  RUNTIME_DIR,
  writeSystemdUnit,
  writeLaunchdPlist,
  parseArgs,
  installFaultInjection,
  resolvePythonExecutable,
  SERVICE_NAME,
  LAUNCHD_LABEL,
}

if (require.main === module) {
  main().catch((err) => {
    fail(err.message)
  })
}
