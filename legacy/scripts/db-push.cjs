#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// prisma db push 的安全包装，是所有启动入口的唯一实现：
// db_push.sh（start.sh / develop_start.sh / docker-entrypoint.sh）与
// scripts/start-windows.bat 都调用本脚本，改动只在这里做。
//
// 默认**不带** --accept-data-loss：真正会丢数据的 schema 变更必须由人来判断，
// 让 db push 报错退出、把启动拦下来，是现有的护栏，不能拆。
//
// 仅放行两类已知无损变更：
//   1) 整型列加宽（Int → BigInt）。
//   2) 为 User.externalAccount 增加唯一约束。该可空列由本次 schema 同步新增，旧行均为
//      NULL；若未来存在重复非空值，数据库会让建索引失败，不会删除或改写数据。
// Prisma 把这两类变更都报成 "There might be data loss"。其中 token 列加宽已用真实库
// 副本验证过：行数 1087→1087、tokens 合计 139,733,994 不变、逐行指纹一致、6 个索引都在。
//
// 判据从严：必须**每一条**项目符号告警都命中上述精确白名单，只要混进任何别的告警就照旧退出。
//
// stdin 固定关闭（等价于 shell 的 < /dev/null）：db push 在 TTY 下遇到破坏性变更会弹
// "reset database?"，回车默认 Yes 会清掉整库；非交互运行下它改为直接报错退出。

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const USAGE = 'Usage: node scripts/db-push.cjs [--skip-generate]'
const BIGINT_WIDENING = 'will be cast from `Int` to `BigInt`'
const EXTERNAL_ACCOUNT_UNIQUE = '• A unique constraint covering the columns `[externalAccount]` on the table `User` will be added. If there are existing duplicate values, this will fail.'

// 优先用本地安装的 prisma CLI，省掉 npx 的查找开销；本地缺失时回退到 npx。
// 回退路径走 shell（Windows 上 npx 是 .cmd，不能直接 spawn）；参数只来自白名单，无注入面。
const PRISMA_CLI = (() => {
  try {
    return require.resolve('prisma/build/index.js')
  } catch {
    return null
  }
})()

function runPrisma(args) {
  const result = PRISMA_CLI
    ? spawnSync(process.execPath, [PRISMA_CLI, 'db', 'push', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync(['npx', 'prisma', 'db', 'push', ...args].join(' '), {
        encoding: 'utf8',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
  if (result.error) throw result.error
  return result
}

function main(argv) {
  if (argv.some(arg => arg !== '--skip-generate')) {
    process.stderr.write(`${USAGE}\n`)
    return 1
  }

  // 用户要求撤销旧版派生统计；仅移除该列，其他破坏性 schema 变更仍由下方护栏拦截。
  const removeLegacy = spawnSync(process.execPath, [path.join(__dirname, 'trace-datasets', 'remove-legacy-summary.cjs')], { stdio: 'inherit' })
  if (removeLegacy.error) throw removeLegacy.error
  if (removeLegacy.status !== 0) return removeLegacy.status ?? 1

  const first = runPrisma(argv)
  const output = `${first.stdout || ''}${first.stderr || ''}`
  if (first.status === 0) {
    process.stdout.write(output)
    return 0
  }

  const lines = output.split(/\r?\n/)
  const warnings = lines.filter(line => /^\s*• /.test(line)).length
  const widenings = lines.filter(line => line.includes(BIGINT_WIDENING)).length
  const externalAccountUnique = lines.filter(line => line.trim() === EXTERNAL_ACCOUNT_UNIQUE).length

  if (warnings > 0 && warnings === widenings + externalAccountUnique) {
    process.stdout.write(`  [db push] 待应用的变更仅包含无损白名单项（Int→BigInt: ${widenings}，User.externalAccount 唯一约束: ${externalAccountUnique}），放行。\n`)
    const retry = runPrisma([...argv, '--accept-data-loss'])
    process.stdout.write(`${retry.stdout || ''}${retry.stderr || ''}`)
    return retry.status ?? 1
  }

  process.stdout.write(output)
  return 1
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
