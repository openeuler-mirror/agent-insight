#!/bin/sh
# prisma db push 的安全包装，供 start.sh / develop_start.sh / docker-entrypoint.sh 共用。
#
# 默认**不带** --accept-data-loss：真正会丢数据的 schema 变更必须由人来判断，
# 让 db push 报错退出、把启动拦下来，是现有的护栏，不能拆。
#
# 仅放行两类已知无损变更：
#   1) 整型列加宽（Int → BigInt）。
#   2) 为 User.externalAccount 增加唯一约束。该可空列由本次 schema 同步新增，旧行均为
#      NULL；若未来存在重复非空值，数据库会让建索引失败，不会删除或改写数据。
# Prisma 把这两类变更都报成 "There might be data loss"。其中 token 列加宽已用真实库
# 副本验证过：行数 1087→1087、tokens 合计 139,733,994 不变、逐行指纹一致、6 个索引都在。
#
# 判据从严：必须**每一条**项目符号告警都命中上述精确白名单，只要混进任何别的告警
# 就照旧退出。
#
# 另外这里统一用 < /dev/null 跑：db push 在 TTY 下遇到破坏性变更会弹 "reset database?"，
# 回车默认 Yes 会清掉整库（develop_start.sh 里已就此写过警告）。非交互运行下它改为直接
# 报错退出，把这个脚雷拆掉。
set -eu

if output=$(npx prisma db push < /dev/null 2>&1); then
  printf '%s\n' "$output"
  exit 0
fi

warnings=$(printf '%s\n' "$output" | grep -c '^[[:space:]]*• ' || true)
widenings=$(printf '%s\n' "$output" | grep -c 'will be cast from `Int` to `BigInt`' || true)
external_account_unique=$(printf '%s\n' "$output" | sed 's/^[[:space:]]*//' | grep -Fxc '• A unique constraint covering the columns `[externalAccount]` on the table `User` will be added. If there are existing duplicate values, this will fail.' || true)
allowed=$((widenings + external_account_unique))

if [ "$warnings" -gt 0 ] && [ "$warnings" = "$allowed" ]; then
  echo "  [db push] 待应用的变更仅包含无损白名单项（Int→BigInt: ${widenings}，User.externalAccount 唯一约束: ${external_account_unique}），放行。"
  npx prisma db push --accept-data-loss < /dev/null
  exit 0
fi

printf '%s\n' "$output"
exit 1
