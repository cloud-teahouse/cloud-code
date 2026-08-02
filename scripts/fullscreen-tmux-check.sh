#!/usr/bin/env bash
# Fullscreen bottom-slot tmux acceptance check (docs/fullscreen-bottom-slot-design.md §8).
# Drives the built CLI inside tmux, sends keys/escape sequences, asserts pane content.
# Usage: scripts/fullscreen-tmux-check.sh  (run from the repo root; requires tmux + built dist)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="cc-fullscreen-$$"
export CLOUD_CODE_HOME="$ROOT/.dev-home"
PASS=0
FAIL=0

say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); say "  ✔ $1"; }
bad() { FAIL=$((FAIL + 1)); say "  ✘ $1"; }
check() { # check <name> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 — 缺少: $3"; fi
}
check_any() { # check_any <name> <haystack> <needle1> <needle2>
  if printf '%s' "$2" | grep -qF -- "$3" || printf '%s' "$2" | grep -qF -- "$4"; then ok "$1"; else bad "$1 — 缺少: $3|$4"; fi
}

cap() { tmux capture-pane -t "$SESSION" -p 2>/dev/null; }
sendl() { tmux send-keys -t "$SESSION" -l -- "$1"; }
submit() { sleep 0.4; tmux send-keys -t "$SESSION" Enter; }
wheel_up() { sendl $'\x1b[<64;50;10M'; sleep 0.3; }
wheel_down() { sendl $'\x1b[<65;50;10M'; sleep 0.3; }

cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null; }
trap cleanup EXIT

command -v tmux >/dev/null || { say "tmux 未安装"; exit 2; }
[ -f "$ROOT/apps/cloud-code/dist/main.mjs" ] || { say "dist 未构建"; exit 2; }

say "== 启动 tmux 会话 =="
tmux new-session -d -s "$SESSION" -x 100 -y 30 -c "$ROOT" \
  "node apps/cloud-code/dist/main.mjs 2>&1; echo EXITED; sleep 5"
sleep 6

say "== 1. 启动布局（欢迎卡顶置，editor+footer 钉底） =="
screen="$(cap)"
check "欢迎盒出现" "$screen" "Cloud"
check "欢迎卡顶置（第 2 行为卡片边框）" "$(printf '%s' "$screen" | sed -n '2p')" "╭"
check_any "footer 在最后一行" "$(printf '%s' "$screen" | tail -1)" "context" "上下文"
check "输入框在底部区域" "$(printf '%s' "$screen" | tail -8)" "❯"

say "== 2. 长 transcript（shell 回显 + 3× /usage） =="
sendl '!echo sticky-probe'
submit
sleep 1.5
for i in 1 2 3; do sendl '/usage'; submit; sleep 1.2; done
screen="$(cap)"
check "/usage 面板进入 transcript" "$screen" "用量"
check "长内容后输入框仍钉底" "$(printf '%s' "$screen" | tail -8)" "❯"

say "== 2b. StickyHeader：上滚置顶 + 点击跳底 =="
wheel_up; wheel_up
check "上滚后顶行出现 sticky header（⏺）" "$(cap | sed -n '1p')" "⏺"
sendl $'\x1b[<0;5;1M'
sleep 1
if cap | sed -n '1p' | grep -q '⏺'; then bad "点击顶行后 header 仍在"; else ok "点击顶行跳回底部（header 消失）"; fi

say "== 3. 滚轮上滚 + 角标 =="
wheel_up; wheel_up; wheel_up
screen="$(cap)"
check "上滚后视口底行出现角标" "$screen" "↓"

say "== 3b. 点击角标跳回底部 =="
badge_row="$(cap | grep -n '↓ [还0-9]' | tail -1 | cut -d: -f1)"
if [ -z "$badge_row" ]; then bad "找不到角标行"; else
  sendl $'\x1b[<0;10;'"${badge_row}"'M'
  sleep 1
  if cap | grep -q '↓ [还0-9]'; then bad "点击角标后仍未回底"; else ok "点击角标跳回底部"; fi
fi

say "== 4. Shift+PgUp/PgDn 翻页 =="
tmux send-keys -t "$SESSION" S-PgUp
sleep 1
screen_up="$(cap)"
tmux send-keys -t "$SESSION" S-PgDn
sleep 1
screen_dn="$(cap)"
if [ "$screen_up" != "$screen_dn" ]; then ok "翻页改变视口内容"; else bad "翻页无视口变化"; fi

say "== 5. 滚轮回底 =="
for i in 1 2 3 4 5 6; do wheel_down; done
screen="$(cap)"
if printf '%s' "$screen" | grep -q '↓ [还0-9]'; then bad "回底后角标仍在"; else ok "回底后角标消失"; fi

say "== 6. 滚动中提交即跳底（设计行为；'滚动中追加视口不动' 由 pi-tui 单测覆盖） =="
wheel_up; wheel_up
before_badge="$(cap)"
check "上滚后角标出现" "$before_badge" "↓"

say "== 7. 提交消息跳回底部 =="
sendl 'hello fullscreen'
submit
sleep 1.5
screen="$(cap)"
if printf '%s' "$screen" | grep -q '↓ [还0-9]'; then bad "提交后角标仍在（未跳底）"; else ok "提交后跳回底部"; fi

say "== 8. help 面板（? 打开，Esc 关闭） =="
help_open=0
for try in 1 2 3; do
  sendl '?'
  submit
  sleep 1.2
  if cap | grep -q 'PgUp'; then help_open=1; break; fi
  tmux send-keys -t "$SESSION" Escape
  sleep 0.5
done
screen="$(cap)"
if [ "$help_open" = "1" ]; then ok "help 面板含滚动键说明"; else bad "help 面板含滚动键说明 — 缺少: PgUp"; fi
tmux send-keys -t "$SESSION" Escape
sleep 1
check "Esc 关闭 help 后输入框恢复" "$(cap | tail -8)" "❯"

say "== 9. resize 无错位 =="
tmux resize-pane -t "$SESSION" -x 80 -y 24
sleep 1.5
tmux resize-pane -t "$SESSION" -x 120 -y 40
sleep 1.5
screen="$(cap)"
check "resize 后输入框仍钉底" "$(printf '%s' "$screen" | tail -8)" "❯"
check_any "resize 后 footer 仍在最后一行" "$(printf '%s' "$screen" | tail -1)" "context" "上下文"

say "== 10. 退出还原终端 =="
# help 面板开关后编辑器里会残留 `?`（设计上放回草稿）；先清行再退出
tmux send-keys -t "$SESSION" C-u
sleep 0.5
tmux send-keys -t "$SESSION" C-d
sleep 1
tmux send-keys -t "$SESSION" C-d
sleep 2
screen="$(cap)"
check "进程退出" "$screen" "EXITED"

say ""
say "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" -eq 0 ]
