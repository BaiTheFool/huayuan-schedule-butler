# 华园日程管家共同开发指南

本文面向第一次参与多人开发的队友。目标不是让每个人先学会全部技术，而是保证大家能安全地：

1. 克隆私有仓库；
2. 在自己的分支修改；
3. 跑自动测试；
4. 提交 Pull Request；
5. 由维护者合并到 `main`；
6. 打包并安装成 WorkBuddy 专家测试。

当前版本：`0.14.0`
仓库：<https://github.com/BaiTheFool/huayuan-schedule-butler>  
主分支：`main`

---

## 1. 先了解项目是什么

这是一个面向华南理工大学本科生的 WorkBuddy 专家包。它负责：

- 在用户本人登录后，读取教务课表、eCourse、雨课堂和校园门户；
- 把课程、作业、考试和通知转换成统一任务卡；
- 根据截止时间、预计耗时、作息与偏好生成日程；
- 回答“我现在该干什么”；
- 支持临时加课、加任务、加休息和重新排程；
- 提供“今日安排、全部待办、可参与事项”三页本地 WebUI；
- 从公开网页抓取学校及学院活动信息。

核心原则：

- 只读学校平台，不自动提交作业、不报名、不缴费；
- 不保存密码、验证码、Cookie、Token；
- “没读到”不等于“没有”；
- 不编造截止时间、标题和提交状态；
- 不直接修改 WorkBuddy 安装缓存；
- 不提交真实课表、作业、姓名、学号、个人偏好等本机数据。

---

## 2. 获取仓库权限和代码

### 2.1 接受 GitHub 邀请

仓库是私有的。维护者需要先在：

```text
Settings → Collaborators / Manage access → Add people
```

邀请队友的 GitHub 账号。队友接受邀请后才能访问。

### 2.2 使用 GitHub Desktop 克隆

1. 打开 GitHub Desktop；
2. 选择 `File → Clone repository`；
3. 选择 `URL`；
4. 填入：

```text
https://github.com/BaiTheFool/huayuan-schedule-butler.git
```

5. 选择一个容易找到的本地目录；
6. 点击 `Clone`。

### 2.3 或使用命令行克隆

```powershell
git clone https://github.com/BaiTheFool/huayuan-schedule-butler.git
cd huayuan-schedule-butler
```

首次开发如果 Git 没有身份信息，需要设置自己的 GitHub 用户名和邮箱：

```powershell
git config user.name "你的名字"
git config user.email "你的 GitHub 邮箱"
```

不要统一使用同一个人的身份提交。

---

## 3. 项目目录怎么读

```text
huayuan-schedule-butler/
├─ .codebuddy-plugin/
│  └─ plugin.json
├─ agents/
│  └─ huayuan-schedule-butler.md
├─ avatars/
│  └─ expert.png
├─ skills/
│  ├─ huayuan-browser-session/
│  ├─ huayuan-task-card/
│  ├─ timeline-brief/
│  ├─ huayuan-dashboard-widget/
│  ├─ huayuan-live-dashboard/
│  ├─ huayuan-campus-manual/   校园生存手册知识库（CC0，46 份知识文件）
│  ├─ huayuan-score-advisor/   绩点与操行分顾问（官方手册口径 + gpa/conduct 计分工具）
│  └─ huayuan-mobile-remote/   手机远程工作台（只读 PWA + 配对码 + 可选公网隧道）
├─ scripts/
│  ├─ bump-version.ps1         版本递增（VERSION.md + plugin.json 自动同步）
│  └─ error-log.js             运行时错误日志（logs/errors.jsonl）
├─ logs/                       运行时日志目录
├─ golden-path/
├─ README.md
├─ GOLDEN-PATH.md
├─ AGENTS.md                   后来 Agent 的交接入口（必读）
├─ CONTRIBUTING.md
├─ ERROR_LOG.md                踩坑档案（人工维护，后来者必读）
├─ VERSION.md                  版本单一事实源 + 变更日志
└─ .gitignore
```

### 3.1 `.codebuddy-plugin/plugin.json`

专家包清单。

重要字段：

- `name`：`huayuan-schedule-butler-v2`，不要随意修改；
- `version`：当前版本；
- `skills`：注册技能；
- `displayDescription`：平台展示介绍；
- `quickPrompts`：平台快捷入口。

修改功能后通常需要升级版本号。

### 3.2 `agents/huayuan-schedule-butler.md`

Agent 的主提示词，定义：

- 什么时候调用哪个技能；
- 初始化、日常快答、排程修正和活动刷新的工作流；
- 回答风格；
- 数据可信度和安全边界。

如果新增一个用户入口，需要同步更新这里。

### 3.3 `skills/huayuan-browser-session/`

负责学校平台访问：

```text
session-gateway.js       启动和复用独立浏览器会话
session-probe.js         静默检查登录态
campus-sync.js           校园门户
jw-timetable.js          教务课表
ecourse-pull.js          eCourse 作业、测试、问卷、讨论
rain-fast.js             雨课堂待办
onboarding.js            初始化流程
first-run.js             初始化命令入口
preferences.js           作息与学习偏好
user-overrides.js        本地完成、延后、临时事项
schedule-analyze.js      周计划、时间切片和冲突计算
now.js                   “我现在该干什么”
manage-items.js          用户修正命令
activity-feed.js         公开活动公告抓取
colleges.js              42 个学院/书院官网目录
```

### 3.4 `skills/huayuan-task-card/`

统一任务卡规范、平台来源说明和 `check_plan.py`。

改任务卡字段或排程输出时，先阅读：

```text
skills/huayuan-task-card/references/task-card-schema.md
skills/huayuan-task-card/references/source-platforms.md
```

### 3.5 `skills/timeline-brief/`

生成不超过 8 行的纯文本时间轴，适合对话里的快速回答。

### 3.6 `skills/huayuan-dashboard-widget/`

在 WorkBuddy 对话中生成内嵌卡片。只展示第一动作、最多 3 段安排和数据状态。

### 3.7 `skills/huayuan-live-dashboard/`

本地只读网页驾驶舱：

```text
public/index.html        今日安排
public/todo.html         全部待办
public/activities.html   可参与事项
scripts/dashboard-server.js
scripts/launch-dashboard.js
```

网页只绑定 `127.0.0.1`，没有聊天输入框，不直接修改学校系统。

### 3.8 `skills/huayuan-mobile-remote/`

手机远程工作台（只读，供手机浏览器打开）：

```text
public/index.html                单页工作台（今日 / 待办 / 活动 / 本周 / 设置 + 配对页）
public/app.js · public/styles.css
public/manifest.webmanifest      可“添加到主屏幕”
public/icon*.png · icon.svg      运行时生成的图标（scripts/make-icons.js）
scripts/remote-server.js         只读服务端：令牌 + 配对码 + 静态白名单
scripts/launch-remote.js         启动器：找最新 now.json、打印局域网/公网地址与配对码
test/smoke.js                    32 项冒烟（启动 → 配对 → 只读接口 → 安全 → 停止）
lib/snapshot.js（在 huayuan-live-dashboard 下）  驾驶舱与手机端共用的只读快照层
```

默认监听 `0.0.0.0` 供手机访问，所有 `/api/*`（除 `/api/health`）都要令牌；只读 `now.json` / `plan.json` / `activity-feed.json`，不写文件、不读 Cookie。

### 3.9 `golden-path/`

离线回归测试。`fixtures/` 里的数据全是虚构样例，不包含真实学生数据。

---

## 4. 开发环境

主要开发和测试环境是 Windows。

建议安装：

- Git
- GitHub Desktop
- Node.js 22 或兼容版本
- Python 3
- WorkBuddy
- Chrome 或 Edge

项目主体只使用 Node.js 内置模块。真实浏览器读取依赖 WorkBuddy 自带的 Node/Playwright 运行环境，不要另外把整个 `node_modules` 提交进仓库。

验证环境：

```powershell
node --version
python --version
git --version
```

---

## 5. 每个人必须使用自己的分支

不要把四个人的修改直接提交到 `main`。

每次开发前先同步：

```powershell
git switch main
git pull --ff-only
```

创建一个有意义的分支：

```powershell
git switch -c feature/activity-filter
```

推荐前缀：

- `feature/`：新增功能；
- `fix/`：修复问题；
- `test/`：测试；
- `docs/`：文档；
- `refactor/`：不改变行为的重构。

一个分支只解决一个问题。不要把“修 eCourse、改 WebUI、升版本”混在一个超大提交里。

---

## 6. 修改代码前先让 Agent 读规范

队友可以把下面这段直接交给自己的 AI Agent：

```text
你正在协助开发 GitHub 仓库 BaiTheFool/huayuan-schedule-butler。

开始修改前必须先完整阅读：
1. CONTRIBUTING.md
2. README.md
3. 与任务相关的 SKILL.md
4. 如需修改排程，再读 GOLDEN-PATH.md 和对应测试

工作约束：
- 当前只做华南理工大学本科生场景。
- 学校平台只读，不自动提交作业、不报名、不缴费。
- 不索要、保存、打印或提交密码、验证码、Cookie、Token、姓名、学号或真实课表。
- 不直接修改 %USERPROFILE%\.workbuddy\plugins 下的安装缓存；只修改当前 Git 仓库。
- 不删除现有测试，不通过放宽断言伪造通过。
- 先说明准备修改哪些文件，再开始改。
- 修改后运行相关测试，并把完整命令和结果贴出来。
- 最终汇报：改动文件、行为变化、测试结果、已知风险和未完成项。

我当前的分支是：<填写分支名>
我要解决的问题是：<填写具体需求>
验收标准是：<填写可验证结果>
```

不要只对 Agent 说“帮我优化一下”。要给出可验证的输入、输出和失败条件。

---

## 7. 常见任务应改哪里

| 任务 | 主要文件 |
|---|---|
| 修改专家开场、触发词和工作流 | `agents/huayuan-schedule-butler.md` |
| 增加学校平台读取 | `skills/huayuan-browser-session/scripts/` |
| 修改初始化问题 | `onboarding.js`、`preferences.js` |
| 修改任务卡字段 | `huayuan-task-card`、`schedule-analyze.js` |
| 修改优先级或排程 | `schedule-analyze.js`、`now.js` |
| 修改“现在该干什么” | `now.js` |
| 增加完成、延后、临时事项 | `manage-items.js`、`user-overrides.js` |
| 修改活动抓取 | `activity-feed.js`、`colleges.js` |
| 修改网页页面 | `huayuan-live-dashboard/public/` |
| 修改网页数据接口 | `dashboard-server.js`、`huayuan-live-dashboard/lib/snapshot.js` |
| 修改手机工作台页面 / 接口 / 配对逻辑 | `huayuan-mobile-remote/public/`、`remote-server.js`、`launch-remote.js` |
| 修改绩点/GPA/操行分/综合测评口径或计分 | `huayuan-score-advisor/scripts/`（计分脚本 + `knowledge/` 常量表双份同步） |
| 修改平台展示 | `.codebuddy-plugin/plugin.json` |
| 增加回归 | `golden-path/` |

修改数据字段时要同时检查：

1. 数据生产脚本；
2. JSON 结构；
3. 页面读取逻辑；
4. `now.js` 或排程逻辑；
5. 对应测试。

---

## 8. 每次修改必须跑哪些测试

在仓库根目录执行：

```powershell
node golden-path/check.js
node golden-path/check-v060.js
node golden-path/check-widget.js
node golden-path/check-v081.js
node golden-path/check-activities.js
node golden-path/check-performance.js
node golden-path/check-score.js
node golden-path/check-mobile.js
node skills/huayuan-live-dashboard/test/smoke.js
node skills/huayuan-mobile-remote/test/smoke.js
node skills/huayuan-browser-session/scripts/manage-items.js --self-check
node skills/huayuan-browser-session/scripts/activity-feed.js --self-check
```

如果改了 eCourse 登录体验，再运行：

```powershell
node golden-path/check-ecourse-ux.js
```

至少要保证：

- `GOLDEN_PATH:PASS`
- `V060:PASS`
- `WIDGET:PASS`
- `V081:PASS`
- `ACTIVITIES:PASS`
- `PERFORMANCE:PASS`
- `SCORE_GATE:PASS`
- `MOBILE:PASS`
- `MOBILE_REMOTE_SMOKE:PASS`
- `LIVE_DASHBOARD_SMOKE:PASS`
- `SELF_CHECK:PASS`

测试失败时，先修复失败项，不要通过删除断言、跳过测试或修改预期来“解决”。

---

## 9. 本地测试 WebUI

先准备一份包含 `now.json`、`plan.json` 和 `activity-feed.json` 的输出目录。

启动：

```powershell
node skills/huayuan-live-dashboard/scripts/launch-dashboard.js --now "<输出目录>\now.json" --no-open
```

终端会输出：

```text
LIVE_DASHBOARD_READY:http://127.0.0.1:<端口>/
```

页面：

```text
http://127.0.0.1:<端口>/
http://127.0.0.1:<端口>/todo.html
http://127.0.0.1:<端口>/activities.html
```

只修改前端时，可以先启动服务，再刷新页面观察变化。涉及 `dashboard-server.js` 时必须重启服务。

### 9.1 本地测试手机工作台

```powershell
node skills/huayuan-mobile-remote/scripts/launch-remote.js --now "<输出目录>\now.json" --no-open
```

终端会输出手机地址、6 位配对码和一条本机直连链接：

```text
MOBILE_REMOTE_READY:http://<局域网IP>:4320/
MOBILE_REMOTE_PAIR:123456
MOBILE_REMOTE_LOCAL:http://127.0.0.1:4320/?k=<令牌>
```

本机验证不需要手机：打开 `MOBILE_REMOTE_LOCAL` 会跳过配对直接进入；要验证配对流程，用无痕窗口打开 `MOBILE_REMOTE_READY` 再输配对码。只改前端时刷新页面即可；改了 `remote-server.js` 要 `--stop` 后重启。手机与电脑不在同一网络时加 `--tunnel`（需本机安装 `cloudflared`）。

---

## 10. 真实平台测试规则

- 每个队友使用自己的学校账号；
- 每人使用不同的本地浏览器 Profile；
- 登录必须由本人完成；
- 不把浏览器 Profile 发给别人；
- 不把运行结果、Cookies 文件或浏览器缓存提交到 Git；
- 遇到验证码、扫码或二次认证时停下来，由本人完成；
- 不允许为了“测试方便”绕过认证；
- 测试失败时保留脱敏状态，不贴完整票据 URL。

真实测试建议只验证“是否读到了”和字段结构，不要把个人课表、作业和姓名发到群里。

---

## 11. 提交前检查

查看修改：

```powershell
git status
git diff
```

确认没有：

- `.env`
- `preferences.json`
- `user-overrides.json`
- `config.json`
- `huayuan-output/`
- 浏览器 Profile
- Cookie、Token、验证码
- 真实课表、作业和姓名
- 临时调试文件
- 无关 ZIP 和截图

只暂存本次任务相关文件：

```powershell
git add <文件1> <文件2>
```

注意：**唯一例外**是 `golden-path/fixtures/preferences.json`——它是黄金路径离线回归的虚构样例偏好（文件内有 `_note` 声明），已在 `.gitignore` 显式放行；除此之外任何位置的 `preferences.json`（真实用户偏好）一律禁止提交。

提交信息使用简短、明确的格式：

```text
feat: add college activity filters
fix: preserve task duration across rest blocks
test: cover activity deadline extraction
docs: explain clean-machine setup
```

示例：

```powershell
git commit -m "feat: add college activity filters"
git push -u origin feature/activity-filter
```

---

## 12. 创建 Pull Request

推送分支后：

1. 打开 GitHub 仓库；
2. GitHub 会提示 `Compare & pull request`；
3. 目标分支选 `main`；
4. 写清：
   - 解决了什么问题；
   - 修改了哪些用户可见行为；
   - 如何复现和测试；
   - 哪些能力还没有做；
   - 是否涉及隐私或登录；
5. 创建 PR；
6. 等至少一名队友审查；
7. 测试通过后再合并。

PR 描述模板：

```markdown
## 改了什么

## 为什么需要

## 如何验证

## 测试结果

## 风险与未完成项
```

不要在 PR 中附带真实学生数据。

---

## 13. 合并后同步主分支

合并成功后，每个人：

```powershell
git switch main
git pull --ff-only
```

然后从最新 `main` 新建下一条功能分支：

```powershell
git switch -c feature/next-task
```

---

## 14. 遇到冲突怎么办

如果 GitHub 提示冲突：

```powershell
git switch main
git pull
git switch feature/your-branch
git merge main
```

GitHub Desktop 会列出冲突文件。处理原则：

- 不要整份覆盖别人的修改；
- 先读懂两边为什么改；
- 保留双方需要的行为；
- 修改后重跑测试；
- 冲突没解决时不要强行提交或强制推送。

命令行中：

```powershell
git merge --abort
```

可以放弃本次合并，回到操作前。应先保存和确认当前修改。

---

## 15. 打包和安装测试

仓库保存源码，不提交 ZIP。打包当前已提交版本：

```powershell
git archive --format=zip --prefix=huayuan-schedule-butler/ --output=..\huayuan-schedule-butler.zip HEAD
```

然后在 WorkBuddy 的专家管理中心导入生成的 ZIP，进行实际测试。

注意事项：

- 打包前先提交并跑测试；
- ZIP 必须包含顶层目录 `huayuan-schedule-butler/`；
- 不要把 `.git` 打进 ZIP；
- 不要把本机 `huayuan-output` 和浏览器 Profile 打进 ZIP；
- 安装测试使用当前分支构建的 ZIP，不要直接编辑安装缓存里的脚本。

---

## 16. 版本号规则

当前插件名固定：

```text
huayuan-schedule-butler-v2
```

- 修 bug：`0.9.x`
- 新增用户可见功能：`0.x.0`
- 大幅重构或协议变更：`x.0.0`

发版动作统一用脚本，**不要手改版本号**：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1 -Message "<一句话变更>"
```

脚本自动递增 `VERSION.md`（单一事实源）与 `.codebuddy-plugin/plugin.json` 的版本号。之后每次升版本至少同步：

1. `.codebuddy-plugin/plugin.json`（脚本已同步）
2. `VERSION.md` 变更日志（脚本已追加）
3. `README.md` 的版本说明（手动补一行）
4. 相关测试或新增回归

不要只改 README 里的版本号而漏改 `plugin.json`；`VERSION.md` 与 `plugin.json` 的版本号必须一致。

---

## 17. 当前已知限制

- eCourse 偶尔出现“总数 N、解析 M”的差额，必须保持 `READ_PARTIAL`。
- 教务系统可能需要校园网、VPN 和二次认证。
- 微信公众号和班级群属于私域，暂不做不稳定自动抓取。
- 学院官网模板很多，活动栏目需要持续验证。
- Chrome 是当前主链路，其他浏览器回退仍需完善。
- `golden-path` 全量测试当前**全部通过**（`GOLDEN_PATH:PASS 49/49`、`SCORE_GATE:PASS 16/16` 等）。历史上的基线缺口（上游 v0.9.0 遗留：fixtures 缺 `preferences.json`、技能数断言 5→6）已在 0.10.1 修复并记录于 `ERROR_LOG.md` #11/#12。修复这类问题时**不要**删断言或改预期来"通过"，先按 #12 的做法补真实 fixture / 同步正确断言。
- `huayuan-score-advisor` 计分口径基于《2026 本科生手册》官方条文（学籍管理办法 2026 修订第 39 条等）；**各院（系）综合测评实施细则可在校级办法基础上微调加分认定**，计分结果以院（系）细则与官方最新通知为准。四分制 GPA 的动态转换需要课程班排名，只有分数时工具会标记无法精算。
- 当前开发版本是 `0.14.0`；本地版本和开放平台审核版本可能不同步。
- 文档维护契约：`AGENTS.md`（Agent 交接）与 `CONTRIBUTING.md`（团队协作）必须由开发者自行保持与代码同步，发现过时直接改。

---

## 18. 团队建议分工

可以按以下方向并行：

- 平台适配：教务、eCourse、雨课堂、校园门户；
- 活动数据：学院来源、公众号补充、截止时间解析；
- 排程算法：优先级、休息、任务拆分、冲突解释；
- WebUI：三页驾驶舱、交互、移动端适配；
- 测试与演示：干净电脑安装、真实用户试用、答辩素材。

每个任务都应该有：

- 一个明确负责人；
- 一个独立分支；
- 一个可验证验收标准；
- 至少一名其他成员 review。

---

## 19. 禁止事项

- 禁止直接向 `main` 推送未经测试的大型改动；
- 禁止提交真实个人信息、个人课表和个人登录状态；
- 禁止把密码、Cookie、Token 写入代码或文档；
- 禁止通过修改测试让错误代码变“通过”；
- 禁止为了演示修改学校系统数据；
- 禁止把“未读到”描述成“没有任务”；
- 禁止让 AI 自行猜测无法验证的截止时间和身份字段；
- 禁止把 API Key、邮箱验证码和个人账号写入仓库。

---

## 20. 最短上手清单

新队友只需先完成这套动作：

1. 接受 GitHub 邀请；
2. 克隆私有仓库；
3. 运行全部离线测试；
4. 按 `CONTRIBUTING.md` 把项目交给自己的 Agent；
5. 从 `main` 创建 `feature/...`；
6. 修改一个小问题；
7. 跑相关测试；
8. 提交并推送分支；
9. 创建 Pull Request；
10. 等 review 后合并。

建议第一项练手任务选择一个低风险功能，例如：

- 网页筛选按钮；
- 活动来源展示；
- README 文案；
- 新增一条离线测试；
- 修复一个明确的 UI 间距问题。

不要一开始就同时重构登录、排程和 WebUI。
