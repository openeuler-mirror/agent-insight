import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { db } from '@/lib/storage/prisma'

// ── 类型 ─────────────────────────────────────────────────────────────

type SingleServer = {
  process: ChildProcess
  port: number
  baseUrl: string
  user: string
  /** Hash of the model config (apiKey/baseURL/providerID/modelID) used to spawn this
   *  instance. 用于检测用户在 UI 改了 apiKey 后判断是否需要重启实例。 */
  configHash: string
  /** spawn 时间戳 (ms)。dashboard 用来算 uptime,排查长时间未活动的卡死实例。 */
  startedAt: number
}

// ── 模块状态 ─────────────────────────────────────────────────────────

/**
 * Multi-tenant：每个 user 一个 opencode 子进程，apiKey/provider 独立。
 * 之所以做 per-user：opencode 的 PromptInput.model schema 不接 apiKey，
 * 静态 config 里只能写一份；想多用户共享单实例就只能让一份 apiKey 卡死。
 *
 * 单机 dev 下通常只有一个 user 在用，等同于 singleton。多人共用 dev server / 多 user
 * 测试评估同时跑的场景，每个 user 各起一个实例，互不干扰。
 *
 * 内存代价：每个 opencode 进程 ~50–100 MB，按需起 + 退出时统一杀。
 */
const GLOBAL_KEY = Symbol.for('@witty-insight/opencode-manager-state')
type ManagerState = {
  /** userKey → 已起的 server 实例 */
  servers: Map<string, SingleServer>
  /** userKey → 正在 spawn 的 in-flight promise（并发去重） */
  startingServers: Map<string, Promise<SingleServer>>
  /**
   * userKey → "server 重启代次"。每起一个新进程就 +1。caller（如 skill-generator-bridge）
   * 把这个代次跟它缓存的 opencode sessionId 一起记，下次取出时对比：代次变了 →
   * 旧 sessionId 已失效（新进程内存里不认它），当作无缓存重建。
   * 取代之前"只在 throw 时 retry"的兜底——server 重启场景 session.prompt 不报错
   * 但也不调 LLM，throw-path 兜不住。
   */
  generations: Map<string, number>
}
const globalAny = globalThis as unknown as { [GLOBAL_KEY]?: ManagerState }
if (!globalAny[GLOBAL_KEY]) {
  globalAny[GLOBAL_KEY] = {
    servers: new Map<string, SingleServer>(),
    startingServers: new Map<string, Promise<SingleServer>>(),
    generations: new Map<string, number>(),
  }
}
const state: ManagerState = globalAny[GLOBAL_KEY]!

/**
 * 暴露当前 user 的 server 代次。skill-generator-bridge 调它给 cached sessionId 打戳。
 * 没起过 server 时返回 0（caller 通常用 `!== current` 判断失效，0 也能正确触发新建）。
 */
export function getOpencodeServerGeneration(user: string): number {
  return state.generations.get(user || ANONYMOUS_USER_KEY) ?? 0
}

/**
 * caller 没传 user 时使用的 fallback key（main.ts CLI demo 等）。
 * 这条路径不查 DB，只读用户全局 ~/.config/opencode/opencode.json，跟 isolation
 * 没引入 per-user 机制时的行为一致。
 */
const ANONYMOUS_USER_KEY = '__anonymous__'

/** 把 user 字符串转成文件系统安全的 slug，作为 isolated 配置目录名。 */
function userToSlug(user: string): string {
  if (!user || user === ANONYMOUS_USER_KEY) return '_anonymous'
  // 邮箱里的 @ 和 . 替换成 _，去掉别的怪字符；截断防止过长。
  return user.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || '_anonymous'
}

// ── 工具函数 ─────────────────────────────────────────────────────────

/** 获取一个空闲端口。让 OS 给我们分配,避免端口冲突。 */
async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('failed to obtain port'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

/** 健康检查。用裸 http 而不是 SDK,因为这时候 client 还没创建。 */
function healthcheck(url: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'GET', headers: { connection: 'close' } },
      (res) => {
        // 必须消费 body,否则连接不会关闭
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode || 0 }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** 轮询健康检查端点直到 server ready。 */
async function waitForServer(
  port: number,
  maxAttempts = 300,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/health`
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await healthcheck(url)
      if (res.status < 500) return
    } catch {
      // 连接被拒(server 还没起来),继续轮询
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `opencode server did not become ready within ${(maxAttempts * 100) / 1000}s`,
  )
}

// ── 启动 server ──────────────────────────────────────────────────────

/**
 * 解析 opencode 二进制的实际路径。优先级：
 *  1. OPENCODE_BIN 环境变量（部署侧覆盖，例如 /opt/opencode/bin/opencode）
 *  2. 项目 node_modules/.bin/opencode（来自 opencode-ai npm 包，服务自包含部署的首选）
 *  3. 直接 PATH 上的 opencode（dev 环境用全局 npm 装的那个）
 *
 * 部署生产环境时建议在 package.json 加 `opencode-ai` 依赖，让方案 2 生效，
 * 这样不依赖部署机器上有 opencode 命令。
 */
function resolveOpencodeBinary(): string {
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) {
    return process.env.OPENCODE_BIN
  }
  const localBin = path.join(process.cwd(), 'node_modules', '.bin', 'opencode')
  if (fs.existsSync(localBin)) return localBin
  return 'opencode'
}

/**
 * 给 spawn 出来的 opencode-server 准备一个干净的 XDG_CONFIG_HOME，避免它读到用户全局
 * `~/.config/opencode/opencode.json` 里挂的第三方插件（典型受害者：witty-diagnosis-agent，
 * 它注册了 `experimental.chat.messages.transform` + `tool.execute.after` preemptive-compaction
 * 等钩子，会偷换 user prompt 触发会话级 summarize，导致 skill-generator 里第二轮提问被替换成
 * "create anchored summary" 指令，模型完全收不到用户真实问题）。
 *
 * 隔离策略：
 *   - 把 XDG_CONFIG_HOME 指到 <project>/data/.opencode-runtime/，里面只放一份空 opencode.json，
 *     opencode 启动时就只看到这份，不会去 plugin 数组里加载 witty-diagnosis-agent。
 *   - HOME 不动，所以 `~/.opencode/plugins/Witty-Skill-Insight.ts`（HOME-relative，不受
 *     XDG_CONFIG_HOME 影响）还能正常加载——trace 上报链路不断。
 *   - cwd 仍然是 home，没必要换。
 *
 * 后续若需要在隔离环境里强制加挂插件，把 .ts 文件 symlink 到
 *   <project>/data/.opencode-runtime/opencode/plugins/ 即可。
 */
/**
 * 内置 provider id 集合：opencode 自带 SDK，static config 里出现这些 id 时不需要
 * 额外指定 npm 包名/baseURL；其它 provider id（如用户自定义的"custom"/"csi-provider"等）
 * 都按 OpenAI 兼容协议 + @ai-sdk/openai-compatible 注册。
 */
const KNOWN_BUILTIN_PROVIDERS = new Set([
  'deepseek',
  'deepseek-official',
  'openai',
  'anthropic',
  'google',
  'qwen',
  'moonshot',
])

/**
 * 简单的稳定 hash，用于 SingleServer.configHash——比较两次 spawn 的 model 配置是否一致，
 * 不一致就需要重启该 user 的 opencode 实例（用户在 UI 改了 apiKey 之后下一次请求生效）。
 */
function stableHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16)
}

/**
 * 把 user 的 active 模型配置（来自我们 web UI / DB UserSettings）转成 opencode static
 * config 里 provider 节点的形态。返回 null 表示用户没配，caller 退到全局配置 fallback。
 *
 * 说明：opencode 的 PromptInput.model schema 不接 apiKey 字段，apiKey 必须走静态 config。
 * 所以即使每次请求都知道 user 是谁，也得在 spawn opencode 实例的时候就把 apiKey 写好——
 * 这是 per-user instance 这套架构存在的根本原因。
 */
async function buildProviderEntryFromUserConfig(
  user: string,
): Promise<{ providerID: string; entry: Record<string, unknown>; modelID: string; raw: { apiKey: string; baseURL?: string } } | null> {
  if (!user || user === ANONYMOUS_USER_KEY) return null
  let serverModel: { providerID: string; modelID: string; apiKey?: string; baseURL?: string } | null = null
  let allConfigs: Array<{ id: string; name: string; provider?: string; apiKey: string; baseUrl?: string; model?: string }> = []
  try {
    const modA = await import('../../general-agent/server-model-config')
    serverModel = await modA.loadServerModelForUser(user)
    // 同时把该 user 的所有注册 configs 拉过来——后面要把同 provider 的所有模型一起注册
    // 进 opencode，让"换模型评测"在不重启 opencode 的前提下也能 work。
    const modB = await import('../../../storage/server-config')
    const settings = await modB.getUserSettings(user)
    allConfigs = (settings.configs ?? []).filter(c => c.apiKey)
  } catch (err) {
    // 模块加载/DB 查询失败不阻塞，退到全局配置 fallback
    console.warn(
      '[opencode] loadServerModelForUser failed, will fall back to global config:',
      (err as Error)?.message,
    )
    return null
  }
  if (!serverModel || !serverModel.apiKey) return null

  // 收集同 providerID 下所有 user-registered model 名 ── 让 opencode 注册多模型，
  // 后续请求里 SendPromptPayload.model.modelID 可以在它们之间切换不重启。
  const { inferProviderFromBaseUrl, normalizeProviderID } = await import('../../general-agent/server-model-config')
  const samePidModels = new Set<string>([serverModel.modelID])
  for (const cfg of allConfigs) {
    const explicitProvider = (cfg as { provider?: string }).provider
    const pid = normalizeProviderID(explicitProvider || inferProviderFromBaseUrl(cfg.baseUrl))
    if (pid === serverModel.providerID && cfg.model) {
      samePidModels.add(cfg.model)
    }
  }

  const isBuiltin = KNOWN_BUILTIN_PROVIDERS.has(serverModel.providerID)
  const models: Record<string, Record<string, unknown>> = {}
  for (const modelID of samePidModels) {
    models[modelID] = {
      name: modelID,
      // 给 deepseek-reasoner 这种长思考模型默认放宽 output——避免 opencode 自带
      // isOverflow → needsCompaction 把下一轮 prompt 吞掉。
      ...(modelID.includes('reasoner')
        ? { limit: { context: 65536, output: 32768 } }
        : {}),
    }
  }
  const entry: Record<string, unknown> = {
    options: {
      apiKey: serverModel.apiKey,
      ...(serverModel.baseURL ? { baseURL: serverModel.baseURL } : {}),
    },
    models,
  }
  if (!isBuiltin) {
    // 用户自定义 OpenAI 兼容端点（火山方舟 GLM、自建 vllm 之类）。npm 字段告诉 opencode
    // 用 @ai-sdk/openai-compatible 走通用 OpenAI 协议。
    entry.npm = '@ai-sdk/openai-compatible'
    entry.name = serverModel.providerID
  }
  if (samePidModels.size > 1) {
    console.log(
      `[opencode:${user}] registering ${samePidModels.size} models under ${serverModel.providerID}: ${[...samePidModels].join(', ')}`,
    )
  }
  return {
    providerID: serverModel.providerID,
    entry,
    modelID: serverModel.modelID,
    raw: { apiKey: serverModel.apiKey, baseURL: serverModel.baseURL },
  }
}

/**
 * 复制用户全局 ~/.config/opencode/opencode.json 的 provider 定义但剥掉 plugin/mcp。
 * 用户没装全局配置时返回 null（不强行兜底，让 buildIsolatedOpencodeConfig 决定下一步）。
 */
function readGlobalOpencodeConfigStripped(): Record<string, unknown> | null {
  const candidates = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
  ]
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    try {
      const raw = fs.readFileSync(candidate, 'utf-8')
      // 全局配置可能是 .jsonc 带注释；这里只支持纯 JSON——失败就 null（fallback）。
      const parsed = JSON.parse(raw) as Record<string, unknown>
      // 这是 isolation 的核心：剥掉用户全局挂的第三方插件（典型：witty-diagnosis-agent
      // 会注入 experimental.chat.messages.transform / preemptive-compaction 钩子，偷换
      // user prompt 触发 SessionSummary——skill-generator 第二轮提问会被替换成"create anchored
      // summary"指令，模型完全收不到用户真实问题）。
      delete parsed.plugin
      delete parsed.plugins
      delete parsed.mcp
      // deepseek-reasoner output limit 加宽（同上理由）。
      const provider = parsed.provider as Record<string, any> | undefined
      const reasoner = provider?.deepseek?.models?.['deepseek-reasoner']
      if (reasoner && typeof reasoner === 'object') {
        reasoner.limit = { context: 65536, output: 32768 }
      }
      return parsed
    } catch (err) {
      console.warn(
        '[opencode] failed to parse global opencode config, fallback to minimal:',
        (err as Error)?.message,
      )
      return null
    }
  }
  return null
}

/**
 * 给指定 user 准备 opencode static config。
 *
 * 优先级：
 *   1. user 在 web UI 里配的 active 模型（DB UserSettings.activeConfig）——这是同事拉新代码
 *      之后能直接用的关键。只要他们在 UI 设过 apiKey 就行，不用动 opencode CLI 全局配置。
 *   2. 全局 ~/.config/opencode/opencode.json（剥掉 plugin/mcp）——单机 dev 用 opencode CLI
 *      已经 auth login 过的兼容路径。
 *   3. 都没有时退到最小骨架（仅声明 deepseek provider id，无 apiKey 必然 401，但至少 server 起得来）。
 */
/**
 * 内置 mcp 注入：当 user 在 Settings 里配了 Tavily API key 时，挂一份本地 stdio MCP
 * server（tools/mcp-web-search/index.ts）让 agent 可以调 web_search / web_fetch。
 *
 * 与"剥用户全局 mcp"的关系：opencode-manager 此前主动 delete 全局 mcp 是为了屏蔽用户
 * 自挂的第三方插件（污染 skill-generator）。这里**额外加回**我们自己内置的那一份——
 * "剥外、加内"。返回 undefined 表示无 key 不挂。
 */
async function buildBuiltinMcpEntry(user: string): Promise<{
  mcp: Record<string, unknown>
  hashSeed: string
} | null> {
  let searchApiKey = ''
  try {
    const mod = await import('@/lib/storage/server-config')
    const settings = await mod.getUserSettings(user)
    if (settings.searchProvider === 'tavily' && settings.searchApiKey) {
      searchApiKey = settings.searchApiKey
    }
  } catch (err) {
    console.warn(
      '[opencode] getUserSettings for mcp failed, web-search MCP will be disabled:',
      (err as Error)?.message,
    )
    return null
  }
  if (!searchApiKey) return null

  // 用 tsx 直跑 .ts 源码——主项目 deps 已经有 tsx，省一个 build 步骤；同事拉新代码
  // 不需要额外构建就能用。如果将来要发布到 prod 镜像里，再切到 dist/index.js。
  const repoRoot = process.cwd()
  const entry = path.join(repoRoot, 'tools', 'mcp-web-search', 'index.ts')
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx')
  return {
    mcp: {
      'web-search': {
        type: 'local',
        command: [tsxBin, entry],
        environment: { TAVILY_API_KEY: searchApiKey },
        enabled: true,
        timeout: 10_000,
      },
    },
    // 只 hash 一段简短 seed，apiKey 变化会触发 spawn 重启
    hashSeed: `mcp:web-search:tavily:${searchApiKey}`,
  }
}

/**
 * opencode.json 配置级 permission —— 与 buildPermissionsForWorkspace 的 session 级
 * 数组 allow **互补必须同时存在**。opencode 1.14.x 内部对工具调用是 AND 关系：
 * session 级允许 + 进程级 config 默认 'ask' → 仍卡死。我们这边的 backend 没 TTY，
 * 没人响应 permission.asked，tool call 就 silent hang。
 *
 * 这里 allow 的 tool 跟 workspace.ts 的 session 级 allow 一致，避免对不齐：
 *   - read / webfetch / bash: 显式 allow（skill 生成必用 read 看用户项目）
 *   - write / edit 不在这里 allow——继续走 session 级 external_directory 限制，
 *     只能写 workspace 与 /tmp，避免 agent 不小心改用户 project。
 */
const OPENCODE_CONFIG_PERMISSION = {
  tool: {
    read: 'allow' as const,
    webfetch: 'allow' as const,
    bash: 'allow' as const,
  },
}

async function buildIsolatedOpencodeConfig(user: string): Promise<{
  config: unknown
  configHash: string
}> {
  const mcpEntry = await buildBuiltinMcpEntry(user)

  // 把 permission 也算进 hash——之前漏算导致升级 OPENCODE_CONFIG_PERMISSION 时
  // 老 opencode 进程不会被 ensureOpencodeServer 检测到 config 变更, 复用旧实例,
  // 用户必须改 apiKey 或手动重启服务才能拿到新 permission。
  const permissionSeed = JSON.stringify(OPENCODE_CONFIG_PERMISSION)
  // Path 1: DB
  const fromUser = await buildProviderEntryFromUserConfig(user)
  if (fromUser) {
    const cfg: Record<string, unknown> = {
      $schema: 'https://opencode.ai/config.json',
      provider: { [fromUser.providerID]: fromUser.entry },
      plugin: [],
      permission: OPENCODE_CONFIG_PERMISSION,
    }
    if (mcpEntry) cfg.mcp = mcpEntry.mcp
    // hash 包含 apiKey、baseURL、mcp seed、permission——下次 ensure 时检测变更
    const hash = stableHash(
      `${fromUser.providerID}|${fromUser.modelID}|${fromUser.raw.apiKey}|${fromUser.raw.baseURL ?? ''}|${mcpEntry?.hashSeed ?? ''}|${permissionSeed}`,
    )
    console.log(
      `[opencode:${user}] using apiKey from DB UserSettings (provider=${fromUser.providerID}, model=${fromUser.modelID}, mcp=${mcpEntry ? 'web-search' : 'none'})`,
    )
    return { config: cfg, configHash: hash }
  }

  // Path 2: global
  const fromGlobal = readGlobalOpencodeConfigStripped()
  if (fromGlobal) {
    if (mcpEntry) (fromGlobal as Record<string, unknown>).mcp = mcpEntry.mcp
    // 用户全局 opencode.json 没设 permission（或设了但漏 read/webfetch/bash），
    // 我们这里强制覆盖——后端无 TTY 容不下 'ask'，必须显式 allow 才不会死锁。
    ;(fromGlobal as Record<string, unknown>).permission = OPENCODE_CONFIG_PERMISSION
    const hash = stableHash(
      'global:' + JSON.stringify(fromGlobal.provider ?? {}) + '|' + (mcpEntry?.hashSeed ?? '') + '|' + permissionSeed,
    )
    console.log(
      `[opencode:${user}] using apiKey from global ~/.config/opencode/opencode.json (no DB UserSettings found for this user, mcp=${mcpEntry ? 'web-search' : 'none'})`,
    )
    return { config: fromGlobal, configHash: hash }
  }

  // Path 3: minimal fallback —— 这条路 100% 会 401，必然出"空气泡"症状。
  // 大声告警让 caller 立刻知道要做什么，不要让用户对着空 UI 猜半天。
  console.warn(
    `[opencode:${user}] ⚠️  no apiKey found anywhere — opencode will start but every LLM call will 401.\n` +
      `         Fix: open the web UI Settings page, configure an API key for an active model config.\n` +
      `         Or:  set DEEPSEEK_API_KEY / OPENCODE_API_KEY env on dev server.\n` +
      `         Or:  run \`opencode auth login\` to populate ~/.config/opencode/opencode.json.\n` +
      `         Symptom if not fixed: skill-generator reply shows up as an empty bubble.`,
  )
  const fallback: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      deepseek: { options: {}, models: { 'deepseek-reasoner': {}, 'deepseek-chat': {} } },
    },
    plugin: [],
    permission: OPENCODE_CONFIG_PERMISSION,
  }
  if (mcpEntry) fallback.mcp = mcpEntry.mcp
  return {
    config: fallback,
    configHash: 'minimal' + (mcpEntry ? ':' + mcpEntry.hashSeed : '') + '|' + permissionSeed,
  }
}

/**
 * 给 spawn 出来的 opencode 子进程准备一个"干净"的 HOME 目录,屏蔽 user 全局 skill。
 *
 * opencode 启动时会扫 6 个路径加载 skill 到 available_skills 注入到 LLM 上下文:
 *   ~/.config/opencode/skills/   ← XDG_CONFIG_HOME 控制 (已被 prepareIsolatedXdgConfigHome 隔)
 *   ~/.claude/skills/             ← HOME 控制 ★
 *   ~/.agents/skills/             ← HOME 控制 ★
 *   <cwd>/.opencode/skills/       ← cwd (chat payload directory) 控制
 *   <cwd>/.claude/skills/         ← 同上
 *   <cwd>/.agents/skills/         ← 同上
 *
 * 本函数处理 ★ 两条 HOME-relative 路径。spawn 时把 HOME 改到隔离目录,这两个目录就空了。
 * 项目级路径 (<cwd>/...) 由 caller 通过 chat payload 的 directory 字段 + skill-workspace-deployer
 * 按需 deploy 控制 (workspace 里只放本次需要的 skill)。
 *
 * 隔离 HOME 目录结构:
 *   <project>/data/.opencode-runtime/<slug>/isolated-home-<key>/
 *   ├── .opencode/
 *   │   ├── plugins/Witty-Skill-Insight.ts → symlink (trace 上报,如 user HOME 下存在)
 *   │   └── skills/                            (空 - opencode 扫不到)
 *   ├── .claude/skills/                        (空)
 *   └── .agents/skills/                        (空)
 *
 * 配合 spawn 时的 env:
 *   HOME            = <隔离 home>            ← 屏蔽 ~/.claude/skills + ~/.agents/skills
 *   XDG_CONFIG_HOME = <xdgRoot>              ← 屏蔽 ~/.config/opencode/skills (已有)
 *
 * 返回 cleanup,caller 在 try/finally 调用清理临时目录。
 *
 * 设计取舍:
 *   - 用 symlink 而非 copy plugin: 改 plugin 内容立即生效,且零 IO。symlink 跨 OS:
 *     mac/linux 支持,windows 不支持 (但生产部署 linux,dev mac, 不踩坑)。
 *   - cleanup 异步,失败不抛 (避免遮蔽 fn 真错误)。
 *   - 短时残留: 进程崩了 cleanup 没跑会留临时目录。可定期清理,或重启时 prune。
 */
export async function prepareIsolatedHome(
  user: string,
  opts?: { key?: string },
): Promise<{ isolatedHome: string; cleanup: () => Promise<void> }> {
  const slug = userToSlug(user)
  const key = opts?.key || `eph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const root = path.join(process.cwd(), 'data', '.opencode-runtime', slug, `isolated-home-${key}`)

  // 创建 4 个空目录, 确保 opencode 扫到的 user skill 列表是空
  // (即使空目录 opencode 扫也 OK, 没有 SKILL.md 就算 0 个 skill)
  fs.mkdirSync(path.join(root, '.opencode', 'plugins'), { recursive: true })
  fs.mkdirSync(path.join(root, '.opencode', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(root, '.agents', 'skills'), { recursive: true })

  // Symlink user 真实的 trace 上报 plugin (~/.opencode/plugins/Witty-Skill-Insight.ts)
  // 到隔离 HOME 下的 .opencode/plugins/, 保留 trace 上报链路。
  // user HOME 下没装 plugin 时不报错, evaluator session 不会被上报 (用户 / 业务方
  // 默认可接受 — evaluator 是内部细节, 看不看到都不影响主流程)。
  const realPlugin = path.join(os.homedir(), '.opencode', 'plugins', 'Witty-Skill-Insight.ts')
  if (fs.existsSync(realPlugin)) {
    const linkTarget = path.join(root, '.opencode', 'plugins', 'Witty-Skill-Insight.ts')
    try {
      // 已存在 (重入或残留) 先删
      try { fs.unlinkSync(linkTarget) } catch { /* ok */ }
      fs.symlinkSync(realPlugin, linkTarget)
    } catch (e) {
      // 不支持 symlink (如 win) 或权限问题 -> fallback 复制
      try {
        fs.copyFileSync(realPlugin, linkTarget)
      } catch (copyErr) {
        console.warn(`[isolated-home] attach plugin failed (symlink+copy 都失败): ${(copyErr as Error)?.message}`)
      }
    }
  } else {
    console.log(`[isolated-home] real plugin not at ${realPlugin}, evaluator session 不会被 trace 上报 (符合预期)`)
  }

  return {
    isolatedHome: root,
    cleanup: async () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch (e) {
        console.warn(`[isolated-home] cleanup failed for ${root}: ${(e as Error)?.message}`)
      }
    },
  }
}

async function prepareIsolatedXdgConfigHome(user: string): Promise<{
  xdgRoot: string
  configHash: string
}> {
  const slug = userToSlug(user)
  const root = path.join(process.cwd(), 'data', '.opencode-runtime', slug)
  const cfgDir = path.join(root, 'opencode')
  fs.mkdirSync(cfgDir, { recursive: true })
  const cfgPath = path.join(cfgDir, 'opencode.json')
  const { config, configHash } = await buildIsolatedOpencodeConfig(user)
  // 每次启动重写一遍，让用户在 UI 改 apiKey 后下次 spawn 立即生效。
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2))
  return { xdgRoot: root, configHash }
}

/**
 * 给 spawn 出来的 opencode 进程组发信号。proc 是用 `detached: true` 起的，所以它的
 * pid 同时是进程组 id；负数 pid 让 process.kill 把信号广播到整组——能一并打到
 * npm 包装层（node bin/opencode）+ 它 spawnSync 出的真二进制（.opencode）。
 *
 * 没有 detached 时 process.kill(-pid) 通常会 EPERM/ESRCH——所以必须配合 startServerForUser
 * 那边的 detached:true 一起用。
 */
function killOpencodeProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (proc.exitCode !== null || typeof proc.pid !== 'number') return
  try {
    process.kill(-proc.pid, signal)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ESRCH') {
      // 进程组已经空了——属于"已经死了"，不需要再做任何事。
      return
    }
    // 兜底：直接打 pid（即便 group 路径异常，至少把 wrapper 干掉一次）。
    try {
      proc.kill(signal)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 探测进程组是否还有活的成员。signal 0 不发实际信号，仅做存在性检查：
 *   - ESRCH = 组里一个进程都没了
 *   - EPERM = 有进程但当前 uid 没权限发——按"还活着"处理
 *   - 成功（不抛）= 至少一个成员还在
 *
 * 关键：即使 group leader（npm wrapper）已经退出+被 reap，只要 .opencode 真二进制还活着，
 * pgid 就还在，这个检查就会返回 true。.opencode 被 launchd/init 收养（PPID=1）也不影响
 * pgid——这正是我们要的语义。
 */
function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return code !== 'ESRCH'
  }
}

/**
 * Graceful-then-forceful 终止整个进程组。SIGTERM → 轮询 3s → 还有成员就 SIGKILL → 再轮询 2s。
 * 返回的 promise 在进程组真的清空之后才 resolve——caller 可以放心 spawn 新实例。
 *
 * 为什么必须轮询进程组、不能只 wait 'exit' 事件：
 *   ChildProcess 'exit' 只反映 npm wrapper 死没死。SIGTERM 把 wrapper 干掉是秒级事件，
 *   但它 spawnSync 出来的真二进制 .opencode（Go/Bun 编译产物，常不响应 SIGTERM）会留下
 *   变孤儿（PPID=1）。如果按 wrapper 的 exit 事件就 resolve，SIGKILL 兜底永远不会触发，
 *   也就回到了 fix 前的 bug：next-server 跟老实例的 SSE 长连接永远不断、前端 spinner 永久转圈。
 *   只有"整组退场"才是真正"老实例已经死透"。
 */
async function terminateOpencodeProcess(
  proc: ChildProcess,
  label: string,
): Promise<void> {
  const pgid = proc.pid
  if (typeof pgid !== 'number') return
  if (proc.exitCode !== null && !processGroupExists(pgid)) return

  killOpencodeProcessTree(proc, 'SIGTERM')

  const tickMs = 50
  const sigtermDeadline = Date.now() + 3000
  while (Date.now() < sigtermDeadline) {
    if (!processGroupExists(pgid)) return
    await new Promise<void>((r) => setTimeout(r, tickMs))
  }

  console.warn(
    `[opencode] ${label}: 进程组 SIGTERM 3s 仍未退场，发 SIGKILL 兜底（pgid=${pgid}）`,
  )
  killOpencodeProcessTree(proc, 'SIGKILL')

  const sigkillDeadline = Date.now() + 2000
  while (Date.now() < sigkillDeadline) {
    if (!processGroupExists(pgid)) return
    await new Promise<void>((r) => setTimeout(r, tickMs))
  }

  console.error(
    `[opencode] ${label}: SIGKILL 后进程组仍存在（pgid=${pgid}）—— 可能是僵尸或权限问题，` +
      `caller 仍会继续 spawn 新实例，请人工检查 ps`,
  )
}

/**
 * 给本次 spawn 的 opencode 子进程拼出"上报目标"的 env 覆盖。
 *
 * 解决的问题: opencode plugin (Witty-Skill-Insight.ts) 用 SKILL_INSIGHT_HOST / SKILL_INSIGHT_API_KEY
 * 决定数据上报到哪台 server / 归到哪个 user。这两个值的解析顺序是 process.env > ~/.skill-insight/.env。
 * 用户机器上 ~/.skill-insight/.env 通常装着远端服务器地址 + 用户自己的 api key
 * (适用于他们手动跑 opencode CLI 时把数据传到远端 dashboard 的场景)。
 *
 * 但本地 next.js 平台 spawn 的 opencode (跑 skill 生成/评测一类内部系统任务) 不应该把数据
 * 上报到那个远端 dashboard ——那是另一个机器的数据,系统任务数据应该归本机 DB + 归触发 user。
 * 之前 spawn 时只继承 process.env 没显式覆盖, 等于让全局上报地址生效, 系统任务数据
 * 飞到了远端服务器, 本地 trace 列表完全看不到。
 *
 * 这里强制注入两个值:
 *   - SKILL_INSIGHT_HOST = http://127.0.0.1:{PORT}    本机 next.js 自身
 *   - SKILL_INSIGHT_API_KEY = 触发 user 自己的 api key 锁数据归属
 *
 * 用户手动跑 opencode CLI 不走这里, 仍按 ~/.skill-insight/.env 走, 行为不变。
 */
async function buildPluginUploadEnvOverride(user: string): Promise<Record<string, string>> {
  const overrides: Record<string, string> = {}
  // host: 优先环境变量 (部署侧 PORT), 缺省 3000
  const localPort = process.env.PORT || process.env.NEXT_PORT || '3000'
  overrides.SKILL_INSIGHT_HOST = `http://127.0.0.1:${localPort}`
  // api key: 查触发 user 在 DB 里登记的 apiKey, 让 plugin 上报数据时归这个 user
  try {
    const u = (await db.findUserByUsername(user)) as { apiKey?: string } | null
    if (u?.apiKey) {
      overrides.SKILL_INSIGHT_API_KEY = u.apiKey
    } else {
      console.warn(
        `[opencode:${user}] user not in DB or has no apiKey — plugin 数据将仍按 process.env / ~/.skill-insight/.env 走, 可能归属错误`,
      )
    }
  } catch (e) {
    console.warn(
      `[opencode:${user}] failed to look up user apiKey for plugin upload override:`,
      (e as Error)?.message || e,
    )
  }
  return overrides
}

async function startServerForUser(
  user: string,
  opts: {
    /** 是否把 opencode 的 stdout/stderr 转发到当前进程 stderr,默认 false。 */
    verbose?: boolean
    /**
     * 覆盖 spawn 时的 HOME 环境变量, 用于 evaluator 等场景隔离 user HOME 下的 skill
     * (~/.claude/skills/ + ~/.agents/skills/)。caller 通过 prepareIsolatedHome 准备
     * 一个空 HOME 目录, 把绝对路径传进来。
     *
     * 不传 = 用 process.env.HOME (默认行为, ensureOpencodeServer 复用路径用)。
     */
    homeOverride?: string
  },
): Promise<SingleServer> {
  const { verbose = false, homeOverride } = opts
  const port = await getOpenPort()
  const binary = resolveOpencodeBinary()
  const { xdgRoot, configHash: baseConfigHash } = await prepareIsolatedXdgConfigHome(user)
  const pluginUploadEnv = await buildPluginUploadEnvOverride(user)
  // 把 plugin upload 用的 apiKey 也算进 hash —— user 在 UI 改 apiKey 后老实例
  // 会继续用旧 key 上报数据,被 /api/ingest/upload 401 reject,数据丢失。新 hash
  // 触发 ensureOpencodeServer 重启实例,新进程拿新 apiKey。
  const configHash = baseConfigHash + '|upload:' + (pluginUploadEnv.SKILL_INSIGHT_API_KEY || 'no-key')

  const proc = spawn(
    binary,
    [
      'serve',
      '--port',
      String(port),
      '--print-logs',
      '--log-level',
      'WARN',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 关键:用 home 作为中性 cwd,目录由 x-opencode-directory header 控制。
      cwd: os.homedir(),
      // 让子进程成为新进程组的 leader。重启时可以用 process.kill(-pid, sig)
      // 把整组（npm 包装层 node + 它 spawnSync 出的真二进制 .opencode）一起带走。
      // node_modules/opencode-ai/bin/opencode 是个 node 脚本，自己被 SIGTERM 时
      // 不会把它 spawnSync 出的 .opencode 子进程一起带走——只有进程组 kill 才行。
      // 不调 .unref()——我们仍然要 wait child 的 exit 事件，event loop 不能 detach。
      detached: true,
      env: {
        ...process.env,
        OPENCODE_PORT: String(port),
        // 屏蔽用户全局 ~/.config/opencode/ 下的配置/插件。详见 prepareIsolatedXdgConfigHome 注释。
        XDG_CONFIG_HOME: xdgRoot,
        // 隔离模式下覆盖 HOME, opencode 扫 ~/.claude/skills + ~/.agents/skills 时看到空
        // (详见 prepareIsolatedHome 注释)。
        ...(homeOverride ? { HOME: homeOverride } : {}),
        // 强制让 plugin 上报到本机 + 归属触发 user (详见 buildPluginUploadEnvOverride 注释)
        ...pluginUploadEnv,
      },
    },
  )

  // 转发日志(可选)。生产环境可以写到文件。
  if (verbose) {
    proc.stdout?.on('data', (b: Buffer) =>
      process.stderr.write(`[opencode:${user}] ${b.toString()}`),
    )
    proc.stderr?.on('data', (b: Buffer) =>
      process.stderr.write(`[opencode:${user}] ${b.toString()}`),
    )
  } else {
    // 即使不转发日志也必须消费 pipe，否则父进程不读 → ~64KB pipe buffer 撑满 →
    // opencode 真二进制 (Go) 内部 write(2) syscall 被 OS 阻塞 → 整个 server 进程冻死，
    // 现象就是"跑一段时间 opencode 卡死、HTTP/SSE 全不响应"。.resume() 把数据丢到
    // 黑洞，buffer 始终空，不会回压。stdio:'ignore' 不行——必须 'pipe' 才能继承 plugin
    // 上报相关的 stdin/stdout 协议；只是不能让它 piped 后没人读。
    proc.stdout?.resume()
    proc.stderr?.resume()
  }

  // 关键:server 进程崩了或主动退出后,清空 map 中对应条目，下次请求会自动 respawn。
  proc.on('exit', (code, signal) => {
    const current = state.servers.get(user)
    if (current?.process === proc) {
      console.error(
        `\n[opencode:${user}] server exited (code=${code}, signal=${signal})`,
      )
      state.servers.delete(user)
    }
  })

  proc.on('error', (err) => {
    console.error(`[opencode:${user}] failed to spawn server:`, err.message)
  })

  // 等 server ready,失败时杀掉进程
  try {
    await waitForServer(port)
  } catch (err) {
    proc.kill('SIGTERM')
    throw err
  }

  return {
    process: proc,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    user,
    configHash,
    startedAt: Date.now(),
  }
}

/**
 * 确保指定 user 的 opencode-server 起来。多用户场景下每个 user 独立实例（apiKey 互不污染）；
 * 不传 user 时使用 ANONYMOUS_USER_KEY 走兼容路径（main.ts CLI demo 等）。
 *
 * 检测到 configHash 变了（用户在 UI 改了 apiKey）会先停旧实例再起新的——下一次请求用新 key。
 *
 * 并发安全：同一 user 多个并发 ensure 调用通过 startingServers map 去重共享一个 in-flight promise。
 */
export async function ensureOpencodeServer(
  opts: {
    user?: string
    verbose?: boolean
  } = {},
): Promise<string> {
  const userKey = opts.user || ANONYMOUS_USER_KEY

  // 检查现有实例是否仍可用 + 配置是否还匹配
  const existing = state.servers.get(userKey)
  if (existing && existing.process.exitCode === null) {
    // 静默对照配置 hash——如果用户在 UI 改了 apiKey，老实例的 configHash 会和重新计算的不一致，
    // 此时先 graceful-then-forceful 干掉老实例（含真二进制），下面走 spawn 新的。
    let nextHash: string | null = null
    try {
      const { configHash } = await buildIsolatedOpencodeConfig(userKey)
      nextHash = configHash
    } catch {
      /* ignore，按现有实例继续用 */
    }
    if (nextHash === null || nextHash === existing.configHash) {
      return existing.baseUrl
    }
    console.log(
      `[opencode:${userKey}] config changed (hash ${existing.configHash} → ${nextHash}), restarting instance`,
    )
    state.servers.delete(userKey)
    // 必须等老实例（连同它 spawn 出的真 opencode 二进制）彻底死透再 spawn 新的，
    // 否则旧二进制变孤儿（PPID=1），next-server 跟它的 SSE 长连接永远不会断，
    // 用户 in-flight 请求永远收不到响应。详见 terminateOpencodeProcess 注释。
    await terminateOpencodeProcess(existing.process, `config-change restart for ${userKey}`)
  }

  // 复用 in-flight spawn
  const inflight = state.startingServers.get(userKey)
  if (inflight) {
    const srv = await inflight
    return srv.baseUrl
  }

  const starting = startServerForUser(userKey, opts)
  state.startingServers.set(userKey, starting)
  try {
    const srv = await starting
    state.servers.set(userKey, srv)
    // 起新进程 → 代次 +1。旧进程内存里的 session ID 在新进程里都不认识，
    // caller 用代次戳跟"现存代次"对比能立刻识破失效缓存。
    state.generations.set(userKey, (state.generations.get(userKey) ?? 0) + 1)
    return srv.baseUrl
  } finally {
    if (state.startingServers.get(userKey) === starting) {
      state.startingServers.delete(userKey)
    }
  }
}

/**
 * 优雅关闭某个 user 的 server（进程退出时调用，或测试里手动 reset）。
 * 5 秒后强杀作为兜底。不传 user 时关掉所有实例（保持向后兼容旧 caller）。
 */
export async function stopOpencodeServer(user?: string): Promise<void> {
  if (user) {
    await stopOneServer(user)
    return
  }
  // 全停
  const users = Array.from(state.servers.keys())
  await Promise.all(users.map((u) => stopOneServer(u)))
}

async function stopOneServer(user: string): Promise<void> {
  const inst = state.servers.get(user)
  if (!inst) return
  state.servers.delete(user)
  const { process: proc } = inst
  if (proc.exitCode !== null) return
  proc.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* 已经死了 */
      }
      resolve()
    }, 5000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * 注册进程退出钩子，dev server 关闭时把所有 opencode 子进程一并带走。
 *
 * 历史问题：stopOpencodeServer 之前定义了但没人调用——dev server Ctrl+C 之后
 * opencode 仍在跑变孤儿，下次启动又起一个，几小时后 ps aux 一堆 opencode 进程占
 * 着端口和内存。
 *
 * 信号语义：
 *   - 'exit'  Node 准备退出（正常完成 / process.exit / 信号被 Next.js 默认 handler 转发）。
 *             同步钩子，只能做 SIGTERM kill，不能 await 5s grace。
 *   - SIGINT/SIGTERM  额外早一拍发 SIGTERM，给 opencode 多 100~200ms 收尾。
 *                     handler 不调 process.exit——让 Next.js 自己的 graceful shutdown 跑完。
 *
 * 多次调用幂等（HMR 重复注册，或 Next.js 13+ multi-call register()）。
 */
let exitHandlersRegistered = false
export function registerExitHandlers(): void {
  if (exitHandlersRegistered) return
  exitHandlersRegistered = true

  const killAll = (): void => {
    for (const inst of state.servers.values()) {
      if (inst.process.exitCode === null) {
        try {
          inst.process.kill('SIGTERM')
        } catch {
          /* 已经死了 */
        }
      }
    }
  }

  process.on('exit', killAll)
  process.on('SIGINT', killAll)
  process.on('SIGTERM', killAll)
}

/** 调试用:返回指定 user 的 server baseUrl，不传 user 时返回任意一个（兼容老 caller）。 */
export function getServerUrl(user?: string): string | null {
  if (user) return state.servers.get(user)?.baseUrl ?? null
  const first = state.servers.values().next().value
  return first?.baseUrl ?? null
}

/** 调试用：当前活跃实例数。 */
export function getActiveServerCount(): number {
  return state.servers.size
}

/**
 * Per-task ephemeral opencode 进程: 每次 spawn 独立实例 → 跑 fn → finally 杀。
 *
 * 跟 ensureOpencodeServer 的区别:
 *   - ensureOpencodeServer: per-user 长驻复用,启动时凝固 skill / 自定义 agent / plugin /
 *     provider config —— 用户编辑这些东西后,旧实例不会自动 reload,需要手动重启。
 *   - runWithEphemeralOpencodeServer: per-call 新启进程,fn 跑完立即 SIGTERM (→ 5s SIGKILL 兜底)。
 *     保证每个后台任务都用最新 skill,杜绝跨 task 的软污染 (plugin 全局状态 / provider 缓存等)。
 *
 * 代价:
 *   - 冷启动 +3-10s / 任务 (spawn + plugin 加载 + healthcheck)
 *   - 内存峰值 ~50-100MB × 并发任务数 (默认上限 5,所以 ~250-500MB)
 *
 * 适用场景: 后台评测 / A·B 灰度等"对正确性比对时延敏感"的任务。用户实时对话 (如
 * skill-generator-bridge) 仍走 ensureOpencodeServer 复用,因为用户在等回复,冷启动延迟
 * 会让用户体验恶化。
 *
 * 注意: 这里**不进 state.servers map** —— ephemeral 实例不被任何代码持有引用,杀完即弃。
 * 因此 dashboard "opencode 实例" 列表大部分时间是空的 (短暂任务峰值时才会一闪而过)。
 */
export async function runWithEphemeralOpencodeServer<T>(
  opts: {
    user?: string
    verbose?: boolean
    /**
     * true: 启用 HOME 隔离, opencode 看不到 user HOME 下的 skill (~/.claude/skills/ +
     *       ~/.agents/skills/) 和插件 (~/.opencode/plugins/ 除 Witty-Skill-Insight 外)。
     *       但 Witty-Skill-Insight.ts plugin 会自动 symlink 到隔离 HOME, trace 上报链路保留。
     *       用于后台评测 (evaluator / grayscale / trigger) 等"内部任务",避免被 user skill 污染。
     * false (默认): 用 process.env.HOME, opencode 能看到 user 所有 skill / plugin。
     *               用于"用户实时对话"等需要看到 user skill 的场景 (skill-generator 等)。
     */
    isolateHome?: boolean
  },
  fn: (serverUrl: string) => Promise<T>,
): Promise<T> {
  const userKey = opts.user || ANONYMOUS_USER_KEY
  const verbose = opts.verbose ?? false
  // 准备隔离 HOME (如启用), 拿 cleanup 在 finally 里调
  let homeCleanup: (() => Promise<void>) | null = null
  let homeOverride: string | undefined = undefined
  if (opts.isolateHome) {
    const { isolatedHome, cleanup } = await prepareIsolatedHome(userKey)
    homeOverride = isolatedHome
    homeCleanup = cleanup
  }
  // 注意: 直接调内部 startServerForUser 不走 cache, 也不写 state.servers。
  // 多个 ephemeral 调用并发时各自起独立进程,互不复用,自然隔离。
  const inst = await startServerForUser(userKey, { verbose, homeOverride })
  try {
    return await fn(inst.baseUrl)
  } finally {
    try {
      await terminateOpencodeProcess(inst.process, `ephemeral cleanup for ${userKey}`)
    } catch (cleanupErr) {
      // cleanup 失败不应该掩盖 fn 的真错误,只 warn 不抛
      console.warn(
        `[opencode] ephemeral cleanup for ${userKey} failed:`,
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      )
    }
    // 隔离 HOME 临时目录在 server 死透之后清, 避免 server 还在引用文件被 unlink
    if (homeCleanup) {
      await homeCleanup()
    }
  }
}

/**
 * Dashboard / debug 用：当前所有活跃 opencode 实例的快照。不会暴露 ChildProcess 句柄,
 * 只导出可序列化的可观测字段:user、PID、port、startedAt、uptime、是否已 exit。
 *
 * 注意: 后台任务从 v0.7 起走 runWithEphemeralOpencodeServer 模式 (per-task spawn-and-kill),
 * 不进 state.servers map; 这里只列出 ensureOpencodeServer 复用模式下持有的实例 (典型场景:
 * skill-generator-bridge 的用户实时对话)。大部分时间这个列表是空的。
 */
export function getOpencodeServersSnapshot(): Array<{
  user: string
  pid: number | null
  port: number
  baseUrl: string
  startedAt: number
  uptimeMs: number
  exitCode: number | null
}> {
  const now = Date.now()
  return Array.from(state.servers.entries()).map(([userKey, srv]) => ({
    user: userKey,
    pid: srv.process.pid ?? null,
    port: srv.port,
    baseUrl: srv.baseUrl,
    startedAt: srv.startedAt,
    uptimeMs: Math.max(0, now - srv.startedAt),
    exitCode: srv.process.exitCode,
  }))
}
