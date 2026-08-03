'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { RasFaultModeTable } from '@/components/agent-ras/RasFaultModeTable';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/lib/client/locale-context';

export default function AgentRasFaultModesPage() {
  const { locale } = useLocale();
  const router = useRouter();

  return (
    <>
      <AppTopBar
        title={locale === 'zh' ? '可靠性故障模式' : 'Reliability Fault Modes'}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => router.push('/agent-ras/trace')}
          >
            <ArrowLeft className="size-3.5" />
            {locale === 'zh' ? '返回可靠性观测' : 'Back to observing'}
          </Button>
        }
      />
      <PageContainer>
        <p className="mb-4 text-sm text-foreground-secondary">
          {locale === 'zh'
            ? '列出当前 Agent RAS runtime 已支持的故障检测与恢复能力。子故障模式名称可本机编辑保存；提示词类恢复措施可点击查看全文。'
            : 'Lists fault detection and recovery capabilities currently supported by the Agent RAS runtime. Sub-mode names can be edited and saved locally; prompt-based recovery actions open a dialog with the full template.'}
        </p>
        <RasFaultModeTable />
      </PageContainer>
    </>
  );
}
