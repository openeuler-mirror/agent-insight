// Skill 优化模块的接口形状。
// 命名沿用 _mock.ts 里的同名 interface（外部已大量引用），从 mock 文件里抽出后
// mock 文件可整体删除——只剩"是不是真实数据"的差异，类型本身一直就是真实接口。

export interface SkillVersion {
    version: number;
    createdAt: string;
    changeLog?: string;
}

export interface SkillSummary {
    id: string;
    name: string;
    description: string;
    category: string;
    author: string;
    tags: string[];
    activeVersion: number;
    updatedAt: string;
    versions: SkillVersion[];
}

export interface OptIssue {
    id: string;
    severity: 'high' | 'medium' | 'low';
    category: string;
    summary: string;
    evidence?: string;
    /**
     * 评估器子代理给出的"应当在 SKILL.md 哪段加什么约束"具体建议。
     * 仅当评估器判定 is_skill_attributable=true 时才有值；用户在 skill-opt 页可看到，
     * 提交优化时也会作为 prompt 的一部分喂给 agent。
     */
    improvementSuggestion?: string;
    /**
     * 这个 issue 的"出处"。前端会渲染成可点击链接，跳到对应来源页/资源。
     * - trace / fault / log: url 必填，点击跳页
     * - static: SKILL.md 等静态扫描结果，url 可选（指向具体文件/行）
     */
    source?: {
        kind: 'trace' | 'fault' | 'log' | 'static';
        label: string;     // 显示文本，例如 "trace tr_28a91" 或 "fault 报告 #12"
        url?: string;      // 同源跳转路径或外链；缺失时只展示 label，不可点击
    };
}

/**
 * 一次优化迭代（"草稿 #N"）——基础版本之上的全量文件快照 + agent 的修改总结。
 * 持久化在 SkillOptSession.iterations 里；前端切草稿 / 跑 diff 全靠这个结构。
 */
export interface OptimizationIteration {
    id: string;             // 'iter_001'
    label: string;          // '草稿 #1' — 显示用
    baseVersion: number;    // 基于哪个发布版本
    createdAt: string;
    summary: string;
    files: Record<string, string>;  // 全量文件快照
}
