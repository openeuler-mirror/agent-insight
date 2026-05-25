import fs from 'fs';
import path from 'path';
import { SkillMetadata, SkillRegistrationRequest, SkillUpdateRequest, SkillSearchParams, SkillUsageStats, VersionChange } from '@/lib/engine/skill-generation/legacy/skill-types';

const DATA_DIR = path.join(process.cwd(), 'data');
const SKILLS_FILE = path.join(DATA_DIR, 'skills.jsonl');
const SKILL_STATS_FILE = path.join(DATA_DIR, 'skill-stats.json');

// 确保数据目录存在
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// 读取所有技能
export async function getAllSkills(): Promise<SkillMetadata[]> {
  ensureDataDir();

  if (!fs.existsSync(SKILLS_FILE)) {
    return [];
  }

  try {
    const content = fs.readFileSync(SKILLS_FILE, 'utf-8');
    if (!content.trim()) {
      return [];
    }

    return content
      .trim()
      .split('\n')
      .map(line => {
        try {
          return JSON.parse(line) as SkillMetadata;
        } catch {
          return null;
        }
      })
      .filter(skill => skill !== null) as SkillMetadata[];
  } catch (error) {
    console.error('Error reading skills:', error);
    return [];
  }
}

// 根据ID获取技能
export async function getSkillById(id: string): Promise<SkillMetadata | null> {
  const skills = await getAllSkills();
  return skills.find(skill => skill.id === id) || null;
}

// 搜索技能
export async function searchSkills(params: SkillSearchParams): Promise<SkillMetadata[]> {
  let skills = await getAllSkills();

  // 应用过滤器
  if (params.query) {
    const query = params.query.toLowerCase();
    skills = skills.filter(skill =>
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query) ||
      skill.tags.some(tag => tag.toLowerCase().includes(query))
    );
  }

  if (params.category) {
    skills = skills.filter(skill => skill.category === params.category);
  }

  if (params.tags && params.tags.length > 0) {
    skills = skills.filter(skill =>
      params.tags!.some(tag => skill.tags.includes(tag))
    );
  }

  if (params.minQualityScore !== undefined) {
    skills = skills.filter(skill =>
      (skill.qualityScore || 0) >= params.minQualityScore!
    );
  }

  if (params.visibility) {
    skills = skills.filter(skill => skill.visibility === params.visibility);
  }

  // 排序
  if (params.sortBy) {
    skills.sort((a, b) => {
      let aValue: any, bValue: any;

      switch (params.sortBy) {
        case 'name':
          aValue = a.name;
          bValue = b.name;
          break;
        case 'qualityScore':
          aValue = a.qualityScore || 0;
          bValue = b.qualityScore || 0;
          break;
        case 'usageCount':
          aValue = a.usageCount || 0;
          bValue = b.usageCount || 0;
          break;
        case 'updatedAt':
          aValue = new Date(a.updatedAt).getTime();
          bValue = new Date(b.updatedAt).getTime();
          break;
        default:
          return 0;
      }

      const order = params.sortOrder === 'desc' ? -1 : 1;
      if (aValue < bValue) return -1 * order;
      if (aValue > bValue) return 1 * order;
      return 0;
    });
  }

  // 分页
  if (params.page !== undefined && params.pageSize !== undefined) {
    const start = params.page * params.pageSize;
    const end = start + params.pageSize;
    skills = skills.slice(start, end);
  }

  return skills;
}

// 注册新技能
export async function registerSkill(request: SkillRegistrationRequest): Promise<SkillMetadata> {
  const skills = await getAllSkills();
  const timestamp = new Date().toISOString();

  // 检查技能名称和版本是否已存在
  const existingSkill = skills.find(s =>
    s.name === request.name && s.version === '1.0.0'
  );

  if (existingSkill) {
    throw new Error(`Skill "${request.name}" version 1.0.0 already exists`);
  }

  const newSkill: SkillMetadata = {
    id: generateSkillId(request.name),
    name: request.name,
    version: '1.0.0',
    description: request.description,
    category: request.category,
    tags: request.tags || [],
    inputFormat: request.inputFormat,
    outputFormat: request.outputFormat,
    dependencies: request.dependencies || [],
    executionEnvironment: request.executionEnvironment || 'default',
    configuration: request.configuration || {},
    author: request.author,
    maintainer: request.author,
    createdAt: timestamp,
    updatedAt: timestamp,
    visibility: request.visibility || 'private',
    allowedTeams: request.allowedTeams || [],
    qualityScore: 0,
    usageCount: 0,
    successRate: 0,
    avgExecutionTime: 0,
    avgTokenUsage: 0,
    changelog: [{
      version: '1.0.0',
      timestamp,
      changes: ['Initial release'],
      breakingChanges: false
    }],
    relatedExecutions: []
  };

  // 保存技能
  ensureDataDir();
  const skillLine = JSON.stringify(newSkill);
  fs.appendFileSync(SKILLS_FILE, (fs.existsSync(SKILLS_FILE) ? '\n' : '') + skillLine);

  // 初始化使用统计
  await updateSkillStats(newSkill.id, {
    totalInvocations: 0,
    successfulInvocations: 0,
    failedInvocations: 0,
    avgLatency: 0,
    avgTokens: 0,
    lastUsed: timestamp,
    usageByTeam: {},
    usageByUser: {}
  });

  return newSkill;
}

// 更新技能
export async function updateSkill(skillId: string, request: SkillUpdateRequest): Promise<SkillMetadata | null> {
  const skills = await getAllSkills();
  const skillIndex = skills.findIndex(s => s.id === skillId);

  if (skillIndex === -1) {
    return null;
  }

  const oldSkill = skills[skillIndex];
  const timestamp = new Date().toISOString();

  // 解析新版本号（简单递增补丁版本）
  const versionParts = oldSkill.version.split('.').map(Number);
  const newVersion = `${versionParts[0]}.${versionParts[1]}.${versionParts[2] + 1}`;

  const updatedSkill: SkillMetadata = {
    ...oldSkill,
    ...request,
    version: newVersion,
    maintainer: request.maintainer || oldSkill.maintainer,
    updatedAt: timestamp,
    changelog: [
      ...oldSkill.changelog,
      {
        version: newVersion,
        timestamp,
        changes: request.changelog?.changes || ['General improvements'],
        breakingChanges: request.changelog?.breakingChanges || false
      }
    ]
  };

  // 移除旧技能，添加新技能（保持JSONL格式）
  skills.splice(skillIndex, 1);
  skills.push(updatedSkill);

  // 重写整个文件
  ensureDataDir();
  const content = skills.map(skill => JSON.stringify(skill)).join('\n');
  fs.writeFileSync(SKILLS_FILE, content);

  return updatedSkill;
}

// 删除技能
export async function deleteSkill(skillId: string): Promise<boolean> {
  const skills = await getAllSkills();
  const newSkills = skills.filter(skill => skill.id !== skillId);

  if (newSkills.length === skills.length) {
    return false; // 没有找到要删除的技能
  }

  ensureDataDir();
  const content = newSkills.map(skill => JSON.stringify(skill)).join('\n');
  fs.writeFileSync(SKILLS_FILE, content);

  // 删除使用统计
  await deleteSkillStats(skillId);

  return true;
}

// 获取技能使用统计
export async function getSkillStats(skillId: string): Promise<SkillUsageStats | null> {
  ensureDataDir();

  if (!fs.existsSync(SKILL_STATS_FILE)) {
    return null;
  }

  try {
    const content = fs.readFileSync(SKILL_STATS_FILE, 'utf-8');
    const stats = JSON.parse(content);
    return stats[skillId] || null;
  } catch (error) {
    console.error('Error reading skill stats:', error);
    return null;
  }
}

// 更新技能使用统计
export async function updateSkillStats(skillId: string, stats: Partial<SkillUsageStats>): Promise<void> {
  ensureDataDir();

  let allStats: Record<string, SkillUsageStats> = {};
  if (fs.existsSync(SKILL_STATS_FILE)) {
    try {
      const content = fs.readFileSync(SKILL_STATS_FILE, 'utf-8');
      allStats = JSON.parse(content);
    } catch {
      allStats = {};
    }
  }

  const currentStats = allStats[skillId] || {
    skillId,
    totalInvocations: 0,
    successfulInvocations: 0,
    failedInvocations: 0,
    avgLatency: 0,
    avgTokens: 0,
    lastUsed: new Date().toISOString(),
    usageByTeam: {},
    usageByUser: {}
  };

  allStats[skillId] = {
    ...currentStats,
    ...stats,
    skillId // 确保skillId正确
  };

  fs.writeFileSync(SKILL_STATS_FILE, JSON.stringify(allStats, null, 2));
}

// 删除技能使用统计
export async function deleteSkillStats(skillId: string): Promise<void> {
  ensureDataDir();

  if (!fs.existsSync(SKILL_STATS_FILE)) {
    return;
  }

  try {
    const content = fs.readFileSync(SKILL_STATS_FILE, 'utf-8');
    const allStats = JSON.parse(content);
    delete allStats[skillId];
    fs.writeFileSync(SKILL_STATS_FILE, JSON.stringify(allStats, null, 2));
  } catch (error) {
    console.error('Error deleting skill stats:', error);
  }
}

// 记录技能调用
export async function recordSkillInvocation(
  skillId: string,
  teamId: string,
  userId: string,
  success: boolean,
  latency: number,
  tokens: number
): Promise<void> {
  const stats = await getSkillStats(skillId) || {
    skillId,
    totalInvocations: 0,
    successfulInvocations: 0,
    failedInvocations: 0,
    avgLatency: 0,
    avgTokens: 0,
    lastUsed: new Date().toISOString(),
    usageByTeam: {},
    usageByUser: {}
  };

  // 更新统计
  stats.totalInvocations += 1;
  if (success) {
    stats.successfulInvocations += 1;
  } else {
    stats.failedInvocations += 1;
  }

  // 更新平均延迟（加权平均）
  stats.avgLatency = (stats.avgLatency * (stats.totalInvocations - 1) + latency) / stats.totalInvocations;

  // 更新平均Token使用（加权平均）
  stats.avgTokens = (stats.avgTokens * (stats.totalInvocations - 1) + tokens) / stats.totalInvocations;

  stats.lastUsed = new Date().toISOString();

  // 更新团队使用统计
  stats.usageByTeam[teamId] = (stats.usageByTeam[teamId] || 0) + 1;

  // 更新用户使用统计
  stats.usageByUser[userId] = (stats.usageByUser[userId] || 0) + 1;

  await updateSkillStats(skillId, stats);

  // 更新技能的质量评分
  await updateSkillQualityScore(skillId);
}

// 更新技能质量评分
async function updateSkillQualityScore(skillId: string): Promise<void> {
  const stats = await getSkillStats(skillId);
  if (!stats) return;

  const skill = await getSkillById(skillId);
  if (!skill) return;

  // 简单质量评分算法（可以根据需求调整）
  const successRate = stats.totalInvocations > 0
    ? (stats.successfulInvocations / stats.totalInvocations) * 100
    : 0;

  const qualityScore = Math.min(100, Math.round(
    successRate * 0.6 + // 成功率权重60%
    (stats.totalInvocations > 10 ? 20 : stats.totalInvocations * 2) + // 使用频率权重20%
    (stats.avgLatency < 5 ? 20 : Math.max(0, 20 - (stats.avgLatency - 5))) // 延迟权重20%
  ));

  // 更新技能元数据
  await updateSkill(skillId, {
    qualityScore,
    usageCount: stats.totalInvocations,
    successRate,
    avgExecutionTime: stats.avgLatency,
    avgTokenUsage: stats.avgTokens
  });
}

// 生成技能ID
function generateSkillId(name: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 5);
  const cleanName = name.toLowerCase().replace(/[^a-z0-9]/g, '-').substr(0, 20);
  return `${cleanName}-${timestamp}-${random}`;
}

// 获取技能分类统计
export async function getCategoryStats(): Promise<Record<string, number>> {
  const skills = await getAllSkills();
  const stats: Record<string, number> = {};

  skills.forEach(skill => {
    stats[skill.category] = (stats[skill.category] || 0) + 1;
  });

  return stats;
}

// 获取热门技能
export async function getPopularSkills(limit: number = 10): Promise<SkillMetadata[]> {
  const skills = await getAllSkills();
  return skills
    .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
    .slice(0, limit);
}

// 获取最近更新的技能
export async function getRecentlyUpdatedSkills(limit: number = 10): Promise<SkillMetadata[]> {
  const skills = await getAllSkills();
  return skills
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);
}