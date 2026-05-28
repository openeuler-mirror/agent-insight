'use client';

/**
 * 新建评测任务对话框
 *
 * 业务语义: 在 /eval 评测执行页"新建一个批次"。后续此任务下所有评测 (A/B 测试 / 用例分析)
 * 都 append 到这个 evaluatorRunId, 在批次详情里聚合展示。
 *
 * 实现:
 *   - 表单收集: 任务名 (必填, 1-60) / 描述 (可选) / 评估器多选 (至少 1 个)
 *   - 提交 → POST /api/eval/trajectory/run { placeholderOnly: true, evaluators[], taskTitle, taskDescription }
 *   - 后端写一行 placeholder TrajectoryEvalResult 行 (status=pending, taskId=null, caseId=''),
 *     返回 evaluatorRunId; /eval 页能立即看到这个"空批次"
 *   - 通过 onCreated(batchId, taskMeta) 把创建结果传回父组件, 父组件负责把 batchId 持久化
 *     到当前 A/B 任务 / 用例分析任务的 config 里 (后续启动评测带 evaluatorRunId 透传 append)
 *
 * 评估器列表: 预置 (presetEvaluators) + 用户自建 (/api/user-evaluators) 合并展示
 * 任务创建后不允许改评估器配置 (改了会让历史批次和当前任务设置脱钩, 难维护) —— 表单 hint 提示
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client/api';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';

export interface NewBatchCreated {
    evaluatorRunId: string;
    taskTitle: string;
    taskDescription: string;
    selectedEvaluators: string[];
    selectedEvaluatorNames: string[];
}

interface Props {
    open: boolean;
    user: string;
    onClose: () => void;
    onCreated: (result: NewBatchCreated) => void;
    /** 可选: 父组件可预填任务名 (例如 "灰度评测 2026-05-27-09" 一键复用) */
    defaultTitle?: string;
    defaultDescription?: string;
}

interface EvaluatorOption {
    id: string;
    name: string;
    description?: string;
    source: 'preset' | 'custom';
}

// 跟 BatchEvaluation / GrayscaleEvaluation 里的 BUILT_IN_EVALUATORS 保持一致——只暴露
// status='ready' 的预置评估器, 隔离掉还在 WIP 的占位卡。
const READY_PRESETS: EvaluatorOption[] = presetEvaluators
    .filter(e => e.status === 'ready')
    .map(e => ({
        id: e.id,
        name: e.name,
        description: e.description,
        source: 'preset' as const,
    }));

function defaultTaskTitle(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `评测任务 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function NewEvaluationBatchDialog({
    open,
    user,
    onClose,
    onCreated,
    defaultTitle,
    defaultDescription,
}: Props) {
    const [title, setTitle] = useState('');
    const [desc, setDesc] = useState('');
    // 默认勾选两个预置评估器 —— 跟原有"启动评测"默认行为对齐 (用户最常用)
    const [selectedIds, setSelectedIds] = useState<Set<string>>(
        () => new Set(READY_PRESETS.map(e => e.id)),
    );
    const [customEvaluators, setCustomEvaluators] = useState<EvaluatorOption[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    // open 时 reset 表单 + 拉用户自建评估器列表
    useEffect(() => {
        if (!open) return;
        setTitle(defaultTitle ?? '');
        setDesc(defaultDescription ?? '');
        setSelectedIds(new Set(READY_PRESETS.map(e => e.id)));
        setError('');
        setSubmitting(false);
        if (!user) return;
        apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`)
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setCustomEvaluators(
                        data
                            .filter((e: { id?: string; name?: string }) => e?.id && e?.name)
                            .map((e: { id: string; name: string; description?: string }) => ({
                                id: e.id,
                                name: e.name,
                                description: e.description,
                                source: 'custom' as const,
                            })),
                    );
                }
            })
            .catch(() => {/* 自建评估器拉取失败不阻塞主流程, 还是能用预置 */});
    }, [open, user, defaultTitle, defaultDescription]);

    if (!open) return null;

    const allOptions = [...READY_PRESETS, ...customEvaluators];

    const toggle = (id: string) =>
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const trimmedTitle = title.trim();
    const finalTitle = trimmedTitle || defaultTaskTitle();
    const finalIds = Array.from(selectedIds);

    const canSubmit = finalIds.length > 0 && finalIds.length <= 5 && !submitting;

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        setError('');
        try {
            const res = await apiFetch('/api/eval/trajectory/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    // 关键: 触发后端 watchPlaceholder 路径但带 placeholderOnly 标记, 仅创建 1 行空批次
                    placeholderOnly: true,
                    evaluators: finalIds,
                    taskTitle: finalTitle,
                    taskDescription: desc.trim(),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.evaluatorRunId) {
                setError(data?.error || `创建失败 (${res.status})`);
                setSubmitting(false);
                return;
            }
            onCreated({
                evaluatorRunId: String(data.evaluatorRunId),
                taskTitle: finalTitle,
                taskDescription: desc.trim(),
                selectedEvaluators: Array.isArray(data.evaluators) ? data.evaluators : finalIds,
                selectedEvaluatorNames: Array.isArray(data.evaluatorNames) ? data.evaluatorNames : [],
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setSubmitting(false);
        }
    };

    return (
        <div
            onClick={e => { if (e.target === e.currentTarget) onClose(); }}
            style={{
                position: 'fixed', inset: 0, zIndex: 1100,
                background: 'rgba(24,24,27,.45)',
                backdropFilter: 'blur(2px)',
                display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                paddingTop: '10vh',
            }}
        >
            <div
                style={{
                    background: '#fff', borderRadius: 12,
                    boxShadow: '0 16px 48px rgba(0,0,0,.18)',
                    width: 580, maxWidth: 'calc(100vw - 32px)',
                    overflow: 'hidden',
                    display: 'flex', flexDirection: 'column',
                    maxHeight: '80vh',
                }}
            >
                <div
                    style={{
                        padding: '14px 18px', borderBottom: '1px solid #E4E4E7',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}
                >
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#18181B' }}>
                        + 新建评测任务
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            background: 'transparent', border: 'none',
                            color: '#71717A', fontSize: 18, cursor: 'pointer',
                            padding: '2px 8px', lineHeight: 1, borderRadius: 4,
                        }}
                        aria-label="关闭"
                    >
                        ×
                    </button>
                </div>

                <div style={{ padding: 18, overflowY: 'auto' }}>
                    {/* 任务名 */}
                    <div style={{ marginBottom: 14 }}>
                        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#18181B', marginBottom: 5 }}>
                            任务名 <span style={{ color: '#B91C1C', marginLeft: 2 }}>*</span>
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder={`默认: ${defaultTaskTitle()}`}
                            maxLength={60}
                            style={{
                                width: '100%',
                                padding: '7px 11px', borderRadius: 6,
                                border: '1px solid #D4D4D8',
                                fontSize: 13, color: '#18181B',
                                outline: 'none', fontFamily: 'inherit',
                            }}
                            onFocus={e => (e.currentTarget.style.borderColor = '#4F46E5')}
                            onBlur={e => (e.currentTarget.style.borderColor = '#D4D4D8')}
                        />
                        <div style={{ fontSize: 11, color: '#71717A', marginTop: 4 }}>
                            为这个评测任务取个名字, 留空将使用默认时间戳 ({title.length}/60)
                        </div>
                    </div>

                    {/* 任务描述 */}
                    <div style={{ marginBottom: 14 }}>
                        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#18181B', marginBottom: 5 }}>
                            任务描述
                        </label>
                        <textarea
                            value={desc}
                            onChange={e => setDesc(e.target.value)}
                            placeholder="可选: 任务背景 / 目标 / 关注点..."
                            maxLength={500}
                            rows={3}
                            style={{
                                width: '100%',
                                padding: '7px 11px', borderRadius: 6,
                                border: '1px solid #D4D4D8',
                                fontSize: 12.5, color: '#18181B',
                                outline: 'none', fontFamily: 'inherit',
                                resize: 'vertical', minHeight: 60,
                            }}
                            onFocus={e => (e.currentTarget.style.borderColor = '#4F46E5')}
                            onBlur={e => (e.currentTarget.style.borderColor = '#D4D4D8')}
                        />
                    </div>

                    {/* 评估器多选 */}
                    <div style={{ marginBottom: 10 }}>
                        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#18181B', marginBottom: 5 }}>
                            评估器 <span style={{ color: '#B91C1C', marginLeft: 2 }}>*</span>
                            <span style={{ fontWeight: 400, color: '#71717A', fontSize: 11, marginLeft: 6 }}>
                                (多选 · 至少 1 个最多 5 个 · 创建后不可改)
                            </span>
                        </label>
                        <div
                            style={{
                                border: '1px solid #D4D4D8', borderRadius: 7,
                                overflow: 'hidden', maxHeight: 260, overflowY: 'auto',
                            }}
                        >
                            {/* 预置 */}
                            {READY_PRESETS.map((ev, i) => {
                                const checked = selectedIds.has(ev.id);
                                return (
                                    <label
                                        key={ev.id}
                                        style={{
                                            display: 'flex', gap: 9,
                                            padding: '9px 11px',
                                            cursor: 'pointer',
                                            borderBottom: i < READY_PRESETS.length - 1 || customEvaluators.length > 0 ? '1px solid #E4E4E7' : 'none',
                                            background: checked ? 'rgba(79,70,229,.04)' : 'transparent',
                                        }}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggle(ev.id)}
                                            style={{ marginTop: 3, accentColor: '#4F46E5' }}
                                        />
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: 12.5, fontWeight: 500, color: '#18181B', display: 'flex', alignItems: 'center', gap: 7 }}>
                                                {ev.name}
                                                <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, fontWeight: 600, background: '#EEF2FF', color: '#4F46E5' }}>
                                                    预置
                                                </span>
                                            </div>
                                            {ev.description && (
                                                <div style={{ fontSize: 11, color: '#71717A', marginTop: 2, lineHeight: 1.5 }}>
                                                    {ev.description}
                                                </div>
                                            )}
                                        </div>
                                    </label>
                                );
                            })}

                            {customEvaluators.length > 0 && (
                                <div
                                    style={{
                                        padding: '5px 11px',
                                        fontSize: 10, color: '#71717A',
                                        background: '#F4F4F5',
                                        fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px',
                                    }}
                                >
                                    用户自建
                                </div>
                            )}
                            {customEvaluators.map((ev, i) => {
                                const checked = selectedIds.has(ev.id);
                                return (
                                    <label
                                        key={ev.id}
                                        style={{
                                            display: 'flex', gap: 9,
                                            padding: '9px 11px',
                                            cursor: 'pointer',
                                            borderBottom: i < customEvaluators.length - 1 ? '1px solid #E4E4E7' : 'none',
                                            background: checked ? 'rgba(79,70,229,.04)' : 'transparent',
                                        }}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggle(ev.id)}
                                            style={{ marginTop: 3, accentColor: '#4F46E5' }}
                                        />
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: 12.5, fontWeight: 500, color: '#18181B', display: 'flex', alignItems: 'center', gap: 7 }}>
                                                {ev.name}
                                                <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, fontWeight: 600, background: '#F0FDF4', color: '#15803D' }}>
                                                    自建
                                                </span>
                                            </div>
                                            {ev.description && (
                                                <div style={{ fontSize: 11, color: '#71717A', marginTop: 2, lineHeight: 1.5 }}>
                                                    {ev.description}
                                                </div>
                                            )}
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                        <div style={{ fontSize: 11, color: '#71717A', marginTop: 5, lineHeight: 1.5 }}>
                            ⓘ 任务下所有 A/B 测试 / 用例分析的评测都会用这些评估器跑。
                            <b style={{ color: '#B45309' }}> 创建后无法修改</b>; 想换评估器需新建任务。
                        </div>
                    </div>

                    {error && (
                        <div style={{
                            padding: '8px 11px', background: '#FEF2F2', color: '#B91C1C',
                            border: '1px solid #FECACA', borderRadius: 6, fontSize: 12,
                            marginTop: 10,
                        }}>
                            {error}
                        </div>
                    )}
                </div>

                <div
                    style={{
                        padding: '11px 18px', borderTop: '1px solid #E4E4E7',
                        display: 'flex', justifyContent: 'flex-end', gap: 8,
                        background: '#FAFAFA',
                    }}
                >
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={submitting}
                        style={{
                            padding: '6px 12px', borderRadius: 6,
                            border: '1px solid #D4D4D8', background: '#fff',
                            fontSize: 12.5, fontWeight: 500, color: '#52525B',
                            cursor: submitting ? 'not-allowed' : 'pointer',
                            opacity: submitting ? .5 : 1,
                        }}
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        style={{
                            padding: '6px 14px', borderRadius: 6,
                            border: '1px solid #4F46E5',
                            background: canSubmit ? '#4F46E5' : '#A5A0E4',
                            fontSize: 12.5, fontWeight: 600, color: '#fff',
                            cursor: canSubmit ? 'pointer' : 'not-allowed',
                        }}
                    >
                        {submitting ? '创建中...' : '创建任务'}
                    </button>
                </div>
            </div>
        </div>
    );
}
