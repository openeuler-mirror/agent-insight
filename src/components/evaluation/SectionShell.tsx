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
    actions,
    open,
    onToggle,
    children,
}: {
    num: number;
    variant: 'config' | 'exec' | 'result';
    title: string;
    desc: string;
    summary: ReactNode;
    /**
     * 右侧操作区, 紧贴 summary 之后 chev 之前。常见用法: 配置卡放「+ 新增评测任务」/
     * 结果卡放「导出」等。点击需要 e.stopPropagation() 避免触发 head onToggle 折叠。
     * 不传时不渲染容器, 不影响原布局。
     */
    actions?: ReactNode;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
}) {
    // head 用 div + role="button" 代替 <button>: 因为 actions slot 可能放交互式
    // 按钮 (例如「新增评测任务」), <button> 嵌套 <button> 在 HTML 里非法 → React
    // hydration warn "<button> cannot be a descendant of <button>"。
    // 保留键盘 a11y: Enter/Space 触发 onToggle。actions 区点击 stopPropagation
    // 防止冒泡到外层 div 触发折叠。
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
        }
    };
    return (
        <section className={`ev-section ev-section-${variant} ${open ? 'open' : ''}`}>
            <div
                role="button"
                tabIndex={0}
                className={`ev-section-head ${actions ? 'has-actions' : ''}`}
                onClick={onToggle}
                onKeyDown={handleKeyDown}
            >
                <span className="ev-section-num">{num}</span>
                <span className="ev-section-title">
                    <b>{title}</b>
                    <small>{desc}</small>
                </span>
                <span className="ev-section-summary">{summary}</span>
                {actions && (
                    <span
                        className="ev-section-actions"
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => e.stopPropagation()}
                    >
                        {actions}
                    </span>
                )}
                <span className="ev-section-chev">›</span>
            </div>
            {open && <div className="ev-section-body">{children}</div>}
        </section>
    );
}
