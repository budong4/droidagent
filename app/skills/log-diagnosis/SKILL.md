---
name: log-diagnosis
description: 日志与崩溃排查。用户说某应用闪退、卡死、无响应(ANR)、耗电异常、莫名重启，或者让你看日志找原因时使用：按崩溃缓冲区、ANR、墓碑、dropbox 的顺序查，给出根因和办法。
---

# 日志与崩溃排查

全部是只读操作。日志可能很长，**始终先过滤再看**，不要把整段 logcat 读进来。

## 1. 先复现、定范围

问清是哪个应用、什么操作、大概什么时间。拿到包名后：`ashell pidof <包名>`（进程是否在运行）。

## 2. 按顺序查

| 来源 | 命令 |
|---|---|
| 崩溃缓冲区（Java 崩溃最直接） | `ashell logcat -d -b crash -t 200` |
| 该应用的日志 | `ashell -c 'logcat -d -t 2000 --pid=$(pidof <包名>)'`（进程已死就用 `logcat -d -t 3000 \| grep -i <包名>`） |
| 只看错误 | `ashell logcat -d -t 3000 '*:E'` |
| ANR | `ls -lt /data/anr/ \| head`，再看最新那份文件开头的 "Cmd line" 和主线程 "main" 的堆栈 |
| Native 崩溃（墓碑） | `ls -lt /data/tombstones/ \| head`，看 "signal"、"Abort message" 和 backtrace 前几帧 |
| 系统记录的历史崩溃 | `ashell -c 'dumpsys dropbox --print data_app_crash \| tail -80'`（也可查 `data_app_anr`、`SYSTEM_TOMBSTONE`） |
| 内核 / 重启 | `ashell logcat -d -b kernel -t 300`；重启原因 `ashell getprop sys.boot.reason` |

## 3. 解读

- Java 崩溃：找 `FATAL EXCEPTION` 后面的异常类型和第一行属于该应用自己包名的栈帧。
- ANR：主线程卡在哪（IO、锁、Binder 调用）。
- 常见根因：权限被撤销、存储满、WebView/系统组件版本问题、Xposed/LSPosed 模块注入、清数据后配置损坏。

## 4. 给出结论

一句话说明根因（附关键日志一两行作证据），再给可执行的办法：清缓存/清数据（需确认）、撤销冲突模块、更新/降级应用等。
