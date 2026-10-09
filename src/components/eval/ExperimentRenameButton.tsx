'use client';

import { useId, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/client/api';
import { displayedExperimentName } from '@/lib/engine/experiment/experiment-name';

export function ExperimentRenameButton({
  experimentId,
  user,
  name,
  createdAt,
  onRenamed,
  showLabel = false,
}: {
  experimentId: string;
  user: string;
  name: string;
  createdAt: string;
  onRenamed: (name: string) => void;
  showLabel?: boolean;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const changeOpen = (nextOpen: boolean) => {
    if (saving) return;
    if (nextOpen) {
      setDraft(displayedExperimentName(name, createdAt));
      setError('');
    }
    setOpen(nextOpen);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextName = draft.trim();
    if (!nextName || nextName.length > 120) {
      setError('实验名称须为 1～120 个字符');
      return;
    }
    if (nextName === name) {
      setOpen(false);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(`/api/experiments/${encodeURIComponent(experimentId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, name: nextName }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result?.error || '修改实验名称失败'));
      onRenamed(String(result.name || nextName));
      setOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '修改实验名称失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={showLabel ? 'sm' : 'icon'}
        className={showLabel ? 'text-foreground-secondary' : 'size-6 text-foreground-muted'}
        aria-label="重命名实验"
        title="重命名实验"
        onClick={(event) => {
          event.stopPropagation();
          changeOpen(true);
        }}
      >
        <Pencil className="size-3.5" aria-hidden />
        {showLabel && '重命名'}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-md" onClick={(event) => event.stopPropagation()}>
          <DialogHeader><DialogTitle>重命名实验</DialogTitle></DialogHeader>
          <form onSubmit={(event) => void save(event)} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor={inputId} className="text-sm text-foreground-secondary">实验名称</label>
              <input
                id={inputId}
                autoFocus
                value={draft}
                maxLength={120}
                onChange={(event) => setDraft(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
              <p className="text-xs text-foreground-muted">{draft.length}/120</p>
              {error && <p role="alert" className="text-xs text-error">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={() => changeOpen(false)}>取消</Button>
              <Button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
