'use strict'

async function checkEnvironment(context, services) {
  const binding = services.executionBinding(context)
  if (binding?.backendKey === 'xgovernor') return services.checkSandbox(context, binding)
  if (context.platform === 'pi-mcts') return services.checkMcts(context, 'swe-bench')
  return { issues: await services.checkAgent(context), prepare: [] }
}
async function prepareEnvironment(context, services, reportProgress) {
  const binding = services.executionBinding(context)
  if (!binding || binding.backendKey !== 'xgovernor') throw new Error('所选执行方式没有自动准备操作')
  await services.prepareSandbox(context, binding, reportProgress)
}
module.exports = { checkEnvironment, prepareEnvironment }
