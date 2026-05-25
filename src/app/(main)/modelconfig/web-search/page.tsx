'use client';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { WebSearchConfig } from '@/components/config/WebSearchConfig';
import { useLocale } from '@/lib/client/locale-context';

export default function WebSearchConfigPage() {
    const { t } = useLocale();
    return (
        <>
            <AppTopBar title={t('nav.webSearch')} />
            <WebSearchConfig />
        </>
    );
}
