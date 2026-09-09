'use client';

import { useState } from 'react';
import Link from 'next/link';
import EvaluatorsCenter from '@/components/EvaluatorsCenter';
import EvaluatorDetailModal from '@/components/eval/EvaluatorDetailModal';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { evaluatorCards, evaluatorRuleNames } from './evaluator-catalog';
import { useEvaluationCatalog, type CatalogAsset } from './useEvaluationCatalog';

interface EvaluatorDraft {
  asset?: CatalogAsset;
  name: string;
  type: 'rules' | 'llm';
  prompt: string;
  credentialId: string;
  criticalStop: boolean;
  checkNames: string[];
}

export default function VersionedEvaluatorsCenter() {
  const { catalog, loaded, error, setError, request, refresh } = useEvaluationCatalog();
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<EvaluatorDraft | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const assets = catalog.assets.filter(asset => asset.kind === 'evaluator' && !asset.archived);
  const cards = evaluatorCards(assets, versions);
  const find = (card: EvaluatorCard) => assets.find(asset => asset.id === card.id)!;

  function edit(asset?: CatalogAsset) {
    setError('');
    setEditing({
      asset, name: asset?.name || '', type: asset?.content.type || 'rules',
      prompt: asset?.content.prompt || '根据 Case 的预期答案与实际执行证据逐轮判断是否满足业务要求。',
      credentialId: asset?.content.credentialId || '',
      criticalStop: asset?.content.criticalStop || false,
      checkNames: asset?.content.checkNames || evaluatorRuleNames,
    });
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const saved = await request({
        action: 'asset', kind: 'evaluator',
        assetKey: editing.asset?.assetKey || 'evaluator-' + crypto.randomUUID(),
        name: editing.name.trim(),
        content: {
          type: editing.type, prompt: editing.prompt,
          ...(editing.credentialId ? { credentialId: editing.credentialId } : {}),
          criticalStop: editing.criticalStop,
          ...(editing.type === 'rules' ? { checkNames: editing.checkNames } : {}),
        },
      });
      setVersions(old => ({ ...old, [saved.assetKey]: saved.id }));
      setEditing(null);
      setNotice(`${saved.name} · v${saved.version} 已发布，可在新建实验中选择。`);
      try { await refresh(); }
      catch { setError('评估器已发布，但列表刷新失败，请刷新页面查看，无需再次发布。'); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  function modelName(asset: CatalogAsset) {
    if (asset.content.type !== 'llm') return '规则检查，无需调用模型';
    if (asset.content.credentialId) {
      return '私有连接 · ' + (catalog.credentials.find(item => item.id === asset.content.credentialId)?.name || '连接不可用');
    }
    return '公共连接 · ' + (catalog.executionOptions.publicModel || '未配置');
  }

  function versionControl(card: EvaluatorCard) {
    const asset = find(card);
    return <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2"><span>版本</span>
        <Select aria-label={asset.name + '版本'} value={asset.id}
          onChange={value => setVersions(old => ({ ...old, [asset.assetKey]: value }))}
          options={assets.filter(item => item.assetKey === asset.assetKey).sort((a, b) => b.version - a.version)
            .map(item => ({ value: item.id, label: 'v' + item.version }))} />
      </div>
      <p className="text-foreground-muted">{modelName(asset)}</p>
    </div>;
  }

  return <>
    <EvaluatorsCenter dataSource={{
      cards, loading: !loaded && !error, error, initialTab: 'preset',
      description: '配置如何判断答案和执行过程是否符合要求；修改后发布新版本，历史实验保持原配置。',
      onCreate: () => edit(),
      onRefresh: () => { void refresh().catch(cause => setError(cause.message)); },
      toolbarActions: <button type="button" className="ai-btn-s" onClick={() => { setError(''); setConnectionsOpen(true); }}>模型连接</button>,
      renderCardContent: versionControl,
      renderCardActions: card => <button type="button" className="ai-btn-s" onClick={() => edit(find(card))}>编辑并发布新版本</button>,
      renderDetail: (card, onClose) => {
        const asset = find(card);
        return <EvaluatorDetailModal card={card} onClose={onClose}
          footerNote="在新建实验中选择评估器和版本；可组合多个评估器，对同一份执行证据评分。"
          actions={<button type="button" className="ai-btn-p" onClick={() => { onClose(); edit(asset); }}>编辑并发布新版本</button>}
          detailContent={<div className="space-y-4 text-sm">
            <div className="rounded-lg border border-border bg-background-secondary p-3">版本：v{asset.version}<br />{modelName(asset)}</div>
            <section><h3 className="ai-section-title mb-2">评分点</h3><p className="text-foreground-secondary">{asset.content.type === 'rules'
              ? (asset.content.checkNames || evaluatorRuleNames).join('、')
              : '依据评分 Prompt、每轮预期答案和实际执行证据判断；证据不足时标记为无法判断。'}</p></section>
            <section><h3 className="ai-section-title mb-2">结果展示</h3><p className="text-foreground-secondary">实验详情 → Case 评测详情 → {asset.content.type === 'rules' ? '轨迹评测' : '结果评测'}。包含评分点、分数、证据与建议。</p></section>
            {asset.content.type === 'rules' && <p className="text-foreground-muted">具体要求配置在评测数据集的 Case 中。{asset.content.criticalStop ? '关键规则失败后，跳过后续 LLM 评估。' : '先执行规则检查，再执行 LLM 评估。'}</p>}
          </div>} />;
      },
      footer: notice ? <p role="status" className="mt-4 text-sm text-foreground-secondary">{notice}</p> : null,
    }} />

    <Dialog open={Boolean(editing)} onOpenChange={open => { if (!open && !busy) setEditing(null); }}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{editing?.asset ? '发布评估器新版本' : '新建自定义评估器'}</DialogTitle>
          <DialogDescription>配置评分方式，发布后可在实验中选择。本次修改不会改变历史版本。</DialogDescription></DialogHeader>
        {editing && <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
          {error && <p role="alert" className="text-sm text-error">{error}</p>}
          <label className="block space-y-1 text-sm"><span>名称</span><Input aria-label="评估器名称" required value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
          <div className="space-y-1 text-sm"><div>类型</div><Select className="w-full justify-between" size="md" aria-label="评估器类型" value={editing.type} onChange={type => setEditing({ ...editing, type })}
            options={[{ value: 'rules', label: '规则评估器' }, { value: 'llm', label: 'LLM 评估器' }]} /></div>
          {editing.type === 'rules' ? <>
            <fieldset><legend className="ai-section-title mb-3">检查项目</legend><div className="grid grid-cols-2 gap-3 text-sm">
              {evaluatorRuleNames.map(rule => <label key={rule} className="flex items-center gap-2"><input type="checkbox" checked={editing.checkNames.includes(rule)} onChange={() => setEditing({ ...editing, checkNames: editing.checkNames.includes(rule) ? editing.checkNames.filter(item => item !== rule) : [...editing.checkNames, rule] })} />{rule}</label>)}
            </div><p className="mt-2 text-xs text-foreground-muted">具体要求在 Case 中配置，这里选择要检查哪些项目。</p></fieldset>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.criticalStop} onChange={event => setEditing({ ...editing, criticalStop: event.target.checked })} />关键规则失败后跳过后续 LLM 评估</label>
          </> : <>
            <label className="block space-y-1 text-sm"><span>评分 Prompt</span><Textarea rows={7} aria-label="评分 Prompt" value={editing.prompt} onChange={event => setEditing({ ...editing, prompt: event.target.value })} /></label>
            <div className="space-y-1 text-sm"><div>评分模型连接</div><Select className="w-full justify-between" size="md" aria-label="评分模型连接" value={editing.credentialId} onChange={credentialId => setEditing({ ...editing, credentialId })}
              options={[{ value: '', label: '公共连接 · ' + (catalog.executionOptions.publicModel || '未配置') }, ...catalog.credentials.map(item => ({ value: item.id, label: item.name }))]} /></div>
          </>}
          <DialogFooter><button type="button" className="ai-btn-s" disabled={busy} onClick={() => setEditing(null)}>取消</button>
            <button type="submit" className="ai-btn-p" disabled={busy || !editing.name.trim() || (editing.type === 'rules' ? !editing.checkNames.length : !editing.prompt.trim())}>{busy ? '发布中…' : '发布版本'}</button></DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>

    <Dialog open={connectionsOpen} onOpenChange={open => { if (!busy) setConnectionsOpen(open); }}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>评分模型连接</DialogTitle><DialogDescription>评估器可使用公共模型，也可绑定仅当前账号可用的私有模型连接。</DialogDescription></DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
          <span>公共连接：{catalog.executionOptions.publicModel || '未配置'}</span><Link href="/modelconfig/registry" className="ai-btn-s">配置公共模型</Link>
        </div>
        <section className="space-y-2"><h3 className="ai-section-title">私有模型连接</h3><p className="text-sm text-foreground-secondary">{catalog.credentials.map(item => item.name).join('、') || '暂无私有连接'}</p></section>
        <form className="space-y-3" onSubmit={async event => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          setBusy(true); setError('');
          try {
            await request({ action: 'credential', name: data.get('name'), config: { baseUrl: data.get('url'), model: data.get('model'), apiKey: data.get('key') } });
            form.reset(); await refresh(); setNotice('私有连接已加密保存，可在 LLM 评估器中选择。');
          } catch (cause) { setError((cause as Error).message); }
          finally { setBusy(false); }
        }}>
          {error && <p role="alert" className="text-sm text-error">{error}</p>}
          <label className="block space-y-1 text-sm"><span>连接名称</span><Input name="name" aria-label="连接名称" required /></label>
          <label className="block space-y-1 text-sm"><span>OpenAI 兼容 Base URL</span><Input name="url" type="url" aria-label="模型 Base URL" required /></label>
          <label className="block space-y-1 text-sm"><span>模型 ID</span><Input name="model" aria-label="评分模型 ID" required /></label>
          <label className="block space-y-1 text-sm"><span>API Key</span><Input name="key" type="password" autoComplete="off" aria-label="私有 API Key" required /></label>
          <DialogFooter><button type="button" className="ai-btn-s" disabled={busy} onClick={() => setConnectionsOpen(false)}>关闭</button><button type="submit" className="ai-btn-p" disabled={busy}>{busy ? '保存中…' : '加密保存连接'}</button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
