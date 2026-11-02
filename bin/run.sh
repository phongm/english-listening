#!/bin/bash
# 统一入口。被 .app 双击调用，也可以直接敲。
# 机器相关值放在 ~/English/config，不进仓库。

set -uo pipefail

CONF="$HOME/English/config"
[ -f "$CONF" ] && . "$CONF"

REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
OUT_ROOT="${OUT_ROOT:-$HOME/English}"
PROXY_URL="${PROXY_URL:-http://127.0.0.1:7890}"

TING_APP="${TING_APP:-/Applications/每日英语听力.app}"
TING_CDP_PORT="${TING_CDP_PORT:-9333}"
TING_WEB_PORT="${TING_WEB_PORT:-8787}"
APPS_DIR="${APPS_DIR:-$HOME/Applications}"
SYNC_APP="$APPS_DIR/每日英语听力·同步字幕.app"
SYNC_PID="$OUT_ROOT/run/ting-sync.pid"
SYNC_LOG="$OUT_ROOT/logs/ting-sync.log"

find_node() {
  for c in "${NODE_BIN:-}" "$(command -v node 2>/dev/null)" \
           /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

NODE="$(find_node)" || {
  echo "找不到 node。先双击运行 install.command，或手动执行: brew install node" >&2
  exit 127
}

mkdir -p "$OUT_ROOT/voa"

need_url() {
  local u="$1"
  case "$u" in
    https://*) return 0 ;;
    *) echo "剪贴板里不是一条 https 课文链接，当前内容：$(printf '%s' "$u" | head -c 80)" >&2; return 1 ;;
  esac
}

ting_cdp_up() {
  curl -s --max-time 1 "http://127.0.0.1:$TING_CDP_PORT/json/version" 2>/dev/null | grep -q "ting_en"
}

ting_app_running() {
  pgrep -x "每日英语听力" >/dev/null 2>&1
}

ting_web_up() {
  curl -s --max-time 1 "http://127.0.0.1:$TING_WEB_PORT/state" >/dev/null 2>&1
}

ting_open_app() {
  open -na "$TING_APP" --args --remote-debugging-port="$TING_CDP_PORT" --remote-allow-origins='*'
}

ting_wait_cdp() {
  local i=0
  while [ "$i" -lt 60 ]; do
    ting_cdp_up && return 0
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

ting_start_service() {
  mkdir -p "$OUT_ROOT/run" "$OUT_ROOT/logs"
  if ting_web_up; then
    echo "ok 同步服务已在运行: http://127.0.0.1:$TING_WEB_PORT/"
    return 0
  fi
  if [ -f "$SYNC_PID" ]; then
    old_pid="$(cat "$SYNC_PID" 2>/dev/null)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null \
       && ps -p "$old_pid" -o command= 2>/dev/null | grep -q "ting-sync.mjs"; then
      kill "$old_pid" 2>/dev/null
    fi
    rm -f "$SYNC_PID"
  fi
  TING_CDP_PORT="$TING_CDP_PORT" TING_WEB_PORT="$TING_WEB_PORT" \
    nohup "$NODE" "$REPO/bin/ting-sync.mjs" >>"$SYNC_LOG" 2>&1 &
  echo $! >"$SYNC_PID"
  local i=0
  while [ "$i" -lt 32 ]; do
    if ting_web_up; then
      echo "ok 同步服务: http://127.0.0.1:$TING_WEB_PORT/（日志 $SYNC_LOG）"
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done
  echo "!! 同步服务没起来，日志末尾：" >&2
  tail -n 20 "$SYNC_LOG" >&2
  return 1
}

ting_open_overlay() {
  if [ -d "$SYNC_APP" ]; then
    # 已在运行时，新实例会通知旧实例把隐藏的窗口显示出来；未运行时则正常启动。
    open -na "$SYNC_APP" --args --url "http://127.0.0.1:$TING_WEB_PORT/"
    echo "ok 字幕条已打开（若之前点过 X，会重新显示）"
  else
    echo "-- 没找到 $SYNC_APP，先用浏览器打开"
    open "http://127.0.0.1:$TING_WEB_PORT/bar"
  fi
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  tr-clipboard)
    text="$(pbpaste)"
    [ -z "${text// /}" ] && { echo "剪贴板是空的。先在 App 里选中原文行并按 ⌘C。" >&2; exit 1; }
    printf '%s' "$text" | "$NODE" "$REPO/bin/tr.mjs"
    ;;

  tr)
    [ $# -eq 0 ] && { echo "用法: run.sh tr <要翻译的文本>" >&2; exit 1; }
    "$NODE" "$REPO/bin/tr.mjs" "$*"
    ;;

  grab)
    url="${1:-}"
    need_url "$url" || exit 1
    "$NODE" "$REPO/bin/voa-grab.mjs" "$url" || exit 1
    ;;

  grab-clipboard)
    url="$(pbpaste | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    need_url "$url" || exit 1
    slug="$(printf '%s' "$url" | sed -E 's#.*/([0-9]+)\.html.*#\1#')"
    [ -z "$slug" ] && slug="lesson"
    "$NODE" "$REPO/bin/voa-grab.mjs" "$url" || exit 1
    txt="$OUT_ROOT/voa/$slug.txt"
    [ -f "$txt" ] || { echo "没找到生成的 $txt" >&2; exit 1; }
    title="$(basename "$txt" .txt)"
    "$NODE" "$REPO/bin/bilingual-subtitle.mjs" "$txt" --md --title "$title" || exit 1
    md="$OUT_ROOT/voa/$slug.对照.md"
    [ -f "$md" ] && open "$md"
    echo "$md"
    ;;

  batch)
    f="${1:-}"
    [ -f "$f" ] || { echo "文件不存在: $f" >&2; exit 1; }
    "$NODE" "$REPO/bin/bilingual-subtitle.mjs" "$f" || exit 1
    ;;

  selftest)
    echo "node: $NODE"
    echo "repo: $REPO"
    out="$("$NODE" "$REPO/bin/tr.mjs" "The train to Cambridge leaves at seven.")"
    echo "翻译自检: $out"
    case "$out" in
      *火车*) echo "SELFTEST_OK" ;;
      *) echo "SELFTEST_FAILED：没拿到中文，检查网络或代理 $PROXY_URL" >&2; exit 1 ;;
    esac
    ;;

  ting-sync-state)
    if ting_cdp_up; then echo "debug-ok"
    elif ting_app_running; then echo "running-no-debug"
    else echo "not-running"
    fi
    ;;

  ting-sync-start)
    if ting_app_running && ! ting_cdp_up; then
      echo "每日英语听力正在运行，但没开同步端口；请先退出 App，或用 ting-sync-launch 重启。" >&2
      exit 2
    fi
    if ! ting_app_running; then
      echo "启动每日英语听力（调试端口 $TING_CDP_PORT）…"
      ting_open_app
      if ! ting_wait_cdp; then
        echo "!! 等不到调试端口。确认 $TING_APP 存在，或 $TING_CDP_PORT 被别的程序占用。" >&2
        exit 1
      fi
    fi
    ting_start_service || exit 1
    ting_open_overlay
    echo "ok 字幕条已打开；在 App 里播放即可"
    ;;

  ting-sync-launch)
    if ting_app_running; then
      echo "退出每日英语听力…"
      osascript -e 'tell application "每日英语听力" to quit' >/dev/null 2>&1
      wait_i=0
      while [ "$wait_i" -lt 48 ] && ting_app_running; do
        sleep 0.25
        wait_i=$((wait_i + 1))
      done
      if ting_app_running; then
        echo "!! App 没有退出，请手动退出后再双击同步图标（这里不强行结束进程）。" >&2
        exit 1
      fi
    fi
    echo "重新启动每日英语听力（调试端口 $TING_CDP_PORT）…"
    ting_open_app
    if ! ting_wait_cdp; then
      echo "!! 等不到调试端口。若 App 刚更新过，见 README 的故障排查。" >&2
      exit 1
    fi
    ting_start_service || exit 1
    ting_open_overlay
    echo "ok 字幕条已打开；在 App 里播放即可"
    ;;

  ting-sync-stop)
    if [ -f "$SYNC_PID" ]; then
      old_pid="$(cat "$SYNC_PID" 2>/dev/null)"
      if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null \
         && ps -p "$old_pid" -o command= 2>/dev/null | grep -q "ting-sync.mjs"; then
        kill "$old_pid" && echo "ok 已停同步服务"
      fi
      rm -f "$SYNC_PID"
    else
      echo "-- 没有同步服务的 pid 记录"
    fi
    pkill -f "每日英语听力·同步字幕.app/Contents/MacOS/" >/dev/null 2>&1 && echo "ok 已关闭字幕条"
    echo "-- 每日英语听力本身不受影响，可继续播放"
    ;;

  ting-sync-follow)
    exec "$NODE" "$REPO/bin/ting-sync.mjs" --follow
    ;;

  ting-sync-probe)
    exec "$NODE" "$REPO/bin/ting-sync.mjs" --probe
    ;;

  ting-sync-selftest)
    exec "$NODE" "$REPO/bin/ting-sync.mjs" --selftest
    ;;

  help|*)
    cat <<'EOF'
用法: run.sh <命令>
  tr-clipboard      翻译剪贴板里的原文（配合 .app 双击）
  tr <文本>         直接翻译
  grab <课文URL>    抓课文 + 下音频
  grab-clipboard    用剪贴板里的课文 URL 抓课文并生成双语对照，然后打开
  batch <文件>      把 .lrc/.srt/.txt 批量出双语对照
  selftest          自检 node、路径与翻译通道

随播字幕（每日英语听力）:
  ting-sync-start    未运行时带调试端口启动 App，并起服务、开置顶字幕条（被 X 隐藏时会重新显示）
  ting-sync-launch   先退出 App 再带调试端口重启（App 已在普通方式运行）
  ting-sync-state    查状态：debug-ok / running-no-debug / not-running
  ting-sync-stop     停同步服务和字幕条（不影响 App 播放）
  ting-sync-follow   只在终端打印当前句和译文
  ting-sync-probe    一次性输出课文/播放器/缓存的诊断 JSON
  ting-sync-selftest 自检课文解析与翻译通道
EOF
    ;;
esac
