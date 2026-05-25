import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOT = path.join(os.homedir(), '.agent_insight', 'agent_workspaces');

export function getWorkspaceRoot(): string {
  return process.env.GENERAL_AGENT_WORKSPACE_ROOT || DEFAULT_ROOT;
}

/**
 * 把 user 标识符规范化为安全的目录名，阻止路径穿越（"..", "/", "~" 等）。
 * 非允许字符替换为 "_"，再加 sha 短哈希前缀，避免不同 user 经过规范化撞名。
 */
export function sanitizeUserSlug(user: string): string {
  const trimmed = String(user || '').trim();
  if (!trimmed) throw new Error('user is required');
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  // 用 user 原值的简单 hash 拼前缀，规避"a/b" 与 "a_b" 经过 sanitize 后重名
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) {
    h = (h * 31 + trimmed.charCodeAt(i)) | 0;
  }
  const hashHex = (h >>> 0).toString(16).padStart(8, '0');
  return `${hashHex}_${safe}`;
}

/**
 * 解析并确保某个 user 的 workspace 目录存在。
 * 同一 user 多次调用拿到同一目录，在 user 内多 session 共享同一根目录。
 */
export function ensureUserWorkspace(user: string): string {
  const slug = sanitizeUserSlug(user);
  const dir = path.join(getWorkspaceRoot(), slug);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 给一次任务再切一层 session 子目录，保证不同任务文件互不污染。
 * 调用方拿到后绑死给 opencode session。
 */
export function ensureSessionWorkspace(user: string, sessionTag: string): string {
  const userDir = ensureUserWorkspace(user);
  const safeTag = String(sessionTag || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'task';
  const dir = path.join(userDir, safeTag);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  ensureWorkspaceRootMarker(dir);
  return dir;
}

/**
 * opencode 的 Project.fromDirectory 用 `.git` 标记向上找 workspace 根。我们的 agent
 * workspace 不在 git 仓库里，opencode 找不到标记就把 worktree 默认成 `/`——system prompt
 * 里写"Workspace root folder: /"误导模型把 `./.skill-generator/...` 推理成 `/root/.skill-generator/...`
 * 落到 workspace 外，触发 permission ask 卡死整个请求。
 *
 * 这里放一个空 `.git` 目录作为标记：opencode 看到它存在，往后跑 `git rev-parse --git-common-dir`
 * 因为不是真 repo 会失败，源码 fallback 到 `worktree: <dir>, vcs: undefined`——刚好就是我们想要的：
 * worktree 锁到 agent workspace 自身，vcs 不为 'git' 所以 agent 不会去跑 git 工具。
 *
 * 兼容性：已经存在的 workspace 目录每次 ensure 也跑一遍（mkdirSync recursive 幂等），让历史会话
 * 直接生效不用手动迁移。
 */
function ensureWorkspaceRootMarker(dir: string): void {
  const marker = path.join(dir, '.git');
  if (fs.existsSync(marker)) return;
  try {
    fs.mkdirSync(marker, { recursive: true });
  } catch {
    /* 创建失败也别阻塞整条调用链——最坏退化到 fix 前的旧行为 */
  }
}

export type OpencodePermissionRule = {
  permission: string;
  pattern: string;
  action: 'allow' | 'deny' | 'ask';
};

/**
 * 后端 opencode session 必须的"基础权限规则"，所有调用方都得包含这套，否则后端无 TTY 时
 * tool 调用会因 permission.asked 没人响应而 silent 卡死。
 *
 * AND 关系提醒：跟 opencode-manager.ts:OPENCODE_CONFIG_PERMISSION 是 AND 关系——
 * session 级（这个数组）+ config 级（OPENCODE_CONFIG_PERMISSION）都必须 allow 工具才能过。
 * 只设 config 级救不了，因为 session 级数组里没规则匹配时，opencode 默认走 'ask'。
 *
 *   - read / webfetch / bash 全局 allow：avoid silent hang on 'ask' fallback。
 *     skill 生成 / 评测器 都需要 agent 读用户文件 / 调外部 API / 跑 bash。
 *   - question / plan_enter / plan_exit 显式 deny：opencode 1.14.x 内部 question 工具
 *     在收到 reply 后无法 resume tool execute，agent 整个 sendPrompt 死锁。
 *     参考 opencode CLI run 命令自己的 workaround（cli/cmd/run.ts:359）。
 *     deny 后 agent 会改用普通文字提问，走标准 chat 流程。
 *
 * 调用方：
 *   - skill 生成走 buildPermissionsForWorkspace（这套 base + workspace 写限制）
 *   - 各 evaluator 直接用 base，自己再加 /tmp/* 写允许（写不到 workspace 外）
 */
export function buildBaseOpencodePermissions(): OpencodePermissionRule[] {
  return [
    { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'webfetch', pattern: '*', action: 'allow' },
    { permission: 'bash', pattern: '*', action: 'allow' },
    // external_directory 全局放行——这是 opencode 跨切面的 permission, 任何
    // workspace 外路径(read/write/edit/bash 都会触发)走它。
    // 不放行的话, agent LLM 推错路径(如生产服务器有 /root/.opencode/skills/ 这种
    // 历史孤儿目录, LLM 把它脑补成"skills 标准位置"+ 拼出 /root/.opencode/skills/foo/...
    // 读不存在文件)就会卡在 external_directory ask -> server 无 TTY 无人应答 -> 死锁。
    //
    // 放行后行为: read 不存在文件返回 "File not found: ... Did you mean..."字符串
    // (opencode read tool 的 miss() 行为, 不抛错), LLM 看到错误自然换路径重试 ——
    // 这是用户期望的行为, 也避免了 hang。
    //
    // 安全 trade-off: 跟 bash:'*' allow 一致(bash 本来就能访问全系统), 这里没新增
    // 攻击面。写操作走 write/edit 工具自己的 permission gating, 不靠 external_directory。
    { permission: 'external_directory', pattern: '*', action: 'allow' },
    { permission: 'question', pattern: '*', action: 'deny' },
    { permission: 'plan_enter', pattern: '*', action: 'deny' },
    { permission: 'plan_exit', pattern: '*', action: 'deny' },
  ];
}

/**
 * skill 生成专用：buildBaseOpencodePermissions + workspace 写访问限制。
 * write / edit 仍走 external_directory 限制——只能写 workspace 与 /tmp，
 * 避免 agent 不小心改用户 project。
 */
export function buildPermissionsForWorkspace(workspaceDir: string): OpencodePermissionRule[] {
  return [
    // 写访问限定 workspace 与 /tmp
    { permission: 'external_directory', pattern: workspaceDir, action: 'allow' },
    { permission: 'external_directory', pattern: `${workspaceDir}/*`, action: 'allow' },
    { permission: 'external_directory', pattern: '/tmp/*', action: 'allow' },
    ...buildBaseOpencodePermissions(),
  ];
}

/**
 * 评测器专用：buildBaseOpencodePermissions + 仅允许写 /tmp/*。
 * 评测器 sandbox 性质，不绑特定 workspace，写访问最小化。
 */
export function buildEvaluatorPermissions(): OpencodePermissionRule[] {
  return [
    { permission: 'external_directory', pattern: '/tmp/*', action: 'allow' },
    ...buildBaseOpencodePermissions(),
  ];
}
