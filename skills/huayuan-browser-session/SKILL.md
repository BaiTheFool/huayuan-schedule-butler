---
name: huayuan-browser-session
description: "Read-only SCUT browser session gateway for undergraduate initialization, timetable, eCourse and Rain Classroom data."
---

# 华园浏览器会话网关

只服务华南理工大学本科生，只读用户明确授权的页面。

## 初始化入口

```powershell
node <本技能目录>\scripts\first-run.js --wizard --login
```

非交互环境：

```powershell
node <本技能目录>\scripts\first-run.js --wizard --yes --prefs prefs.json --skip-read
```

初始化固定顺序：

```text
匿名槽位 → 四平台授权 → 偏好 → 登录检查
→ 门户+教务 → eCourse → 雨课堂 → 当前教学周 → 日程分析
```

用户只需集中回答一次授权与偏好；不要逐个平台重复询问。

## 状态

| 状态 | 含义 |
|---|---|
| `uninitialized` | 尚未初始化 |
| `partial` | 有平台或关键来源未读全 |
| `paused` | 正在等用户本人登录或二次认证 |
| `completed` | 教务课表、eCourse、雨课堂均读到，分析可用且校验通过 |

查看状态：

```powershell
node <本技能目录>\scripts\intro.js
node <本技能目录>\scripts\first-run.js --show
```

## 会话纪律

1. 所有登录读取必须经过 `session-gateway.js`。
2. 先无头检查；登录有效时保持隐藏。
3. 登录失效时只打开一次可见 Chrome，停在真实登录入口。
4. 出现 `AUTH_REQUIRED` 后让用户本人扫码或完成统一认证。
5. 不要循环重试，不要自动填写账号、密码、验证码。
6. 同一时刻只允许一个浏览器；平台串行读取。
7. 登录成功后在同一浏览器上下文立即读取。
8. 不另开探测标签；避免 CAS 重定向风暴。

会话目录：

```text
profiles/<profile-id>/cas       门户 + 教务
profiles/<profile-id>/ecourse  eCourse
profiles/<profile-id>/rain     雨课堂
```

不同学校账号必须使用不同 `profile-id`。看到 `BROWSER_BUSY` / `PROFILE_BUSY` 时停止，不启动第二个浏览器。

## 读取命令

| 平台 | 命令 |
|---|---|
| 门户 + 教务 | `node campus-sync.js --login-timeout-seconds 600` |
| 教务课表 | `node jw-timetable.js --login-timeout-seconds 600` |
| eCourse | `node ecourse-pull.js --login-timeout-seconds 600` |
| 雨课堂 | `node rain-fast.js --login-timeout-seconds 600` |
| 登录态检查 | `node session-probe.js --platform all` |
| 校园活动公开源 | `node activity-feed.js --output-dir <输出目录>` |

所有脚本都接受 `--profile-id` 和 `--output-dir`。

## 读取状态

- `READ_OK`：完整读取；
- `READ_PARTIAL`：部分记录、分类或字段未解析；
- `READ_EMPTY`：页面正常但确实没有记录；
- `READ_FAILED`：读取失败。

规则：

- “没读到”不等于“没有任务”；
- `READ_PARTIAL` 必须说明还差什么；
- 不明确字段写“待确认”；
- eCourse 普通讨论帖记为 `informational`，不当作未解析作业；
- 只有明确要求回复、跟帖计分或存在回帖截止时，才把讨论区差额计入 `unparsed_count`。

## 教务课表

读取顺序：

```text
已登录页面请求重放 → 页面网络 JSON → DOM 表格
```

入口语义：

```text
信息查询 → 个人课表查询
```

HTTP 入口只使用：

```text
http://xsjw2018.jw.scut.edu.cn/
```

不要擅自改成 HTTPS。提取课程、教师、星期、节次、周次、教室、校区；缺字段写“待确认”。

## eCourse

从根地址进入并跟随跳转，不写死课程 ID。课程要动态枚举。

每个分类输出：

```text
records_total / submitted_count / unfinished_count
unknown_count / unparsed_count / informational_count
```

差额处理：

- 作业、测试、问卷：声明 N 条只解析 M 条时，N-M 计入未解析；
- 讨论区：普通帖子只有作者、时间、浏览和回复按钮，没有截止与提交状态，不按任务处理；
- 讨论区只要出现“请回复 / 必须跟帖 / 回复计分 / 回帖截止”，缺口才计入未解析。

eCourse 顶层只能停留在 `ecourse` 或 `sso`。跳到教务或其他站点立即中止，不继续导航。

## 雨课堂

- 登录入口：`https://<rain-base>/pro/login`；
- 动态识别当前学期，不写死学期码；
- 待办、课件、随堂练习的截止时间不明确时标“待确认”；
- 不把公开课程目录当成个人登录成功的证据。

## 教学周

确认顺序：

1. 用户明确提供；
2. 已保存的 `current_week`；
3. 教务校历中字段名明确为第一周开始的日期；
4. 都不可用则只问一次。

```powershell
node <本技能目录>\scripts\manage-items.js week --timetable <jw-timetable.json>
node <本技能目录>\scripts\manage-items.js set-week --number 10
```

未知周次时保留课程，但标记“按可能发生计入”，不得宣称精确。

## 计划与用户修正

生成分析：

```powershell
node <本技能目录>\scripts\schedule-analyze.js --validate
```

当前动作：

```powershell
node <本技能目录>\scripts\now.js
```

修正命令：

```powershell
node <本技能目录>\scripts\manage-items.js add-course ...
node <本技能目录>\scripts\manage-items.js add-task ...
node <本技能目录>\scripts\manage-items.js add-personal ...
node <本技能目录>\scripts\manage-items.js cancel-course ...
node <本技能目录>\scripts\manage-items.js done ...
node <本技能目录>\scripts\manage-items.js defer ...
node <本技能目录>\scripts\manage-items.js remove --id <id>
```

平台任务的完成/延后只写本地覆盖层，不上传学校平台。

## 定期刷新

固定触发语：

```text
刷新我的校园待办
```

已有配置时运行：

```powershell
node <本技能目录>\scripts\first-run.js --wizard --yes
node <本技能目录>\scripts\now.js
```

- `--wizard --yes` 会沿用已保存偏好和授权平台，不得重新初始化或覆盖偏好；
- 遇到登录失效才加 `--login`，由用户本人完成一次认证；
- 刷新后汇报新增、消失/完成、截止或状态变化、3 天内到期与已过期项；
- 缺失来源仍标 `READ_PARTIAL`，不得显示为 0；
- 页面提示默认每 7 天刷新一次，临时收到新作业通知时随时刷新。

初始化偏好时询问一次“你所在学院/书院？”，确认后保存：

```powershell
node <本技能目录>\scripts\manage-items.js set-college --name 软件学院
node <本技能目录>\scripts\activity-feed.js --list-colleges
```

学院目录覆盖官网机构设置中的 42 个本科相关学院/书院。学院名称只用于筛选公开活动来源，不写入学校系统。

## 校园活动抓取

固定触发语：

```text
刷新校园活动
```

```powershell
node <本技能目录>\scripts\activity-feed.js --output-dir <最新输出目录>
```

输出 `activity-feed.json` / `activity-feed.md`。脚本只访问公开网页，覆盖校团委、学生工作处、本科生院、研究生院、软件学院学生工作和就业在线；筛出带报名、竞赛、讲座、志愿、培训、就业等可参与关键词的事项，排除获奖名单和活动总结。

脚本会读取已保存学院，并追加该学院官网中可发现的“通知公告 / 学生工作 / 团学 / 活动 / 竞赛 / 讲座”栏目。也可临时覆盖：

```powershell
node <本技能目录>\scripts\activity-feed.js --output-dir <目录> --college 计算机科学与工程学院
```

微信公众号是重要补充渠道，但公开搜索存在验证码、时效和跳转限制。没有连接器时只能让用户粘贴/转发，不可声称已自动读取私域群或所有公众号。

来源清单与本次比赛核验记录见：`references/activity-sources.md`。

排程纪律：

- 标题可识别的任务一进入任务池就参与排程，截止时间未知只标“待确认”，不能因此丢出计划；
- 当前时间已有明确任务时，10 分钟以上就立即开始，不等待 45/90 分钟完整空档；
- 任务按预计耗时切片，可跨多个空档；同一空档可依次放多个短任务并保留缓冲；
- 有可排任务时，计划只展示真实任务片段，剩余空档保持机动，不生成未绑定任务；
- 只有标题不可识别的编号（如单独的“6”）不猜测、不排入，只问一次。

## 安全

- 不索要、保存、打印或导出密码、验证码、Cookie、Token、票据；
- URL 中 `ticket/token/code/sessionid` 写成 `***`；
- 学号、身份证、手机号、邮箱和名单/成绩页面跳过或脱敏；
- 不提交作业、不报名、不缴费、不修改学校业务数据；
- 只读取用户授权且当前账号有权访问的页面。

## 排障

先看：

```text
<platform>-session-events.jsonl
<platform>-session-result.json
<platform>-session-status.json
```

常见状态：

- `AUTH_REQUIRED`：用户本人登录；
- `AUTH_TIMEOUT`：登录超时，重跑一次同一流程；
- `BROWSER_BUSY` / `PROFILE_BUSY`：已有浏览器占用；
- `READ_FAILED`：查看脱敏诊断，不猜数据；
- `ECOURSE_SECTION_UNPARSED`：真实任务缺口才提示人工核对。
