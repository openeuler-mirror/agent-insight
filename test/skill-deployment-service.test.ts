/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import type { ClientPlatformCapability } from '@/lib/reliability/client-registry'

import { createIsolatedDatabase } from './helpers/isolated-database'

const database = createIsolatedDatabase()
const require_ = createRequire(import.meta.url)
const { computeSkillSnapshotHash } = require_('../src/lib/skill-workbench/domain') as typeof import('@/lib/skill-workbench/domain')
const { handleCommandStatus } = require_('../src/lib/reliability/command-receipt') as typeof import('@/lib/reliability/command-receipt')
const { claimSkillArtifact, previewSkillDeployment } = require_('../src/lib/skill-deployment/service') as typeof import('@/lib/skill-deployment/service')
const { createInstallToken, registerClient, updateCapabilities, normalizeCapabilities } = require_('../src/lib/reliability/client-registry') as typeof import('@/lib/reliability/client-registry')
const { registerSocket, unregisterSocket } = require_('../src/lib/reliability/control-hub') as typeof import('@/lib/reliability/control-hub')
const { prismaRaw } = require_('../src/lib/storage/prisma') as typeof import('@/lib/storage/prisma')

test.after(async () => {
  await prismaRaw.$disconnect()
  database.dispose()
})

test('registered and refreshed deployment capabilities reach the real preview command', async () => {
  const user = `deployment-registration-${process.pid}`
  const name = 'registration-preview'
  const skill = await prismaRaw.skill.create({ data: { name, user } })
  await prismaRaw.skillVersion.create({ data: { skillId: skill.id, version: 1, content: '# skill' } })
  const capability: NonNullable<ClientPlatformCapability['skillDeployment']> = { protocolVersion: 1, ready: true, modes: ['framework_global'], backup: 'retained', reload: 'restart_required' }
  const capabilities = { platforms: [{ id: 'jiuwenswarm', skillDeployment: capability }], actions: ['PRECHECK_SKILL_DEPLOYMENT', 'DEPLOY_SKILL_ARTIFACT'] }
  const { installToken } = await createInstallToken({ user })
  const client = await registerClient({ installToken, hostname: 'test-host', capabilities })
  const stored = await prismaRaw.reliabilityClient.findUniqueOrThrow({ where: { clientId: client.clientId } })
  assert.deepEqual(JSON.parse(stored.capabilitiesJson).platforms[0].skillDeployment, capability)
  await updateCapabilities({ clientId: client.clientId, revision: 'updated', capabilities })
  const execution = await prismaRaw.execution.create({ data: { user, framework: 'jiuwenswarm', clientId: client.clientId } })
  const acknowledgements: Promise<unknown>[] = []
  registerSocket(client.clientId, { close() {}, send(raw) {
    const frame = JSON.parse(raw)
    assert.equal(frame.action, 'PRECHECK_SKILL_DEPLOYMENT')
    acknowledgements.push(handleCommandStatus({ clientId: client.clientId, commandId: frame.commandId, status: 'SUCCEEDED', result: { current: { exists: false } } }))
  } })
  try {
    const preview = await previewSkillDeployment({ user, skillName: name, sourceExecutionId: execution.id, source: { type: 'published_version', skillVersion: 1 } })
    assert.equal(preview.deployable, true)
    assert.equal(preview.target.mode, 'framework_global')
    assert.equal(preview.clientId, client.clientId)
    await Promise.all(acknowledgements)
  } finally { unregisterSocket(client.clientId) }
})

test('deployment capability normalization strips untrusted fields and unsupported protocols', () => {
  const raw = { platforms: [{ id: 'jiuwenswarm', skillDeployment: { protocolVersion: 1, ready: true, modes: ['framework_global', 'unsafe'], backup: 'retained', reload: 'restart_required', password: 'must-not-persist' } }] }
  assert.deepEqual((normalizeCapabilities(raw).platforms[0] as any).skillDeployment, { protocolVersion: 1, ready: true, modes: ['framework_global'], backup: 'retained', reload: 'restart_required' })
  raw.platforms[0].skillDeployment.protocolVersion = 2
  assert.equal((normalizeCapabilities(raw).platforms[0] as any).skillDeployment, undefined)
})

test('artifact claims are client-bound and terminal deployment receipts are idempotent', async () => {
  const user = `skill-deploy-${process.pid}`
  const clientId = `client-skill-deploy-${process.pid}`
  const files = { 'SKILL.md': '# deployed', 'references/a.md': 'a' }
  const artifactHash = computeSkillSnapshotHash(files)
  const skill = await prismaRaw.skill.create({ data: { name: 'deploy-test', user } })
  await prismaRaw.skillVersion.create({
    data: { skillId: skill.id, version: 2, content: files['SKILL.md'], files: JSON.stringify(files) },
  })
  await prismaRaw.reliabilityClient.create({
    data: { clientId, user, name: 'fixture', status: 'online', lastSeenAt: new Date() },
  })
  await prismaRaw.skillDeployment.create({
    data: {
      deploymentId: 'deploy_service_fixture', user, skillName: skill.name, targetSkillVersion: 2,
      artifactHash, artifactRef: 'skillart_service_fixture', artifactExpiresAt: new Date(Date.now() + 60_000),
      sourceExecutionId: 'execution-fixture', clientId, platform: 'opencode', targetMode: 'execution_origin',
      originRef: 'origin_0123456789abcdef01234567', direction: 'upgrade', status: 'DISPATCHING',
      idempotencyKey: 'service-fixture', commandId: 'cmd_service_fixture',
    },
  })
  await prismaRaw.reliabilityCommand.create({
    data: {
      commandId: 'cmd_service_fixture', clientId, user, action: 'DEPLOY_SKILL_ARTIFACT',
      payloadJson: '{}', status: 'SENT', expiresAt: new Date(Date.now() + 60_000),
    },
  })

  await assert.rejects(() => claimSkillArtifact('another-client', 'skillart_service_fixture'),
    (error: any) => error.code === 'SKILL_ARTIFACT_NOT_FOUND')
  const artifact = await claimSkillArtifact(clientId, 'skillart_service_fixture')
  assert.deepEqual(artifact.files, files)
  assert.equal(artifact.manifest.skillVersion, 2)

  await handleCommandStatus({
    clientId, commandId: 'cmd_service_fixture', status: 'SUCCEEDED',
    result: {
      state: 'INSTALLED',
      backup: { previousSkillVersion: 1, previousContentHash: '0123456789abcdef', backupRef: '.agent-insight/backups/v1' },
    },
  })
  await handleCommandStatus({
    clientId, commandId: 'cmd_service_fixture', status: 'FAILED',
    error: { code: 'LATE_REPLAY', message: 'must be ignored' },
  })
  const deployment = await prismaRaw.skillDeployment.findUniqueOrThrow({ where: { deploymentId: 'deploy_service_fixture' } })
  assert.equal(deployment.status, 'SUCCEEDED')
  assert.equal(deployment.previousSkillVersion, 1)
  assert.equal(deployment.errorCode, null)
  assert.equal(await prismaRaw.skillDeploymentEvent.count({ where: { deploymentId: deployment.deploymentId } }), 1)
})
