'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import {
  findUnsupportedCustomEvaluatorVariables,
  isValidCustomEvaluatorName,
  type EvaluatorCard,
  type LlmEvaluatorConfig,
  type CodeEvaluatorConfig,
} from '@/lib/evaluators/custom-evaluator-model';
import { Term } from '@/components/text/Term';
import styles from './code-evaluator-detail.module.css';

const CodeMonacoEditor = dynamic(
  () => import('@monaco-editor/react').then(m => m.Editor),
  {
    ssr: false,
    loading: () => <div className={styles.monacoLoading}>编辑器加载中…</div>,
  },
);

const DEFAULT_CODE_SAMPLE_PAYLOAD = `{
  "prediction": "被测模型输出",
  "reference": "参考答案",
  "metadata": {}
}`;

const SYSTEM_PROMPT_PLACEHOLDER = `请编写评估器的 system prompt。可引用以下字段：
{{input}}：任务输入
{{output}}：任务输出
{{reference_output}}：预期输出
{{trajectory}}：trace 轨迹

这些字段都不是必填；目前仅支持以上四个变量。评估器最终需要输出 score 和 reason。`;

async function fetchEvaluators(user: string): Promise<EvaluatorCard[]> {
  const res = await apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`);
  if (!res.ok) return [];
  const j = await res.json();
  return Array.isArray(j) ? (j as EvaluatorCard[]) : [];
}

async function persistAll(user: string, list: EvaluatorCard[]): Promise<boolean> {
  const res = await apiFetch('/api/user-evaluators', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, evaluators: list }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok && data?.success !== false;
}

export default function CustomEvaluatorDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t, locale } = useLocale();
  const { user } = useAuth();
  const rawId = typeof params?.id === 'string' ? params.id : '';
  const id = decodeURIComponent(rawId);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [card, setCard] = useState<EvaluatorCard | null>(null);

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError('');
    try {
      const list = await fetchEvaluators(user);
      const found = list.find(c => c.id === id) ?? null;
      setCard(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
      setCard(null);
    } finally {
      setLoading(false);
    }
  }, [user, id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function normalizeCardForSave(c: EvaluatorCard): EvaluatorCard {
    if (c.evaluatorType === 'LLM' && c.llmConfig) {
      const prompt = (c.llmConfig.userPrompt || '').trim();
      const model = c.llmConfig.model;
      return {
        ...c,
        name: c.name.trim(),
        llmConfig: { ...c.llmConfig, userPrompt: prompt },
        mappedMetrics: model ? ['LLM 评测', model] : ['LLM 评测'],
      };
    }
    if (c.evaluatorType === 'Code' && c.codeConfig) {
      return {
        ...c,
        name: c.name.trim(),
        codeConfig: { ...c.codeConfig, sourceCode: c.codeConfig.sourceCode.trim() },
      };
    }
    return { ...c, name: c.name.trim() };
  }

  const handleSave = async () => {
    if (!user || !card) return;
    setSaving(true);
    setError('');
    try {
      if (card.evaluatorType === 'LLM') {
        if (!card.name.trim()) {
          setError('请填写名称');
          return;
        }
        if (!isValidCustomEvaluatorName(card.name)) {
          setError('名称会作为链路追踪中的 agent 名称：必须以英文字母开头，仅支持字母、数字、下划线、连字符');
          return;
        }
        const lc = card.llmConfig;
        if (!lc?.systemPrompt?.trim()) {
          setError('请填写 System Prompt');
          return;
        }
        const unsupportedVars = findUnsupportedCustomEvaluatorVariables(lc.systemPrompt);
        if (unsupportedVars.length > 0) {
          setError(`System Prompt 仅支持 {{input}}、{{output}}、{{reference_output}}、{{trajectory}}，不支持：${unsupportedVars.map(v => `{{${v}}}`).join('、')}`);
          return;
        }
      }
      if (card.evaluatorType === 'Code') {
        if (!card.name.trim()) {
          setError('请填写名称');
          return;
        }
        if (!card.codeConfig?.sourceCode?.trim()) {
          setError('请编写评测代码');
          return;
        }
      }
      const list = await fetchEvaluators(user);
      const idx = list.findIndex(c => c.id === card.id);
      if (idx === -1) {
        setError('评估器不存在或已被删除');
        return;
      }
      const next = [...list];
      next[idx] = normalizeCardForSave(card);
      const ok = await persistAll(user, next);
      if (!ok) throw new Error('保存失败');
      router.push('/metrics');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!user) {
    return (
      <>
        <AppTopBar title={<Term id="evaluator" label={t('nav.evalMetrics')} />} />
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }} className="loading">
          请先登录
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <AppTopBar title={<Term id="evaluator" label={locale === 'zh' ? '评估器配置' : 'Evaluator'} />} />
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }} className="loading">
          加载中…
        </div>
      </>
    );
  }

  if (!card) {
    return (
      <>
        <AppTopBar title={<Term id="evaluator" label={locale === 'zh' ? '评估器配置' : 'Evaluator'} />} />
        <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
          <p style={{ color: 'var(--error)' }}>{error || '未找到该自建评估器'}</p>
          <Link href="/metrics" className="ai-btn-s" style={{ display: 'inline-block', marginTop: 12 }}>
            返回评估器列表
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <AppTopBar title={<Term id="evaluator" label={locale === 'zh' ? '配置评估器' : 'Configure evaluator'} />} />
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '18px 22px 32px',
          maxWidth: card.evaluatorType === 'Code' ? 1180 : 880,
          margin: '0 auto',
        }}
      >
        <div className={styles.detailHeader}>
          <Link href="/metrics" className="ai-btn-s">
            ← {locale === 'zh' ? '返回' : 'Back'}
          </Link>
          <span style={{ color: 'var(--foreground-muted)' }}>/</span>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{card.name}</h1>
          <span className="ai-badge ai-badge-gr">{card.evaluatorType}</span>
        </div>

        {error ? (
          <div className="ai-card" style={{ padding: 12, color: 'var(--error)', marginBottom: 14 }}>
            {error}
          </div>
        ) : null}

        {card.evaluatorType === 'LLM' && (
          <LlmEditor card={card} onChange={setCard} />
        )}
        {card.evaluatorType === 'Code' && (
          <CodeEditor card={card} onChange={setCard} />
        )}
        {card.evaluatorType === 'Custom RPC' && (
          <div className="ai-card" style={{ padding: 16, marginBottom: 14 }}>
            <p style={{ margin: 0, color: 'var(--foreground-secondary)' }}>
              当前类型为 Custom RPC，请在列表中删除后改用 LLM 或 Code 评估器。
            </p>
          </div>
        )}

        <div className={styles.detailFooter}>
          <button type="button" className="ai-btn-p" disabled={saving || card.evaluatorType === 'Custom RPC'} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '保存'}
          </button>
          <Link href="/metrics" className="ai-btn-s" style={{ marginLeft: 'auto' }}>
            取消
          </Link>
        </div>
      </div>
    </>
  );
}

function LlmEditor({ card, onChange }: { card: EvaluatorCard; onChange: (c: EvaluatorCard) => void }) {
  const cfg: LlmEvaluatorConfig = card.llmConfig ?? {
    model: '',
    systemPrompt: '',
    userPrompt: '',
  };
  const userPromptValue = cfg.userPrompt || '';
  const hasUserPromptBlock = cfg.userPrompt !== undefined;

  const patchCfg = (partial: Partial<LlmEvaluatorConfig>) => {
    const nextModel = partial.model ?? cfg.model;
    onChange({
      ...card,
      llmConfig: { ...cfg, ...partial },
      mappedMetrics: nextModel ? ['LLM 评测', nextModel] : ['LLM 评测'],
    });
  };

  return (
    <div className="ai-card" style={{ padding: 18 }}>
      <div className={styles.sectionTitle} style={{ marginBottom: 12 }}>
        配置信息
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          <span style={{ color: 'var(--error)' }}>* </span>
          名称
        </span>
        <input
          value={card.name}
          onChange={e => onChange({ ...card, name: e.target.value })}
          placeholder="例如 custom_eval_agent"
          style={{ borderRadius: 8, border: '1px solid var(--input-border)', padding: '10px 12px', fontSize: 13 }}
        />
        <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
          名称会作为链路追踪中的 agent 名称，仅支持英文、数字、下划线、连字符，且必须以英文字母开头。
        </span>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>描述</span>
        <textarea
          value={card.description}
          onChange={e => onChange({ ...card, description: e.target.value })}
          rows={2}
          style={{ borderRadius: 8, border: '1px solid var(--input-border)', padding: 10, fontSize: 13 }}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          <span style={{ color: 'var(--error)' }}>* </span>
          System Prompt
        </span>
        <textarea
          value={cfg.systemPrompt}
          onChange={e => patchCfg({ systemPrompt: e.target.value })}
          placeholder={SYSTEM_PROMPT_PLACEHOLDER}
          rows={10}
          spellCheck={false}
          style={{
            borderRadius: 8,
            border: '1px solid var(--input-border)',
            padding: 12,
            fontSize: 12,
            fontFamily: 'ui-monospace, monospace',
          }}
        />
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>User Prompt</span>
        {hasUserPromptBlock ? (
          <div className={styles.promptCard}>
            <div className={styles.promptCardHeader}>
              <span className={styles.promptCardTitle}>User</span>
              <button
                type="button"
                className={styles.promptCardAction}
                onClick={() => patchCfg({ userPrompt: undefined })}
              >
                清空
              </button>
            </div>
            <textarea
              value={userPromptValue}
              onChange={e => patchCfg({ userPrompt: e.target.value })}
              placeholder="请输入可选的 user prompt"
              className={styles.promptCardTextarea}
            />
          </div>
        ) : (
          <button
            type="button"
            className={styles.promptAddBtn}
            onClick={() => patchCfg({ userPrompt: '' })}
          >
            + 添加 User Prompt
          </button>
        )}
      </div>

      <section style={{ marginTop: 18, padding: 14, borderRadius: 8, background: 'var(--background-secondary)', border: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>输出</div>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.65 }}>
          <strong>得分：</strong>最终分数应为 0.0～1.0 的数字，表示满足提示词评判标准的程度。
        </p>
        <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.65 }}>
          <strong>原因：</strong>说明判分依据；结尾建议使用「因此，应该给出的分数是[分数]」一类可解析句式（具体以执行引擎为准）。
        </p>
      </section>
    </div>
  );
}

function CodeEditor({ card, onChange }: { card: EvaluatorCard; onChange: (c: EvaluatorCard) => void }) {
  const cfg: CodeEvaluatorConfig = card.codeConfig ?? {
    language: 'python',
    scoreMode: '0-1',
    sourceCode: '',
  };

  const [samplePayload, setSamplePayload] = useState(DEFAULT_CODE_SAMPLE_PAYLOAD);

  const patchCfg = (partial: Partial<CodeEvaluatorConfig>) => {
    const merged = { ...cfg, ...partial };
    onChange({
      ...card,
      codeConfig: merged,
      scoreRange: merged.scoreMode === 'pass-fail' ? 'pass/fail' : '0-1',
      mappedMetrics: ['Code 评测', merged.language],
    });
  };

  const monacoLang = cfg.language === 'python' ? 'python' : 'javascript';

  const editorOptions = {
    fontSize: 13,
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    padding: { top: 10 },
    tabSize: cfg.language === 'python' ? 4 : 2,
    wordWrap: 'on' as const,
    smoothScrolling: true,
  };

  return (
    <div className={styles.wrap}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>基础信息</h2>
        <div className={styles.basicCard}>
          <div className={styles.field}>
            <span className={styles.label}>
              <span className={styles.req}>* </span>
              名称
            </span>
            <input
              className={styles.input}
              value={card.name}
              maxLength={50}
              onChange={e => onChange({ ...card, name: e.target.value })}
              placeholder="例如：路由一致性门禁"
            />
            <span className={styles.counter}>{card.name.length}/50</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>描述</span>
            <textarea
              className={styles.textarea}
              value={card.description}
              maxLength={200}
              rows={3}
              onChange={e => onChange({ ...card, description: e.target.value })}
              placeholder="简要说明评测目的与适用场景"
            />
            <span className={styles.counter}>{card.description.length}/200</span>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>配置信息</h2>
        <div className={styles.configShell}>
          <div className={styles.toolbar}>
            <div className={`${styles.toolbarBlock} ${styles.toolbarBlockGrow}`}>
              <span className={styles.label}>
                <span className={styles.req}>* </span>
                语言
              </span>
              <div className={styles.langPills} role="group" aria-label="编程语言">
                <button
                  type="button"
                  className={`${styles.langPill} ${cfg.language === 'python' ? styles.langPillActive : ''}`}
                  onClick={() => patchCfg({ language: 'python' })}
                >
                  <span className={`${styles.langIcon} ${styles.langIconPy}`} aria-hidden>
                    Py
                  </span>
                  <span>
                    Python 3
                    <span className={styles.langPillSub}> · 推荐</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={`${styles.langPill} ${cfg.language === 'javascript' ? styles.langPillActive : ''}`}
                  onClick={() => patchCfg({ language: 'javascript' })}
                >
                  <span className={`${styles.langIcon} ${styles.langIconJs}`} aria-hidden>
                    JS
                  </span>
                  <span>
                    JavaScript
                    <span className={styles.langPillSub}> · ES</span>
                  </span>
                </button>
              </div>
            </div>
            <div className={styles.toolbarBlock}>
              <span className={styles.label}>
                <span className={styles.req}>* </span>
                分数形态
              </span>
              <div className={styles.scoreSeg} role="group" aria-label="分值形式">
                <button
                  type="button"
                  className={`${styles.scoreBtn} ${cfg.scoreMode === '0-1' ? styles.scoreBtnActive : ''}`}
                  onClick={() => patchCfg({ scoreMode: '0-1' })}
                >
                  连续分 0.0～1.0
                </button>
                <button
                  type="button"
                  className={`${styles.scoreBtn} ${cfg.scoreMode === 'pass-fail' ? styles.scoreBtnActive : ''}`}
                  onClick={() => patchCfg({ scoreMode: 'pass-fail' })}
                >
                  门禁 pass / fail
                </button>
              </div>
            </div>
          </div>

          <p className={styles.hintBanner}>
            运行时注入 <code style={{ fontSize: 11.5 }}>payload</code>（JSON），入口函数为{' '}
            <code style={{ fontSize: 11.5 }}>evaluate(payload)</code>
            ，返回值需可被序列化（建议含 score、可选 pass、detail）。
          </p>

          <div className={styles.split}>
            <div className={`${styles.pane} ${styles.paneCode}`}>
              <div className={styles.paneHead}>
                <span>执行函数体</span>
                <span className={styles.paneHeadMeta}>{monacoLang === 'python' ? 'Python' : 'JavaScript'}</span>
              </div>
              <div className={styles.editorMount}>
                <CodeMonacoEditor
                  height={400}
                  language={monacoLang}
                  theme="vs"
                  value={cfg.sourceCode}
                  onChange={v => patchCfg({ sourceCode: v ?? '' })}
                  options={editorOptions}
                />
              </div>
            </div>
            <div className={`${styles.pane} ${styles.paneJson}`}>
              <div className={styles.paneHead}>
                <span>测试数据 · payload</span>
                <span className={styles.paneHeadMeta}>仅本地草稿，不参与保存</span>
              </div>
              <div className={styles.editorMount}>
                <CodeMonacoEditor
                  height={400}
                  language="json"
                  theme="vs"
                  value={samplePayload}
                  onChange={v => setSamplePayload(v ?? '')}
                  options={editorOptions}
                />
              </div>
            </div>
          </div>

          <div className={styles.docHint}>
            <strong style={{ color: 'var(--foreground)' }}>约定：</strong>
            Python 返回 <code>dict</code>，JavaScript 返回普通对象；字段 <code>score</code> 建议为 0～1 浮点数，
            <code>pass</code> 用于门禁形态，
            <code>detail</code> 为人类可读说明。右侧 JSON 可用于对照字段结构（后续可接在线试运行）。
          </div>
        </div>
      </section>
    </div>
  );
}
