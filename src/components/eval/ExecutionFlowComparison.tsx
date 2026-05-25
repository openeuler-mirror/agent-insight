'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client/api'
import { useTheme, useThemeColors } from '@/lib/client/theme-context';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';

interface ExecutionFlowComparisonProps {
  executionId: string;
  skillId?: string;
  user?: string | null;
  onStepClick?: (index: number) => void;
}

interface ProblemStep {
  stepIndex: number;
  stepName: string;
  status: 'partial' | 'unexpected' | 'skipped';
  problem: string;
  suggestion: string;
}

interface MatchSummary {
  totalSteps: number;
  matchedSteps: number;
  partialSteps: number;
  unexpectedSteps: number;
  skippedSteps: number;
  orderViolations: number;
  overallScore: number;
}

interface MatchData {
  analyzed: boolean;
  mode?: 'dynamic' | 'compare';
  matchJson?: string;
  staticMermaid?: string;
  dynamicMermaid?: string;
  analysisText?: string;
  interactionCount?: number;
  currentInteractionCount?: number;
  hasUpdate?: boolean;
  matchedAt?: string;
  usedSkillName?: string;
  usedSkillVersion?: number;
}

export default function ExecutionFlowComparison({
  executionId,
  skillId,
  user,
  onStepClick
}: ExecutionFlowComparisonProps) {
  const { user: currentUser } = useAuth();
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMode, setAnalyzeMode] = useState<'dynamic' | 'compare'>('compare');
  const [matchData, setMatchData] = useState<MatchData | null>(null);
  const [error, setError] = useState<string>('');
  const [analysisExpanded, setAnalysisExpanded] = useState(true);
  const [componentExpanded, setComponentExpanded] = useState(false);
  const [autoParsing, setAutoParsing] = useState(false);
  const { isDark } = useTheme();
  const { t } = useLocale();
  const c = useThemeColors();


  const actualSkillId = skillId && skillId.trim() ? skillId : null;

  useEffect(() => {
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const checkMatchData = () => {
      apiFetch(`/api/observe/executions/${executionId}/analyze-match`)
        .then(res => res.json())
        .then((data: MatchData) => {
          if (data.analyzed) {
            if (!data.dynamicMermaid && !data.staticMermaid && !data.matchJson) {
              setAutoParsing(true);
              pollTimer = setTimeout(checkMatchData, 3000);
            } else {
              setAutoParsing(false);
              setMatchData(data);
            }
          } else {
            setAutoParsing(false);
          }
        })
        .catch(() => {
          setAutoParsing(false);
        });
    };

    checkMatchData();

    return () => {
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [executionId]);

  const handleDynamicAnalyze = async () => {
    setAnalyzing(true);
    setError('');
    setAnalyzeMode('dynamic');

    try {
      const res = await apiFetch(`/api/observe/executions/${executionId}/analyze-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: currentUser, mode: 'dynamic' })
      });

      const result = await res.json();

      if (result.success) {
        setMatchData({
          analyzed: true,
          mode: 'dynamic',
          dynamicMermaid: result.dynamicMermaid,
          interactionCount: result.interactionCount,
          matchedAt: new Date().toISOString()
        });
      } else {
        setError(result.error || t('flow.analysisFailed'));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : t('errors.networkError');
      setError(message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleCompareAnalyze = async () => {
    if (!actualSkillId) {
      setError(t('flow.noSkillForComparison'));
      return;
    }

    setAnalyzing(true);
    setError('');
    setAnalyzeMode('compare');

    try {
      const res = await apiFetch(`/api/observe/executions/${executionId}/analyze-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: currentUser, mode: 'compare' })
      });

      const result = await res.json();

      if (result.success) {
        const problemSteps = result.match?.problemSteps || [];
        setMatchData({
          analyzed: true,
          mode: 'compare',
          matchJson: JSON.stringify(result.match),
          staticMermaid: result.staticMermaid,
          dynamicMermaid: result.dynamicMermaid,
          analysisText: JSON.stringify(problemSteps),
          interactionCount: result.interactionCount,
          currentInteractionCount: result.currentInteractionCount,
          hasUpdate: result.hasUpdate,
          matchedAt: new Date().toISOString(),
          usedSkillName: result.usedSkillName,
          usedSkillVersion: result.usedSkillVersion
        });
      } else {
        setError(result.error || t('flow.analysisFailed'));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : t('errors.networkError');
      setError(message);
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div style={{
      background: c.bgSecondary,
      borderRadius: '8px',
      border: `1px solid ${c.border}`,
      marginBottom: '2rem',
      overflow: 'hidden'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '1rem 1.5rem',
        borderBottom: componentExpanded ? '1px solid #334155' : 'none',
        cursor: 'pointer'
      }}
      onClick={() => setComponentExpanded(!componentExpanded)}
      >
        <h4 style={{ color: c.primary, margin: 0, fontSize: '0.95rem' }}>
          {t('flow.executionFlowAnalysis')}
        </h4>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span style={{ color: c.fgMuted, fontSize: '0.8rem', marginRight: '0.5rem' }}>
            {componentExpanded ? t('details.collapse') : t('details.expand')}
          </span>
          <button
            style={{
              background: c.border,
              border: 'none',
              borderRadius: '4px',
              color: c.fgMuted,
              padding: '4px 8px',
              cursor: 'pointer',
              fontSize: '0.8rem'
            }}
          >
            {componentExpanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {componentExpanded && (
        <div style={{ padding: '1.5rem' }}>
          {autoParsing && (
            <div style={{ 
              padding: '0.75rem', 
              background: 'rgba(56, 189, 248, 0.1)', 
              borderRadius: '4px', 
              color: '#38bdf8',
              marginBottom: '1rem',
              fontSize: '0.9rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>🔄</span>
              {t('flow.autoParsingExecution')}
            </div>
          )}
          <div style={{ 
            display: 'flex', 
            justifyContent: 'flex-end', 
            alignItems: 'center',
            marginBottom: '1rem'
          }}>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={(e) => { e.stopPropagation(); setAutoParsing(false); handleDynamicAnalyze(); }}
                disabled={analyzing}
                style={{
                  padding: '6px 16px',
                  background: analyzing && analyzeMode === 'dynamic' ? '#334155' : '#22c55e',
                  color: analyzing && analyzeMode === 'dynamic' ? '#a1a1aa' : '#18181b',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: analyzing ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  fontSize: '0.85rem'
                }}
              >
                {analyzing && analyzeMode === 'dynamic' ? t('flow.analyzing') : t('flow.flowParse')}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setAutoParsing(false); handleCompareAnalyze(); }}
                disabled={analyzing}
                style={{
                  padding: '6px 16px',
                  background: analyzing && analyzeMode === 'compare' ? '#334155' : '#38bdf8',
                  color: analyzing && analyzeMode === 'compare' ? '#a1a1aa' : '#18181b',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: analyzing ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  fontSize: '0.85rem'
                }}
              >
                {analyzing && analyzeMode === 'compare' ? t('flow.comparing') : t('flow.skillComparison')}
              </button>
            </div>
          </div>

          {error && (
            <div style={{
              padding: '0.75rem',
              background: c.errorSubtle,
              borderRadius: '4px',
              color: c.error,
              marginBottom: '1rem',
              fontSize: '0.9rem'
            }}>
              {error}
            </div>
          )}

          {matchData && matchData.analyzed ? (
            <div>
              {matchData.mode === 'compare' && matchData.dynamicMermaid ? (
                <div style={{ marginBottom: '1rem' }}>
                  <h5 style={{ color: c.fgMuted, margin: '0 0 0.5rem 0', fontSize: '0.85rem' }}>
                    {t('flow.executionFlowComparison')} {matchData.usedSkillName && `(${matchData.usedSkillName} v${matchData.usedSkillVersion})`}
                  </h5>
                  <div style={{
                    background: c.bg,
                    padding: '1rem',
                    borderRadius: '6px',
                    border: `1px solid ${c.border}`,
                    minHeight: '250px',
                    overflowX: 'auto',
                    overflowY: 'auto'
                  }}>
                    <MermaidRenderer code={matchData.dynamicMermaid || ''} />
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom: '1rem' }}>
                  <h5 style={{ color: c.fgMuted, margin: '0 0 0.5rem 0', fontSize: '0.85rem' }}>
                    {t('flow.executionTrace')}
                  </h5>
                  <div style={{
                    background: c.bg,
                    padding: '1rem',
                    borderRadius: '6px',
                    border: `1px solid ${c.border}`,
                    minHeight: '180px',
                    overflowX: 'auto',
                    overflowY: 'auto'
                  }}>
                    <MermaidRenderer code={matchData.dynamicMermaid || ''} />
                  </div>
                </div>
              )}

              {matchData.mode === 'compare' && matchData.matchJson && (
                (() => {
                  let summary: MatchSummary | null = null;
                  try {
                    summary = JSON.parse(matchData.matchJson)?.summary;
                  } catch {}

                  if (!summary) return null;

                  return (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '1.5rem',
                      padding: '0.75rem',
                      background: c.bg,
                      borderRadius: '6px',
                      marginBottom: '1rem'
                    }}>
                      <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.85rem' }}>
                        <span style={{ color: c.success }}>✅ {t('flow.matchedSteps')}：{summary.matchedSteps || 0}</span>
                        <span style={{ color: c.warning }}>⚠️ {t('flow.status.partial')}：{summary.partialSteps || 0}</span>
                        <span style={{ color: c.error }}>❌ {t('flow.status.unexpected')}：{summary.unexpectedSteps || 0}</span>
                        <span style={{ color: c.fgMuted }}>⭕ {t('flow.status.skipped')}：{summary.skippedSteps || 0}</span>
                      </div>
                      <div style={{ marginLeft: 'auto', fontSize: '0.8rem', color: c.fgSecondary }}>
                        {t('flow.interactionCount')}: {matchData.interactionCount}
                        {matchData.hasUpdate && (
                          <span style={{ color: c.warning, marginLeft: '0.5rem' }}>
                            {t('flow.hasUpdates')}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()
              )}

              {matchData.mode === 'compare' && matchData.analysisText && (
                <div style={{ marginBottom: '1rem' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                      marginBottom: '0.5rem'
                    }}
                    onClick={() => setAnalysisExpanded(!analysisExpanded)}
                  >
                    <h5 style={{ color: c.fgMuted, margin: 0, fontSize: '0.85rem' }}>
                      {t('flow.problemStepAnalysis')}
                    </h5>
                    <button
                      style={{
                        background: c.border,
                        border: 'none',
                        borderRadius: '4px',
                        color: c.fgMuted,
                        padding: '4px 8px',
                        cursor: 'pointer',
                        fontSize: '0.8rem'
                      }}
                    >
                      {analysisExpanded ? t('details.collapse') + ' ▲' : t('details.expand') + ' ▼'}
                    </button>
                  </div>
                  {analysisExpanded && (
                    (() => {
                      let problemSteps: ProblemStep[] = [];
                      try {
                        problemSteps = JSON.parse(matchData.analysisText);
                      } catch {
                        return (
                          <div style={{
                            background: c.bg,
                            padding: '1rem',
                            borderRadius: '6px',
                            border: `1px solid ${c.border}`,
                            color: c.fgSecondary,
                            fontSize: '0.9rem'
                          }}>
                            {t('flow.noProblemSteps')}
                          </div>
                        );
                      }

                      if (!Array.isArray(problemSteps) || problemSteps.length === 0) {
                        return (
                          <div style={{
                            background: c.bg,
                            padding: '1rem',
                            borderRadius: '6px',
                            border: `1px solid ${c.border}`,
                            color: c.success,
                            fontSize: '0.9rem'
                          }}>
                            {t('flow.allStepsMatched')}
                          </div>
                        );
                      }

                      const statusLabel: Record<string, { text: string; color: string }> = {
                        'partial': { text: t('flow.status.partial'), color: c.warning },
                        'unexpected': { text: t('flow.status.unexpected'), color: c.error },
                        'skipped': { text: t('flow.status.skipped'), color: c.fgMuted }
                      };

                      const controlFlowLabel: Record<string, { text: string; color: string }> = {
                        'required': { text: '必选', color: '#38bdf8' },
                        'conditional': { text: '条件分支', color: '#fbbf24' },
                        'loop': { text: '循环', color: '#a78bfa' },
                        'optional': { text: '可选', color: '#94a3b8' },
                        'handoff': { text: '衔接', color: '#4ade80' },
                      };

                      const getControlFlowType = (stepName: string): string | null => {
                        if (!matchData.matchJson) return null;
                        try {
                          const matchResult = JSON.parse(matchData.matchJson);
                          const match = matchResult.matches?.find((m: any) => m.expectedStepName === stepName);
                          if (match?.expectedStepId) {
                            return null;
                          }
                        } catch {}
                        return null;
                      };

                      return (
                        <div style={{
                          background: c.bg,
                          borderRadius: '6px',
                          border: `1px solid ${c.border}`,
                          overflow: 'hidden',
                          maxHeight: '600px',
                          overflowY: 'auto'
                        }}>
                          <table style={{
                            width: '100%',
                            borderCollapse: 'collapse',
                            fontSize: '0.9rem'
                          }}>
                            <thead>
                              <tr style={{ background: c.bgSecondary }}>
                                <th style={{ padding: '0.75rem', textAlign: 'left', color: c.fgMuted, borderBottom: `1px solid ${c.border}`, width: '80px' }}>{t('flow.interactionCount')}</th>
                                <th style={{ padding: '0.75rem', textAlign: 'left', color: c.fgMuted, borderBottom: `1px solid ${c.border}`, width: '120px' }}>{t('flow.stepName')}</th>
                                <th style={{ padding: '0.75rem', textAlign: 'left', color: c.fgMuted, borderBottom: `1px solid ${c.border}`, width: '110px' }}>{t('flow.stepStatus')}</th>
                                <th style={{ padding: '0.75rem', textAlign: 'left', color: c.fgMuted, borderBottom: `1px solid ${c.border}`, width: '90px' }}>{t('flow.controlFlow')}</th>
                                <th style={{ padding: '0.75rem', textAlign: 'left', color: c.fgMuted, borderBottom: `1px solid ${c.border}` }}>{t('flow.problemDescription')}</th>
                                <th style={{ padding: '0.75rem', textAlign: 'left', color: c.fgMuted, borderBottom: `1px solid ${c.border}` }}>{t('details.evalTable.improvementSuggestion')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {problemSteps.map((step, index) => (
                                <tr key={index} style={{ background: index % 2 === 0 ? '#18181b' : '#111827' }}>
                                  <td
                                    style={{
                                      padding: '0.75rem',
                                      color: onStepClick ? '#38bdf8' : '#e4e4e7',
                                      borderBottom: `1px solid ${c.border}`,
                                      cursor: onStepClick ? 'pointer' : 'default',
                                      textDecoration: onStepClick ? 'underline' : 'none'
                                    }}
                                    onClick={() => onStepClick?.(step.stepIndex)}
                                  >
                                    #{step.stepIndex}
                                  </td>
                                  <td style={{ padding: '0.75rem', color: c.fg, borderBottom: `1px solid ${c.border}` }}>{step.stepName}</td>
                                  <td style={{ padding: '0.75rem', borderBottom: `1px solid ${c.border}` }}>
                                    <span style={{
                                      padding: '2px 8px',
                                      borderRadius: '4px',
                                      background: `${statusLabel[step.status]?.color || '#a1a1aa'}20`,
                                      color: statusLabel[step.status]?.color || '#a1a1aa',
                                      fontSize: '0.8rem'
                                    }}>
                                      {statusLabel[step.status]?.text || step.status}
                                    </span>
                                  </td>
                                  <td style={{ padding: '0.75rem', borderBottom: `1px solid ${c.border}` }}>
                                    {(() => {
                                      const cfType = (step as any).controlFlowType || getControlFlowType(step.stepName) || 'required';
                                      const cfInfo = controlFlowLabel[cfType];
                                      if (!cfInfo) return <span style={{ color: c.fgMuted, fontSize: '0.8rem' }}>-</span>;
                                      return (
                                        <span style={{ 
                                          padding: '2px 8px', 
                                          borderRadius: '4px', 
                                          background: `${cfInfo.color}20`,
                                          color: cfInfo.color,
                                          fontSize: '0.8rem'
                                        }}>
                                          {cfInfo.text}
                                        </span>
                                      );
                                    })()}
                                  </td>
                                  <td style={{ padding: '0.75rem', color: c.fg, borderBottom: `1px solid ${c.border}` }}>{step.problem}</td>
                                  <td style={{ padding: '0.75rem', color: c.primary, borderBottom: `1px solid ${c.border}` }}>{step.suggestion}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()
                  )}
                </div>
              )}
            </div>
          ) : (
            <div style={{
              color: c.fgSecondary,
              fontSize: '0.9rem',
              textAlign: 'center',
              padding: '2rem'
            }}>
              <div style={{ marginBottom: '0.5rem' }}>
                <strong>{t('flow.executionFlowHint')}</strong>
              </div>
              <div>
                <strong>{t('flow.skillComparisonHint')}</strong>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MermaidRenderer({ code }: { code: string }) {
  const { isDark } = useTheme();
  const { t } = useLocale();
  const c = useThemeColors();
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const renderMermaid = async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          flowchart: {
            useMaxWidth: false,
            curve: 'basis'
          },
          themeVariables: {
            fontSize: '16px'
          }
        });
        const { svg } = await mermaid.render('mermaid-exec-' + Date.now(), code);
        setSvg(svg);
        setError('');
      } catch (e) {
        console.error('Mermaid render error:', e);
        setError(t('flow.renderFailed'));
      }
    };
    if (code) renderMermaid();
  }, [code]);

  if (error) {
    return <div style={{ color: c.error }}>{error}</div>;
  }

  if (!svg) {
    return <div style={{ color: c.fgSecondary }}>{t('flow.analyzing')}</div>;
  }

  return (
    <div
      style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'flex-start',
        alignItems: 'flex-start',
        minWidth: 'max-content'
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
