---
name: huayuan-dashboard-widget
description: Render a compact Huayuan Schedule Butler dashboard inside WorkBuddy with show_widget, using the latest now.json and plan.json without starting a local web server.
---

# 华园日程驾驶舱 Widget

## 用途

把 `now.json` 中的“当前第一动作、后续时段、数据状态”渲染成 WorkBuddy 对话内的紧凑 Widget。它不替代专家文本回答，也不启动本地服务器。

## 触发时机

1. 本轮外部驾驶舱已经由 `huayuan-live-dashboard` 打开后，用户明确说“在对话里看卡片”或“看卡片”时展示；
2. 用户只说“打开驾驶舱 / 看驾驶舱 / 打开网页驾驶舱 / 打开分屏”时不生成内嵌卡片，使用已经打开的外部网页驾驶舱；
3. 普通问答、初始化尚未完成或资料不完整时，不在对话内重复铺开驾驶舱；
4. 内嵌卡片不能替代外部驾驶舱，也不能阻止每个用户回合先打开外部驾驶舱。

## 执行流程

1. 确认最新结果：

```powershell
node <huayuan-browser-session技能目录>\scripts\now.js
```

2. 生成 Widget 参数：

```powershell
node <本技能目录>\scripts\build-widget.js --now <now.json> --plan <plan.json>
```

脚本输出 JSON，包含：

- `title`
- `loading_messages`
- `widget_code`
- `meta`

3. 读取 WorkBuddy 原生 `widget_guidelines` 说明（如果运行时提供），然后直接调用：

```json
{
  "title": "华园日程驾驶舱",
  "widget_code": "<脚本输出的 widget_code>",
  "loading_messages": ["正在读取最新安排…", "正在整理你的第一动作…"]
}
```

不要用 Markdown 代码块展示 `widget_code`。

## 展示内容

固定只展示：

1. 当前日期、时间和数据状态；
2. 唯一第一动作；
3. 接下来最多 3 段安排；
4. 待确认数据数量；
5. 一行修改提示。

不得在 Widget 内输出完整周表、长解释、技术架构或文件路径。

## 降级

- `show_widget` 调用失败：只回复一条文字版“第一动作 + 下一步”（`node scripts\build-widget.js --now <now.json> --text`，或取输出里的 `text_fallback`），不要生成 HTML 文件；
- `now.js` 返回 `SETUP_REQUIRED`：不生成 Widget，继续初始化引导；
- `now.json` 不存在或损坏：不伪造数据，只说明“暂时没有可展示的最新安排”。

## 数据与安全

- 只读取本机的结构化产物；
- 不在 Widget 中放姓名、学号、Cookie、Token；
- 不发起网络请求；
- 不修改学校系统；
- Widget 生成过程是确定性的，不调用大模型重新排程。
