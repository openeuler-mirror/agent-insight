import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离 GENERAL_AGENT_WORKSPACE_ROOT，避免改到真实 ~/.agent_insight/agent_workspaces/
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-root-marker-test-'));
process.env.GENERAL_AGENT_WORKSPACE_ROOT = tmpRoot;

import { ensureSessionWorkspace } from '../src/lib/engine/general-agent/workspace';

test('ensureSessionWorkspace 在新建 workspace 中放 .git 标记，让 opencode 锁定 worktree', () => {
  const dir = ensureSessionWorkspace('user@example.com', 'thread-new');
  assert.ok(fs.existsSync(dir), 'workspace dir 已创建');
  const marker = path.join(dir, '.git');
  assert.ok(fs.existsSync(marker), '.git 标记已创建');
  assert.ok(fs.statSync(marker).isDirectory(), '.git 是目录');
});

test('ensureSessionWorkspace 对已存在的 workspace 也补上 .git 标记，老会话无需迁移', () => {
  // 先手动建出"老会话"目录（没 .git）模拟历史状态
  const userDir = path.join(tmpRoot, 'manual_user');
  fs.mkdirSync(userDir, { recursive: true });
  // 用 ensure 创出对应 slug，再删 .git 模拟历史状态
  const dir = ensureSessionWorkspace('preexisting@example.com', 'thread-old');
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# preexisting');

  // 再次 ensure：标记应被补上，且历史文件保留
  const dir2 = ensureSessionWorkspace('preexisting@example.com', 'thread-old');
  assert.equal(dir2, dir);
  assert.ok(fs.existsSync(path.join(dir, '.git')), '历史 dir 也补上 .git');
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')), '历史文件未被覆盖');
});
