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

import fs from 'node:fs'
import path from 'node:path'

export function writeXiaooCredentialBridge(directory: string, llm: Record<string, unknown>, response?: Record<string, unknown>) {
  const file = path.join(directory, 'insight-xiaoo-credentials')
  fs.writeFileSync(file, `#!${process.execPath}\nconst fs=require('node:fs'); let input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{JSON.parse(input); const llm=${JSON.stringify(llm)}; fs.writeSync(3,JSON.stringify(${response ? JSON.stringify(response) : '{schemaVersion:1,llm,credential:process.env[llm.api_key_env]}' }));});\n`, { mode: 0o755 })
  return file
}
