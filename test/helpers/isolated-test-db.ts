/**
 * 回归测试隔离库 helper（2026-08-19 定稿规则：回归隔离、深度可见）。
 *
 * 规则：普通回归/红灯测试一律把 DATABASE_URL 指向隔离临时库，不写官方共享库
 * （~/.agent-insight/data/witty_insight.db）；只有 kill-bug 深度 E2E、链路回放和
 * 手动测试才写官方库（数据在 3000-3003 任意端口 UI 可见）。
 *
 * 用法：必须在 import 任何 @/lib/storage/*（prisma/data-service 等）模块之前调用——
 * 本仓库无 "type":"module"，tsx 按 CommonJS 顺序执行顶层语句：
 *
 *   import { isolateTestDatabase } from "./helpers/isolated-test-db"
 *   isolateTestDatabase("claude-data-service")
 *   import { saveExecutionRecord } from "@/lib/storage/data-service"
 *
 * 隔离库 schema 来源：复制官方库（schema 现成、含 TraceThread，且不依赖 prisma CLI）。
 * 纪律：只借 schema，不得依赖复制库里的数据内容（一律唯一 ID + 相对断言），
 * 官方库数据变化不影响回归确定性。
 *
 * 切换点：将来若本机 prisma db push 可用（当前 schema engine 空错误不可用，见
 * docs/tasks/bugs/workbuddy-trace-open.md Bug 18），可把 prepareSchema 换成
 * 对全新空库执行 db push，测试即升级为无真实数据的干净库。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const OFFICIAL_DB = path.join(os.homedir(), ".agent-insight", "data", "witty_insight.db")
const DIR_PREFIX = "ai-isolated-"
/** 自动清扫上次运行遗留的隔离目录，防止 %TEMP% 无限堆积（每次 87MB 拷贝）。 */
const STALE_KEEP_MS = 12 * 60 * 60 * 1000

function sweepStaleIsolatedDirs(): void {
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (!entry.startsWith(DIR_PREFIX)) continue
      const dir = path.join(os.tmpdir(), entry)
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > STALE_KEEP_MS) {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      } catch {
        // 删除失败（被占用等）不阻断测试，留给下次清扫
      }
    }
  } catch {
    // 读不到临时目录等极端情况不阻断
  }
}

export function isolateTestDatabase(tag: string): { dir: string; dbFile: string; databaseUrl: string } {
  if (!fs.existsSync(OFFICIAL_DB)) {
    throw new Error(`隔离库来源缺失：${OFFICIAL_DB}。回归测试依赖官方共享库的 schema 拷贝，请先初始化官方库。`)
  }
  sweepStaleIsolatedDirs()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${DIR_PREFIX}${tag}-`))
  const dbFile = path.join(dir, "witty_insight.db")
  fs.copyFileSync(OFFICIAL_DB, dbFile)
  const databaseUrl = `file:${dbFile.replaceAll("\\", "/")}`
  process.env.DATABASE_URL = databaseUrl
  return { dir, dbFile, databaseUrl }
}
