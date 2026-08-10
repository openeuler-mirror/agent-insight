'use client';

import { useId, useMemo } from 'react';

interface Props {
    points: Array<{ date: string; uses: number }>;
    height?: number;
}

const MAX_PLOT_POINTS = 180;

/** 点数过多时只在绘制层做保形抽样 —— API 与统计口径保持逐日数据（Phase2 §9）。 */
function samplePreservingShape(points: Props['points']): Props['points'] {
    if (points.length <= MAX_PLOT_POINTS) return points;
    const bucket = Math.ceil(points.length / MAX_PLOT_POINTS);
    const out: Props['points'] = [];
    for (let i = 0; i < points.length; i += bucket) {
        const slice = points.slice(i, i + bucket);
        // 取桶内峰值，保住形状不被均值抹平
        out.push(slice.reduce((a, b) => (b.uses > a.uses ? b : a), slice[0]));
    }
    const last = points[points.length - 1];
    if (out[out.length - 1]?.date !== last.date) out.push(last);
    return out;
}

/**
 * 纵轴刻度：把上界抬到"好看的整数"再等分，避免出现 37.3333 这种刻度。
 * 全 0 数据回落到 0..4，保证轴上仍有可读刻度而不是一条线。
 */
export function buildTicks(maxValue: number, segments = 4): number[] {
    if (!Number.isFinite(maxValue) || maxValue <= 0) {
        return Array.from({ length: segments + 1 }, (_, i) => i);
    }
    const rough = maxValue / segments;
    const mag = 10 ** Math.floor(Math.log10(rough));
    const norm = rough / mag;
    // 2.5 保证 max=100 落到 0/25/50/75/100；4 保证 max=143 落到 0/40/…/160
    // 而不是跳到步长 50、上界 200 白白浪费三成纵向空间。
    const stepNorm =
        norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 4 ? 4 : norm <= 5 ? 5 : 10;
    const step = stepNorm * mag;
    const ticks: number[] = [];
    for (let i = 0; i <= segments; i++) {
        // mag < 1 时 step 会带小数（max < 4 的场景），round 保证刻度是整数次数
        ticks.push(Math.round(step * i));
    }
    // max 很小时 round 后可能出现重复（如 0,1,1,2,2），去重避免画出重叠网格线
    return [...new Set(ticks)];
}

export function UsageTrendChart({ points, height = 200 }: Props) {
    const gradId = useId().replace(/:/g, '');
    const plot = useMemo(() => samplePreservingShape(points), [points]);

    const max = Math.max(0, ...plot.map((p) => p.uses));
    const ticks = useMemo(() => buildTicks(max), [max]);
    const yMax = ticks[ticks.length - 1] || 1;

    if (!plot.length) {
        return (
            <div
                style={{
                    height,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--foreground-muted)',
                    fontSize: 'var(--text-sm)',
                }}
            >
                暂无数据
            </div>
        );
    }

    // 绘图区用 viewBox 横向拉伸铺满卡片；刻度文字放在真实 DOM 里（不进 SVG），
    // 这样既没有留白，文字也不会被拉扁 —— 两者兼得的关键。
    const W = 1000;
    const H = 100;
    const AXIS_W = 8 + String(yMax).length * 8; // 纵轴文字槽位，按位数估算
    const X_LABEL_H = 20;

    const yPct = (v: number) => (1 - v / yMax) * 100;
    const x = (i: number) => (plot.length === 1 ? W / 2 : (i / (plot.length - 1)) * W);
    const y = (v: number) => (1 - v / yMax) * H;

    const line = plot.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.uses).toFixed(2)}`).join(' ');
    const area = `${line} L${x(plot.length - 1).toFixed(2)},${H} L${x(0).toFixed(2)},${H} Z`;

    const labelIdx = [0, Math.floor(plot.length / 2), plot.length - 1].filter(
        (v, i, a) => a.indexOf(v) === i && v >= 0 && v < plot.length
    );

    const xLabel = (i: number) => (i === plot.length - 1 ? '今天' : plot[i].date.slice(5).replace('-', '/'));
    const plotH = height - X_LABEL_H;

    const tickTextStyle: React.CSSProperties = {
        position: 'absolute',
        right: 8,
        transform: 'translateY(-50%)',
        fontSize: 'var(--text-sm)',
        color: 'var(--foreground-muted)',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
        whiteSpace: 'nowrap',
    };

    return (
        <div
            style={{ display: 'flex', height, width: '100%' }}
            role="img"
            aria-label={`每日有效使用趋势，最高 ${max} 次`}
        >
            {/* 纵轴刻度：真实 DOM 文字，不随绘图区拉伸而变形 */}
            <div style={{ position: 'relative', width: AXIS_W, height: plotH, flexShrink: 0 }}>
                {ticks.map((t) => (
                    <span key={t} style={{ ...tickTextStyle, top: `${yPct(t)}%` }}>
                        {t.toLocaleString()}
                    </span>
                ))}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ position: 'relative', height: plotH }}>
                    {ticks.map((t) => (
                        <div
                            key={t}
                            style={{
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                top: `${yPct(t)}%`,
                                borderTop: '1px solid var(--border)',
                            }}
                        />
                    ))}

                    <svg
                        viewBox={`0 0 ${W} ${H}`}
                        preserveAspectRatio="none"
                        style={{ width: '100%', height: '100%', display: 'block', position: 'relative' }}
                    >
                        <defs>
                            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
                                <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
                            </linearGradient>
                        </defs>
                        <path d={area} fill={`url(#${gradId})`} />
                        <path
                            d={line}
                            fill="none"
                            stroke="var(--primary)"
                            strokeWidth="2"
                            strokeLinejoin="round"
                            strokeLinecap="round"
                            // 描边不跟着 viewBox 拉伸，否则线宽会被横向压细
                            vectorEffect="non-scaling-stroke"
                        />
                    </svg>
                </div>

                <div style={{ position: 'relative', height: X_LABEL_H }}>
                    {labelIdx.map((i) => (
                        <span
                            key={i}
                            style={{
                                position: 'absolute',
                                top: 4,
                                left: `${(x(i) / W) * 100}%`,
                                transform:
                                    i === 0
                                        ? 'none'
                                        : i === plot.length - 1
                                          ? 'translateX(-100%)'
                                          : 'translateX(-50%)',
                                fontSize: 'var(--text-sm)',
                                color: 'var(--foreground-muted)',
                                lineHeight: 1,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {xLabel(i)}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}
