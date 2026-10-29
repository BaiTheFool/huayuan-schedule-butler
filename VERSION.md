VERSION=0.12.0

### 0.12.0 · 2026-10-30 · feat: add mobile remote workbench (read-only PWA, pairing code, optional cloudflared tunnel)
- 新增内置技能 `huayuan-mobile-remote`：手机浏览器直接打开「今日安排 / 全部待办 / 可参与事项 / 本周计划」的只读工作台；`launch-remote.js` 一条命令起服务，打印局域网地址与 6 位配对码，`--tunnel` 用本机 `cloudflared` 免账号快速隧道拿到公网 https 地址。
- 新增共享只读快照层 `huayuan-live-dashboard/lib/snapshot.js`：网页驾驶舱与手机端共用同一份 `now/todo/sync/activities/prompts` 组装逻辑，端到端结论一致（`dashboard-server.js` 同步改为引用它，API 版本仍为 3）。
- 手机端为可安装 PWA：`manifest.webmanifest` + 程序化生成的 192/512/180 PNG 图标、深色模式、下拉刷新、断网回退到 localStorage 缓存；底部四个 Tab + 设置页（复制刷新指令、解除配对）。
- 安全：除 `/api/health` 外所有接口要求令牌（`timingSafeEqual`）；配对码错 8 次锁 5 分钟；静态资源只从 `public/` 白名单读取；统一 CSP / nosniff / frame 保护；服务端零写文件。
- 新增回归：`skills/huayuan-mobile-remote/test/smoke.js`（32 项）、`golden-path/check-mobile.js`（33 项）。

### 0.11.0 · 2026-10-28 · feat: huayuan-score-advisor GPA/conduct calculators + official-manual KB (0.11.0)

# 华园日程管家 · 版本记录

> 本文件是版本的**单一事实源**。机器可读行固定为第一行：`VERSION=x.y.z`。
> 发版流程：改代码 → `powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1 -Message "<一句话变更>"`（自动 patch+1 并同步 `plugin.json`）→ 跑 `node golden-path\check.js` → 提交。
> 规则：版本号一律由脚本递增，**不要手动改** VERSION.md 与 plugin.json 的版本号；确需大/中版本时用 `-Part major|minor`。

## 变更日志（新→旧）

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
