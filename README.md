# 每日英语听力 · 免费学习链路

给「没钱但要学英语」的自己。核心结论是：**每日英语听力的译文是 VIP 权益，非 VIP 没有任何免费入口**，
所以这套工具把"翻译"这一层搬到 App 外面，用公有领域的 VOA 存档 + 免费翻译通道补齐。

全程**不需要敲命令**：装好后是双击操作。

---

## 一、装（只做一次）

前置：机器上有 Node.js（`brew install node` 或 nodejs.org 的 LTS 安装包）。

1. 把本仓库放到任意位置（`git clone` 或整个文件夹拷过去）。
2. 双击 **`install.command`**。

安装器会自己探测环境并把结果写进 `~/English/config`（不进仓库，换机器就重新生成）：

- 找 `node`（依次试 `PATH`、`/opt/homebrew/bin`、`/usr/local/bin`）
- 试本机代理 `http://127.0.0.1:7890` 能不能打通 VOA 存档站；不通就退回直连
- 生成稳定入口 `~/English/run.sh`、兼容软链 `~/scripts/*.mjs`
- 在 `~/Applications` 生成两个一键 App
- 跑一次翻译自检，失败会直接告诉你失败原因

## 二、用（日常零命令）

| 想做什么 | 怎么做 |
| --- | --- |
| 翻译一句 | 在任意 App 里选中英文 → `⌘C` → 双击 **译剪贴板** → 弹窗看译文，要覆盖剪贴板再点「复制译文」 |
| 学一整篇 | 复制一条 VOA 课文链接 → 双击 **抓课文** → 自动下载音频、生成双语对照表并打开 |

产物都在 `~/English/voa/`：`<编号>.txt`（原文）、`<编号>.mp3`（音频）、`<编号>.对照.md`（逐句对照）。

想更快：系统设置 → 键盘 → 键盘快捷键 → **App 快捷键**，给两个 App 的「运行」菜单项绑组合键；
或把它们拖进程序坞。第一次双击若被 Gatekeeper 拦：访达里按住 `⌃控制` 点 App → 打开。

## 三、内容从哪来

**VOA Learning English**（`learningenglish.voanews.com`）——美国联邦政府资助媒体，材料属**公有领域**，
音频和全文可自由下载、翻译、自用。

必须知道的现状：2025-03-14 行政令裁撤 USAGM，3 月 15 日起 VOA **停更**（App 里那句"VOA官网关停"是真的）。
但"停更"不等于"下架"——Beginning / Intermediate / Advanced 三级课、Let's Learn English 系列、
As It Is、Science & Technology、People in America、US History 全部作为**冻结存档**仍可访问，音频是直链 MP3。

选源时排除掉的候选（都实测过）：

- `americanenglish.state.gov` → 已迁到 `americanenglish.org`，是**教师**资源站，没有学习者听力库
- `elllo.org` → 有 A1–C1 完整文本稿，但**主音频只挂在 SoundCloud 嵌入里、无直链**，无法自动下载
- BBC Learning English / archive.org → 可达但内容有版权，不做批量下载
- Google 翻译、有道、OpenAI 端点 → 本机直连不通（实测超时），别配

## 四、命令行（可选，等价于上面两个双击）

```bash
~/English/run.sh tr-clipboard          # 翻译剪贴板
~/English/run.sh tr "some english"     # 直接翻译
~/English/run.sh grab "<课文URL>"      # 抓课文+下音频
~/English/run.sh grab-clipboard        # 用剪贴板链接抓课文并出对照表
~/English/run.sh batch 你的字幕.lrc     # 任意 lrc/srt/vtt/txt 出双语对照
~/English/run.sh selftest              # 自检 node / 路径 / 翻译通道
```

## 五、诊断

| 现象 | 先看什么 |
| --- | --- |
| 弹窗"翻译失败" | `~/English/run.sh selftest`；再确认翻译端点可达：`curl -s -o /dev/null -w '%{http_code}\n' https://edge.microsoft.com/translate/translatetext` 应返回 405 |
| 抓课文失败、提示代理 | 代理软件没开。开代理后重跑 `install.command` 让它重新探测；或改 `~/English/config` 里的 `PROXY_URL` |
| 提示"剪贴板里不是 https 课文链接" | 要复制**文章页**链接（`/a/<名字>/<编号>.html`），不是首页 |
| 对照表里出现"（失败: …）" | 翻译端点被限流。脚本每次最多 25 句、失败重试一次；隔一会儿再跑，缺的行会重译 |

## 六、已知边界（别踩坑）

- **翻译通道是微软 Edge 的公开免费端点，没有 SLA**，可能被限流。兜底方案：macOS 自带的 Apple 翻译（离线）或自建 LibreTranslate。
- **机翻质量低于编辑精校**，口语断句和习语会偏。遇到别扭译法就回到查词。
- 对话首句偶尔残留一个游离引号（`” Well, back to work!`），是原文引号被当中文引号处理，没为它加规则。
- **Easydict 划词配置没做**：它是菜单栏应用，`AXWindows=0` 且拿不到主/焦点窗口，无法可靠自动配置。想装的话手动四下：设置 → 翻译服务勾「微软翻译」（主）和「Apple 翻译」（离线兜底）→ 关掉 Google/内置 AI/有道（本机实测不通）→ 确认快捷键；辅助功能权限需你自己授。
- **App 内「收藏」也没自动化成功**：收藏按钮只在专辑页且是 canvas 绘制、无 `AXPress`；阅读页的返回控件对合成点击和 Esc 都无反应。手动两下：侧栏 专辑分类 → VOA常速慢速 → 点进专辑 → 「收藏」。
- **本工具不绕过任何付费门禁**：不改 App 包、不伪造会员标志、不清配额计数器。每日英语听力的官方精校译文该付费就付费。

## 七、这个仓库里有什么

```
bin/voa-grab.mjs            抓 VOA 课文：抽正文切句 + 下 MP3（代理内置，--no-proxy 可关）
bin/bilingual-subtitle.mjs  任意 lrc/srt/vtt/txt → 双语对照 md / 双语 lrc
bin/tr.mjs                  剪贴板/管道/参数 → 译文，支持 TR_TO 反向
bin/run.sh                  统一入口（上面的命令都走它）
apps/*.applescript          两个一键 App 的源码，由 install.command 用 osacompile 编译
install.command             双击安装 + 自检，幂等
```
