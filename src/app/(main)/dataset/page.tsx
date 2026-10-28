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
