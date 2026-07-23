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
 * 评估器列表: 评测执行页只展示并提交预置评估器；自建评估器仍由后端能力保留。
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
    /** 配置区已选的评估器 id 列表。新建评测任务直接用这批评估器, 对话框内不再重复让用户选。 */
    evaluators?: string[];
    /** 可选: 用例分析任务归属。只有 Skill 用例分析入口会传, 其它入口保持普通评测任务。 */
    taskScope?: 'skill-case-analysis';
    taskSkillName?: string;
    taskSkillVersion?: number | null;
}

interface EvaluatorOption {
    id: string;
    name: string;
    description?: string;
    source: 'preset';
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
    evaluators,
    taskScope,
    taskSkillName,
    taskSkillVersion,
}: Props) {
    const [title, setTitle] = useState('');
    const [desc, setDesc] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    // open 时 reset 表单
    useEffect(() => {
        if (!open) return;
        setTitle(defaultTitle ?? '');
        setDesc(defaultDescription ?? '');
        setError('');
        setSubmitting(false);
    }, [open, defaultTitle, defaultDescription]);

    if (!open) return null;

    // 评估器来自配置区 (props.evaluators), 对话框内不再选择。解析名字做只读展示。
    const nameById = new Map<string, string>([
        ...READY_PRESETS.map(e => [e.id, e.name] as [string, string]),
    ]);
    const finalIds = (evaluators || []).filter(id => nameById.has(id));
    const finalNames = finalIds.map(id => nameById.get(id) || id);

    const trimmedTitle = title.trim();
    const finalTitle = trimmedTitle || defaultTaskTitle();

    const canSubmit = finalIds.length > 0 && finalIds.length <= 5 && !submitting;

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        setError('');
        try {
            // 评测任务 = 一个空的 backing 实验（createOnly：只建不评）；返回的 experimentId 作任务 id。
            const res = await apiFetch('/api/experiments/eval-traces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user,
                    createOnly: true,
                    name: finalTitle,
                    evaluators: finalIds,
                    scope: taskScope || 'skill-case-analysis',
                    ...(taskScope ? {
                        skillName: taskSkillName,
                        skillVersion: taskSkillVersion,
                    } : {}),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.experimentId) {
                setError(data?.error || `创建失败 (${res.status})`);
                setSubmitting(false);
                return;
            }
            onCreated({
                // 字段名沿用 evaluatorRunId（父组件当作不透明的"批次 id"用），值现在是 experimentId
                evaluatorRunId: String(data.experimentId),
                taskTitle: finalTitle,
                taskDescription: desc.trim(),
                selectedEvaluators: finalIds,
                selectedEvaluatorNames: [],
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

                    {/* 评估器 (只读): 来自配置区的多选, 此处不再重复选择 */}
                    <div style={{ marginBottom: 10 }}>
                        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#18181B', marginBottom: 5 }}>
                            评估器
                            <span style={{ fontWeight: 400, color: '#71717A', fontSize: 11, marginLeft: 6 }}>
                                (取自上方配置, 共 {finalNames.length} 个)
                            </span>
                        </label>
                        {finalNames.length > 0 ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {finalNames.map((name, i) => (
                                    <span
                                        key={`${name}_${i}`}
                                        style={{
                                            padding: '3px 9px', borderRadius: 99,
                                            background: '#EEF2FF', color: '#4F46E5',
                                            fontSize: 11.5, fontWeight: 600,
                                            border: '1px solid rgba(79,70,229,.2)',
                                        }}
                                    >
                                        {name}
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <div style={{
                                padding: '8px 11px', background: '#FEF2F2', color: '#B91C1C',
                                border: '1px solid #FECACA', borderRadius: 6, fontSize: 12,
                            }}>
                                配置区未选择评估器, 请先在上方「评估器」下拉里勾选至少 1 个。
                            </div>
                        )}
                        <div style={{ fontSize: 11, color: '#71717A', marginTop: 5, lineHeight: 1.5 }}>
                            ⓘ 任务下所有评测都会用这些评估器跑。想改评估器请在上方配置区调整。
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
