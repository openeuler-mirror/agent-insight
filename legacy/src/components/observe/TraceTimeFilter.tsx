/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use client';

import { useId, useState, useSyncExternalStore } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { SelectOption } from '@/components/ui/select';
import { resolveTraceTimeRange, toLocalTraceTime, type TraceTimeRangeError } from '@/lib/client/trace-time-range';
import { cn } from '@/lib/utils';

interface Props {
    value: string;
    from: string;
    to: string;
    label: string;
    options: SelectOption[];
    locale: string;
    onChange: (next: { time: string; timeFrom: string; timeTo: string }) => void;
}

const subscribe = () => () => {};

export default function TraceTimeFilter({ value, from, to, label, options, locale, onChange }: Props) {
    const zh = locale === 'zh';
    const browserReady = useSyncExternalStore(subscribe, () => true, () => false);
    const id = useId();
    const [open, setOpen] = useState(false);
    const [custom, setCustom] = useState(false);
    const [start, setStart] = useState('');
    const [end, setEnd] = useState('');
    const [error, setError] = useState<TraceTimeRangeError | null>(null);
    const customLabel = zh ? '自定义时间范围' : 'Custom time range';
    const errors: Record<TraceTimeRangeError, string> = {
        empty: zh ? '请至少填写开始或结束时间' : 'Enter a start or end time',
        invalid: zh ? '请输入有效的日期时间' : 'Enter a valid date and time',
        order: zh ? '开始时间不能晚于结束时间' : 'Start time must not be after end time',
    };
    const activeRange = value === 'custom' ? resolveTraceTimeRange(from, to) : null;
    const rangeLabel = browserReady && activeRange && !activeRange.error
        ? `${toLocalTraceTime(from).replace('T', ' ') || (zh ? '不限' : 'Any')} ～ ${toLocalTraceTime(to).replace('T', ' ') || (zh ? '不限' : 'Any')}`
        : customLabel;
    const currentLabel = value === 'custom' ? rangeLabel : options.find(option => option.value === value)?.label ?? value;
    const changeOpen = (next: boolean) => {
        if (next) {
            setStart(toLocalTraceTime(from));
            setEnd(toLocalTraceTime(to));
            setCustom(value === 'custom');
            setError(activeRange?.error ?? null);
        }
        setOpen(next);
    };
    const apply = () => {
        const range = resolveTraceTimeRange(start, end);
        setError(range.error);
        if (range.error) return;
        onChange({ time: 'custom', timeFrom: range.from, timeTo: range.to });
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={changeOpen}>
            <PopoverTrigger asChild>
                <button type="button" aria-label={`${label}: ${value === 'custom' ? customLabel : currentLabel}`} title={value === 'custom' ? rangeLabel : undefined}
                    className={cn('inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        value !== 'all' ? 'bg-primary-subtle border-primary-border text-primary' : 'bg-card border-border text-foreground hover:bg-background-secondary')}>
                    <span className={cn('font-medium', value === 'all' && 'text-foreground-muted')}>{label}</span>
                    <span className="max-w-[14rem] truncate">{currentLabel}</span>
                    <ChevronDown className="size-3 shrink-0 text-foreground-muted" aria-hidden />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)] p-2 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto" aria-label={label}>
                <div className="flex flex-col gap-0.5">
                    {options.map(option => (
                        <button key={option.value} type="button" onClick={() => {
                            onChange({ time: option.value, timeFrom: '', timeTo: '' });
                            setOpen(false);
                        }} className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <span className="size-4 shrink-0">{value === option.value && <Check className="size-4" />}</span>
                            {option.label}
                        </button>
                    ))}
                    <button type="button" aria-expanded={custom} aria-controls={`${id}-range`} onClick={() => setCustom(true)}
                        className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="size-4 shrink-0">{value === 'custom' && <Check className="size-4" />}</span>
                        {customLabel}
                    </button>
                </div>
                {custom && (
                    <form id={`${id}-range`} className="mt-2 space-y-3 border-t border-border px-2 pt-3" onSubmit={event => { event.preventDefault(); apply(); }}>
                        <p className="text-xs text-foreground-muted">{zh ? '本地时区' : 'Local time zone'}: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
                        <div className="space-y-1">
                            <label htmlFor={`${id}-start`} className="text-xs font-medium">{zh ? '开始时间（可选）' : 'Start time (optional)'}</label>
                            <Input id={`${id}-start`} type="datetime-local" step="1" value={start} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
                                className="relative block pr-8 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:right-3 [&::-webkit-calendar-picker-indicator]:m-0"
                                onChange={event => { setStart(event.target.value); setError(null); }} />
                        </div>
                        <div className="space-y-1">
                            <label htmlFor={`${id}-end`} className="text-xs font-medium">{zh ? '结束时间（可选）' : 'End time (optional)'}</label>
                            <Input id={`${id}-end`} type="datetime-local" step="1" value={end} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
                                className="relative block pr-8 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:right-3 [&::-webkit-calendar-picker-indicator]:m-0"
                                onChange={event => { setEnd(event.target.value); setError(null); }} />
                        </div>
                        {error && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{errors[error]}</p>}
                        <div className="flex justify-end gap-2 pb-1">
                            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>{zh ? '取消' : 'Cancel'}</Button>
                            <Button type="submit" size="sm">{zh ? '应用' : 'Apply'}</Button>
                        </div>
                    </form>
                )}
            </PopoverContent>
        </Popover>
    );
}
