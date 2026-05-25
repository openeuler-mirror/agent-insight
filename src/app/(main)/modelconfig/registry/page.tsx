'use client';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { ModelConfigManager } from '@/components/config/ModelConfigManager';
import { useLocale } from '@/lib/client/locale-context';

export default function ModelRegistryPage() {
    const { t } = useLocale();
    return (
        <>
            <AppTopBar title={t('nav.modelRegistry')} />
            <ModelConfigManager />
        </>
    );
}
