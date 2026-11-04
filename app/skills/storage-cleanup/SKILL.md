---
name: storage-cleanup
description: 存储清理。用户说空间不足、想清理垃圾、找大文件/重复文件、看哪个应用最占空间时使用：先统计、列出清单让用户确认，再删除或清缓存。
---

# 存储清理

**原则：先列清单，后动手。** 删除是真删手机里的文件，没有回收站。任何删除前都要把路径和大小列给用户，得到明确同意。

## 1. 先看总量

- `df -h /data`
- 内部存储一级目录占用：`du -h -d 1 /sdcard 2>/dev/null | sort -h | tail -15`

**不要**对 `/`、`/data`、`/storage` 做递归 `du`/`find`（会走进整个 /data 和 /proc，极慢）。范围始终限定在 `/sdcard/...` 或某个具体应用目录，并加 `-maxdepth`。

## 2. 找大文件

```bash
find /sdcard -xdev -type f -size +100M -printf '%s\t%TY-%Tm-%Td\t%p\n' 2>/dev/null | sort -rn | head -30 | numfmt --to=iec --field=1
```

常见大头：`/sdcard/Download`、`/sdcard/DCIM`、`/sdcard/Movies`、`/sdcard/Android/media/<包名>`（微信/QQ 的视频、语音）、`/sdcard/tencent`。

## 3. 应用占用

- 各应用数据+缓存概况：`ashell -c 'dumpsys diskstats'`（看 `App Size`、`App Data Size`、`App Cache Size` 三行，按包名对应）
- 单个应用：`du -sh /data/data/<包名> /sdcard/Android/data/<包名> 2>/dev/null`

## 4. 清理手段（由安全到激进）

1. **清所有应用缓存**（系统接口，安全）：`ashell pm trim-caches 999G`
2. **清单个应用缓存**：`rm -rf /data/data/<包名>/cache/* /data/data/<包名>/code_cache/*`，然后 `ashell restorecon -R /data/data/<包名>`
3. **删除用户确认过的文件**：逐条 `rm -- '<路径>'`，不要用通配符批量删用户没看过的文件
4. **重复文件**（限定目录）：先按大小分组再算 md5，只把内容完全相同的列出来，让用户选保留哪份

## 5. 收尾

清理后再跑一次 `df -h /data`，告诉用户腾出了多少空间。
