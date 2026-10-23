'use strict'

async function checkEnvironment(context, services) {
  if (context.platform === 'pi-mcts') return services.checkMcts(context, 'zsoft-l1')
  const issues = await services.checkAgent(context)
  issues.push(...await services.checkZsoftSource(context))
  return { issues, prepare: [] }
}
async function prepareEnvironment() {}
module.exports = { checkEnvironment, prepareEnvironment }
