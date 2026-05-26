'use client';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { WebSearchConfig } from '@/components/config/WebSearchConfig';
import { useLocale } from '@/lib/client/locale-context';
import { Term } from '@/components/text/Term';

export default function WebSearchConfigPage() {
    const { t } = useLocale();
    return (
        <>
            <AppTopBar title={<Term id="web-search" label={t('nav.webSearch')} />} />
            <WebSearchConfig />
        </>
    );
}
