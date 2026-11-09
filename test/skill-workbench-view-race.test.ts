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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

type View = 'detail' | 'evaluation' | 'experiment' | 'optimization';
const session = (id = 'session', source = 'management') => ({
  id, source, activeView: 'optimization' as View, skillName: 'fixture' as string | null, workVersion: 1 as number | null, files: {},
});
type Session = ReturnType<typeof session>;
const ast = ts.createSourceFile('shell.tsx', fs.readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['loadSession', 'selectDraftAsset', 'loadSessions', 'switchView', 'acceptOptimizationSession', 'showSessionAsset', 'openHistorySession', 'changeAssetSkill', 'changeAssetVersion', 'createSession', 'createBlankSession', 'selectManagedSkill', 'openOptimizationRecord', 'uploadSnapshot', 'openActiveSessionView'];
const callbacks = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast)) && node.initializer) {
    const expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    callbacks.set(node.name.getText(ast), expression.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(callbacks.size, names.length);
const compiled = ts.transpileModule([...callbacks].map(([name, code]) => `const ${name} = ${code};`).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(initial: Session | null = session()) {
  const state = { view: 'optimization' as View, active: initial, errors: [] as string[], selected: null as unknown, historyOpen: true, urlChanges: [] as (string | null)[] };
  const requests: Array<{ url: string; options?: { method?: string; body?: string } }> = [];
  const scope = {
    user: 'fixture@example.invalid', requestedSessionId: 'session', active: initial,
    creating: false, selectingSkill: false, uploading: false, pickerPurpose: 'browse', FormData,
    uploadInputRef: { current: null },
    sessionSelectionEpochRef: { current: 0 }, sessionListRequestRef: { current: 0 }, viewSelectionEpochRef: { current: 0 }, viewIntentRef: { current: 'detail' as View },
    activeSessionRef: { current: initial }, selectedAssetRef: { current: null as unknown },
    setLoading: () => {}, setError: (value: string) => { state.errors.push(value); }, setSessions: () => {}, updateSessionUrl: (id: string | null) => { state.urlChanges.push(id); },
    setCreating: () => {}, setSelectingSkill: () => {}, setPickerOpen: () => {}, setUploading: () => {}, setSelectedOptimizationRecordId: () => {},
    setCurrentView: (view: View) => { state.view = view; },
    setActive: (value: Session | null) => { state.active = value; scope.active = value; },
    setSelectedAsset: (value: unknown) => { state.selected = value; }, clearAssetSelection: () => { state.selected = null; },
    updateHistoryOpen: (value: boolean) => { state.historyOpen = value; },
    loadAssetCatalog: async () => {},
    loadOptimizationRecords: async () => {},
    assetCatalog: [{ name: 'fixture', activeVersion: 1, versions: [{ version: 1 }] }], selectedCatalogSkill: { name: 'fixture' },
    selectFormalAsset: async () => {},
    apiFetch: async (url: string, options?: { method?: string; body?: string }): Promise<Response> => {
      requests.push({ url, options });
      if (options?.method === 'PATCH') return Response.json({ session: { ...scope.active, ...JSON.parse(options.body!) } });
      return Response.json(url.includes('/sessions?') ? { sessions: [session()] } : { session: session() });
    },
  };
  const handlers = runInNewContext(`${compiled}\n({loadSession, loadSessions, switchView, acceptOptimizationSession, openHistorySession, changeAssetSkill, changeAssetVersion, createSession, createBlankSession, selectManagedSkill, openOptimizationRecord, uploadSnapshot, openActiveSessionView});`, scope) as {
    loadSession: (id: string, username: string) => Promise<Session>;
    loadSessions: () => Promise<void>; switchView: (view: View) => Promise<void>; acceptOptimizationSession: (value: Session) => void;
    openHistorySession: (id: string) => Promise<void>;
    changeAssetSkill: (name: string) => Promise<void>; changeAssetVersion: (version: number) => Promise<void>;
    createSession: () => Promise<Session | null>; createBlankSession: () => Promise<Session | null>;
    selectManagedSkill: (name: string, version: number) => Promise<void>;
    openOptimizationRecord: (record: { id: string; skillName: string; baseVersion: number }) => Promise<void>;
    uploadSnapshot: (files: File[]) => Promise<void>; openActiveSessionView: (view: View) => Promise<void>;
  };
  return { state, scope, requests, ...handlers };
}

test('版本内容加载迟到时不能覆盖用户刚选择的实验页签', async () => {
  const f = fixture(), asset = deferred<void>(), started = deferred<void>();
  f.scope.selectFormalAsset = async () => { started.resolve(); await asset.promise; };
  const loading = f.loadSessions();
  await started.promise;
  await f.switchView('experiment');
  asset.resolve(); await loading;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.state.active?.activeView, 'experiment');
  assert.equal(f.state.errors.some(Boolean), false);
});

test('草稿会话响应迟到时不能把新选页签重置为详情或旧页签', async () => {
  const f = fixture(null), response = deferred<Response>();
  f.scope.apiFetch = async url => url.includes('/sessions?') ? Response.json({ sessions: [session()] }) : response.promise;
  const loading = f.loadSessions();
  await Promise.resolve(); await Promise.resolve();
  await f.switchView('experiment');
  response.resolve(Response.json({ session: session('session', 'generated') }));
  await loading;
  assert.equal(f.state.view, 'experiment');
  assert.ok(f.state.selected);
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
  await f.loadSessions();
  assert.equal(f.state.view, 'experiment');
});

test('新页签意图产生于会话列表等待期间时也写入随后加载的会话', async () => {
  const f = fixture(null), list = deferred<Response>();
  let calls = 0;
  f.scope.apiFetch = async () => ++calls === 1 ? list.promise : Response.json({ session: session() });
  const loading = f.loadSessions();
  await f.switchView('experiment');
  list.resolve(Response.json({ sessions: [session()] })); await loading;
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
  assert.equal(f.state.view, 'experiment');
});

test('会话加载返回对象携带等待期间产生的新页签意图', async () => {
  const f = fixture(null), response = deferred<Response>();
  f.scope.apiFetch = async () => response.promise;
  const loading = f.loadSession('session', 'owner');
  await f.switchView('experiment');
  response.resolve(Response.json({ session: session() }));
  assert.equal((await loading).activeView, 'experiment');
});

test('连续切页的旧 PATCH 响应不能回写新页签状态', async () => {
  const f = fixture(), old = deferred<Response>();
  f.scope.apiFetch = async (_url, options) => {
    const view = JSON.parse(options!.body!).activeView as View;
    return view === 'evaluation' ? old.promise : Response.json({ session: { ...session(), activeView: view } });
  };
  const first = f.switchView('evaluation');
  await f.switchView('experiment');
  old.resolve(Response.json({ session: { ...session(), activeView: 'evaluation' } })); await first;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.state.active?.activeView, 'experiment');
});

for (const status of [200, 500]) test(`页签保存返回 ${status} 时不能回退后台已推进的版本和文件`, async () => {
  const f = fixture(), saved = deferred<Response>();
  f.scope.apiFetch = async () => saved.promise;
  const click = f.switchView('experiment');
  f.acceptOptimizationSession({ ...session(), workVersion: 2, files: { 'SKILL.md': 'version 2' } });
  saved.resolve(Response.json(status === 200 ? { session: { ...session(), activeView: 'experiment' } } : { error: 'save failed' }, { status }));
  await click;
  assert.equal(f.scope.activeSessionRef.current?.workVersion, 2);
  assert.equal(f.state.active?.workVersion, 2);
  assert.equal((f.state.active?.files as Record<string, string>)['SKILL.md'], 'version 2');
  assert.equal(f.state.active?.activeView, status === 200 ? 'experiment' : 'optimization');
});

test('点击后启动的会话刷新使用立即更新的页签状态', async () => {
  const f = fixture(), saved = deferred<Response>();
  f.scope.apiFetch = async (url, options) => options?.method === 'PATCH' ? saved.promise
    : Response.json(url.includes('/sessions?') ? { sessions: [session()] } : { session: session() });
  const click = f.switchView('experiment');
  await f.loadSessions();
  assert.equal(f.state.view, 'experiment');
  saved.resolve(Response.json({ session: { ...session(), activeView: 'experiment' } })); await click;
});

test('同一次渲染中切回原页签仍会保存最新选择', async () => {
  const f = fixture(), old = deferred<Response>();
  f.scope.setActive = value => { f.state.active = value; };
  f.scope.apiFetch = async (url, options) => {
    f.requests.push({ url, options });
    const view = JSON.parse(options!.body!).activeView as View;
    return view === 'evaluation' ? old.promise : Response.json({ session: { ...session(), activeView: view } });
  };
  const first = f.switchView('evaluation');
  await f.switchView('optimization');
  old.resolve(Response.json({ session: { ...session(), activeView: 'evaluation' } })); await first;
  assert.equal(f.requests.length, 2);
  assert.equal(f.state.active?.activeView, 'optimization');
});

test('优化后台同步更新当前草稿内容并保留已选择的实验页签', async () => {
  const f = fixture(session('session', 'generated'));
  f.scope.user = '';
  f.scope.selectedAssetRef.current = { kind: 'draft', skillName: 'fixture', version: 1 };
  f.state.view = 'experiment';
  f.acceptOptimizationSession({ ...session('session', 'generated'), files: { 'SKILL.md': 'updated' } });
  assert.equal(f.state.view, 'experiment');
  assert.equal((f.state.selected as { files: Record<string, string> }).files['SKILL.md'], 'updated');
});

test('迟到优化快照不能污染新页签状态或让下一次会话刷新回退', async () => {
  const f = fixture();
  await f.switchView('experiment');
  f.acceptOptimizationSession({ ...session(), files: { 'SKILL.md': 'updated' } });
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
  await f.loadSessions();
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.state.active?.activeView, 'experiment');
});

test('先前历史会话的资产加载完成不能覆盖新会话选择的页签', async () => {
  const f = fixture(), asset = deferred<void>(), started = deferred<void>();
  let calls = 0;
  f.scope.selectFormalAsset = async () => { if (++calls === 1) { started.resolve(); await asset.promise; } };
  f.scope.apiFetch = async (url, options) => {
    if (options?.method === 'PATCH') return Response.json({ session: { ...f.scope.activeSessionRef.current, ...JSON.parse(options.body!) } });
    return Response.json({ session: session(url.includes('/second?') ? 'second' : 'first') });
  };
  const first = f.openHistorySession('first'); await started.promise;
  await f.openHistorySession('second'); await f.switchView('experiment');
  asset.resolve(); await first;
  assert.equal(f.state.active?.id, 'second');
  assert.equal(f.state.view, 'experiment');
});

test('历史会话的版本内容加载期间新点击的页签保持生效', async () => {
  const f = fixture(), asset = deferred<void>(), started = deferred<void>();
  f.scope.selectFormalAsset = async () => { started.resolve(); await asset.promise; };
  const opening = f.openHistorySession('session'); await started.promise;
  await f.switchView('experiment');
  asset.resolve(); await opening;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.state.historyOpen, false);
});

test('历史草稿响应迟到不能通过资产选择重置较新的页签点击', async () => {
  const f = fixture(), response = deferred<Response>(), started = deferred<void>();
  f.scope.apiFetch = async (_url, options) => {
    if (options?.method === 'PATCH') return Response.json({ session: { ...f.scope.activeSessionRef.current, ...JSON.parse(options.body!) } });
    started.resolve(); return response.promise;
  };
  const opening = f.openHistorySession('draft'); await started.promise;
  await f.switchView('experiment');
  response.resolve(Response.json({ session: session('draft', 'generated') })); await opening;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.state.active?.id, 'draft');
});

test('没有较新页签点击时打开历史会话正常回到详情并关闭历史浮层', async () => {
  const f = fixture();
  await f.openHistorySession('session');
  assert.equal(f.state.view, 'detail');
  assert.equal(f.state.historyOpen, false);
  assert.equal(f.state.active?.id, 'session');
});

test('没有较新点击时正常恢复会话保存的页签', async () => {
  const f = fixture(null);
  f.state.view = 'detail';
  await f.loadSessions();
  assert.equal(f.state.view, 'optimization');
  assert.equal(f.state.active?.id, 'session');
});

test('转到另一个会话时仍恢复它保存的页签而不继承旧会话点击', async () => {
  const f = fixture();
  await f.switchView('experiment');
  f.scope.requestedSessionId = 'other';
  f.scope.apiFetch = async url => Response.json(url.includes('/sessions?') ? { sessions: [session('other')] }
    : { session: { ...session('other'), activeView: 'evaluation' } });
  await f.loadSessions();
  assert.equal(f.state.view, 'evaluation');
  assert.equal(f.scope.activeSessionRef.current?.id, 'other');
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'evaluation');
});

test('切换会话后旧资产请求不能恢复原会话页签', async () => {
  const f = fixture(), asset = deferred<void>(), started = deferred<void>();
  f.scope.selectFormalAsset = async () => { started.resolve(); await asset.promise; };
  const loading = f.loadSessions(); await started.promise;
  f.scope.sessionSelectionEpochRef.current += 1;
  f.scope.activeSessionRef.current = session('new-session');
  f.state.view = 'detail';
  asset.resolve(); await loading;
  assert.equal(f.state.view, 'detail');
});

for (const kind of ['Skill', '版本'] as const) {
  const changeAsset = (f: ReturnType<typeof fixture>) => kind === 'Skill' ? f.changeAssetSkill('fixture') : f.changeAssetVersion(2);

  test(`${kind} 切换的资产内容迟到不能覆盖更新的实验页签点击`, async () => {
    const f = fixture(), asset = deferred<void>();
    f.scope.selectFormalAsset = async () => { await asset.promise; };
    const changing = changeAsset(f);
    await f.switchView('experiment');
    asset.resolve(); await changing;
    assert.equal(f.state.view, 'experiment');
  });

  test(`${kind} 切换未遇到更新意图时正常展示详情`, async () => {
    const f = fixture();
    await changeAsset(f);
    assert.equal(f.state.view, 'detail');
  });

  for (const epochChanged of [true, false]) test(`${kind} 迟到时不能覆盖已切换会话的页签（epoch ${epochChanged ? '变化' : '不变'}）`, async () => {
    const f = fixture(), asset = deferred<void>();
    f.scope.selectFormalAsset = async () => { await asset.promise; };
    const changing = changeAsset(f);
    if (epochChanged) f.scope.sessionSelectionEpochRef.current += 1;
    f.scope.activeSessionRef.current = session('other');
    f.state.view = 'evaluation';
    asset.resolve(); await changing;
    assert.equal(f.state.view, 'evaluation');
  });
}

for (const kind of ['快捷页签', '优化报告', '选择已有 Skill'] as const) {
  const prepare = (f: ReturnType<typeof fixture>, promise: Promise<void>) => {
    if (kind === '优化报告') f.scope.loadOptimizationRecords = async () => { await promise; };
    else f.scope.selectFormalAsset = async () => { await promise; };
    return kind === '快捷页签' ? f.openActiveSessionView('evaluation')
      : kind === '优化报告' ? f.openOptimizationRecord({ id: 'record', skillName: 'fixture', baseVersion: 1 })
        : f.selectManagedSkill('fixture', 1);
  };

  test(`${kind} 的迟到准备不能覆盖较新的实验页签`, async () => {
    const f = fixture(), ready = deferred<void>();
    const opening = prepare(f, ready.promise);
    await f.switchView('experiment');
    ready.resolve(); await opening;
    assert.equal(f.state.view, 'experiment');
    assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
    await f.loadSessions();
    assert.equal(f.state.view, 'experiment');
  });

  test(`${kind} 无较新点击时保持原来的目标页签`, async () => {
    const f = fixture();
    await prepare(f, Promise.resolve());
    assert.equal(f.state.view, kind === '快捷页签' ? 'evaluation' : kind === '优化报告' ? 'optimization' : 'detail');
  });

  test(`${kind} 的迟到准备不能改变另一个会话的页签`, async () => {
    const f = fixture(), ready = deferred<void>();
    const opening = prepare(f, ready.promise);
    await Promise.resolve();
    f.scope.sessionSelectionEpochRef.current += 1;
    f.scope.activeSessionRef.current = session('other');
    f.scope.setActive(f.scope.activeSessionRef.current);
    f.state.view = 'experiment';
    ready.resolve(); await opening;
    assert.equal(f.state.view, 'experiment');
    assert.equal(f.scope.activeSessionRef.current?.id, 'other');
  });
}

function blankCreationFixture() {
  const f = fixture(), response = deferred<Response>();
  const blank = { ...session('blank'), skillName: null, workVersion: null, activeView: 'detail' as View };
  f.scope.apiFetch = async (url, options) => {
    if (options?.method === 'POST') return response.promise;
    if (options?.method === 'PATCH') return Response.json({ session: { ...f.scope.activeSessionRef.current, ...JSON.parse(options.body!) } });
    return Response.json(url.includes('/sessions?') ? { sessions: [blank] } : { session: blank });
  };
  return { ...f, response };
}

test('新建空会话的 POST 等待期间新点击使旧创建动作放弃接管页面', async () => {
  const f = blankCreationFixture(), selected = { skillName: 'old asset' };
  f.state.selected = selected;
  const creating = f.createBlankSession();
  await f.switchView('experiment');
  f.response.resolve(Response.json({ session: { id: 'blank' } }));
  const created = await creating;
  assert.equal(f.state.view, 'experiment');
  assert.equal(created, null);
  assert.equal(f.scope.activeSessionRef.current?.id, 'session');
  assert.equal(f.state.active?.id, 'session');
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
  assert.equal(f.state.selected, selected);
  assert.deepEqual(f.state.urlChanges, []);
  await f.loadSessions();
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.state.selected, selected);
});

test('通用会话创建仍在 POST 等待后合并新页签并返回当前会话', async () => {
  const f = blankCreationFixture();
  const creating = f.createSession();
  await f.switchView('experiment');
  f.response.resolve(Response.json({ session: { id: 'blank' } }));
  const created = await creating;
  assert.equal(created?.id, 'blank');
  assert.equal(created?.activeView, 'experiment');
  assert.equal(f.scope.activeSessionRef.current?.id, 'blank');
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
});

test('正常新建空会话清除资产并进入详情', async () => {
  const f = blankCreationFixture();
  f.state.selected = { skillName: 'old asset' };
  const creating = f.createBlankSession();
  f.response.resolve(Response.json({ session: { id: 'blank' } }));
  assert.equal((await creating)?.id, 'blank');
  assert.equal(f.state.view, 'detail');
  assert.equal(f.state.selected, null);
  assert.deepEqual(f.state.urlChanges, ['blank']);
});

test('已切到另一会话时迟到的新建空会话不修改选择或地址', async () => {
  const f = blankCreationFixture();
  const creating = f.createBlankSession();
  f.scope.sessionSelectionEpochRef.current += 1;
  f.scope.activeSessionRef.current = session('other');
  f.state.view = 'experiment';
  f.response.resolve(Response.json({ session: { id: 'blank' } }));
  await creating;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.scope.activeSessionRef.current?.id, 'other');
  assert.deepEqual(f.state.urlChanges, []);
});

function uploadFixture() {
  const f = fixture(session('session', 'generated')), response = deferred<Response>();
  f.scope.apiFetch = async (url, options) => {
    if (url.endsWith('/upload')) return response.promise;
    if (options?.method === 'PATCH') return Response.json({ session: { ...f.scope.activeSessionRef.current, ...JSON.parse(options.body!) } });
    return Response.json({ sessions: [session()] });
  };
  const complete = () => response.resolve(Response.json({ session: { ...session('session', 'uploaded'), activeView: 'detail', files: { 'SKILL.md': 'uploaded' } } }));
  const upload = () => f.uploadSnapshot([new File(['uploaded'], 'SKILL.md')]);
  return { ...f, complete, upload };
}

test('上传结果迟到时保留新页签并同步快照内部状态，后续恢复不回退', async () => {
  const f = uploadFixture();
  const uploading = f.upload();
  await f.switchView('experiment');
  f.complete(); await uploading;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
  assert.equal((f.state.selected as { files: Record<string, string> }).files['SKILL.md'], 'uploaded');
  await f.loadSessions();
  assert.equal(f.state.view, 'experiment');
});

test('上传无较新意图时正常更新草稿并显示详情', async () => {
  const f = uploadFixture();
  const uploading = f.upload(); f.complete(); await uploading;
  assert.equal(f.state.view, 'detail');
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'detail');
  assert.equal((f.state.selected as { files: Record<string, string> }).files['SKILL.md'], 'uploaded');
});

test('上传旧会话的结果不能覆盖已选择的新会话或资产', async () => {
  const f = uploadFixture(), selected = { skillName: 'other' };
  const uploading = f.upload();
  f.scope.sessionSelectionEpochRef.current += 1;
  f.scope.activeSessionRef.current = session('other');
  f.scope.setActive(f.scope.activeSessionRef.current);
  f.state.view = 'experiment'; f.state.selected = selected;
  f.complete(); await uploading;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.state.active?.id, 'other');
  assert.equal(f.scope.activeSessionRef.current?.id, 'other');
  assert.equal(f.state.selected, selected);
});

test('正常绑定已有 Skill 可接纳本动作创建的新会话', async () => {
  const f = fixture();
  f.scope.pickerPurpose = 'bind';
  f.scope.apiFetch = async (url, options) => {
    if (options?.method === 'PATCH') return Response.json({ session: { ...f.scope.activeSessionRef.current, ...JSON.parse(options.body!) } });
    return Response.json({ session: { ...session('created'), activeView: 'detail', ...(url.endsWith('/context') ? {} : { skillName: null, workVersion: null }) } });
  };
  await f.selectManagedSkill('fixture', 1);
  assert.equal(f.scope.sessionSelectionEpochRef.current, 1);
  assert.equal(f.scope.activeSessionRef.current?.id, 'created');
  assert.equal(f.state.view, 'detail');
});

test('绑定返回快照合并较新页签，后续恢复不回退', async () => {
  const f = fixture({ ...session(), skillName: null }), response = deferred<Response>(), started = deferred<void>();
  f.scope.pickerPurpose = 'bind';
  f.scope.apiFetch = async (url, options) => {
    if (url.endsWith('/context')) { started.resolve(); return response.promise; }
    if (options?.method === 'PATCH') return Response.json({ session: { ...f.scope.activeSessionRef.current, ...JSON.parse(options.body!) } });
    return Response.json({ sessions: [session()] });
  };
  const selecting = f.selectManagedSkill('fixture', 1); await started.promise;
  await f.switchView('experiment');
  response.resolve(Response.json({ session: { ...session(), activeView: 'detail' } })); await selecting;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
  await f.loadSessions();
  assert.equal(f.state.view, 'experiment');
});

test('优化报告已经进入记录加载后，较新页签仍不被迟到结果覆盖', async () => {
  const f = fixture(), ready = deferred<void>(), started = deferred<void>();
  f.scope.loadOptimizationRecords = async () => { started.resolve(); await ready.promise; };
  const opening = f.openOptimizationRecord({ id: 'record', skillName: 'fixture', baseVersion: 1 });
  await started.promise; await f.switchView('experiment');
  ready.resolve(); await opening;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
});

test('草稿快捷页签准备不能隐式回详情或覆盖较新点击', async () => {
  const f = fixture(session('session', 'generated'));
  const opening = f.openActiveSessionView('evaluation');
  await f.switchView('experiment'); await opening;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.scope.activeSessionRef.current?.activeView, 'experiment');
});

test('旧绑定请求的返回快照不能覆盖新选会话或切回详情', async () => {
  const f = fixture({ ...session(), skillName: null }), response = deferred<Response>();
  f.scope.pickerPurpose = 'bind';
  f.scope.apiFetch = async () => response.promise;
  const binding = f.selectManagedSkill('fixture', 1);
  f.scope.sessionSelectionEpochRef.current += 1;
  f.scope.activeSessionRef.current = session('other');
  f.scope.setActive(f.scope.activeSessionRef.current);
  f.state.view = 'experiment';
  response.resolve(Response.json({ session: session() })); await binding;
  assert.equal(f.state.view, 'experiment');
  assert.equal(f.state.active?.id, 'other');
  assert.equal(f.scope.activeSessionRef.current?.id, 'other');
});
