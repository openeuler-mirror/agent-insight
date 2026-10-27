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

'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const { normalizeAgentOptions } = require('./index.cjs')

function proposeOptionMigration(savedDefinition, currentDefinition, input) {
  try {
    const saved = normalizeAgentOptions(input)
    if (!saved || !savedDefinition || savedDefinition.runtimeKey !== saved.runtimeKey
      || savedDefinition.definitionDigest !== saved.definitionDigest || currentDefinition.runtimeKey !== saved.runtimeKey
      || currentDefinition.configuration?.version !== 2 || saved.definitionDigest === currentDefinition.definitionDigest) return undefined
    const options = normalizeAgentOptions({ version: 2, runtimeKey: currentDefinition.runtimeKey,
      definitionDigest: currentDefinition.definitionDigest, values: saved.values }, currentDefinition)
    return { options }
  } catch { return undefined }
}

module.exports = { proposeOptionMigration }
