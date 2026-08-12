'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { RasFaultModeTable } from '@/components/agent-ras/RasFaultModeTable';
import { RasCapabilityConfigPanel } from '@/components/agent-ras/RasCapabilityConfigPanel';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { useLocale } from '@/lib/client/locale-context';
import type { RasCatalogDomain, RasCapabilityCatalog } from '@/lib/ingest/ras/catalog-engine';

type ViewMode = 'catalog' | 'configure';

function parseView(raw: string | null): ViewMode {
  return raw === 'configure' ? 'configure' : 'catalog';
}

function domainChipLabel(domain: RasCatalogDomain, zh: boolean): string {
  const title = (zh ? domain.label?.zh : domain.label?.en) || domain.id;
  return zh ? `${title} → 配置 ${domain.id}` : `${title} → configure`;
}

function FaultModesBody() {
  const { locale } = useLocale();
  const { apiKey } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const zh = locale === 'zh';

  const view = parseView(searchParams.get('view'));
  const focusDetector = searchParams.get('detector');

  const [domains, setDomains] = useState<RasCatalogDomain[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadDomains() {
      try {
        const headers: HeadersInit = {};
        if (apiKey) headers['x-witty-api-key'] = apiKey;
        const res = await apiFetch('/api/agent-ras/catalog', { headers });
        if (!res.ok) return;
        const data = await res.json();
        const catalog = data.catalog as RasCapabilityCatalog;
        if (cancelled) return;
        const sorted = [...(catalog.domains || [])].sort((a, b) => {
          const ao = Number(a.priority ?? a.order ?? 0);
          const bo = Number(b.priority ?? b.order ?? 0);
          return ao - bo;
        });
        setDomains(sorted);
      } catch {
        // chips are optional shortcuts; table/panel fetch their own catalog
      }
    }
    void loadDomains();
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  const setView = useCallback(
    (next: ViewMode, detector?: string | null) => {
      const qs = new URLSearchParams();
      if (next === 'configure') qs.set('view', 'configure');
      if (next === 'configure' && detector) qs.set('detector', detector);
      const suffix = qs.toString();
      router.replace(suffix ? `/agent-ras/fault-modes?${suffix}` : '/agent-ras/fault-modes');
    },
    [router],
  );

  const intro = useMemo(() => {
    if (view === 'configure') {
      return zh
        ? '按平台维护 Agent RAS 期望配置（对齐 runtime AgentRASConfig）。可选择是否同步到 OpenCode 客户端；其他平台可导出 YAML/JSON 后人工落盘。'
        : 'Maintain per-platform Agent RAS desired config (aligned with runtime AgentRASConfig). Optionally sync to the OpenCode client; other platforms can export YAML/JSON for manual apply.';
    }
    return zh
      ? '列出当前 Agent RAS runtime 已支持的故障检测与恢复能力。子故障模式名称可本机编辑保存；提示词类恢复措施可点击查看全文。启停与阈值请切换到「平台配置」。'
      : 'Lists fault detection and recovery capabilities currently supported by the Agent RAS runtime. Sub-mode names can be edited locally; prompt-based recovery opens a dialog. Use Platform config for enablement and thresholds.';
  }, [view, zh]);

  return (
    <>
      <AppTopBar
        title={zh ? '可靠性能力' : 'Reliability Capabilities'}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => router.push('/agent-ras/trace')}
          >
            <ArrowLeft className="size-3.5" />
            {zh ? '返回可靠性观测' : 'Back to observing'}
          </Button>
        }
      />
      <PageContainer>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <p className="text-sm text-foreground-secondary max-w-3xl">{intro}</p>
          <div
            className="inline-flex shrink-0 rounded-[var(--radius-md)] border border-border p-0.5 bg-background-secondary"
            role="tablist"
            aria-label={zh ? '视图切换' : 'View switch'}
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === 'catalog'}
              onClick={() => setView('catalog')}
              className={`px-3 py-1.5 text-xs font-medium rounded-[calc(var(--radius-md)-2px)] transition-colors ${
                view === 'catalog'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
            >
              {zh ? '能力目录' : 'Catalog'}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'configure'}
              onClick={() => setView('configure', focusDetector)}
              className={`px-3 py-1.5 text-xs font-medium rounded-[calc(var(--radius-md)-2px)] transition-colors ${
                view === 'configure'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
            >
              {zh ? '平台配置' : 'Configure'}
            </button>
          </div>
        </div>

        {view === 'catalog' ? (
          <div className="flex flex-col gap-3">
            {domains.length > 0 && (
              <div className="flex flex-wrap gap-2 text-xs">
                {domains.map((domain) => (
                  <button
                    key={domain.id}
                    type="button"
                    className="rounded-full border border-border px-2.5 py-1 text-foreground-secondary hover:border-primary hover:text-primary transition-colors"
                    onClick={() => setView('configure', domain.id)}
                  >
                    {domainChipLabel(domain, zh)}
                  </button>
                ))}
              </div>
            )}
            <RasFaultModeTable />
          </div>
        ) : (
          <RasCapabilityConfigPanel focusDetector={focusDetector} />
        )}
      </PageContainer>
    </>
  );
}

export default function AgentRasFaultModesPage() {
  return (
    <Suspense fallback={null}>
      <FaultModesBody />
    </Suspense>
  );
}
