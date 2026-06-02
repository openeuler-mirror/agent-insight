'use client';

import React, { useEffect, useRef, useState } from 'react';

export interface MultiSelectOption {
    id: string;
    name: string;
    meta?: string;
}

/**
 * 配置区通用「下拉框 + 多选」。用例分析 AB 式配置的数据集 / 评估器选择共用。
 * 受控组件: selectedIds 由调用方持有, 勾选/取消通过 onChange 回传完整 id 数组。
 */
export function ConfigMultiSelect({
    label,
    placeholder,
    options,
    selectedIds,
    onChange,
    accent = '#2563eb',
    emptyHint,
    disabled,
}: {
    label: string;
    placeholder?: string;
    options: MultiSelectOption[];
    selectedIds: string[];
    onChange: (ids: string[]) => void;
    accent?: string;
    emptyHint?: string;
    disabled?: boolean;
}) {
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

    const selectedNames = options.filter(o => selectedIds.includes(o.id)).map(o => o.name);
    const summary = selectedNames.length === 0
        ? (placeholder || '请选择')
        : selectedNames.length <= 2
            ? selectedNames.join('、')
            : `${selectedNames.slice(0, 2).join('、')} 等 ${selectedNames.length} 项`;

    const toggle = (id: string) => {
        onChange(selectedIds.includes(id) ? selectedIds.filter(i => i !== id) : [...selectedIds, id]);
    };

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.04em', minWidth: 52 }}>{label}</span>
            <div ref={ref} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => !disabled && setOpen(o => !o)}
                    style={{
                        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                        padding: '6px 10px', borderRadius: 6, fontSize: 12.5,
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        border: '1px solid ' + (selectedIds.length ? accent : '#d4d4d8'),
                        background: disabled ? '#f4f4f5' : '#fff',
                        color: selectedIds.length ? '#27272a' : '#a1a1aa', textAlign: 'left',
                    }}
                >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        {selectedIds.length > 0 && (
                            <span style={{ fontSize: 10.5, fontWeight: 700, color: accent, background: accent + '14', borderRadius: 99, padding: '0 7px' }}>{selectedIds.length}</span>
                        )}
                        <span style={{ color: '#a1a1aa', fontSize: 10 }}>{open ? '▲' : '▼'}</span>
                    </span>
                </button>
                {open && (
                    <div style={{
                        position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
                        background: '#fff', border: '1px solid #e4e4e7', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.12)',
                        maxHeight: 260, overflowY: 'auto', padding: 4,
                    }}>
                        {options.length === 0 && (
                            <div style={{ padding: '10px 12px', fontSize: 12, color: '#a1a1aa' }}>{emptyHint || '暂无选项'}</div>
                        )}
                        {options.map(o => {
                            const on = selectedIds.includes(o.id);
                            return (
                                <div
                                    key={o.id}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => toggle(o.id)}
                                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(o.id); } }}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 5,
                                        cursor: 'pointer', fontSize: 12.5,
                                        background: on ? accent + '0f' : 'transparent', color: '#27272a',
                                    }}
                                >
                                    <span style={{
                                        width: 15, height: 15, borderRadius: 4, flexShrink: 0,
                                        border: '1.5px solid ' + (on ? accent : '#c4c4cc'),
                                        background: on ? accent : '#fff',
                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                        color: '#fff', fontSize: 10, fontWeight: 700,
                                    }}>{on ? '✓' : ''}</span>
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
                                    {o.meta && <span style={{ fontSize: 10.5, color: '#a1a1aa', flexShrink: 0 }}>{o.meta}</span>}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
