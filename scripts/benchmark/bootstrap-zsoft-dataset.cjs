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

const { bootstrapDataset } = require('./bootstrap-dataset.cjs')

bootstrapDataset({
  key: 'zsoft-l1',
  name: 'ZSoft L1',
  args: ['scripts/benchmark/ensure-dataset.ts', '--benchmark', 'zsoft-l1'],
  describeFailure: () => [
    '自动准备或数据库导入失败',
    '请检查 config/benchmark/platform.local.yaml 中 benchmarks.zsoft-l1.dataset.source、revision；网络受限时可指定本机官方目录，具体查看 ZSoft 部署指南。',
  ],
})
