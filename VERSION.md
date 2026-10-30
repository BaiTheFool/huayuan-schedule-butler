VERSION=0.14.11

# 华园日程管家 · 版本记录

> 本文件是版本的**单一事实源**。机器可读行固定为第一行：`VERSION=x.y.z`。
> 发版流程：改代码 → `powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1 -Message "<一句话变更>"`（自动 patch+1 并同步 `plugin.json`）→ 跑 `node golden-path\check.js` → 提交。
> 规则：版本号一律由脚本递增，**不要手动改** VERSION.md 与 plugin.json 的版本号；确需大/中版本时用 `-Part major|minor`。

## 变更日志（新→旧）

### 0.14.11 · 2026-10-30 · fix: use live device clock in mobile workbench
- 手机顶部和“此刻”改用设备实时时间，每 30 秒自动更新，不再显示 `now.json` 生成时间。
- 当前活动依据最新路线块和实时分钟判断，快照时间旧也不会让“要上课/在路上/用餐”长期停滞。
- 手机总回归扩展到 44 项。

### 0.14.10 · 2026-10-30 · fix: refresh mobile after local ignore and defer changes
- 手机服务绑定固定 `live-now.json`，不再固定到启动时的历史 `now.json`；完成、延后或忽略事项后下一次刷新即可同步。
- `now.js` 同时发布 `live-plan.json`，快照层缺失计划时递归查找最新计划，避免手机本周计划跟随旧目录。
- 移动端冒烟扩展到 41 项，新增快照更新后的 P0 与已完成状态同步断言。

### 0.14.9 · 2026-10-30 · feat: sync mobile route map and timeline with desktop dashboard
- 手机服务端复用电脑端同一路线引擎，返回真实课程、通勤、学习、运动、休息、地图折线、POI、天气、权重和统计。
- 手机今日页新增校园路线地图、地点编号、路线摘要、学习/放松/运动权重与四项统计；时间轴改用 `route.blocks`，不再只显示 `now.sequence` 中的单个休息块。
- 移动端冒烟扩展到 39 项，覆盖课程块、路线折线和地图点。

### 0.14.8 · 2026-10-30 · fix: sync mobile activities across WorkBuddy sessions
- 活动刷新后发布固定 `live-activities.json`，驾驶舱与手机工作台读取同一份活动数据。
- 共享快照层在固定文件缺失时，递归查找最近一次历史 `activity-feed.json`，修复最新 `now.json` 与活动文件不在同一目录导致手机显示 `NOT_SYNCED`。
- 增加跨会话活动发现与固定快照回归。

### 0.14.7 · 2026-10-30 · fix: enable mobile scrolling and hide dashboard service windows
- 手机主视图改为独立 `100dvh` 内容滚动容器，修复 Android WebView 无法上下滚动；切页、滚动监听和下拉刷新统一使用 `.content.scrollTop`。
- 后台驾驶舱改由调度任务运行 UTF-16 VBScript，再以 `WScript.Shell.Run(..., 0, False)` 隐藏启动 Node，不再额外弹出 Windows Terminal 的 `node` 标签页。
- 增加手机滚动和驾驶舱隐藏启动回归；服务复用仍保持同一 PID。

### 0.14.6 · 2026-10-30 · fix: keep one resident dashboard and reuse latest local timetable
- 驾驶舱使用固定 `live-now.json`；已有服务只更新快照并返回 `ACTION:refresh-existing`，不再因 WorkBuddy 回合 cwd 变化而重启或更换 PID。
- Windows 下通过 WMI 创建脱离命令监管的独立服务进程，禁止 Agent 用 `sleep/curl` 或手工后台启动修补。
- `now.js` 递归查找全部 WorkBuddy 历史输出中的最新课表并发布驾驶舱快照；顶部第一动作与路线页使用同一份课表，不再出现下方有课程、上方却提示未读课表。

### 0.14.5 · 2026-10-30 · fix: open the real dashboard before every turn and fix midnight sleep routing
- 驾驶舱改用 WorkBuddy 原生 `preview_url`：每条用户消息先启动并验证真实 HTML，再立即打开 HTTP URL；`ALREADY_OPEN` 不再允许跳过，禁止 `present_files`、本地 HTML、文件附件、卡片或外部浏览器冒充驾驶舱。
- 启动器新增页面身份校验和固定预览参数输出，失败时不会宣称已打开。
- 路线修复 `00:00`/次日睡觉偏好：按当天 24:00 封口，GPS 出发只相对起床后的非睡眠块计算，不再生成零点出发或伪重叠。

### 0.14.4 · 2026-10-30 · fix: resume Rain Classroom after login and stabilize eCourse notices
- 雨课堂登录等待改为复用页面自然请求采集到的静态标识头（重点为 `XTBZ`），登录后不再因裸接口拒绝而无限显示等待。
- 增加“已进入个人课程列表页”的第二登录信号；接口稍慢时先继续读取，不刷新正在使用的课程列表。
- eCourse 提示条只在顶层页面挂载，禁止 iframe 内重复显示；提示文案用 `sessionStorage` 跨页面导航保留，登录页稳定显示“请扫码登录”而不是回退到“正在打开”。

### 0.14.3 · 2026-10-30 · fix: make present_files the mandatory final side-panel action
- WorkBuddy 宿主规定 `present_files` 只能作为“结果已完成”回合的最后一个工具调用；上一版让模型在回合开始立即打开，与宿主规则冲突，模型因此错误地二次运行启动器并打开外部 Chrome。
- 改为：回合开始只启动本地驾驶舱服务；原请求处理完成后，最后一个工具调用必须是 `present_files({"files":[URL]})`，之后只写最终文字。
- 删除 Agent 层的外部浏览器兜底，禁止第二次运行启动器或去掉 `--no-open`。右侧侧栏会与最终回复一起出现。

### 0.14.2 · 2026-10-30 · fix: open the guided dashboard in WorkBuddy's side browser
- 驾驶舱启动器新增 `--no-open` 模式，只负责启动本地服务并返回状态，不再默认用 Windows `start` 拉起独立 Chrome。
- Agent 通过 WorkBuddy 内置 `present_files` 打开本地 `http://127.0.0.1` 地址，驾驶舱显示在右侧内置浏览器面板；`LIVE_DASHBOARD_ALREADY_OPEN:1` 时避免重复打开。
- 只有宿主不提供 `present_files` 时，才回退到外部浏览器；手机问题同样用 `--page mobile` 在侧边面板定位第四页。

### 0.14.1 · 2026-10-30 · feat: make the dashboard the mandatory guided control surface
- 每个用户回合先确保外部驾驶舱已打开；页面仍在时通过心跳避免重复弹窗，页面关闭后自动重开。
- 未初始化、缺少 `now.json` 时仍可启动驾驶舱，并由初始化健康状态接口列出学院、平台授权、偏好、教学周、课表、待办和活动等缺失项。
- 三个原页面加入双层红点：标签页提示本页缺口，页面顶部逐项显示缺失资料及可复制补全指令。
- 新增第四个“手机工作台”标签，可直接启动/停止只读手机服务、换配对码、显示局域网地址与发现端口、下载 APK 并查看故障排查。

### 0.14.0 · 2026-10-30 · feat: integrate team branches with the complete main feature set
- 在 `0.13.8` 主干上整合校园生存手册、绩点与操行分顾问、手机远程工作台，保留三页驾驶舱、大学城路线、地图与楼栋搜索、全部待办、教务自动读取及受限环境降级。
- 桌面驾驶舱与手机工作台共用只读快照层，避免两端展示不同结论。
- 手机工作台提供 PWA/APK、6 位配对码、令牌鉴权、局域网发现和可选公网隧道，并随包提供安卓安装包与首次安装引导。
- 插件注册技能共 9 个，Agent、插件清单与实际技能目录保持一致。

### 0.13.0 · 2026-10-30 · feat: LAN discovery (UDP 4327) for the Android workbench shell
- 服务端新增局域网发现：UDP `4327` 监听，收到 `HUAYUAN_DISCOVER/1` 只回 `{service, port, version}`，不回令牌、不回配对码、不回任何数据，且只应答私有地址来源；端口可用 `--discovery-port` 改。
- 启动器把插件版本（读 `VERSION.md` 首行）传给服务端，并新增 `MOBILE_REMOTE_DISCOVERY:udp://4327` 输出；`mobile-remote.json` 记录 `discovery_port`。
- 交付侧新增 Android 壳 `android-app/`（不引第三方库的 WebView 壳）：开屏广播发现电脑、列出可连地址、手动地址兜底、记住上次地址、顶部「刷新 / 地址」、外链交给系统浏览器；页面仍是同一套只读 PWA。
- 回归：`smoke.js` 32 → 33 项（新增广播发现用例，用独立发现端口避免与本机实例抢端口）；`check-mobile.js` 33 → 35 项（源码级发现与启动器输出断言）。

### 0.12.0 · 2026-10-30 · feat: add mobile remote workbench (read-only PWA, pairing code, optional cloudflared tunnel)
- 新增内置技能 `huayuan-mobile-remote`：手机浏览器直接打开「今日安排 / 全部待办 / 可参与事项 / 本周计划」的只读工作台；`launch-remote.js` 一条命令起服务，打印局域网地址与 6 位配对码，`--tunnel` 用本机 `cloudflared` 免账号快速隧道拿到公网 https 地址。
- 新增共享只读快照层 `huayuan-live-dashboard/lib/snapshot.js`：网页驾驶舱与手机端共用同一份 `now/todo/sync/activities/prompts` 组装逻辑，端到端结论一致（`dashboard-server.js` 同步改为引用它，API 版本仍为 3）。
- 手机端为可安装 PWA：`manifest.webmanifest` + 程序化生成的 192/512/180 PNG 图标、深色模式、下拉刷新、断网回退到 localStorage 缓存；底部四个 Tab + 设置页（复制刷新指令、解除配对）。
- 安全：除 `/api/health` 外所有接口要求令牌（`timingSafeEqual`）；配对码错 8 次锁 5 分钟；静态资源只从 `public/` 白名单读取；统一 CSP / nosniff / frame 保护；服务端零写文件。
- 新增回归：`skills/huayuan-mobile-remote/test/smoke.js`（32 项）、`golden-path/check-mobile.js`（33 项）。

### 0.11.0 · 2026-10-28 · feat: huayuan-score-advisor GPA/conduct calculators + official-manual KB (0.11.0)

### 0.10.2 · 2026-10-28 · 共同开发指南整合与测试基线修复
- 新增 `CONTRIBUTING.md`（共同开发指南）到仓库，并把其协作规范（分支/PR/测试门禁/打包/版本规则/隐私红线）整合进 `AGENTS.md`，新增「开发者自更新契约」硬要求。
- 补齐 `golden-path/fixtures/preferences.json`：修复上游遗留基线缺口，`check.js` 47/49 → 49/49、`check-v081.js` 6/9 → 9/9（详见 ERROR_LOG #11/#12）。
- `check-performance.js` 技能数断言 5 → 6（v0.10.0 新增 `huayuan-campus-manual` 的正当同步）。
- `scripts/bump-version.ps1` 修复读取编码（VERSION.md / plugin.json 补 `-Encoding utf8`），发版链路首次实测通过。
- `ERROR_LOG.md` 追加 #12；README 版本说明同步。

### 0.10.0 · 2026-10-28 · 知识库与工程治理
- 新增内置技能 `huayuan-campus-manual`：接入《华南理工生存手册》（CC0）知识库 46 份知识文件 + 校区地图/转诊单图片，覆盖作息、校历、校巴时刻、食堂、校区地图与周边、学业规则（绩点/考试/转专业）、就医医保、课外竞赛、毕业去向、新生入门。
- 新增版本号控制：`VERSION.md`（单一事实源）+ `scripts/bump-version.ps1`（自动递增并同步 plugin.json）。
- 新增报错日志：`ERROR_LOG.md`（人工维护的踩坑档案）+ `scripts/error-log.js`（运行时可追加的结构化错误日志）。
- 新增 Agent 交接指南：`AGENTS.md`（后来者唯一入口，含目录地图、维护契约、门禁与交付标准）。
- 主 Agent 增加校园生活知识问答路径；README 同步更新。

### 0.9.0 · 校园活动信息流
- 初始化询问所在学院，内置 42 个本科相关学院/书院官网入口；抓取校级来源后自动发现所选学院的通知、学生工作、团学、活动、竞赛和讲座栏目。
- 活动页分别展示“校级”和“我的学院”，可直接刷新或发送“刷新校园活动”。

### 0.8.3 · 任务连续优先，休息后补
- 课程等硬占用之后，先把明确任务按完整预计耗时排进去，再把每日休息配额放进剩余时间；不再让固定偏好休息时刻把长任务切碎。只有连续窗口确实放不下长任务时才拆段。

### 0.8.2 · 待办页
- 网页驾驶舱新增独立 `/todo.html`：按 P0/P1/P2/P3 分组显示全部任务、已过期项和数据提醒，固定提示每 7 天刷新一次。

### 0.8.1 · 任务优先的即时排程
- 当前有明确任务且可用时间不少于 10 分钟时直接开始；任务按预计耗时切片，可跨多个空档；标题明确但截止未知的任务保守排入并标“待确认”。新增 `golden-path\check-v081.js` 7 项回归。

### 0.8.0 · 性能精简版
- 主 Agent 提示词与浏览器 Skill 从约 34KB 压缩到约 10KB 和 7KB；普通问答不自动加载 Widget；明确区分内嵌卡片与外部网页；`maxTurns` 60→30。

### 0.7.2 · 可视化路径互斥
- “看驾驶舱”走 `show_widget` 内嵌卡片；“打开驾驶舱”必须启动外部浏览器驾驶舱，两条路径互斥。

### 0.7.1 · eCourse 讨论区误报修复
- 普通发帖、浏览数、回复按钮不再算作“未解析作业”；只有明确要求回复、跟帖计分或存在回帖截止时才保留为待确认任务。

### 0.7.0 · 分屏网页驾驶舱
- 专家可启动本机只读网页并在系统浏览器打开，左侧对话、右侧实时展示第一动作、时间轴、待确认数据。

### 0.6.1 · 扁平化 Widget
- 驾驶舱 Widget 按 WorkBuddy 规范扁平化：无渐变和阴影、最小字号 11px、外层透明、兼容深色主题。回归：`check-v060.js`（32 项）、`check-widget.js`（32 项）。

### 0.6.0 · 不替用户做决定
- 每条数据带来源标签（课程/平台任务/用户偏好/用户临时事项/系统默认/待确认）；教学周未确认或数据不全时只给估算与一个下一步，不输出确定结论；默认回答压缩为「结论+1–3 条依据+一个下一步」，不超过 300 字。

### 0.5.1 · eCourse 初始化体验
- 不再重复打开登录页，改为事件驱动轮询（实测 0.6 秒），顶部进度条、逐行转发、每 3 秒心跳。回归：`check-ecourse-ux.js`（36 项）。

### 0.5.0 · 入口按新手重排
- 专家卡固定三个快捷入口（初始化 → 我现在该干什么 → 临时新增并重排）；固定开场白；未初始化时不运行 `now.js`（退出码 3）；固定黄金路径成为发版回归基线。

### 0.4.1 · 教学周过滤
- 学校课表按当前教学周过滤（`weeks.list`/`weeks.parity`）；教学周未知时保留课程但明确标注。初始化新增「当前教学周」一步。

### 0.4.0 · 现在该干什么 + 用户修正覆盖层
- 以当前时刻算出唯一第一动作 + 排序待办 + 后续时段；手工课程/停课/临时任务/平台任务完成延后等本地状态不改写学校原始课表。

### 0.3.2 · 固定本科生口径
- 不再询问本科/研究生；会话按平台隔离（门户+教务 / eCourse / 雨课堂 各一份浏览器会话）；可移植包（不含本机用户名、课程 ID、学期码或固定输出路径）。
