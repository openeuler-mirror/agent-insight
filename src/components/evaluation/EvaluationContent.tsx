'use client';

import { useState } from 'react';
import './evaluation-content.css';
import {
    STATIC_EVAL_STANDARDS,
    SEVERITY_LABEL,
} from './constants';
import type {
    EvaluationDetail,
    IssueRow,
    Severity,
    StaticStandard,
} from './types';
import { FindingsGrouped, FindingsFlat, type FindingGroup, type FindingItem } from './EvaluationFindings';

/**
 * 评估详情视图：把 GET /api/evaluation/[id] 一个 detail 渲染成
 *   - 维度评分卡（顶部：合规率 + 严重度直方图；网格：6 维度，每张显示百分比 + 问题数）
 *   - 按 6 大标准分组的优化点列表（展开后看 evidence/reasoning/suggestedFix）
 *
 * 元信息（评估时间/状态/耗时/评估器/contentHash）由外层 DetailHeader 渲染，这里不重复展示。
 * dynamic 评估走 FlatIssueList 兜底。
 */
export function EvaluationContent({
    detail,
    headerSlot,
}: {
    detail: EvaluationDetail;
    headerSlot?: React.ReactNode;
}) {
    const e = detail.evaluation;
    const isStatic = e.type === 'static';
    const scores = e.l2Scores?.scores || {};
    const comments = e.l2Scores?.comments;
    const hasL2Scores = Object.keys(scores).length > 0;

    if (!isStatic) {
        return (
            <div className="ev-content">
                {headerSlot}
                <FindingsFlat items={detail.issues.map(toFindingItem)} histogram={detail.histogram} />
            </div>
        );
    }

    // 统一计算 6 大标准的 score / issues / status，下方两个组件共用一份数据。
    const grouped = groupByStandards(detail.issues, scores, hasL2Scores);
    const matchedIds = new Set(grouped.flatMap(g => g.items.map(i => i.id)));
    const otherIssues = detail.issues.filter(i => !matchedIds.has(i.id));

    // "每维度对总分的贡献"——已评估维度数 N 把 100 分均分，每维度满分 = 100/N，
    // 维度得分 score (0-5) 转换为贡献 = (score/5) × (100/N)。
    // 关键约束：所有维度的贡献相加 = 总分（用户原话），所以总分必须从 contribution
    // 求和反推（而不是先算 avg×20 再独立显示），否则四舍五入会让两边对不上。
    const evaluatedCount = grouped.filter(g => typeof g.score === 'number').length;
    const dimContribution = (score: number): number =>
        evaluatedCount > 0 ? Math.round((score / 5) * (100 / evaluatedCount)) : 0;

    const findingGroups: FindingGroup[] = grouped.map(g => ({
        key: g.key,
        title: g.title,
        desc: g.desc,
        status: g.status,
        items: g.items.map(toFindingItem),
        scoreLabel: typeof g.score === 'number'
            ? `${dimContribution(g.score)} 分`
            : undefined,
    }));
    const otherItems = otherIssues.map(toFindingItem);

    // 顶部 Hero 总分 = 所有维度 contribution 之和（不是独立 avg×20 算法），
    // 这样保证"小分加起来就是总分"在视觉上严丝合缝。
    const overallScore = evaluatedCount > 0
        ? grouped.reduce((sum, g) => sum + (typeof g.score === 'number' ? dimContribution(g.score) : 0), 0)
        : null;

    return (
        <div className="ev-content">
            {headerSlot}
            <EvaluationOverallScoreHero score={overallScore} />
            <DimensionScoresCard
                grouped={grouped}
                comments={comments}
                histogram={detail.histogram}
                totalIssues={detail.issues.length}
                hasL2Scores={hasL2Scores}
            />
            <FindingsGrouped
                groups={findingGroups}
                otherItems={otherItems}
                hasScores={hasL2Scores}
                otherTitle="其它静态扫描问题"
                otherDesc="未匹配到上述 6 个标准维度的检查项（通常来自 L1 linter 或自定义规则）。"
            />
        </div>
    );
}

function EvaluationOverallScoreHero({ score }: { score: number | null }) {
    const color = score == null ? 'var(--ev-muted)'
        : score >= 80 ? 'var(--sa-success, #16a34a)'
        : score >= 50 ? 'var(--sa-warning, #d97706)'
        : 'var(--sa-danger,  #dc2626)';
    return (
        <section className="sa-standards-wrap" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 18px' }}>
                <div>
                    <div style={{ fontSize: 11, color: 'var(--sa-muted)', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 4 }}>
                        静态合规总分
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <b style={{ fontSize: 44, fontWeight: 800, lineHeight: 1, letterSpacing: '-1.5px', color }}>
                            {score ?? '--'}
                        </b>
                        <span style={{ fontSize: 14, color: 'var(--sa-muted)', fontWeight: 600 }}>/ 100</span>
                    </div>
                </div>
                <span style={{ fontSize: 12, color: 'var(--sa-muted)', maxWidth: 280, textAlign: 'right', lineHeight: 1.55 }}>
                    各维度"贡献分"之和 · 未评估维度不计入
                </span>
            </div>
        </section>
    );
}

/** IssueRow → FindingItem 适配——字段名一对一对应，类型层面无损 */
function toFindingItem(issue: IssueRow): FindingItem {
    return {
        id: issue.id,
        summary: issue.summary,
        severity: issue.severity,
        evidence: issue.evidence,
        reasoning: issue.reasoning,
        suggestedFix: issue.suggestedFix,
        dimension: issue.dimension,
        ruleId: issue.ruleId,
        category: issue.category,
        dedupKey: issue.dedupKey,
    };
}

// ───────── Grouping (shared by dimension card + standard list) ─────────

type StdStatus = 'passed' | 'failed' | 'notEvaluated';

interface GroupedStandard extends StaticStandard {
    items: IssueRow[];
    score?: number;
    status: StdStatus;
}

function groupByStandards(
    issues: IssueRow[],
    scores: Record<string, number>,
    hasL2Scores: boolean,
): GroupedStandard[] {
    return STATIC_EVAL_STANDARDS.map(std => {
        const aliasSet = new Set(std.dimensionAliases);
        const items = issues.filter(i => aliasSet.has(i.dimension || ''));
        const score = std.dimensionAliases
            .map(a => scores[a])
            .find(s => typeof s === 'number' && Number.isFinite(s));
        let status: StdStatus;
        if (typeof score === 'number') {
            status = score >= 4 ? 'passed' : 'failed';
        } else if (hasL2Scores) {
            status = 'notEvaluated';
        } else {
            status = items.some(i => i.severity === 'high' || i.severity === 'medium') ? 'failed' : 'passed';
        }
        return { ...std, items, score, status };
    });
}

// ───────── Dimension scores card ─────────

function DimensionScoresCard({
    grouped,
    comments,
    histogram,
    totalIssues,
    hasL2Scores,
}: {
    grouped: GroupedStandard[];
    comments?: { meta?: string; code?: string };
    histogram: Record<Severity, number>;
    totalIssues: number;
    hasL2Scores: boolean;
}) {
    // 总分 = 已评估维度的均分 ×20（百分比化），未评估的不进分母。
    // 跟之前"满分项/已评估项"口径换掉：均值更直观，单项不及格不会把总分腰斩。
    let scoreSum = 0;
    let evaluated = 0;
    for (const g of grouped) {
        if (typeof g.score === 'number') {
            evaluated++;
            scoreSum += g.score;
        }
    }
    const avgPct = evaluated > 0 ? Math.round((scoreSum / evaluated) * 20) : null;

    // 已评估维度：雷达图轴 / 薄弱维度都基于这份
    const evaluatedDims = grouped.filter(g => typeof g.score === 'number');
    // 薄弱维度 = 已评估且分数 < 5，按分数升序（最弱在前）
    const weakDims = evaluatedDims.filter(g => (g.score as number) < 5).sort((a, b) => (a.score as number) - (b.score as number));
    const themeColor = avgPct != null ? pctColor(avgPct) : 'var(--ev-muted)';
    const themeTint = avgPct != null ? pctTint(avgPct) : 'rgba(113, 113, 122, 0.08)';

    return (
        <div className="ev-card ev-radar-card">
            <div className="ev-radar-body">
                {/* 左：雷达图 —— 只画已评估维度，N 边形动态适配 */}
                <div className="ev-radar-svg-wrap">
                    {hasL2Scores && evaluatedDims.length >= 3 ? (
                        <DimensionRadar dims={evaluatedDims} themeColor={themeColor} themeTint={themeTint} />
                    ) : (
                        <div className="ev-radar-empty">
                            {hasL2Scores
                                ? `仅 ${evaluatedDims.length} 个维度被评估，无法绘制雷达图`
                                : 'L2 维度评分缺失（仅运行了 L1 linter）'}
                        </div>
                    )}
                </div>

                {/* 右：已评估 + 严重度 + 薄弱维度
                    "维度均分"原本在这里，跟顶部 Hero 总分重复，已删；雷达图本身已经
                    把各维度得分可视化，右侧的数字总览不需要再重复一遍总分。 */}
                <div className="ev-radar-stats">
                    <div className="ev-radar-line">
                        {evaluated}/{grouped.length} 已评估 · 共 {totalIssues} 条问题
                    </div>
                    <div className="ev-severity-row">
                        <SevChip count={histogram.high} severity="high" />
                        <SevChip count={histogram.medium} severity="medium" />
                        <SevChip count={histogram.low} severity="low" />
                    </div>

                    {weakDims.length > 0 && (
                        <div className="ev-weak">
                            <div className="ev-weak-title">薄弱维度</div>
                            <ul className="ev-weak-list">
                                {weakDims.map(g => {
                                    const dimPct = Math.round((g.score as number) * 20);
                                    const dimColor = pctColor(dimPct);
                                    return (
                                        <li key={g.key}>
                                            <span className="ev-weak-dot" style={{ background: dimColor }} />
                                            <span className="ev-weak-name" style={{ color: dimColor }}>{g.title}</span>
                                            <span className="ev-weak-score">{dimPct}%</span>
                                            {g.items.length > 0 && (
                                                <span className="ev-weak-issues">· {g.items.length} 个问题</span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}
                </div>
            </div>

            {(comments?.meta || comments?.code) && (
                <div className="ev-comments">
                    {comments.meta && <div><b>SKILL.md：</b>{comments.meta}</div>}
                    {comments.code && <div><b>参考实现：</b>{comments.code}</div>}
                </div>
            )}
        </div>
    );
}

/**
 * 雷达图：SVG 自绘，N 边形动态（只画已评估的维度，少于 3 个会退化为提示）。
 * - 5 圈同心 N 边形网格（1/2/3/4/5 分）
 * - 数据多边形：填色 = themeTint（均分色阶），边线 = themeColor
 * - 每个顶点画一个小圆，颜色按该维度自己的分数取（高分绿/中黄/低红），方便单点诊断
 * - 维度名沿轴线外端，文字 anchor 根据角度自动 start/middle/end
 */
function DimensionRadar({
    dims,
    themeColor,
    themeTint,
}: {
    dims: GroupedStandard[];
    themeColor: string;
    themeTint: string;
}) {
    const n = dims.length;
    // viewBox 给标签留出余量：宽比高大一些，因为「脚本及参考文档质量」这类标签横向最长。
    // 半径 R 控制 polygon 大小；labelR 大于 R，标签落在 polygon 外。
    const w = 480;
    const h = 380;
    const cx = w / 2;
    const cy = h / 2;
    const R = 120;
    const labelR = 158;

    // 顶部 12 点方向开始，顺时针均分
    const angles = dims.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / n);

    const point = (score: number, i: number) => ({
        x: cx + (score / 5) * R * Math.cos(angles[i]),
        y: cy + (score / 5) * R * Math.sin(angles[i]),
    });

    const dataPath = dims
        .map((g, i) => {
            const p = point(g.score as number, i);
            return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
        })
        .join(' ') + ' Z';

    const gridPaths = [1, 2, 3, 4, 5].map(level =>
        dims
            .map((_, i) => {
                const p = point(level, i);
                return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
            })
            .join(' ') + ' Z'
    );

    return (
        <svg viewBox={`0 0 ${w} ${h}`} className="ev-radar-svg" preserveAspectRatio="xMidYMid meet">
            {/* grid */}
            {gridPaths.map((d, i) => (
                <path key={i} d={d} fill="none" stroke="var(--ev-line)" strokeWidth={1} opacity={i === gridPaths.length - 1 ? 0.6 : 0.4} />
            ))}
            {/* axes */}
            {angles.map((a, i) => {
                const p = point(5, i);
                return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="var(--ev-line)" strokeWidth={1} opacity={0.5} />;
            })}
            {/* data polygon */}
            <path d={dataPath} fill={themeTint} stroke={themeColor} strokeWidth={1.8} strokeLinejoin="round" />
            {/* vertices */}
            {dims.map((g, i) => {
                const p = point(g.score as number, i);
                const dotColor = pctColor((g.score as number) * 20);
                return <circle key={i} cx={p.x} cy={p.y} r={4} fill={dotColor} />;
            })}
            {/* labels —— 用全称（g.title），文字 anchor 根据角度自适应 */}
            {dims.map((g, i) => {
                const a = angles[i];
                const lx = cx + labelR * Math.cos(a);
                const ly = cy + labelR * Math.sin(a);
                let anchor: 'start' | 'middle' | 'end' = 'middle';
                if (Math.cos(a) > 0.3) anchor = 'start';
                else if (Math.cos(a) < -0.3) anchor = 'end';
                // 顶/底端轻微抬升，避免与图形重叠
                const dy = Math.sin(a) < -0.5 ? -4 : Math.sin(a) > 0.5 ? 4 : 0;
                return (
                    <text
                        key={i}
                        x={lx}
                        y={ly + dy}
                        textAnchor={anchor}
                        dominantBaseline="middle"
                        fontSize={15}
                        fill="var(--ev-fg2)"
                    >
                        {g.title}
                    </text>
                );
            })}
        </svg>
    );
}

function pctTint(pct: number): string {
    if (pct >= 90) return 'rgba(22, 163, 74, 0.1)';
    if (pct >= 70) return 'rgba(202, 138, 4, 0.12)';
    if (pct >= 50) return 'rgba(234, 88, 12, 0.12)';
    return 'rgba(220, 38, 38, 0.1)';
}

function pctColor(pct: number): string {
    if (pct >= 90) return '#16a34a';
    if (pct >= 70) return '#ca8a04';
    if (pct >= 50) return '#ea580c';
    return '#dc2626';
}

function SevChip({ count, severity }: { count: number; severity: Severity }) {
    return (
        <div className={`ev-sev-chip ${severity}`}>
            <b>{count}</b>
            <span>{SEVERITY_LABEL[severity]}</span>
        </div>
    );
}

// StandardGroupedIssues / StandardRow / IssueCard / FlatIssueList / worstSeverity
// 已抽到 EvaluationFindings.tsx 作为跨评估器复用组件。这里通过 FindingsGrouped
// / FindingsFlat 调用，行为完全等价。
