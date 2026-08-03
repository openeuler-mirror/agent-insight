'use client';

import { useState, useMemo } from 'react';
import { PageContainer, PageContent } from '@/components/shell/PageContainer';
import { PageHeader } from '@/components/shell/PageHeader';
import { useLocale } from '@/lib/client/locale-context';
import { PlatformSelector } from '@/components/agent-ras/PlatformSelector';
import { FaultCatalog } from '@/components/agent-ras/FaultCatalog';
import { InjectionConfig } from '@/components/agent-ras/InjectionConfig';
import { InjectionHistory } from '@/components/agent-ras/InjectionHistory';
import { FAULT_TYPES, MOCK_INJECTION_HISTORY } from '@/components/agent-ras/mockData';
import type { FaultType, InjectionRecord } from '@/components/agent-ras/mockData';
import { toast } from 'sonner';

export default function AgentRasFaultInjectionPage() {
  const { locale } = useLocale();
  const [platform, setPlatform] = useState('openjiuwen');
  const [selectedFault, setSelectedFault] = useState<FaultType | null>(null);
  const [history, setHistory] = useState<InjectionRecord[]>(MOCK_INJECTION_HISTORY);
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [selectedFaults, setSelectedFaults] = useState<FaultType[]>([]);
  const [target, setTarget] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});

  const filteredFaults = useMemo(
    () => FAULT_TYPES.filter(f => f.platforms.includes(platform)),
    [platform],
  );

  const handlePlatformChange = (p: string) => {
    setPlatform(p);
    setSelectedFault(null);
    setSelectedFaults([]);
    setTarget('');
    setParams({});
  };

  const handleInject = () => {
    if (mode === 'single' && !selectedFault) {
      toast.error(locale === 'zh' ? '请先选择一个故障类型' : 'Please select a fault type');
      return;
    }
    if (mode === 'batch' && !selectedFaults.length) {
      toast.error(locale === 'zh' ? '请至少选择一个故障类型' : 'Please select at least one fault type');
      return;
    }
    if (!target) {
      toast.error(locale === 'zh' ? '请输入目标 Agent ID' : 'Please enter a target Agent ID');
      return;
    }

    const faults = mode === 'single' && selectedFault ? [selectedFault] : selectedFaults;
    const newRecords: InjectionRecord[] = faults.map(f => ({
      id: `inj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      faultType: f.id,
      platform,
      target,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      params: { ...params },
    }));

    setHistory(prev => [...newRecords, ...prev]);
    toast.success(
      locale === 'zh'
        ? `已提交 ${newRecords.length} 条注入任务（Mock）`
        : `${newRecords.length} injection task(s) submitted (Mock)`,
    );

    // Simulate completion
    setTimeout(() => {
      setHistory(prev =>
        prev.map(r =>
          newRecords.some(n => n.id === r.id) ? { ...r, status: 'completed' as const } : r,
        ),
      );
    }, 2000);

    if (mode === 'single') {
      setSelectedFault(null);
    } else {
      setSelectedFaults([]);
    }
    setTarget('');
    setParams({});
  };

  return (
    <PageContainer>
      <PageHeader
        variant="management"
        title={locale === 'zh' ? '故障注入与评测（Mock）' : 'Fault Injection & Eval (Mock)'}
        description={locale === 'zh' ? '用于产品演示的模拟故障注入页面' : 'Mock fault injection for product demonstration'}
      />
      <PageContent>
        <div className="rounded-md border border-border bg-background-secondary px-4 py-3 text-sm text-foreground-secondary">
          {locale === 'zh'
            ? '模拟模式：本页只生成前端演示记录，不会向 Agent 下发真实故障，也不会改变运行中的会话。'
            : 'Mock mode: this page only creates frontend demo records. It does not inject real faults or change running sessions.'}
        </div>
        <PlatformSelector
          selected={platform}
          onSelect={handlePlatformChange}
        />
        <div style={{
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          gap: 16,
          marginTop: 16,
        }}>
          <FaultCatalog
            faults={filteredFaults}
            selectedFault={mode === 'single' ? selectedFault : null}
            selectedFaults={mode === 'batch' ? selectedFaults : []}
            mode={mode}
            onSelectFault={f => {
              if (mode === 'single') {
                setSelectedFault(f);
              } else {
                setSelectedFaults(prev =>
                  prev.some(s => s.id === f.id) ? prev.filter(s => s.id !== f.id) : [...prev, f],
                );
              }
            }}
          />
          <div>
            <InjectionConfig
              mode={mode}
              onModeChange={setMode}
              selectedFault={mode === 'single' ? selectedFault : null}
              selectedFaults={mode === 'batch' ? selectedFaults : []}
              target={target}
              onTargetChange={setTarget}
              params={params}
              onParamsChange={setParams}
              onInject={handleInject}
            />
          </div>
        </div>
        <div style={{ marginTop: 24 }}>
          <InjectionHistory records={history} />
        </div>
      </PageContent>
    </PageContainer>
  );
}
