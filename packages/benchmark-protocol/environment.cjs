'use strict'

const { digest } = require('./execution.cjs')
const PROTOCOL = 'execution-environment/v1'
const ACTION = 'PREPARE_EXECUTION_ENVIRONMENT'
const TIMEOUT_MS = 45 * 60 * 1000
const key = /^[a-z][a-z0-9-]{0,63}$/
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value)
function invalid() { throw Object.assign(new Error('执行环境请求不合法，请重新选择数据集和执行主机'), { code: 'ENVIRONMENT_CONTEXT_INVALID' }) }
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) invalid()
}
function validateContext(value) {
  fields(value, ['protocol', 'clientId', 'dataset', 'platform', 'agent', 'model', 'agentOptions', 'experiment'])
  if (value.protocol !== PROTOCOL || !text(value.clientId) || !key.test(value.platform) || !text(value.agent, 128)
    || typeof value.model !== 'string' || value.model.length > 512 || /[\x00-\x1f]/.test(value.model)) invalid()
  fields(value.dataset, ['id', 'adapterKey', 'revision', 'caseIds', 'faultTypes'])
  const ds = value.dataset
  if (!text(ds.id) || !key.test(ds.adapterKey) || !text(ds.revision)
    || !Array.isArray(ds.caseIds) || ds.caseIds.length > 500 || ds.caseIds.some(id => typeof id !== 'string' || !id.length || id.length > 65536 || id.includes('\0'))
    || !Array.isArray(ds.faultTypes) || ds.faultTypes.some(id => !text(id, 128))) invalid()
  fields(value.experiment, ['mode', 'timeoutSeconds', 'concurrency'])
  if (!['generate', 'skill-ab', 'trigger'].includes(value.experiment.mode)
    || !Number.isSafeInteger(value.experiment.timeoutSeconds) || value.experiment.timeoutSeconds < 1
    || !Number.isSafeInteger(value.experiment.concurrency) || value.experiment.concurrency < 1) invalid()
  if (value.agentOptions !== undefined && (!value.agentOptions || typeof value.agentOptions !== 'object' || Array.isArray(value.agentOptions))) invalid()
  if (JSON.stringify(value).length > 256 * 1024) invalid()
  return structuredClone(value)
}
function contextDigest(value) { return digest(validateContext(value)) }
function preparationMessage(state, durationHint) {
  if (state === 'checking') return '正在检查运行环境…'
  if (state === 'preparing') return durationHint === 'first_install_minutes'
    ? '正在准备运行环境，首次可能需要几分钟。完成后将自动进入下一步。'
    : durationHint === 'minutes' ? '正在准备运行环境，可能需要几分钟。完成后将自动进入下一步。' : '正在准备运行环境…'
  return ''
}
module.exports = { PROTOCOL, ACTION, TIMEOUT_MS, validateContext, contextDigest, preparationMessage }
