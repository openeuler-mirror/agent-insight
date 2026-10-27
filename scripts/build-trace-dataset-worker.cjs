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

const path = require('node:path');
const fs = require('node:fs');
function buildTraceDatasetWorker() {
  const root = path.resolve(__dirname, '..');
  const outfile = path.join(root, 'generated/trace-datasets/worker.cjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/server/trace-datasets/worker.ts')], outfile, bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['@prisma/client'], logLevel: 'silent' });
  return outfile;
}
module.exports = { buildTraceDatasetWorker };
if (require.main === module) console.log(buildTraceDatasetWorker());
