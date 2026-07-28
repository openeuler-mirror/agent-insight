#!/bin/sh
# prisma db push 的安全包装，供 start.sh / develop_start.sh / docker-entrypoint.sh 共用。
#
# 默认**不带** --accept-data-loss：真正会丢数据的 schema 变更必须由人来判断，
# 让 db push 报错退出、把启动拦下来，是现有的护栏，不能拆。
#
# 唯一的例外是**整型列加宽**（Int → BigInt）。Prisma 把任何列类型变更都报成
# "There might be data loss"，但加宽是无损的——Execution 的六个 token 列迁 BigInt 时
# 用真实库副本实测过：行数 1087→1087、tokens 合计 139,733,994 不变、逐行指纹一致、
# 6 个索引都在。这类变更若不放行，升级后重启会直接 exit 1、服务起不来。
#
# 判据从严：必须**每一条**告警都是 Int→BigInt，只要混进任何别的告警就照旧退出。
#
# 另外这里统一用 < /dev/null 跑：db push 在 TTY 下遇到破坏性变更会弹 "reset database?"，
# 回车默认 Yes 会清掉整库（develop_start.sh 里已就此写过警告）。非交互运行下它改为直接
# 报错退出，把这个脚雷拆掉。
set -eu

if output=$(npx prisma db push < /dev/null 2>&1); then
  printf '%s\n' "$output"
  exit 0
fi

warnings=$(printf '%s\n' "$output" | grep -c 'You are about to' || true)
widenings=$(printf '%s\n' "$output" | grep -c 'will be cast from `Int` to `BigInt`' || true)

if [ "$warnings" -gt 0 ] && [ "$warnings" = "$widenings" ]; then
  echo "  [db push] 待应用的变更只有整型加宽 Int→BigInt（$widenings 处），无数据丢失，放行。"
  npx prisma db push --accept-data-loss < /dev/null
  exit 0
fi

printf '%s\n' "$output"
exit 1
