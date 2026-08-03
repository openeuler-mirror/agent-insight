export interface FaultType {
  id: string;
  category: 'thinking' | 'tool' | 'communication' | 'resource';
  name: string;
  label: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
  platforms: string[];
  params: FaultParam[];
}

export interface FaultParam {
  key: string;
  label: string;
  type: 'text' | 'number';
  placeholder?: string;
  defaultValue?: string;
}

export const FAULT_TYPES: FaultType[] = [
  {
    id: 'thinking_loop',
    category: 'thinking',
    name: 'thinking_loop',
    label: '思考循环',
    description: 'Agent 陷入无限思考循环，反复生成相似内容但不调用工具',
    severity: 'critical',
    platforms: ['openjiuwen', 'opencode', 'hermes', 'openclaw'],
    params: [{ key: 'max_iter', label: '最大循环次数', type: 'number', defaultValue: '3', placeholder: '3' }],
  },
  {
    id: 'repeated_reasoning',
    category: 'thinking',
    name: 'repeated_reasoning',
    label: '重复推理',
    description: 'Agent 在不同阶段重复相同的推理过程',
    severity: 'warning',
    platforms: ['openjiuwen', 'opencode', 'hermes'],
    params: [{ key: 'threshold', label: '重复次数阈值', type: 'number', defaultValue: '5', placeholder: '5' }],
  },
  {
    id: 'hallucination_drift',
    category: 'thinking',
    name: 'hallucination_drift',
    label: '幻觉漂移',
    description: 'Agent 生成的内容逐渐偏离事实，产生幻觉输出',
    severity: 'warning',
    platforms: ['openjiuwen', 'opencode', 'hermes', 'openclaw'],
    params: [{ key: 'drift_ratio', label: '漂移比率', type: 'text', defaultValue: '0.3', placeholder: '0.3' }],
  },
  {
    id: 'tool_timeout',
    category: 'tool',
    name: 'tool_timeout',
    label: '工具超时',
    description: 'Agent 调用工具时超时未返回结果',
    severity: 'critical',
    platforms: ['openjiuwen', 'opencode', 'hermes', 'openclaw'],
    params: [{ key: 'timeout_ms', label: '超时毫秒数', type: 'number', defaultValue: '30000', placeholder: '30000' }],
  },
  {
    id: 'tool_error',
    category: 'tool',
    name: 'tool_error',
    label: '工具错误',
    description: 'Agent 调用工具时返回异常错误',
    severity: 'critical',
    platforms: ['openjiuwen', 'opencode', 'hermes', 'openclaw'],
    params: [
      { key: 'error_rate', label: '错误率（0-1）', type: 'text', defaultValue: '0.5', placeholder: '0.5' },
      { key: 'error_code', label: '错误码', type: 'text', defaultValue: '500', placeholder: '500' },
    ],
  },
  {
    id: 'repeated_tool',
    category: 'tool',
    name: 'repeated_tool',
    label: '工具重复调用',
    description: 'Agent 短时间内重复调用同一工具且参数未发生有效变化',
    severity: 'warning',
    platforms: ['openjiuwen', 'opencode', 'hermes', 'openclaw'],
    params: [{ key: 'repeat_count', label: '重复次数', type: 'number', defaultValue: '3', placeholder: '3' }],
  },
  {
    id: 'tool_output_parse_error',
    category: 'tool',
    name: 'tool_output_parse_error',
    label: '工具输出解析错误',
    description: 'Agent 无法正确解析工具返回的输出格式',
    severity: 'warning',
    platforms: ['openjiuwen', 'opencode', 'hermes'],
    params: [{ key: 'parse_rate', label: '解析失败率', type: 'text', defaultValue: '0.3', placeholder: '0.3' }],
  },
  {
    id: 'connection_lost',
    category: 'communication',
    name: 'connection_lost',
    label: '连接丢失',
    description: 'Agent 与外部服务的连接中断',
    severity: 'critical',
    platforms: ['openjiuwen', 'opencode', 'hermes', 'openclaw'],
    params: [{ key: 'reconnect_attempts', label: '重连尝试次数', type: 'number', defaultValue: '3', placeholder: '3' }],
  },
  {
    id: 'api_rate_limit',
    category: 'communication',
    name: 'api_rate_limit',
    label: 'API 限流',
    description: 'Agent 调用外部 API 时触发频率限制',
    severity: 'warning',
    platforms: ['openjiuwen', 'opencode', 'hermes', 'openclaw'],
    params: [{ key: 'retry_after', label: '重试等待秒数', type: 'number', defaultValue: '60', placeholder: '60' }],
  },
  {
    id: 'auth_expired',
    category: 'communication',
    name: 'auth_expired',
    label: '认证过期',
    description: 'Agent 的 API 认证令牌过期，无法继续操作',
    severity: 'critical',
    platforms: ['openjiuwen', 'opencode'],
    params: [],
  },
  {
    id: 'context_overflow',
    category: 'resource',
    name: 'context_overflow',
    label: '上下文溢出',
    description: 'Agent 的上下文窗口超出模型限制',
    severity: 'warning',
    platforms: ['openjiuwen', 'opencode', 'hermes', 'openclaw'],
    params: [{ key: 'max_tokens', label: '最大 tokens', type: 'number', defaultValue: '128000', placeholder: '128000' }],
  },
  {
    id: 'token_exhausted',
    category: 'resource',
    name: 'token_exhausted',
    label: 'Token 耗尽',
    description: 'Agent 运行超出预算的 token 配额',
    severity: 'warning',
    platforms: ['openjiuwen', 'opencode'],
    params: [{ key: 'budget_tokens', label: 'Token 预算', type: 'number', defaultValue: '100000', placeholder: '100000' }],
  },
];

export const MOCK_INJECTION_HISTORY: InjectionRecord[] = [
  {
    id: 'mock-001',
    faultType: 'thinking_loop',
    platform: 'openjiuwen',
    target: 'deep-agent-v3',
    status: 'completed',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    params: { max_iter: '5' },
  },
  {
    id: 'mock-002',
    faultType: 'tool_timeout',
    platform: 'opencode',
    target: 'code-review-bot',
    status: 'completed',
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    params: { timeout_ms: '15000' },
  },
  {
    id: 'mock-003',
    faultType: 'connection_lost',
    platform: 'openjiuwen',
    target: 'deep-agent-v3',
    status: 'failed',
    createdAt: new Date(Date.now() - 10800000).toISOString(),
    params: { reconnect_attempts: '3' },
  },
  {
    id: 'mock-004',
    faultType: 'tool_error',
    platform: 'hermes',
    target: 'hermes-agent-01',
    status: 'completed',
    createdAt: new Date(Date.now() - 14400000).toISOString(),
    params: { error_rate: '0.3', error_code: '503' },
  },
];

export interface InjectionRecord {
  id: string;
  faultType: string;
  platform: string;
  target: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  params: Record<string, unknown>;
}
