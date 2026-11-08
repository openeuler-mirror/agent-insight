/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

import { createIsolatedDatabase } from './helpers/isolated-database'

const database = createIsolatedDatabase()
const require_ = createRequire(import.meta.url)
const { computeSkillSnapshotHash } = require_('../src/lib/skill-workbench/domain') as typeof import('@/lib/skill-workbench/domain')
const { handleCommandStatus } = require_('../src/lib/reliability/command-receipt') as typeof import('@/lib/reliability/command-receipt')
const { claimSkillArtifact } = require_('../src/lib/skill-deployment/service') as typeof import('@/lib/skill-deployment/service')
const { prismaRaw } = require_('../src/lib/storage/prisma') as typeof import('@/lib/storage/prisma')

test.after(async () => {
  await prismaRaw.$disconnect()
  database.dispose()
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
