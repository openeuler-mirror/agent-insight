/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
