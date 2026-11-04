---
name: backup-restore
description: 备份与恢复。用户想备份应用数据（含聊天记录、游戏存档）、APK、联系人、短信、照片，或要把之前的备份恢复回去时使用。
---

# 备份与恢复

备份统一放在 `/sdcard/DroidAgentBackup/<日期>/` 下，开始前先 `df -h /data` 确认空间够。

## 应用（APK + 数据）

备份前先停止应用，避免数据写到一半：`ashell am force-stop <包名>`（会关闭该应用，先告诉用户）。

```bash
B=/sdcard/DroidAgentBackup/$(date +%F)/<包名>; mkdir -p "$B"
for p in $(ashell pm path <包名> | sed 's/^package://'); do cp "$p" "$B/"; done
tar -C /data/data -czpf "$B/data.tar.gz" <包名>
stat -c '%u:%g' /data/data/<包名> > "$B/owner.txt"
```

恢复（需确认，会覆盖当前数据）：

1. 装回 APK：只有一个 `base.apk` 时 `ashell pm install -r <路径>/base.apk`；有 split 时 `ashell pm install-multiple -r <路径>/*.apk`
2. `ashell am force-stop <包名>`
3. `tar -C /data/data -xzpf data.tar.gz`
4. **用新装应用的 uid 修正属主**（重装后 uid 可能变化）：`chown -R $(stat -c '%u:%g' /data/data/<包名>) /data/data/<包名>`，再 `ashell restorecon -R /data/data/<包名>`

不要恢复到不同版本差距很大的应用上，数据格式可能不兼容。

## 个人数据（读取会弹确认）

- 联系人：`pdata contacts --limit 500 > contacts.json`，需要的话再转成 vCard。
- 短信：`pdata sms --limit 500 --body > sms.json`（包含正文，只在用户明确要备份短信时做）。
- 通话记录：`pdata calllog --limit 500 > calllog.json`

## 照片与文件

直接复制目录即可，例如 `cp -a /sdcard/DCIM/Camera "$B/"`。目录很大时先用 `du -sh` 告诉用户大小。

## 完成后

列出备份目录里的文件和总大小，并提醒：备份在手机本机，**手机丢失或重置时会一起丢失**，重要备份要拷到电脑或云盘。
