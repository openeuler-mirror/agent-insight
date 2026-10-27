'use strict'

async function checkEnvironment(context, services) {
  const issues = await services.checkAgent(context)
  if (!['opencode', 'xiaoo'].includes(context.platform)) {
    issues.push({ code: 'FI_PLATFORM_UNSUPPORTED', message: '所选 Agent 暂不支持故障注入，请选择支持的 Agent。' })
    return { issues, prepare: [] }
  }
  const fi = await services.checkFaultInjection(context)
  issues.push(...fi.issues)
  return { issues, prepare: fi.prepare }
}
async function prepareEnvironment(context, services, reportProgress) {
  await reportProgress({ state: 'preparing' })
  await services.prepareFaultInjection(context)
}
module.exports = { checkEnvironment, prepareEnvironment }
