# 华园日程管家 · 报错日志

> 本文件是**人工维护的踩坑档案**（供后来 agent 与人类开发者复用），与 `logs/errors.jsonl`（运行时自动记录的结构化错误流）互补。
> **维护契约**：遇到问题并解决后，必须在文末按模板追加一条（编号往下排，不跳号、不删改已有记录）。发现本文件与代码不符时，以代码为准并修正本文件。

## 追加模板

```
### #NN · YYYY-MM-DD · 发现于 <版本或场景>
- 现象：
- 根因：
- 解决：
- 验证：
- 预防规则：
```

---

## 已记录问题

### #01 · 教务课表语义点击后只解析到空结果 · 0.3.x
- 现象：`jw-timetable.js` 点击「信息查询 → 个人课表查询」后，原页面解析不到课表数据。
- 根因：教务菜单是 `target="_blank"`，点击后在新标签打开；只解析原页面拿不到内容。
- 解决：脚本接管新标签再解析（网络响应优先，DOM 表格兜底）。
- 验证：三校区课表实测可读，产物 `jw-timetable.json` 含课程段。
- 预防：任何「语义点击后跳新标签」的入口都必须接管新标签；改选择器后先跑 `jw-timetable.js` 看诊断 JSON。

### #02 · 列表视图第 0 行混入姓名+学号标题行 · 0.3.x
- 现象：课表列表视图第 0 行是「姓名 + 学号」标题行，被当作课程解析。
- 根因：页面结构如此。
- 解决：跳过第 0 行且不落盘（隐私要求）。
- 验证：产物无学号字段；golden-path 断言通过。
- 预防：任何课表解析必须跳过标题行；学号类长数字一律打码。

### #03 · 表格视图星期列整体错位 · 0.3.x
- 现象：带 `rowspan` 的列导致星期表头与课程行错位。
- 根因：按单元格顺序直接映射星期，rowspan 列把后续列挤偏。
- 解决：星期用表头单元格**水平中心对齐**换算。
- 验证：大学城/五山课表实测星期正确。
- 预防：解析表格视图前先确认表头结构；错位风险高时降级到列表视图。

### #04 · eCourse 初始化白屏/慢 · 0.5.0
- 现象：初始化时重复打开登录页，固定等待 8 秒，用户看着像卡死。
- 根因：无条件导航 + 固定延时。
- 解决：只在必要时导航一次；改为事件驱动轮询（二维码出现即返回，实测 0.6 秒）；窗口出现即显示顶部进度条，脚本输出逐行转发，每 3 秒心跳。
- 验证：`node golden-path\check-ecourse-ux.js`（36 项断言）。
- 预防：不要用固定 sleep 等异步 UI；优先事件/轮询，且必须有进度反馈。

### #05 · 两个平台互相抢标签 · 0.3.2
- 现象：门户/教务与 eCourse 在同一浏览器会话里互相导航，读取结果串台。
- 根因：共享 Cookie / 共享会话命名空间。
- 解决：会话按平台隔离（`cas` / `ecourse` / `rain` 三份独立目录）；`campus-sync` 与 `ecourse-pull` 职责不重叠。
- 验证：多平台串行读取实测通过；同一时刻仍只有一个 Chrome（`.browser-singleton.lock`）。
- 预防：任何新平台接入都必须有独立会话命名空间；禁止跨命名空间复用 Cookie。

### #06 · 占位 iframe 被误判为登录证据 · 0.5.x
- 现象：门户 `index.html?id=...` 预置多个 `src` 与自身同址的空占位 iframe，被当作「未登录」或阻断导航。
- 根因：`ECOURSE_SELF_EMBED_LOOP` 是页面结构造成的伪信号。
- 解决：仅作告警上报，不当作未登录证据，不阻断导航；`src` 为空的 iframe 单独计数。
- 验证：eCourse 正常读取不受影响。
- 预防：告警码与错误码分开；新页面结构先看诊断 JSON 再定性。

### #07 · eCourse 顶层被重定向到教务系统 · 0.5.x
- 现象：eCourse 顶层进入 `xsjw` / `jwglxt`，整次读取被带偏。
- 根因：会话被 CAS 转发链带出平台。
- 解决：主框架只允许停留在 `ecourse` 与 `sso`；一旦离开立即中止并记录脱敏 URL（`ECOURSE_TOP_REDIRECTED_TO_JW` / `ECOURSE_TOP_LEFT_PLATFORM`），不再继续导航。
- 验证：中止路径回归通过。
- 预防：任何平台读取都要定义「允许停留域」，越界即中止，不要尝试在错误会话里补救。

### #08 · eCourse 讨论区发帖被误算为待办作业 · 0.7.0
- 现象：普通发帖、浏览数、回复按钮被算作「未解析作业」，待办虚高。
- 根因：判定规则过宽。
- 解决：只有页面明确要求回复、跟帖计分或存在回帖截止时才保留为待确认任务；讨论区记录单独计入 `informational`。
- 验证：`golden-path\check-v071.js` 回归（README 0.7.1）。
- 预防：新增任务类型前先过「页面是否明确要求用户动作」这一关。

### #09 · 固定休息时刻把长任务切成无意义碎段 · 0.8.2
- 现象：45 分钟任务被固定休息时刻切成 38+7 分钟两段。
- 根因：先排休息再排任务。
- 解决：改为**任务连续优先、休息后补**：课程等硬占用之后先把明确任务按完整耗时排进去，再把休息配额放进剩余时间；只有连续窗口放不下长任务才拆段。
- 验证：`golden-path\check-v081.js` 7 项回归；README 0.8.3。
- 预防：排程顺序必须是「硬占用 → 任务 → 休息」，禁止把长任务切出无意义尾段。

### #10 · 跨周次时间重叠被误判为冲突 · 0.4.0
- 现象：`19:00-20:40（第14周）` 与 `19:00-21:35（4-13周）` 时间重叠但周次不相交，被判为冲突。
- 根因：只比时间不比周次。
- 解决：`plan.json` 块带上 `weeks` / `week_list`，`check_plan.py` 跳过周次不相交的块；初始化加「当前教学周」确认。
- 验证：`golden-path\check.js` 断言覆盖。
- 预防：凡带周次的占用都必须做周次相交判定，不能只比时间段。

### #11 · 黄金路径基线 47/49（上游 v0.9.0 原版即失败，非本分支改动引入） · 0.9.0
- 现象：`node golden-path\check.js` 输出 `GOLDEN_PATH:FAIL 47/49`，两项失败：① 偏好落盘断言期望 `daily_limit_min=180`，实际为 `240`；② 「周六 14:00-16:00 羽毛球固定事项」断言未通过。
- 根因：上游仓库 641bdd7（v0.9.0 发布提交）自身基线不一致——`check.js` 第 158-162 行断言上限 180 且 fixture 规格（GOLDEN-PATH.md）写 180，但当前代码默认值为 240（`preferences.js` 默认 `daily_limit_min=240`）；且 `golden-path\fixtures\` 目录没有 `preferences.json`，第 2 步用例实际由默认值生成，v0.6.0 起「不再静默生成成套偏好」后羽毛球固定事项也不再默认产生。用干净克隆（未做任何改动）重跑同样 47/49，证明与 0.10.0 新增内容无关。
- 解决（**已解决，采用方案 B，见 #12**）：方案 A 改 `check.js` 断言与 GOLDEN-PATH.md 规格为 240；方案 B 在 fixtures 提供 preferences.json 并在用例中显式写入；方案 C 回上游修复。
- 验证：`git status --short` 确认 golden-path/ 未被本分支改动。
- 预防：发版回归若出现与「基线未动」相关的失败，先查上游一致性，不要为了通过而临时改断言。

### #12 · 补齐 fixtures/preferences.json 并同步 check-performance 技能数 · 0.10.2
- 现象：按 CONTRIBUTING §8 跑全量门禁时三个套件不绿：`check.js` 47/49（同 #11）、`check-v081.js` 6/9（第 3 组「当前短空档直接开始」3 项全挂）、`check-performance.js` 6/7（「Skills 数量为 5」失败，实际 6）。
- 根因：① `golden-path/fixtures/preferences.json` 缺失（GOLDEN-PATH.md 第一节明确该文件应在 fixtures/，但从未入库）——所有 `--prefs` 用例静默回退到默认偏好（上限 240、运动周一/三/五 17:00-18:00、晚餐 17:30-18:20），导致 #11 两项失败，且周三 17:20 被运动占住、check-v081 短空档用例失败；② `check-performance.js` 第 31 行断言技能数 5，而 v0.10.0 有意新增第 6 个技能 `huayuan-campus-manual` 后未同步该断言。
- 解决：① 新建 `golden-path/fixtures/preferences.json`（虚构角色「小林」：上限 180 / 单块 90 / 休息 60 / 周六 14:00-16:00 羽毛球固定；晚餐 17:40-18:20、运动仅周一/周五，保证周三 17:20-17:40 短空档可用——check-v081 第 3 组依赖，同时不破坏 check.js 第 6 步周四 18:20「晚餐已结束」的前提）；② `check-performance.js` 断言 5→6（配套同步测试，属 v0.10.0 行为的正当更新，非放宽断言）。
- 验证：全量门禁全绿——`GOLDEN_PATH:PASS 49/49`、`V060:PASS 32/32`、`WIDGET:PASS 32/32`、`V081:PASS 9/9`、`ACTIVITIES:PASS 6/6`、`PERFORMANCE:PASS 7/7`、`ECOURSE_UX:PASS 36/36`、`LIVE_DASHBOARD_SMOKE` exit 0、`SELF_CHECK:PASS 33/33`、`ACTIVITY_SELF_CHECK:PASS 8/8`。
- 预防：新增技能/偏好字段时必须同步检查依赖 fixtures 的用例；fixtures 目录与 GOLDEN-PATH.md 的文件清单要保持一致；改功能后按 CONTRIBUTING §7 五处检查（生产脚本/JSON 结构/页面读取/排程逻辑/对应测试）。

### #13 · 绩点计分：五级制"中等"绩点 ≠ 动态百分比表的 C · 0.11.0
- 现象：`gpa-calculator.js --self-check` 两处失败——五级制「中等」课程按 2.3（动态表的 C）而非 2.7 折算；且端到端样例里 `level: 优秀` 的思政课被漏算进 GPA 预期。
- 根因：手册附表「五级制 → 绩点」与「百分制动态转换 → 绩点」是**两张独立表**：五级制「中等」直接给 C→2.7（及格 1.7），而动态表里 70.1%-80% 分位的 C→2.3；初版实现把五级制映射进动态表的 GRADE_TO_POINT，造成 2.3。另：`conduct-calculator.js` 自检断言对 `H`（裸数字）误用了 `out.H.value`。
- 解决：脚本新增 `FIVE_LEVEL_TO_POINT = { 优秀:4.0, 良好:3.7, 中等:2.7, 及格:1.7, 不及格:0.0 }`，五级制直接按该表折算、不再经过动态百分比表；同步修正知识文件 `001-绩点规则.md` 与自检/门禁断言。
- 验证：`gpa-calculator.js --self-check` PASS 19/19、`conduct-calculator.js --self-check` PASS 13/13、`golden-path\check-score.js` PASS 16/16；`node golden-path\check.js` 全量不受影响。
- 预防：实现手册计分规则时先区分「独立计分表」与「映射表」；五级/两级制按手册附表直接折算，动态百分比表只用于 rankPercentile 输入。计分脚本与 `knowledge/` 常量表是双份事实源，改动必须两边同步并在自检断言中固化样例值。

### #14 · 2026-10-30 · 手机远程工作台（0.12.0）
- 现象：手机工作台首轮自测时，时间轴上的状态圆点被撑成 32×28 的色块并压住标题；配对页与主界面同时渲染；无头浏览器复测时旧 CSS/JS 仍在生效，误判「修复无效」。
- 根因：① 圆点用了 `class="dot task"`，与待办卡片的 `.task { width:100%; padding:13px 14px }` 撞名，宽高被后者覆盖；② `.pair { display:flex }` 是作者样式，会盖掉浏览器对 `[hidden]` 的 `display:none`，所以两个视图同时可见；③ `styles.css` / `app.js` 走 `Cache-Control: max-age=60`，同一浏览器实例里连续截图拿到的是缓存版本。
- 解决：① 圆点修饰类改为 `kind-rest` / `kind-task` / `kind-personal` / `kind-fixed`，待办卡片类改为 `task-card`，并在 CSS 里加 `[hidden] { display:none !important }`；② 无头预览脚本（本地 `.tmp-mobile/shot.js`，不入库）先 `Network.setCacheDisabled` 再导航；③ 手机端用 `text-wrap: balance` 与 `overflow-wrap: anywhere` 处理长标题与长路径。
- 验证：`node skills\huayuan-mobile-remote\test\smoke.js` 32/32、`node golden-path\check-mobile.js` 33/33；390×844 无头截图五个 Tab + 配对页均无控制台报错、无横向滚动（`scrollWidth = 390`）。
- 预防规则：新增页面级 class 前先 grep 是否已被其它组件占用（`.task`、`.dot`、`.block`、`.tag` 都是高撞名风险）；带 `display` 的容器必须显式处理 `[hidden]`；用浏览器缓存验证前端改动时，一律先禁用缓存。

### #15 · 2026-10-30 · 校园网下 cloudflared 快速隧道被判「不可达」（0.12.0）
- 现象：`launch-remote.js --tunnel` 拿到 `https://xxx.trycloudflare.com` 后，`fetch` 永远超时，被判定 `TUNNEL_UNREACHABLE` 并杀掉隧道；但同一域名在手机上其实能打开。
- 根因：① 校园网 DNS 不解析 `*.trycloudflare.com`（`curl: (6) Could not resolve host`），而隧道边缘其实已连上（日志有 `Registered tunnel connection`）；② 隧道刚建时 DoH 有 10–30 秒传播延迟；③ Node 的 `fetch` 访问 `dns.alidns.com` 直接 `fetch failed`（同一 URL 用 curl 正常），`doh.pub` 还会返回 40 秒 NXDOMAIN 负缓存；④ Cloudflare 返回两个边缘 IP，只探测第一个会偶发失败。
- 解决：`resolveHost()` 改用 **curl 查 DoH**（阿里 → 腾讯 → Cloudflare，`Answer` 可能是对象或数组），拿到 IP 后用 `curl --resolve` 绕过本机 DNS 验证；验证窗口放宽到 75 秒、逐个 IP 探测；DNS 始终查不到但隧道已注册时保留进程并输出 `MOBILE_REMOTE_PUBLIC_UNVERIFIED`，不再误杀。
- 验证：`--tunnel` 第二次尝试即拿到 `MOBILE_REMOTE_PUBLIC`（`public_verified=true`），公网 `api/health`、`/api/pair`、`/api/dashboard` 全部 200；headless Edge 加载公网地址，设置页显示「公网隧道（https）」。
- 预防规则：验证「公网域名」不要依赖本机 DNS（校园网/运营商污染很常见），DoH + `--resolve` 是唯一可控路径；隧道类探测必须给 DNS 传播留时间；进程存活比一次探测失败更重要（宁可标「未验证」也不要杀掉可用隧道）。

### #16 · 2026-10-30 · Android 壳（0.13.0）：模拟器网络不可用、中文路径构建
- 现象：APK 在 Android 11 模拟器里手动填 `10.0.2.2:4320` 报 `Failed to connect`；`adb shell ping 10.0.2.2` 直接 `Network is unreachable`；同一份代码在真机 Wi-Fi 下无此问题。
- 根因：本机装了 awl / vgate / Tailscale 等多块虚拟网卡，模拟器 slirp NAT 没能建立默认路由（模拟器状态栏 Wi-Fi 图标带 `?`）；这不是 App 或服务端问题。另：AGP 对非 ASCII 工程路径敏感，直接在含中文的交付目录里构建容易踩 `android.overridePathCheck` 之外的新坑。
- 解决：验证走 `adb reverse tcp:4320 tcp:4320`，让设备 `127.0.0.1:4320` 转发到宿主，完成「发现/手输地址 → 配对 → 页面渲染」全链路；APK 构建统一在 ASCII 临时目录（`C:\gcc-tmp\hywb`）执行，产物再拷回中文交付目录。
- 验证：Android 11 模拟器里 APK 打开配对页、输入 6 位配对码、进入工作台；发现列表曾成功列出 `http://10.0.2.2:4345/`（一次），说明广播应答链路可用；服务端 UDP 探针 100% 回复。
- 预防规则：**模拟器 ≠ 手机**，Android 网络问题先用 `adb reverse` 排除 NAT；真机验收再测 Wi-Fi 广播。Android 工程一律在 ASCII 路径构建；`usesCleartextTraffic` + `networkSecurityConfig` 必须同时给，否则 Android 9+ 直接拒绝局域网 http。

### #17 · 2026-10-30 · 未初始化时驾驶舱无法承担引导入口（0.14.1）
- 现象：旧启动器没有 `now.json` 就返回 `NO_NOW_JSON`，初始化资料只能散落在聊天文字里；已打开的驾驶舱也无法区分“页面已关闭”和“服务仍在运行”，下一轮容易重复弹窗或反过来不再打开。
- 根因：驾驶舱把首屏数据硬依赖在已完成的日程产物上；启动器只检查服务健康，没有浏览器页面心跳；三页导航没有统一缺口状态。
- 解决：新增只读初始化健康接口，在没有 `now.json` 时返回未初始化模式和逐项复制指令；页面每 5 秒发送心跳，启动器仅在页面失联时重新打开；新增第四页“手机工作台”控制只读服务、配对码、局域网地址和 APK。
- 验证：驾驶舱 smoke 89/89；真实空 Home 启动输出 `LIVE_DASHBOARD_ONBOARDING_MODE:1`、`now=null`、9 个缺失项；手机启动/停止与 APK 下载均通过。
- 预防：驾驶舱入口不得依赖 `now.json` 才能启动；所有新标签页必须接入共享 onboarding/attention 状态和红点测试。

### #18 · 2026-10-30 · 驾驶舱误开独立 Chrome（0.14.2）
- 现象：要求“每轮先打开驾驶舱”后，Windows 上弹出一个独立 Chrome 窗口，没有出现在 WorkBuddy 右侧内置浏览器面板。
- 根因：`launch-dashboard.js` 默认调用 `cmd.exe /c start <url>`；这是操作系统级外部浏览器启动，不是宿主预览工具。
- 解决：Agent 统一用 `--no-open` 启动本地服务，再调用 WorkBuddy 原生 `present_files(<localhost URL>)` 在右侧面板预览；页面心跳返回 `LIVE_DASHBOARD_ALREADY_OPEN:1` 时避免重复开页。仅当宿主没有 `present_files` 才回退外部浏览器。
- 验证：首次返回 `ALREADY_OPEN:0`，心跳后再次调用返回 `1`，`--page mobile` 返回 `0` 并给出 `mobile.html` URL；性能门禁新增 `present_files` 断言。
- 预防：WorkBuddy 内可预览的 localhost/HTML 一律走 `present_files`；不要用 `start`、`open`、浏览器进程启动来模拟宿主侧栏。

---

## 运行时错误日志（logs/errors.jsonl）使用说明

- 写入：`node scripts\error-log.js --code <CODE> --message "<原因>" [--severity warn|info] [--context '<JSON>'] [--file <相对路径>]`
- 查看：`node scripts\error-log.js --list --n 20`
- 统计：`node scripts\error-log.js --stat`
- 纪律：只记脱敏诊断信息（状态/错误码/原因），**禁止**写入账号、密码、Cookie、Token、学号、身份证、手机号、邮箱；正文与名单不落盘。
- 本项目既有事件流 `<平台>-session-events.jsonl` 继续负责读取过程事件；`errors.jsonl` 只记「需要后来者知道」的错误与告警。
