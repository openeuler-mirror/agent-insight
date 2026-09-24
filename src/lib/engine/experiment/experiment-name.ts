export function defaultExperimentName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Agent 评测 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function displayedExperimentName(name: string, createdAt: string | Date): string {
  if (!/^Agent 评测 \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: · (?:同配置|复用评测配置))+$/.test(name)) return name;
  const created = new Date(createdAt);
  return Number.isNaN(created.getTime()) ? name : defaultExperimentName(created);
}
