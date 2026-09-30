'use strict'

const MCTS_SEARCH_OPTIONS_CAPABILITY = 'mcts-search-options/v1'
const MCTS_RUNTIMES = Object.freeze({ 'pi-mcts': 'pi', 'xiao-mcts': 'xiaoo' })
const MCTS_OPTION_FIELDS = Object.freeze([
  { key: 'maxIters', flag: '--max-iters', label: '最大迭代次数', min: 1 },
  { key: 'branching', flag: '--branching', label: '分支数', min: 1 },
  { key: 'maxTurnsInit', flag: '--max-turns-init', label: 'Solver 初始最大轮数', min: 1 },
  { key: 'maxTurnsStep', flag: '--max-turns-step', label: 'Solver 后续最大轮数', min: 1 },
  { key: 'maxTurnsAuthor', flag: '--max-turns-author', label: 'Author 初始最大轮数', min: 1 },
  { key: 'maxTurnsAuthorStep', flag: '--max-turns-author-step', label: 'Author 后续最大轮数', min: 1 },
  { key: 'tokenFuseLimit', flag: '--token-fuse-limit', label: 'Token 熔断阈值', min: 0 },
])
const MCTS_QUICK_OPTIONS = Object.freeze({ maxIters: 1, branching: 1, maxTurnsInit: 20,
  maxTurnsStep: 10, maxTurnsAuthor: 20, maxTurnsAuthorStep: 10, tokenFuseLimit: 0 })

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} 必须是对象`)
  return value
}

function normalizeAgentOptions(value) {
  if (value == null) return undefined
  const options = object(value, 'Agent 参数')
  if (Object.keys(options).some(key => key !== 'mcts')) throw new TypeError('未知的 Agent 参数类型')
  if (!Object.hasOwn(options, 'mcts')) return undefined
  const mcts = object(options.mcts, 'MCTS 参数')
  const fields = new Map(MCTS_OPTION_FIELDS.map(field => [field.key, field]))
  const result = {}
  for (const [key, value] of Object.entries(mcts)) {
    const field = fields.get(key)
    if (!field) throw new TypeError(`未知的 MCTS 参数：${key}`)
    if (!Number.isSafeInteger(value) || value < field.min) {
      throw new TypeError(`${field.label}必须为${field.min === 0 ? '非负' : '正'}安全整数`)
    }
    result[key] = value
  }
  return Object.keys(result).length ? { mcts: result } : undefined
}

function parseMctsOptionInputs(inputs) {
  const values = {}
  for (const field of MCTS_OPTION_FIELDS) {
    const text = String(inputs[field.key] ?? '').trim()
    if (text) values[field.key] = Number(text)
  }
  return normalizeAgentOptions({ mcts: values })
}

function mctsOptionArgs(options) {
  const normalized = normalizeAgentOptions(options)
  return MCTS_OPTION_FIELDS.flatMap(field => Object.hasOwn(normalized?.mcts || {}, field.key)
    ? [field.flag, String(normalized.mcts[field.key])] : [])
}

module.exports = { MCTS_SEARCH_OPTIONS_CAPABILITY, MCTS_RUNTIMES, MCTS_OPTION_FIELDS,
  MCTS_QUICK_OPTIONS, normalizeAgentOptions, parseMctsOptionInputs, mctsOptionArgs }
