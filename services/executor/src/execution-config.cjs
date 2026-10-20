'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { loadProjectConfig } = require('./project-config.cjs')
const { artifactIdentity } = require('./xgovernor/artifact-identity.cjs')
const { resolveManagedProfile } = require('./xgovernor/installation.cjs')
const protocolPath = fs.existsSync(path.resolve(__dirname, '../../../packages/benchmark-protocol/execution.cjs'))
  ? path.resolve(__dirname, '../../../packages/benchmark-protocol/execution.cjs') : path.resolve(__dirname, '../packages/benchmark-protocol/execution.cjs')
const protocol = require(protocolPath)
const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false } }

let probeCache
let processConfig
function executionCapabilities(options = {}) {
  const raw = options.config || (processConfig ||= loadProjectConfig('executor').execution)
  const installations = new Map(Object.entries(raw.profiles).map(([key, local]) => [key, resolveManagedProfile(local, {
    env: options.env || process.env, root: options.installationRoot, target: options.target,
  })]))
  const configured = { ...raw, profiles: Object.fromEntries([...installations].map(([key, installed]) => [key, installed.config])) }
  const identities = new Map(Object.entries(configured.profiles).map(([key, local]) => [key, artifactIdentity(local)]))
  const config = { ...configured, profiles: Object.fromEntries(Object.entries(configured.profiles).map(([key, local]) => [key, { ...local, artifactDigest: identities.get(key).digest }])) }
  const env = options.env || process.env
  const fingerprint = protocol.digest({ config, os: options.os || process.platform, credentials: Object.values(config.profiles).flatMap(p => [Boolean(env[p.traceApiKeyEnv]), ...Object.values(p.models).map(m => Boolean(env[m.apiKeyEnv]))]) })
  if (!options.refresh && probeCache?.fingerprint === fingerprint && Date.now() - probeCache.at < 30_000) return probeCache.value
  const profiles = Object.entries(config.profiles).map(([key, local]) => {
    const reasons = []
    reasons.push(...installations.get(key).reasons)
    reasons.push(...identities.get(key).reasons)
    if ((options.os || process.platform) !== 'linux') reasons.push('xGovernor 本地 Docker 执行需要 Linux')
    if (!executable(local.serverExecutable)) reasons.push('请配置可执行的 xGovernor server')
    if (!env[local.traceApiKeyEnv]) reasons.push(`缺少 Trace 上传环境变量 ${local.traceApiKeyEnv}`)
    if (!Object.keys(local.models).length || Object.values(local.models).some(model => !env[model.apiKeyEnv])) reasons.push('模型配置或模型凭据未就绪')
    for (const [platform, runtime] of Object.entries(local.runtimes)) {
      if (!executable(runtime.workerExecutable)) reasons.push(`${platform} worker 未配置`)
      if (runtime.kind === 'pi' && (!executable(runtime.executable) || !runtime.extensionDirectory || !fs.existsSync(runtime.extensionDirectory))) reasons.push('Pi CLI 或桥接扩展未配置')
      if (!['pi', 'xiaoo'].includes(runtime.kind) && !executable(runtime.traceExporter)) reasons.push(`${platform} 完整 Trace 导出器未配置`)
      if (runtime.traceExporter) {
        const check = spawnSync(runtime.traceExporter, ['--describe'], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, env })
        let description
        try { description = JSON.parse(check.stdout) } catch {}
        if (check.status !== 0 || description?.schemaVersion !== 'execution-trace/v1' || description.full !== true || !description.runtimeKinds?.includes(runtime.kind)) reasons.push(`${platform} Trace 导出合同不兼容`)
      }
    }
    if (!reasons.length) {
      const probe = spawnSync(local.dockerExecutable, ['--host', `unix://${local.dockerSocket}`, 'info', '--format', '{{.OSType}} {{.CgroupVersion}}'], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536 })
      if (probe.status !== 0 || probe.stdout.trim() !== 'linux 2') reasons.push('Docker 或 cgroup v2 未就绪')
    }
    return { profile: protocol.describeProfile(key, local), benchmarks: config.bindings.filter(binding => binding.profile === key).flatMap(binding => binding.benchmarks), ready: !reasons.length, ...(reasons.length ? { note: reasons.join('；') } : {}) }
  })
  const value = { profiles, config }
  probeCache = { fingerprint, at: Date.now(), value }
  return value
}

module.exports = { ...protocol, executionCapabilities }
