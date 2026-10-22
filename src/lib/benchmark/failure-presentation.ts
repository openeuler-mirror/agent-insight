export interface BenchmarkFailurePresentation {
  code: string;
  originalCode?: string;
  label: string;
  message: string;
}

const FAILURE_META: Record<string, { label: string; message: string }> = {
  MODEL_CONFIGURATION_INVALID: {
    label: '模型配置解析失败',
    message: '执行端无法解析所选模型配置，模型请求尚未发出。请查看具体原因并检查执行机器上的原生 Agent 配置。',
  },
  MODEL_CREDENTIAL_MISSING: {
    label: '未取得模型凭据',
    message: '执行端未取得所选模型凭据，模型请求尚未发出。请检查执行机器上的原生 Agent 凭据配置后重跑 Case。',
  },
  MODEL_CREDENTIAL_STORE_UNREADABLE: {
    label: '原生凭据库读取失败',
    message: '执行端无法读取或解密原生凭据库，请检查运行账号、文件权限及 Vault/SDF 环境。模型请求尚未发出。',
  },
  MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE: {
    label: '模型凭据适配未就绪',
    message: '客户端凭据桥接缺失、版本不兼容或不支持当前认证方式，请更新客户端并查看具体原因；这不代表模型或 Key 无效。',
  },
  XGOVERNOR_REJECTED: {
    label: '执行环境请求被拒绝',
    message: 'xGovernor 拒绝执行请求，请检查客户端安装与会话配置。',
  },
  ENOSPC: {
    label: '执行端存储空间不足',
    message: '执行端文件系统空间或 inode 不足，请检查对应挂载点后手动重试。',
  },
  EDQUOT: {
    label: '执行端存储配额不足',
    message: '执行端存储配额已耗尽，请检查配额后手动重试。',
  },
  EVENT_MONITOR_UNAVAILABLE: {
    label: '失败监测通道未就绪',
    message: 'OpenCode 事件插件未就绪，请更新客户端并检查插件加载。',
  },
  AGENT_TIMEOUT: {
    label: 'Agent 执行超时',
    message: 'Agent 在规定时间内未完成，执行进程已终止。',
  },
  MODEL_UNAVAILABLE: {
    label: '模型不可用',
    message: '模型或模型服务不可用，Agent 未能正常执行。',
  },
  MODEL_ERROR: {
    label: '模型调用失败',
    message: 'Agent 已报告模型或 Provider 错误，执行已提前终止。',
  },
  MODEL_NO_RESPONSE: {
    label: '模型未响应',
    message: 'Agent 会话已结束，但没有产生任何模型输出或工具调用。',
  },
  MODEL_START_TIMEOUT: {
    label: '等待模型响应超时',
    message: '会话已创建，但在首响应时限内未观察到模型活动。',
  },
  AGENT_EXIT_NONZERO: {
    label: 'Agent 异常退出',
    message: 'Agent 进程异常退出，未生成有效提交。',
  },
  AGENT_NO_OUTPUT: {
    label: 'Agent 无有效输出',
    message: 'Agent 已结束，但没有生成有效提交物。',
  },
  TRACE_ID_MISSING: {
    label: 'Trace 未上报',
    message: 'Agent 执行结束，但没有获得有效 Trace ID。',
  },
};

const KNOWN_FAILURE_CODE = new RegExp(`\\b(${Object.keys(FAILURE_META).join('|')})\\b`);

export function benchmarkFailurePresentation(
  code: string | null | undefined,
  message: string | null | undefined,
): BenchmarkFailurePresentation | null {
  const normalizedMessage = message?.trim() || '';
  const originalCode = code?.trim() || normalizedMessage.match(KNOWN_FAILURE_CODE)?.[1] || '';
  const storageCode = /\bEDQUOT\b|disk quota exceeded/i.test(normalizedMessage) ? 'EDQUOT'
    : /\bENOSPC\b|no space left on device/i.test(normalizedMessage) ? 'ENOSPC' : '';
  const normalizedCode = storageCode && ['', 'MODEL_ERROR', 'AGENT_EXIT_NONZERO', 'WORKSPACE_PREPARE_FAILED', 'EXECUTION_FAILED'].includes(originalCode)
    ? storageCode : originalCode;
  if (!normalizedCode && !normalizedMessage) return null;

  const meta = FAILURE_META[normalizedCode];
  const legacyCredentialMessage = normalizedCode === 'MODEL_CONFIGURATION_INVALID'
    && normalizedMessage === '所选模型凭据不可用，请完成原有 Agent 的模型配置或登录';
  return {
    code: normalizedCode,
    ...(originalCode && originalCode !== normalizedCode ? { originalCode } : {}),
    label: meta?.label || 'Agent 执行失败',
    message: legacyCredentialMessage
      ? '执行端未取得所选模型凭据。旧版记录未区分凭据缺失与凭据适配不支持，请更新客户端后重跑 Case 获取具体原因；这不代表模型或 Key 无效。'
      : normalizedMessage && normalizedMessage !== normalizedCode
      ? normalizedMessage
      : meta?.message || 'Agent 执行未成功完成。',
  };
}
