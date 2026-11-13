/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { randomBytes } from 'node:crypto'

import { computeSkillSnapshotHash } from '@/lib/skill-workbench/domain'
import { resolveSkillVersionFiles } from '@/lib/skill-workbench/session-service'
import { prismaRaw } from '@/lib/storage/prisma'
import { createCommand, getCommand, markSent } from '@/lib/reliability/command-bus'
import { dispatchCommand } from '@/lib/reliability/control-dispatch'
import { deriveStatus, ReliabilityError } from '@/lib/reliability/client-registry'

export type DeploymentSource =
  | { type: 'optimization'; optimizationRecordId: string }
  | { type: 'published_version'; skillVersion: number }

type ResolvedVersion = {
  skillId: string
  version: number
  semanticVersion: string | null
  files: Record<string, string>
  contentHash: string
  optimizationRecordId: string | null
  sourceExecutionId: string | null
}
type ResolvedDestination = {
  sourceExecutionId: string
  clientId: string
  platform: 'opencode' | 'pi-agent' | 'xiaoo' | 'jiuwenswarm'
  targetMode: 'execution_origin' | 'framework_global'
  originRef: string | null
  displayPath: string | null
}

export type DeploymentPreview = {
  deployable: boolean
  blockers: Array<{ code: string; message: string }>
  platform: string
  clientId: string
  target: { mode: string; originRef: string | null; displayPath: string | null }
  current: { exists?: boolean; skillVersion: number | null; contentHash: string | null }
  targetVersion: { skillVersion: number; semanticVersion: string | null; contentHash: string }
  direction: 'install' | 'upgrade' | 'downgrade' | 'reinstall'
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(7).toString('hex')}`
}

function normalizePlatform(value: string | null | undefined): ResolvedDestination['platform'] | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'opencode') return 'opencode'
  if (['pi', 'pi-agent', 'pi_agent'].includes(normalized)) return 'pi-agent'
  if (normalized === 'xiaoo') return 'xiaoo'
  if (['jiuwen', 'openjiuwen', 'jiuwenswarm', 'openjiuwenswarm'].includes(normalized)) return 'jiuwenswarm'
  return null
}

function parseObject(json: string | null | undefined): Record<string, any> {
  try {
    const value = JSON.parse(json || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function parseArray(json: string | null | undefined): any[] {
  try {
    const value = JSON.parse(json || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function direction(current: number | null, target: number): DeploymentPreview['direction'] {
  if (current == null) return 'install'
  if (target > current) return 'upgrade'
  if (target < current) return 'downgrade'
  return 'reinstall'
}

async function resolveVersion(user: string, skillName: string, source: DeploymentSource): Promise<ResolvedVersion> {
  const skill = await prismaRaw.skill.findFirst({ where: { name: skillName, user } })
  if (!skill) throw new ReliabilityError('SKILL_NOT_FOUND', 'Skill 不存在或不属于当前用户', 404)

  let version: number
  let optimizationRecordId: string | null = null
  let sourceExecutionId: string | null = null
  if (source.type === 'optimization') {
    const record = await prismaRaw.skillOptimizationRecord.findFirst({
      where: { id: source.optimizationRecordId, user, skillName },
    })
    if (!record || record.status !== 'published' || record.publishedVersion == null) {
      throw new ReliabilityError('OPTIMIZATION_NOT_PUBLISHED', '只有已复测并正式发布的优化版本可以下发', 409)
    }
    version = record.publishedVersion
    optimizationRecordId = record.id
    const refs = parseArray(record.sourceRefsJson)
    const diagnosisId = refs.find((ref: any) => ref?.type === 'diagnosis' && typeof ref.id === 'string')?.id
    const directExecution = refs.find((ref: any) => ['execution', 'trace'].includes(ref?.type)
      && typeof (ref.executionId || ref.id) === 'string')
    sourceExecutionId = directExecution ? String(directExecution.executionId || directExecution.id) : null
    if (!sourceExecutionId && diagnosisId) {
      sourceExecutionId = (await prismaRaw.diagnosisRun.findFirst({
        where: { id: diagnosisId, user }, select: { executionId: true },
      }))?.executionId || null
    }
  } else {
    version = Number(source.skillVersion)
    if (!Number.isInteger(version) || version < 0) {
      throw new ReliabilityError('SKILL_VERSION_INVALID', '目标 Skill 版本不合法', 400)
    }
  }

  const row = await prismaRaw.skillVersion.findUnique({
    where: { skillId_version: { skillId: skill.id, version } },
  })
  if (!row) throw new ReliabilityError('SKILL_VERSION_NOT_FOUND', `正式版本 v${version} 不存在`, 404)
  if (!['passed', 'not_required'].includes(row.verificationStatus)) {
    throw new ReliabilityError(
      'SKILL_VERSION_NOT_VERIFIED',
      row.verificationStatus === 'failed'
        ? `正式版本 v${version} 外部验证未通过，不能下发`
        : `正式版本 v${version} 尚未完成外部验证，不能下发`,
      409,
    )
  }
  const files = resolveSkillVersionFiles(skill.id, row.version, row.files, row.content)
  return {
    skillId: skill.id,
    version: row.version,
    semanticVersion: row.semanticVersion,
    files,
    contentHash: computeSkillSnapshotHash(files),
    optimizationRecordId,
    sourceExecutionId,
  }
}

async function resolveDestination(user: string, skillName: string, sourceExecutionId: string): Promise<ResolvedDestination> {
  const execution = await prismaRaw.execution.findFirst({
    where: { id: sourceExecutionId, user },
    select: { id: true, clientId: true, framework: true },
  })
  if (!execution) throw new ReliabilityError('SOURCE_EXECUTION_NOT_FOUND', '来源 Trace 不存在或不属于当前用户', 404)
  const platform = normalizePlatform(execution.framework)
  if (!platform) throw new ReliabilityError('PLATFORM_UNSUPPORTED', `框架 ${execution.framework || 'unknown'} 暂不支持 Skill 下发`, 422)

  if (platform === 'jiuwenswarm') {
    let clientId = execution.clientId
    if (!clientId) {
      const clients = await prismaRaw.reliabilityClient.findMany({ where: { user, unboundAt: null } })
      const candidates = clients.filter((client) => {
        if (deriveStatus(client) !== 'online') return false
        const capabilities = parseObject(client.capabilitiesJson)
        return Array.isArray(capabilities.platforms)
          && capabilities.platforms.some((item: any) => normalizePlatform(item?.id) === 'jiuwenswarm'
            && item?.skillDeployment?.ready !== false)
      })
      if (candidates.length !== 1) {
        throw new ReliabilityError(
          candidates.length ? 'SOURCE_CLIENT_AMBIGUOUS' : 'SOURCE_CLIENT_UNKNOWN',
          candidates.length ? '来源 Trace 未绑定客户端，且存在多个可用 JiuwenSwarm 客户端' : '来源 Trace 未记录可下发的客户端身份',
          422,
        )
      }
      clientId = candidates[0].clientId
    }
    return {
      sourceExecutionId: execution.id,
      clientId,
      platform,
      targetMode: 'framework_global',
      originRef: null,
      displayPath: '${JIUWENSWARM_DATA_DIR:-~/.jiuwenswarm}/agent/workspace/skills/' + skillName,
    }
  }

  if (!execution.clientId) throw new ReliabilityError('SOURCE_CLIENT_UNKNOWN', '来源 Trace 未记录可下发的客户端身份', 422)

  const skill = await prismaRaw.executionSkill.findFirst({
    where: { executionId: execution.id, skillName },
    include: { origin: true },
  })
  const origin = skill?.origin
  if (!origin?.originRef || origin.clientId !== execution.clientId || normalizePlatform(origin.platform) !== platform) {
    throw new ReliabilityError('SKILL_ORIGIN_UNAVAILABLE', '来源 Trace 未记录该 Skill 的实际执行位置，已阻止改投全局目录', 422)
  }
  return {
    sourceExecutionId: execution.id,
    clientId: execution.clientId,
    platform,
    targetMode: 'execution_origin',
    originRef: origin.originRef,
    displayPath: origin.displayPath,
  }
}

async function resolveClient(user: string, destination: ResolvedDestination) {
  const client = await prismaRaw.reliabilityClient.findFirst({
    where: { user, clientId: destination.clientId, unboundAt: null },
  })
  if (!client) throw new ReliabilityError('DEPLOYMENT_CLIENT_NOT_FOUND', '来源客户端未注册或已解绑', 422)
  if (deriveStatus(client) !== 'online') {
    throw new ReliabilityError('DEPLOYMENT_CLIENT_OFFLINE', '来源客户端当前离线，请上线后重新预检', 409)
  }
  const capabilities = parseObject(client.capabilitiesJson)
  const actions = new Set(Array.isArray(capabilities.actions) ? capabilities.actions.map(String) : [])
  if (!actions.has('PRECHECK_SKILL_DEPLOYMENT') || !actions.has('DEPLOY_SKILL_ARTIFACT')) {
    throw new ReliabilityError('DEPLOYMENT_CLIENT_UPGRADE_REQUIRED', '来源客户端版本不支持 Skill 下发，请先升级客户端', 409)
  }
  const platform = Array.isArray(capabilities.platforms)
    ? capabilities.platforms.find((item: any) => normalizePlatform(item?.id) === destination.platform)
    : null
  if (!platform?.skillDeployment || platform.skillDeployment.ready === false) {
    throw new ReliabilityError('DEPLOYMENT_PLATFORM_UNAVAILABLE', `客户端未声明 ${destination.platform} Skill 下发能力`, 409)
  }
  return client
}

async function dispatchAndWait(input: {
  user: string
  clientId: string
  action: 'PRECHECK_SKILL_DEPLOYMENT'
  payload: Record<string, unknown>
  timeoutMs?: number
}) {
  const frame = await createCommand({
    user: input.user,
    clientId: input.clientId,
    action: input.action,
    payload: input.payload,
    ttlMs: Math.max(10_000, input.timeoutMs || 10_000),
  })
  const dispatched = await dispatchCommand(input.clientId, frame)
  if (dispatched.delivered) await markSent(frame.commandId, 'wss')
  const deadline = Date.now() + (input.timeoutMs || 7_000)
  while (Date.now() < deadline) {
    const row = await getCommand(frame.commandId)
    if (row?.status === 'SUCCEEDED') return parseObject(row.resultJson)
    if (['FAILED', 'EXPIRED', 'DELIVERY_FAILED'].includes(row?.status || '')) {
      throw new ReliabilityError(row?.errorCode || 'DEPLOYMENT_PRECHECK_FAILED', row?.errorMessage || '客户端预检失败', 409)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new ReliabilityError('DEPLOYMENT_PRECHECK_TIMEOUT', '客户端预检超时，请确认客户端在线后重试', 504)
}

async function resolvePlan(input: {
  user: string
  skillName: string
  sourceExecutionId: string
  source: DeploymentSource
}) {
  const version = await resolveVersion(input.user, input.skillName, input.source)
  const sourceExecutionId = input.sourceExecutionId || version.sourceExecutionId
  if (!sourceExecutionId) {
    throw new ReliabilityError('SOURCE_EXECUTION_REQUIRED', '无法从优化记录确定来源 Trace，请显式选择来源 Trace', 400)
  }
  const destination = await resolveDestination(input.user, input.skillName, sourceExecutionId)
  await resolveClient(input.user, destination)
  const precheck = await dispatchAndWait({
    user: input.user,
    clientId: destination.clientId,
    action: 'PRECHECK_SKILL_DEPLOYMENT',
    payload: {
      platform: destination.platform,
      skillName: input.skillName,
      target: { mode: destination.targetMode, ...(destination.originRef ? { originRef: destination.originRef } : {}) },
    },
  })
  const current = precheck.current && typeof precheck.current === 'object' ? precheck.current : {}
  return { version, destination, precheck, current }
}

export async function previewSkillDeployment(input: {
  user: string
  skillName: string
  sourceExecutionId: string
  source: DeploymentSource
}): Promise<DeploymentPreview> {
  const { version, destination, precheck, current } = await resolvePlan(input)
  return {
    deployable: true,
    blockers: [],
    platform: destination.platform,
    clientId: destination.clientId,
    target: {
      mode: destination.targetMode,
      originRef: destination.originRef,
      displayPath: typeof precheck.displayPath === 'string' ? precheck.displayPath : destination.displayPath,
    },
    current: {
      exists: current.exists === true,
      skillVersion: Number.isInteger(current.skillVersion) ? current.skillVersion : null,
      contentHash: typeof current.contentHash === 'string' ? current.contentHash : null,
    },
    targetVersion: {
      skillVersion: version.version,
      semanticVersion: version.semanticVersion,
      contentHash: version.contentHash,
    },
    direction: direction(Number.isInteger(current.skillVersion) ? current.skillVersion : null, version.version),
  }
}

export async function createSkillDeployment(input: {
  user: string
  skillName: string
  sourceExecutionId: string
  source: DeploymentSource
  confirmed: boolean
  idempotencyKey: string
}) {
  if (!input.confirmed) throw new ReliabilityError('DEPLOYMENT_CONFIRMATION_REQUIRED', '下发前必须二次确认', 400)
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!idempotencyKey || idempotencyKey.length > 160) {
    throw new ReliabilityError('IDEMPOTENCY_KEY_INVALID', '缺少合法的幂等键', 400)
  }
  const existing = await prismaRaw.skillDeployment.findUnique({
    where: { user_idempotencyKey: { user: input.user, idempotencyKey } },
  })
  if (existing) {
    const expectedOptimizationId = input.source.type === 'optimization' ? input.source.optimizationRecordId : null
    if (existing.skillName !== input.skillName
      || (input.sourceExecutionId && existing.sourceExecutionId !== input.sourceExecutionId)
      || existing.optimizationRecordId !== expectedOptimizationId
      || (input.source.type === 'published_version' && existing.targetSkillVersion !== input.source.skillVersion)) {
      throw new ReliabilityError('IDEMPOTENCY_KEY_REUSED', '该幂等键已用于另一项 Skill 下发', 409)
    }
    return existing
  }

  const { version, destination, current } = await resolvePlan(input)
  const deploymentId = newId('deploy')
  const artifactRef = newId('skillart')
  const currentVersion = Number.isInteger(current.skillVersion) ? current.skillVersion : null
  const currentHash = typeof current.contentHash === 'string' ? current.contentHash : null
  const created = await prismaRaw.skillDeployment.create({
    data: {
      deploymentId,
      user: input.user,
      skillName: input.skillName,
      targetSkillVersion: version.version,
      semanticVersion: version.semanticVersion,
      artifactHash: version.contentHash,
      artifactRef,
      artifactExpiresAt: new Date(Date.now() + 10 * 60_000),
      optimizationRecordId: version.optimizationRecordId,
      sourceExecutionId: destination.sourceExecutionId,
      clientId: destination.clientId,
      platform: destination.platform,
      targetMode: destination.targetMode,
      originRef: destination.originRef,
      previousSkillVersion: currentVersion,
      previousContentHash: currentHash,
      direction: direction(currentVersion, version.version),
      status: 'CREATED',
      idempotencyKey,
      events: { create: { phase: 'created', status: 'CREATED' } },
    },
  })

  try {
    const frame = await createCommand({
      user: input.user,
      clientId: destination.clientId,
      action: 'DEPLOY_SKILL_ARTIFACT',
      ttlMs: 5 * 60_000,
      payload: {
        deploymentId,
        artifactRef,
        platform: destination.platform,
        skillName: input.skillName,
        skillVersion: version.version,
        semanticVersion: version.semanticVersion,
        contentHash: version.contentHash,
        expectedCurrent: { exists: current.exists === true, skillVersion: currentVersion, contentHash: currentHash },
        target: { mode: destination.targetMode, ...(destination.originRef ? { originRef: destination.originRef } : {}) },
      },
    })
    await prismaRaw.skillDeployment.update({
      where: { deploymentId },
      data: { commandId: frame.commandId, status: 'DISPATCHING' },
    })
    const dispatched = await dispatchCommand(destination.clientId, frame)
    if (dispatched.delivered) await markSent(frame.commandId, 'wss')
    await prismaRaw.skillDeploymentEvent.create({
      data: { deploymentId, phase: 'dispatch', status: dispatched.delivered ? 'SENT' : 'QUEUED' },
    })
  } catch (error) {
    await prismaRaw.skillDeployment.update({
      where: { deploymentId },
      data: {
        status: 'FAILED',
        errorCode: error instanceof ReliabilityError ? error.code : 'DEPLOYMENT_DISPATCH_FAILED',
        errorMessage: error instanceof Error ? error.message : '下发命令创建失败',
        completedAt: new Date(),
      },
    })
    throw error
  }
  return prismaRaw.skillDeployment.findUniqueOrThrow({ where: { deploymentId } })
}

export async function getSkillDeployment(user: string, skillName: string, deploymentId: string) {
  return prismaRaw.skillDeployment.findFirst({
    where: { user, skillName, deploymentId },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  })
}

export async function claimSkillArtifact(clientId: string, artifactRef: string) {
  const deployment = await prismaRaw.skillDeployment.findFirst({
    where: { clientId, artifactRef },
  })
  if (!deployment) throw new ReliabilityError('SKILL_ARTIFACT_NOT_FOUND', 'Skill 制品不存在', 404)
  if (deployment.artifactExpiresAt.getTime() <= Date.now()) {
    throw new ReliabilityError('SKILL_ARTIFACT_EXPIRED', 'Skill 制品领取引用已过期', 410)
  }
  const skill = await prismaRaw.skill.findFirst({ where: { name: deployment.skillName, user: deployment.user } })
  if (!skill) throw new ReliabilityError('SKILL_NOT_FOUND', 'Skill 不存在', 404)
  const version = await prismaRaw.skillVersion.findUnique({
    where: { skillId_version: { skillId: skill.id, version: deployment.targetSkillVersion } },
  })
  if (!version) throw new ReliabilityError('SKILL_VERSION_NOT_FOUND', '目标正式版本不存在', 404)
  const files = resolveSkillVersionFiles(skill.id, version.version, version.files, version.content)
  const contentHash = computeSkillSnapshotHash(files)
  if (contentHash !== deployment.artifactHash) {
    throw new ReliabilityError('SKILL_ARTIFACT_CHANGED', '正式版本内容与部署快照不一致', 409)
  }
  await prismaRaw.skillDeployment.updateMany({
    where: { deploymentId: deployment.deploymentId, artifactClaimedAt: null },
    data: { artifactClaimedAt: new Date(), status: 'DOWNLOADING', startedAt: deployment.startedAt || new Date() },
  })
  return {
    manifest: {
      schemaVersion: 1,
      skillName: deployment.skillName,
      skillVersion: version.version,
      semanticVersion: version.semanticVersion,
      contentHash,
    },
    files,
  }
}

export async function applySkillDeploymentReceipt(input: {
  commandId: string
  clientId: string
  status: 'RECEIVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  result?: Record<string, any>
  error?: { code?: string; message?: string }
}) {
  const deployment = await prismaRaw.skillDeployment.findFirst({
    where: { commandId: input.commandId, clientId: input.clientId },
  })
  if (!deployment) return
  const result = input.result || {}
  const phase = typeof result.phase === 'string' ? result.phase : input.status.toLowerCase()
  let status = deployment.status
  const data: Record<string, any> = {}
  if (input.status === 'RECEIVED') status = 'RECEIVED'
  if (input.status === 'RUNNING') {
    const runningState = String(result.state || phase || 'RUNNING').toUpperCase()
    status = ['RECEIVED', 'DOWNLOADING', 'VERIFYING', 'BACKING_UP', 'INSTALLING', 'RUNNING'].includes(runningState)
      ? runningState : 'RUNNING'
  }
  if (input.status === 'SUCCEEDED') {
    status = 'SUCCEEDED'
    data.completedAt = new Date()
    data.resultJson = JSON.stringify(result)
    const backup = result.backup && typeof result.backup === 'object' ? result.backup : null
    data.backupRef = typeof backup?.backupRef === 'string' ? backup.backupRef : null
    data.previousSkillVersion = Number.isInteger(backup?.previousSkillVersion)
      ? backup.previousSkillVersion : deployment.previousSkillVersion
    data.previousContentHash = typeof backup?.previousContentHash === 'string'
      ? backup.previousContentHash : deployment.previousContentHash
  }
  if (input.status === 'FAILED') {
    status = result.restored === true ? 'FAILED_RESTORED' : 'FAILED'
    data.completedAt = new Date()
    data.errorCode = input.error?.code || 'CLIENT_DEPLOYMENT_FAILED'
    data.errorMessage = input.error?.message || '客户端下发失败'
    data.resultJson = JSON.stringify(result)
  }
  await prismaRaw.$transaction([
    prismaRaw.skillDeployment.update({
      where: { deploymentId: deployment.deploymentId },
      data: { ...data, status, ...(!deployment.startedAt && input.status !== 'RECEIVED' ? { startedAt: new Date() } : {}) },
    }),
    prismaRaw.skillDeploymentEvent.create({
      data: { deploymentId: deployment.deploymentId, phase, status: input.status, detailJson: JSON.stringify(result) },
    }),
  ])
}
