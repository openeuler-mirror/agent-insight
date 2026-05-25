'use client';

/**
 * 跨评估器复用的"分析标准 + 折叠 issue 卡片"组件。
 *
 * 抽自 EvaluationContent 里原本静态合规专用的 StandardGroupedIssues / StandardRow /
 * IssueCard / FlatIssueList。设计目的：让用例分析 / 召回 / A/B 这些其他评估器也能
 * 用同一套折叠卡视觉风格，保持 4 个评估器详情页"结果展示"区视觉一致。
 *
 * 两种入口：
 *   - FindingsGrouped: 主分组形态——K 个评估维度，每个挂 N 条 finding
 *     （静态合规天然适配；用例分析也可按"关键观点 / 路径偏离 / 工具选择"等大类分组）
 *   - FindingsFlat: 扁平形态——一组 finding 不分维度（动态评估、A/B case 列表等）
 *
 * 类型从 IssueRow 推广成更轻量的 FindingItem，调用方只需要 summary + severity +
 * 三段说明（evidence / reasoning / suggestedFix）。
 */

import { useState } from 'react';
import './evaluation-content.css';
import { SEVERITY_LABEL } from './constants';
import type { Severity } from './types';

export type FindingStatus = 'passed' | 'failed' | 'notEvaluated';

export interface FindingItem {
    id: string;
    summary: string;
    severity: Severity;
    /** 主原因（什么证据导致这个判定）。映射 IssueRow.evidence */
    evidence?: string | null;
    /** 进一步推理说明 */
    reasoning?: string | null;
    /** 改进建议 */
    suggestedFix?: string | null;
    /** 维度名（小灰字 hint，可选）*/
    dimension?: string | null;
    /** 元信息——展示在 issue 卡底部 */
    ruleId?: string | null;
    category?: string | null;
    dedupKey?: string | null;
    /**
     * 单条 item 是否通过。默认 undefined = 视为"失败 item"（旧静态合规语义，所有 item 都是 issue）。
     * 设 true → 渲染轻量风格（绿勾 + 无 severity 徽章 + 不展开 evidence/suggestion），
     * 让"通过的 case 也能在折叠组里看到"成为可能（召回分析需要）。
     */
    passed?: boolean;
}

export interface FindingGroup {
    key: string;
    title: string;
    desc: string;
    status: FindingStatus;
    items: FindingItem[];
    /** 已格式化的分数标签（如 "80%"、"3/5"、"p<0.05"）；不传则只显示问题数 */
    scoreLabel?: string;
}

/* ───────── 主分组形态（首选）───────── */

export function FindingsGrouped({
    groups,
    otherItems = [],
    hasScores = true,
    title = '分析标准',
    hint = '展开查看每个标准下的优化点细节',
    otherTitle = '其它问题',
    otherDesc = '未匹配到上述分组的检查项',
    emptyMessage = '本次评估未发现优化点 ✓',
}: {
    groups: FindingGroup[];
    /** 不能归入主分组的兜底 items；为空数组就不渲染 "其它" 行 */
    otherItems?: FindingItem[];
    /** 是否有有效的 scoreLabel——影响"未评估"vs"通过"判定显示 */
    hasScores?: boolean;
    title?: string;
    hint?: string;
    otherTitle?: string;
    otherDesc?: string;
    emptyMessage?: string;
}) {
    const total = groups.reduce((n, g) => n + g.items.length, 0) + otherItems.length;
    if (total === 0 && hasScores) {
        return <div className="ev-empty">{emptyMessage}</div>;
    }
    return (
        <div className="ev-standards">
            <div className="ev-standards-head">
                <h3>{title}</h3>
                <span>{hint}</span>
            </div>
            {groups.map(g => <GroupRow key={g.key} group={g} />)}
            {otherItems.length > 0 && (
                <GroupRow
                    key="__other__"
                    group={{
                        key: '__other__',
                        title: otherTitle,
                        desc: otherDesc,
                        status: 'failed',
                        items: otherItems,
                    }}
                />
            )}
        </div>
    );
}

function GroupRow({ group: g }: { group: FindingGroup }) {
    // 只统计"未通过"items 作为问题数；passed item 是通过的 case，不算问题
    const failedItems = g.items.filter(i => !i.passed);
    const passedItems = g.items.filter(i => i.passed);

    // 视觉降级：标记 passed 但有 failed item / 子项分数明显偏低时 → 'warn'（黄色 ⚠）
    const visual: 'passed' | 'failed' | 'notEvaluated' | 'warn' =
        g.status === 'passed' && failedItems.length > 0 ? 'warn' : g.status;

    const [open, setOpen] = useState(false);
    // 只要有任何 items（含 passed）都允许展开，让用户能看到通过的 case 列表
    const interactive = g.items.length > 0;

    const icon = visual === 'passed' ? '✓'
        : visual === 'notEvaluated' ? '—'
            : visual === 'warn' ? '⚠'
                : '×';

    const worst = worstSeverity(failedItems);
    const valueParts: string[] = [];
    if (g.scoreLabel) valueParts.push(g.scoreLabel);
    else if (g.status === 'notEvaluated') valueParts.push('未评估');
    valueParts.push(failedItems.length === 0 ? '无问题' : `${failedItems.length} 个问题`);

    return (
        <article className={`ev-standard ${visual} ${open ? 'open' : ''}`}>
            <button
                type="button"
                className="ev-standard-head"
                onClick={() => interactive && setOpen(v => !v)}
            >
                <span className="ev-standard-icon">{icon}</span>
                <span>
                    <b>{g.title}</b>
                    <small>{g.desc}</small>
                </span>
                <code>{valueParts.join(' · ')}</code>
                {worst ? <em className={`ev-sev-tag ${worst}`} style={{ fontStyle: 'normal' }}>{worst.toUpperCase()}</em> : <i />}
                <span className="ev-chev">›</span>
            </button>
            {open && g.items.length > 0 && (
                <div className="ev-standard-body">
                    {/* 失败 item 优先；通过 item 排后面（轻量样式） */}
                    {failedItems.map(item => <IssueCard key={item.id} item={item} />)}
                    {passedItems.length > 0 && failedItems.length > 0 && (
                        <div style={{ padding: '6px 4px 0', fontSize: 11, color: 'var(--ev-muted)' }}>
                            以下 {passedItems.length} 条为通过项 ✓
                        </div>
                    )}
                    {passedItems.map(item => <IssueCard key={item.id} item={item} />)}
                </div>
            )}
        </article>
    );
}

/* ───────── 扁平形态（动态评估、case 列表等无显式维度分组的场景）───────── */

export function FindingsFlat({
    items,
    histogram,
    title = '优化点',
}: {
    items: FindingItem[];
    histogram?: Record<Severity, number>;
    title?: string;
}) {
    if (items.length === 0) {
        return <div className="ev-empty">本次评估未发现优化点 ✓</div>;
    }
    const hist = histogram ?? items.reduce<Record<Severity, number>>((acc, i) => {
        acc[i.severity] = (acc[i.severity] || 0) + 1;
        return acc;
    }, { high: 0, medium: 0, low: 0 });
    return (
        <div className="ev-standards">
            <div className="ev-standards-head">
                <h3>{title}</h3>
                <span>共 {items.length} 条 · 高 {hist.high} / 中 {hist.medium} / 低 {hist.low}</span>
            </div>
            <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {items.map(i => <IssueCard key={i.id} item={i} />)}
            </div>
        </div>
    );
}

/* ───────── 单条 finding 卡（两种形态共用）───────── */

export function IssueCard({ item }: { item: FindingItem }) {
    // 通过的 item 走轻量渲染：绿勾 + summary + 可选 evidence；不显示 severity 徽章和"建议"
    // （已经通过的没什么要建议的）。让"展示通过的 case"成为一个轻量副视图。
    if (item.passed) {
        return (
            <div className="ev-issue" style={{ borderLeftColor: 'var(--sa-success, #16a34a)', background: 'rgba(34,197,94,.03)' }}>
                <div className="ev-issue-head">
                    <span style={{ color: 'var(--sa-success, #16a34a)', fontWeight: 700, marginRight: 4 }}>✓</span>
                    <b style={{ color: 'var(--ev-fg)' }}>{item.summary}</b>
                    {item.dimension && (
                        <span style={{ fontSize: 11, color: 'var(--ev-muted)' }}>{item.dimension}</span>
                    )}
                </div>
                {item.evidence && item.evidence.trim() && (
                    <div className="ev-issue-sections">
                        <div className="ev-issue-section">
                            <div className="ev-issue-section-body" style={{ color: 'var(--ev-muted)', fontSize: 12 }}>{item.evidence}</div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    const sections: Array<{ label: string; body: string | null | undefined }> = [
        { label: '证据', body: item.evidence },
        { label: '原因', body: item.reasoning },
        { label: '建议', body: item.suggestedFix },
    ];
    const visibleSections = sections.filter(s => s.body && s.body.trim());

    return (
        <div className={`ev-issue ${item.severity}`}>
            <div className="ev-issue-head">
                <b>{item.summary}</b>
                {item.dimension && (
                    <span style={{ fontSize: 11, color: 'var(--ev-muted)' }}>{item.dimension}</span>
                )}
                <span className={`ev-issue-pill ${item.severity}`}>{SEVERITY_LABEL[item.severity]}</span>
            </div>
            {visibleSections.length > 0 && (
                <div className="ev-issue-sections">
                    {visibleSections.map(s => (
                        <div key={s.label} className="ev-issue-section">
                            <div className="ev-issue-section-label">{s.label}</div>
                            <div className="ev-issue-section-body">{s.body}</div>
                        </div>
                    ))}
                </div>
            )}
            {(item.ruleId || item.dedupKey || item.category) && (
                <div className="ev-issue-meta">
                    {item.ruleId && <span>ruleId: <code>{item.ruleId}</code></span>}
                    {item.category && !item.ruleId && <span>分类: <code>{item.category}</code></span>}
                    {item.dedupKey && <span>dedupKey: <code>{item.dedupKey}</code></span>}
                </div>
            )}
        </div>
    );
}

function worstSeverity(items: Array<{ severity: Severity }>): Severity | undefined {
    if (items.some(i => i.severity === 'high')) return 'high';
    if (items.some(i => i.severity === 'medium')) return 'medium';
    if (items.some(i => i.severity === 'low')) return 'low';
    return undefined;
}
