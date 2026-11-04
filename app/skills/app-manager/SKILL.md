---
name: app-manager
description: 应用管理。用户要列出/查找已装应用、看应用大小和使用频率、冻结或停用预装应用、卸载、检查应用权限、备份 APK 时使用。
---

# 应用管理

所有包管理命令都在安卓环境里执行：`ashell pm …` / `ashell cmd package …` / `ashell dumpsys …`。

## 查询（只读，可直接做）

- 用户应用：`ashell pm list packages -3`；系统应用：`ashell pm list packages -s`；已停用：`ashell pm list packages -d`
- 带安装路径：`ashell pm list packages -f -3`
- 应用名与版本：`ashell -c 'dumpsys package <包名> | grep -E "versionName|firstInstallTime|lastUpdateTime"'`
- 最近使用：`ashell -c 'dumpsys usagestats | grep -E "package=<包名>" | head'`
- 已授予的权限：`ashell -c 'dumpsys package <包名> | grep "granted=true"'`
- 后台/自启相关的 appops：`ashell appops get <包名>`

## 修改（每一项都要先说明影响并得到确认）

| 操作 | 命令 | 可恢复性 |
|---|---|---|
| 停用（冻结） | `ashell pm disable-user --user 0 <包名>` | `ashell pm enable <包名>` 恢复 |
| 为当前用户卸载预装应用 | `ashell pm uninstall --user 0 <包名>` | `ashell cmd package install-existing <包名>` 恢复 |
| 彻底卸载用户应用 | `ashell pm uninstall <包名>` | 不可恢复，数据一并删除 |
| 撤销某权限 | `ashell pm revoke <包名> <权限>` | `ashell pm grant` 恢复 |
| 禁止后台运行 | `ashell appops set <包名> RUN_ANY_IN_BACKGROUND ignore` | 改回 `allow` |
| 强行停止 | `ashell am force-stop <包名>` | — |

**不要动**：`android`、`com.android.systemui`、`com.android.phone`、`com.android.settings`、各类 `*.provider`、输入法、桌面、root 管理器和 `com.droidagent.app` 本身。拿不准某个预装应用是否关键时，优先选「停用」而不是卸载，并提醒用户可能的副作用。

每次修改后，把「做了什么、怎么恢复」追加到 `~/device/app-changes.md`，方便以后回滚。

## 备份 APK

```bash
mkdir -p /sdcard/DroidAgentBackup/apks/<包名>
for p in $(ashell pm path <包名> | sed 's/^package://'); do cp "$p" /sdcard/DroidAgentBackup/apks/<包名>/; done
```

分包应用（多个 split APK）要一起备份，恢复时用 `ashell pm install-multiple` 一起装。
