export function formatExperimentTimestamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function defaultExperimentName(now = new Date()): string {
  return `Agent 评测 ${formatExperimentTimestamp(now)}`;
}

export function defaultSkillExperimentName(
  skillName: string,
  preset: 'trigger' | 'use-case' | 'skill-ab',
  version: number,
  now = new Date(),
): string {
  const label = preset === 'trigger' ? '触发分析' : preset === 'skill-ab' ? 'A/B 测试' : '用例分析';
  return `${skillName} · ${label} · v${version} · ${formatExperimentTimestamp(now)}`;
}

export function displayedExperimentName(name: string, createdAt: string | Date): string {
  if (!/^Agent 评测 \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: · (?:同配置|复用评测配置))+$/.test(name)) return name;
  const created = new Date(createdAt);
  return Number.isNaN(created.getTime()) ? name : defaultExperimentName(created);
}
