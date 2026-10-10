'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Brush,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DotItemDotProps } from 'recharts';

import type {
  ExperimentBaselineTrend as BaselineTrend,
  ExperimentBaselineTrendPoint,
} from '@/lib/engine/experiment/baseline-trend';
import { displayedExperimentName } from '@/lib/engine/experiment/experiment-name';

interface ChartPoint extends ExperimentBaselineTrendPoint {
  label: string;
}

interface ChartInteractionState {
  activeTooltipIndex?: number | string;
  activeLabel?: string | number;
}

const DEFAULT_VISIBLE_POINTS = 10;

function dateLabel(value: string, showYear: boolean): string {
  const date = new Date(value);
  const monthDay = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return showYear ? `${date.getFullYear()}-${monthDay}` : monthDay;
}

function selectedDateLabel(value: string): string {
  const date = new Date(value);
  const datePart = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const timePart = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${datePart} ${timePart}`;
}

function formatValue(value: number, percentage: boolean): string {
  const display = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return percentage ? `${display}%` : display;
}

function TrendTooltip({
  active,
  payload,
  percentage,
  onOpenExperiment,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartPoint }>;
  percentage: boolean;
  onOpenExperiment: (experimentId: string) => void;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div style={{
      minWidth: 190, padding: '9px 11px', border: '1px solid var(--border-dark)',
      borderRadius: 'var(--radius-md)', background: 'var(--card-bg)', boxShadow: 'var(--shadow)',
      fontSize: 11,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 5 }}>{displayedExperimentName(point.name, point.createdAt)}</div>
      <div style={{ color: 'var(--foreground-secondary)' }}>
        {point.agentName || '未记录 Agent'}{point.model ? ` / ${point.model}` : ''}
      </div>
      <div style={{ marginTop: 5, color: 'var(--foreground-secondary)' }}>
        {formatValue(point.value, percentage)} · {point.summary}
      </div>
      <div style={{ marginTop: 3, color: 'var(--foreground-muted)' }}>
        {new Date(point.createdAt).toLocaleString('zh-CN', { hour12: false })}
      </div>
      <button
        type="button"
        className="ai-btn ai-btn-s"
        onClick={(event) => {
          event.stopPropagation();
          onOpenExperiment(point.experimentId);
        }}
        style={{ marginTop: 7, minHeight: 26, padding: '3px 8px', fontSize: 10.5 }}
      >
        查看实验详情
      </button>
    </div>
  );
}

export function ExperimentBaselineTrend({ trend }: { trend: BaselineTrend }) {
  const router = useRouter();
  const percentage = trend.metricKind === 'percentage';
  const showYear = useMemo(() => (
    new Set(trend.points.map((point) => new Date(point.createdAt).getFullYear())).size > 1
  ), [trend.points]);
  const data = useMemo<ChartPoint[]>(() => trend.points.map((point, index) => ({
    ...point,
    label: point.isCurrent
      ? `本次 · ${dateLabel(point.createdAt, showYear)}`
      : `#${index + 1} · ${dateLabel(point.createdAt, showYear)}`,
  })), [showYear, trend.points]);
  const [windowLimit, setWindowLimit] = useState(DEFAULT_VISIBLE_POINTS);
  const defaultStartIndex = Math.max(0, data.length - Math.min(windowLimit, data.length));
  const [selectedRange, setSelectedRange] = useState<{ startIndex: number; endIndex: number } | null>(null);
  const range = selectedRange
    ? {
        startIndex: Math.min(selectedRange.startIndex, Math.max(0, data.length - 1)),
        endIndex: Math.min(selectedRange.endIndex, Math.max(0, data.length - 1)),
      }
    : { startIndex: defaultStartIndex, endIndex: Math.max(0, data.length - 1) };
  const visibleCount = data.length ? range.endIndex - range.startIndex + 1 : 0;
  const showPointLabels = visibleCount <= DEFAULT_VISIBLE_POINTS;
  const windowOptions = data.length <= 20 ? [10, 20] : [10, 20, 50];
  const currentIndex = data.findIndex((point) => point.isCurrent);
  const current = currentIndex >= 0 ? data[currentIndex] : null;
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const explicitSelectedIndex = selectedExperimentId
    ? data.findIndex((point) => point.experimentId === selectedExperimentId)
    : -1;
  const selectedIndex = explicitSelectedIndex >= 0
    ? explicitSelectedIndex
    : currentIndex >= 0 ? currentIndex : Math.max(0, data.length - 1);
  const selected = data[selectedIndex] || current;
  const previous = selectedIndex > 0 ? data[selectedIndex - 1] : null;
  const delta = selected && previous ? Math.round((selected.value - previous.value) * 10) / 10 : null;
  const selectActivePoint = (state: unknown) => {
    const interaction = state as ChartInteractionState | undefined;
    const pointByLabel = interaction?.activeLabel === undefined
      ? null
      : data.find((item) => item.label === String(interaction.activeLabel)) || null;
    const index = Number(interaction?.activeTooltipIndex);
    const point = pointByLabel || (Number.isInteger(index) ? data[index] : null);
    if (point) setSelectedExperimentId(point.experimentId);
  };
  const renderDot = (props: DotItemDotProps) => {
    const point = props.payload as ChartPoint;
    if (typeof props.cx !== 'number' || typeof props.cy !== 'number') return null;
    const isSelected = point.experimentId === selected?.experimentId;
    const select = () => setSelectedExperimentId(point.experimentId);
    return (
      <circle
        className="experiment-baseline-trend-dot"
        cx={props.cx}
        cy={props.cy}
        r={isSelected ? 5.5 : point.isCurrent ? 5 : 4}
        fill={isSelected || point.isCurrent ? 'var(--primary)' : 'var(--card-bg)'}
        stroke="var(--primary)"
        strokeWidth={isSelected ? 3 : 2}
        role="button"
        tabIndex={0}
        aria-label={`选择实验 ${displayedExperimentName(point.name, point.createdAt)}，${formatValue(point.value, percentage)}，${point.summary}`}
        onMouseEnter={select}
        onFocus={select}
        onClick={(event) => {
          event.stopPropagation();
          select();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          select();
        }}
        style={{ cursor: 'pointer' }}
      />
    );
  };

  return (
    <section style={{
      background: 'var(--card-bg)', border: '1px solid var(--card-border)',
      borderRadius: 'var(--radius-lg)', marginBottom: 14, overflow: 'hidden',
    }}>
      <header style={{
        minHeight: 44, padding: '10px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <strong style={{ fontSize: 12.5 }}>同评测基线趋势</strong>
        <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>· {trend.baselineDescription}</span>
        {data.length > DEFAULT_VISIBLE_POINTS && (
          <label style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 10.5, color: 'var(--foreground-secondary)',
          }}>
            最多显示
            <select
              aria-label="趋势图最多显示实验次数"
              value={windowLimit}
              onChange={(event) => {
                const count = Number(event.target.value);
                setWindowLimit(count);
                setSelectedRange({ startIndex: Math.max(0, data.length - count), endIndex: data.length - 1 });
                setSelectedExperimentId(current?.experimentId || data[data.length - 1]?.experimentId || null);
              }}
              style={{
                height: 28, padding: '0 24px 0 8px', border: '1px solid var(--border-dark)',
                borderRadius: 'var(--radius-sm)', background: 'var(--input-bg)', color: 'var(--foreground)',
                fontSize: 11, outline: 'none', cursor: 'pointer',
              }}
            >
              {windowOptions.map((count) => (
                <option key={count} value={count}>最近 {count} 次</option>
              ))}
            </select>
          </label>
        )}
      </header>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, padding: '16px 18px 10px' }}>
        <div style={{ flex: '1 1 230px', maxWidth: 330, paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{trend.metricLabel} 趋势</div>
          <p style={{ margin: '7px 0 0', fontSize: 11, lineHeight: 1.65, color: 'var(--foreground-secondary)' }}>
            Agent、模型或执行客户端可以变化；评测基线必须相同。
            {data.length > 1 ? '横轴按实验时间排序；点击节点查看对应实验。' : ''}
          </p>
        </div>
        <div
          className="experiment-baseline-trend-chart"
          style={{ flex: '3 1 520px', minWidth: 0, height: data.length > DEFAULT_VISIBLE_POINTS ? 245 : 205 }}
        >
          {data.length < 2 ? (
            <div style={{
              height: '100%', display: 'grid', placeItems: 'center',
              color: 'var(--foreground-muted)', fontSize: 12,
            }}>
              暂无同基线历史实验
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data}
                accessibilityLayer={false}
                margin={{ top: 24, right: 16, bottom: data.length > DEFAULT_VISIBLE_POINTS ? 4 : 2, left: 2 }}
                onMouseMove={selectActivePoint}
                onClick={selectActivePoint}
              >
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 4" vertical={false} />
                <XAxis
                  dataKey="label"
                  padding={{ left: 24, right: 24 }}
                  height={30}
                  tickMargin={8}
                  tick={{ fontSize: 10, fill: 'var(--foreground-muted)' }}
                  axisLine={{ stroke: 'var(--border-dark)' }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 50, 100]}
                  width={40}
                  padding={{ top: 12 }}
                  tickMargin={8}
                  tick={{ fontSize: 10, fill: 'var(--foreground-muted)' }}
                  axisLine={{ stroke: 'var(--border-dark)' }}
                  tickLine={false}
                />
                <Tooltip
                  content={(
                    <TrendTooltip
                      percentage={percentage}
                      onOpenExperiment={(experimentId) => (
                        router.push(`/experiments/${encodeURIComponent(experimentId)}`)
                      )}
                    />
                  )}
                  cursor={{ stroke: 'var(--border-dark)', strokeDasharray: '3 3' }}
                  wrapperStyle={{ pointerEvents: 'auto' }}
                />
                <Line
                  type="linear"
                  dataKey="value"
                  stroke="var(--primary)"
                  strokeWidth={2.4}
                  dot={renderDot}
                  activeDot={{ r: 6, fill: 'var(--primary)', stroke: 'var(--card-bg)', strokeWidth: 2 }}
                  isAnimationActive={false}
                  tabIndex={-1}
                  style={{ outline: 'none' }}
                >
                  {showPointLabels && (
                    <LabelList
                      dataKey="value"
                      position="top"
                      fill="var(--foreground-secondary)"
                      fontSize={10}
                      formatter={(value: unknown) => typeof value === 'number' ? formatValue(value, percentage) : ''}
                    />
                  )}
                </Line>
                {data.length > DEFAULT_VISIBLE_POINTS && (
                  <Brush
                    dataKey="label"
                    height={28}
                    travellerWidth={7}
                    startIndex={range.startIndex}
                    endIndex={range.endIndex}
                    fill="var(--background-secondary)"
                    stroke="var(--border-dark)"
                    tickFormatter={(label) => String(label).replace(/^#\d+ · /, '')}
                    onChange={(nextRange) => {
                      if (typeof nextRange.startIndex !== 'number' || typeof nextRange.endIndex !== 'number') return;
                      let startIndex = nextRange.startIndex;
                      let endIndex = nextRange.endIndex;
                      if (endIndex - startIndex + 1 > windowLimit) {
                        if (startIndex < range.startIndex) startIndex = Math.max(0, endIndex - windowLimit + 1);
                        else endIndex = Math.min(data.length - 1, startIndex + windowLimit - 1);
                      }
                      setSelectedRange({ startIndex, endIndex });
                      setSelectedExperimentId(data[endIndex]?.experimentId || null);
                    }}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
      {selected && (
        <footer style={{
          padding: '11px 18px', borderTop: '1px solid var(--border)', background: 'var(--card-bg)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
        }}>
          <div style={{
            minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap',
            fontSize: 11, color: 'var(--foreground-secondary)', overflowWrap: 'anywhere',
          }}>
            <strong style={{ color: 'var(--foreground)' }}>{selectedDateLabel(selected.createdAt)}</strong>
            <span>·</span>
            <span>{selected.agentName || '未记录 Agent'}{selected.model ? ` / ${selected.model}` : ''}</span>
            <span>·</span>
            <strong style={{ color: 'var(--foreground)' }}>{formatValue(selected.value, percentage)}</strong>
            <span>· {selected.summary}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            {delta !== null && (
              <strong style={{
                padding: '5px 9px', border: `1px solid ${delta > 0
                  ? 'var(--success-subtle-border)'
                  : delta < 0 ? 'var(--error-subtle-border)' : 'var(--border-dark)'}`,
                borderRadius: '999px', background: delta > 0
                  ? 'var(--success-subtle)'
                  : delta < 0 ? 'var(--error-subtle)' : 'var(--card-bg)',
                color: delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--error)' : 'var(--foreground-secondary)',
                fontSize: 10.5, whiteSpace: 'nowrap',
              }}>
                {delta === 0
                  ? '与上次持平'
                  : `较上次 ${delta > 0 ? '+' : ''}${formatValue(delta, percentage)} ${delta > 0 ? '↑' : '↓'}`}
              </strong>
            )}
            {!selected.isCurrent && (
              <button
                type="button"
                className="ai-btn ai-btn-s"
                onClick={() => router.push(`/experiments/${encodeURIComponent(selected.experimentId)}`)}
                style={{ minHeight: 28, padding: '4px 9px', fontSize: 10.5 }}
              >
                查看实验
              </button>
            )}
          </div>
        </footer>
      )}
    </section>
  );
}
