'use client';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { ModelConfigManager } from '@/components/config/ModelConfigManager';

export default function ModelRegistryPage() {
    return (
        <div style={{ height: '100%', overflowY: 'auto' }}>
            <AppTopBar title="模型配置" />
            <ModelConfigManager />

        </div>
    );
}
