# DroidAgent

把 **Claude Code / Agent SDK** 装进一台**已 Root 的 Android 手机**，让它以**真 root** 身份在手机本地的 Debian chroot 里运行，通过一个 App 样式的聊天界面帮你管理和操作整台手机——文件、应用、进程、系统设置，还能跨 App 操作屏幕、做 APK 逆向分析。

> 名字叫 DroidAgent 而不是绑定某个模型，是为了以后能接入别的模型。当前后端基于 `@anthropic-ai/claude-agent-sdk`。

## 下载安装

最新自包含安装包（APK 内置整套装好依赖的 Debian，装上点一下自动解包，首次使用不需要联网装环境）：

- **[Releases](../../releases/latest)** → 下载 `DroidAgent.apk`（约 1.3 GB）

需要：已 Root 的 arm64 手机（KernelSU / Magisk / APatch）+ 你自己的 Claude 订阅账号。装好打开 App，它会自己申请 root。想自己从源码构建见下文。

---

## 这是什么

```
┌─────────────────────────── 你的 Android 手机（已 root）───────────────────────────┐
│                                                                                    │
│  DroidAgent APK (com.droidagent.app)                                               │
│  ├─ 原生壳：WebView + 自动申请 root + 悬浮窗                                        │
│  └─ 首次启动把内置的 Debian rootfs 解包到应用的设备加密目录                         │
│         /data/user_de/0/com.droidagent.app/rootfs                                  │
│                                                                                    │
│  Debian chroot（真 root，绑定挂载了安卓的 /data /system /proc …）                   │
│  ├─ Node 后端 (server.mjs)：Agent SDK + 本地 HTTP/SSE 服务 (127.0.0.1:8787)         │
│  ├─ PWA 前端：类 Claude.ai 的聊天界面，多会话、斜杠命令、待办清单、权限卡片          │
│  └─ 工具：ashell（执行安卓命令）、droid（屏幕自动化）、pdata（个人数据）、           │
│          clip、frida-server，以及 jadx/radare2/frida/mitmproxy 等逆向工具链          │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **真 root**：chroot 里绑定挂载了安卓真实的 `/data`、`/system`、`/proc`、`/dev` 等，agent 能看到并操作整台手机。
- **App 样式**：不是终端套壳，是自建的聊天前端，有多会话并发、斜杠命令、实时待办、权限确认卡片、和 Claude Code 一致的执行模式（Ask / Accept edits / Plan / Auto / Full access）、输入框里的用量环、11 套主题（纯色和原创插画）、7 种开源字体和自定义聊天背景。
- **跑在手机本地**：后端 Node 服务监听 `127.0.0.1:8787`，APK 用 WebView 加载它。

## 前置条件

- 一台 **已 Root** 的 Android 手机（KernelSU / KernelSU-Next / Magisk / APatch 均可，需要其附带的 busybox）。arm64。
- PC 端构建 APK 需要：**Android SDK**（build-tools + 一个 platform）、**JDK 21**、**Python 3**。
- 一份 **Debian arm64 的 rootfs 快照**（`apk/assets/rootfs.tar.xz`，见下文；因体积大不随仓库分发）。

## 构建 APK

```bash
cd apk
# 工具链路径可用环境变量覆盖，否则自动探测常见位置
export ANDROID_HOME=~/AppData/Local/Android/Sdk    # 或你的 SDK 路径
export JAVA_HOME="D:\\Java\\jdk-21"                 # 或你的 JDK 路径
python build.py
```

- 产物：`apk/DroidAgent.apk`（自签名调试版；`debug.keystore` 首次构建自动生成）。
- `build.py` 会自动把这些打进 APK（都以不压缩方式存放）：
  - `phone/debian` → `assets/debian`（启动器，始终用仓库里的最新版）；
  - `app/`（server + web，不含 `node_modules`）→ `assets/agent-app.tar`。App 每次启动会把它同步进 chroot，**聊天界面和后端的修复只需更新 APK，不用重做 rootfs**；
  - `apk/assets/setup/`（首次启动 / 启动中的进度页面）；
  - `apk/assets/rootfs.tar.xz`（若存在）。
- 某些设备若仍拒装 `targetSdk≥30`，把 `AndroidManifest.xml` 的 `targetSdkVersion` 降到 29 再构建（当前已是 29）。

### 更新已经装好的手机

手机上已经解压过 Linux 系统时，不带 rootfs 的小 APK（约 7 MB）就能完成更新：把 `apk/assets/rootfs.tar.xz` 移走后构建，再覆盖安装。

```bash
adb install -r apk/DroidAgent.apk
```

- 必须用**同一个 `debug.keystore`** 签名，否则会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。不要为此卸载 App——卸载会连同 `/data/user_de/0/com.droidagent.app/rootfs` 一起删掉。
- 打开 App 后它会自动同步新版启动器和聊天程序，并重启后台服务。
- 不带 rootfs 的 APK 不能用来初始化一台新手机，发布给别人时请用完整版。

### 自动构建与发布（GitHub Actions）

`.github/workflows/apk.yml` 在每次推送到 `main` 时构建更新版 APK（不含 Linux 系统，约 7 MB）和 Root 管理器更新包，并以版本号发布到 Releases（`v<版本>`，标为预发布）。之后手机上的更新方式就是：打开 Releases，下载最新的 `DroidAgent-<版本>.apk` 直接安装，App 启动时会自动同步聊天程序和运行时。

**自动更新**：手机上的后台服务（root，常驻）启动 2 分钟后和之后每小时检查一次（读取 Releases 里「自动更新通道」的 latest.json，不受 GitHub 接口限流影响），发现更高版本就下载 APK、核对 GitHub 公布的 sha256、用 `pm install` 静默安装（安卓会拒绝签名不同的包），再把新的启动器、聊天程序和运行时同步进 Linux 环境并重启服务；装的时候 App 若开着，会自动重新打开。正在进行的对话不会被打断，会等它结束再装。设置 → 通用 里可以关掉自动安装（改为只提示）或手动检查。需要仓库是公开的（手机不带 GitHub 凭据）。发布新版本时，同时修改 `apk/AndroidManifest.xml` 的 `versionName` / `versionCode` 并在 `CHANGELOG.md` 加一节；版本号没变的推送不会覆盖已发布的包。

一次性设置：安卓只接受同一签名的更新，所以 CI 必须用当初签名手机上那个 APK 的密钥。在构建过那个 APK 的电脑上，把 `apk/debug.keystore` 转成 base64，存为仓库的 Actions Secret `ANDROID_KEYSTORE_BASE64`（仓库 Settings → Secrets and variables → Actions）。Windows PowerShell：

```bash
[Convert]::ToBase64String([IO.File]::ReadAllBytes("apk\debug.keystore")) | Set-Clipboard
```

### 不用电脑，在手机上直接更新

聊天程序（后端 + 界面）在已解压的 Linux 系统里，可以用 Root 管理器刷一个更新包来更新，不用重装 APK，也不会丢数据：

```bash
python tools/build_update_zip.py
```

把生成的 `DroidAgent-update.zip` 放到手机上，在 KernelSU / Magisk / APatch 的「模块 → 从本地安装」里选它。它会备份旧版，更新聊天程序、Node 运行时和启动器，重启服务并显示 Claude Code 的运行方式；重启手机后自动移除，不留模块。APK 本身的部分（图标、启动页）仍需要更新 APK。构建需要 `npm`（用来打包 Node 运行时）。

## 构建 rootfs 快照

APK 里打包的 `apk/assets/rootfs.tar.xz` 是一份已经装好依赖的 Debian。两种做法：

1. **先在设备上装好再打快照**（推荐，装上即用）：用 `phone/debian` 启动器 `install` 一份基础 Debian arm64 rootfs + `phone/overlay`，`debian setup` 装好 Node / Claude Code / 工具链，再 `tar -cJ` 打包成 `rootfs.tar.xz`（打包时记得排除凭据、对话记录、缓存等）。
2. **只打基础包**：APK 里只放一份基础 Debian arm64 rootfs，装到新机后再 `debian setup` 联网装依赖。

`phone/debian` 支持的命令：

```
debian install <rootfs.tar.xz> <overlay>   解包 + 应用 overlay（首次）
debian selfinstall [apk]                    从已安装的 APK 里解包 rootfs
debian setup [EXTRA=1]                       在 chroot 里装 Node / Claude Code / 工具
debian start | stop | status                挂载 / 卸载 / 查看状态
debian shell ['cmd']                         进 chroot 的 shell
debian app start|stop|restart|status         聊天 App 后端（http://127.0.0.1:8787）
debian appdeps                               装后端的 npm 依赖
debian retools                               装逆向分析工具链
```

启动器会自动探测 KernelSU / Magisk / APatch 的 busybox，并从自身所在路径推导应用目录，不写死包名。

## 安装与首次使用

1. 把 `DroidAgent.apk` 安装到手机（需允许「安装未知来源」）。
2. 打开 App，它会直接开始准备，不需要再点按钮：
   1. **获取 Root 权限**：弹出 Root 管理器的授权窗口时点允许。被拒或没有 root，会说明原因并提供「重试」。
   2. **解压 Linux 系统**（只在第一次）：从安装包本身解压，不联网下载。界面显示百分比、已处理大小和剩余时间，期间屏幕保持常亮。
   3. **启动助手服务**：服务就绪后自动进入聊天界面。
3. 以后每次打开：服务在运行就直接进入；不在运行（比如重启过手机）就自动重新启动。
4. 用你的 **Claude 订阅账号**在 App 里登录（走 OAuth，不需要 API key）。

### 登录失败怎么办

- 登录用的是「自动回调」：授权后浏览器会跳到 `http://localhost:端口/callback`，也就是手机上 `claude` 自己开的本地服务（Linux 环境和安卓共用网络），登录自动完成，不用复制授权码。浏览器停在打不开的 localhost 页面时，把地址栏里的网址粘贴回 App 即可。Node 版 Claude Code 2.1.112 的 `auth login` 本来就没有粘贴授权码的入口，旧做法在它上面会一直卡在「正在验证授权码」。

- 登录失败时界面会显示 `claude` 实际报的错。完整输出在 chroot 里的 `~/.claude/agent-login.log`。
- 新版 Claude Code 是用 Bun 编译的原生程序，在部分安卓内核上一启动就崩溃（`Bun has crashed`，信号 6）。后台启动时会逐个试：全局 `claude`、SDK 自带的 `claude`、以上两者关闭 JIT（`JavaScriptCoreUseJIT=0`），最后是跑在 Node.js 上的 Claude Code 2.1.112（最后一个纯 JavaScript 版本，随 APK 和更新包一起提供）。第一个能启动的同时用于登录和对话。日志 `/var/log/agent-app.log` 里的 `[runtime]` 行会写明试了哪些、用的是哪个。
- 手机开着 VPN、浏览器能打开登录页，不代表 Linux 环境里的 `claude` 也能连上：很多 VPN（尤其是分应用代理模式）不转发 root 进程的流量，结果就是卡在「正在验证授权码」。现在每次登录前会先测试能否连上 `platform.claude.com` 和 `api.anthropic.com`；连不上时会自动查找本机代理端口（Clash 7890/7897、NekoBox 2080、v2rayNG 10809 等），找到能用的就自动保存。
- 自动检测失败时，登录页底部会出现代理输入框，可以手动填写代理软件的本地 HTTP 端口，例如 `http://127.0.0.1:7890`；保存时会立即测试能否连上。

> 开机自启：把 `optional/99-debian-agent.sh` 放到 `/data/adb/service.d/` 即可（KernelSU/Magisk 的 service.d）。

## 配置

- **代理**（访问 Anthropic API）：登录前自动检测；检测不到时在登录页手动填写（写入 chroot 里的 `/etc/agent/proxy.env`，立即生效，登录、对话、字体下载和自动更新都会使用）。
- **执行模式**（输入框左下角）：Ask（只读操作直接做，其余逐步确认）、Accept edits（自动改文件和跑常规命令，有风险的先问，默认）、Plan（只读分析，先出计划，同意后执行）、Auto（只有刷机、重启、格式化等高危操作才问）、Full access（不再询问，切换时确认一次）。
- **系统提示词 / 技能 / MCP**：在 App 的设置里管理，下一条消息生效。内置 8 个安卓常用技能（手机体检、存储清理、应用管理、屏幕自动化、日志诊断、网络诊断、APK 分析、备份与恢复），首次启动自动启用；关掉或改过的不会被更新覆盖。
- **外观**：设置 → 外观 里选主题、字体和聊天背景。背景有 14 张预设（原创动漫风场景和渐变、歌川广重浮世绘、梵高名画、NASA 极光照片，均为原创或公有领域，来源见 `tools/background_photos.py`），也可以用自己的图片，都带可调遮罩。输入框是液态玻璃效果。字体第一次使用时按需下载用到的字，之后缓存在 `~/.claude/fonts`。
- **扩展市场**：设置 → 助手 → 扩展市场（或 `/market`）。技能和连接器的精选目录在 `app/server/catalog/`（`app/` 下只有 `server`、`web`、`skills` 会同步到手机）；插件通过官方 `claude plugin` 命令安装，下载后默认不启用，列出内容经确认才启用，因为插件的 hooks 和本地命令会以 root 运行。关闭的技能放在 `~/.claude/skills-disabled/`，和 Claude 一起创建的技能草稿放在 `~/.claude/skill-drafts/`。市场逻辑的测试：`node --test tests/market.test.mjs`。
- **斜杠命令**：输入 `/` 列出全部命令。Claude Code 终端界面里才有的 `/status`、`/usage`、`/doctor` 等由 App 自己实现；`/compact`、`/context`、`/cost`、`/init` 和自定义命令、技能交给 Claude Code，输出显示在对话里。
- **对话标题**：第一次回复之后，用一次 Haiku 调用根据对话内容生成标题；手动改过名的不会被覆盖。
- **版本与更新**：设置 → 通用 → 版本与更新，列出每个版本的更新内容（来自 `CHANGELOG.md`，随 App 一起打包）。
- **用量与额度**：输入框右下角的圆环是 5 小时窗口的用量，点开看每周额度和重置时间。直接读取 claude.ai 的用量接口（和 Claude Code 自己的 `/usage` 同一个），不依赖 SDK 版本，也不需要先开始对话。
- **登录权限**：登录链接总是申请最新版 Claude Code 的完整授权范围（含 `user:plugins`），不管手机上跑的是哪个版本；在 设置 → 账号 里可以看到当前登录的授权范围是否完整。
- **个人数据**：联系人、短信、相册等在 Ask 和 Accept edits 模式下逐次确认。
- **悬浮窗**：任务跳到别的应用时自动浮出进度，回到对话自动收起。

## 目录结构

| 路径 | 内容 |
|---|---|
| `apk/` | 原生 APK（`build.py` 纯脚本构建，不依赖 Gradle）、源码、资源；`apk/assets/setup/` 是首次启动的进度页面 |
| `brand/` | 图标源文件（`icon.svg`）和重新生成 PNG 图标的脚本 |
| `app/server/` | Node 后端 `server.mjs`（Agent SDK + HTTP/SSE）、OAuth 登录 pty |
| `app/web/` | PWA 前端（聊天界面、悬浮窗面板） |
| `phone/debian` | 安卓侧启动器脚本（挂载 / chroot / 管理后端） |
| `phone/overlay/` | 叠加进 rootfs 的内容：工具（ashell/droid/pdata/clip）、agent 的 `CLAUDE.md`、设备档案模板 |
| `optional/` | 开机自启脚本 |
| `tools/` | 手机端更新包（Root 管理器刷入）的源文件和构建脚本 |
| `.github/workflows/` | 自动构建并发布更新版 APK |

## ⚠️ 安全警告

这个项目以 **真 root** 运行，chroot 里的 `/data`、`/sdcard`、`/system`、`/proc` 等**是安卓真实分区的绑定挂载，不是副本**。在里面删文件就是真删手机里的文件。

- **绝不**对 chroot 根目录或 `/`、`/data`、`/storage` 执行递归的 `rm -rf`、`chmod -R`、`chcon -R`、`chown -R`——它们会顺着绑定挂载走进真实的 `/data`、`/proc`，可能改坏系统、丢失全部数据、甚至变砖。递归操作前先确认目标下没有活动挂载（`grep <path> /proc/self/mountinfo`）。
- 刷分区、碰 bootloader/vbmeta/tee/userdata 风险极高，务必清楚自己在做什么。
- agent 的 `CLAUDE.md` 内置了这些安全规则，但**最终责任在你**。本软件按「原样」提供，不承担任何损失。

## License

[MIT](LICENSE)
