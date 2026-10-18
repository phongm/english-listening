#!/bin/bash
# 双击安装：探测环境 → 写机器配置 → 生成两个一键 App → 自检。
# 幂等，可重复运行。

set -uo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CONF_DIR="$HOME/English"
CONF="$CONF_DIR/config"
APPS_DIR="$HOME/Applications"
PROBE="http://127.0.0.1:7890"

echo "== 每日英语听力 · 免费链路安装 =="
echo "仓库: $REPO"
mkdir -p "$CONF_DIR" "$APPS_DIR" "$CONF_DIR/voa"

NODE=""
for c in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$c" ] && [ -x "$c" ] && { NODE="$c"; break; }
done
if [ -z "$NODE" ]; then
  echo "!! 没找到 node。翻译脚本需要它。"
  echo "   装一个（二选一）：brew install node   或   从 nodejs.org 下载 LTS 安装包"
  echo "   装好后再次双击本文件。"
  exit 1
fi
echo "ok node: $NODE ($("$NODE" --version))"

PROXY=""
if curl -sL --max-time 6 -x "$PROBE" -o /dev/null "https://learningenglish.voanews.com/"; then
  PROXY="$PROBE"
  echo "ok 代理可用: $PROXY（VOA 存档站走它）"
else
  echo "-- 本机代理 $PROBE 不可用，VOA 抓取将尝试直连（部分网络下不通）"
fi

cat > "$CONF" <<EOF
# 由 install.command 生成；换机器就重新双击 install.command
REPO="$REPO"
NODE_BIN="$NODE"
OUT_ROOT="$CONF_DIR"
PROXY_URL="$PROXY"
EOF
echo "ok 配置: $CONF"

cat > "$CONF_DIR/run.sh" <<EOF
#!/bin/bash
exec /bin/bash "$REPO/bin/run.sh" "\$@"
EOF
chmod +x "$CONF_DIR/run.sh"
echo "ok 稳定入口: $CONF_DIR/run.sh"

mkdir -p "$HOME/scripts"
for f in voa-grab.mjs bilingual-subtitle.mjs tr.mjs; do
  ln -sf "$REPO/bin/$f" "$HOME/scripts/$f"
done
echo "ok 兼容软链: ~/scripts/{voa-grab,bilingual-subtitle,tr}.mjs"

built=0
if osacompile -o "$APPS_DIR/译剪贴板.app" "$REPO/apps/translate.applescript" 2>/dev/null; then built=$((built+1)); else echo "!! 生成 译剪贴板.app 失败"; fi
if osacompile -o "$APPS_DIR/抓课文.app" "$REPO/apps/grab.applescript" 2>/dev/null; then built=$((built+1)); else echo "!! 生成 抓课文.app 失败"; fi
echo "ok 一键 App: $built/2 → $APPS_DIR"

echo
echo "== 自检 =="
"$CONF_DIR/run.sh" selftest || exit 1

cat <<'EOF'

装好了。日常用法（全程不用终端）：

  逐句翻译   在 App 里选中英文 → ⌘C → 双击「译剪贴板」
  整篇课文   复制一条 VOA 课文链接 → 双击「抓课文」→ 自动打开双语对照表

想更快：系统设置 → 键盘 → 键盘快捷键 → App 快捷键，给这两个 App 的
菜单项「运行」绑一个组合键；或把它们拖到程序坞。

第一次双击若被拦：在访达里按住 ⌌ 控制键点 App → 打开 → 再点打开。
EOF
