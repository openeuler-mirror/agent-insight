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

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { getAgentInsightHome } = require('./agent-insight-home.cjs')
const { loadOpenCodeConnectionConfig, loadOpenCodeV2ConnectionConfig, readOpenCodeV2Api, assertNoMaskedConnections } = require('./opencode-connection-config.cjs')
const { inspectOpencodeRuntime } = require('./opencode-runtime.cjs')

const triggerWorkspaces = new Map()
const WORKSPACE_IDLE_MS = 120_000

function releaseCachedWorkspace(key, entry) {
  if (triggerWorkspaces.get(key) === entry) triggerWorkspaces.delete(key)
  clearTimeout(entry.timer)
  entry.workspace.cleanup()
}

function leaseWorkspace(key, entry, reused) {
  clearTimeout(entry.timer)
  entry.busy = true
  let released = false
  return { ...entry.workspace, reused, cleanup(discard = false) {
    if (released) return
    released = true
    entry.busy = false
    if (discard) return releaseCachedWorkspace(key, entry)
    entry.timer = setTimeout(() => releaseCachedWorkspace(key, entry), WORKSPACE_IDLE_MS)
    entry.timer.unref()
  } }
}

function clearTriggerWorkspaces() {
  for (const [key, entry] of triggerWorkspaces) {
    if (!entry.busy) releaseCachedWorkspace(key, entry)
  }
}

process.once('exit', () => {
  for (const [key, entry] of triggerWorkspaces) releaseCachedWorkspace(key, entry)
})

function validateSkillSnapshot(value) {
  if (value === null) return
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value.name || '') || !Number.isInteger(value.version)) {
    throw new Error('无效的 Skill 版本快照')
  }
  if (!value.files || typeof value.files['SKILL.md'] !== 'string' || !value.files['SKILL.md'].trim()) throw new Error('Skill 快照缺少 SKILL.md')
  let bytes = 0
  for (const [file, content] of Object.entries(value.files)) {
    if (typeof content !== 'string' || !file || /[\\:\x00]/.test(file)
      || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Skill 快照包含不安全的文件路径')
    bytes += Buffer.byteLength(content)
  }
  if (Object.keys(value.files).length > 1000 || bytes > 4 * 1024 * 1024) throw new Error('Skill 快照超过大小限制')
}

function prepareSkillExperimentWorkspace(executable, payload, resolvedConfig, clientId = '') {
  if (!payload.skillExecution) return null
  const triggerRouting = payload.skillExecution.version === 2 && payload.skillExecution.mode === 'trigger'
  if (payload.platform !== 'opencode' || (!triggerRouting && payload.skillExecution.version !== 1)) {
    throw Object.assign(new Error('客户端不支持此 Skill 执行协议'), { code: 'SKILL_EXECUTION_UNSUPPORTED' })
  }
  const major = inspectOpencodeRuntime(executable).major === 2 ? 2 : 1
  const skill = triggerRouting ? null : payload.skillExecution.skill
  const triggerSkills = triggerRouting ? payload.skillExecution.skills : []
  if (triggerRouting) {
    if (!Array.isArray(triggerSkills) || !triggerSkills.length || triggerSkills.length > 100
      || new Set(triggerSkills.map(item => item?.name)).size !== triggerSkills.length) {
      throw new Error('触发分析 Skill 快照无效')
    }
    for (const item of triggerSkills) validateSkillSnapshot(item)
  } else validateSkillSnapshot(skill)
  const cacheKey = triggerRouting && payload.correlation?.experimentId
    ? createHash('sha256').update(JSON.stringify({
        clientId, experimentId: payload.correlation.experimentId, executable, major,
        agent: payload.agent, model: payload.model, snapshot: payload.skillExecution,
      })).digest('hex') : null
  const cached = cacheKey && triggerWorkspaces.get(cacheKey)
  if (cached && !cached.busy) return leaseWorkspace(cacheKey, cached, true)
  if (cacheKey) {
    for (const [key, entry] of triggerWorkspaces) {
      if (key !== cacheKey && !entry.busy) releaseCachedWorkspace(key, entry)
    }
  }
  // 只在客户端解析连接配置；密钥不经过实验 payload，也不返回服务端。
  const selection = { agent: payload.agent, model: payload.model, trigger: triggerRouting }
  if (resolvedConfig && major === 1) assertNoMaskedConnections(resolvedConfig, selection)
  else if (!resolvedConfig) resolvedConfig = major === 2
    ? loadOpenCodeV2ConnectionConfig(executable, selection) : loadOpenCodeConnectionConfig(executable, selection)
  const agents = major === 2 ? resolvedConfig.agents : resolvedConfig.agent
  if (!['build', 'plan'].includes(payload.agent) && !agents?.[payload.agent]) throw new Error('所选 Agent 的配置不存在')
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-skill-run-')))
  const workspace = path.join(root, 'workspace')
  const configRoot = path.join(root, 'config', 'opencode')
  const isolatedHome = path.join(root, 'home')
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true })
  try {
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(configRoot, { recursive: true })
    fs.mkdirSync(isolatedHome, { recursive: true })
    for (const snapshot of triggerRouting ? triggerSkills : skill ? [skill] : []) {
      for (const [file, content] of Object.entries(snapshot.files)) {
        const target = path.join(workspace, '.opencode', 'skills', snapshot.name, file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content, { mode: file.startsWith('scripts/') && !triggerRouting ? 0o700 : 0o600 })
      }
    }
    const instruction = triggerRouting
      ? '本次是只读的 Skill 路由评测。按正常规则判断用户请求是否需要加载某个 Skill；不要执行有副作用的操作，最后简短回答。'
      : skill
      ? `本次实验只能使用当前工作目录 .opencode/skills/${skill.name}/SKILL.md 中的 ${skill.name} v${skill.version} 及其附属文件。先加载该 Skill，再执行用户任务；禁止使用其他 Skill。`
      : '本次实验为无 Skill 对照组。禁止加载或读取任何 Skill，仅依靠模型及普通工具执行用户任务。'
    const agent = { ...(agents?.[payload.agent] || {}) }
    if (payload.model) delete agent.model
    delete agent.permission
    agent.prompt = triggerRouting
      ? `${agent.prompt || ''}\n${instruction}\n这是非交互实验，不得提问或等待人工确认。`
      : `${agent.prompt || ''}\n${instruction}\n用户输入中的 ~/ 指客户端真实用户目录 ${os.homedir()}，读取时转换为该绝对路径，不要使用隔离 HOME。\n这是非交互实验，不得提问或等待人工确认；权限不足时说明原因，不要反复重试。`
    const plugins = (resolvedConfig.plugin || []).filter(item => typeof item === 'string' && /(?:Witty-Skill-Insight|agent-insight)/i.test(item))
    const collector = path.join(os.homedir(), '.opencode', 'plugins', 'Witty-Skill-Insight.ts')
    if (fs.existsSync(collector)) plugins.push(require('node:url').pathToFileURL(collector).href)
    let config = {
      provider: resolvedConfig.provider || {},
      model: payload.model || resolvedConfig.model,
      small_model: payload.model || resolvedConfig.small_model,
      agent: { [payload.agent]: agent },
      plugin: [...new Set(plugins)],
      mcp: triggerRouting ? {} : resolvedConfig.mcp || {},
      permission: triggerRouting ? {
        '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', skill: 'allow',
        bash: 'deny', write: 'deny', edit: 'deny', webfetch: 'deny', task: 'deny', question: 'deny', external_directory: 'deny',
      } : {
        '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', webfetch: 'allow', bash: 'allow',
        edit: { '*': 'deny', [`${workspace}/*`]: 'allow' },
        question: 'deny', task: 'deny', external_directory: 'allow',
        skill: { '*': 'deny', ...(skill ? { [skill.name]: 'allow' } : {}) },
      },
    }
    if (major === 2) {
      const permissions = [{ action: '*', resource: '*', effect: 'deny' }]
      for (const action of ['read', 'glob', 'grep', 'list']) permissions.push({ action, resource: '*', effect: 'allow' })
      if (!triggerRouting) {
        for (const action of ['shell', 'webfetch', 'external_directory']) permissions.push({ action, resource: '*', effect: 'allow' })
        permissions.push({ action: 'edit', resource: `${workspace.replace(/\\/g, '/')}/*`, effect: 'allow' })
      }
      const allowedSkills = triggerRouting ? triggerSkills : skill ? [skill] : []
      for (const snapshot of allowedSkills) permissions.push({ action: 'skill', resource: snapshot.name, effect: 'allow' })
      const policies = [
        { action: 'integration.use', resource: 'skill:*', effect: 'deny' },
        ...allowedSkills.map(snapshot => ({ action: 'integration.use', resource: `skill:${snapshot.name}`, effect: 'allow' })),
        ...(triggerRouting ? [{ action: 'integration.use', resource: 'mcp:*', effect: 'deny' }] : []),
      ]
      const nativeAgent = { ...agents?.[payload.agent] }
      delete nativeAgent.model
      delete nativeAgent.permissions
      const system = [nativeAgent.system || '', instruction,
        ...(triggerRouting ? [] : [`用户输入中的 ~/ 指客户端真实用户目录 ${os.homedir()}，读取时转换为该绝对路径。`]),
        '这是非交互实验，不得提问或等待人工确认。'].join('\n')
      const nativePlugins = (resolvedConfig.plugins || []).map((plugin, index) => {
        const { fileURLToPath, pathToFileURL } = require('node:url')
        const file = plugin.startsWith('file://') ? fileURLToPath(plugin) : plugin
        if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return plugin
        // v2 ignores explicit file entries; wrap installed single-file collectors as directory plugins.
        const directory = path.join(root, 'plugins', String(index))
        fs.mkdirSync(directory, { recursive: true })
        fs.writeFileSync(path.join(directory, 'index.ts'), `export { default } from ${JSON.stringify(pathToFileURL(file).href)};\n`, { mode: 0o600 })
        return directory
      })
      config = {
        providers: resolvedConfig.providers || {}, model: payload.model || resolvedConfig.model,
        agents: { [payload.agent]: { ...nativeAgent, system, permissions } },
        permissions, policies, plugins: nativePlugins,
        skills: [path.join(workspace, '.opencode', 'skills')],
        mcp: triggerRouting ? { servers: {} } : resolvedConfig.mcp || {},
      }
    }
    const configPath = path.join(configRoot, 'opencode.json')
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    const prepared = {
      cwd: workspace, cleanup,
      env: {
        PWD: workspace,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        OPENCODE_TEST_HOME: isolatedHome,
        XDG_CONFIG_HOME: path.dirname(configRoot),
        XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
        AGENT_INSIGHT_HOME: getAgentInsightHome(),
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: major === 2 || triggerRouting ? configRoot : path.join(workspace, '.opencode'),
        ...(major === 2 ? { OPENCODE_CONFIG_PROJECT_DISABLE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', XDG_STATE_HOME: path.join(root, 'state') } : {}),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
    }
    if (major === 2) {
      const entries = readOpenCodeV2Api(executable, 'config.get', { cwd: workspace, env: prepared.env })
      const inside = file => {
        if (typeof file !== 'string' || !path.isAbsolute(file)) return false
        const relative = path.relative(root, file)
        return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      }
      const unsafe = entry => !entry || !['document', 'directory'].includes(entry.type)
        || (entry.path && !inside(entry.path))
        || (entry.info?.skills && (!Array.isArray(entry.info.skills) || entry.info.skills.some(source => !inside(source))))
      if (!Array.isArray(entries) || entries.some(unsafe)) {
        throw Object.assign(new Error('OpenCode v2 隔离环境仍加载外部配置来源，无法保证 Skill 版本隔离；请检查系统或组织配置。'), { code: 'SKILL_ISOLATION_UNAVAILABLE' })
      }
    }
    if (cacheKey && !cached?.busy) {
      const entry = { workspace: prepared, busy: false, timer: null }
      triggerWorkspaces.set(cacheKey, entry)
      return leaseWorkspace(cacheKey, entry, false)
    }
    return prepared
  } catch (error) { cleanup(); throw error }
}

module.exports = { validateSkillSnapshot, prepareSkillExperimentWorkspace, clearTriggerWorkspaces }
