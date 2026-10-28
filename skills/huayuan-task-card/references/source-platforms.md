# 来源平台读取要点与支持矩阵

> 实测环境：Windows 10/11，WorkBuddy 5.8.3，Chrome 131，隔离的独立浏览器配置（persistent profile）。
> **以下为 2026-10-27 至 10-28 的实测结论；平台页面结构会变化，每次使用前应重新做一次轻量自检。**

## 一、平台支持矩阵

| 平台 | 入口（学校通用域名） | 结果 | 登录方式 | 读取方式 / 可读内容 |
|------|---------|------|---------|---------|
| 华南理工大学官网 | `www.scut.edu.cn` | ✅ 公开可读 | 无需登录 | 直接读页面文本（标题 + 正文） |
| 本科生院（教务处主页） | `jw.scut.edu.cn` | ✅ 公开可读 | 无需登录 | 栏目页、通知公告（非个人数据） |
| 研究生院 | `www2.scut.edu.cn/graduate/` | ✅ 公开可读 | 无需登录 | 通知公告栏目 |
| 校园门户 | `my.scut.edu.cn` | ⚠️ 需登录 | 统一认证（CAS） | 首页可见区、待办、校历 |
| 统一身份认证 | `sso.scut.edu.cn/cas/login` | ✅ 可达 | 扫码 / 微信 / 账号 | **只由用户本人操作**，智能体不碰表单 |
| eCourse | `ecourse.scut.edu.cn`（根地址） | ⚠️ 需登录（独立会话） | eCourse 页面内登录 | 课程枚举、作业 / 测试 / 问卷 / 讨论 |
| 教务学生端 | `xsjw2018.jw.scut.edu.cn` | ⚠️ 需登录（随 CAS） | CAS 自动转发 | 课表、考试安排（不读成绩、不改数据） |
| 雨课堂（校级） | `scut.yuketang.cn` | ⚠️ 需登录（独立会话） | 雨课堂登录 | 课程待办、截止时间 |
| 学堂云 | `xtu.yuketang.cn` | ⚠️ 可达但加载慢 | 需登录 | 课程资料；30 秒超时要重试 |
| 课程群（QQ / 微信） | — | ❌ 无直接读取能力 | — | 只能由用户粘贴或导出后交给你 |

### 必读：多平台是分别登录、分别授权

- **统一认证只解决门户与教务**；eCourse 需要在其页面内单独登录；雨课堂有完全独立的会话。
- 因此**不能承诺"一次登录就能读取全部平台"**。脚本会如实输出 `AUTH_REQUIRED:<平台>` / `AUTH_WAIT:<平台>`，缺哪个平台就只补哪个。
- 首次运行向导里没勾选的平台，脚本会输出 `PLATFORM_NOT_AUTHORIZED` 并跳过，不会偷偷打开页面。

## 二、会话与 Profile

必须使用 `skills/huayuan-browser-session`。Profile 根目录**跟随当前 Windows 用户**，不含写死路径：

```text
%USERPROFILE%\.workbuddy\huayuan-schedule-butler\profiles\<profile-id>\
```

- `<profile-id>` 默认 `default`，可用 `--profile-id acc-a` 另开槽位。
- **同一台电脑切换不同账号必须换槽位**，共用槽位会导致 Cookie 互相覆盖、读到别人数据或登录态反复失效。
- 匿名配置在 `%USERPROFILE%\.workbuddy\huayuan-schedule-butler\config.json`（学生类型 / 授权平台 / 槽位名）。
- 输出默认写当前工作区 `huayuan-output\<时间戳>\`。

标准状态机：

```text
（首次）first-run.js 选学生类型 / 授权平台 / 槽位
→ session-probe.js 无头检查
→ 有效：无头读取 → 关闭
→ 无效：AUTH_REQUIRED:<平台>
→ 打开一次可见浏览器
→ AUTH_WAIT:<平台>
→ 用户本人登录
→ AUTH_LOGIN_OK:<平台>
→ 同一会话立即读取
→ 完成后关闭
```

关键规则：

1. 平时不得主动弹出浏览器；只有登录失效时才显示窗口。
2. 用户必须在专用窗口本人登录；智能体不碰账号、密码、验证码。
3. 校园门户、eCourse 和教务系统使用 CAS 单会话 Cookie，**关窗后可能立即失效**。登录后不得先关窗再重开，必须同上下文读取。
4. 雨课堂会话相对持久，但仍必须走同一套无头优先流程。
5. 不读取、导出、打印或落盘 Cookie、Token、票据、动态认证请求头。页面自然生成的静态标识头只允许在内存中用于当次请求。
6. 同一槽位同时只允许一个进程；检测到 `PROFILE_BUSY` 立即停止。
7. 登录等待默认 5 分钟；超时输出 `AUTH_TIMEOUT:<平台>`，关闭会话，用户下次重跑。
8. HTTP 200 不代表业务成功：必须同时检查业务 `success`、数据结构与登录跳转。
9. 单门课程读取失败不阻断其他课程；全部失败或认证过期时不得输出"零任务"。

## 三、各平台读取要点

### 3.1 eCourse

- 入口只用根地址 `https://ecourse.scut.edu.cn/`，**跟随 302** 到带 id 的门户页；不拼接、不直接访问无 id 的 `index.html`。
- 课程列表在门户 iframe `getCourses.html?whichCourse=study`；课堂内容在 `web/templet/` 下的 exercise / testPaperList_student / surveyList_student / discussion 四个子页。
- `discussion` 普通帖子只有作者、发布时间、浏览数和回复按钮，没有截止时间或提交状态；默认记为 `informational`，不计入待办或 `unparsed_count`。只有页面明确要求回复、跟帖计分或存在回帖截止时，才转成待确认任务。
- 课程 id **全部动态枚举**，不写死任何 id。
- 判定：含「已提交 / 已完成 / 已作答」= 完成；只有「未提交 / 未完成 / 未作答 / 去提交」= 待办；「已过期」≠ 未提交；`记录总数=0` 直接返回空结构。
- 已知坑：门户页会预置多个 `src` 与自身同址的**空占位 iframe**，`ECOURSE_SELF_EMBED_LOOP` 只能当告警，**不能当"未登录"证据，也不能阻断导航**。
- 顶层被跳到 `xsjw` 时输出 `ECOURSE_TOP_REDIRECTED_TO_JW` 并中止该次导航。

### 3.2 雨课堂

- 课程数据来自 `user-courses` 接口（页内 fetch，`credentials: include`），待办来自 `todo_list`。
- 缺 `XTBZ` 等静态标识头时接口会返回 `success=false`，这**不是登录失效**；脚本会采集页面自然请求的标识头后重试一次。
- **学期码不写死**：按「课程数最多的学期，并列取较大者」自动识别，依据写进 `term_detection.evidence`；不对时用 `--term` 覆盖。

### 3.3 门户 / 教务

- 门户是 CAS 锚点，登录门户后教务通常可自动转发。
- 教务只读课表与考试安排，不读成绩、不点任何提交类入口。
- HTTPS 在教务端不可用，必须用 `http://`。

## 四、读取失败时的标准话术

- 未登录 / 跳转到 `sso.scut.edu.cn`：`当前平台需要登录。我已打开一个专用 Chrome 窗口。请你在窗口里本人完成统一认证或扫码，登录成功后不要关闭窗口；脚本会自动继续读取，并在完成后关闭。`
- 正文为空：`页面打开了但没读到内容，可能是需要登录或页面结构变了。这次我先跳过，不猜。`
- 域名解析失败：`这个入口在我这里打不开（域名解析失败），暂时读不了。你能把课表截图或导出文件发我吗？`
- 加载超时：`页面加载超时了，我再试一次；还不行就先用其它来源拼。`

## 五、降级路径（读不到时的替代方案）

按优先级依次尝试，每种都要向用户说明走了哪条：

1. **用户导出文件**：课表 Excel / CSV / 截图 / PDF → 直接解析
2. **用户粘贴文本**：从页面复制文字贴进对话
3. **用户口述**：逐项确认课程与截止时间
4. **手工任务卡**：由用户提供字段，你负责结构化与排程

降级后生成的每张任务卡，`来源平台` 标注为 `用户提供`，`置信度` 最高记为「中」，因为无法与原始页面交叉核对。

## 六、故障排查速查

| 现象 | 处理 |
|---|---|
| `PLATFORM_NOT_AUTHORIZED` | `first-run.js --platforms ...` 重新授权该平台 |
| `PROFILE_BUSY` | 关掉上一次残留的 Chrome / node 进程后重跑；不要强杀未知进程 |
| `AUTH_TIMEOUT` | 重跑或加大 `--login-timeout-seconds` |
| `ECOURSE_SELF_EMBED_LOOP` | 告警，忽略即可 |
| `ECOURSE_TOP_REDIRECTED_TO_JW` | 中止本次导航，先单独登录门户再重跑 |
| 读到空正文 | 先 `session-probe.js`；再看诊断 `body_head`（已脱敏、≤500 字） |
| 学期不对 | 看 `term_detection.evidence`，用 `--term` 覆盖 |
| 换账号后数据串了 | 检查两账号是否用了同一个 `--profile-id`，改槽位重跑 |

## 七、移植到其他学校

1. 用环境变量覆盖基址：`HUAYUAN_SSO_BASE` / `HUAYUAN_PORTAL_BASE` / `HUAYUAN_ECOURSE_BASE` / `HUAYUAN_RAIN_BASE` / `HUAYUAN_JW_BASE`。
2. 先跑一次 `ecourse-pull.js`，按 `ecourse-discovery.json` 的 `anchors / json_responses` 定位本校课程入口选择器。
3. `first-run.js --force` 重选平台与槽位。

雨课堂体系的学校一般无需改选择器；eCourse 各校定制程度不同，选择器可能需要调整，但**不得改成写死课程 id 或学期码**。

## 八、平台能力声明（对用户必须如实说明）

可以说：
- "我能读取你在浏览器中已登录、且明确授权页面的正文内容"
- "我能读取学校公开的通知、公告、院系栏目页面"

不能说：
- "我能访问所有统一认证网站"
- "我能自动登录"
- "我能一次登录读取所有平台"
- "我能读取 QQ / 微信课程群里的消息"
- "我能替你提交作业或报名"

## 九、术语对照

| 用户说法 | 对应入口 |
|---------|---------|
| 教务系统 | `my.scut.edu.cn`（门户，经统一认证）或 `jw.scut.edu.cn`（本科生院公开栏目） |
| eCourse | `ecourse.scut.edu.cn` |
| 雨课堂 | `scut.yuketang.cn` |
| 学堂云 | `xtu.yuketang.cn`（雨课堂体系的校级子站） |
| 校园通知 | 学校主页通知公告、各学院 / 研究生院栏目页 |
| 邮箱 | 学校邮箱 / 个人邮箱，需用户授权或粘贴 |
