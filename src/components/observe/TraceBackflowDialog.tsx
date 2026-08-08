'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/client/api';
import {
  defaultTraceBackflowSourceForField,
  nextDatasetFieldKey,
  sortTraceBackflowDatasetsByRecency,
  type TraceBackflowArtifactSource,
} from '@/lib/agent-dataset-model';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
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

type FieldType = 'text' | 'number' | 'boolean' | 'json';
type ArtifactSource = TraceBackflowArtifactSource;
type TargetMode = 'existing' | 'new';
type DialogStep = 'target' | 'mapping' | 'preview';

interface DatasetFieldOption {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  description?: string;
  system?: boolean;
}

interface DatasetOption {
  id: string;
  name: string;
  fields: DatasetFieldOption[];
  createdAt?: string;
  updatedAt?: string;
}

interface ConfiguredField extends DatasetFieldOption {
  source: ArtifactSource;
  origin: 'existing' | 'new';
}

export interface TraceBackflowSource {
  taskId: string;
  executionId?: string;
  label?: string;
}

interface TraceDraft {
  values: { input: string; output: string; trace: unknown[] };
  traceSource: { taskId: string; executionId?: string; capturedAt: string };
}

interface PreparedDraft extends TraceDraft {
  label: string;
  warnings: string[];
}

interface PreviewRow {
  label: string;
  values: Record<string, unknown>;
  traceSource: TraceDraft['traceSource'];
  warnings: string[];
}

const FIELD_TYPE_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔值' },
  { value: 'json', label: 'JSON' },
] as const;

const SOURCE_OPTIONS = [
  { value: 'input', label: 'input' },
  { value: 'output', label: 'output' },
  { value: 'trace', label: 'trace' },
  { value: 'none', label: 'none' },
] as const;

const DEFAULT_NEW_FIELDS: ConfiguredField[] = [
  { id: 'input', key: 'input', label: '输入', type: 'text', system: true, source: 'input', origin: 'new' },
  { id: 'reference_output', key: 'reference_output', label: '预期输出', type: 'text', system: true, source: 'output', origin: 'new' },
  { id: 'trajectory', key: 'trajectory', label: '轨迹', type: 'json', system: true, source: 'trace', origin: 'new' },
];

async function settleWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function configureExistingFields(dataset?: DatasetOption): ConfiguredField[] {
  return (dataset?.fields || []).map(field => ({
    ...field,
    source: defaultTraceBackflowSourceForField(field.key),
    origin: 'existing',
  }));
}

function fieldPayload(field: ConfiguredField): DatasetFieldOption {
  return {
    id: field.id,
    key: field.key.trim(),
    label: field.label.trim(),
    type: field.type,
    description: field.description,
    system: field.system,
  };
}

export function TraceBackflowDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: string;
  sources: TraceBackflowSource[];
  onSaved?: () => void;
}) {
  const sourceKey = JSON.stringify(props.sources.map(source => ({
    taskId: source.taskId,
    executionId: source.executionId,
    label: source.label,
  })));
  const [step, setStep] = useState<DialogStep>('target');
  const [mode, setMode] = useState<TargetMode | null>(null);
  const [datasets, setDatasets] = useState<DatasetOption[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [datasetName, setDatasetName] = useState('Trace 回流数据集');
  const [datasetDescription, setDatasetDescription] = useState('');
  const [fields, setFields] = useState<ConfiguredField[]>([]);
  const [drafts, setDrafts] = useState<PreparedDraft[]>([]);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!props.open || !props.user) return;
    const sources = (JSON.parse(sourceKey) as TraceBackflowSource[])
      .filter(source => source.taskId || source.executionId);
    if (sources.length === 0) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setLoading(true);
      setStep('target');
      setMode(null);
      setDatasetId('');
      setDatasetName('Trace 回流数据集');
      setDatasetDescription('');
      setFields([]);
      setDrafts([]);
      setPreviewRows([]);
      setFailedCount(0);
      setActiveIndex(0);
      setError('');
      try {
        const [datasetList, prepared] = await Promise.all([
          apiFetch(`/api/agent-datasets?user=${encodeURIComponent(props.user)}&view=summary`).then(async response => {
            const data = await response.json();
            if (!response.ok) throw new Error(data?.error || '评测数据集加载失败');
            return Array.isArray(data) ? data : [];
          }),
          settleWithConcurrency(sources, 3, async source => {
            const response = await apiFetch('/api/agent-datasets/trace-drafts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                user: props.user,
                taskId: source.taskId,
                executionId: source.executionId,
              }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data?.error || 'Trace 读取失败');
            return {
              ...data.draft,
              label: source.label || source.taskId || source.executionId || 'Trace',
              warnings: Array.isArray(data.warnings) ? data.warnings : [],
            } as PreparedDraft;
          }),
        ]);
        if (cancelled) return;
        const options = sortTraceBackflowDatasetsByRecency(datasetList.map((item: DatasetOption) => ({
          id: item.id,
          name: item.name,
          fields: Array.isArray(item.fields) ? item.fields : [],
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })));
        const successful = prepared
          .filter((result): result is PromiseFulfilledResult<PreparedDraft> => result.status === 'fulfilled')
          .map(result => result.value);
        setDatasets(options);
        setDrafts(successful);
        setFailedCount(prepared.length - successful.length);
        if (options.length > 0) {
          setMode('existing');
          setDatasetId(options[0].id);
          setFields(configureExistingFields(options[0]));
        } else {
          setMode('new');
          setFields(DEFAULT_NEW_FIELDS.map(field => ({ ...field })));
        }
        if (successful.length === 0) setError('所选 Trace 均处理失败，请稍后重试');
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Trace 回流准备失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [props.open, props.user, sourceKey]);

  const selectedDataset = useMemo(
    () => datasets.find(dataset => dataset.id === datasetId) || null,
    [datasets, datasetId],
  );
  const isBatch = props.sources.length > 1;
  const activePreview = previewRows[activeIndex] || null;
  const addedFieldCount = mode === 'existing' ? fields.filter(field => field.origin === 'new').length : fields.length;

  const chooseMode = (nextMode: TargetMode) => {
    setMode(nextMode);
    setError('');
    if (nextMode === 'new') {
      setDatasetId('');
      setFields(DEFAULT_NEW_FIELDS.map(field => ({ ...field })));
    } else {
      setFields([]);
    }
  };

  const chooseDataset = (nextId: string) => {
    setDatasetId(nextId);
    setError('');
    const dataset = datasets.find(item => item.id === nextId);
    setFields(configureExistingFields(dataset));
  };

  const updateField = (id: string, patch: Partial<ConfiguredField>) => {
    setFields(current => current.map(field => field.id === id ? { ...field, ...patch } : field));
    setError('');
  };

  const addField = () => {
    const key = nextDatasetFieldKey(fields.map(field => field.key));
    const usedLabels = new Set(fields.map(field => field.label.trim().toLocaleLowerCase()));
    let index = 1;
    while (usedLabels.has(`新字段 ${index}`.toLocaleLowerCase())) index += 1;
    setFields(current => [...current, {
      id: `new-${key}`,
      key,
      label: `新字段 ${index}`,
      type: 'text',
      source: 'none',
      origin: 'new',
    }]);
  };

  const removeField = (id: string) => {
    setFields(current => current.filter(field => field.id !== id));
    setError('');
  };

  const goToMapping = () => {
    if (!mode) {
      setError('请选择添加到已有数据集或新建数据集');
      return;
    }
    if (mode === 'existing' && !datasetId) {
      setError('请选择一个已有数据集');
      return;
    }
    if (mode === 'new' && !datasetName.trim()) {
      setError('请输入新数据集名称');
      return;
    }
    setError('');
    setStep('mapping');
  };

  const goToPreview = () => {
    if (fields.length === 0) {
      setError('请至少保留一个字段');
      return;
    }
    const seenKeys = new Set<string>();
    const seenLabels = new Set<string>();
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      const key = field.key.trim();
      const label = field.label.trim();
      if (!label) {
        setError(`第 ${index + 1} 个字段缺少字段名称`);
        return;
      }
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
        setError('字段内部标识异常，请删除后重新新增该字段');
        return;
      }
      if (seenKeys.has(key)) {
        setError('字段内部标识重复，请删除后重新新增该字段');
        return;
      }
      const normalizedLabel = label.toLocaleLowerCase();
      if (seenLabels.has(normalizedLabel)) {
        setError(`字段名称「${label}」重复`);
        return;
      }
      seenKeys.add(key);
      seenLabels.add(normalizedLabel);
    }
    if (!fields.some(field => field.source !== 'none')) {
      setError('请至少将一个字段映射到 Trace 数据');
      return;
    }
    setPreviewRows(drafts.map(draft => ({
      label: draft.label,
      traceSource: draft.traceSource,
      warnings: draft.warnings,
      values: Object.fromEntries(fields.map(field => [
        field.key.trim(),
        field.source === 'none' ? '' : draft.values[field.source],
      ])),
    })));
    setActiveIndex(0);
    setError('');
    setStep('preview');
  };

  const updatePreviewValue = (key: string, value: unknown) => {
    setPreviewRows(current => current.map((row, index) => (
      index === activeIndex ? { ...row, values: { ...row.values, [key]: value } } : row
    )));
  };

  const save = async () => {
    if (!mode || previewRows.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch('/api/agent-datasets/backflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: props.user,
          mode,
          datasetId: mode === 'existing' ? datasetId : undefined,
          datasetName: mode === 'new' ? datasetName.trim() : undefined,
          datasetDescription: mode === 'new' ? datasetDescription.trim() : undefined,
          fields: mode === 'new' ? fields.map(fieldPayload) : undefined,
          newFields: mode === 'existing'
            ? fields.filter(field => field.origin === 'new').map(fieldPayload)
            : undefined,
          fieldMappings: fields.map(field => ({ key: field.key.trim(), source: field.source })),
          cases: previewRows.map(row => ({ values: row.values, traceSource: row.traceSource })),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result?.success) throw new Error(result?.error || '回流保存失败');
      toast.success(`${result.inserted || previewRows.length} 条 Trace 已加入评测数据集`);
      props.onSaved?.();
      props.onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '回流保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={open => !saving && props.onOpenChange(open)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>加入评测数据集</DialogTitle>
          <DialogDescription>
            将原始用户输入、最终输出和原始 Trace JSON 映射到目标数据集，确认预览后再写入。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 border-b border-border text-xs">
          {[
            ['target', '1 选择数据集'],
            ['mapping', '2 字段映射'],
            ['preview', '3 数据预览'],
          ].map(([value, label]) => (
            <div
              key={value}
              className={cn(
                'border-b-2 px-3 py-2 text-center text-foreground-muted',
                step === value && 'border-primary font-medium text-primary',
              )}
            >
              {label}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="py-14 text-center text-sm text-foreground-muted">正在读取 {props.sources.length} 条 Trace...</div>
        ) : error && drafts.length === 0 ? (
          <div className="rounded-md border border-error-border bg-error-subtle p-3 text-sm text-error">{error}</div>
        ) : (
          <div className="grid gap-4">
            {failedCount > 0 && (
              <div className="rounded-md border border-warning-border bg-warning-subtle p-3 text-sm text-warning">
                {failedCount} 条 Trace 处理失败，将不会进入本次保存；其余 {drafts.length} 条可以继续配置。
              </div>
            )}

            {step === 'target' && (
              <div className="grid gap-5 py-2">
                <div className="grid gap-2">
                  <span className="text-xs font-medium text-foreground-muted">写入方式</span>
                  <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border">
                    <button
                      type="button"
                      onClick={() => chooseMode('existing')}
                      aria-pressed={mode === 'existing'}
                      className={cn(
                        'min-h-10 px-3 text-sm transition-colors hover:bg-background-secondary',
                        mode === 'existing' && 'bg-primary-subtle font-medium text-primary',
                      )}
                    >
                      添加到已有数据集
                    </button>
                    <button
                      type="button"
                      onClick={() => chooseMode('new')}
                      aria-pressed={mode === 'new'}
                      className={cn(
                        'min-h-10 border-l border-border px-3 text-sm transition-colors hover:bg-background-secondary',
                        mode === 'new' && 'bg-primary-subtle font-medium text-primary',
                      )}
                    >
                      新建数据集
                    </button>
                  </div>
                </div>

                {mode === 'existing' && (
                  <div className="grid gap-2">
                    <span className="text-xs font-medium text-foreground-muted">已有数据集</span>
                    <Select
                      value={datasetId}
                      onChange={chooseDataset}
                      options={[
                        { value: '', label: '请选择数据集' },
                        ...datasets.map(item => ({ value: item.id, label: `${item.name}（${item.fields.length} 个字段）` })),
                      ]}
                      size="md"
                      className="w-full justify-between"
                      aria-label="已有数据集"
                    />
                    {datasets.length === 0 && <span className="text-xs text-foreground-muted">当前没有可用数据集，请选择新建数据集。</span>}
                  </div>
                )}

                {mode === 'new' && (
                  <div className="grid gap-4">
                    <label className="grid gap-2">
                      <span className="text-xs font-medium text-foreground-muted">数据集名称</span>
                      <Input value={datasetName} onChange={event => setDatasetName(event.target.value)} />
                    </label>
                    <label className="grid gap-2">
                      <span className="text-xs font-medium text-foreground-muted">描述（可选）</span>
                      <Textarea rows={3} value={datasetDescription} onChange={event => setDatasetDescription(event.target.value)} />
                    </label>
                  </div>
                )}
              </div>
            )}

            {step === 'mapping' && (
              <div className="grid gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">
                    {mode === 'existing' ? selectedDataset?.name : datasetName}
                  </span>
                  <span className="text-foreground-muted">{fields.length} 个字段 · {drafts.length} 条 Trace</span>
                </div>
                <div className="overflow-x-auto border-y border-border">
                  <div className="min-w-[620px]">
                    <div className="grid grid-cols-[minmax(180px,1fr)_110px_minmax(190px,1.2fr)_40px] gap-3 bg-background-secondary px-3 py-2 text-xs font-medium text-foreground-muted">
                      <span>字段名称</span>
                      <span>类型</span>
                      <span>Trace source</span>
                      <span />
                    </div>
                    {fields.map((field, index) => {
                      const editable = mode === 'new' || field.origin === 'new';
                      return (
                        <div
                          key={field.id}
                          className={cn(
                            'grid grid-cols-[minmax(180px,1fr)_110px_minmax(190px,1.2fr)_40px] items-center gap-3 px-3 py-2',
                            index > 0 && 'border-t border-border',
                          )}
                        >
                          {editable ? (
                            <Input value={field.label} onChange={event => updateField(field.id, { label: event.target.value })} aria-label="字段名称" />
                          ) : <span className="truncate text-sm text-foreground">{field.label}</span>}
                          {editable ? (
                            <Select
                              value={field.type}
                              onChange={type => updateField(field.id, { type })}
                              options={FIELD_TYPE_OPTIONS}
                              size="md"
                              className="w-full justify-between"
                              aria-label={`${field.label} 字段类型`}
                            />
                          ) : <span className="text-xs text-foreground-muted">{FIELD_TYPE_OPTIONS.find(option => option.value === field.type)?.label}</span>}
                          <Select
                            value={field.source}
                            onChange={source => updateField(field.id, { source })}
                            options={SOURCE_OPTIONS}
                            size="md"
                            className="w-full justify-between"
                            aria-label={`${field.label} Trace source`}
                          />
                          {editable ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-8 text-foreground-muted hover:text-error"
                              onClick={() => removeField(field.id)}
                              title={`删除字段 ${field.label}`}
                              aria-label={`删除字段 ${field.label}`}
                            >
                              <Trash2 className="size-4" aria-hidden />
                            </Button>
                          ) : <span />}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" className="w-fit gap-1.5" onClick={addField}>
                  <Plus className="size-4" aria-hidden />
                  新增字段
                </Button>
              </div>
            )}

            {step === 'preview' && activePreview && (
              <div className="grid gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 text-sm">
                  <span className="font-medium text-foreground">
                    {mode === 'existing' ? `写入 ${selectedDataset?.name}` : `新建 ${datasetName}`}
                  </span>
                  <span className="text-foreground-muted">
                    {previewRows.length} 条数据 · {mode === 'existing' ? `新增 ${addedFieldCount} 个字段` : `${fields.length} 个字段`}
                  </span>
                </div>
                <div className={cn('grid gap-4', isBatch && 'md:grid-cols-[220px_minmax(0,1fr)]')}>
                  {isBatch && (
                    <div className="max-h-[56vh] overflow-y-auto border-r border-border pr-3">
                      <div className="grid gap-1">
                        {previewRows.map((row, index) => (
                          <button
                            key={`${row.traceSource.executionId || row.traceSource.taskId}-${index}`}
                            type="button"
                            onClick={() => { setActiveIndex(index); setError(''); }}
                            className={cn(
                              'w-full rounded-sm px-2 py-2 text-left text-xs transition-colors hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              activeIndex === index && 'bg-primary-subtle text-primary',
                            )}
                          >
                            <span className="block font-medium">第 {index + 1} 条</span>
                            <span className="mt-0.5 block truncate text-foreground-muted">{row.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="grid min-w-0 gap-4">
                    {fields.map(field => (
                      <label key={field.id} className="grid gap-2">
                        <span className="text-xs font-medium text-foreground-muted">{field.label} · {field.key}</span>
                        {field.type === 'boolean' ? (
                          <input
                            type="checkbox"
                            checked={activePreview.values[field.key] === true || activePreview.values[field.key] === 'true'}
                            onChange={event => updatePreviewValue(field.key, event.target.checked)}
                            className="size-4 accent-primary"
                          />
                        ) : field.type === 'number' ? (
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={String(activePreview.values[field.key] ?? '')}
                            onChange={event => {
                              const raw = event.target.value;
                              const parsed = Number(raw);
                              updatePreviewValue(field.key, raw === '' ? '' : Number.isFinite(parsed) ? parsed : raw);
                            }}
                          />
                        ) : (
                          <Textarea
                            className={cn(
                              'field-sizing-fixed resize-y overflow-y-scroll',
                              field.type === 'json' ? 'h-64 font-mono text-xs' : 'h-28',
                            )}
                            rows={field.type === 'json' ? 7 : 4}
                            value={typeof activePreview.values[field.key] === 'string'
                              ? activePreview.values[field.key] as string
                              : JSON.stringify(activePreview.values[field.key] ?? '', null, 2)}
                            onChange={event => updatePreviewValue(field.key, event.target.value)}
                            spellCheck={field.type !== 'json'}
                          />
                        )}
                      </label>
                    ))}
                    {activePreview.warnings.length > 0 && (
                      <div className="rounded-md border border-warning-border bg-warning-subtle p-3 text-sm text-warning">
                        {activePreview.warnings.join(' ')}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {error && drafts.length > 0 && (
              <div className="rounded-md border border-error-border bg-error-subtle p-3 text-sm text-error">{error}</div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {step !== 'target' && (
              <Button
                variant="ghost"
                onClick={() => { setError(''); setStep(step === 'preview' ? 'mapping' : 'target'); }}
                disabled={saving}
                className="gap-1"
              >
                <ChevronLeft className="size-4" aria-hidden />
                上一步
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={saving}>取消</Button>
            {step === 'target' && <Button onClick={goToMapping} disabled={loading || drafts.length === 0}>下一步：字段映射</Button>}
            {step === 'mapping' && <Button onClick={goToPreview}>下一步：数据预览</Button>}
            {step === 'preview' && (
              <Button onClick={() => void save()} disabled={saving || previewRows.length === 0}>
                {saving ? '保存中...' : `确认加入（${previewRows.length}）`}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
