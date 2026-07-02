import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ensureSkillFilesInWorkspace, resolveSkillStorageDirSync } from '@/lib/skill-opt-storage';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个 v<N> 存储目录：SKILL.md（frontmatter name）+ 可选的核心脚本 analyze_logs.py。 */
function seedSkillDir(dir: string, name: string, opts: { withScript: boolean }): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: collision fixture\n---\n\n# ${name}\n`,
    'utf-8',
  );
  if (opts.withScript) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'analyze_logs.py'), 'print("real baseline")\n', 'utf-8');
  }
}

const SKILL = 'log-analyzer';
const hasScript = (root: string) => fs.existsSync(path.join(root, 'scripts', 'analyze_logs.py'));

test('storageDirOverride 命中 → 从权威目录预填（带上核心脚本 analyze_logs.py）', () => {
  const workspaceDir = mktmp('ws-');
  const authoritativeDir = path.join(mktmp('auth-'), 'v1');
  try {
    seedSkillDir(authoritativeDir, SKILL, { withScript: true });

    const res = ensureSkillFilesInWorkspace({
      skillName: SKILL,
      baseVersion: 1,
      workspaceDir,
      storageDirOverride: authoritativeDir,
    });

    assert.equal(res.source, 'storage');
    assert.equal(res.storageDir, authoritativeDir);
    assert.ok(res.copied >= 2, `expected ≥2 files copied, got ${res.copied}`);
    assert.ok(fs.existsSync(path.join(workspaceDir, 'SKILL.md')));
    assert.ok(hasScript(workspaceDir), '权威目录的 analyze_logs.py 应被预填进 workspace');
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(authoritativeDir), { recursive: true, force: true });
  }
});

test('同名碰撞：name-scan 会选到缺脚本的旧目录；storageDirOverride 绕过它选到正确目录', () => {
  const origCwd = process.cwd();
  const origDataDir = process.env.AGENT_INSIGHT_DATA_DIR;
  // realpathSync：macOS 下 mktmp 返回 /var/...，chdir 后 process.cwd() 是 /private/var/...，
  // resolveSkillStorageDirSync 按 process.cwd() 拼路径——预期值也得用同一 realpath 形态。
  const cwd = fs.realpathSync(mktmp('cwd-'));
  const workspaceA = mktmp('wsA-');
  const workspaceB = mktmp('wsB-');
  // 权威目录放在 name-scan 根之外，且是唯一带核心脚本的那个
  const authoritativeDir = path.join(mktmp('auth-'), 'v1');
  try {
    // name-scan 根：两个同名 skill 的 by-id 残留目录，都【缺】analyze_logs.py（orphan / 旧 seed）
    const root = path.join(cwd, 'data', 'storage', 'skills');
    seedSkillDir(path.join(root, 'id-aaa-orphan', 'v1'), SKILL, { withScript: false });
    seedSkillDir(path.join(root, 'id-zzz-orphan', 'v1'), SKILL, { withScript: false });
    seedSkillDir(authoritativeDir, SKILL, { withScript: true });

    process.env.AGENT_INSIGHT_DATA_DIR = cwd;
    process.chdir(cwd);

    // 1) 暴露 bug：name-scan 只能按 frontmatter name 匹配，两个同名目录无法区分，
    //    返回的是 orphan 之一——按 readdir 顺序，不保证是"对"的那个，且都缺核心脚本。
    const picked = resolveSkillStorageDirSync(SKILL, 1);
    assert.ok(picked, 'name-scan 应能按 frontmatter name 命中某个同名目录');
    assert.ok(picked!.startsWith(root), 'name-scan 命中的应在 storage 根内');
    assert.ok(!hasScript(picked!), 'name-scan 命中的 orphan 目录缺 analyze_logs.py（这正是混淆来源）');

    // 2) 不传 override（沿用 legacy name-scan）→ 预填的基线缺核心脚本（复现"基线不完整"）
    const legacy = ensureSkillFilesInWorkspace({ skillName: SKILL, baseVersion: 1, workspaceDir: workspaceA });
    assert.equal(legacy.source, 'storage');
    assert.ok(!hasScript(workspaceA), 'legacy name-scan 预填缺 analyze_logs.py');

    // 3) 传 override（权威目录）→ 预填的基线带上核心脚本（修复）
    const fixed = ensureSkillFilesInWorkspace({
      skillName: SKILL,
      baseVersion: 1,
      workspaceDir: workspaceB,
      storageDirOverride: authoritativeDir,
    });
    assert.equal(fixed.source, 'storage');
    assert.equal(fixed.storageDir, authoritativeDir);
    assert.ok(hasScript(workspaceB), 'override 应让预填命中带 analyze_logs.py 的权威目录');
  } finally {
    process.chdir(origCwd);
    if (origDataDir === undefined) delete process.env.AGENT_INSIGHT_DATA_DIR;
    else process.env.AGENT_INSIGHT_DATA_DIR = origDataDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(workspaceA, { recursive: true, force: true });
    fs.rmSync(workspaceB, { recursive: true, force: true });
    fs.rmSync(path.dirname(authoritativeDir), { recursive: true, force: true });
  }
});

test('storageDirOverride 指向不存在的路径 → 回退 legacy name-scan', () => {
  const origCwd = process.cwd();
  const origDataDir = process.env.AGENT_INSIGHT_DATA_DIR;
  const cwd = fs.realpathSync(mktmp('cwd-'));
  const workspaceDir = mktmp('ws-');
  try {
    const root = path.join(cwd, 'data', 'storage', 'skills');
    const onlyDir = path.join(root, 'id-only', 'v2');
    seedSkillDir(onlyDir, SKILL, { withScript: true });
    process.env.AGENT_INSIGHT_DATA_DIR = cwd;
    process.chdir(cwd);

    const res = ensureSkillFilesInWorkspace({
      skillName: SKILL,
      baseVersion: 2,
      workspaceDir,
      storageDirOverride: path.join(cwd, 'does', 'not', 'exist', 'v2'),
    });

    assert.equal(res.source, 'storage');
    assert.equal(res.storageDir, onlyDir, '不存在的 override 应被忽略，回退到 name-scan');
    assert.ok(hasScript(workspaceDir));
  } finally {
    process.chdir(origCwd);
    if (origDataDir === undefined) delete process.env.AGENT_INSIGHT_DATA_DIR;
    else process.env.AGENT_INSIGHT_DATA_DIR = origDataDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('workspace 已有 SKILL.md → 跳过预填（follow-up 复用），即便给了 override', () => {
  const workspaceDir = mktmp('ws-');
  const authoritativeDir = path.join(mktmp('auth-'), 'v1');
  try {
    fs.writeFileSync(path.join(workspaceDir, 'SKILL.md'), '---\nname: existing\n---\n', 'utf-8');
    seedSkillDir(authoritativeDir, SKILL, { withScript: true });

    const res = ensureSkillFilesInWorkspace({
      skillName: SKILL,
      baseVersion: 1,
      workspaceDir,
      storageDirOverride: authoritativeDir,
    });

    assert.equal(res.skipped, 'workspace_not_empty');
    assert.equal(res.copied, 0);
    assert.ok(!hasScript(workspaceDir), '已存在 workspace 不应被 override 覆盖预填');
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(authoritativeDir), { recursive: true, force: true });
  }
});

test('无 override、name-scan 未命中 → 回退 baselineFiles', () => {
  const origCwd = process.cwd();
  const origDataDir = process.env.AGENT_INSIGHT_DATA_DIR;
  const cwd = mktmp('cwd-empty-'); // 没有 data/storage/skills，name-scan 必然 miss
  const workspaceDir = mktmp('ws-');
  try {
    process.env.AGENT_INSIGHT_DATA_DIR = cwd;
    process.chdir(cwd);
    const res = ensureSkillFilesInWorkspace({
      skillName: SKILL,
      baseVersion: 1,
      workspaceDir,
      storageDirOverride: null,
      baselineFiles: { 'SKILL.md': '---\nname: from-baseline\n---\n' },
    });

    assert.equal(res.source, 'baseline_files');
    assert.equal(res.copied, 1);
    assert.ok(fs.existsSync(path.join(workspaceDir, 'SKILL.md')));
  } finally {
    process.chdir(origCwd);
    if (origDataDir === undefined) delete process.env.AGENT_INSIGHT_DATA_DIR;
    else process.env.AGENT_INSIGHT_DATA_DIR = origDataDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
