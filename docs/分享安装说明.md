# 每日英语听力随播字幕 · 分享安装说明

这是一个 macOS 个人学习工具：在「每日英语听力」里正常播放，屏幕底部会出现一条置顶字幕条，按播放进度自动显示英文句和中文译文。

它不破解 App，不下载音频，不使用 App 的 VIP 精校译文。

## 适合谁用

适合已经有「每日英语听力」Mac 版，并且想边听边看双语字幕的人。

要求：

- macOS。
- 已安装「每日英语听力」，而且要的是**官网直下的 Mac 版**（`ting_en.dmg`）。
  Mac App Store 那份是沙盒版，开不了本地同步端口，字幕不会跟播。
- 已安装 Node.js。
- 已安装 Xcode 命令行工具。
- 播放的课文必须有逐句文本 / 时间轴。

## 安装

1. 下载或 clone 仓库：

   ```bash
   git clone https://github.com/phongm/english-listening.git
   ```

   也可以从 GitHub Release 页面下载 Source code.zip，然后解压。

2. 安装前置工具。

   如果没装 Node.js：

   ```bash
   brew install node
   ```

   或从 https://nodejs.org 下载 LTS 安装包。

   如果没装 Xcode 命令行工具：

   ```bash
   xcode-select --install
   ```

3. 双击仓库里的：

   ```text
   install.command
   ```

   如果 macOS 提示不能打开，按住 `Control` 点击 App 或文件 → 打开 → 再点打开。

4. 打开 `~/Applications`，双击：

   ```text
   每日英语听力·同步
   ```

5. 在每日英语听力里播放任意带逐句文本的课文。

## 常用操作

- 字幕条默认会跟随播放。
- 英文单词有下划线，鼠标悬停可查词。
- 点击单词可固定词典，复制单词、复制整句、收藏生词。
- 工具栏支持：
  - 上一句 / 重听
  - 暂停 / 继续原音频
  - 下一句
  - 双语 / 原文 / 译文 / 逐词
  - 倍速
  - 背景浓度
  - 设置
  - 字号
  - 隐藏
- 整条字幕可以拖动到屏幕任意位置。
- 点 X 只是隐藏字幕条，不会退出程序。

## 默认快捷键

带 `⌘`、`⌃` 或 `⌥` 的快捷键是全局快捷键。

- `⌘B`：显示 / 隐藏字幕条
- `⌘⇧S`：显示 / 隐藏设置
- `⌃⌥Space`：暂停 / 继续播放
- `⌃⌥←`：上一句
- `⌃⌥→`：下一句
- `⌃⌥M`：切换显示模式
- `⌃⌥B`：切换背景浓度
- `⌃⌥[`：倍速降低
- `⌃⌥]`：倍速升高
- `⌃=`：字号放大
- `⌃-`：字号缩小

如果某个快捷键被系统或其他 App 占用，可以在设置里重新录制。

## 数据保存在哪里

配置：

```text
~/English/config
~/English/ting-sync.conf
```

缓存：

```text
~/English/ting-cache
```

日志：

```text
~/English/logs/ting-sync.log
~/English/logs/overlay.log
```

缓存可以删除，删除后只会重新翻译和重新生成。

## 常见问题

### 提示「请用每日英语听力·同步图标启动 App」

说明每日英语听力正在运行，但没有开本地同步端口。

处理：

1. 退出每日英语听力。
2. 双击 `~/Applications/每日英语听力·同步`。

如果照上面做完还是不行，先确认装的不是 App Store 版：

```bash
codesign -d --entitlements :- "/Applications/每日英语听力.app" 2>/dev/null | grep -o "com.apple.security.app-sandbox"
```

有输出就是沙盒版。App Sandbox 不让程序监听端口，所以同步端口永远起不来，
字幕也就拿不到播放进度。换成官网直下的 `ting_en.dmg` 版本（<https://www.eudic.net/v4/en/app/ting>），
再重跑一次 `install.command`。

### 没有字幕条

点菜单栏的 `captions` 图标 → 显示。

或运行：

```bash
~/English/run.sh ting-sync-stop
~/English/run.sh ting-sync-start
```

### 一直显示「译文中…」

通常是网络或代理问题。

运行自检：

```bash
~/English/run.sh ting-sync-selftest
```

如需代理，可编辑：

```text
~/English/ting-sync.conf
```

里的 `TR_PROXY`。

### 字幕条很糊或看不清

打开设置，把背景浓度改成「标准」或「高对比」。

### 快捷键没反应

先在设置里确认快捷键没有和其他 App 冲突。全局快捷键建议包含 `⌘`、`⌃` 或 `⌥`。

## 边界

- 只有带逐句时间轴的课文才能稳定跟播。
- 翻译使用免费公开端点，没有 SLA。
- 机翻质量低于官方精校。
- App 大版本更新后可能需要重新适配。
