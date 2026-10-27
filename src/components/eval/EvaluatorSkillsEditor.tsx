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

import { useRef, useState } from 'react';
import { FileText, Folder, FolderSearch, Upload, Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { SkillManagementPicker } from '@/components/skill-workbench/SkillManagementPicker';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { evaluatorSkillSourceLabel, type EvaluatorSkillSelection, type EvaluatorSkillFileInfo } from '@/lib/evaluators/evaluator-skills';

interface Preview { path?: string; content?: string; isText?: boolean; size?: number; truncated?: boolean }
async function json(url: string, init?: RequestInit) {
  const response = await apiFetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Skill 文件处理失败');
  return data;
}
function sourceLabel(skill: EvaluatorSkillSelection) {
  return 'snapshotHash' in skill ? evaluatorSkillSourceLabel(skill) : skill.kind === 'library' ? `Skill 库 · v${skill.version}` : '本地导入 · 待保存';
}
function previewUrl(base: string, relative: string) {
  if (base.startsWith('/api/skills/')) {
    const [pathname, query] = base.split('?');
    const params = new URLSearchParams(query);
    const version = params.get('version'); params.delete('version');
    return `${pathname}/${version}/files/${relative.split('/').map(encodeURIComponent).join('/')}?${params}`;
  }
  return `${base}&path=${encodeURIComponent(relative)}`;
}
function FileTree({ files, prefix = '', selected, busy, onSelect }: {
  files: EvaluatorSkillFileInfo[]; prefix?: string; selected?: string; busy: boolean; onSelect: (path: string) => void;
}) {
  const names = [...new Set(files.map(file => file.path.slice(prefix.length).split('/')[0]))].sort((a, b) => a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b));
  return <ul className="space-y-1">{names.map(name => {
    const full = `${prefix}${name}`;
    const file = files.find(file => file.path === full);
    return <li key={full}>{file
      ? <button type="button" title={full} disabled={busy} onClick={() => onSelect(full)} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${selected === full ? 'bg-primary-subtle text-primary' : 'text-foreground-secondary hover:bg-background-secondary'}`}><FileText className="size-3.5 shrink-0" /><span className="break-all">{name}</span></button>
      : <details open><summary className="cursor-pointer rounded px-2 py-1.5 text-xs text-foreground-secondary"><Folder className="mr-2 inline size-3.5" />{name}</summary><div className="ml-3 border-l border-border pl-2"><FileTree files={files.filter(file => file.path.startsWith(`${full}/`))} prefix={`${full}/`} selected={selected} busy={busy} onSelect={onSelect} /></div></details>}</li>;
  })}</ul>;
}

export default function EvaluatorSkillsEditor({ value, onChange, evaluatorId }: {
  value: EvaluatorSkillSelection[]; onChange: (skills: EvaluatorSkillSelection[]) => void; evaluatorId?: string;
}) {
  const { user } = useAuth();
  const folderInput = useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [librarySession, setLibrarySession] = useState(0);
  const [open, setOpen] = useState(false);
  const [returnToLibrary, setReturnToLibrary] = useState(false);
  const [replaceSkill, setReplaceSkill] = useState<EvaluatorSkillSelection | null>(null);
  const [viewedSkill, setViewedSkill] = useState<EvaluatorSkillSelection | null>(null);
  const [candidate, setCandidate] = useState<EvaluatorSkillSelection | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [files, setFiles] = useState<EvaluatorSkillFileInfo[]>([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const userQuery = `user=${encodeURIComponent(user || '')}`;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const showPackage = async (skill: EvaluatorSkillSelection, url: string, pending: boolean, fromLibrary = false) => {
    setLibraryOpen(false); setOpen(true); setReturnToLibrary(fromLibrary);
    setViewedSkill(skill); setCandidate(null); setPreview(null); setFiles([]); setBaseUrl(url);
    const data = await json(url);
    setFiles(data.files || []);
    setPreview(await json(previewUrl(url, 'SKILL.md')));
    if (pending) setCandidate(skill);
  };
  const libraryUrl = (name: string, version: number, owner: string | null) => `/api/skills/by-name/${encodeURIComponent(name)}/versions?${userQuery}&sourceOwner=${encodeURIComponent(owner ?? '')}&version=${version}`;
  const chooseLibrary = (name: string, version: number, owner: string | null, pending: boolean) => run(() => showPackage({ kind: 'library', name, version, sourceOwner: owner }, libraryUrl(name, version, owner), pending, true));
  const importFiles = async (input: FileList | null) => {
    if (!input?.length) return;
    const selected = Array.from(input);
    const root = selected[0].webkitRelativePath.split('/')[0];
    if (!root || selected.some(file => !file.webkitRelativePath.startsWith(`${root}/`))
      || !selected.some(file => file.webkitRelativePath === `${root}/SKILL.md`)) throw new Error('请选择根目录包含 SKILL.md 的 Skill 文件夹');
    const form = new FormData();
    form.set('user', user || ''); form.set('kind', 'folder');
    for (const file of selected) { form.append('files', file, file.name); form.append('paths', file.webkitRelativePath); }
    const data = await json('/api/user-evaluators/skill-imports', { method: 'POST', body: form });
    await showPackage({ kind: 'local', name: data.name, importToken: data.importToken, fileCount: data.files.length }, `/api/user-evaluators/skill-imports/${data.importToken}/files?${userQuery}`, true);
  };
  const showSaved = (skill: EvaluatorSkillSelection) => run(async () => {
    setReplaceSkill(null);
    if ('snapshotHash' in skill) {
      if (!evaluatorId) throw new Error('请先保存评估器');
      await showPackage(skill, `/api/user-evaluators/${encodeURIComponent(evaluatorId)}/skills/${encodeURIComponent(skill.name)}/files?${userQuery}`, false);
    } else if (skill.kind === 'local') {
      await showPackage(skill, `/api/user-evaluators/skill-imports/${skill.importToken}/files?${userQuery}`, false);
    } else await showPackage(skill, libraryUrl(skill.name, skill.version, skill.sourceOwner), false);
  });
  const beginLibrary = (skill: EvaluatorSkillSelection | null = null) => { setError(''); setReplaceSkill(skill); setLibrarySession(session => session + 1); setLibraryOpen(true); };
  const beginImport = () => {
    setError(''); setReplaceSkill(null);
    folderInput.current?.click();
  };
  const add = () => {
    if (!candidate) return;
    if (replaceSkill && candidate.name !== replaceSkill.name) { setError('更换版本需保持 Skill 名称一致'); return; }
    const next = value.filter(s => s.name !== replaceSkill?.name);
    if (next.some(s => s.name === candidate.name)) { setError(`Skill 名称重复：${candidate.name}`); return; }
    if (next.length >= 8) { setError('最多添加 8 个 Skill'); return; }
    const index = value.findIndex(s => s.name === replaceSkill?.name);
    if (index < 0) next.push(candidate); else next.splice(index, 0, candidate);
    onChange(next); setOpen(false);
  };
  const replaceOwner = replaceSkill && ('snapshotHash' in replaceSkill ? replaceSkill.source.kind === 'library' ? replaceSkill.source.owner : undefined : replaceSkill.kind === 'library' ? replaceSkill.sourceOwner : undefined);
  return (
    <section className="my-5 space-y-3 rounded-lg border border-border bg-background p-4">
      <div className="flex items-center justify-between gap-3"><strong className="text-sm">Skills（可选）</strong>
        <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="ai-btn-s" disabled={busy}><Plus className="mr-1 inline size-3.5" />添加 Skill</button></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => beginLibrary()}><FolderSearch className="size-4" />从 Skill 库选择</DropdownMenuItem>
          <DropdownMenuItem onSelect={beginImport}><Upload className="size-4" />从电脑中导入文件夹</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
      <p className="text-xs text-foreground-muted">添加的 Skill 都会参与评估，不需要时请移除。</p>
      {!value.length && <p className="text-xs text-foreground-secondary">从 Skill 库选择，或从电脑导入根目录含 SKILL.md 的 Skill 文件夹。</p>}
      {value.map(skill => <div key={skill.name} className="flex flex-wrap items-center gap-3 rounded border border-border p-3 text-xs">
        <span className="mr-auto min-w-0"><strong className="break-all">{skill.name}</strong><span className="ml-2 text-foreground-muted">{sourceLabel(skill)}</span></span>
        {'fileCount' in skill && <span className="text-foreground-muted">{skill.fileCount} 个文件</span>}
        <button type="button" className="ai-btn-s" disabled={busy} onClick={() => void showSaved(skill)}>查看文件</button>
        {('snapshotHash' in skill ? skill.source.kind : skill.kind) === 'library'
          && <button type="button" className="ai-btn-s" disabled={busy} onClick={() => beginLibrary(skill)}>更换版本</button>}
        <button type="button" className="ai-btn-s" disabled={busy} onClick={() => onChange(value.filter(s => s !== skill))}>移除</button>
      </div>)}
      <input ref={node => { folderInput.current = node; node?.setAttribute('webkitdirectory', ''); node?.setAttribute('directory', ''); }} aria-label="导入 Skill 文件夹" className="hidden" type="file" multiple onChange={e => { const f = e.target.files; void run(() => importFiles(f)); e.target.value = ''; }} />
      {error && !open && <p role="alert" className="text-sm text-error">{error}</p>}
      {busy && !open && <p role="status" className="text-xs text-foreground-muted">正在处理 Skill…</p>}
      <SkillManagementPicker key={librarySession} open={libraryOpen} user={user || ''} selecting={busy} purpose="evaluate" onClose={() => setLibraryOpen(false)}
        onlySkillName={replaceSkill?.name} onlySkillOwner={replaceOwner}
        disabledSkillNames={value.filter(skill => skill.name !== replaceSkill?.name).map(skill => skill.name)}
        onSelect={(name, version, owner) => chooseLibrary(name, version, owner ?? null, true)} onPreview={(name, version, owner) => chooseLibrary(name, version, owner, false)} />
      <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
        <DialogContent className="flex max-h-[85vh] w-[calc(100%_-_2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12"><DialogTitle>{candidate ? (replaceSkill ? '确认替换 Skill' : '确认添加 Skill') : '查看文件'}{viewedSkill ? ` · ${viewedSkill.name}` : ''}</DialogTitle><DialogDescription>{viewedSkill && sourceLabel(viewedSkill)} · {files.length} 个文件 · 只读预览{candidate && '；保存评估器后生效。'}{candidate && 'kind' in candidate && candidate.kind === 'local' && '本地导入不自动加入 Skill 库。'}</DialogDescription></DialogHeader>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(140px,24%)_1fr] overflow-hidden">
            <aside aria-label="Skill 文件树" className="max-h-[55vh] min-h-72 overflow-auto border-r border-border bg-background-secondary p-3"><FileTree files={files} selected={preview?.path} busy={busy} onSelect={relative => void run(async () => setPreview(await json(previewUrl(baseUrl, relative))))} /></aside>
            <div className="min-w-0 overflow-auto p-4 text-xs">{preview ? <><div className="mb-3 flex flex-wrap gap-2 text-foreground-muted"><strong className="text-foreground">{preview.path}</strong><span>{preview.size} 字节</span></div>{preview.truncated && <p>预览已截断，运行文件保持完整。</p>}{preview.isText ? <pre className="max-h-[48vh] overflow-auto whitespace-pre-wrap break-all leading-6">{preview.content}</pre> : <p>二进制文件，不提供文本预览。</p>}</> : <p className="text-foreground-muted">{busy ? '正在读取文件…' : '选择文件查看内容'}</p>}</div>
          </div>
          {error && <p role="alert" className="px-5 py-2 text-sm text-error">{error}</p>}
          <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">{returnToLibrary && <button type="button" className="ai-btn-s mr-auto" disabled={busy} onClick={() => { setOpen(false); setLibraryOpen(true); }}>返回 Skill 库</button>}<button type="button" className="ai-btn-s" disabled={busy} onClick={() => setOpen(false)}>关闭</button>{candidate && <button type="button" className="ai-btn-p" disabled={busy} onClick={add}>{replaceSkill ? '替换当前 Skill' : '添加到评估器'}</button>}</div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
