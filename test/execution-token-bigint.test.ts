import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { PrismaClient } from "@prisma/client"
import { executionBigIntToNumber } from "../src/lib/storage/prisma-client"

// 32 位有符号上限。这几列是整个 session 累计求和，长命 session 会突破它。
const INT32_MAX = 2_147_483_647
const OVERFLOW = 3_000_000_000

/**
 * 建一张 Execution 表跑用例。`columnType` 决定 token 列的 SQLite 声明类型：
 * "BIGINT" = 跑过 `prisma db push` 之后的现网形态，"INTEGER" = 迁移前的旧库形态。
 *
 * 这个参数不是摆设：Prisma 的 SQLite 连接器**按库里列的声明类型**决定怎么转换，
 * 光把 schema.prisma 改成 BigInt、不迁移旧库，超限值照样抛 P2023（见最后一个用例）。
 */
async function withDb(
  columnType: "BIGINT" | "INTEGER",
  fn: (client: ReturnType<typeof makeClient>) => Promise<void>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-token-bigint-"))
  const file = path.join(dir, "probe.db")
  const client = makeClient(file)
  try {
    // 只建用得到的列 + 所有带 @default 的列（Prisma 会把它们写进 INSERT，缺了就报
    // "column does not exist"）。将来给 Execution 加带默认值的列时，这里要跟着加。
    await client.$executeRawUnsafe(`
      CREATE TABLE "Execution" (
        "id" TEXT PRIMARY KEY,
        "tokens" ${columnType},
        "inputTokens" ${columnType},
        "cacheReadInputTokens" ${columnType},
        "timestamp" DATETIME NOT NULL,
        "isSkillCorrect" BOOLEAN DEFAULT false,
        "isAnswerCorrect" BOOLEAN DEFAULT false,
        "isSubagent" BOOLEAN NOT NULL DEFAULT false
      )
    `)
    await fn(client)
  } finally {
    await client.$disconnect()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function makeClient(file: string) {
  return new PrismaClient({ datasources: { db: { url: `file:${file}` } } }).$extends(executionBigIntToNumber)
}

const SELECT = { id: true, tokens: true, inputTokens: true, cacheReadInputTokens: true } as const

test("token 列：超过 int32 上限的累计值能写入并读回（原先抛 P2023）", async () => {
  await withDb("BIGINT", async (client) => {
    await client.execution.create({
      data: { id: "overflow", tokens: OVERFLOW, cacheReadInputTokens: OVERFLOW },
      select: SELECT,
    })

    const row = await client.execution.findUniqueOrThrow({ where: { id: "overflow" }, select: SELECT })
    assert.equal(row.tokens, OVERFLOW)
    assert.equal(row.cacheReadInputTokens, OVERFLOW)
    assert.ok(OVERFLOW > INT32_MAX, "用例值必须真的超过 int32 上限，否则测不到东西")
  })
})

test("token 列：读回的是 number，不是 bigint —— 全站 200+ 处按 number 消费", async () => {
  await withDb("BIGINT", async (client) => {
    await client.execution.create({
      data: { id: "typed", tokens: OVERFLOW, inputTokens: 42 },
      select: SELECT,
    })
    const row = await client.execution.findUniqueOrThrow({ where: { id: "typed" }, select: SELECT })

    assert.equal(typeof row.tokens, "number")
    // 小值同样要是 number：Prisma 读 BigInt 列连 42 都返回 bigint。
    assert.equal(typeof row.inputTokens, "number")
    // bigint 会让这两步直接抛 TypeError，它们是 API 响应和大盘聚合的必经路径。
    assert.equal(JSON.stringify({ t: row.tokens }), `{"t":${OVERFLOW}}`)
    assert.equal(row.tokens! + 1, OVERFLOW + 1)
  })
})

test("token 列：null 保持 null，不能变成 0", async () => {
  await withDb("BIGINT", async (client) => {
    await client.execution.create({ data: { id: "empty" }, select: SELECT })
    const row = await client.execution.findUniqueOrThrow({ where: { id: "empty" }, select: SELECT })

    // 转成 0 会把「没采到这项」伪装成「用了 0 token」，指标会被悄悄稀释。
    assert.equal(row.tokens, null)
    assert.equal(row.inputTokens, null)
    assert.equal(row.cacheReadInputTokens, null)
  })
})

test("token 列：一行溢出不再拖垮整条查询", async () => {
  await withDb("BIGINT", async (client) => {
    await client.execution.create({ data: { id: "a-normal", tokens: 1000 }, select: SELECT })
    await client.execution.create({ data: { id: "b-overflow", tokens: OVERFLOW }, select: SELECT })
    await client.execution.create({ data: { id: "c-normal", tokens: 2000 }, select: SELECT })

    // 改之前：只要有一行溢出，这条 findMany 整条抛 P2023，那一批 trace 全部拉不出来。
    const rows = await client.execution.findMany({ select: SELECT, orderBy: { id: "asc" } })
    assert.deepEqual(rows.map((r) => r.tokens), [1000, OVERFLOW, 2000])
  })
})

test("旧库不迁移也不会更坏 —— 未超限的正常值照常读写", async () => {
  await withDb("INTEGER", async (client) => {
    // 现网库在跑 db push 之前列还是 INTEGER。改 schema 不能让这些库当场坏掉：
    // 没超限的值（占绝大多数）必须和改之前一样读写正常，且读回仍是 number。
    await client.execution.create({
      data: { id: "legacy-normal", tokens: 1000, inputTokens: 42, cacheReadInputTokens: null },
      select: SELECT,
    })
    const row = await client.execution.findUniqueOrThrow({ where: { id: "legacy-normal" }, select: SELECT })

    assert.equal(row.tokens, 1000)
    assert.equal(typeof row.tokens, "number")
    assert.equal(row.inputTokens, 42)
    assert.equal(row.cacheReadInputTokens, null)
  })
})

test("旧库不迁移则修复不生效 —— 部署必须跑 prisma db push", async () => {
  await withDb("INTEGER", async (client) => {
    // Prisma 的 SQLite 连接器按**库里列的声明类型**转换，不是按 schema.prisma。
    // 所以只改 schema、不迁移现网库，超限值依旧原样抛 P2023。这条用例把这个部署前提钉死，
    // 免得有人以为改完 schema 就完事了。
    await assert.rejects(
      () => client.execution.create({ data: { id: "legacy", tokens: OVERFLOW }, select: SELECT }),
      (error: unknown) => {
        assert.match(String(error), /does not fit in an INT column/)
        return true
      },
    )
  })
})
