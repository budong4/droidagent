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
- **App 样式**：不是终端套壳，是自建的聊天前端，有多会话并发、斜杠命令、实时待办、权限确认卡片、亮/暗主题、账号/用量面板。
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
- 若 `apk/assets/rootfs.tar.xz` 存在，会被打进 APK，实现「装上 App 点一下就自动解包整个 Linux 系统」。不放也能构建，只是首次启动时需要你自己把 rootfs 推进去。
- `build.py` 自己实现了 zip 对齐（部分新系统对 `resources.arsc` 的对齐校验更严）。某些设备若仍拒装 `targetSdk≥30`，把 `AndroidManifest.xml` 的 `targetSdkVersion` 降到 29 再构建。

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
2. 打开 App——它会**自己申请 root**（弹出你 Root 管理器的授权窗口，点允许）。若被拒或没 root，界面会给出明确提示让你重试。
3. 首次会把内置的 Linux 系统**自动解包**到应用目录，然后启动后端、加载聊天界面。
4. 用你的 **Claude 订阅账号**在 App 里登录（走 OAuth，不需要 API key）。

> 开机自启：把 `optional/99-debian-agent.sh` 放到 `/data/adb/service.d/` 即可（KernelSU/Magisk 的 service.d）。

## 配置

- **代理**（访问 Anthropic API）：编辑 chroot 里的 `/etc/agent/proxy.env`。
- **系统提示词 / Skills / MCP**：在 App 的设置里管理，下一条消息生效。
- **个人数据开关**：默认关闭；打开后读联系人/短信/相册等仍会逐次弹确认。
- **悬浮窗**：任务跳到别的应用时自动浮出进度，回到对话自动收起（可在设置里总开关）。

## 目录结构

| 路径 | 内容 |
|---|---|
| `apk/` | 原生 APK（`build.py` 纯脚本构建，不依赖 Gradle）、源码、资源 |
| `app/server/` | Node 后端 `server.mjs`（Agent SDK + HTTP/SSE）、OAuth 登录 pty |
| `app/web/` | PWA 前端（聊天界面、悬浮窗面板） |
| `phone/debian` | 安卓侧启动器脚本（挂载 / chroot / 管理后端） |
| `phone/overlay/` | 叠加进 rootfs 的内容：工具（ashell/droid/pdata/clip）、agent 的 `CLAUDE.md`、设备档案模板 |
| `optional/` | 开机自启脚本 |

## ⚠️ 安全警告

这个项目以 **真 root** 运行，chroot 里的 `/data`、`/sdcard`、`/system`、`/proc` 等**是安卓真实分区的绑定挂载，不是副本**。在里面删文件就是真删手机里的文件。

- **绝不**对 chroot 根目录或 `/`、`/data`、`/storage` 执行递归的 `rm -rf`、`chmod -R`、`chcon -R`、`chown -R`——它们会顺着绑定挂载走进真实的 `/data`、`/proc`，可能改坏系统、丢失全部数据、甚至变砖。递归操作前先确认目标下没有活动挂载（`grep <path> /proc/self/mountinfo`）。
- 刷分区、碰 bootloader/vbmeta/tee/userdata 风险极高，务必清楚自己在做什么。
- agent 的 `CLAUDE.md` 内置了这些安全规则，但**最终责任在你**。本软件按「原样」提供，不承担任何损失。

## License

[MIT](LICENSE)
