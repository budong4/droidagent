---
name: phone-health
description: 手机体检。用户问电池、发热、卡顿、内存、存储空间、重启原因、"手机状态怎么样"时使用：一次性收集电池/温度/CPU/内存/存储/运行时间等指标，给出带结论和建议的体检报告。
---

# 手机体检

目标：几条只读命令收齐数据，最后给一份**有结论**的简短报告，而不是把原始输出贴给用户。全部是只读操作，不需要确认。

## 收集（按需挑选，能并行就并行）

| 项目 | 命令 |
|---|---|
| 电池概况 | `ashell -c 'dumpsys battery'`（level、temperature 是 0.1℃ 单位、health、status、plugged） |
| 电池细节 | `cat /sys/class/power_supply/battery/{capacity,temp,cycle_count,charge_full,charge_full_design,health} 2>/dev/null`（有的机型没有部分节点，缺了就跳过） |
| 温度 | `for z in /sys/class/thermal/thermal_zone*; do echo "$(cat $z/type) $(cat $z/temp)"; done 2>/dev/null \| sort -k2 -n \| tail -8`（单位多为毫摄氏度） |
| CPU / 负载 | `cat /proc/loadavg`；`ashell -c 'top -b -n 1 -m 10'` |
| 内存 | `grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' /proc/meminfo` |
| 存储 | `df -h /data /sdcard 2>/dev/null` |
| 运行时间 / 重启原因 | `uptime`；`ashell getprop sys.boot.reason`；`ashell getprop ro.boot.bootreason` |
| 系统 | `ashell getprop ro.product.model`、`ro.build.version.release`、`ro.build.display.id`；`uname -r` |
| 耗电大户 | `ashell -c 'dumpsys batterystats --charged \| grep -A 15 "Estimated power use"'`（输出可能很长，只取这一段） |

## 判断要点

- 电池健康：有 `charge_full` 和 `charge_full_design` 时，健康度 = 前者 / 后者；低于 80% 建议关注。`cycle_count` 有就报。
- 温度：电池 > 40℃ 或 CPU 区域 > 75℃ 算偏热，结合正在运行的前台应用和负载解释原因。
- 内存：`MemAvailable` 低于总量 10% 说明内存紧张。
- 存储：`/data` 可用 < 10% 时建议用 storage-cleanup 技能清理。

## 输出格式

先一句话总评（例如「整体健康，电池偏热」），再分条列出：电池、温度、性能、存储、其他发现，每条一行数据 + 一句解读，最后给 1~3 条具体建议。
