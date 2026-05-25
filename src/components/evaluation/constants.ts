import type { StaticStandard } from './types';

/**
 * 静态评估 6 维度标准（与 src/lib/engine/skill-issues/static-evaluator/prompts.ts 对齐）。
 * dimensionAliases 同时兼容 L2 LLM 的中文维度名 与 L1 linter 的英文枚举（role/structure/content），
 * 以及历史遗留名「代码质量」→ 6. 脚本及参考文档质量。
 */
export const STATIC_EVAL_STANDARDS: StaticStandard[] = [
    {
        key: 'purpose',
        title: '目的适配性',
        desc: '评估 Skill 是否具有清晰的单一目的，并能让 LLM 准确识别调用时机。',
        dimensionAliases: ['目的适配性', 'role'],
    },
    {
        key: 'structure',
        title: '结构规范性',
        desc: '评估 Skill 的元数据规范、内容组织和信息密度。',
        dimensionAliases: ['结构规范性', 'structure'],
    },
    {
        key: 'instruction',
        title: '指令适配性',
        desc: '评估指令自由度是否与任务的风险等级和确定性相匹配。',
        dimensionAliases: ['指令适配性'],
    },
    {
        key: 'consistency',
        title: '内容一致性',
        desc: '评估 Skill 在术语、表达风格是否保持一致，且不依赖隐含的时效性假设。',
        dimensionAliases: ['内容一致性', 'content'],
    },
    {
        key: 'reliability',
        title: '运维可靠性',
        desc: '评估 Skill 的安全边界、灾难恢复和操作可观测性。',
        dimensionAliases: ['运维可靠性'],
    },
    {
        key: 'asset',
        title: '脚本及参考文档质量',
        desc: '评估 Skill 关联的参考实现和脚本文件，强调其独立性、健壮性与自愈能力。',
        dimensionAliases: ['脚本及参考文档质量', '代码质量'],
    },
];

export const SEVERITY_LABEL: Record<'high' | 'medium' | 'low', string> = {
    high: '高',
    medium: '中',
    low: '低',
};

export function severityColor(s: string): string {
    return s === 'high' ? '#dc2626' : s === 'medium' ? '#ea580c' : '#65a30d';
}

export function scoreColor(score: number): string {
    if (score >= 4.5) return '#16a34a';
    if (score >= 3.5) return '#ca8a04';
    if (score >= 2.5) return '#ea580c';
    return '#dc2626';
}
