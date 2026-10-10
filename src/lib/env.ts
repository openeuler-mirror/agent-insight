import { config } from 'dotenv';
import path from 'node:path';
import { assertSupportedHomeEnv, getAgentInsightHome, resolveDatabaseUrl } from '../../scripts/agent-insight-home.cjs';

export { getAgentInsightHome };

export function getAgentInsightDataDir(): string {
  return path.join(getAgentInsightHome(), 'data');
}

export function resolveAgentInsightHomePath(...segments: string[]): string {
  return path.join(getAgentInsightHome(), ...segments);
}

export function resolveAgentInsightDataPath(...segments: string[]): string {
  return path.join(getAgentInsightDataDir(), ...segments);
}

export function getSkillStorageRoot(): string {
  return resolveAgentInsightDataPath('storage', 'skills');
}

export function getSkillVersionAssetPath(skillId: string, version: number): string {
  return `data/storage/skills/${skillId}/v${version}`;
}

export function getSkillVersionStorageDir(skillId: string, version: number): string {
  return path.join(getSkillStorageRoot(), skillId, `v${version}`);
}

export function resolveRuntimeAssetPath(assetPath: string): string {
  if (path.isAbsolute(assetPath)) return assetPath;
  if (assetPath === 'data' || assetPath.startsWith('data/')) {
    return path.join(getAgentInsightHome(), assetPath);
  }
  return resolveAgentInsightDataPath(assetPath);
}

export function getAgentInsightEnvPath(): string {
  return path.join(getAgentInsightHome(), '.env');
}

/**
 * 统一把 DATABASE_URL 归一到一个对 server 和手动 node 脚本都可用的绝对路径。
 * 目标:平台**默认就从 ~/.agent-insight/data 读库**,不需要任何人手动传 DATABASE_URL。
 *
 *   1) 未设置 / 空        → 默认 ~/.agent-insight/data/witty_insight.db
 *      (旧实现返回 undefined,会让 Prisma 报 "Environment variable not found: DATABASE_URL")
 *   2) 模板默认相对路径    → 解析到 ~/.agent-insight/data 绝对路径
 *   3) file:~/… 含波浪号  → 展开 ~ 为家目录。dotenv/node **不会**展开 ~(只有 bash `source` 会),
 *      以前因此出现"server 正常、手动脚本写错库"的坑;这里统一展开,两边行为一致。
 *   4) 其它(已是绝对路径 / 自定义 / 非 file:)→ 原样返回。
 */
export function resolveDefaultDatabaseUrl(databaseUrl: string | undefined): string {
  return resolveDatabaseUrl(databaseUrl);
}

export function loadAgentInsightEnv(): void {
  const root = getAgentInsightHome();
  const managedEnv = config({ path: path.join(root, '.env') });
  assertSupportedHomeEnv(managedEnv.parsed || {});
  const projectEnv = config();
  assertSupportedHomeEnv(projectEnv.parsed || {});
  assertSupportedHomeEnv();
  process.env.AGENT_INSIGHT_HOME = root;

  // 总会拿到一个绝对路径(含未设置时的默认),让 server / 脚本 / 任意入口都一致地落到同一个库。
  process.env.DATABASE_URL = resolveDefaultDatabaseUrl(process.env.DATABASE_URL);
}
