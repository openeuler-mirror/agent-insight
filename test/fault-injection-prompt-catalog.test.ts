import assert from 'node:assert/strict'
import type { FaultInjectionRun } from '@prisma/client'
import test from 'node:test'
import { listFaultsViaPython } from '@/lib/fault-injection/engine'
import { createTaskWithRuns } from '@/lib/fault-injection/store'
import { normalizeFault } from '@/lib/fault-injection/types'
import { prisma } from '@/lib/storage/prisma'
import { buildCasesFromCatalog } from '@/server/builtin-example/ensure-reliability-dataset'

test('real catalog prompts survive task creation and match every generated case', async () => {
  const raw = await listFaultsViaPython('opencode')
  const faults = raw.map((item) => normalizeFault(item as Record<string, unknown>))
  const cases = buildCasesFromCatalog(faults)
  assert.ok(cases.length >= faults.length && faults.length > 0)
  const addition = '保留工作区已有的无关文件。'
  const created = await createTaskWithRuns({
    user: 'fi-prompt-catalog-test',
    platform: 'opencode',
    agent: 'build',
    prompt: addition,
    workspace: '/tmp/fi-prompt-catalog-test',
    items: cases.map((item) => ({
      fault: String(item.values?.fault_injection_type),
      submode: item.values?.submode ? String(item.values.submode) : null,
    })),
  })
  try {
    const stored: FaultInjectionRun[] = await prisma.faultInjectionRun.findMany({
      where: { fiTaskId: created.task.id },
    })
    const byRunId = new Map(stored.map((run) => [run.runId, run]))
    assert.equal(stored.length, cases.length)
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index]
      const fault = faults.find((entry) => entry.id === item.values?.fault_injection_type)!
      const submode = fault.submodes?.find((entry) => entry.id === item.values?.submode)
      const instruction = submode
        ? `使用 ${fault.skillName} 技能，执行${submode.name}。`
        : `使用 ${fault.skillName} 技能。`
      assert.equal(item.input, instruction)
      const persisted = byRunId.get(created.runs[index].runId)!
      assert.equal(JSON.parse(persisted.requestJson || '{}').prompt, `${instruction}\n\n${addition}`)
    }
  } finally {
    await prisma.faultInjectionRun.deleteMany({ where: { fiTaskId: created.task.id } })
    await prisma.faultInjectionTask.delete({ where: { id: created.task.id } })
    await prisma.$disconnect()
  }
})
