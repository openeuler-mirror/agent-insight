'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { deriveEvaluatorTags, getEvaluatorMeta } from '@/lib/evaluators/registry';

/** 详情弹窗分节：节标题小号大写 + 主题色强调，正文浅底内容框 */
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--primary)',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--background-secondary)',
          padding: '10px 12px',
          fontSize: 12.5,
          lineHeight: 1.65,
          color: 'var(--foreground-secondary)',
        }}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * 评估器详情弹窗（预置 / 自建通用）：居中悬浮 760px。
 * 内容全部由卡片元数据派生（registry 单一事实来源），自建卡提供「编辑」入口。
 */
export default function EvaluatorDetailModal({
  card,
  onClose,
}: {
  card: EvaluatorCard;
  onClose: () => void;
}) {
  const router = useRouter();
  const meta = getEvaluatorMeta(card);
  const tags = deriveEvaluatorTags(card);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pointLabels = (card.pointsDef ?? []).map(p => p.label).filter(Boolean);
  const outputText = card.evaluatorType === 'LLM'
    ? `score 0-100 + 评分点（${pointLabels.length > 0 ? `${pointLabels.join(' / ')}，逐条强制给分` : 'Judge 自行提取'}）+ 判断依据（Markdown）`
    : 'score 0-100 + 证据（JSON）——具体证据构成见描述。';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="evaluator-detail-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        background: 'rgba(0,0,0,0.45)',
      }}
      onClick={onClose}
    >
      <div
        className="ai-card"
        style={{
          width: '100%',
          maxWidth: 760,
          padding: 22,
          position: 'relative',
          maxHeight: '88vh',
          overflowY: 'auto',
          boxShadow: 'var(--shadow)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 id="evaluator-detail-title" style={{ margin: 0, fontSize: 18, fontWeight: 650, color: 'var(--foreground)' }}>
              {card.name}
            </h2>
            <span className={`ai-badge ${card.source === 'preset' ? 'ai-badge-b' : 'ai-badge-g'}`}>
              {card.source === 'preset' ? '预置' : '自建'}
            </span>
          </div>
          <button type="button" className="ai-btn-s" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          {tags.map(tag => (
            <span
              key={tag}
              style={{
                background: 'var(--primary-subtle)',
                border: '1px solid var(--primary-subtle-border)',
                color: 'var(--primary)',
                borderRadius: 6,
                padding: '3px 9px',
                fontSize: 11,
              }}
            >
              {tag}
            </span>
          ))}
        </div>

        <DetailSection title="描述">{card.description}</DetailSection>

        <DetailSection title="应用场景">
          {card.scenarios.length > 0 ? card.scenarios.join(' · ') : '—'}
        </DetailSection>

        <DetailSection title="前置条件">
          {meta.requires.includes('reference')
            ? '需已标注参考答案——能否在实验中使用，取决于实验第 ② 步圈选的 trace 是否满足标注覆盖，第 ④ 步自动校验门控。'
            : '无——任意已圈选的 trace 均可评，不依赖参考数据。'}
        </DetailSection>

        <DetailSection title="输出">
          <code style={{ fontSize: 12, fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--foreground)' }}>
            {outputText}
          </code>
        </DetailSection>

        <DetailSection title="结果呈现位置">
          {`Trace 评测详情 · 「${meta.category === 'res' ? '结果评测' : '轨迹评测'}」板块（类目为注册时元数据，运行时不可变更）`}
        </DetailSection>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap', marginTop: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
            能否勾选以实验 ④ 步的校验为准（按已圈选 trace 检查前置条件）
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {card.source === 'custom' ? (
              <button
                type="button"
                className="ai-btn-p"
                onClick={() => router.push(`/metrics/evaluators/${encodeURIComponent(card.id)}`)}
              >
                编辑
              </button>
            ) : null}
            <button type="button" className="ai-btn-s" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    </div>
  );
}
