/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { createHash, randomBytes } = require('crypto')

const MAX_FILES = 1000
const MAX_BYTES = 4 * 1024 * 1024

function deploymentError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temp, file)
}

function normalizedFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw deploymentError('ARTIFACT_INVALID', 'Skill 制品缺少文件集合')
  }
  const out = {}
  let totalBytes = 0
  for (const [rawName, content] of Object.entries(files)) {
    if (typeof content !== 'string') throw deploymentError('ARTIFACT_INVALID', `Skill 文件不是文本: ${rawName}`)
    const name = String(rawName || '').replaceAll('\\', '/')
    const parts = name.split('/')
    if (!name || name.startsWith('/') || /[\x00:]/.test(name)
      || parts.some(part => !part || part === '.' || part === '..')) {
      throw deploymentError('ARTIFACT_PATH_INVALID', `Skill 制品包含不安全路径: ${rawName}`)
    }
    totalBytes += Buffer.byteLength(content)
    if (totalBytes > MAX_BYTES) throw deploymentError('ARTIFACT_TOO_LARGE', 'Skill 制品超过 4 MiB')
    out[name] = content
  }
  if (!Object.keys(out).length || typeof out['SKILL.md'] !== 'string' || !out['SKILL.md'].trim()) {
    throw deploymentError('ARTIFACT_INVALID', 'Skill 制品缺少 SKILL.md')
  }
  if (Object.keys(out).length > MAX_FILES) throw deploymentError('ARTIFACT_TOO_LARGE', 'Skill 制品文件数超过 1000')
  return out
}

function snapshotHash(files) {
  const normalized = Object.entries(normalizedFiles(files))
    .sort(([left], [right]) => left.localeCompare(right))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function assertNoSymlinkPath(target, stopAt) {
  let current = path.resolve(target)
  const stop = path.resolve(stopAt)
  while (isWithin(stop, current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw deploymentError('TARGET_SYMLINK_FORBIDDEN', `部署目标包含符号链接: ${current}`)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (current === stop) break
    current = path.dirname(current)
  }
}

function originRegistryPath(clientHome) {
  return path.join(clientHome, 'skill-origins.json')
}

function registerSkillOrigin(clientHome, input) {
  if (!input || !['opencode', 'pi-agent', 'xiaoo'].includes(input.platform)) {
    throw deploymentError('ORIGIN_INVALID', '不支持的 Skill 来源平台')
  }
  const skillName = String(input.skillName || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(skillName)) {
    throw deploymentError('ORIGIN_INVALID', 'Skill 名称不合法')
  }
  const targetDir = path.resolve(String(input.targetDir || ''))
  const frameworkRoot = path.resolve(String(input.frameworkRoot || ''))
  if (!isWithin(frameworkRoot, targetDir) || targetDir === frameworkRoot) {
    throw deploymentError('ORIGIN_OUTSIDE_ROOT', 'Skill 目标不在框架根目录内')
  }
  const registryFile = originRegistryPath(clientHome)
  const registry = readJson(registryFile, { schemaVersion: 1, origins: {} })
  const digest = createHash('sha256')
    .update([input.platform, frameworkRoot, targetDir, skillName].join('\n'))
    .digest('hex').slice(0, 24)
  const originRef = `origin_${digest}`
  registry.schemaVersion = 1
  registry.origins ||= {}
  registry.origins[originRef] = {
    platform: input.platform,
    skillName,
    frameworkRoot,
    targetDir,
    displayPath: input.displayPath || targetDir,
    observedSkillVersion: Number.isInteger(input.observedSkillVersion) ? input.observedSkillVersion : null,
    observedContentHash: input.observedContentHash || null,
    registeredAt: new Date().toISOString(),
  }
  atomicWriteJson(registryFile, registry)
  return { originRef, ...registry.origins[originRef] }
}

function resolveTarget(clientHome, target, skillName, platform) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(skillName || ''))) {
    throw deploymentError('TARGET_INVALID', 'Skill 名称不合法')
  }
  if (target?.mode === 'framework_global' && platform === 'jiuwenswarm') {
    const dataRoot = path.resolve(process.env.JIUWENSWARM_DATA_DIR || path.join(os.homedir(), '.jiuwenswarm'))
    const frameworkRoot = path.join(dataRoot, 'agent', 'workspace')
    return {
      platform,
      frameworkRoot,
      targetDir: path.join(frameworkRoot, 'skills', skillName),
      metadataRoot: path.join(frameworkRoot, '.agent-insight'),
      displayPath: path.join(frameworkRoot, 'skills', skillName),
    }
  }
  if (target?.mode !== 'execution_origin' || !target.originRef) {
    throw deploymentError('ORIGIN_REQUIRED', '该框架下发需要来源 Trace 的 Skill 定位引用')
  }
  const registry = readJson(originRegistryPath(clientHome), { origins: {} })
  const origin = registry?.origins?.[target.originRef]
  if (!origin || origin.platform !== platform || origin.skillName !== skillName) {
    throw deploymentError('ORIGIN_NOT_FOUND', '来源引用不存在或与 Skill/框架不匹配')
  }
  const frameworkRoot = path.resolve(origin.frameworkRoot)
  const targetDir = path.resolve(origin.targetDir)
  if (!isWithin(frameworkRoot, targetDir) || targetDir === frameworkRoot) {
    throw deploymentError('ORIGIN_OUTSIDE_ROOT', '来源引用已逃逸框架根目录')
  }
  return {
    platform,
    frameworkRoot,
    targetDir,
    metadataRoot: path.join(frameworkRoot, '.agent-insight'),
    displayPath: origin.displayPath || targetDir,
  }
}

function collectDirectoryFiles(root) {
  if (!fs.existsSync(root)) return {}
  const out = {}
  const walk = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.archive' || entry.name === '.agent-insight') continue
      const full = path.join(current, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      const info = fs.lstatSync(full)
      if (info.isSymbolicLink()) throw deploymentError('TARGET_SYMLINK_FORBIDDEN', `Skill 目录包含符号链接: ${rel}`)
      if (info.isDirectory()) walk(full, rel)
      else if (info.isFile()) out[rel] = fs.readFileSync(full, 'utf8')
    }
  }
  walk(root)
  return out
}

function stateFile(target, skillName) {
  return path.join(target.metadataRoot, 'skills', skillName, 'state.json')
}

function inspectCurrent(target, skillName) {
  const state = readJson(stateFile(target, skillName), null)
  if (!fs.existsSync(target.targetDir)) return { exists: false, skillVersion: null, contentHash: null }
  const files = collectDirectoryFiles(target.targetDir)
  const contentHash = Object.keys(files).length ? snapshotHash(files) : null
  return {
    exists: true,
    skillVersion: Number.isInteger(state?.skillVersion) && state?.contentHash === contentHash ? state.skillVersion : null,
    semanticVersion: state?.contentHash === contentHash ? state.semanticVersion || null : null,
    contentHash,
    managed: state?.contentHash === contentHash && state?.managedBy === 'agent-insight',
  }
}

function precheckDeployment(clientHome, payload) {
  const platform = String(payload?.platform || '')
  const skillName = String(payload?.skillName || '')
  const target = resolveTarget(clientHome, payload?.target, skillName, platform)
  assertNoSymlinkPath(target.targetDir, target.frameworkRoot)
  const current = inspectCurrent(target, skillName)
  return {
    platform,
    targetMode: payload.target.mode,
    displayPath: target.displayPath,
    current,
  }
}

function writePayload(stage, files) {
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 })
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(stage, ...relative.split('/'))
    if (!isWithin(stage, target)) throw deploymentError('ARTIFACT_PATH_INVALID', `Skill 路径逃逸: ${relative}`)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, content, { mode: relative.startsWith('scripts/') ? 0o700 : 0o600 })
  }
}

function backupLabel(version, hash, deploymentId, now = new Date()) {
  const prefix = Number.isInteger(version) ? `v${version}` : 'legacy'
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${prefix}__${timestamp}__${String(hash || 'unknown').slice(0, 8)}__${deploymentId}`
}

function installArtifact(clientHome, payload, artifact) {
  const manifest = artifact?.manifest || {}
  const files = normalizedFiles(artifact?.files)
  const skillName = String(manifest.skillName || '')
  const platform = String(payload?.platform || '')
  if (skillName !== payload.skillName || manifest.skillVersion !== payload.skillVersion) {
    throw deploymentError('ARTIFACT_IDENTITY_MISMATCH', 'Skill 制品身份与部署命令不一致')
  }
  const actualHash = snapshotHash(files)
  if (actualHash !== manifest.contentHash || actualHash !== payload.contentHash) {
    throw deploymentError('ARTIFACT_HASH_MISMATCH', 'Skill 制品内容哈希不一致')
  }
  const target = resolveTarget(clientHome, payload.target, skillName, platform)
  assertNoSymlinkPath(target.targetDir, target.frameworkRoot)
  fs.mkdirSync(path.dirname(target.targetDir), { recursive: true, mode: 0o700 })
  fs.mkdirSync(target.metadataRoot, { recursive: true, mode: 0o700 })

  const current = inspectCurrent(target, skillName)
  const expected = payload.expectedCurrent || {}
  if (typeof expected.exists === 'boolean' && expected.exists !== current.exists) {
    throw deploymentError('VERSION_CONFLICT', '客户端当前 Skill 是否存在已在预检后发生变化')
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'contentHash') && expected.contentHash !== current.contentHash) {
    throw deploymentError('VERSION_CONFLICT', '客户端当前 Skill 内容已在预检后发生变化')
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'skillVersion') && expected.skillVersion !== current.skillVersion) {
    throw deploymentError('VERSION_CONFLICT', '客户端当前 Skill 版本已在预检后发生变化')
  }
  if (current.contentHash === actualHash && current.skillVersion === manifest.skillVersion) {
    return { state: 'ALREADY_INSTALLED', installed: current, backup: null, displayPath: target.displayPath }
  }
  if (current.managed && current.skillVersion === manifest.skillVersion && current.contentHash !== actualHash) {
    throw deploymentError('VERSION_CONTENT_CONFLICT', '同一 Skill 版本对应的内容哈希不一致')
  }

  const stage = path.join(path.dirname(target.targetDir), `.${skillName}.agent-insight-stage-${randomBytes(5).toString('hex')}`)
  const backupRoot = path.join(target.metadataRoot, 'backups', skillName)
  let backup = null
  let targetMoved = false
  let stageInstalled = false
  try {
    writePayload(stage, files)
    if (snapshotHash(collectDirectoryFiles(stage)) !== actualHash) {
      throw deploymentError('STAGE_VERIFY_FAILED', 'Skill 暂存内容校验失败')
    }
    if (current.exists) {
      const label = backupLabel(current.skillVersion, current.contentHash, payload.deploymentId)
      const backupDir = path.join(backupRoot, label)
      const backupContent = path.join(backupDir, 'content')
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
      atomicWriteJson(path.join(backupDir, 'manifest.json'), {
        schemaVersion: 1,
        skillName,
        skillVersion: current.skillVersion,
        contentHash: current.contentHash,
        deploymentId: payload.deploymentId,
        backedUpAt: new Date().toISOString(),
      })
      fs.renameSync(target.targetDir, backupContent)
      targetMoved = true
      backup = {
        previousSkillVersion: current.skillVersion,
        previousContentHash: current.contentHash,
        backupRef: path.relative(target.frameworkRoot, backupDir).replaceAll(path.sep, '/'),
        backupDir,
        backupContent,
      }
    }
    fs.renameSync(stage, target.targetDir)
    stageInstalled = true
    const installedHash = snapshotHash(collectDirectoryFiles(target.targetDir))
    if (installedHash !== actualHash) throw deploymentError('INSTALL_VERIFY_FAILED', '安装后的 Skill 内容哈希不一致')
    const state = {
      schemaVersion: 1,
      skillName,
      skillVersion: manifest.skillVersion,
      semanticVersion: manifest.semanticVersion || null,
      contentHash: actualHash,
      deploymentId: payload.deploymentId,
      installedAt: new Date().toISOString(),
      managedBy: 'agent-insight',
    }
    atomicWriteJson(stateFile(target, skillName), state)
    return {
      state: 'INSTALLED',
      installed: state,
      backup: backup ? {
        previousSkillVersion: backup.previousSkillVersion,
        previousContentHash: backup.previousContentHash,
        backupRef: backup.backupRef,
      } : null,
      displayPath: target.displayPath,
    }
  } catch (error) {
    let restored = false
    try {
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true })
      if (stageInstalled && fs.existsSync(target.targetDir)) fs.rmSync(target.targetDir, { recursive: true, force: true })
      if (targetMoved && backup?.backupContent) {
        fs.renameSync(backup.backupContent, target.targetDir)
        if (backup.backupDir && fs.existsSync(backup.backupDir)) {
          fs.rmSync(backup.backupDir, { recursive: true, force: true })
        }
        restored = true
      }
    } catch (restoreError) {
      error.code = 'RESTORE_FAILED'
      error.message = `${error.message}; 自动恢复失败: ${restoreError.message}`
    }
    error.restored = restored
    throw error
  }
}

async function downloadArtifact(cfg, artifactRef) {
  const res = await fetch(`${cfg.insightBaseUrl}/api/reliability/client/v1/skill-artifacts/${encodeURIComponent(artifactRef)}`, {
    headers: {
      authorization: `Bearer ${cfg.deviceCredential}`,
      'x-agent-insight-client-id': cfg.clientId,
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw deploymentError(body?.error?.code || 'ARTIFACT_DOWNLOAD_FAILED', body?.error?.message || `HTTP ${res.status}`)
  return body
}

async function executeDeployment(cfg, payload, clientHome = path.dirname(cfg.workspaceBase || path.join(clientHomeFallback(), 'workspaces'))) {
  const artifact = await downloadArtifact(cfg, payload.artifactRef)
  return installArtifact(clientHome, payload, artifact)
}

function clientHomeFallback() {
  const base = process.env.AGENT_INSIGHT_HOME || path.join(os.homedir(), '.agent-insight')
  return path.join(base, 'client')
}

module.exports = {
  backupLabel,
  collectDirectoryFiles,
  executeDeployment,
  inspectCurrent,
  installArtifact,
  normalizedFiles,
  precheckDeployment,
  registerSkillOrigin,
  resolveTarget,
  snapshotHash,
}
