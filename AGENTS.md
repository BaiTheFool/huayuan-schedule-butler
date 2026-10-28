# 华园日程管家 · Agent 交接指南

> **后来接手的任何智能体/开发者，开工前必须先读本文件**，再按需读 `README.md`（给人看的完整说明）、`GOLDEN-PATH.md`（回归基线）、`ERROR_LOG.md`（踩坑档案）、`VERSION.md`（版本单一事实源）。
> 本文件与 game-hub 的 `DEVELOPER_AGENT.md`、nexus 的 `AGENTS.md` 同一套工程治理思路：先立规矩，再动手，做完必须维护文档。

## 0. 铁律（违反即返工）

1. **版本号只准脚本改**：发版用 `scripts\bump-version.ps1`（自动递增 VERSION.md 与 plugin.json），禁止手改版本号。
2. **遇到问题必须留档**：新问题解决后追加 `ERROR_LOG.md`（编号往下排）；运行时可复用 `scripts\error-log.js` 写 `logs/errors.jsonl`。
3. **改完必须跑回归**：`node golden-path\check.js`（49 项断言）必须全过；改了哪块就重跑对应 `check-*.js`（见 GOLDEN-PATH.md 第五节）。
4. **只读学校数据，不替用户做决定**：不自动提交作业/报名/缴费/改学校系统；登录由用户本人完成。
5. **敏感信息不落盘**：账号密码、验证码、Cookie、Token、学号、身份证、手机号、邮箱一律不保存不回显；页面正文不落盘。
6. **发现文档与代码不符**：以代码为准并修正本文档，不要将错就错。
7. **知识库更新必须记档**：同步上游手册后更新 `skills/huayuan-campus-manual/knowledge/000-知识库索引.md` 的同步日期，并在 ERROR_LOG.md 记录 diff。

## 1. 这是什么

「华园日程管家（本科生）」是一个 **CodeBuddy/WorkBuddy Agent 型专家插件**（`plugin.json` 里 `expertType: agent`）：

- 把华南理工大学本科生散落在 **教务系统、eCourse、雨课堂、校园门户** 的课表/作业/考试/通知，统一整理成**可追溯、可修改、可解释**的日程。
- 内置 5 个技能 + 新增 `huayuan-campus-manual`（校园知识库）：`huayuan-task-card`（任务卡）、`huayuan-browser-session`（浏览器读取）、`timeline-brief`（时间轴）、`huayuan-dashboard-widget`（对话内卡片）、`huayuan-live-dashboard`（外部网页驾驶舱）、`huayuan-campus-manual`（生存手册知识库）。
- 演示与发版基线：`golden-path/check.js`（49 项断言，离线、不登录、样例数据全虚构）。

## 2. 目录地图

```
huayuan-schedule-butler/
├─ .codebuddy-plugin/plugin.json      # 插件清单：名称/版本/技能注册（version 必须与 VERSION.md 一致）
├─ agents/huayuan-schedule-butler.md  # ★ 主 Agent 提示词（意图分流、初始化、快答、刷新、活动、可视化、安全边界）
├─ skills/
│  ├─ huayuan-browser-session/        # 浏览器会话网关 + 平台读取脚本（scripts/*.js）
│  ├─ huayuan-task-card/              # 任务卡模型、去重、排程算法、check_plan.py
│  ├─ timeline-brief/                 # 纯文本时间轴（≤8 行）
│  ├─ huayuan-dashboard-widget/       # show_widget 内嵌卡片
│  ├─ huayuan-live-dashboard/         # 外部网页驾驶舱（public/ + scripts/）
│  └─ huayuan-campus-manual/          # ★ 校园生存手册知识库（knowledge/ + SKILL.md）
├─ golden-path/                       # 回归基线：check.js + check-vXXX.js + fixtures/（虚构样例）
├─ scripts/
│  ├─ bump-version.ps1                # ★ 版本递增（改 VERSION.md + plugin.json）
│  └─ error-log.js                    # ★ 运行时错误日志（logs/errors.jsonl）
├─ logs/                              # 运行时日志（errors.jsonl），.gitkeep 占位
├─ AGENTS.md                          # ★ 本文件
├─ ERROR_LOG.md                       # ★ 踩坑档案（人工维护）
├─ GOLDEN-PATH.md                     # 演示脚本 + 验收检查表
├─ README.md                          # 完整用户/开发者说明
└─ VERSION.md                         # ★ 版本单一事实源 + 变更日志
```

**grep 速查**（需要细节时按符号定位，别整读大文件）：
`session-gateway.js`（会话网关）、`first-run.js`（向导）、`now.js`（现在该干什么）、`schedule-analyze.js`（排程）、`manage-items.js`（覆盖层）、`activity-feed.js`（校园活动）、`period-times.js`（节次时间）、`privacy.js`（脱敏）。

## 3. 常用命令

```powershell
# 全量回归（发版前必跑）
node golden-path\check.js
# 定向回归（改了对应区域）
node golden-path\check-v081.js        # 排程
node golden-path\check-ecourse-ux.js  # eCourse 初始化体验
node golden-path\check-widget.js      # Widget
node golden-path\check-v060.js        # 可视化路径
node golden-path\check-performance.js # 性能
node golden-path\check-activities.js  # 校园活动

# 单步脚本（示例）
node skills\huayuan-browser-session\scripts\first-run.js --wizard --login
node skills\huayuan-browser-session\scripts\now.js
node skills\huayuan-browser-session\scripts\schedule-analyze.js --validate
node skills\huayuan-browser-session\scripts\manage-items.js set-college --name <学院>

# 版本递增（发版）
powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1 -Message "<一句话变更>"
# 错误日志
node scripts\error-log.js --code <CODE> --message "<原因>" [--severity warn] [--context '<JSON>']
node scripts\error-log.js --stat
```

## 4. 数据与隐私边界（不可放宽）

- 浏览器会话按平台隔离：`cas`（门户+教务）/ `ecourse` / `rain`，互不共享 Cookie；同一时刻只允许一个 Chrome。
- 登录只能由用户本人完成（`AUTH_REQUIRED:<平台>` 即弹出可见窗口等待本人操作）；教务常有二次认证（微信企业号/短信），脚本无法代办。
- 只读、不猜接口：结构不符时输出诊断（`anchors / json_responses / attempts`），不编造数据。
- 脱敏规则：URL 中 `ticket/token/code/sessionid` 写 `***`；学号类长数字、身份证、手机号、邮箱自动打码；课表标题行（姓名+学号）跳过；名单/成绩页面整段跳过。
- 读不到≠没有：`READ_PARTIAL` 必须标「待确认」；0 条只在页面确认空时才说「没有」。

## 5. 维护契约（改完必须做）

| 你改了什么 | 必须同步更新 |
|---|---|
| 新增/修改技能 | `plugin.json` 的 `skills` 数组 + `agents/*.md` 的 frontmatter `skills` + README 对应章节 |
| 改了开场白/初始化/快答/排程文案 | `golden-path/check.js` 对应断言 + GOLDEN-PATH.md 第五节对应条目 |
| 改了排程规则/覆盖层 | 重跑 `check-v081.js` / `check.js` |
| 修复了问题 | `ERROR_LOG.md` 追加一条（模板见该文件顶部） |
| 发了新版本 | `scripts\bump-version.ps1 -Message "..."`（自动 VERSION.md + plugin.json） |
| 同步了手册知识库 | `knowledge/000-知识库索引.md` 同步日期 + ERROR_LOG.md 记录 diff |
| 改了本文件相关事实 | 直接修正 AGENTS.md，不要留「这里可能不对」 |

## 6. 交付标准（每次任务结束回复用户时）

最终回复必须说明：
1. 改了什么（文件级）；
2. 为什么（根因，若为 bug 修复）；
3. 怎么验证（`node golden-path\check.js` 结果 / 定向回归 / 实测结论）；
4. 新版本号（如发版）与路径；
5. 是否新增了 `ERROR_LOG.md` / `logs/errors.jsonl` 条目。

## 7. 常见坑（详见 ERROR_LOG.md）

- 教务菜单 `target="_blank"` → 必须接管新标签（#01）。
- 表格视图星期错位 → 表头水平中心对齐（#03）。
- 固定 sleep 等异步 UI → 事件驱动轮询 + 进度反馈（#04）。
- 跨平台抢标签 → 会话按平台隔离（#05）。
- 空占位 iframe 不是未登录证据（#06）。
- 排程顺序：硬占用 → 任务 → 休息，禁止切碎长任务（#09）。
- 带周次的占用必须做周次相交判定（#10）。
