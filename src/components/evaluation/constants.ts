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

/**
 * 静态评估总分 + 各维度贡献分的【唯一口径】——列表页与详情页共用这一个函数，
 * 杜绝「列表 90 / 详情 91」这类两页不一致（根因是两边各自用不同的取整顺序聚合）。
 *
 * 口径：
 *   - 已评估维度数 N 把 100 分均分，每维度满分 = 100/N；
 *   - 单维度贡献 contribution = round((score/5) × (100/N))（score ∈ 0..5）；
 *   - 总分 total = Σ contribution。
 *
 * 因为总分就是各维度贡献的和，所以天然满足「小分加起来 = 总分」，
 * 且相同的维度分得到完全相同的贡献分（不会出现配额法那种「同分不同贡献」的怪象）。
 * 未评估的维度不计入分母（用户要求）；无任何 L2 维度分 → total = null，调用方显示 `--`。
 */
export interface StaticScoreResult {
    /** 静态合规总分 0..100；没有任何已评估维度时为 null */
    total: number | null;
    /** 实际被 L2 评估的维度数（= 均分分母） */
    scoredCount: number;
    /** STATIC_EVAL_STANDARDS.key → 该维度整数贡献分；Σ 恰等于 total */
    contributionByKey: Record<string, number>;
}

export function computeStaticScore(
    scores: Record<string, number> | null | undefined,
): StaticScoreResult {
    if (!scores) return { total: null, scoredCount: 0, contributionByKey: {} };

    // 按标准顺序收集已评估维度（dimensionAliases 容错 L2 中文名 / L1 英文枚举）
    const evaluated: { key: string; score: number }[] = [];
    for (const std of STATIC_EVAL_STANDARDS) {
        const v = std.dimensionAliases
            .map(a => scores[a])
            .find(s => typeof s === 'number' && Number.isFinite(s));
        if (typeof v === 'number') evaluated.push({ key: std.key, score: v });
    }
    const n = evaluated.length;
    if (n === 0) return { total: null, scoredCount: 0, contributionByKey: {} };

    const contributionByKey: Record<string, number> = {};
    let total = 0;
    for (const d of evaluated) {
        const contribution = Math.round((d.score / 5) * (100 / n));
        contributionByKey[d.key] = contribution;
        total += contribution;
    }
    return { total, scoredCount: n, contributionByKey };
}

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
