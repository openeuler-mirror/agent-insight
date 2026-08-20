'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, FolderSearch, Loader2, Search, X } from 'lucide-react';

import { apiFetch } from '@/lib/client/api';

interface ManagedSkillVersion {
  version: number;
  semanticVersion: string | null;
  createdAt: string;
}

interface ManagedSkill {
  id: string;
  name: string;
  category: string;
  description: string | null;
  tags: string[];
  visibility: string;
  author: string | null;
  activeVersion: number | null;
  isUploaded: boolean;
  updatedAt: string;
  versions: ManagedSkillVersion[];
}

interface PickerResponse {
  items: ManagedSkill[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

interface SkillManagementPickerProps {
  open: boolean;
  user: string;
  selecting: boolean;
  onClose: () => void;
  onSelect: (skillName: string, version: number) => Promise<void>;
}

export function SkillManagementPicker({ open, user, selecting, onClose, onSelect }: SkillManagementPickerProps) {
  const [draftSearch, setDraftSearch] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState<'all' | 'uploaded' | 'generated'>('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PickerResponse | null>(null);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ user, page: String(page), pageSize: '9', source });
    if (search) params.set('search', search);
    if (category) params.set('category', category);

    setLoading(true);
    setError('');
    void apiFetch(`/api/skill-management/skills?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '加载 Skill 失败');
        setData(result as PickerResponse);
        setVersions((current) => {
          const next = { ...current };
          for (const skill of result.items as ManagedSkill[]) {
            const activeExists = skill.versions.some((item) => item.version === skill.activeVersion);
            next[skill.name] = activeExists
              ? skill.activeVersion as number
              : skill.versions[0]?.version ?? 0;
          }
          return next;
        });
      })
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
        setError(loadError instanceof Error ? loadError.message : '加载 Skill 失败');
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [category, open, page, search, source, user]);

  const range = useMemo(() => {
    if (!data || data.total === 0) return '0 项';
    const start = (data.page - 1) * data.pageSize + 1;
    return `${start}–${Math.min(data.page * data.pageSize, data.total)} / ${data.total}`;
  }, [data]);

  if (!open) return null;

  const submitSearch = () => {
    setPage(1);
    setSearch(draftSearch.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay-bg)] p-6" role="dialog" aria-modal="true" aria-label="选择 Skill">
      <div className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <FolderSearch className="size-4.5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-foreground">从 Skill 管理中心选择</h2>
            <p className="mt-0.5 text-xs text-foreground-muted">选择明确版本作为本会话的工作快照，不会修改线上激活版本。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={selecting}
            className="ml-auto inline-flex size-8 items-center justify-center rounded-md text-foreground-muted hover:bg-background-secondary disabled:opacity-50"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background-secondary px-5 py-3">
          <div className="flex h-8 min-w-56 flex-1 items-center rounded-md border border-border bg-card px-2">
            <Search className="mr-2 size-3.5 text-foreground-muted" />
            <input
              value={draftSearch}
              onChange={(event) => setDraftSearch(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && submitSearch()}
              placeholder="搜索名称或描述"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground-muted"
            />
            <button type="button" onClick={submitSearch} className="text-[11px] font-medium text-primary">搜索</button>
          </div>
          <input
            value={category}
            onChange={(event) => { setCategory(event.target.value); setPage(1); }}
            placeholder="全部分类"
            className="h-8 w-32 rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none placeholder:text-foreground-muted focus:border-primary"
          />
          <select
            value={source}
            onChange={(event) => { setSource(event.target.value as typeof source); setPage(1); }}
            className="h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-primary"
          >
            <option value="all">全部来源</option>
            <option value="generated">平台生成</option>
            <option value="uploaded">上传导入</option>
          </select>
        </div>

        <div className="min-h-[430px] flex-1 overflow-y-auto p-5">
          {error && <div className="rounded-md border border-error-border bg-error-subtle px-3 py-2 text-xs text-error">{error}</div>}
          {loading && !data ? (
            <div className="flex h-80 items-center justify-center text-xs text-foreground-muted">
              <Loader2 className="mr-2 size-4 animate-spin" />加载中
            </div>
          ) : data?.items.length ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {data.items.map((skill) => {
                const selectedVersion = versions[skill.name] ?? skill.versions[0]?.version ?? 0;
                return (
                  <article key={skill.id} className="flex min-h-48 flex-col rounded-lg border border-border bg-card p-4 hover:border-primary">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold text-foreground">{skill.name}</h3>
                        <p className="mt-0.5 text-[11px] text-foreground-muted">{skill.category} · {skill.isUploaded ? '上传导入' : '平台生成'}</p>
                      </div>
                      <span className="rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-foreground-muted">{skill.visibility}</span>
                    </div>
                    <p className="mt-3 line-clamp-2 text-xs leading-5 text-foreground-secondary">{skill.description || '暂无描述'}</p>
                    <div className="mt-2 flex min-h-5 flex-wrap gap-1">
                      {skill.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-foreground-muted">{tag}</span>
                      ))}
                    </div>
                    <div className="mt-auto flex items-center gap-2 pt-3">
                      <select
                        aria-label={`${skill.name} 版本`}
                        value={selectedVersion}
                        disabled={skill.versions.length === 0 || selecting}
                        onChange={(event) => setVersions((current) => ({ ...current, [skill.name]: Number(event.target.value) }))}
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
                      >
                        {skill.versions.map((version) => (
                          <option key={version.version} value={version.version}>
                            v{version.version}{version.version === skill.activeVersion ? '（激活）' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={skill.versions.length === 0 || selecting}
                        onClick={() => void onSelect(skill.name, selectedVersion)}
                        className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {selecting ? <Loader2 className="size-3.5 animate-spin" /> : '选择'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="flex h-80 flex-col items-center justify-center text-center">
              <FolderSearch className="size-6 text-foreground-muted" />
              <p className="mt-3 text-sm font-medium text-foreground">没有匹配的 Skill</p>
              <p className="mt-1 text-xs text-foreground-muted">尝试调整搜索词、分类或来源。</p>
            </div>
          )}
        </div>

        <footer className="flex items-center border-t border-border px-5 py-3 text-xs text-foreground-muted">
          <span>{range}</span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="上一页"
            disabled={!data || data.page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border disabled:opacity-40"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="mx-3">{data?.page || 1} / {data?.pages || 1}</span>
          <button
            type="button"
            aria-label="下一页"
            disabled={!data || data.page >= data.pages || loading}
            onClick={() => setPage((current) => current + 1)}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border disabled:opacity-40"
          >
            <ChevronRight className="size-4" />
          </button>
        </footer>
      </div>
    </div>
  );
}
