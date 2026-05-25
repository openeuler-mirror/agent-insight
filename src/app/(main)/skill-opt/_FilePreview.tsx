'use client';

// File preview block — adapted from skill-generator's IDE panel.
//
// Differences from skill-generator:
//   - read-only (no editing, no tabs, no save)
//   - single active file at a time (preview, not work)
//   - lightweight tree (categorized: main / scripts / references)
//   - .md → ReactMarkdown, others → Monaco (read-only)
//
// Designed to be reused by both the optimization list page (preview a skill
// before clicking 优化) and potentially the optimize page (preview the
// pre-patch source files in the right column).

import { useState, useMemo, useEffect } from 'react';
import { Editor } from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
    // 已加载的文件内容。新模式下通常只 seed SKILL.md（其余文件懒拉）。
    files: Record<string, string>;
    // 完整文件路径列表；缺省时从 files 的 keys 推断（旧调用方）。
    paths?: string[];
    // 懒加载非 seed 文件的回调。返回 null 表示加载失败或文件不可读。
    loadContent?: (path: string) => Promise<string | null>;
}

type SkillFrontmatter = { name?: string; description?: string; body: string };

// SKILL.md 顶部固定是 `---\nname: ...\ndescription: ...\n---`，ReactMarkdown 不带
// frontmatter 插件时会把它渲染成 hr + setext-h2 + hr 三件套（YAML 体被吃成大标题），
// 视觉很糟。这里手动剥出 name/description，body 交给 ReactMarkdown，
// 上方用 skill-frontmatter-card 卡片单独呈现。逻辑与 skill-generator/page.tsx 对齐。
function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
    if (!content.startsWith('---')) return null;
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return null;
    const fm = match[1];
    return {
        name: extractYamlScalar(fm, 'name'),
        description: extractYamlScalar(fm, 'description'),
        body: content.slice(match[0].length),
    };
}

// 兼容 3 种 YAML 形态：单行（含带引号）/ `>` 折叠块 / `|` 字面块。
function extractYamlScalar(fm: string, key: string): string | undefined {
    const lines = fm.split(/\r?\n/);
    const re = new RegExp(`^${key}:\\s*(.*)$`);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (!m) continue;
        const raw = m[1].trim();
        if (raw === '>' || raw === '|' || raw === '') {
            const collected: string[] = [];
            for (let j = i + 1; j < lines.length; j++) {
                if (/^[A-Za-z_][\w-]*\s*:/.test(lines[j])) break;
                collected.push(lines[j].replace(/^\s+/, ''));
            }
            if (raw === '|') return collected.join('\n').replace(/\s+$/, '');
            return collected.filter(s => s.length > 0).join(' ');
        }
        return raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
    return undefined;
}

function FileIcon({ name }: { name: string }) {
    const isMd = name.endsWith('.md');
    const isPy = name.endsWith('.py');
    const isSh = name.endsWith('.sh');
    const color = isMd ? '#3b82f6' : isPy ? '#eab308' : isSh ? '#10b981' : '#6b7280';
    return (
        <svg
            width="13" height="13" viewBox="0 0 14 14"
            fill="none" stroke={color} strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0 }}
            aria-hidden
        >
            <path d="M2 2h7l3 3v7H2V2z" />
            <path d="M9 2v3h3" />
            {isMd && <path d="M4 7h6M4 9.5h4" strokeWidth="1.2" />}
        </svg>
    );
}

function categorize(paths: string[]): Record<'main' | 'scripts' | 'references', string[]> {
    const cats = { main: [] as string[], scripts: [] as string[], references: [] as string[] };
    for (const p of paths) {
        if (p.includes('scripts/')) cats.scripts.push(p);
        else if (p.includes('references/')) cats.references.push(p);
        else cats.main.push(p);
    }
    return cats;
}

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

const CAT_LABEL: Record<string, string> = {
    main: '主文档',
    scripts: 'SCRIPTS',
    references: 'REFERENCES',
};

export function FilePreview({ files, paths: pathsProp, loadContent }: Props) {
    const paths = useMemo(
        () => (pathsProp ?? Object.keys(files)).slice().sort(),
        [pathsProp, files]
    );
    const [active, setActive] = useState<string>(paths[0] ?? '');
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

    // 懒加载文件的缓存。切到一个 paths 完全不同的 skill/版本时清空，避免串。
    const [lazyCache, setLazyCache] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const pathsKey = paths.join('|');
    useEffect(() => { setLazyCache({}); }, [pathsKey]);

    // When the file map changes (skill or version switch), pick the first
    // file. SKILL.md sorts before scripts/* alphabetically so this lands
    // on the SKILL.md when present.
    useEffect(() => {
        if (!paths.includes(active)) setActive(paths[0] ?? '');
    }, [paths, active]);

    const direct = files[active];
    const cached = lazyCache[active];

    useEffect(() => {
        if (direct !== undefined || cached !== undefined || !loadContent || !active) return;
        let cancel = false;
        setLoading(true);
        loadContent(active)
            .then(c => {
                if (cancel) return;
                if (c !== null) setLazyCache(prev => ({ ...prev, [active]: c }));
            })
            .catch(() => { /* 静默：UI 显示空内容即可 */ })
            .finally(() => { if (!cancel) setLoading(false); });
        return () => { cancel = true; };
    }, [active, direct, cached, loadContent]);

    const cats = useMemo(() => categorize(paths), [paths]);
    const content = direct ?? cached ?? '';
    const isMd = active.endsWith('.md');
    const isLoading = loading && direct === undefined && cached === undefined;
    // SKILL.md / 其他 .md：剥 frontmatter；剥不到（不是 frontmatter 开头）就走原样
    const frontmatter = useMemo(
        () => (isMd ? parseSkillFrontmatter(content) : null),
        [isMd, content]
    );

    const toggleCat = (cat: string) =>
        setCollapsed(prev => {
            const next = new Set(prev);
            next.has(cat) ? next.delete(cat) : next.add(cat);
            return next;
        });

    if (paths.length === 0) {
        return <div className="skopt-fp-empty">没有文件</div>;
    }

    return (
        <div className="skopt-fp-root">
            <aside className="skopt-fp-tree">
                {(['main', 'scripts', 'references'] as const).map(cat => {
                    const list = cats[cat];
                    if (list.length === 0) return null;
                    const isCollapsed = collapsed.has(cat);
                    return (
                        <div key={cat} className="skopt-fp-cat">
                            <div
                                className={`skopt-fp-cat-head ${isCollapsed ? 'collapsed' : ''}`}
                                onClick={() => toggleCat(cat)}
                            >
                                <svg
                                    className="chev"
                                    width="9" height="9" viewBox="0 0 10 10"
                                    fill="none" stroke="currentColor" strokeWidth="1.5"
                                    aria-hidden
                                >
                                    <path d="M2 3l3 3 3-3" />
                                </svg>
                                <span className="label">{CAT_LABEL[cat]}</span>
                                <span className="count">{list.length}</span>
                            </div>
                            {!isCollapsed && (
                                <div className="skopt-fp-cat-children">
                                    {list.map(p => (
                                        <div
                                            key={p}
                                            className={`skopt-fp-file ${active === p ? 'active' : ''}`}
                                            onClick={() => setActive(p)}
                                            title={p}
                                        >
                                            <FileIcon name={p} />
                                            <span className="name">{p.split('/').pop()}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </aside>
            <div className="skopt-fp-body">
                <div className="skopt-fp-bread">
                    <FileIcon name={active} />
                    <span>{active}</span>
                </div>
                <div className="skopt-fp-content">
                    {isLoading ? (
                        <div className="skopt-fp-empty">加载中…</div>
                    ) : isMd ? (
                        <div className="skopt-fp-md">
                            {frontmatter && (frontmatter.name || frontmatter.description) && (
                                <div className="skopt-fp-frontmatter-card">
                                    <div className="skopt-fp-frontmatter-label">Skill 元信息</div>
                                    {frontmatter.name && (
                                        <div className="skopt-fp-frontmatter-name">{frontmatter.name}</div>
                                    )}
                                    {frontmatter.description && (
                                        <div className="skopt-fp-frontmatter-desc">{frontmatter.description}</div>
                                    )}
                                </div>
                            )}
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {frontmatter ? frontmatter.body : content}
                            </ReactMarkdown>
                        </div>
                    ) : (
                        <Editor
                            height="100%"
                            language={detectLanguage(active)}
                            value={content}
                            theme="light"
                            options={{
                                fontSize: 12,
                                minimap: { enabled: false },
                                automaticLayout: true,
                                readOnly: true,
                                scrollBeyondLastLine: false,
                                lineNumbers: 'on',
                                wordWrap: 'on',
                            }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
