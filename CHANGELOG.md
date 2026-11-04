# 更新记录

每个版本的说明会显示在 GitHub Releases 和 App 更新后的提示里。发布新版本时，在最上面加一节，并同步修改 `apk/AndroidManifest.xml` 的 `versionName` / `versionCode`。

## 1.3.1

- 自动更新改为从 GitHub 发布的 latest.json 读取最新版本，不再受 GitHub 接口「每小时 60 次」的限制（共用 VPN 或运营商出口时很容易触发）
- 检查间隔从 6 小时缩短为 1 小时

## 1.3.0

- 自动更新：后台每 6 小时检查一次新版本，自动下载并静默安装（用 root），装完自动重启服务；App 开着的话会自动重新打开
- 设置里新增「自动更新」开关、当前版本和「检查更新」按钮
- 更新完成后在对话里提示更新了什么

## 1.2.5

- 修复 ashell 报 /dev/fd/63 不存在：Linux 环境里补上 /dev/fd、/dev/stdin 等标准链接
- 手机端小工具（ashell、droid 等）随更新一起同步

## 1.2.4

- 用量与额度：直接读取 claude.ai 用量接口，不依赖 SDK 版本
- 登录申请最新版 Claude Code 的完整权限；账号页显示授权范围
