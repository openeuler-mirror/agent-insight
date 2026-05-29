'use client';

import React, { useEffect, useRef, useState } from 'react';

export interface EvalTaskOption {
    runId: string;
    taskTitle?: string;
    traceCount?: number;
    doneCount?: number;
    runningCount?: number;
    createdAt?: string;
}

/**
 * 评测任务选择器 —— 配置区右侧"评测任务"控件: 选一个已有评测任务(批次) 或 新建。
 * A/B 测试与用例分析共用同一概念: 选/建后, 后续评测都 append 到这个 evaluatorRunId,
 * 结果在「评测执行」(/eval/run/<runId>) 聚合查看。
 */
export function EvalTaskPicker({
    tasks,
    selectedRunId,
    selectedTitle,
    onSelect,
    onCreateNew,
    locale = 'zh',
}: {
    tasks: EvalTaskOption[];
    selectedRunId?: string;
    selectedTitle?: string;
    onSelect: (opt: { runId: string; taskTitle?: string }) => void;
    onCreateNew: () => void;
    locale?: string;
}) {
    const zh = locale === 'zh';
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    const current = tasks.find(t => t.runId === selectedRunId);
    const label = selectedRunId
        ? (current?.taskTitle || selectedTitle || selectedRunId.slice(0, 8))
        : (zh ? '选择 / 新建评测任务' : 'Select / new eval task');

    return (
        <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: '1px solid ' + (selectedRunId ? 'rgba(126,34,206,.3)' : '#D4D4D8'),
                    background: selectedRunId ? '#F5E8FF' : '#fff',
                    color: selectedRunId ? '#7E22CE' : '#52525B',
                    maxWidth: 260, overflow: 'hidden',
                }}
                title={selectedRunId ? `评测任务 ${selectedRunId}` : undefined}
            >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📋 {label}</span>
                <span style={{ color: '#A1A1AA', fontSize: 10 }}>{open ? '▲' : '▼'}</span>
            </button>
            {selectedRunId && (
                <button
                    type="button"
                    onClick={() => window.open(`/eval/run/${encodeURIComponent(selectedRunId)}`, '_blank')}
                    style={{ padding: '4px 9px', background: '#EEF2FF', border: '1px solid rgba(79,70,229,.25)', borderRadius: 5, fontSize: 11.5, fontWeight: 600, color: '#4F46E5', cursor: 'pointer' }}
                    title={zh ? '打开评测任务详情' : 'Open eval task'}
                >
                    {zh ? '查看' : 'View'}
                </button>
            )}
            {open && (
                <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60, minWidth: 300,
                    background: '#fff', border: '1px solid #E4E4E7', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.12)',
                    maxHeight: 340, overflowY: 'auto', padding: 4,
                }}>
                    <button
                        type="button"
                        onClick={() => { setOpen(false); onCreateNew(); }}
                        style={{
                            width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 5,
                            border: '1px dashed #C4B5FD', background: '#FAF5FF', color: '#7E22CE',
                            fontSize: 12.5, fontWeight: 600, cursor: 'pointer', marginBottom: 4,
                        }}
                    >
                        + {zh ? '新建评测任务' : 'New eval task'}
                    </button>
                    {tasks.length === 0 ? (
                        <div style={{ padding: '8px 10px', fontSize: 12, color: '#A1A1AA' }}>{zh ? '暂无历史评测任务' : 'No eval tasks yet'}</div>
                    ) : tasks.map(t => {
                        const on = t.runId === selectedRunId;
                        return (
                            <div
                                key={t.runId}
                                role="button"
                                tabIndex={0}
                                onClick={() => { setOpen(false); onSelect({ runId: t.runId, taskTitle: t.taskTitle }); }}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(false); onSelect({ runId: t.runId, taskTitle: t.taskTitle }); } }}
                                style={{
                                    padding: '8px 10px', borderRadius: 5, cursor: 'pointer',
                                    background: on ? 'rgba(126,34,206,.08)' : 'transparent',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: '#27272A' }}>
                                    {on && <span style={{ color: '#7E22CE' }}>✓</span>}
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {t.taskTitle || t.runId.slice(0, 8)}
                                    </span>
                                </div>
                                <div style={{ fontSize: 11, color: '#A1A1AA', marginTop: 2 }}>
                                    {zh ? '共' : ''} {t.traceCount ?? 0} {zh ? '条' : 'records'}
                                    {typeof t.doneCount === 'number' ? ` · ${zh ? '已完成' : 'done'} ${t.doneCount}` : ''}
                                    {t.runningCount ? ` · ${zh ? '进行中' : 'running'} ${t.runningCount}` : ''}
                                    {t.createdAt ? ` · ${new Date(t.createdAt).toLocaleDateString()}` : ''}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
