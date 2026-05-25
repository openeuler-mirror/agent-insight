'use client';

// File diff viewer using Monaco's built-in DiffEditor.
//
// Top toolbar lets the user pick *any two* snapshots (基线 / 对比), where a
// snapshot is either the published v{N} or one of the draft iterations
// produced by past optimization runs. When 对比 is a draft, action buttons
// 「回退到此」 and 「发布为新版本」 appear.
//
// Layout:
//   ┌─ versionbar ───────────────────────────────────────┐
//   │ 基线 [v1 ▾] ⇄ 对比 [草稿 #2 ▾] [草稿chip] [回退][发布] │
//   ├──────────────┬─────────────────────────────────────┤
//   │ 📋 报告       │  ── markdown / DiffEditor / Editor  │
//   │ 变更文件 (N)  │                                     │
//   │ 未变更 (M)    │                                     │
//   └──────────────┴─────────────────────────────────────┘

import { useState, useMemo, useEffect } from 'react';
import { DiffEditor, Editor } from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { diffLines } from 'diff';
import type { OptimizationIteration } from './types';

interface Props {
    skillName: string;
    baseVersion: number;
    /** v{baseVersion} 的全量文件 — 永远是最早的"基线"选项 */
    baseFiles: Record<string, string>;
    /** 已生成的所有草稿 */
    iterations: OptimizationIteration[];
    selectedBase: string;
    selectedCurrent: string;
    onChangeBase: (label: string) => void;
    onChangeCurrent: (label: string) => void;
    /** 把某个草稿设为新的"working state"，丢弃之后的草稿 */
    onRollback: (label: string) => void;
    /** 把某个草稿发布为 skill 的下一个正式版本 */
    onAdopt: (label: string) => void;
}

type Selection =
    | { kind: 'report' }
    | { kind: 'changed'; path: string }
    | { kind: 'unchanged'; path: string };

type ViewMode = 'side' | 'inline';

function detectLanguage(path: string): string {
    if (path.endsWith('.py')) return 'python';
    if (path.endsWith('.sh')) return 'shell';
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.js')) return 'javascript';
    if (path.endsWith('.json')) return 'json';
    if (path.endsWith('.md')) return 'markdown';
    if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
    return 'plaintext';
}

function lineDelta(orig: string, mod: string): { added: number; removed: number } {
    const changes = diffLines(orig, mod);
    let added = 0;
    let removed = 0;
    for (const c of changes) {
        if (c.added) added += c.count ?? 0;
        else if (c.removed) removed += c.count ?? 0;
    }
    return { added, removed };
}

// 生成"v{base} → 草稿 #N"的 markdown 优化报告（顶栏 + agent summary + 改动文件清单）。
// 历史上在 _mock.ts，搬来私有化——它只被 _FileDiff 用，没必要散落。
function buildIterationReport(
    name: string,
    baseLabel: string,
    draftLabel: string,
    baseFiles: Record<string, string>,
    draftFiles: Record<string, string>,
    summary: string,
): string {
    const allPaths = new Set([...Object.keys(baseFiles), ...Object.keys(draftFiles)]);
    const fileStats: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number }> = [];
    for (const p of allPaths) {
        const orig = baseFiles[p] ?? '';
        const mod = draftFiles[p] ?? '';
        if (orig === mod) continue;
        const status = !orig ? 'added' : !mod ? 'deleted' : 'modified';
        const { added, removed } = lineDelta(orig, mod);
        fileStats.push({ path: p, status, added, removed });
    }
    fileStats.sort((a, b) => a.path.localeCompare(b.path));

    const totalAdded = fileStats.reduce((s, f) => s + f.added, 0);
    const totalRemoved = fileStats.reduce((s, f) => s + f.removed, 0);
    const headerLine = fileStats.length > 0
        ? `**${name}** · ${baseLabel} → ${draftLabel} · ${fileStats.length} 文件改动 · +${totalAdded} / -${totalRemoved}`
        : `**${name}** · ${baseLabel} → ${draftLabel} · 无改动`;

    // body：agent 的修改总结（按 prompt 约定应含 ## 修改总结 / ### 已解决的优化点 等小节）；
    // agent 没说话时退化成短句。
    const body = summary?.trim() ? summary.trim() : '_（agent 未输出修改总结）_';

    // 改动文件清单：用 inline code 包统计数字让它视觉上区别于路径（颜色靠 CSS class）。
    // 不走 raw HTML—— ReactMarkdown 默认拒绝，又不想为这点开 rehype-raw 引入 XSS 风险。
    const fileSection = fileStats.length > 0
        ? `\n\n---\n\n### 改动文件\n\n${fileStats.map(f => {
            const icon = f.status === 'added' ? '🆕' : f.status === 'deleted' ? '🗑️' : '✏️';
            const parts: string[] = [`${icon} \`${f.path}\``];
            if (f.added > 0) parts.push(`\`+${f.added}\``);
            if (f.removed > 0) parts.push(`\`-${f.removed}\``);
            return `- ${parts.join(' ')}`;
        }).join('\n')}`
        : '';

    return `${headerLine}\n\n${body}${fileSection}\n`;
}

export function FileDiff({
    skillName, baseVersion, baseFiles, iterations,
    selectedBase, selectedCurrent,
    onChangeBase, onChangeCurrent,
    onRollback, onAdopt,
}: Props) {
    // Build the snapshot list: published v{N} + all drafts.
    const snapshots = useMemo(() => {
        const list: Array<{ label: string; kind: 'published' | 'draft'; files: Record<string, string>; iter?: OptimizationIteration }> = [
            { label: `v${baseVersion}`, kind: 'published', files: baseFiles },
        ];
        for (const it of iterations) {
            list.push({ label: it.label, kind: 'draft', files: it.files, iter: it });
        }
        return list;
    }, [baseVersion, baseFiles, iterations]);

    const baseSnap = snapshots.find(s => s.label === selectedBase) ?? snapshots[0];
    const curSnap = snapshots.find(s => s.label === selectedCurrent) ?? snapshots[snapshots.length - 1];

    // Compute changed/unchanged file partition between base & current.
    const { changedFiles, unchangedFiles, changedPaths, unchangedPaths } = useMemo(() => {
        const allPaths = new Set([
            ...Object.keys(baseSnap.files),
            ...Object.keys(curSnap.files),
        ]);
        const changed: Record<string, { original: string; modified: string }> = {};
        const unchanged: Record<string, string> = {};
        for (const p of allPaths) {
            const orig = baseSnap.files[p] ?? '';
            const mod = curSnap.files[p] ?? '';
            if (orig === mod) {
                unchanged[p] = orig;
            } else {
                changed[p] = { original: orig, modified: mod };
            }
        }
        return {
            changedFiles: changed,
            unchangedFiles: unchanged,
            changedPaths: Object.keys(changed).sort(),
            unchangedPaths: Object.keys(unchanged).sort(),
        };
    }, [baseSnap, curSnap]);

    // Per-file +X / -Y stats for the file list.
    const stats = useMemo(() => {
        const out: Record<string, { added: number; removed: number }> = {};
        for (const p of changedPaths) {
            out[p] = lineDelta(changedFiles[p].original, changedFiles[p].modified);
        }
        return out;
    }, [changedPaths, changedFiles]);

    // Report only makes sense when current is a draft. Generated against
    // the *currently selected base*, not the iteration's original base.
    const report = useMemo(() => {
        if (curSnap.kind !== 'draft' || !curSnap.iter) return '';
        return buildIterationReport(
            skillName,
            baseSnap.label,
            curSnap.label,
            baseSnap.files,
            curSnap.files,
            curSnap.iter.summary,
        );
    }, [skillName, baseSnap, curSnap]);

    const hasReport = curSnap.kind === 'draft';
    const initialSel: Selection = hasReport
        ? { kind: 'report' }
        : changedPaths[0]
            ? { kind: 'changed', path: changedPaths[0] }
            : unchangedPaths[0]
                ? { kind: 'unchanged', path: unchangedPaths[0] }
                : { kind: 'report' };
    const [sel, setSel] = useState<Selection>(initialSel);
    // 默认走内联视图（上下叠加）——比并排更省横向空间，diff 面板在 right panel
    // 里宽度本来就紧张，inline 更易读。用户可在 toolbar 切回并排。
    const [mode, setMode] = useState<ViewMode>('inline');

    // Snap back to a sensible default when base/current changes.
    useEffect(() => {
        setSel(initialSel);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedBase, selectedCurrent]);

    const isLatestDraft = curSnap.kind === 'draft' && curSnap.label === iterations[iterations.length - 1]?.label;

    const renderRight = () => {
        if (sel.kind === 'report') {
            if (!report) {
                return (
                    <div className="skopt-fd-report-empty">
                        当前对比的是已发布版本 <code>{curSnap.label}</code>，无优化报告。
                    </div>
                );
            }
            return (
                <div className="skopt-fd-report">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            // inline code 自定义：识别 `+N` / `-N` 形态的统计 chip 染色，
                            // 其它 inline code（路径 / 标识符）走默认样式。pre 不受影响。
                            code({ className, children, ...props }) {
                                const isInlineCode = !className;  // remarkGfm 给 fenced code 加 language-* class
                                if (isInlineCode) {
                                    const text = String(children ?? '');
                                    if (/^\+\d+$/.test(text)) {
                                        return <code className="stat-add" {...props}>{children}</code>;
                                    }
                                    if (/^-\d+$/.test(text)) {
                                        return <code className="stat-del" {...props}>{children}</code>;
                                    }
                                }
                                return <code className={className} {...props}>{children}</code>;
                            },
                        }}
                    >{report}</ReactMarkdown>
                </div>
            );
        }
        if (sel.kind === 'changed') {
            const file = changedFiles[sel.path];
            return (
                <DiffEditor
                    key={`${sel.path}::${mode}`}
                    height="100%"
                    language={detectLanguage(sel.path)}
                    original={file?.original ?? ''}
                    modified={file?.modified ?? ''}
                    theme="light"
                    options={{
                        fontSize: 12,
                        readOnly: true,
                        renderSideBySide: mode === 'side',
                        useInlineViewWhenSpaceIsLimited: false,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        wordWrap: 'on',
                        renderOverviewRuler: false,
                        scrollbar: { useShadows: false },
                    }}
                />
            );
        }
        return (
            <Editor
                key={sel.path}
                height="100%"
                language={detectLanguage(sel.path)}
                value={unchangedFiles[sel.path] ?? ''}
                theme="light"
                options={{
                    fontSize: 12,
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: 'on',
                    scrollbar: { useShadows: false },
                }}
            />
        );
    };

    const breadcrumb =
        sel.kind === 'report' ? '优化报告' :
        sel.kind === 'changed' ? sel.path :
        sel.path;

    return (
        <div className="skopt-fd-wrap">
            <div className="skopt-fd-versionbar">
                <label>
                    基线
                    <select value={selectedBase} onChange={e => onChangeBase(e.target.value)}>
                        {snapshots.map(s => (
                            <option key={s.label} value={s.label}>
                                {s.label}{s.kind === 'published' ? ' (发布)' : ' (草稿)'}
                            </option>
                        ))}
                    </select>
                </label>
                <span className="vs">⇄</span>
                <label>
                    对比
                    <select value={selectedCurrent} onChange={e => onChangeCurrent(e.target.value)}>
                        {snapshots.map(s => (
                            <option key={s.label} value={s.label}>
                                {s.label}{s.kind === 'published' ? ' (发布)' : ' (草稿)'}
                            </option>
                        ))}
                    </select>
                </label>
                {curSnap.kind === 'draft' && (
                    <span className="draft-chip" title="草稿是优化器生成的候选改动，未写入正式版本号。点「发布为新版本」可发布。">
                        草稿 · 未发布
                    </span>
                )}
                <div className="actions">
                    {curSnap.kind === 'draft' && !isLatestDraft && (
                        <button
                            type="button"
                            className="btn-rollback"
                            onClick={() => onRollback(curSnap.label)}
                            title="把此草稿设为新的工作起点，丢弃之后的草稿"
                        >
                            回退到此
                        </button>
                    )}
                    {curSnap.kind === 'draft' && (
                        <button
                            type="button"
                            className="btn-adopt"
                            onClick={() => onAdopt(curSnap.label)}
                        >
                            发布为 v{baseVersion + 1}
                        </button>
                    )}
                </div>
            </div>

            <div className="skopt-fd-root">
                <aside className="skopt-fd-list">
                    <div className="skopt-fd-section">
                        <div
                            className={`skopt-fd-row report ${sel.kind === 'report' ? 'active' : ''}`}
                            onClick={() => setSel({ kind: 'report' })}
                        >
                            <span className="icon">📋</span>
                            <span className="label">优化报告</span>
                        </div>
                    </div>

                    <div className="skopt-fd-section">
                        <div className="skopt-fd-section-head">变更文件 ({changedPaths.length})</div>
                        {changedPaths.length === 0 && (
                            <div className="skopt-fd-section-empty">无差异</div>
                        )}
                        {changedPaths.map(p => {
                            const { added, removed } = stats[p];
                            const active = sel.kind === 'changed' && sel.path === p;
                            return (
                                <div
                                    key={p}
                                    className={`skopt-fd-row file ${active ? 'active' : ''}`}
                                    onClick={() => setSel({ kind: 'changed', path: p })}
                                    title={p}
                                >
                                    <span className="path">{p}</span>
                                    <span className="stat">
                                        {added > 0 && <span className="add">+{added}</span>}
                                        {removed > 0 && <span className="del">-{removed}</span>}
                                    </span>
                                </div>
                            );
                        })}
                    </div>

                    <div className="skopt-fd-section">
                        <div className="skopt-fd-section-head">未变更文件 ({unchangedPaths.length})</div>
                        {unchangedPaths.length === 0 && (
                            <div className="skopt-fd-section-empty">无</div>
                        )}
                        {unchangedPaths.map(p => {
                            const active = sel.kind === 'unchanged' && sel.path === p;
                            return (
                                <div
                                    key={p}
                                    className={`skopt-fd-row file unchanged ${active ? 'active' : ''}`}
                                    onClick={() => setSel({ kind: 'unchanged', path: p })}
                                    title={p}
                                >
                                    <span className="path">{p}</span>
                                </div>
                            );
                        })}
                    </div>
                </aside>

                <div className="skopt-fd-body">
                    <div className="skopt-fd-toolbar">
                        <span className="path-crumb">{breadcrumb}</span>
                        {sel.kind === 'changed' && (
                            <div className="mode-switch" role="group" aria-label="视图模式">
                                <button
                                    type="button"
                                    className={mode === 'side' ? 'active' : ''}
                                    onClick={() => setMode('side')}
                                    title="左右并排"
                                >
                                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                                        <rect x="1.5" y="2" width="4.5" height="10" rx="0.5" />
                                        <rect x="8" y="2" width="4.5" height="10" rx="0.5" />
                                    </svg>
                                    <span>并排</span>
                                </button>
                                <button
                                    type="button"
                                    className={mode === 'inline' ? 'active' : ''}
                                    onClick={() => setMode('inline')}
                                    title="上下内联"
                                >
                                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                                        <rect x="1.5" y="2" width="11" height="4.5" rx="0.5" />
                                        <rect x="1.5" y="7.5" width="11" height="4.5" rx="0.5" />
                                    </svg>
                                    <span>内联</span>
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="skopt-fd-editor">
                        {renderRight()}
                    </div>
                </div>
            </div>
        </div>
    );
}
