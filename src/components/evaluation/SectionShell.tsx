'use client';

/**
 * SectionShell —— 三段式评测页面（① 配置 / ② 执行 / ③ 结果）通用折叠卡外壳。
 *
 * 设计来源：
 *   触发分析页 (/skill-eval/trigger/[skillName]) 先用上，后续 batch / grayscale /
 *   static 各评测器页面都按此结构。提到共享组件以保证 4 个评测器视觉/交互一致。
 *
 * 使用要点：
 *   - num: 1 / 2 / 3，圆角徽章显示
 *   - variant: 'config' | 'exec'（蓝色徽章）| 'result'（绿色徽章）
 *   - summary 节点：折叠态显示在 head 右侧，让用户不用展开就看到关键状态
 *   - open / onToggle: 受控折叠态
 *
 * 样式 class 命名空间 `.ev-section*` 收口在 evaluation-content.css。
 */

import type { ReactNode } from 'react';

export function SectionShell({
    num,
    variant,
    title,
    desc,
    summary,
    open,
    onToggle,
    children,
}: {
    num: number;
    variant: 'config' | 'exec' | 'result';
    title: string;
    desc: string;
    summary: ReactNode;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
}) {
    return (
        <section className={`ev-section ev-section-${variant} ${open ? 'open' : ''}`}>
            <button type="button" className="ev-section-head" onClick={onToggle}>
                <span className="ev-section-num">{num}</span>
                <span className="ev-section-title">
                    <b>{title}</b>
                    <small>{desc}</small>
                </span>
                <span className="ev-section-summary">{summary}</span>
                <span className="ev-section-chev">›</span>
            </button>
            {open && <div className="ev-section-body">{children}</div>}
        </section>
    );
}
