#!/bin/bash
# 统一入口。被 .app 双击调用，也可以直接敲。
# 机器相关值放在 ~/English/config，不进仓库。

set -uo pipefail

CONF="$HOME/English/config"
[ -f "$CONF" ] && . "$CONF"

REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
OUT_ROOT="${OUT_ROOT:-$HOME/English}"
PROXY_URL="${PROXY_URL:-http://127.0.0.1:7890}"

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

  help|*)
    cat <<'EOF'
用法: run.sh <命令>
  tr-clipboard      翻译剪贴板里的原文（配合 .app 双击）
  tr <文本>         直接翻译
  grab <课文URL>    抓课文 + 下音频
  grab-clipboard    用剪贴板里的课文 URL 抓课文并生成双语对照，然后打开
  batch <文件>      把 .lrc/.srt/.txt 批量出双语对照
  selftest          自检 node、路径与翻译通道
EOF
    ;;
esac
