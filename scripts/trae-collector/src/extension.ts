import * as vscode from 'vscode'
import { UploadEngine } from './uploader/upload-engine'
import { SpoolReader } from './uploader/spool'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

let statusBarItem: vscode.StatusBarItem | undefined
let uploadEngine: UploadEngine | undefined
let uploadTimer: NodeJS.Timeout | undefined
let outputChannel: vscode.OutputChannel | undefined
let envWatcher: fs.FSWatcher | undefined
let spoolWatcher: fs.FSWatcher | undefined
let isSyncing = false
let sessionEndDebounce: NodeJS.Timeout | undefined
let heartbeatTimer: NodeJS.Timeout | undefined
let lastSpoolActivity = 0
let lastHeartbeatAt = 0
export interface TraeConfig {
  enabled: boolean
  host: string
  apiKey: string
  uploadIntervalMs: number
  requestTimeoutMs: number
  maxRetries: number
  retryBaseDelayMs: number
  llmEnabled: boolean
  llmPollIntervalMs: number
  logLevel: string
  spoolDir: string
  heartbeatEnabled: boolean
  heartbeatIntervalMs: number
  modelName: string
}

function getConfig(): TraeConfig {
  const cfg = vscode.workspace.getConfiguration('agentInsight.trae')
  let host = cfg.get<string>('host', '')
  let apiKey = cfg.get<string>('apiKey', '')
  // Runtime fallback: read from .env if settings are empty
  if (!host || !apiKey) {
    try {
      const envFile = path.join(os.homedir(), '.agent-insight', '.env')
      if (fs.existsSync(envFile)) {
        const envText = fs.readFileSync(envFile, 'utf8')
        if (!host) {
          const m = envText.match(/^AGENT_INSIGHT_HOST=(.+)$/m)
          if (m) host = m[1].trim()
        }
        if (!apiKey) {
          const m = envText.match(/^AGENT_INSIGHT_API_KEY=(.+)$/m)
          if (m) apiKey = m[1].trim()
        }
      }
    } catch {}
  }
  return {
    enabled: cfg.get<boolean>('enabled', true),
    host: host,
    apiKey: apiKey,
    uploadIntervalMs: cfg.get<number>('uploadIntervalMs', 30000),
    requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 15000),
    maxRetries: cfg.get<number>('maxRetries', 3),
    retryBaseDelayMs: cfg.get<number>('retryBaseDelayMs', 10000),
    llmEnabled: cfg.get<boolean>('llmEnabled', true),
    llmPollIntervalMs: cfg.get<number>('llmPollIntervalMs', 30000),
    logLevel: cfg.get<string>('logLevel', 'info'),
    spoolDir: (cfg.get<string>('spoolDir', '') || '').replace(/^~/, os.homedir()),
    heartbeatEnabled: cfg.get<boolean>('heartbeatEnabled', true),
    heartbeatIntervalMs: cfg.get<number>('heartbeatIntervalMs', 30000),
    modelName: cfg.get<string>('modelName', ''),
  }
}
function getEnvFilePath(): string {
  return path.join(os.homedir(), '.agent-insight', '.env')
}

function readEnvValue(key: string): string | null {
  try {
    const envFile = getEnvFilePath()
    if (!fs.existsSync(envFile)) return null
    const envText = fs.readFileSync(envFile, 'utf8')
    const m = envText.match(new RegExp(`^${key}=(.+)$`, 'm'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

async function syncConfigFromEnv() {
  if (isSyncing) return
  isSyncing = true
  try {
    const cfg = vscode.workspace.getConfiguration('agentInsight.trae')
    const hostFromEnv = readEnvValue('AGENT_INSIGHT_HOST')
    const keyFromEnv = readEnvValue('AGENT_INSIGHT_API_KEY')
    
    if (hostFromEnv !== null) {
      const currentHost = cfg.get('host', '')
      if (currentHost !== hostFromEnv) {
        await cfg.update('host', hostFromEnv, vscode.ConfigurationTarget.Global)
        log('config updated from .env: host')
      }
    }
    
    if (keyFromEnv !== null) {
      const currentKey = cfg.get('apiKey', '')
      if (currentKey !== keyFromEnv) {
        await cfg.update('apiKey', keyFromEnv, vscode.ConfigurationTarget.Global)
        log('config updated from .env: apiKey')
      }
    }
    
    updateStatusBar()
    restartUploadTimer()
  } finally {
    isSyncing = false
  }
}

function syncEnvFromConfig() {
  if (isSyncing) return
  isSyncing = true
  try {
    const cfg = vscode.workspace.getConfiguration('agentInsight.trae')
    const hostFromCfg = cfg.get<string>('host', '')
    const keyFromCfg = cfg.get<string>('apiKey', '')
    
    const envFile = getEnvFilePath()
    let envContent = ''
    
    if (fs.existsSync(envFile)) {
      envContent = fs.readFileSync(envFile, 'utf8')
    }
    
    // Update or add AGENT_INSIGHT_HOST
    if (hostFromCfg) {
      if (envContent.match(/^AGENT_INSIGHT_HOST=/m)) {
        envContent = envContent.replace(/^AGENT_INSIGHT_HOST=.+$/m, `AGENT_INSIGHT_HOST=${hostFromCfg}`)
      } else {
        envContent += `\nAGENT_INSIGHT_HOST=${hostFromCfg}`
      }
    }
    
    // Update or add AGENT_INSIGHT_API_KEY
    if (keyFromCfg) {
      if (envContent.match(/^AGENT_INSIGHT_API_KEY=/m)) {
        envContent = envContent.replace(/^AGENT_INSIGHT_API_KEY=.+$/m, `AGENT_INSIGHT_API_KEY=${keyFromCfg}`)
      } else {
        envContent += `\nAGENT_INSIGHT_API_KEY=${keyFromCfg}`
      }
    }
    
    // Ensure directory exists
    fs.mkdirSync(path.dirname(envFile), { recursive: true })
    fs.writeFileSync(envFile, envContent.trim() + '\n')
    
    log('config updated from settings to .env')
  } catch (err) {
    log(`failed to sync config to .env: ${err instanceof Error ? err.message : String(err)}`, 'warn')
  } finally {
    isSyncing = false
  }
}

function startEnvWatcher() {
  try {
    const envFile = getEnvFilePath()
    const envDir = path.dirname(envFile)
    
    if (!fs.existsSync(envDir)) {
      fs.mkdirSync(envDir, { recursive: true })
    }
    
    envWatcher = fs.watch(envDir, (eventType: string, filename: string | null) => {
      if (filename === '.env') {
        log('.env file changed, syncing config...')
        syncConfigFromEnv()
      }
    })
    log('env watcher started')
  } catch (err) {
    log(`failed to start env watcher: ${err instanceof Error ? err.message : String(err)}`, 'warn')
  }
}

function stopEnvWatcher() {
  if (envWatcher) {
    try {
      envWatcher.close()
      log('env watcher stopped')
    } catch {}
    envWatcher = undefined
  }
}

function startSpoolWatcher() {
  try {
    const cfg = getConfig()
    const spoolDir = cfg.spoolDir || path.join(os.homedir(), '.agent-insight', 'otel_data', 'trae')
    
    if (!fs.existsSync(spoolDir)) {
      fs.mkdirSync(spoolDir, { recursive: true })
    }
    
    spoolWatcher = fs.watch(spoolDir, { recursive: true }, (eventType: string, filename: string | null) => {
      if (!filename || !filename.endsWith('.jsonl')) return
      // Record activity for heartbeat
      lastSpoolActivity = Date.now()
      
      // Debounce to avoid triggering too frequently
      if (sessionEndDebounce) clearTimeout(sessionEndDebounce)
      sessionEndDebounce = setTimeout(() => {
        const cfg = getConfig()
        if (cfg.enabled && cfg.host && cfg.apiKey) {
          log('spool file changed, triggering upload...')
          flushSpool()
          // Start heartbeat for active sessions
          if (cfg.heartbeatEnabled) {
            startHeartbeat()
          }
        }
      }, 3000) // 3 second debounce
    })
    log('spool watcher started')
  } catch (err) {
    log(`failed to start spool watcher: ${err instanceof Error ? err.message : String(err)}`, 'warn')
  }
}

function stopSpoolWatcher() {
  if (spoolWatcher) {
    try {
      spoolWatcher.close()
      log('spool watcher stopped')
    } catch {}
    spoolWatcher = undefined
  }
}

// AC29: 清理 spool 目录和配置文件
function cleanupOnUninstall() {
  try {
    const cfg = getConfig()
    const spoolDir = cfg.spoolDir || path.join(os.homedir(), '.agent-insight', 'otel_data', 'trae')
    
    // AC22: 先尝试上传所有未上传的数据
    flushSpool().catch(() => {})
    
    // 清理 spool 目录（保留最近24小时的文件）
    if (fs.existsSync(spoolDir)) {
      const now = Date.now()
      const keepAfter = now - 24 * 60 * 60 * 1000 // 24小时
      const files = fs.readdirSync(spoolDir, { recursive: true, encoding: 'utf8' }) as string[]
      files.forEach(filePath => {
        const fullPath = path.join(spoolDir, filePath)
        if (fs.statSync(fullPath).isFile()) {
          const mtime = fs.statSync(fullPath).mtime.getTime()
          if (mtime < keepAfter) {
            fs.unlinkSync(fullPath)
          }
        }
      })
      log('spool directory cleaned up')
    }
    
    // 清理 hooks 目录
    const hooksDir = path.join(os.homedir(), '.agent-insight', 'trae-hooks')
    if (fs.existsSync(hooksDir)) {
      try {
        fs.rmSync(hooksDir, { recursive: true, force: true })
        log('hooks directory cleaned up')
      } catch {}
    }
    
    // 清理 checkpoint 文件
    const checkpointFile = path.join(os.homedir(), '.agent-insight', 'trae_uploader_checkpoint.json')
    if (fs.existsSync(checkpointFile)) {
      fs.unlinkSync(checkpointFile)
      log('checkpoint file cleaned up')
    }
    
    // AC30: 不清理 .env 文件（可能被其他采集器使用）
  } catch (err) {
    log(`cleanup error: ${err instanceof Error ? err.message : String(err)}`, 'warn')
  }
}

// AC27: 内存泄漏检测 - 定期检查 EventEmitter 监听器数量
function startMemoryMonitor() {
  if (process.env.NODE_ENV !== 'development') return
  
  setInterval(() => {
    const eventListeners = (process as any).eventNames?.().length || 0
    const heapUsed = process.memoryUsage().heapUsed / 1024 / 1024
    log(`memory: ${heapUsed.toFixed(2)}MB, eventListeners: ${eventListeners}`, 'debug')
    
    // AC27: 检测异常内存增长
    if (heapUsed > 200) {
      log(`memory warning: ${heapUsed.toFixed(2)}MB exceeded threshold`, 'warn')
    }
  }, 60000)
}

function startHeartbeat() {
  const cfg = getConfig()
  if (!cfg.heartbeatEnabled) return
  const interval = cfg.heartbeatIntervalMs
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    const now = Date.now()
    // Only heartbeat if spool has had recent activity (within 3x interval)
    if (now - lastSpoolActivity > interval * 3) {
      stopHeartbeat()
      return
    }
    // Rate-limit: don't heartbeat more often than the configured interval
    if (now - lastHeartbeatAt < interval) return
    lastHeartbeatAt = now
    log('heartbeat: triggering upload')
    flushSpool()
  }, interval)
  log('heartbeat started: interval=' + interval + 'ms')
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
    log('heartbeat stopped')
  }
}

function restartUploadTimer() {
  if (uploadTimer) clearInterval(uploadTimer)
  const cfg = getConfig()
  if (cfg.enabled && cfg.host && cfg.apiKey) {
    uploadTimer = setInterval(() => flushSpool(), cfg.uploadIntervalMs)
    log('upload timer started: interval=' + cfg.uploadIntervalMs + 'ms')
  }
}

function log(msg: string, level: string = 'info') {
  if (!outputChannel) return
  const cfg = getConfig()
  const levels = ['error', 'warn', 'info', 'debug']
  const cfgIdx = levels.indexOf(cfg.logLevel)
  const msgIdx = levels.indexOf(level)
  if (msgIdx < 0 || msgIdx > cfgIdx) return
  const ts = new Date().toISOString().slice(0, 19)
  outputChannel.appendLine(`[${ts}] [${level.toUpperCase()}] ${msg}`)
}

function updateStatusBar() {
  if (!statusBarItem) return
  const cfg = getConfig()
  if (!cfg.enabled) {
    statusBarItem.text = '$(eye-closed) Agent Insight'
    statusBarItem.tooltip = 'TRAE 采集器已禁用'
    return
  }
  const hasHost = !!cfg.host
  const hasKey = !!cfg.apiKey
  statusBarItem.text = hasHost && hasKey ? '$(eye) Agent Insight' : '$(eye) Agent Insight \u26a0\ufe0f'
  statusBarItem.tooltip = hasHost && hasKey
    ? 'Agent Insight TRAE Collector \u2014 \u8fd0\u884c\u4e2d'
    : `Agent Insight TRAE Collector \u2014 \u672a\u914d\u7f6e${!cfg.host ? ' HOST' : ''}${!cfg.apiKey ? ' API_KEY' : ''}`
  statusBarItem.color = hasHost && hasKey ? new vscode.ThemeColor('statusBarItem.prominentForeground') : new vscode.ThemeColor('errorForeground')
}

async function flushSpool() {
  const cfg = getConfig()
  if (!cfg.enabled || !cfg.host || !cfg.apiKey) {
    log('flush skipped: missing config')
    return
  }
  try {
    log('flush started')
    await uploadEngine?.uploadAll()
    log('flush completed')
  } catch (err) {
    log(`flush error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Agent Insight TRAE')
  log('activating...')

  // --- Auto-deploy Hook scripts (always run to ensure updates) ---
  try {
    const { execSync } = require('child_process')
    const isWindows = process.platform === 'win32'
    const setupScript = path.join(context.extensionPath, isWindows ? 'setup.ps1' : 'setup.sh')
    if (fs.existsSync(setupScript)) {
      log('Auto-deploying hook scripts (setup ' + (isWindows ? 'ps1' : 'sh') + ')...')
      if (isWindows) {
        execSync('powershell -ExecutionPolicy Bypass -File "' + setupScript + '"', { timeout: 30000, stdio: 'pipe' })
      } else {
        execSync('bash "' + setupScript + '"', { timeout: 30000, stdio: 'pipe' })
      }
      log('Hook scripts auto-deployed successfully')
    } else {
      log('setup script not found at: ' + setupScript, 'warn')
    }
  } catch (e) {
    log('auto-deploy hook scripts failed: ' + (e instanceof Error ? e.message : String(e)), 'warn')
  }

  let autoConfigured = false
  try {
    const envFile = path.join(os.homedir(), '.agent-insight', '.env')
    if (fs.existsSync(envFile)) {
      const envText = fs.readFileSync(envFile, 'utf8')
      const cfg = vscode.workspace.getConfiguration('agentInsight.trae')
      const hostMatch = envText.match(/^AGENT_INSIGHT_HOST=(.+)$/m)
      if (hostMatch && cfg.get('host') !== hostMatch[1].trim()) {
        cfg.update('host', hostMatch[1].trim(), vscode.ConfigurationTarget.Global)
        autoConfigured = true
      }
      const keyMatch = envText.match(/^AGENT_INSIGHT_API_KEY=(.+)$/m)
      if (keyMatch && cfg.get('apiKey') !== keyMatch[1].trim()) {
        cfg.update('apiKey', keyMatch[1].trim(), vscode.ConfigurationTarget.Global)
        autoConfigured = true
      }
    }
  } catch {}

  // --- Status Bar ---
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.command = 'agent-insight-trae.showStatus'
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)
  updateStatusBar()

  // --- Spool Reader ---
  const spoolReader = new SpoolReader(getConfig().spoolDir || undefined)
  log('spoolReader using: ' + spoolReader.getSpoolDir())

  uploadEngine = new UploadEngine(spoolReader, log, getConfig())
  context.subscriptions.push(uploadEngine)

  // --- LLM Trace Collector (disabled — TRAE DB is encrypted) ---
  log('LLM collector disabled (TRAE database is encrypted, model/token unavailable from DB)')

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('agent-insight-trae.showStatus', () => {
      const cfg = getConfig()
      const msg = cfg.enabled
        ? 'Agent Insight TRAE: ' + (cfg.host ? '\u5df2\u8fde\u63a5' : '\u672a\u914d\u7f6e HOST') + ' | API Key: ' + (cfg.apiKey ? '\u5df2\u8bbe\u7f6e' : '\u672a\u8bbe\u7f6e')
        : 'Agent Insight TRAE: \u5df2\u7981\u7528'
      vscode.window.showInformationMessage(msg)
    }),

    vscode.commands.registerCommand('agent-insight-trae.flushNow', async () => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '\u6b63\u5728\u4e0a\u4f20 TRAE Trace \u6570\u636e...' }, async () => {
        await flushSpool()
      })
      vscode.window.showInformationMessage('TRAE Trace \u6570\u636e\u4e0a\u4f20\u5b8c\u6210')
    }),

    vscode.commands.registerCommand('agent-insight-trae.openSpoolDir', async () => {
      const cfg = getConfig()
      const dir = cfg.spoolDir || path.join(os.homedir(), '.agent-insight', 'otel_data', 'trae')
      try {
        await vscode.env.clipboard.writeText(dir)
        vscode.window.showInformationMessage('Spool \u76ee\u5f55: ' + dir + '\n(\u8def\u5f84\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f)')
      } catch {
        vscode.window.showInformationMessage('Spool \u76ee\u5f55: ' + dir)
      }
    }),

    vscode.commands.registerCommand('agent-insight-trae.openLogs', () => {
      outputChannel?.show()
    }),

    // AC29: 卸载清理命令
    vscode.commands.registerCommand('agent-insight-trae.cleanup', async () => {
      const confirm = await vscode.window.showWarningMessage(
        '确定要清理所有 TRAE 采集器数据吗？这将删除 spool 目录、hooks 脚本和 checkpoint 文件。',
        { modal: true },
        '确定清理'
      )
      if (confirm === '确定清理') {
        cleanupOnUninstall()
        vscode.window.showInformationMessage('清理完成')
      }
    }),
  )

  // --- Config Change Listener ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('agentInsight.trae')) {
        updateStatusBar()
        restartUploadTimer()
        syncEnvFromConfig()
      }
    }),
  )

  // --- Upload Timer ---
  if (autoConfigured) {
    setTimeout(() => {
      const cfg = getConfig()
      log('auto-config: host=' + (cfg.host ? 'yes' : 'no') + ' apiKey=' + (cfg.apiKey ? 'yes' : 'no'))
      if (cfg.host && cfg.apiKey) {
        vscode.window.showInformationMessage('Agent Insight \u914d\u7f6e\u5df2\u4ece .env \u81ea\u52a8\u52a0\u8f7d')
      }
      restartUploadTimer()
    }, 1000)
  } else {
    restartUploadTimer()
  }

  // --- Deactivation Handler (best-effort shutdown entry) ---
  context.subscriptions.push({
    dispose: () => {
      try {
        const entry = JSON.stringify({
          t: new Date().toISOString(),
          kind: 'plugin.shutdown',
          sessionID: 'all',
          payload: { reason: 'extension-deactivate', pid: process.pid }
        }) + '\n'
        const dir = getConfig().spoolDir || path.join(os.homedir(), '.agent-insight', 'otel_data', 'trae')
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(path.join(dir, 'plugin-shutdown.jsonl'), entry, 'utf8')
      } catch {}
    },
  })

  // Push outputChannel AFTER dispose callback so it's disposed last
  context.subscriptions.push(outputChannel)

  // --- Env File Watcher ---
  startEnvWatcher()

  // --- Spool Directory Watcher ---
  startSpoolWatcher()

  // AC27: 启动内存监控
  startMemoryMonitor()

  log('activated')
}

export async function deactivate() {
  stopHeartbeat()
  stopEnvWatcher()
  stopSpoolWatcher()
  if (uploadTimer) clearInterval(uploadTimer)
  if (sessionEndDebounce) clearTimeout(sessionEndDebounce)
  try { await flushSpool() } catch {}
  log('deactivated')
}
