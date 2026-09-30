interface Progress {
  failed: number;
  skipped?: number;
  unscored?: number;
}

export function describeExperimentOutcome(input: {
  status: string;
  execution?: Progress | null;
  evaluation?: Progress | null;
  score?: number | null;
  complete: boolean;
  trajectoryOnly?: boolean;
}) {
  const failures = (input.execution?.failed || 0) + (input.evaluation?.failed || 0);
  const unscored = input.evaluation?.unscored || 0;
  if (input.status === 'cancelled') return { successful: false, label: '已取消', conclusion: '已取消', hint: '实验已取消' };
  if (input.status === 'failed') return { successful: false, label: '实验失败', conclusion: '需处理', hint: '查看失败原因后重试' };
  if (!input.complete) return { successful: false, label: '运行中', conclusion: '计算中', hint: '等待运行与评测结束' };
  if (failures) return { successful: false, label: '已结束，存在失败项', conclusion: '需处理', hint: '部分执行或评测失败，当前数据不完整' };
  if (unscored || input.score == null) return { successful: false, label: '已结束，存在未计分项', conclusion: input.score == null ? '暂无评分结论' : '部分未计分', hint: '查看评估器结论及未计分原因' };
  if (input.trajectoryOnly) return { successful: true, label: '实验完成', conclusion: '轨迹评测完成', hint: '仅评估轨迹质量，未评估任务结果，不代表整体可用性' };
  return { successful: true, label: '实验完成', conclusion: input.score >= 80 ? '可使用' : '需优化', hint: '实验数据已完成评估' };
}
