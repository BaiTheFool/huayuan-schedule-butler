# 华园日程管家 · Agent 交接指南

> **后来接手的任何智能体/开发者，开工前必须先读本文件**，再按需读 `CONTRIBUTING.md`（团队共同开发规范）、`README.md`（给人看的完整说明）、`GOLDEN-PATH.md`（回归基线）、`ERROR_LOG.md`（踩坑档案）、`VERSION.md`（版本单一事实源）。
> 本文件与 game-hub 的 `DEVELOPER_AGENT.md`、nexus 的 `AGENTS.md` 同一套工程治理思路：先立规矩，再动手，做完必须维护文档。
> **开发者自更新契约（硬要求）**：凡参与开发的人或 Agent，任务完成前必须自行检查并更新受影响的文档（本文档 / `CONTRIBUTING.md` / `ERROR_LOG.md` / `VERSION.md` / README）。**文档不自更 = 任务未完成。**

## 0. 铁律（违反即返工）

1. **版本号只准脚本改**：发版用 `scripts\bump-version.ps1`（自动递增 VERSION.md 与 plugin.json），禁止手改版本号。
2. **遇到问题必须留档**：新问题解决后追加 `ERROR_LOG.md`（编号往下排）；运行时可复用 `scripts\error-log.js` 写 `logs/errors.jsonl`。
3. **改完必须跑回归**：`node golden-path\check.js` 及受影响 `check-*.js` 必须全过（当前全绿：49/49 等，见 `CONTRIBUTING.md` §8 清单）；**禁止删断言、跳过测试或改预期来"通过"**，失败先修根因（补 fixture 或同步正确断言，范例见 `ERROR_LOG.md` #12）。
4. **只读学校数据，不替用户做决定**：不自动提交作业/报名/缴费/改学校系统；登录由用户本人完成。
5. **敏感信息不落盘**：账号密码、验证码、Cookie、Token、学号、身份证、手机号、邮箱一律不保存不回显；页面正文不落盘。
6. **发现文档与代码不符**：以代码为准并修正本文档，不要将错就错。
7. **知识库更新必须记档**：同步上游手册后更新 `skills/huayuan-campus-manual/knowledge/000-知识库索引.md` 的同步日期，并在 ERROR_LOG.md 记录 diff。
8. **协作流程按 `CONTRIBUTING.md`**：多人协作时禁止直接提交 main，必须在独立分支开发、跑完全部测试、经 review 后合并（详见第 6 节）。
9. **文档自更新**：改了什么，就同步更新本文档 / CONTRIBUTING.md / ERROR_LOG.md / VERSION.md / README 中受影响的部分；留给后来者的过时信息 = 任务没做完。

## 1. 这是什么

「华园日程管家（本科生）」是一个 **CodeBuddy/WorkBuddy Agent 型专家插件**（`plugin.json` 里 `expertType: agent`）：

- 把华南理工大学本科生散落在 **教务系统、eCourse、雨课堂、校园门户** 的课表/作业/考试/通知，统一整理成**可追溯、可修改、可解释**的日程。
- **驾驶舱总闸**：每个用户回合先执行 `launch-dashboard.js`；即使没有 `now.json` 也进入初始化驾驶舱。驾驶舱提供双层红点、缺失项清单和可复制补全指令；手机问题使用第四个“手机工作台”标签。
- 内置 9 个技能：`huayuan-task-card`（任务卡）、`huayuan-browser-session`（浏览器读取）、`timeline-brief`（时间轴）、`huayuan-dashboard-widget`（对话内卡片）、`huayuan-live-dashboard`（外部网页驾驶舱）、`huayuan-campus-route`（大学城一日路线）、`huayuan-campus-manual`（生存手册知识库）、`huayuan-score-advisor`（绩点与操行分顾问，官方 2026 手册口径 + 计分工具）、`huayuan-mobile-remote`（手机远程工作台：只读 PWA + 配对码 + 局域网发现 + 可选公网隧道）。
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
│  ├─ huayuan-campus-manual/          # ★ 校园生存手册知识库（knowledge/ + SKILL.md）
│  ├─ huayuan-score-advisor/          # ★ 绩点与操行分顾问（官方手册口径 + gpa/conduct 计分工具）
│  └─ huayuan-mobile-remote/          # ★ 手机远程工作台（public/ PWA + scripts/ + apk/ 随包 App + references/ 教程）
├─ golden-path/                       # 回归基线：check.js + check-vXXX.js + fixtures/（虚构样例）
├─ scripts/
│  ├─ bump-version.ps1                # ★ 版本递增（改 VERSION.md + plugin.json）
│  └─ error-log.js                    # ★ 运行时错误日志（logs/errors.jsonl）
├─ logs/                              # 运行时日志（errors.jsonl），.gitkeep 占位
├─ AGENTS.md                          # ★ 本文件（Agent 交接入口）
├─ CONTRIBUTING.md                    # ★ 团队共同开发指南（分支/PR/测试/打包/版本规则）
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
node golden-path\check-score.js       # 绩点/操行分计分工具（0.11.0）
node golden-path\check-mobile.js      # 手机远程工作台（0.14.1，含 35 项冒烟）

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
| 改了团队协作流程 / 分支规范 / 测试清单 | `CONTRIBUTING.md` 对应章节 |
| 改了本文件相关事实 | 直接修正 AGENTS.md，不要留「这里可能不对」 |
| 任何改动完成后 | 自查上述清单，未更新的项补齐（**自更新 = 任务完成条件**） |

## 6. 共同开发规范（来自 CONTRIBUTING.md，团队协作必读）

> 完整版见仓库根 `CONTRIBUTING.md`。以下为硬要点，冲突时以 `CONTRIBUTING.md` 为准。

### 6.1 分支与提交纪律
- **禁止直接提交 main**：多人协作时每个任务一条独立分支，前缀 `feature/` `fix/` `test/` `docs/` `refactor/`；一个分支只解决一个问题。
- 开工前先同步：`git switch main` → `git pull --ff-only`（本地与上游分叉时用 `git merge origin/main`）→ `git switch -c <前缀>/<任务>`。
- 提交信息格式：`feat: ...` / `fix: ...` / `test: ...` / `docs: ...` / `refactor: ...`，一句话说清。

### 6.2 修改前与修改后
- 修改前：先完整读 `CONTRIBUTING.md` → `README.md` → 相关 `SKILL.md`；要改排程再读 `GOLDEN-PATH.md` 与对应测试；**先说明准备改哪些文件，再动手**。
- 修改后：跑第 3 节全部测试门禁，完整贴命令与结果；失败先修根因，禁止删断言/跳测试/改预期。

### 6.3 真实平台测试规则
- 每人用自己的学校账号与本地浏览器 Profile；登录由本人完成；遇到验证码/扫码/二次认证停下交本人。
- 不把浏览器 Profile、Cookies、运行结果发给别人或提交到 Git；测试只验证"是否读到"与字段结构，不传播个人课表/作业/姓名。

### 6.4 提交前检查与 PR
- `git status` / `git diff` 确认无 `.env`、`preferences.json`、`user-overrides.json`、`config.json`、`huayuan-output/`、浏览器 Profile、Cookie/Token、真实课表与姓名、临时文件。
- 只 `git add` 本任务相关文件；PR 目标 `main`，描述按「改了什么 / 为什么需要 / 如何验证 / 测试结果 / 风险与未完成项」五段写，至少一名队友 review 后合并。

### 6.5 打包与版本
- 源码入库不提交 ZIP：`git archive --format=zip --prefix=huayuan-schedule-butler/ --output=..\huayuan-schedule-butler.zip HEAD`（不含 `.git`、`huayuan-output/`、Profile）。
- 版本规则：修 bug `0.9.x` / 新功能 `0.x.0` / 重构 `x.0.0`；发版走 `scripts\bump-version.ps1 -Message "..."`，同步 `plugin.json`（脚本）、`VERSION.md`（脚本）、`README.md` 版本说明、相关测试。

## 7. 开发者自更新契约（硬要求）

> 这份契约是「把文档交给后来者」的保证。**参与开发的人或 Agent 都必须遵守，不自更 = 任务未完成。**

1. **完成任务前必须自查**：本次改动影响到了哪些文档（AGENTS.md / CONTRIBUTING.md / ERROR_LOG.md / VERSION.md / README / 知识库索引），把该更新的部分更新掉，不留"这里可能不对"。
2. **踩坑必须追加**：遇到并解决的问题 → `ERROR_LOG.md` 文末按模板追加（编号往下排），不要只记在脑子里或回复里。
3. **规范变更必须同步**：改了分支/测试/打包/版本等协作流程 → 同步更新 `CONTRIBUTING.md` 对应章节。
4. **结构变更必须同步**：新增/改名/删除文件或技能 → 更新本文档目录地图与 `CONTRIBUTING.md` 目录图；技能注册 → `plugin.json` + `agents/*.md` frontmatter。
5. **发现过时直接改**：发现本文件或 CONTRIBUTING 与代码不符 → 以代码为准修正文档，而不是忽略或备注"待修"。
6. **发版必须留痕**：每次升版本 → `VERSION.md` 变更日志 + `README.md` 版本说明 + ERROR_LOG 如需。
7. **交付时声明**：最终回复里说明本次更新了哪些文档（见第 8 节交付标准）。

## 8. 交付标准（每次任务结束回复用户时）

最终回复必须说明：
1. 改了什么（文件级）；
2. 为什么（根因，若为 bug 修复）；
3. 怎么验证（`node golden-path\check.js` 结果 / 定向回归 / 实测结论）；
4. 新版本号（如发版）与路径；
5. 是否新增了 `ERROR_LOG.md` / `logs/errors.jsonl` 条目；
6. **本次自更新了哪些文档**（AGENTS.md / CONTRIBUTING.md / VERSION.md / README / 知识库索引）。

## 9. 常见坑（详见 ERROR_LOG.md）

- 教务菜单 `target="_blank"` → 必须接管新标签（#01）。
- 表格视图星期错位 → 表头水平中心对齐（#03）。
- 固定 sleep 等异步 UI → 事件驱动轮询 + 进度反馈（#04）。
- 跨平台抢标签 → 会话按平台隔离（#05）。
- 空占位 iframe 不是未登录证据（#06）。
- 排程顺序：硬占用 → 任务 → 休息，禁止切碎长任务（#09）。
- 带周次的占用必须做周次相交判定（#10）。
