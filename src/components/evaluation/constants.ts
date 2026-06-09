import type { StaticStandard } from './types';

/**
 * 静态评估 6 维度标准（与 src/lib/engine/skill-issues/static-evaluator/prompts.ts 对齐）。
 *
 * 2026-06 重整：
 *  - 替换"运维可靠性" → "安全风险性"（独立的威胁评估维度，详见 agent-scan issue-codes）
 *  - 重命名 / 扩展 "脚本及参考文档质量" → "工程健壮性"（吸收原"运维可靠性"中的灾难恢复 / 可观测性 / 人机协作子项）
 *  - L1 linter 全部归到 structure / security（原 'role' / 'content' alias 删除；旧数据归"其它静态扫描问题"分区）
 *
 * dimensionAliases 同时兼容 L2 LLM 的中文维度名 与 L1 linter 的英文枚举（structure / security）。
 */
export const STATIC_EVAL_STANDARDS: StaticStandard[] = [
    {
        key: 'purpose',
        title: '目的适配性',
        desc: '评估 Skill 是否具有清晰的单一目的，并能让 LLM 准确识别调用时机。',
        dimensionAliases: ['目的适配性'],
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
        dimensionAliases: ['内容一致性'],
    },
    {
        key: 'security',
        title: '安全风险性',
        desc: '检测 prompt injection / 硬编码 secret / 可疑下载 URL / 不安全凭据处理等 10 类威胁（参考 agent-scan issue-codes）。',
        dimensionAliases: ['安全风险性', 'security'],
    },
    {
        key: 'robustness',
        title: '工程健壮性',
        desc: '评估 Skill 关联的脚本独立性、错误处理、依赖管理，以及流程层面的灾难恢复、可观测性和人机协作设计。',
        dimensionAliases: ['工程健壮性'],
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
