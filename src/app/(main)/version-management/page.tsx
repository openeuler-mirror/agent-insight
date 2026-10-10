'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit2, Loader2, Plus, Tag, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { VersionWorkspaceTabs } from '@/components/observe/VersionWorkspaceTabs';
import { PageContainer, PageHeader } from '@/components/shell/PageContainer';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { useLocale } from '@/lib/client/locale-context';
import { clusterTraceTagsByPrefix, type TraceTagCluster } from '@/lib/trace-tag-clustering';
import { cn } from '@/lib/utils';

type TraceTagKind = 'version' | 'business';

type TraceTag = {
  id: string;
  name: string;
  description: string | null;
  kind: TraceTagKind;
  color: string;
  createdBy: string | null;
  createdAt: string;
  usageCount: number;
};

type TagFormState = {
  id?: string;
  name: string;
  description: string;
  kind: TraceTagKind;
  color: string;
};

const EMPTY_FORM: TagFormState = {
  name: '',
  description: '',
  kind: 'version',
  color: '#6366f1',
};

const COLOR_SWATCHES = ['#6366f1', '#16a34a', '#0ea5e9', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'];

function strings(locale: string) {
  const zh = locale.toLowerCase().startsWith('zh');
  if (zh) {
    return {
      title: '版本管理',
      subtitle: '通过标签管理版本分组和业务筛选范围',
      intro: '通过标签实现版本管理：版本标签用于版本分析的对比与详情；业务标签用于在链路追踪中筛选 Trace。',
      newTag: '新建标签',
      newVersion: '新建版本标签',
      newBusiness: '新建业务标签',
      version: '版本标签',
      business: '业务标签',
      versionHint: '用于版本分析的对比与详情',
      businessHint: '用于链路追踪中筛选 Trace',
      traceCount: 'Trace 数',
      tagCount: '标签数',
      ungrouped: '未分组',
      newInGroup: '新建同前缀标签',
      totalTags: '标签总数',
      versionTags: '版本标签',
      businessTags: '业务标签',
      bindings: 'Trace 绑定',
      createdAt: '创建时间',
      descriptionColumn: '说明',
      noDesc: '无说明',
      edit: '编辑',
      delete: '删除',
      actions: '操作',
      formTitleNew: '新建标签',
      formTitleEdit: '编辑标签',
      formDescNew: '创建后可在链路追踪的用户标签列绑定到 Trace。',
      formDescEdit: '修改会影响所有已绑定 Trace 上的标签展示。',
      editImpact: '影响范围：名称、说明、颜色和类型变化会同步影响链路追踪、版本分析和业务筛选中的展示；已绑定的 Trace 不会丢失。',
      name: '名称',
      description: '描述',
      type: '标签类型',
      color: '颜色',
      cancel: '取消',
      save: '保存',
      create: '创建',
      saving: '保存中...',
      namePlaceholder: '如 baseline / v1.4 / 回归测试',
      descPlaceholder: '简短说明版本、实验或业务范围',
      emptyVersionTitle: '还没有版本标签',
      emptyBusinessTitle: '还没有业务标签',
      emptyDesc: '新建标签后，可从链路追踪给 Trace 打标。',
      loadFailed: '加载标签失败',
      saveFailed: '保存标签失败',
      deleteFailed: '删除标签失败',
      saved: '标签已保存',
      deleted: '标签已删除',
      deleteTitle: '确认删除标签？',
      deleteDesc: '这是硬删除：会删除标签并移除所有 Trace 绑定，Trace 记录本身会保留。',
      deleteImpactTitle: '影响范围',
      deleteImpactBindings: '将从 {count} 条 Trace 上移除此标签绑定。',
      deleteImpactVersion: '版本标签删除后，对应版本会从版本分析的对比和详情中消失。',
      deleteImpactBusiness: '业务标签删除后，对应链路追踪筛选条件将失效。',
      confirmDelete: '删除',
    };
  }
  return {
    title: 'Version Management',
    subtitle: 'Manage version cohorts and business filter tags',
    intro: 'Version tags power Version Analysis; business tags are used to filter traces in Trace.',
    newTag: 'New tag',
    newVersion: 'New version tag',
    newBusiness: 'New business tag',
    version: 'Version tags',
    business: 'Business tags',
    versionHint: 'Used by Version Analysis comparison and detail views',
    businessHint: 'Used to filter traces in Trace',
    traceCount: 'Traces',
    tagCount: 'Tags',
    ungrouped: 'Ungrouped',
    newInGroup: 'New with prefix',
    totalTags: 'Total tags',
    versionTags: 'Version tags',
    businessTags: 'Business tags',
    bindings: 'Trace bindings',
    createdAt: 'Created',
    descriptionColumn: 'Description',
    noDesc: 'No description',
    edit: 'Edit',
    delete: 'Delete',
    actions: 'Actions',
    formTitleNew: 'Create tag',
    formTitleEdit: 'Edit tag',
    formDescNew: 'After creation, tags can be attached to traces in Trace.',
    formDescEdit: 'Changes affect how the tag appears on every bound trace.',
    editImpact: 'Impact: name, description, color, and type changes are reflected in Trace, Version Analysis, and business filters. Bound traces are kept.',
    name: 'Name',
    description: 'Description',
    type: 'Type',
    color: 'Color',
    cancel: 'Cancel',
    save: 'Save',
    create: 'Create',
    saving: 'Saving...',
    namePlaceholder: 'e.g. baseline / v1.4 / regression',
    descPlaceholder: 'Describe the version, experiment, or business scope',
    emptyVersionTitle: 'No version tags yet',
    emptyBusinessTitle: 'No business tags yet',
    emptyDesc: 'Create tags, then attach them from Trace.',
    loadFailed: 'Failed to load tags',
    saveFailed: 'Failed to save tag',
    deleteFailed: 'Failed to delete tag',
    saved: 'Tag saved',
    deleted: 'Tag deleted',
    deleteTitle: 'Delete tag?',
    deleteDesc: 'This hard-deletes the tag and removes it from every trace. Trace records are kept.',
    deleteImpactTitle: 'Impact scope',
    deleteImpactBindings: 'This tag will be removed from {count} traces.',
    deleteImpactVersion: 'Deleting a version tag removes that version from Version Analysis comparison and detail views.',
    deleteImpactBusiness: 'Deleting a business tag makes the corresponding Trace filter unavailable.',
    confirmDelete: 'Delete',
  };
}

async function readApiError(res: Response, fallback: string) {
  try {
    const data = await res.json();
    return String(data?.error || fallback);
  } catch {
    return fallback;
  }
}

export default function VersionManagementPage() {
  const { user } = useAuth();
  const { locale } = useLocale();
  const copy = strings(locale);
  const [tags, setTags] = useState<TraceTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<TagFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TraceTag | null>(null);

  const loadTags = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/tags?user=${encodeURIComponent(user)}`);
      if (!res.ok) throw new Error(await readApiError(res, copy.loadFailed));
      const data = await res.json();
      setTags(Array.isArray(data) ? data : []);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : copy.loadFailed);
      setTags([]);
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed, user]);

  useEffect(() => {
    void Promise.resolve().then(loadTags);
  }, [loadTags]);

  const counts = useMemo(() => {
    const version = tags.filter(tag => tag.kind === 'version').length;
    const business = tags.filter(tag => tag.kind === 'business').length;
    const bindings = tags.reduce((sum, tag) => sum + (tag.usageCount || 0), 0);
    return { version, business, bindings };
  }, [tags]);

  const versionTags = useMemo(() => tags.filter(tag => tag.kind === 'version').sort((a, b) => a.name.localeCompare(b.name)), [tags]);
  const businessTags = useMemo(() => tags.filter(tag => tag.kind === 'business').sort((a, b) => a.name.localeCompare(b.name)), [tags]);

  const openCreate = (kind: TraceTagKind = 'version', prefix?: string | null) => {
    setForm({ ...EMPTY_FORM, kind, name: prefix ? `${prefix}_` : '' });
    setFormOpen(true);
  };

  const openEdit = (tag: TraceTag) => {
    setForm({
      id: tag.id,
      name: tag.name,
      description: tag.description || '',
      kind: tag.kind,
      color: tag.color || EMPTY_FORM.color,
    });
    setFormOpen(true);
  };

  const saveTag = async () => {
    if (!user || !form.name.trim()) return;
    setSaving(true);
    try {
      const payload = { user, name: form.name.trim(), description: form.description.trim(), kind: form.kind, color: form.color };
      const res = form.id
        ? await apiFetch(`/api/tags/${encodeURIComponent(form.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await apiFetch('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(await readApiError(res, copy.saveFailed));
      toast.success(copy.saved);
      setFormOpen(false);
      await loadTags();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const deleteTag = async () => {
    if (!user || !deleteTarget) return;
    const res = await apiFetch(`/api/tags/${encodeURIComponent(deleteTarget.id)}?user=${encodeURIComponent(user)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await readApiError(res, copy.deleteFailed));
    toast.success(copy.deleted);
    setDeleteTarget(null);
    await loadTags();
  };

  return (
    <>
      <AppTopBar title={copy.title} showDefaultActions={false} />
      <VersionWorkspaceTabs />
      <PageContainer variant="wide" className="bg-background">
        <PageHeader
          title={copy.title}
          description={copy.subtitle}
          actions={(
            <Button onClick={() => openCreate('version')} className="h-8 gap-1.5">
              <Plus className="size-4" />
              {copy.newTag}
            </Button>
          )}
        />

        <div className="grid gap-3 md:grid-cols-4 mb-4">
          <SummaryCard label={copy.totalTags} value={tags.length} />
          <SummaryCard label={copy.versionTags} value={counts.version} />
          <SummaryCard label={copy.businessTags} value={counts.business} />
          <SummaryCard label={copy.bindings} value={counts.bindings} />
        </div>

        <div className='mb-4 rounded-md border border-border bg-background-secondary px-3 py-2 text-sm text-foreground-secondary'>
          {copy.intro}
        </div>

        {loading ? (
          <div className='flex items-center justify-center gap-2 py-16 text-sm text-foreground-muted'>
            <Loader2 className='size-4 animate-spin' />
            {copy.saving.replace('...', '')}
          </div>
        ) : (
          <div className='space-y-4'>
            <TagClusterSection
              title={copy.version}
              hint={copy.versionHint}
              tone='version'
              tags={versionTags}
              copy={copy}
              locale={locale}
              emptyTitle={copy.emptyVersionTitle}
              onCreate={() => openCreate('version')}
              onCreateInCluster={(prefix) => openCreate('version', prefix)}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
            <TagClusterSection
              title={copy.business}
              hint={copy.businessHint}
              tone='business'
              tags={businessTags}
              copy={copy}
              locale={locale}
              emptyTitle={copy.emptyBusinessTitle}
              onCreate={() => openCreate('business')}
              onCreateInCluster={(prefix) => openCreate('business', prefix)}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          </div>
        )}
      </PageContainer>

      <Dialog open={formOpen} onOpenChange={(open) => !saving && setFormOpen(open)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? copy.formTitleEdit : copy.formTitleNew}</DialogTitle>
            <DialogDescription>{form.id ? copy.formDescEdit : copy.formDescNew}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              {copy.name}
              <Input value={form.name} onChange={(event) => setForm(prev => ({ ...prev, name: event.target.value }))} placeholder={copy.namePlaceholder} maxLength={80} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              {copy.description}
              <Textarea value={form.description} onChange={(event) => setForm(prev => ({ ...prev, description: event.target.value }))} placeholder={copy.descPlaceholder} maxLength={300} />
            </label>
            <div className="grid gap-1.5 text-sm font-medium text-foreground">
              {copy.type}
              <Select
                value={form.kind}
                onChange={(kind) => setForm(prev => ({ ...prev, kind }))}
                options={[{ value: 'version', label: copy.version }, { value: 'business', label: copy.business }]}
                size="md"
              />
            </div>
            <div className="grid gap-2 text-sm font-medium text-foreground">
              {copy.color}
              <div className="flex flex-wrap items-center gap-2">
                {COLOR_SWATCHES.map(color => (
                  <button
                    key={color}
                    type="button"
                    aria-label={color}
                    onClick={() => setForm(prev => ({ ...prev, color }))}
                    className={cn('size-7 rounded-md border transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', form.color === color ? 'border-foreground scale-105' : 'border-border')}
                    style={{ backgroundColor: color }}
                  />
                ))}
                <Input type="color" value={form.color} onChange={(event) => setForm(prev => ({ ...prev, color: event.target.value }))} className="h-8 w-12 p-1" />
              </div>
            </div>
            {form.id && (
              <div className="rounded-md border border-warning-subtle bg-warning-subtle px-3 py-2 text-xs leading-5 text-warning">
                {copy.editImpact}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>{copy.cancel}</Button>
            <Button onClick={saveTag} disabled={saving || !form.name.trim()}>
              {saving ? copy.saving : (form.id ? copy.save : copy.create)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={copy.deleteTitle}
        description={deleteTarget ? (
          <span className="block space-y-2">
            <span className="block">{copy.deleteDesc} ({deleteTarget.name})</span>
            <span className="block rounded-md border border-error-border bg-error-subtle px-3 py-2 text-xs leading-5 text-error">
              <span className="block font-semibold">{copy.deleteImpactTitle}</span>
              <span className="mt-1 block">{copy.deleteImpactBindings.replace('{count}', (deleteTarget.usageCount || 0).toLocaleString())}</span>
              <span className="mt-1 block">{deleteTarget.kind === 'version' ? copy.deleteImpactVersion : copy.deleteImpactBusiness}</span>
            </span>
          </span>
        ) : copy.deleteDesc}
        confirmText={copy.confirmDelete}
        cancelText={copy.cancel}
        tone="danger"
        onConfirm={deleteTag}
      />
    </>
  );
}

function TagClusterSection({ title, hint, tone, tags, copy, locale, emptyTitle, onCreate, onCreateInCluster, onEdit, onDelete }: {
  title: string;
  hint: string;
  tone: TraceTagKind;
  tags: TraceTag[];
  copy: ReturnType<typeof strings>;
  locale: string;
  emptyTitle: string;
  onCreate: () => void;
  onCreateInCluster: (prefix: string | null) => void;
  onEdit: (tag: TraceTag) => void;
  onDelete: (tag: TraceTag) => void;
}) {
  const toneColor = tone === 'version' ? 'var(--primary)' : 'var(--success)';
  const clusters = clusterTraceTagsByPrefix(tags, locale);
  return (
    <section className='space-y-3'>
      <div className='flex items-center gap-3'>
        <span className='size-2 rounded-full' style={{ backgroundColor: toneColor }} />
        <div className='min-w-0'>
          <h2 className='text-sm font-semibold text-foreground'>{title}</h2>
          <p className='mt-0.5 text-xs text-foreground-muted'>{hint}</p>
        </div>
        <div className='flex-1' />
        <Button variant='outline' size='sm' onClick={onCreate}><Plus className='size-4' />{tone === 'version' ? copy.newVersion : copy.newBusiness}</Button>
      </div>
      {tags.length === 0 ? (
        <div className='overflow-hidden rounded-md border border-border bg-card'>
          <EmptyState icon={Tag} title={emptyTitle} description={copy.emptyDesc} />
        </div>
      ) : (
        <div className='grid gap-3 lg:grid-cols-2 2xl:grid-cols-3'>
          {clusters.map(cluster => (
            <TagClusterCard
              key={cluster.key}
              cluster={cluster}
              copy={copy}
              onCreate={() => onCreateInCluster(cluster.prefix)}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="text-xs text-foreground-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value.toLocaleString()}</div>
    </div>
  );
}

function TagClusterCard({ cluster, copy, onCreate, onEdit, onDelete }: {
  cluster: TraceTagCluster<TraceTag>;
  copy: ReturnType<typeof strings>;
  onCreate: () => void;
  onEdit: (tag: TraceTag) => void;
  onDelete: (tag: TraceTag) => void;
}) {
  return (
    <article className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-border bg-background-secondary px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{cluster.prefix || copy.ungrouped}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-muted">
            <span>{copy.tagCount} <strong className="font-semibold text-foreground">{cluster.tags.length.toLocaleString()}</strong></span>
            <span>{copy.bindings} <strong className="font-semibold text-foreground">{cluster.usageCount.toLocaleString()}</strong></span>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-xs" onClick={onCreate}>
          <Plus className="size-3.5" />
          {cluster.prefix ? copy.newInGroup : copy.newTag}
        </Button>
      </div>
      <div className="divide-y divide-border">
        {cluster.tags.map(tag => (
          <div key={tag.id} className="group flex items-start gap-3 px-4 py-3 hover:bg-background-secondary">
            <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground" title={tag.name}>{tag.name}</div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-foreground-secondary">{tag.description || copy.noDesc}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground-muted">
                <span>{copy.traceCount} <strong className="font-semibold tabular-nums text-foreground">{(tag.usageCount || 0).toLocaleString()}</strong></span>
                <span>{copy.createdAt} {formatDate(tag.createdAt)}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon" className="size-7" onClick={() => onEdit(tag)} aria-label={`${copy.edit} ${tag.name}`}>
                <Edit2 className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7 text-error hover:text-error" onClick={() => onDelete(tag)} aria-label={`${copy.delete} ${tag.name}`}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
