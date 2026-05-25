'use client';

import AgentDatasetCenter from '@/components/AgentDatasetCenter';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useLocale } from '@/lib/client/locale-context';

export default function DatasetPage() {
  const { t } = useLocale();
  return (
    <>
      <AppTopBar title={t('nav.dataset')} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <AgentDatasetCenter />
      </div>
    </>
  );
}
