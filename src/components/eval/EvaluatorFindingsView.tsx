'use client';

/**
 * 评估器深度分析视图——展示 trajectory + result evaluator 产出的 4 类 finding：
 *   deviation_steps     → 路径偏离
 *   key_point_findings  → 关键动作未覆盖（covered=false 的）
 *   tool_choice_findings → 工具选择
 *   result_issues        → 结果问题（format / extra_content / verbosity / incorrect_fact）
 *
 * 每条 finding 带 is_skill_attributable 徽章 + improvement_suggestion。从原来嵌在
 * skill-eval/page.tsx 的 TrajectoryEvaluatorFindings 抽出来，让 skill 分析页和
 * 评测中心详情页（TrajectoryDetailView）都能复用，避免两份代码漂移。
 *
 * 用法：传入解析后的 row（含 deviationSteps + rawAnalysis），组件内部自己抽 findings。
 * 样式依赖 skill-analysis.css 里的 .sa-dx-eval-* 类。
 */

import './evaluator-findings-view.css';

// 与 skill-eval/page.tsx 中的 EvaluatorFinding 保持一致
export interface EvaluatorFinding {
    kind: 'deviation' | 'key_point' | 'tool_choice' | 'result_issue';
    title: string;
    description?: string;
    severity?: 'high' | 'medium' | 'low';
    stepIndex?: number;
    covered?: boolean;
    isSkillAttributable?: boolean;
    improvementSuggestion?: string;
}

export interface EvaluatorFindingsRowLike {
    deviationSteps?: unknown;
    /** API 端解析过的 rawAnalysisJson；可能是任何形状，组件内部会自己窄化校验 */
    rawAnalysis?: unknown;
}

function pickAttr(obj: Record<string, unknown>, snakeKey: string, camelKey: string): unknown {
    if (snakeKey in obj && obj[snakeKey] !== undefined) return obj[snakeKey];
    if (camelKey in obj && obj[camelKey] !== undefined) return obj[camelKey];
    return undefined;
}

export function extractFindings(row: EvaluatorFindingsRowLike): EvaluatorFinding[] {
    const out: EvaluatorFinding[] = [];

    // 1) deviation_steps（API 已解析为 row.deviationSteps 数组）
    const dev: Record<string, unknown>[] = Array.isArray(row.deviationSteps)
        ? (row.deviationSteps as Record<string, unknown>[])
        : [];
    for (const d of dev) {
        const isAttr = pickAttr(d, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(d, 'improvement_suggestion', 'improvementSuggestion');
        out.push({
            kind: 'deviation',
            title: String(d.name ?? d.kind ?? '路径偏离') + (d.stepIndex != null ? ` · 步骤 ${d.stepIndex}` : ''),
            description: typeof d.deviation === 'string' ? d.deviation : undefined,
            severity: typeof d.severity === 'string' ? d.severity as EvaluatorFinding['severity'] : undefined,
            stepIndex: typeof d.stepIndex === 'number' ? d.stepIndex : undefined,
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    // raw 可能是任何形状（API 返回过来的 unknown），先窄到 Record
    const raw: Record<string, unknown> | null =
        row.rawAnalysis && typeof row.rawAnalysis === 'object' && !Array.isArray(row.rawAnalysis)
            ? (row.rawAnalysis as Record<string, unknown>)
            : null;
    const findFromRaw = (key: string): Record<string, unknown>[] => {
        if (!raw) return [];
        const direct = raw[key];
        if (Array.isArray(direct)) return direct as Record<string, unknown>[];
        const resultEval = raw.resultEvaluation;
        if (resultEval && typeof resultEval === 'object' && Array.isArray((resultEval as Record<string, unknown>)[key])) {
            return (resultEval as Record<string, unknown>)[key] as Record<string, unknown>[];
        }
        return [];
    };

    // 2) key_point_findings 仅展示 covered=false 的
    for (const f of findFromRaw('key_point_findings')) {
        const covered = pickAttr(f, 'covered', 'covered');
        if (covered === true) continue;
        const isAttr = pickAttr(f, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(f, 'improvement_suggestion', 'improvementSuggestion');
        out.push({
            kind: 'key_point',
            title: `关键动作未覆盖：${String(f.content ?? '未命名要点')}`,
            description: typeof f.explanation === 'string' ? f.explanation : undefined,
            severity: typeof f.severity === 'string' ? f.severity as EvaluatorFinding['severity'] : undefined,
            covered: false,
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    // 3) tool_choice_findings
    for (const f of findFromRaw('tool_choice_findings')) {
        const isAttr = pickAttr(f, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(f, 'improvement_suggestion', 'improvementSuggestion');
        out.push({
            kind: 'tool_choice',
            title: `工具选择问题：${String(f.tool ?? f.issue ?? '工具调用')}` + (f.step_index != null || f.stepIndex != null ? ` · 步骤 ${f.step_index ?? f.stepIndex}` : ''),
            description: typeof f.reason === 'string' ? f.reason : (typeof f.issue === 'string' ? f.issue : undefined),
            severity: typeof f.severity === 'string' ? f.severity as EvaluatorFinding['severity'] : undefined,
            stepIndex: typeof f.step_index === 'number' ? f.step_index as number : (typeof f.stepIndex === 'number' ? f.stepIndex as number : undefined),
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    // 4) result_issues（任务完成度评估器的输出）
    const RESULT_KIND_LABEL: Record<string, string> = {
        format: '格式偏差',
        extra_content: '多余内容',
        verbosity: '表达问题',
        incorrect_fact: '事实错误',
        other: '结果问题',
    };
    for (const f of findFromRaw('result_issues')) {
        const isAttr = pickAttr(f, 'is_skill_attributable', 'isSkillAttributable');
        const suggestion = pickAttr(f, 'improvement_suggestion', 'improvementSuggestion');
        const subKind = typeof f.kind === 'string' ? f.kind : 'other';
        out.push({
            kind: 'result_issue',
            title: `${RESULT_KIND_LABEL[subKind] || subKind}：${String(f.summary ?? '未命名问题')}`,
            severity: typeof f.severity === 'string' ? f.severity as EvaluatorFinding['severity'] : undefined,
            isSkillAttributable: typeof isAttr === 'boolean' ? isAttr : true,
            improvementSuggestion: typeof suggestion === 'string' ? suggestion : undefined,
        });
    }

    return out;
}

const FINDING_KIND_LABEL: Record<EvaluatorFinding['kind'], string> = {
    deviation: '路径偏离',
    key_point: '关键动作',
    tool_choice: '工具选择',
    result_issue: '结果问题',
};

export function EvaluatorFindingsView({ row }: { row: EvaluatorFindingsRowLike }) {
    const findings = extractFindings(row);
    if (findings.length === 0) {
        return (
            <div className="efv-empty">
                ✓ 评估器未识别出可归因到 Skill 的问题（这条 Trace 流程合规）
            </div>
        );
    }
    const grouped: Record<EvaluatorFinding['kind'], EvaluatorFinding[]> = {
        deviation: [], key_point: [], tool_choice: [], result_issue: [],
    };
    for (const f of findings) grouped[f.kind].push(f);

    const totalAttrCount = findings.filter(f => f.isSkillAttributable !== false).length;
    const nonAttrCount = findings.length - totalAttrCount;

    return (
        <div className="efv-root">
            <div className="efv-summary">
                <span>评估器识别出 <b>{findings.length}</b> 条问题</span>
                <span className="efv-summary-sep">·</span>
                <span><b className="efv-attr-num">{totalAttrCount}</b> 条可归因到 Skill</span>
                {nonAttrCount > 0 && (
                    <>
                        <span className="efv-summary-sep">·</span>
                        <span className="efv-non-attr-num">{nonAttrCount} 条 model/工具问题（不进优化）</span>
                    </>
                )}
            </div>
            {(Object.keys(grouped) as EvaluatorFinding['kind'][]).map(kind => {
                const items = grouped[kind];
                if (items.length === 0) return null;
                return (
                    <div key={kind} className="efv-group">
                        <div className="efv-group-head">
                            {FINDING_KIND_LABEL[kind]}
                            <span className="efv-group-count">{items.length}</span>
                        </div>
                        {items.map((f, i) => (
                            <div key={i} className={`efv-card${f.severity ? ' sev-' + f.severity : ''}${f.isSkillAttributable === false ? ' non-attr' : ''}`}>
                                <div className="efv-card-head">
                                    <span className="efv-title">{f.title}</span>
                                    {f.severity && <span className={`efv-pill ${f.severity === 'high' ? 'err' : f.severity === 'medium' ? 'warn' : ''}`}>{f.severity}</span>}
                                    {f.isSkillAttributable === false && (
                                        <span className="efv-pill" title="评估器判定此问题不能通过修改 SKILL.md 解决，不会进入 skill-opt">
                                            非 Skill 问题
                                        </span>
                                    )}
                                </div>
                                {f.description && <div className="efv-desc">{f.description}</div>}
                                {f.improvementSuggestion && f.isSkillAttributable !== false && (
                                    <div className="efv-suggestion">
                                        <span className="efv-suggestion-label">改进建议</span>
                                        {f.improvementSuggestion}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}
