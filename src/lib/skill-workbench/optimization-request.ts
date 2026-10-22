export function hasOptimizationInput(feedback: string, issues: Array<{ summary: string }>, planItems?: Array<{ title: string }>) {
  return Boolean(feedback.trim() || (planItems === undefined
    ? issues.some((issue) => issue.summary.trim())
    : planItems.some((item) => item.title.trim())));
}
