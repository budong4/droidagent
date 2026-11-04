---
name: screen-automation
description: 屏幕自动化。用户让你在别的应用里操作（打开应用、点按钮、填表、滑动浏览、批量重复操作、抢东西、签到）时使用：用 droid 按「观察→动作→再观察」循环可靠地操作屏幕。
---

# 屏幕自动化（droid）

## 基本循环

1. **观察**：`droid ui` —— 列出可交互控件（编号、文字、中心坐标）。比截图更准、更快，优先用它。
2. **决策**：找到目标控件的编号或文字。
3. **动作**：`droid tap-id N` / `droid tap-text 文字` / `droid tap X Y`。
4. **再观察**：动作后重新 `droid ui`（或 `droid wait-text 期望出现的文字 --timeout 8`）确认结果，**不要连续盲点**。

`droid ui` 找不到目标（游戏、WebView、自绘界面）时，改用截图：`droid shot --grid`，然后用 Read 查看 `/tmp/droid/shot.png`。截图默认 0.5 倍，**设备坐标 = 图上坐标 ÷ 0.5**。

## 常用动作

| 需求 | 命令 |
|---|---|
| 打开应用 | `droid app <包名>`（不知道包名：`droid apps 关键词`） |
| 当前前台 | `droid top` |
| 输入文字 | 先点中输入框，再 `droid text "内容"`（中文需要已安装并启用 ADBKeyboard） |
| 按键 | `droid key back` / `home` / `enter` / `recent` / `del` |
| 滑动 | `droid swipe X1 Y1 X2 Y2 300`；向下翻一屏：从屏幕 75% 高度滑到 25% |
| 长按 | `droid longpress X Y 800` |
| 点亮屏幕 | `droid wake` |

## 可靠性技巧

- 列表里找东西：滑一屏 → `droid ui` → 没找到再滑，最多滑 N 次后告诉用户没找到。
- 有加载动画时用 `droid wait-text`，不要用固定 `sleep` 猜。
- 弹窗（权限、广告、更新提示）会挡住目标：先处理弹窗再继续。
- 重复任务（比如批量点赞、逐条处理）先做一条，确认流程正确再批量执行，并在中途报告进度。

## 必须停下来问用户的

付款、转账、下单、发送消息/邮件、发帖评论、删除内容、修改账号或隐私设置。到这一步时停下，说明将要点击什么，等用户确认。
