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
  echo "ok 代理可用: $PROXY（VOA 存档站和翻译通道走它）"
else
  echo "-- 本机代理 $PROBE 不可用，VOA 抓取将尝试直连（部分网络下不通）"
fi

TING_APP=""
for p in "/Applications/每日英语听力.app" "$HOME/Applications/每日英语听力.app"; do
  [ -d "$p" ] && { TING_APP="$p"; break; }
done
if [ -z "$TING_APP" ]; then
  TING_APP="$(mdfind 'kMDItemCFBundleIdentifier == "com.eusoft.ting.en"' 2>/dev/null | grep '\.app$' | head -n 1)"
fi
if [ -n "$TING_APP" ] && [ -d "$TING_APP" ]; then
  echo "ok 每日英语听力: $TING_APP"
else
  TING_APP="/Applications/每日英语听力.app"
  echo "-- 没检测到每日英语听力；装好后如路径不同，改 ~/English/config 里的 TING_APP"
fi

mkdir -p "$CONF_DIR/logs" "$CONF_DIR/run"
cat > "$CONF" <<EOF
# 由 install.command 生成；换机器就重新双击 install.command
REPO="$REPO"
NODE_BIN="$NODE"
OUT_ROOT="$CONF_DIR"
PROXY_URL="$PROXY"
TING_APP="$TING_APP"
TING_CDP_PORT="9333"
TING_WEB_PORT="8787"
EOF
echo "ok 配置: $CONF"

cat > "$CONF_DIR/ting-sync.conf" <<EOF
# ting-sync 配置（install.command 生成；改端口/缓存目录后重启同步服务）
TEMP_HTML="$HOME/Library/Application Support/ting_en/ting/tmp/temp/index.html"
CDP_PORT="9333"
WEB_PORT="8787"
CACHE_DIR="$CONF_DIR/ting-cache"
TR_PROXY="$PROXY"
EOF
echo "ok 同步配置: $CONF_DIR/ting-sync.conf"

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
if osacompile -o "$APPS_DIR/每日英语听力·同步.app" "$REPO/apps/sync.applescript" 2>/dev/null; then built=$((built+1)); else echo "!! 生成 每日英语听力·同步.app 失败"; fi

OVERLAY_APP="$APPS_DIR/每日英语听力·同步字幕.app"
if command -v swiftc >/dev/null 2>&1; then
  TMP_OVERLAY="$CONF_DIR/.overlay-build.app"
  rm -rf "$TMP_OVERLAY"
  mkdir -p "$TMP_OVERLAY/Contents/MacOS" "$TMP_OVERLAY/Contents/Resources"
  cat > "$TMP_OVERLAY/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>每日英语听力·同步字幕</string>
  <key>CFBundleDisplayName</key><string>每日英语听力·同步字幕</string>
  <key>CFBundleIdentifier</key><string>com.local.ting-sync.overlay</string>
  <key>CFBundleExecutable</key><string>ting-sync-overlay</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
  if swiftc -O "$REPO/overlay/Overlay.swift" \
      -o "$TMP_OVERLAY/Contents/MacOS/ting-sync-overlay" \
      -framework Cocoa -framework WebKit >>"$CONF_DIR/logs/install.log" 2>&1; then
    pkill -f "每日英语听力·同步字幕.app/Contents/MacOS/" >/dev/null 2>&1
    rm -rf "$OVERLAY_APP"
    mv "$TMP_OVERLAY" "$OVERLAY_APP"
    codesign --force --deep --sign - "$OVERLAY_APP" >/dev/null 2>&1
    built=$((built+1))
    echo "ok 置顶字幕条: $OVERLAY_APP"
  else
    rm -rf "$TMP_OVERLAY"
    echo "!! 编译置顶字幕条失败（详见 $CONF_DIR/logs/install.log；会先用浏览器窗口）"
  fi
else
  echo "-- 没装 Xcode 命令行工具，跳过置顶字幕条（xcode-select --install 后重跑；临时用浏览器窗口）"
fi
echo "ok 双击 App: 已生成 $built 个 → $APPS_DIR"

echo
echo "== 自检 =="
"$CONF_DIR/run.sh" selftest || exit 1
echo
echo "-- 随播字幕自检（需要 App 里打开过一篇课文）"
"$CONF_DIR/run.sh" ting-sync-selftest \
  || echo "!! 随播字幕自检未通过；在 App 里打开一篇课文后再跑：~/English/run.sh ting-sync-selftest"

cat <<'EOF'

装好了。日常用法（全程不用终端）：

  随播字幕   双击「每日英语听力·同步」启动 App，播放任意课文，
             置顶字幕条就会跟着进度自动显示中英文。
             字幕条可直接拖动；鼠标移上去有上一句/下一句/字号/隐藏。
             如果 App 已经用普通方式开着，双击后会问一次是否重启。
  逐句翻译   在 App 里选中英文 → ⌘C → 双击「译剪贴板」
  整篇课文   复制一条 VOA 课文链接 → 双击「抓课文」→ 自动打开双语对照表

屏幕右上角菜单栏的 captions 图标可显示/隐藏/退出字幕条；关掉它不影响 App 播放。
想更快：系统设置 → 键盘 → 键盘快捷键 → App 快捷键，给这些 App 的
菜单项「运行」绑一个组合键；或把它们拖到程序坞。

第一次双击若被拦：在访达里按住 ⌌ 控制键点 App → 打开 → 再点打开。
EOF
