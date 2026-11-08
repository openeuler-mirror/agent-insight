/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const runtime = require('../scripts/skill-deployment-runtime.cjs')

function artifact(skillName: string, skillVersion: number, files: Record<string, string>) {
  return {
    manifest: {
      schemaVersion: 1,
      skillName,
      skillVersion,
      semanticVersion: null,
      contentHash: runtime.snapshotHash(files),
    },
    files,
  }
}

test('OpenCode origin installs, versions backups, and supports historical redeploy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-deploy-runtime-'))
  try {
    const clientHome = path.join(root, 'client')
    const frameworkRoot = path.join(root, 'project', '.opencode')
    const targetDir = path.join(frameworkRoot, 'skills', 'demo-skill')
    const origin = runtime.registerSkillOrigin(clientHome, {
      platform: 'opencode', skillName: 'demo-skill', frameworkRoot, targetDir,
    })
    const base = {
      deploymentId: 'deploy_test_1', platform: 'opencode', skillName: 'demo-skill', skillVersion: 1,
      target: { mode: 'execution_origin', originRef: origin.originRef },
      expectedCurrent: { exists: false, skillVersion: null, contentHash: null },
    }
    const v1 = artifact('demo-skill', 1, { 'SKILL.md': '# one', 'references/a.md': 'a' })
    const first = runtime.installArtifact(clientHome, { ...base, contentHash: v1.manifest.contentHash }, v1)
    assert.equal(first.state, 'INSTALLED')
    assert.equal(first.backup, null)
    assert.equal(runtime.precheckDeployment(clientHome, base).current.skillVersion, 1)

    const v2 = artifact('demo-skill', 2, { 'SKILL.md': '# two', 'references/a.md': 'b' })
    const second = runtime.installArtifact(clientHome, {
      ...base, deploymentId: 'deploy_test_2', skillVersion: 2, contentHash: v2.manifest.contentHash,
      expectedCurrent: { exists: true, skillVersion: 1, contentHash: v1.manifest.contentHash },
    }, v2)
    assert.equal(second.installed.skillVersion, 2)
    assert.equal(second.backup.previousSkillVersion, 1)
    assert.match(second.backup.backupRef, /backups\/demo-skill\/v1__/)

    const downgrade = runtime.installArtifact(clientHome, {
      ...base, deploymentId: 'deploy_test_3', skillVersion: 1, contentHash: v1.manifest.contentHash,
      expectedCurrent: { exists: true, skillVersion: 2, contentHash: v2.manifest.contentHash },
    }, v1)
    assert.equal(downgrade.installed.skillVersion, 1)
    assert.equal(downgrade.backup.previousSkillVersion, 2)
    assert.equal(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8'), '# one')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test('deployment rejects stale current content and unsafe artifact paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-deploy-conflict-'))
  try {
    const clientHome = path.join(root, 'client')
    const frameworkRoot = path.join(root, 'project', '.opencode')
    const targetDir = path.join(frameworkRoot, 'skills', 'demo-skill')
    const origin = runtime.registerSkillOrigin(clientHome, {
      platform: 'opencode', skillName: 'demo-skill', frameworkRoot, targetDir,
    })
    const v1 = artifact('demo-skill', 1, { 'SKILL.md': '# one' })
    runtime.installArtifact(clientHome, {
      deploymentId: 'deploy_test_1', platform: 'opencode', skillName: 'demo-skill', skillVersion: 1,
      contentHash: v1.manifest.contentHash,
      target: { mode: 'execution_origin', originRef: origin.originRef },
      expectedCurrent: { exists: false, skillVersion: null, contentHash: null },
    }, v1)
    fs.writeFileSync(path.join(targetDir, 'SKILL.md'), '# locally changed')
    const v2 = artifact('demo-skill', 2, { 'SKILL.md': '# two' })
    assert.throws(() => runtime.installArtifact(clientHome, {
      deploymentId: 'deploy_test_2', platform: 'opencode', skillName: 'demo-skill', skillVersion: 2,
      contentHash: v2.manifest.contentHash,
      target: { mode: 'execution_origin', originRef: origin.originRef },
      expectedCurrent: { exists: true, skillVersion: 1, contentHash: v1.manifest.contentHash },
    }, v2), (error: any) => error.code === 'VERSION_CONFLICT')
    assert.throws(() => runtime.normalizedFiles({ '../outside': 'x', 'SKILL.md': 'ok' }),
      (error: any) => error.code === 'ARTIFACT_PATH_INVALID')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('JiuwenSwarm installs in the user-global skill directory and versions backups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-deploy-jiuwen-'))
  const previous = process.env.JIUWENSWARM_DATA_DIR
  process.env.JIUWENSWARM_DATA_DIR = path.join(root, '.jiuwenswarm')
  try {
    const clientHome = path.join(root, 'client')
    const target = { mode: 'framework_global' }
    const v3 = artifact('global-skill', 3, { 'SKILL.md': '# three' })
    runtime.installArtifact(clientHome, {
      deploymentId: 'deploy_jiuwen_1', platform: 'jiuwenswarm', skillName: 'global-skill', skillVersion: 3,
      contentHash: v3.manifest.contentHash, target,
      expectedCurrent: { exists: false, skillVersion: null, contentHash: null },
    }, v3)
    const v2 = artifact('global-skill', 2, { 'SKILL.md': '# two' })
    const downgraded = runtime.installArtifact(clientHome, {
      deploymentId: 'deploy_jiuwen_2', platform: 'jiuwenswarm', skillName: 'global-skill', skillVersion: 2,
      contentHash: v2.manifest.contentHash, target,
      expectedCurrent: { exists: true, skillVersion: 3, contentHash: v3.manifest.contentHash },
    }, v2)
    assert.equal(downgraded.backup.previousSkillVersion, 3)
    assert.match(downgraded.backup.backupRef, /backups\/global-skill\/v3__/)
    assert.equal(fs.readFileSync(path.join(process.env.JIUWENSWARM_DATA_DIR, 'agent/workspace/skills/global-skill/SKILL.md'), 'utf8'), '# two')
  } finally {
    if (previous === undefined) delete process.env.JIUWENSWARM_DATA_DIR
    else process.env.JIUWENSWARM_DATA_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
