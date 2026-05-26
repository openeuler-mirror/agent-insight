'use client';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { ModelConfigManager } from '@/components/config/ModelConfigManager';
import { useLocale } from '@/lib/client/locale-context';
import { Term } from '@/components/text/Term';

export default function ModelRegistryPage() {
    const { t } = useLocale();
    return (
        <>
            <AppTopBar title={<Term id="model-registry" label={t('nav.modelRegistry')} />} />
            <ModelConfigManager />
        </>
    );
}
