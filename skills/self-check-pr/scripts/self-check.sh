#!/usr/bin/env bash
# 提 PR 前自查：只跑机械可判的部分，判断题留给人和 AI。
# 用法： bash .opencode/skills/self-check-pr/scripts/self-check.sh [base]
#       默认 base=upstream/master
set -uo pipefail
BASE="${1:-upstream/master}"
FAIL=0
note() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
bad()  { printf '  \033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '  \033[32m✓ %s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }

git rev-parse --verify -q "$BASE" >/dev/null 2>&1 || { echo "找不到基线 $BASE，先 git fetch"; exit 2; }
FILES=$(git diff --name-only "$BASE...HEAD")
[ -z "$FILES" ] && { echo "相对 $BASE 没有改动"; exit 0; }

note "1. 改动范围（防夹带别人的 MR）"
echo "  文件数 $(echo "$FILES" | wc -l | tr -d ' ')  |  $(git diff --shortstat "$BASE...HEAD")"
MERGES=$(git log --merges --oneline "$BASE..HEAD" | wc -l | tr -d ' ')
if [ "$MERGES" -gt 0 ]; then
  bad "分支里有 $MERGES 个 merge commit —— 极可能把别人已合/未合的 MR 一起带进来了"
  git log --merges --oneline "$BASE..HEAD" | sed 's/^/     /'
  echo "     用 git log --oneline $BASE..HEAD 逐条确认，只保留自己的 commit（建议从 $BASE 重新切分支 cherry-pick）"
else
  ok "无 merge commit"
fi
BEHIND=$(git rev-list --count "$(git merge-base "$BASE" HEAD)..$BASE")
[ "$BEHIND" -gt 0 ] && warn "落后 $BASE $BEHIND 个 commit，建议先 rebase" || ok "已基于最新 $BASE"

note "2. 文件编码 / BOM / 换行（Windows 编辑器最容易踩）"
ENC_BAD=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in *.png|*.jpg|*.ico|*.zip|*.vsix|*.jar|*.pdf) continue;; esac
  info=$(file -b "$f")
  case "$info" in
    *UTF-16*|*UTF-32*)      bad "$f 是 $info —— npm/tsc 读不了，八成是 PowerShell 重定向写的"; ENC_BAD=1;;
    *"with BOM"*)           bad "$f 带 BOM —— 会污染 diff 首行"; ENC_BAD=1;;
    *CRLF*)                 warn "$f 是 CRLF 换行";;
  esac
done <<< "$FILES"
[ "$ENC_BAD" -eq 0 ] && ok "无 UTF-16 / BOM 文件"
if echo "$FILES" | grep -qx "package-lock.json"; then
  node -e "JSON.parse(require('fs').readFileSync('package-lock.json','utf8'))" 2>/dev/null \
    && ok "package-lock.json 可被 JSON.parse" \
    || bad "package-lock.json 解析失败 —— npm ci 会挂"
fi

note "3. 接入配对点（改了一处、漏了另一处）"
NEWFW="${PR_FRAMEWORK:-}"
if [ -z "$NEWFW" ]; then
  warn "跳过：设 PR_FRAMEWORK=<你的框架名> 再跑可自动比对（如 PR_FRAMEWORK=qoder）"
else
  # 四个已有框架都出现过的文件 = 接入必经点
  MUST=$(for fw in hermes openclaw codeagent opencode; do git grep -il "$fw" "$BASE" -- src test | sed "s|^$BASE:||"; done \
         | sort | uniq -c | awk '$1>=3 {print $2}')
  MISS=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! git grep -qi "$NEWFW" HEAD -- "$f"; then bad "$f 里没有 $NEWFW"; MISS=1; fi
  done <<< "$MUST"
  [ "$MISS" -eq 0 ] && ok "必经接入点都出现了 $NEWFW"
  echo "     注意：data-service.ts 里有【两处】框架清单（SUBAGENT_TREE_FRAMEWORKS 与 computeOwnSkills），出现一次不代表两处都改了"
fi

note "4. 生产构建（必须实际执行）"
BUILD_LOG=$(mktemp "${TMPDIR:-/tmp}/agent-insight-build.XXXXXX")
trap 'rm -f "$BUILD_LOG"' EXIT
if npm run build 2>&1 | tee "$BUILD_LOG"; then
  ok "npm run build 通过"
else
  bad "生产构建失败：npm run build 返回非零退出码"
fi
if grep -Eq 'Turbopack build encountered [0-9]+ warnings|Overly broad patterns' "$BUILD_LOG"; then
  warn "构建产生 Turbopack warning，必须确认是基线已有还是本 PR 新增"
fi

note "5. 测试：和基线比失败集，不是看是否全绿"
echo "  $BASE 上本来就有既存失败，'我这边全绿' 不是有效结论。跑："
cat <<'EOS'
     git stash -u && git checkout -q <base> && npm test 2>&1 | grep -E '^✖ ' | sort -u > /tmp/base.txt
     git checkout -q -  && git stash pop  && npm test 2>&1 | grep -E '^✖ ' | sort -u > /tmp/mine.txt
     comm -13 /tmp/base.txt /tmp/mine.txt      # ← 必须为空：我引入的新失败
EOS

note "6. 破坏验证（本项最容易走过场）"
echo "  把你这次新增的核心逻辑改成恒定返回一个常数，再跑你自己的测试。"
echo "  测试没变红 = 它根本没跑到你的代码，等于没有测试。"

printf '\n'
[ "$FAIL" -eq 0 ] && { printf '\033[32m机械检查通过。判断题部分见 self-check-pr skill 的自审清单。\033[0m\n'; exit 0; }
printf '\033[31m有机械检查未通过，先修上面标 ✗ 的。\033[0m\n'; exit 1
