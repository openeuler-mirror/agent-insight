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

import {readCoreEvaluators,saveCoreEvaluators} from '@/lib/storage-core/evaluators';

/** 读取某用户的自建评估器 JSON 数组（不做结构校验） */
export async function readUserCustomEvaluators(user: string): Promise<unknown[]> {
  return readCoreEvaluators();
}

/** 覆盖写入某用户的自建评估器列表 */
export async function writeUserCustomEvaluators(user: string, items: unknown[]): Promise<void> {
  { await saveCoreEvaluators(items); return; }
}
