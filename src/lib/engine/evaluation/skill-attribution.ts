/**
 * "Skill 归因"状态记录器——把 buildSkillKeyActionComparison 的 7 种内部状态映射成
 * 用户可见的 3 档（ok / degraded / not-applicable），写入 TrajectoryEvalResult.rawAnalysisJson
 * 让前端徽章读取。
 *
 * 这里抽出来是为了让单元测试不必拖整个 Next.js API route——逻辑很纯，单输入单输出。
 */

export type SkillKeyActionComparisonResult =
    | { status: 'ok'; referenceKeyActionsText: string; actualExtractedStepsText: string }
    | { status: 'no-skill-targets' }
    | { status: 'missing-skill'; missingSkills: string[] }
    | { status: 'missing-parsed-flow'; missingSkills: string[] }
    | { status: 'no-key-actions' }
    | { status: 'dynamic-analysis-failed' }
    | { status: 'no-extracted-steps' };

export type SkillAttributionState = 'ok' | 'degraded' | 'not-applicable';

export interface SkillAttributionStatus {
    state: SkillAttributionState;
    code: SkillKeyActionComparisonResult['status'];
    message: string;
}

/**
 * 把 comparison 结果转成 UI 徽章状态：
 *   - ok:             3 步全跑通，evaluator 走 skill_key_actions 模式
 *   - not-applicable: trace 没标 skill，本来就不该做 skill 归因（用户无需处理）
 *   - degraded:       想做但某一步失败了，evaluator 退到 trajectory-only 模式
 *
 * `degraded` 涵盖 5 种失败：
 *   missing-skill / missing-parsed-flow / no-key-actions /
 *   dynamic-analysis-failed / no-extracted-steps
 *
 * 每条 degraded 都带具体的中文 message，前端 hover 徽章可见。
 */
/**
 * 前端从 /api/eval/trajectory/results 拿到的 row（list 端点）或 single 端点的 result
 * 里抽出 skillAttribution。两个端点都把 rawAnalysisJson 解析后放在 row.rawAnalysis
 * 字段里——若不存在或字段不合法则返回 null。
 *
 * 抽到 lib 是为了：
 *   1) 让前端两处（skill-eval 页 + 评估中心详情页）共用同一份解析逻辑，避免漂移
 *   2) 让 UT 能锁住 API 契约——一旦哪天 list 端点又"忘了带 rawAnalysis"，UT 会先抓住
 */
export function parseSkillAttributionFromRow(
    row: { rawAnalysis?: unknown } | null | undefined,
): SkillAttributionStatus | null {
    const raw = row?.rawAnalysis;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const attr = (raw as Record<string, unknown>).skillAttribution;
    if (!attr || typeof attr !== 'object' || Array.isArray(attr)) return null;
    const obj = attr as Record<string, unknown>;
    const state = obj.state;
    if (state !== 'ok' && state !== 'degraded' && state !== 'not-applicable') return null;
    const code = obj.code;
    const message = obj.message;
    return {
        state,
        code: typeof code === 'string' ? (code as SkillAttributionStatus['code']) : 'ok',
        message: typeof message === 'string' ? message : '',
    };
}

export function buildSkillAttributionStatus(
    comparison: SkillKeyActionComparisonResult,
): SkillAttributionStatus {
    switch (comparison.status) {
        case 'ok':
            return {
                state: 'ok',
                code: 'ok',
                message: 'skill 关键步骤与 trace 实际步骤已完整对比',
            };
        case 'no-skill-targets':
            return {
                state: 'not-applicable',
                code: 'no-skill-targets',
                message: 'trace 未关联任何 skill，本次评测不做 skill 归因',
            };
        case 'missing-skill':
            return {
                state: 'degraded',
                code: 'missing-skill',
                message: `trace 关联的 skill 在 Skills 管理中找不到：${comparison.missingSkills.join('、')}`,
            };
        case 'missing-parsed-flow':
            return {
                state: 'degraded',
                code: 'missing-parsed-flow',
                message: `skill 尚未生成可用的解析流程，无法提取关键步骤：${comparison.missingSkills.join('、')}`,
            };
        case 'no-key-actions':
            return {
                state: 'degraded',
                code: 'no-key-actions',
                message: 'skill flow 解析成功但未识别出任何关键步骤',
            };
        case 'dynamic-analysis-failed':
            return {
                state: 'degraded',
                code: 'dynamic-analysis-failed',
                message: 'trace 步骤动态分析失败（通常是 LLM 未配置或调用失败）',
            };
        case 'no-extracted-steps':
            return {
                state: 'degraded',
                code: 'no-extracted-steps',
                message: '未能从 trace 中提取出实际执行步骤',
            };
    }
}
