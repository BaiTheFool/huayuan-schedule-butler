# 华园日程驾驶舱 Widget 扩展

该目录是「华园日程管家」的独立扩展，不修改主专家包。

## 能力

- 读取最新 `now.json`；
- 生成适合 WorkBuddy `show_widget` 的内联 HTML；
- 展示唯一第一动作、接下来最多 3 段安排和数据状态；
- 不启动本地服务器；
- 不依赖外网脚本；
- Widget 小于 30KB；
- 生成结果可重复，不调用大模型重新排程。

## 测试

```powershell
node scripts\build-widget.js --self-check
```

## 生成

```powershell
node scripts\build-widget.js --now <路径>\now.json
```

输出 JSON：

```json
{
  "title": "华园日程驾驶舱",
  "loading_messages": ["正在读取最新安排…", "正在整理你的第一动作…"],
  "widget_code": "<HTML>",
  "meta": {}
}
```

Agent 应把 `widget_code` 直接传给 WorkBuddy 原生 `show_widget`，不要把 HTML 作为 Markdown 代码块展示。

## 合并到专家包

主包完成当前的并发修改后：

1. 把本目录复制为：
   `workbuddy-expert\huayuan-schedule-butler\skills\huayuan-dashboard-widget`
2. 在 `.codebuddy-plugin/plugin.json` 的 `skills` 数组注册；
3. 在 Agent 定义中加入 `SKILL.md` 的触发规则；
4. 重新执行全部测试并打包。
