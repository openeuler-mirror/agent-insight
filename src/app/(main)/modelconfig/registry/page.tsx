'use client';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { ModelConfigManager } from '@/components/config/ModelConfigManager';
import { ModelPricingManager } from '@/components/config/ModelPricingManager';
import { useLocale } from '@/lib/client/locale-context';
import { Term } from '@/components/text/Term';

export default function ModelRegistryPage() {
    const { t } = useLocale();
    return (
        <div style={{ height: '100%', overflowY: 'auto' }}>
            <AppTopBar title={<Term id="model-registry" label={t('nav.modelRegistry')} />} />
            <ModelConfigManager />
            <ModelPricingManager />
        </div>
    );
}
