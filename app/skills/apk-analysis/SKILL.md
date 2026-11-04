---
name: apk-analysis
description: APK 分析。用户想检查某个应用的权限、组件、签名、请求的服务器地址、是否有可疑行为，或要反编译看代码时使用。只分析用户自己手机上的、或用户有权分析的应用。
---

# APK 分析

## 1. 拿到 APK

```bash
mkdir -p /root/apk/<包名> && cd /root/apk/<包名>
for p in $(ashell pm path <包名> | sed 's/^package://'); do cp "$p" .; done; ls -lh
```

主包是 `base.apk`，其余是 split。

## 2. 快速体检（不需要额外工具）

- 清单与权限（androguard 已装）：
  ```bash
  python3 - <<'PY'
  from androguard.core.apk import APK
  a = APK("base.apk")
  print(a.get_package(), a.get_androidversion_name(), "minSdk", a.get_min_sdk_version(), "targetSdk", a.get_target_sdk_version())
  print("权限:", *sorted(a.get_permissions()), sep="\n  ")
  for kind in ("activities", "services", "receivers", "providers"):
      print(kind, len(getattr(a, "get_" + kind)()))
  PY
  ```
- 导出的组件（可被其他应用调用）：`apktool d -s -o out base.apk` 后在 `out/AndroidManifest.xml` 里找 `android:exported="true"`。
- 签名证书：`keytool -printcert -jarfile base.apk`（没有 keytool 时用 androguard 的 `a.get_certificates()`）。
- 敏感字符串：`unzip -p base.apk 'classes*.dex' | strings -n 8 | grep -Eio 'https?://[a-z0-9./?=_%:-]+' | sort -u | head -50`

## 3. 深入（需要逆向工具链）

工具链没装时（`command -v jadx` 为空），告诉用户需要先在安卓侧执行 `debian retools`（下载较大，需联网）。装好后：

- 反编译成 Java：`jadx -d src base.apk`，再在 `src/` 里 `rg` 关键词（加密、登录、上传接口等）。
- 动态观察：`frida-server start`（会弹确认），用 `frida -H 127.0.0.1:27042 -n <进程名>`；**用 `-H` 而不是 `-U`**。分析完提醒用户 `frida-server stop`。

## 4. 报告

列出：基本信息、敏感权限（定位/通讯录/短信/录音/相机/无障碍/悬浮窗）及其是否合理、导出组件风险、联系的服务器域名、可疑点。结论分「正常 / 值得注意 / 有风险」三档。
