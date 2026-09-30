'use client';

import { useState } from 'react';
import { Info, RotateCcw, SlidersHorizontal } from 'lucide-react';

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
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  DEFAULT_ENTITY_F1_RUN_CONFIG,
  DEFAULT_EXACT_MATCH_RUN_CONFIG,
  ENTITY_F1_EVALUATOR_ID,
  EXACT_MATCH_EVALUATOR_ID,
  normalizeEntityF1RunConfig,
  normalizeExactMatchRunConfig,
  type ConfigurableTextEvaluatorId,
  type EntityF1RunConfig,
  type EntityMatchMode,
  type EvaluatorRunConfigMap,
  type ExactMatchRunConfig,
  type MultiCandidateScoring,
} from '@/lib/evaluators/evaluator-run-config';

interface TextEvaluatorConfigDialogProps {
  evaluatorId: ConfigurableTextEvaluatorId;
  configs: EvaluatorRunConfigMap;
  onOpenChange: (open: boolean) => void;
  onSave: (
    id: ConfigurableTextEvaluatorId,
    config: ExactMatchRunConfig | EntityF1RunConfig,
  ) => void;
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-5 rounded-lg border border-card-border bg-background-secondary/45 px-3.5 py-3 transition-colors hover:border-border-dark">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-foreground-muted">{description}</span>
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
        className="mt-0.5"
      />
    </label>
  );
}

function ChoiceGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; description: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-lg border px-3 py-2.5 text-left transition-all',
              active
                ? 'border-primary bg-primary-subtle shadow-sm'
                : 'border-card-border bg-card hover:border-border-dark',
            )}
          >
            <span className={cn('block text-xs font-bold', active ? 'text-primary' : 'text-foreground')}>
              {option.label}
            </span>
            <span className="mt-1 block text-[11px] leading-4 text-foreground-muted">
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function TextEvaluatorConfigDialog({
  evaluatorId,
  configs,
  onOpenChange,
  onSave,
}: TextEvaluatorConfigDialogProps) {
  const [exactDraft, setExactDraft] = useState<ExactMatchRunConfig>(() =>
    normalizeExactMatchRunConfig(configs[EXACT_MATCH_EVALUATOR_ID]));
  const [f1Draft, setF1Draft] = useState<EntityF1RunConfig>(() =>
    normalizeEntityF1RunConfig(configs[ENTITY_F1_EVALUATOR_ID]));

  const isExact = evaluatorId === EXACT_MATCH_EVALUATOR_ID;
  const isF1 = evaluatorId === ENTITY_F1_EVALUATOR_ID;

  const reset = () => {
    if (isExact) setExactDraft({ ...DEFAULT_EXACT_MATCH_RUN_CONFIG });
    if (isF1) setF1Draft({ ...DEFAULT_ENTITY_F1_RUN_CONFIG });
  };

  const save = () => {
    if (isExact) onSave(EXACT_MATCH_EVALUATOR_ID, exactDraft);
    if (isF1) onSave(ENTITY_F1_EVALUATOR_ID, f1Draft);
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto p-0">
        <DialogHeader className="border-b border-border px-6 py-5 pr-12">
          <div className="flex items-center gap-2 text-primary">
            <SlidersHorizontal className="size-4" />
            <DialogTitle>
              {isExact ? '完全精确匹配配置' : '实体 F1 匹配配置'}
            </DialogTitle>
          </div>
          <DialogDescription>
            {isExact
              ? '控制比较前的文本标准化方式，以及多个参考答案的计分口径。'
              : '控制实体之间如何判定匹配，以及比较前的标准化方式。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-5">
          {isExact && (
            <>
              <section className="space-y-2.5">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-foreground-secondary">
                    文本标准化
                  </h3>
                  <p className="mt-1 text-xs text-foreground-muted">开启的处理会同时作用于实际输出和参考答案。</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ToggleRow
                    label="忽略大小写"
                    description="例如 OK 与 ok 视为相同。"
                    checked={!exactDraft.caseSensitive}
                    onCheckedChange={(checked) => setExactDraft((prev) => ({ ...prev, caseSensitive: !checked }))}
                  />
                  <ToggleRow
                    label="忽略 Unicode 标点"
                    description="去除中英文标点后再比较。"
                    checked={exactDraft.punctuationInsensitive}
                    onCheckedChange={(checked) => setExactDraft((prev) => ({ ...prev, punctuationInsensitive: checked }))}
                  />
                  <ToggleRow
                    label="归一化空白"
                    description="连续空白合并，并移除首尾空白。"
                    checked={exactDraft.whitespaceNormalization}
                    onCheckedChange={(checked) => setExactDraft((prev) => ({ ...prev, whitespaceNormalization: checked }))}
                  />
                  <ToggleRow
                    label="统一全角/半角"
                    description="采用 NFKC 统一字符宽度。"
                    checked={exactDraft.widthNormalization}
                    onCheckedChange={(checked) => setExactDraft((prev) => ({ ...prev, widthNormalization: checked }))}
                  />
                </div>
              </section>

              <section className="space-y-2.5">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-foreground-secondary">
                    多候选计分
                  </h3>
                  <p className="mt-1 text-xs text-foreground-muted">参考答案为 JSON 字符串数组时生效。</p>
                </div>
                <ChoiceGroup<MultiCandidateScoring>
                  value={exactDraft.multiCandidateScoring}
                  onChange={(value) => setExactDraft((prev) => ({ ...prev, multiCandidateScoring: value }))}
                  options={[
                    { value: 'any', label: '任一命中即满分', description: '任意候选完全匹配即得 100 分。' },
                    { value: 'fraction', label: '按命中比例', description: '按命中候选数 ÷ 候选总数计分。' },
                  ]}
                />
              </section>
            </>
          )}

          {isF1 && (
            <>
              <section className="space-y-2.5">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-foreground-secondary">
                    实体匹配方式
                  </h3>
                  <p className="mt-1 text-xs text-foreground-muted">预测实体与标准实体采用最大一对一匹配。</p>
                </div>
                <ChoiceGroup<EntityMatchMode>
                  value={f1Draft.matchMode}
                  onChange={(value) => setF1Draft((prev) => ({ ...prev, matchMode: value }))}
                  options={[
                    { value: 'exact', label: '精确匹配', description: '标准化后必须完全相同。' },
                    { value: 'fuzzy', label: '模糊匹配', description: '编辑距离不超过阈值即匹配。' },
                    { value: 'substring', label: '子串匹配', description: '一方完整包含另一方即匹配。' },
                  ]}
                />
              </section>

              {f1Draft.matchMode === 'fuzzy' && (
                <section className="rounded-lg border border-card-border bg-background-secondary/45 p-3.5">
                  <label htmlFor="fuzzy-threshold" className="text-sm font-semibold text-foreground">
                    最大编辑距离
                  </label>
                  <p className="mt-0.5 text-xs leading-5 text-foreground-muted">
                    允许插入、删除或替换的字符数，取值 0–100；一般使用 1。
                  </p>
                  <Input
                    id="fuzzy-threshold"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={f1Draft.fuzzyThreshold}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isInteger(value) && value >= 0 && value <= 100) {
                        setF1Draft((prev) => ({ ...prev, fuzzyThreshold: value }));
                      }
                    }}
                    className="mt-2 w-28 bg-card"
                  />
                </section>
              )}

              <section className="space-y-2.5">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-foreground-secondary">
                    实体标准化
                  </h3>
                  <p className="mt-1 text-xs text-foreground-muted">在去重和匹配之前应用。</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ToggleRow
                    label="忽略大小写"
                    description="英文实体不区分大小写。"
                    checked={!f1Draft.caseSensitive}
                    onCheckedChange={(checked) => setF1Draft((prev) => ({ ...prev, caseSensitive: !checked }))}
                  />
                  <ToggleRow
                    label="归一化空白"
                    description="连续空白合并并去除首尾空白。"
                    checked={f1Draft.whitespaceNormalization}
                    onCheckedChange={(checked) => setF1Draft((prev) => ({ ...prev, whitespaceNormalization: checked }))}
                  />
                  <ToggleRow
                    label="统一全角/半角"
                    description="采用 NFKC 统一字符宽度。"
                    checked={f1Draft.widthNormalization}
                    onCheckedChange={(checked) => setF1Draft((prev) => ({ ...prev, widthNormalization: checked }))}
                  />
                </div>
              </section>
            </>
          )}

          <div className="flex gap-2 rounded-lg border border-primary-subtle-border bg-primary-subtle px-3.5 py-3 text-xs leading-5 text-foreground-secondary">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>该配置会保存到实验，并应用于本实验中的全部 Case；修改后不会回算历史实验结果。</span>
          </div>
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={reset} className="mr-auto">
            <RotateCcw className="size-3.5" />
            恢复默认
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" size="sm" onClick={save}>
            保存配置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
