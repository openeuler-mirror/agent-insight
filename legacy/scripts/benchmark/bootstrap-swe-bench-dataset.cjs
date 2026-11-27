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

function describeFailure(detail) {
  if (/哈希.*(不匹配|失败)/.test(detail)) {
    return ['文件哈希校验失败', '请检查文件是否为要求的官方版本，具体查看相关部署指南。']
  }
  if (/本机文件不存在或不是普通文件/.test(detail)) {
    return ['本机来源文件不可用', '请检查 config/benchmark/platform.local.yaml 中 dataset.source 和 loader.sourceArchive 指定的文件，具体查看相关部署指南。']
  }
  if (/curl 执行失败/.test(detail)) {
    const sourceKey = /下载SWE-bench 官方源码/.test(detail)
      ? 'loader.sourceArchive'
      : 'dataset.source'
    const reason = /curl: \(28\)|timed? ?out|timeout/i.test(detail) ? '下载超时' : '下载失败'
    return [reason, `网络受限时，可在 config/benchmark/platform.local.yaml 中设置 benchmarks.swe-bench.${sourceKey} 为内网地址或本机文件路径，具体查看相关部署指南。`]
  }
  if (/缺少 python3-venv|无法创建 Python|loader.python 无法加载|Python 环境安装完成后仍无法加载|需要可执行命令：python3|(?:python3?|python\.exe|pip) 执行失败/.test(detail)) {
    return ['Python 环境准备或加载失败', '请安装所需 Python 依赖，或在 config/benchmark/platform.local.yaml 中用 benchmarks.swe-bench.loader.python 指定已有环境，具体查看相关部署指南。']
  }
  return ['自动准备或数据库导入失败', '请查看日志中的具体错误和相关部署指南。']
}

bootstrapDataset({
  key: 'swe-bench',
  name: 'SWE-bench Verified',
  args: ['scripts/benchmark/ensure-swe-bench-dataset.ts'],
  describeFailure,
})
