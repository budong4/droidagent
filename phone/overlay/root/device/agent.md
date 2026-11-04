# 设备档案（请按你自己的手机填写）

> 这是一个**模板**。第一次在新设备上部署后，建议让 agent 或你自己把这台机器的真实情况记在这里，
> 之后处理 root / 刷机 / 分区相关问题时 agent 会先读这个文件。
> 不确定的留空即可，不要照抄别人的参数。

## 基本信息

| 项目 | 值 |
|------|-----|
| 机型 / 代号 | （例：Pixel 8 / shiba） |
| SoC | |
| Android 版本 / 系统 | （例：Android 14 / 原生 或 某 OEM 系统） |
| 架构 | arm64 |
| 序列号 | （可留空，涉及隐私） |

## Root 方案

| 项目 | 值 |
|------|-----|
| 方案 | （KernelSU / KernelSU-Next / Magisk / APatch 之一） |
| 管理器包名 | |
| 工作目录 | `/data/adb/…` |
| busybox 路径 | （例：`/data/adb/ksu/bin/busybox`） |
| 额外模块 | （susfs、Zygisk、LSPosed 等，若有） |

## Bootloader / 分区注意事项

- Bootloader 是否解锁：
- **刷分区前务必确认**：哪些分区碰不得（bootloader、vbmeta、tee、userdata 等），这台机器有没有防回滚（anti-rollback）、A/B 槽位等。
- 有坑/教训就记在这里，避免重复踩。

## 其他

- 常用路径、已知问题、这台机器特有的行为等。
