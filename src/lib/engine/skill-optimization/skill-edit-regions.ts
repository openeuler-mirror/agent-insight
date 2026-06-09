export type SkillEditRegionKind = 'frontmatter' | 'section';

export interface SkillEditRegion {
  file: string;
  kind: SkillEditRegionKind;
  label: string;
  anchor: string;
  startLine: number;
  endLine: number;
}

export interface SkillIssueRegionHint {
  category?: string | null;
  summary?: string | null;
  evidence?: string | null;
  reasoning?: string | null;
  suggestedFix?: string | null;
}

export interface ParsedSkillRegions {
  frontmatter?: SkillEditRegion;
  frontmatterFields: Map<string, SkillEditRegion>;
  sections: SkillEditRegion[];
}

interface RegionIntent {
  frontmatterFields?: string[];
  frontmatter?: boolean;
  sectionTokens?: string[];
}

const SKILL_FILE = 'SKILL.md';

const REGION_INTENTS: Array<{ tokens: string[]; intent: RegionIntent }> = [
  {
    tokens: ['description', 'desc', '描述', '触发', 'trigger', 'routing', '路由', '召回'],
    intent: {
      frontmatterFields: ['description'],
      sectionTokens: ['when to use', '适用', '使用场景', '触发', 'routing', '召回'],
    },
  },
  {
    tokens: ['tag', 'tags', 'metadata', '元数据', '标签'],
    intent: { frontmatterFields: ['tags'], frontmatter: true },
  },
  {
    tokens: ['name', '命名'],
    intent: { frontmatterFields: ['name'], frontmatter: true },
  },
  {
    tokens: ['frontmatter', 'yaml'],
    intent: { frontmatter: true },
  },
  {
    tokens: ['examples', 'example', '示例', '样例', 'multi-page', '多页', 'case'],
    intent: { sectionTokens: ['examples', 'example', '示例', '样例', 'case'] },
  },
  {
    tokens: [
      'scripts',
      'script',
      'tool',
      '工具',
      '执行',
      'token',
      'timeout',
      '错误',
      '报错',
      '轨迹偏差',
      '关键观点遗漏',
      '步骤',
      '流程',
      'how to use',
      'usage',
    ],
    intent: {
      sectionTokens: ['how to use', 'usage', '使用', '执行', 'workflow', 'steps', '步骤', '流程'],
    },
  },
  {
    tokens: ['format', 'output', '输出', '格式'],
    intent: { sectionTokens: ['output', 'format', '输出', '格式', 'examples', '示例'] },
  },
];

export function resolveSkillEditRegionsForIssue(
  skillContent: string | null | undefined,
  hint: SkillIssueRegionHint,
): SkillEditRegion[] {
  if (!skillContent) return [];
  const parsed = parseSkillRegions(skillContent);
  const intent = inferRegionIntent(hint);
  const regions: SkillEditRegion[] = [];

  for (const field of intent.frontmatterFields ?? []) {
    const region = parsed.frontmatterFields.get(field);
    if (region) {
      regions.push(region);
    } else if (parsed.frontmatter) {
      regions.push(parsed.frontmatter);
    } else {
      regions.push(syntheticFrontmatterRegion());
    }
  }

  if (intent.frontmatter && regions.length === 0) {
    regions.push(parsed.frontmatter ?? syntheticFrontmatterRegion());
  }

  for (const token of intent.sectionTokens ?? []) {
    const matches = parsed.sections.filter(section => sectionMatches(section, token));
    for (const match of matches) regions.push(match);
  }

  return uniqueRegions(regions);
}

export function parseSkillRegions(content: string): ParsedSkillRegions {
  const lines = content.split(/\r?\n/);
  const frontmatter = parseFrontmatter(lines, content);
  const headings = parseHeadings(lines, frontmatter?.endLine ?? 0);
  const sections = headings.map((heading, index) => {
    const next = headings
      .slice(index + 1)
      .find(candidate => candidate.level <= heading.level);
    const endLine = next ? next.line - 1 : Math.max(heading.line, lines.length);
    return {
      file: SKILL_FILE,
      kind: 'section' as const,
      label: `section:${heading.text}`,
      anchor: heading.text,
      startLine: heading.line,
      endLine,
    };
  });

  return {
    frontmatter: frontmatter?.region,
    frontmatterFields: frontmatter?.fields ?? new Map(),
    sections,
  };
}

export function formatSkillEditRegion(region: SkillEditRegion): string {
  const range = region.startLine === region.endLine
    ? `L${region.startLine}`
    : `L${region.startLine}-L${region.endLine}`;
  return `${region.file}:${region.label} (${range})`;
}

function parseFrontmatter(
  lines: string[],
  content: string,
): { region: SkillEditRegion; fields: Map<string, SkillEditRegion>; endLine: number } | null {
  if ((lines[0] ?? '').trim() !== '---') return null;
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closeIndex < 1) return null;

  const region: SkillEditRegion = {
    file: SKILL_FILE,
    kind: 'frontmatter',
    label: 'frontmatter',
    anchor: 'frontmatter',
    startLine: 1,
    endLine: closeIndex + 1,
  };
  const fields = parseFrontmatterFields(lines, closeIndex);
  return { region, fields, endLine: closeIndex + 1 };
}

function parseFrontmatterFields(lines: string[], closeIndex: number): Map<string, SkillEditRegion> {
  const fields = new Map<string, SkillEditRegion>();
  const starts: Array<{ key: string; index: number }> = [];
  for (let index = 1; index < closeIndex; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+)\s*:/);
    if (match) starts.push({ key: match[1].toLowerCase(), index });
  }
  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i];
    const next = starts[i + 1];
    const endIndex = next ? next.index - 1 : closeIndex - 1;
    fields.set(current.key, {
      file: SKILL_FILE,
      kind: 'frontmatter',
      label: `frontmatter.${current.key}`,
      anchor: current.key,
      startLine: current.index + 1,
      endLine: Math.max(current.index + 1, endIndex + 1),
    });
  }
  return fields;
}

function parseHeadings(
  lines: string[],
  startIndex: number,
): Array<{ level: number; text: string; line: number }> {
  const headings: Array<{ level: number; text: string; line: number }> = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const text = match[2].trim();
    if (!text) continue;
    headings.push({ level: match[1].length, text, line: index + 1 });
  }
  return headings;
}

function inferRegionIntent(hint: SkillIssueRegionHint): RegionIntent {
  const haystack = normalizeText([
    hint.category,
    hint.summary,
    hint.evidence,
    hint.reasoning,
    hint.suggestedFix,
  ].filter(Boolean).join('\n'));

  const out: RegionIntent = {
    frontmatterFields: [],
    sectionTokens: [],
  };

  for (const { tokens, intent } of REGION_INTENTS) {
    if (!tokens.some(token => haystack.includes(normalizeText(token)))) continue;
    mergeIntent(out, intent);
  }

  return out;
}

function mergeIntent(target: RegionIntent, source: RegionIntent): void {
  if (source.frontmatter) target.frontmatter = true;
  if (source.frontmatterFields) {
    target.frontmatterFields = uniqueStrings([
      ...(target.frontmatterFields ?? []),
      ...source.frontmatterFields,
    ]);
  }
  if (source.sectionTokens) {
    target.sectionTokens = uniqueStrings([
      ...(target.sectionTokens ?? []),
      ...source.sectionTokens,
    ]);
  }
}

function sectionMatches(section: SkillEditRegion, token: string): boolean {
  const heading = normalizeText(section.anchor);
  const needle = normalizeText(token);
  return heading.includes(needle) || needle.includes(heading);
}

function uniqueRegions(regions: SkillEditRegion[]): SkillEditRegion[] {
  const seen = new Set<string>();
  const out: SkillEditRegion[] = [];
  for (const region of regions) {
    const key = [
      region.file,
      region.kind,
      region.label,
      region.startLine,
      region.endLine,
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(region);
  }
  return out.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.startLine - b.startLine || a.endLine - b.endLine || a.label.localeCompare(b.label);
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function syntheticFrontmatterRegion(): SkillEditRegion {
  return {
    file: SKILL_FILE,
    kind: 'frontmatter',
    label: 'frontmatter',
    anchor: 'frontmatter',
    startLine: 1,
    endLine: 1,
  };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}
