'use strict'

const preparers = new Map([['swe-bench', require('./benchmarks/swe-bench.cjs').prepareCaseImage]])

async function prepareExecutionImage(task, options) {
  const prepare = preparers.get(task.benchmark.key)
  if (prepare) return prepare(task, options)
  const { docker, signal } = options
  const { image: reference, arch } = task.execution.environment
  let image
  try { image = JSON.parse((await docker(['image', 'inspect', reference], { signal })).stdout)[0] } catch {
    await docker(['pull', '--platform', `linux/${arch}`, reference], { signal })
    image = JSON.parse((await docker(['image', 'inspect', reference], { signal })).stdout)[0]
  }
  return { image }
}

module.exports = { prepareExecutionImage }
