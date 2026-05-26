'use client';

import AgentDatasetCenter from '@/components/AgentDatasetCenter';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { useLocale } from '@/lib/client/locale-context';
import { Term } from '@/components/text/Term';

export default function DatasetPage() {
  const { t } = useLocale();
  return (
    <>
      <AppTopBar title={<Term id="dataset" label={t('nav.dataset')} />} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <AgentDatasetCenter />
      </div>
    </>
  );
}
