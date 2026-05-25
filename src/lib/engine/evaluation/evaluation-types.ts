// 技能效果评估系统类型定义
// 与现有skill-types.ts兼容，支持A05需求实现

// ==================== 基础类型 ====================

export interface MetricValue {
  value: number;
  unit: string;
  confidence: number; // 0-1的置信度
  source?: string; // 数据来源
  timestamp?: string; // 数据时间戳
}

export interface DataQualityMetrics {
  completeness: number; // 数据完整性 0-1
  accuracy: number; // 数据准确性 0-1
  timeliness: number; // 数据及时性 0-1
  consistency: number; // 数据一致性 0-1
}

// ==================== 评估维度评分模型 ====================

export interface SubdimensionScore {
  score: number; // 0-100分
  weight: number; // 子维度权重
  metrics: {
    [metric: string]: MetricValue;
  };
  rationale?: string; // 评分理由
}

export interface DimensionScore {
  score: number; // 0-100分
  weight: number; // 维度权重
  subdimensions: {
    [subdimension: string]: SubdimensionScore;
  };
  rationale: string; // 评分理由
  improvementSuggestions: string[]; // 改进建议
}

// ==================== 评估结果模型 ====================

export interface EvaluationResult {
  // 基础信息
  id: string;
  skillId: string;
  skillVersion: string;
  evaluationTimestamp: string;

  // 评估维度评分
  functionalScore: DimensionScore;      // 功能性评估
  efficiencyScore: DimensionScore;      // 效率性评估
  practicalityScore: DimensionScore;    // 实用性评估
  economicScore: DimensionScore;        // 经济性评估

  // 综合评分
  overallScore: number;                 // 简单平均分
  weightedScore: number;                // 加权综合分

  // 评估详情
  testCaseId?: string;                  // 使用的测试用例ID
  evaluationMethod: 'automated' | 'manual' | 'hybrid';
  evaluatorId?: string;                 // 评估者ID（人工评估时）

  // 评估数据源
  dataSources: {
    executionRecords?: string[];        // 关联的执行记录ID
    userFeedback?: UserFeedback[];      // 用户反馈数据
    testResults?: TestResult[];         // 测试结果
    costData?: CostData[];              // 成本数据
  };

  // 元数据
  metadata: {
    evaluationDuration: number;         // 评估耗时（毫秒）
    confidenceLevel: number;            // 评估置信度 0-1
    dataQualityScore: number;           // 数据质量评分 0-100
    version: string;                    // 评估模型版本
  };

  // 原始数据引用
  rawDataReferences: {
    executionData?: string;             // 执行数据快照或引用
    configuration?: Record<string, any>; // 评估配置
  };
}

// ==================== A/B实验模型 ====================

export interface ExperimentVariant {
  id: string;
  name: string;
  description: string;
  skillId: string;
  skillVersion: string;
  configuration?: Record<string, any>; // 变体特定配置
}

export interface ExperimentMetric {
  name: string;
  description: string;
  type: 'numeric' | 'boolean' | 'categorical';
  unit?: string;
  targetDirection: 'higher' | 'lower'; // 指标期望方向
  importance: number; // 1-5的重要性评分
}

export interface MetricResult {
  mean: number;
  stdDev: number;
  count: number;
  confidenceInterval?: [number, number]; // 置信区间
}

export interface ABExperiment {
  // 基础信息
  id: string;
  name: string;
  description: string;

  // 实验设计
  hypothesis: string;
  variants: {
    control: ExperimentVariant;
    treatment: ExperimentVariant;
    [key: string]: ExperimentVariant; // 支持多变量测试
  };

  // 实验配置
  metrics: ExperimentMetric[];
  sampleSize: number;
  randomizationUnit: 'user' | 'session' | 'task';

  // 实验状态
  status: 'draft' | 'running' | 'paused' | 'completed' | 'analyzed';
  startTime?: string;
  endTime?: string;

  // 参与者分配
  participantAllocation: {
    [variant: string]: string[]; // 参与者ID列表
  };

  // 实验结果
  results?: {
    [metric: string]: {
      control: MetricResult;
      treatment: MetricResult;
      difference: number;
      confidenceInterval: [number, number];
      pValue: number;
      isSignificant: boolean;
      effectSize: number;
    }
  };

  // 实验结论
  conclusion?: {
    summary: string;
    recommendation: 'adopt' | 'reject' | 'further_testing';
    confidence: number;
    businessImpact: string;
  };

  // 元数据
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

// ==================== 测试用例模型 ====================

export interface TestCase {
  // 基础信息
  id: string;
  name: string;
  description: string;

  // 测试内容
  input: any;
  expectedOutput?: any;
  expectedMetrics?: {
    [metric: string]: {
      min?: number;
      max?: number;
      target?: number;
    }
  };

  // 测试配置
  category: string; // 功能测试、性能测试、边界测试等
  difficulty: 'easy' | 'medium' | 'hard';
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];

  // 评估标准
  evaluationCriteria: {
    [criterion: string]: {
      weight: number;
      scoringFunction: string; // 评分函数引用
    }
  };

  // 元数据
  createdAt: string;
  updatedAt: string;
  author: string;
  version: string;

  // 历史结果
  historicalResults?: {
    [skillId: string]: {
      score: number;
      timestamp: string;
      details: any;
    }[]
  };
}

// ==================== 质量基准模型 ====================

export interface QualityBenchmark {
  // 基础信息
  id: string;
  name: string;
  description: string;
  type: 'internal' | 'industry' | 'team' | 'custom';

  // 基准值
  benchmarks: {
    [metric: string]: {
      excellent: number;    // 优秀阈值
      good: number;         // 良好阈值
      average: number;      // 平均阈值
      poor: number;         // 较差阈值
      unit: string;         // 单位
    }
  };

  // 适用范围
  applicableTo: {
    categories?: string[];  // 适用的技能分类
    tags?: string[];        // 适用的技能标签
    complexity?: string[];  // 适用的复杂度级别
  };

  // 元数据
  source?: string;          // 数据来源
  validityPeriod: {
    start: string;
    end?: string;
  };
  confidence: number;       // 基准置信度 0-1

  // 计算方式
  calculationMethod: string;
  sampleSize?: number;      // 样本量
  lastUpdated: string;
}

// ==================== 辅助类型 ====================

export interface UserFeedback {
  userId: string;
  timestamp: string;
  rating: number; // 1-5分
  comment?: string;
  category?: string; // 问题分类
  sentiment?: 'positive' | 'neutral' | 'negative';
}

export interface TestResult {
  testCaseId: string;
  timestamp: string;
  skillId: string;
  skillVersion: string;
  passed: boolean;
  executionTime?: number;
  output?: any;
  metrics?: {
    [metric: string]: MetricValue;
  };
}

export interface CostData {
  timestamp: string;
  skillId: string;
  costType: 'token' | 'api_call' | 'compute' | 'storage';
  amount: number;
  unit: string;
  currency?: string;
  context?: Record<string, any>;
}

export interface ScoreTrendData {
  skillId: string;
  timestamps: string[];
  scores: number[];
  dimensions: {
    functional: number[];
    efficiency: number[];
    practicality: number[];
    economic: number[];
  };
}

export interface ImprovementSuggestion {
  id: string;
  skillId: string;
  evaluationId: string;
  category: 'functional' | 'efficiency' | 'practicality' | 'economic' | 'general';
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  estimatedEffort: 'small' | 'medium' | 'large'; // 实施预估工作量
  expectedImpact: number; // 预期改进效果 0-100
  implementationSteps?: string[];
  adopted?: boolean;
  adoptedAt?: string;
  adoptedBy?: string;
}

// ==================== API请求/响应类型 ====================

export interface EvaluationSearchParams {
  skillId?: string;
  timeRange?: {
    start: string;
    end: string;
  };
  minScore?: number;
  maxScore?: number;
  evaluationMethod?: 'automated' | 'manual' | 'hybrid';
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'score' | 'confidence';
  sortOrder?: 'asc' | 'desc';
}

export interface EvaluationRunRequest {
  skillId: string;
  evaluationType: 'automated' | 'manual' | 'comparative';
  options?: {
    testCases?: string[]; // 指定测试用例ID
    evaluatorId?: string; // 人工评估时
    comparisonSkills?: string[]; // 对比评估时
    forceRefresh?: boolean; // 强制重新评估
  };
}

export interface ExperimentSearchParams {
  skillId?: string;
  status?: ABExperiment['status'];
  timeRange?: {
    start: string;
    end: string;
  };
  limit?: number;
  offset?: number;
}

export interface TestCaseSearchParams {
  category?: string;
  tags?: string[];
  difficulty?: TestCase['difficulty'];
  priority?: TestCase['priority'];
  query?: string; // 全文搜索
  limit?: number;
  offset?: number;
}

export interface BenchmarkSearchParams {
  type?: QualityBenchmark['type'];
  category?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface BenchmarkComparisonRequest {
  skillId: string;
  benchmarkId: string;
  includeDetails?: boolean;
}

export interface BenchmarkComparisonResult {
  skillId: string;
  benchmarkId: string;
  overallComparison: {
    skillScore: number;
    benchmarkScore: number;
    difference: number;
    percentile: number; // 技能在基准中的百分位
  };
  dimensionComparisons: {
    [dimension: string]: {
      skillScore: number;
      benchmarkScore: number;
      difference: number;
      status: 'excellent' | 'good' | 'average' | 'poor' | 'below_poor';
    }
  };
  recommendations: string[];
}

// ==================== 评估配置类型 ====================

export interface ScoringModelConfig {
  id: string;
  name: string;
  description: string;
  dimensionWeights: {
    functional: number;
    efficiency: number;
    practicality: number;
    economic: number;
  };
  subdimensionWeights: {
    functional: {
      accuracy: number;
      completeness: number;
      correctness: number;
      consistency: number;
    };
    efficiency: {
      speed: number;
      resourceEfficiency: number;
      successRate: number;
      stability: number;
    };
    practicality: {
      usability: number;
      maintainability: number;
      compatibility: number;
      extensibility: number;
    };
    economic: {
      costBenefit: number;
      roi: number;
      alternativeCost: number;
      maintenanceCost: number;
    };
  };
  metricNormalization: {
    [metric: string]: {
      min: number;
      max: number;
      ideal: number;
      unit: string;
    }
  };
  version: string;
  isDefault: boolean;
}

export interface EvaluationTemplate {
  id: string;
  name: string;
  description: string;
  skillCategories: string[]; // 适用的技能分类
  testCases: string[]; // 默认测试用例ID列表
  scoringModelId: string;
  evaluationMethod: 'automated' | 'manual' | 'hybrid';
  defaultOptions: Record<string, any>;
}

// ==================== 常量定义 ====================

// 评估维度常量
export const EVALUATION_DIMENSIONS = ['functional', 'efficiency', 'practicality', 'economic'] as const;
export type EvaluationDimension = typeof EVALUATION_DIMENSIONS[number];

// 功能性子维度
export const FUNCTIONAL_SUBDIMENSIONS = ['accuracy', 'completeness', 'correctness', 'consistency'] as const;

// 效率性子维度
export const EFFICIENCY_SUBDIMENSIONS = ['speed', 'resourceEfficiency', 'successRate', 'stability'] as const;

// 实用性子维度
export const PRACTICALITY_SUBDIMENSIONS = ['usability', 'maintainability', 'compatibility', 'extensibility'] as const;

// 经济性子维度
export const ECONOMIC_SUBDIMENSIONS = ['costBenefit', 'roi', 'alternativeCost', 'maintenanceCost'] as const;

// 测试用例分类
export const TEST_CASE_CATEGORIES = [
  '功能测试',
  '性能测试',
  '边界测试',
  '兼容性测试',
  '安全性测试',
  '可用性测试',
  '压力测试',
  '回归测试'
] as const;

// 质量基准类型
export const BENCHMARK_TYPES = ['internal', 'industry', 'team', 'custom'] as const;

// 实验状态
export const EXPERIMENT_STATUSES = ['draft', 'running', 'paused', 'completed', 'analyzed'] as const;

// 评估方法
export const EVALUATION_METHODS = ['automated', 'manual', 'hybrid'] as const;