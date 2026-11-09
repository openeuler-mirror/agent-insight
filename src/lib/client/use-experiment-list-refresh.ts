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

import { useEffect } from 'react';

const LIST_REFRESH_MS = 5_000;

export function useExperimentListRefresh(
  rows: readonly { status: string }[],
  load: (silent?: boolean) => Promise<void>,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled || !rows.some((row) => row.status === 'running' || row.status === 'draft')) return;
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await load(true);
        if (!cancelled) schedule();
      }, LIST_REFRESH_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rows, load, enabled]);
}
