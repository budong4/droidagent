---
name: network-diagnosis
description: 网络诊断。用户说网络慢、连不上、Wi-Fi/移动数据异常、某网站或应用打不开、想看哪个应用耗流量、测网速时使用：逐层检查接口、路由、DNS、连通性和代理/VPN。
---

# 网络诊断

Debian 环境和安卓共用网络栈，`ping`、`curl`、`ip`、`dig` 都可以直接用；安卓侧信息用 `ashell dumpsys`。

## 逐层检查

| 层 | 命令 |
|---|---|
| 当前网络 | `ashell -c 'dumpsys connectivity \| grep -E "NetworkAgentInfo|VALIDATED|CAPTIVE" \| head -20'` |
| 接口与地址 | `ip -br addr`；默认路由 `ip route` |
| Wi-Fi 详情 | `ashell -c 'dumpsys wifi \| grep -E "mWifiInfo|RSSI|Link speed|Frequency" \| head'` |
| 移动网络 | `ashell -c 'dumpsys telephony.registry \| grep -E "mServiceState|mSignalStrength" \| head -4'` |
| DNS | `dig +short baidu.com`、`dig +short google.com`；对比 `dig @223.5.5.5 域名` 判断是否 DNS 问题 |
| 连通性 | `ping -c 4 223.5.5.5`（IP 层）→ `curl -sI -m 8 https://www.baidu.com`（HTTP 层） |
| 代理 / VPN | `ashell -c 'dumpsys connectivity \| grep -i vpn \| head'`；本机代理端口 `ss -ltnp \| grep -E ":(7890|7897|10809|2080)\b"` |
| 流量排行 | `ashell -c 'dumpsys netstats --uid \| head -60'`，按 uid 汇总后用 `ashell pm list packages -U` 对应到包名 |

## 测速（会消耗流量，先告诉用户大约多少）

```bash
curl -o /dev/null -s -w '下载 %{speed_download} B/s，用时 %{time_total}s\n' https://speed.cloudflare.com/__down?bytes=20000000
```

## 判断

- IP 通、域名不通 → DNS 问题；HTTP 不通但 ping 通 → 防火墙/代理/证书问题。
- 能上国内站、上不了境外站 → 正常网络环境限制，看 VPN/代理是否生效（注意：很多 VPN 的分应用模式不转发 root 进程的流量）。
- 结论先行，再列证据和建议。
