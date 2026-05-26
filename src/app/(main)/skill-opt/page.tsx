'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useLocale } from '@/lib/client/locale-context';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import type { SkillSummary } from './types';
import { FilePreview } from './_FilePreview';
import { Term } from '@/components/text/Term';
import './skill-opt.css';

export default function SkillOptListPage() {
    const { t } = useLocale();
    const router = useRouter();
    const { user } = useAuth();

    const [skills, setSkills] = useState<SkillSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [selectedId, setSelectedId] = useState<string>('');
    // version per skill (defaults to activeVersion when first looked up)
    const [chosenVersion, setChosenVersion] = useState<Record<string, number>>({});

    // 拉用户实际的 skill 列表（之前用 MOCK_SKILLS，看不到 vmcore-analysis 等真实 skill）
    useEffect(() => {
        if (!user) { setLoading(false); return; }
        let aborted = false;
        setLoading(true);
        setLoadError(null);
        apiFetch(`/api/skills?user=${encodeURIComponent(user)}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((arr: unknown) => {
                if (aborted) return;
                const raw = Array.isArray(arr) ? (arr as any[]) : [];
                // /api/skills 字段跟 SkillSummary 几乎一致；缺的字段补默认值
                const list: SkillSummary[] = raw.map(s => ({
                    id: s.id,
                    name: s.name,
                    description: s.description ?? '',
                    category: s.category ?? '其他',
                    author: s.author ?? '',
                    tags: Array.isArray(s.tags) ? s.tags : [],
                    activeVersion: s.activeVersion ?? 0,
                    updatedAt: s.updatedAt ?? '',
                    versions: Array.isArray(s.versions) ? s.versions : [],
                }));
                setSkills(list);
                if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
            })
            .catch(err => {
                if (aborted) return;
                console.error('[skill-opt] failed to load skills:', err);
                setLoadError(err?.message || String(err));
                setSkills([]);
            })
            .finally(() => { if (!aborted) setLoading(false); });
        return () => { aborted = true; };
    // selectedId 不放依赖：只在第一次自动选首个，后续用户切换不应触发重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    const filtered = useMemo(() => {
        if (!query) return skills;
        const q = query.toLowerCase();
        return skills.filter(s =>
            s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)
        );
    }, [query, skills]);

    const selected = skills.find(s => s.id === selectedId);
    const v = selected ? (chosenVersion[selected.id] ?? selected.activeVersion) : 0;

    const setVersion = (id: string, version: number) =>
        setChosenVersion(prev => ({ ...prev, [id]: version }));

    const goOptimize = () => {
        if (!selected) return;
        router.push(`/skill-opt/${encodeURIComponent(selected.name)}/${v}`);
    };

    // 拉当前 skill@version 的 SKILL.md + 文件清单。非 SKILL.md 的文件懒拉。
    const userQuery = user ? `?user=${encodeURIComponent(user)}` : '';
    const [versionDetail, setVersionDetail] = useState<{ paths: string[]; seed: Record<string, string> } | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);

    useEffect(() => {
        if (!selected) { setVersionDetail(null); return; }
        let aborted = false;
        setDetailLoading(true);
        setDetailError(null);
        setVersionDetail(null);
        apiFetch(`/api/skills/${selected.id}/versions/${v}${userQuery}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((d: { content?: string; files?: string }) => {
                if (aborted) return;
                // files 是 JSON 字符串数组（含 SKILL.md）；旧记录可能缺，兜底成 ['SKILL.md']
                let paths: string[] = ['SKILL.md'];
                try {
                    const parsed = d.files ? JSON.parse(d.files) : null;
                    if (Array.isArray(parsed) && parsed.length > 0) paths = parsed;
                } catch { /* 用兜底 */ }
                setVersionDetail({ paths, seed: { 'SKILL.md': d.content || '' } });
            })
            .catch(err => {
                if (aborted) return;
                console.error('[skill-opt] failed to load version detail:', err);
                setDetailError(err?.message || String(err));
            })
            .finally(() => { if (!aborted) setDetailLoading(false); });
        return () => { aborted = true; };
    }, [selected, v, userQuery]);

    const loadFileContent = useCallback(async (path: string): Promise<string | null> => {
        if (!selected) return null;
        // path 里可能含 / 子目录，需要逐段 encode
        const encoded = path.split('/').map(encodeURIComponent).join('/');
        const res = await apiFetch(`/api/skills/${selected.id}/versions/${v}/files/${encoded}${userQuery}`);
        if (!res.ok) return null;
        const json = await res.json();
        if (json.isText === false) return '(二进制文件，不可预览)';
        if (json.truncated) return '(文件超大，已截断)';
        return typeof json.content === 'string' ? json.content : null;
    }, [selected, v, userQuery]);

    return (
        <>
            <AppTopBar title={<Term id="skill-optimization" label={t('nav.skillOpt')} />} />
            <div className="skopt-list-root">
                <div className="skopt-list-toolbar">
                    <input
                        className="skopt-search-input"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="搜索 skill 名称 / 描述…"
                    />
                </div>

                <div className="skopt-list-3col">
                    {/* ── Col 1: skill list ── */}
                    <div className="skopt-col skopt-col-skills">
                        <div className="skopt-col-head">Skill ({filtered.length})</div>
                        <div className="skopt-col-body">
                            {loading && (
                                <div className="skopt-list-empty">加载中…</div>
                            )}
                            {loadError && (
                                <div className="skopt-list-empty">加载失败：{loadError}</div>
                            )}
                            {!loading && !loadError && filtered.length === 0 && (
                                <div className="skopt-list-empty">
                                    {query ? '没有匹配的 skill' : '尚未上传任何 skill'}
                                </div>
                            )}
                            {filtered.map(s => (
                                <div
                                    key={s.id}
                                    className={`skopt-row ${selectedId === s.id ? 'active' : ''}`}
                                    onClick={() => setSelectedId(s.id)}
                                >
                                    <div className="skopt-row-name">{s.name}</div>
                                    <div className="skopt-row-meta">
                                        <span className="cat">{s.category}</span>
                                        <span className="ver">v{s.activeVersion}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* ── Col 2: version picker ── */}
                    <div className="skopt-col skopt-col-version">
                        <div className="skopt-col-head">版本</div>
                        <div className="skopt-col-body">
                            {!selected && <div className="skopt-list-empty">请选择 skill</div>}
                            {selected && (
                                <div className="version-picker">
                                    <select
                                        value={v}
                                        onChange={e => setVersion(selected.id, Number(e.target.value))}
                                    >
                                        {selected.versions.map(ver => (
                                            <option key={ver.version} value={ver.version}>
                                                v{ver.version}
                                                {ver.version === selected.activeVersion ? ' (当前)' : ''}
                                            </option>
                                        ))}
                                    </select>
                                    <div className="version-meta">
                                        {selected.versions.find(x => x.version === v)?.changeLog && (
                                            <div className="changelog">
                                                {selected.versions.find(x => x.version === v)?.changeLog}
                                            </div>
                                        )}
                                        <div className="created">
                                            创建于 {new Date(selected.versions.find(x => x.version === v)?.createdAt ?? '').toLocaleString('zh-CN')}
                                        </div>
                                    </div>
                                    <button className="skopt-optimize-btn" onClick={goOptimize}>
                                        优化 →
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* ── Col 3: skill file preview (multi-file) ── */}
                    <div className="skopt-col skopt-col-preview">
                        <div className="skopt-col-head">
                            预览
                            {selected && <span className="head-sub"> · {selected.name} v{v}</span>}
                        </div>
                        <div className="skopt-col-body skopt-col-body-flush">
                            {!selected && <div className="skopt-list-empty">请选择 skill</div>}
                            {selected && detailLoading && <div className="skopt-list-empty">加载中…</div>}
                            {selected && detailError && (
                                <div className="skopt-list-empty">加载失败：{detailError}</div>
                            )}
                            {selected && !detailLoading && !detailError && versionDetail && (
                                <FilePreview
                                    files={versionDetail.seed}
                                    paths={versionDetail.paths}
                                    loadContent={loadFileContent}
                                />
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
