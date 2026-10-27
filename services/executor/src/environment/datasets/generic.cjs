'use strict'

async function checkEnvironment(context, services) {
  const issues = await services.checkAgent(context)
  return { issues, prepare: [] }
}
async function prepareEnvironment() {}
module.exports = { checkEnvironment, prepareEnvironment }
