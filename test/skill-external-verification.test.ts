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

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createIsolatedDatabase } from './helpers/isolated-database'

const database = createIsolatedDatabase()
const require_ = createRequire(import.meta.url)
const { computeSkillSnapshotHash } = require_('../src/lib/skill-workbench/domain') as typeof import('@/lib/skill-workbench/domain')
const { publishOptimizationCandidate } = require_('../src/lib/skill-workbench/publish-service') as typeof import('@/lib/skill-workbench/publish-service')
const {
  activateVerifiedSkillVersion,
  recordExternalSkillVersionVerification,
} = require_('../src/lib/skill-workbench/version-verification-service') as typeof import('@/lib/skill-workbench/version-verification-service')
const { prismaRaw } = require_('../src/lib/storage/prisma') as typeof import('@/lib/storage/prisma')

test.after(async () => {
  await prismaRaw.$disconnect()
  database.dispose()
})

test('优化候选先发布为待验证版本，外部验证通过后才能激活', async () => {
  const user = `external-verification-${process.pid}`
  const name = 'external-verification-fixture'
  const baseFiles = {
    'SKILL.md': `---\nname: ${name}\ndescription: fixture\n---\n\n# Base`,
  }
  const candidateFiles = {
    ...baseFiles,
    'SKILL.md': `${baseFiles['SKILL.md']}\n\nExternal validation candidate.`,
  }
  const skill = await prismaRaw.skill.create({
    data: { user, name, activeVersion: 0 },
  })
  await prismaRaw.skillVersion.create({
    data: {
      skillId: skill.id,
      version: 0,
      content: baseFiles['SKILL.md'],
      files: JSON.stringify(baseFiles),
    },
  })
  const session = await prismaRaw.skillWorkbenchSession.create({
    data: {
      user,
      skillName: name,
      workVersion: 0,
      source: 'management',
      filesJson: JSON.stringify(baseFiles),
    },
  })
  const candidateHash = computeSkillSnapshotHash(candidateFiles)
  const evaluation = await prismaRaw.skillSnapshotEvaluation.create({
    data: {
      sessionId: session.id,
      user,
      skillName: name,
      proposedVersion: 1,
      contentHash: candidateHash,
      generator: 'test-fixture',
      trigger: 'optimization',
      status: 'ok',
    },
  })
  const record = await prismaRaw.skillOptimizationRecord.create({
    data: {
      sessionId: session.id,
      user,
      skillName: name,
      baseVersion: 0,
      candidateVersionLabel: 'v1-candidate',
      candidateFilesJson: JSON.stringify(candidateFiles),
      candidateContentHash: candidateHash,
      staticEvaluationId: evaluation.id,
      status: 'pending_retest',
    },
  })

  const published = await publishOptimizationCandidate({
    user,
    skillName: name,
    recordId: record.id,
    confirmed: true,
    verificationMode: 'external',
    activate: false,
  })
  assert.equal(published.version.version, 1)
  assert.equal(published.version.verificationMode, 'external')
  assert.equal(published.version.verificationStatus, 'pending')
  assert.equal((await prismaRaw.skill.findUniqueOrThrow({ where: { id: skill.id } })).activeVersion, 0)
  assert.equal((await prismaRaw.skillOptimizationRecord.findUniqueOrThrow({ where: { id: record.id } })).status, 'published')

  await assert.rejects(
    () => activateVerifiedSkillVersion({ user, skillName: name, version: 1 }),
    (error: any) => error.status === 409 && /尚未完成外部验证/.test(error.message),
  )
  await recordExternalSkillVersionVerification({ user, skillName: name, version: 1, result: 'failed', note: '外部用例失败' })
  await assert.rejects(
    () => activateVerifiedSkillVersion({ user, skillName: name, version: 1 }),
    (error: any) => error.status === 409 && /未通过/.test(error.message),
  )
  await recordExternalSkillVersionVerification({ user, skillName: name, version: 1, result: 'passed', note: '外部用例通过' })
  const activated = await activateVerifiedSkillVersion({ user, skillName: name, version: 1 })
  assert.equal(activated.skill.activeVersion, 1)
  assert.equal(activated.version.verificationStatus, 'passed')

  await assert.rejects(
    () => recordExternalSkillVersionVerification({ user: 'another-user', skillName: name, version: 1, result: 'passed' }),
    (error: any) => error.status === 404,
  )
})

test('会话卡片提供下载、验证登记和激活入口', () => {
  const conversation = readFileSync('src/components/skill-workbench/OptimizationConversation.tsx', 'utf8')
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8')
  const deploymentService = readFileSync('src/lib/skill-deployment/service.ts', 'utf8')
  const automationPush = readFileSync('src/app/api/skills/automation/push/route.ts', 'utf8')
  const deleteVersion = readFileSync('src/app/api/skills/[id]/versions/[version]/route.ts', 'utf8')
  assert.match(conversation, /下载 \{getOptimizationTargetVersion\(record\)\} ZIP/)
  assert.match(conversation, /验证通过/)
  assert.match(conversation, /验证失败/)
  assert.match(conversation, /激活 \{getOptimizationTargetVersion\(record\)\}/)
  assert.match(shell, /verificationMode:\s*'external'/)
  assert.match(shell, /activate:\s*false/)
  assert.match(shell, /\/verification/)
  assert.match(shell, /\/activate/)
  assert.match(deploymentService, /SKILL_VERSION_NOT_VERIFIED/)
  assert.match(automationPush, /verificationStatus !== 'passed'/)
  assert.match(deleteVersion, /No verified version is available to become active/)
})
