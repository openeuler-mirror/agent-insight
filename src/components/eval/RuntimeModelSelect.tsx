'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { filterRuntimeModels, normalizeRuntimeModels, type RuntimeModelOption } from '@/lib/client/model-search';

export function RuntimeModelSelect({ id, models = [], value, onChange }: {
  id: string;
  models?: RuntimeModelOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const options = useMemo(() => [
    { id: '', label: '平台默认' },
    ...normalizeRuntimeModels(models),
  ], [models]);
  const filtered = useMemo(() => filterRuntimeModels(options, query), [options, query]);
  const active = filtered[Math.min(activeIndex, filtered.length - 1)];
  const selected = options.find((model) => model.id === value);
  const label = (model: RuntimeModelOption) => model.label || model.id || '平台默认';

  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, query]);

  const choose = (model: RuntimeModelOption) => {
    onChange(model.id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      setQuery('');
      setActiveIndex(Math.max(0, options.findIndex((model) => model.id === value)));
    }}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" className="w-full min-w-0 justify-between font-normal"
          aria-label={`运行模型：${selected ? label(selected) : value || '平台默认'}`}>
          <span className="truncate">{selected ? label(selected) : value || '平台默认'}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="选择运行模型" className="p-2" style={{ width: 'var(--radix-popover-trigger-width)' }}
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}>
        <Input ref={inputRef} role="combobox" aria-label="搜索运行模型" aria-expanded={open}
          aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active ? `${listId}-${filtered.indexOf(active)}` : undefined}
          placeholder="搜索供应商 / 模型名称或 ID" value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (filtered.length) {
                const index = filtered.indexOf(active);
                setActiveIndex((index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length);
              }
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (active) choose(active);
            }
          }} />
        <div role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {filtered.length ? `${filtered.length} 个选项` : '没有匹配的模型，请修改搜索词'}
        </div>
        <div id={listId} role="listbox" aria-label="运行模型" className="max-h-64 overflow-y-auto">
          {filtered.map((model, index) => (
            <div key={model.id} id={`${listId}-${index}`} role="option" aria-selected={model.id === value}
              ref={model === active ? activeRef : undefined}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm ${model === active ? 'bg-accent text-accent-foreground' : ''}`}
              onMouseMove={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(model)} title={model.id || label(model)}>
              <span className="min-w-0 flex-1 truncate">{label(model)}</span>
              {model.id === value && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
