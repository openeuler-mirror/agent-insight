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

const FAILURES = Object.freeze({
  MCTS_LLM_INSUFFICIENT_BALANCE: '模型服务返回余额或付费额度不足，请检查模型账户或调用渠道的余额后重试',
  MCTS_LLM_OUTPUT_TRUNCATED: '模型输出达到 token 上限，响应或工具调用参数可能被截断；请缩短单次输出或分段写入，并检查文件是否落盘',
})

function errorText(value, depth = 0) {
  if (depth > 5) return ''
  if (typeof value === 'string') return value.slice(0, 16384)
  if (Array.isArray(value)) return value.slice(0, 16).map(item => errorText(item, depth + 1)).join('\n').slice(0, 16384)
  if (!value || typeof value !== 'object') return ''
  return ['message', 'errorMessage', 'error', 'code', 'text', 'content', 'details']
    .map(key => errorText(value[key], depth + 1)).join('\n').slice(0, 16384)
}

function failureCodes(value) {
  const result = []
  const text = errorText(value)
  if (/insufficient[\s_-]+(?:balance|credits?|quota)\b|余额不足|付费额度不足/i.test(text)) result.push('MCTS_LLM_INSUFFICIENT_BALANCE')
  if (/response hit the output token limit|(?:output|max(?:imum)?)[ _-]?tokens?[^\n]{0,50}(?:limit|exceed)|输出.{0,12}(?:token|令牌).{0,12}(?:上限|截断)/i.test(text)
    || value?.stopReason === 'length' || value?.finish_reason === 'length') result.push('MCTS_LLM_OUTPUT_TRUNCATED')
  return result
}

function knownCodes(codes) {
  return Array.isArray(codes) ? [...new Set(codes.filter(code => Object.hasOwn(FAILURES, code)))] : []
}

function summarizeFailures(codes) {
  return Object.keys(FAILURES).filter(code => knownCodes(codes).includes(code)).map(code => FAILURES[code]).join('；')
}

function ledgerFailureCodes(run) {
  const result = knownCodes(run?.failureCodes)
  for (const runtime of Array.isArray(run?.runtimes) ? run.runtimes : []) {
    let pending = knownCodes(runtime?.failureCodes)
    for (const turn of Array.isArray(runtime?.turns) ? runtime.turns : []) {
      if (!turn || typeof turn !== 'object') continue
      const codes = knownCodes(turn.failureCodes)
      if (codes.length) pending = [...new Set([...pending, ...codes])]
      else if (turn.terminal && turn.status === 'success') {
        const tools = Array.isArray(turn.tools) ? turn.tools : []
        if (turn.hasOutput || tools.some(tool => tool?.status === 'succeeded')) pending = pending.filter(code => code !== 'MCTS_LLM_INSUFFICIENT_BALANCE')
        if (tools.some(tool => ['write', 'edit'].includes(tool?.name) && tool.status === 'succeeded')) pending = pending.filter(code => code !== 'MCTS_LLM_OUTPUT_TRUNCATED')
      }
    }
    result.push(...pending)
  }
  return Object.keys(FAILURES).filter(code => result.includes(code))
}

module.exports = { failureCodes, knownCodes, ledgerFailureCodes, summarizeFailures }
