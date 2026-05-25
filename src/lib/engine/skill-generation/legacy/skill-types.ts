// 技能元数据定义
export interface SkillMetadata {
  // 基础信息
  id: string;
  name: string;
  version: string; // 语义化版本，如 "1.0.0"
  description: string;

  // 分类信息
  category: string; // 前端、后端、数据、运维等
  tags: string[]; // 技术栈、用途等标签

  // 技术信息
  inputFormat: string; // 输入格式描述
  outputFormat: string; // 输出格式描述
  dependencies: string[]; // 依赖的技能或工具
  executionEnvironment: string; // 执行环境要求
  configuration: Record<string, any>; // 配置参数

  // 作者和维护信息
  author: string;
  maintainer: string;
  createdAt: string;
  updatedAt: string;

  // 权限和访问控制
  visibility: 'public' | 'team' | 'private';
  allowedTeams: string[]; // 允许访问的团队

  // 质量评估指标
  qualityScore?: number; // 0-100的质量评分
  usageCount?: number; // 使用次数
  successRate?: number; // 成功率
  avgExecutionTime?: number; // 平均执行时间
  avgTokenUsage?: number; // 平均Token消耗

  // 版本历史
  changelog: VersionChange[];

  // 关联的执行数据
  relatedExecutions: string[]; // 关联的执行记录ID
}

export interface VersionChange {
  version: string;
  timestamp: string;
  changes: string[];
  breakingChanges: boolean;
}

export interface SkillUsageStats {
  skillId: string;
  totalInvocations: number;
  successfulInvocations: number;
  failedInvocations: number;
  avgLatency: number;
  avgTokens: number;
  lastUsed: string;
  usageByTeam: Record<string, number>;
  usageByUser: Record<string, number>;
}

export interface SkillSearchParams {
  query?: string;
  category?: string;
  tags?: string[];
  minQualityScore?: number;
  maxLatency?: number;
  visibility?: 'public' | 'team' | 'private';
  teamId?: string;
  sortBy?: 'name' | 'qualityScore' | 'usageCount' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface SkillRegistrationRequest {
  name: string;
  description: string;
  category: string;
  tags?: string[];
  inputFormat: string;
  outputFormat: string;
  dependencies?: string[];
  executionEnvironment?: string;
  configuration?: Record<string, any>;
  author: string;
  visibility?: 'public' | 'team' | 'private';
  allowedTeams?: string[];
}

export interface SkillUpdateRequest {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  inputFormat?: string;
  outputFormat?: string;
  dependencies?: string[];
  executionEnvironment?: string;
  configuration?: Record<string, any>;
  maintainer?: string;
  visibility?: 'public' | 'team' | 'private';
  allowedTeams?: string[];
  changelog?: VersionChange;
  // Metadata updates
  qualityScore?: number;
  usageCount?: number;
  successRate?: number;
  avgExecutionTime?: number;
  avgTokenUsage?: number;
}

// 技能目录分类体系
export const SKILL_CATEGORIES = [
  '前端开发',
  '后端开发',
  '数据工程',
  'DevOps',
  '测试',
  '文档',
  '代码审查',
  '性能优化',
  '安全',
  '部署',
  '监控',
  '其他'
] as const;

export type SkillCategory = typeof SKILL_CATEGORIES[number];

// 常用标签
export const COMMON_SKILL_TAGS = [
  'React', 'Vue', 'Angular', 'Next.js', 'TypeScript', 'JavaScript',
  'Node.js', 'Python', 'Java', 'Go', 'Rust', 'C++',
  'API设计', '数据库', '缓存', '消息队列', '微服务',
  'Docker', 'Kubernetes', 'CI/CD', 'Terraform',
  '测试', '单元测试', '集成测试', 'E2E测试',
  '文档生成', '代码生成', '重构', '性能分析',
  '安全扫描', '漏洞检测', '合规检查'
] as const;