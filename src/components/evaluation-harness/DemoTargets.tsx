'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import { AgentCardFrame, AgentDirectoryLayout, AgentDirectoryPanel, agentDirectoryGridStyle, Btn, FilterSelect, Tag } from '@/components/agents/AgentDirectory';
import { assetsFor } from './AssetVersionPicker';
import { useEvaluationCatalog, type CatalogAsset } from './useEvaluationCatalog';

function DemoTargetsContent({ defaultKind = 'agent' }: { defaultKind?: 'agent' | 'skill' }) {
    const { catalog, loaded, error, setError, request, refresh } = useEvaluationCatalog();
    const search = useSearchParams();
    const queryId = search?.get('targetId') || '';
    const [kind, setKind] = useState<'agent' | 'skill'>(defaultKind);
    const [objectKey, setObjectKey] = useState('');
    const [selected, setSelected] = useState('');
    const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState<any>(null);
    const appliedLink = useRef('');
    const detailRef = useRef<HTMLElement>(null);
    const assets = catalog.assets;
    const target = assets.find((asset) => asset.id === selected);
    const versions = assetsFor(assets, kind).filter((asset) => !asset.archived || asset.id === queryId);
    const objects = versions.filter((asset, index, all) => all.findIndex((candidate) => candidate.assetKey === asset.assetKey) === index);
    const visibleObjects = objects.filter((asset) => !objectKey || asset.assetKey === objectKey);

    useEffect(() => {
        const linkedTarget = assets.find((asset) => asset.id === queryId && asset.kind === 'target');
        if (!linkedTarget || appliedLink.current === queryId) return;
        appliedLink.current = queryId;
        setKind(linkedTarget.content.type === 'skill' ? 'skill' : 'agent');
        setObjectKey(linkedTarget.assetKey);
        setSelected(linkedTarget.id);
        setSelectedVersions((current) => ({ ...current, [linkedTarget.assetKey]: linkedTarget.id }));
    }, [queryId, assets]);

    useEffect(() => {
        if (selected) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [selected]);

    async function analyze(asset: CatalogAsset) {
        setSelected(asset.id);
        setBusy(true);
        setError('');
        setReport(null);
        try {
            const saved = await request({ action: 'static', targetId: asset.id });
            setReport({ targetId: asset.id, data: JSON.parse(saved.reportJson) });
        } catch (failure) {
            setError((failure as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function synchronize() {
        setBusy(true);
        setError('');
        try {
            await request({ action: 'bootstrap' });
            await refresh();
        } catch (failure) {
            setError((failure as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return <AgentDirectoryLayout title="评测对象">
        <AgentDirectoryPanel>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>评测对象筛选</div>
                    <div style={{ fontSize: 11.5, color: 'var(--foreground-secondary)' }}>已登记 {objects.length} 个 {kind === 'agent' ? 'Agent' : 'Skill'}，选择版本查看定义与执行地址。</div>
                </div>
                <Btn variant="outline" disabled={busy} onClick={synchronize}>{busy ? '处理中…' : '同步对象目录'}</Btn>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 18, padding: 14, borderRadius: 12, background: 'var(--background-secondary)', border: '1px solid rgba(127,127,127,0.08)' }}>
                <FilterSelect label="对象类型" value={kind} onChange={(value) => { setKind(value as 'agent' | 'skill'); setObjectKey(''); setSelected(''); setReport(null); }} options={[{ value: 'agent', label: 'Agent' }, { value: 'skill', label: 'Skill' }]} minWidth={180} />
                <FilterSelect label="对象" value={objectKey} onChange={(value) => { setObjectKey(value); setSelected(''); setReport(null); }} options={[{ value: '', label: '全部对象' }, ...objects.map((asset) => ({ value: asset.assetKey, label: asset.name }))]} minWidth={180} />
            </div>
            {error && <p role="alert" style={{ marginTop: 16, fontSize: 12, color: 'var(--error)' }}>{error}</p>}
            {!loaded ? <p style={{ marginTop: 16, color: 'var(--foreground-muted)', fontSize: 12 }}>加载中…</p> : !visibleObjects.length ? <div style={{ marginTop: 16, border: '1px dashed var(--border)', borderRadius: 10, padding: 24, textAlign: 'center', color: 'var(--foreground-secondary)', fontSize: 12.5, background: 'var(--background-secondary)' }}>暂无符合条件的对象，可同步外部目录后再选择。</div> : <div style={{ ...agentDirectoryGridStyle, marginTop: 16 }}>
                {visibleObjects.map((object) => {
                    const objectVersions = versions.filter((asset) => asset.assetKey === object.assetKey);
                    const asset = objectVersions.find((candidate) => candidate.id === selectedVersions[object.assetKey]) || object;
                    return <AgentCardFrame key={object.assetKey}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>{asset.name}</span>
                            <Tag variant="outline" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>{kind === 'agent' ? 'Agent' : 'Skill'}</Tag>
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginTop: 4, overflowWrap: 'anywhere' }}>{asset.content.externalId}</div>
                        <div style={{ marginTop: 12 }}><FilterSelect label="版本" value={asset.id} onChange={(value) => { setSelectedVersions((current) => ({ ...current, [asset.assetKey]: value })); if (target?.assetKey === asset.assetKey) setSelected(value); setReport(null); }} options={objectVersions.map((version) => ({ value: version.id, label: `v${version.version}${version.archived ? '（执行端已不再提供）' : ''}` }))} minWidth={0} /></div>
                        <dl style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 11, display: 'grid', gap: 8 }}>
                            <div><dt style={{ color: 'var(--foreground-muted)' }}>外部版本</dt><dd style={{ color: 'var(--foreground)', marginTop: 4 }}>{asset.content.externalVersion || `v${asset.version}`}</dd></div>
                            <div><dt style={{ color: 'var(--foreground-muted)' }}>执行地址</dt><dd style={{ color: 'var(--foreground)', marginTop: 4, overflowWrap: 'anywhere' }}>{asset.content.endpoint || catalog.executionOptions.demoEndpoint || '未配置'}</dd></div>
                        </dl>
                        <div style={{ flex: 1, minHeight: 12 }} />
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                            <Btn variant="outline" size="sm" style={{ flex: 1 }} onClick={() => setSelected(asset.id)}>查看定义</Btn>
                            <Btn variant="secondary" size="sm" style={{ flex: 1 }} disabled={busy || asset.archived} onClick={() => analyze(asset)}>检查 Skill 定义</Btn>
                        </div>
                    </AgentCardFrame>;
                })}
            </div>}
        </AgentDirectoryPanel>
        {target && <section ref={detailRef} aria-label="评测对象定义" style={{ marginTop: 16 }}>
            <AgentDirectoryPanel>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>{target.name} · v{target.version}</h2>
                    <Btn variant="outline" size="sm" aria-label="关闭定义" onClick={() => setSelected('')}><X size={14} /></Btn>
                </div>
                <p style={{ margin: '8px 0 16px', fontSize: 11.5, color: 'var(--foreground-muted)' }}>对象由外部 Agent 平台维护；这里读取版本并保存实验快照。</p>
                <div style={{ display: 'grid', gap: 14, fontSize: 12, color: 'var(--foreground-secondary)' }}>
                    <div><h3 style={{ fontWeight: 600, color: 'var(--foreground)', marginBottom: 6 }}>Prompt</h3><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' }}>{target.content.prompt || '未提供 Prompt'}</pre></div>
                    {target.content.skills.map((skill: any) => <div key={skill.name} style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}><h3 style={{ fontWeight: 600, color: 'var(--foreground)' }}>Skill · {skill.name}</h3><p style={{ marginTop: 6 }}>{skill.description}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', marginTop: 6 }}>{skill.prompt}</pre></div>)}
                    <p>工具：{target.content.tools.map((tool: any) => tool.name).join('、') || '未提供'}</p>
                    {(target.content.inputSchema || target.content.outputSchema) && <details><summary style={{ cursor: 'pointer' }}>输入 / 输出字段定义</summary><pre style={{ overflow: 'auto', fontSize: 11, paddingTop: 8 }}>{JSON.stringify({ input: target.content.inputSchema, output: target.content.outputSchema }, null, 2)}</pre></details>}
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 14 }}><Btn variant="outline" disabled={busy || target.archived} onClick={() => analyze(target)}>{busy ? '检查中…' : '检查 Skill 定义'}</Btn><span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>检查描述重叠、职责冲突等风险，无需运行实验。</span></div>
                    {report?.targetId === target.id && <section aria-label="Skill 定义检查结果" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                        <h3 style={{ fontWeight: 600, color: 'var(--foreground)' }}>Skill 定义检查结果 · {report.data.findings.length} 项风险</h3>
                        <p style={{ marginTop: 6, fontSize: 11, color: 'var(--foreground-muted)' }}>{report.data.note}</p>
                        {!report.data.findings.length && <p style={{ marginTop: 10 }}>当前规则未发现明显风险，可继续执行 Case 验证实际行为。</p>}
                        {report.data.findings.map((finding: any, index: number) => <div key={index} style={{ marginTop: 10, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}><strong>{finding.type}</strong><p style={{ marginTop: 6 }}>{finding.skills.join('、')}</p><p style={{ marginTop: 6 }}>{finding.reason}</p></div>)}
                    </section>}
                </div>
            </AgentDirectoryPanel>
        </section>}
    </AgentDirectoryLayout>;
}

export default function DemoTargets(props: { defaultKind?: 'agent' | 'skill' }) {
    return <Suspense fallback={<p>正在加载…</p>}><DemoTargetsContent {...props} /></Suspense>;
}
