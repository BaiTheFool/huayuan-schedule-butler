---
name: huayuan-mobile-remote
description: Serve a read-only mobile workbench of the latest Huayuan plan so a phone on the same Wi-Fi, a VPN or a public tunnel can open today's plan, todos, activities and the weekly schedule.
---

# 手机远程工作台

## 用途

把电脑上的「今日安排 / 全部待办 / 可参与事项 / 本周计划」放到手机上：手机浏览器打开电脑给出的地址，输入电脑显示的 6 位配对码即可。适合人不在电脑前时快速看一眼“现在该干什么”。

它和另外两种可视化分工明确：

| 用户说法 | 走哪条路 |
|---|---|
| 看卡片 / 看驾驶舱（对话内） | `huayuan-dashboard-widget` 的 `show_widget` |
| 打开驾驶舱 / 网页 / 分屏（电脑上） | `huayuan-live-dashboard` |
| **手机 / 手机上 / 手机上打开 / 手机远程** | **本技能** |

只要用户句子里出现「手机」，就走本技能，不要误开电脑驾驶舱。

## 触发

- “在手机上看今天的安排”
- “手机怎么打开驾驶舱”
- “打开手机工作台 / 手机远程工作台”
- “出门在外想看一眼待办”

## 执行

1. 先确认最新结果存在（没有就先跑一次）：

```powershell
node <huayuan-browser-session技能目录>\scripts\now.js
```

2. 启动手机工作台（局域网）：

```powershell
node <本技能目录>\scripts\launch-remote.js
```

3. 看到下面这些行后再回复用户（`MOBILE_REMOTE_READY` 是手机要打开的地址，`MOBILE_REMOTE_PAIR` 是配对码）：

```text
MOBILE_REMOTE_READY:http://<电脑局域网IP>:4320/
MOBILE_REMOTE_URLS:http://<其它网卡IP>:4320/ ...
MOBILE_REMOTE_PAIR:123456
MOBILE_REMOTE_LOCAL:http://127.0.0.1:4320/?k=<令牌>
```

4. 需要**外网/手机流量**访问时加 `--tunnel`（用本机 `cloudflared` 的免账号快速隧道）：

```powershell
node <本技能目录>\scripts\launch-remote.js --tunnel
```

成功时多一行 `MOBILE_REMOTE_PUBLIC:https://<随机域名>.trycloudflare.com`；失败时只打印 `MOBILE_REMOTE_TUNNEL_FAILED:<原因>`，局域网地址照常可用。

5. 停止与换码：

```powershell
node <本技能目录>\scripts\launch-remote.js --stop          # 停服务与隧道
node <本技能目录>\scripts\launch-remote.js --reset-pairing # 换配对码与令牌，旧手机会失效
```

### 局域网自动发现（给 Android App 用）

服务同时监听 UDP `4327`：手机 App 广播 `HUAYUAN_DISCOVER/1`，这里只回
`{service, port, version}`，不回令牌、不回配对码、不回任何数据；只应答私有地址来源。
启动日志里会有 `MOBILE_REMOTE_DISCOVERY:udp://4327`。App 在「找不到电脑」时才会用到手动输入地址。

## 首次引导：让用户装到手机（只问一次）

初始化走完、用户已经看到结果页之后，问一次「要不要顺手装到手机？」。只给**一条**路线：

1. **安卓 + 想装 App（推荐）**：让手机连同一个 Wi-Fi，浏览器打开
   `http://<电脑IP>:<端口>/`，配对页底部点「装到手机桌面」下载 APK（`/download/app.apk`，
   也可以直接输 `http://<电脑IP>:<端口>/download/app.apk`）；装好打开「华园工作台」，
   它会自动发现电脑，输配对码即可。以后电脑换 IP 也不用改地址。
2. **iPhone / 不想装 App**：浏览器打开同一地址 → 分享 →「添加到主屏幕」。
3. **手机不在同一网络**：加 `--tunnel` 启动，把 `MOBILE_REMOTE_PUBLIC` 的 https 地址给用户。

用户说不装就继续日常问答，不要追问第二次。完整话术见
`references/手机连接傻瓜教程.md`（含逐条排查顺序，可直接照着念）。

## 回复模板（不超过 3 行）

> 手机工作台已开：`<地址>`，配对码 `<6 位数字>`。
> 手机连同一个 Wi-Fi（或电脑加 `--tunnel` 后用 https 地址）打开，输入配对码即可。
> 只读：不改课表、不交作业；要更新数据，回这里发“刷新我的校园待办”。

## 页面与接口

| 路径 | 内容 |
|---|---|
| `/` | 今日安排：唯一第一动作、接下来时间轴、需要你决定、可复制指令 |
| `/todo.html` 等价路由（底部 Tab） | 全部待办 P0–P3、已过期项、本地完成/延后计数 |
| 活动 Tab | 校级 / 学院活动，按类型筛选，显示截止倒计时与原文链接 |
| 本周 Tab | `plan.json` 的每日时间块 |
| 设置 Tab | 连接方式、数据时间、教学周、复制刷新指令、解除配对 |
| `/api/health` | 免鉴权健康检查 |
| `/api/pair` | `POST {code}` → 令牌 |
| `/api/dashboard` | 需令牌；返回 now/todo/sync/activities/prompts/plan |
| `/api/shutdown` | 需令牌；停止服务（启动器的 `--stop` 用它） |
| UDP `4327` | 局域网发现：App 广播，回端口与版本（不含令牌/配对码） | 
| `/download/app.apk` | 随包的安卓 App（不需要令牌），配对页底部可直接下载 |

前端是单页 PWA，`/manifest.webmanifest` + 192/512 PNG 图标可“添加到主屏幕”。`android-app/` 里还有一个 WebView 壳（APK），开屏会自动发现电脑，同时支持 `http://` 局域网地址与 `https://` 隧道地址。

## 数据与隐私

- 只读  
ow.json`、`plan.json`、`activity-feed.json` 三个运行产物，不读浏览器 Cookie、密码、令牌、学号或成绩页面；
- 不写任何文件（`test/smoke.js` 会断言服务端无写文件调用）；
- 手机端不提供提交作业、报名、缴费、删除或修改学校数据的操作；
- 配对码只在本机内存中，重启即换；令牌存在 `%HUAYUAN_HOME%\mobile-remote.json`（`HUAYUAN_HOME` 默认 `%USERPROFILE%\.workbuddy\huayuan-schedule-butler`）；
- 公网隧道只是把本机端口转发出去，数据仍只存在你自己的电脑上；不用时执行 `--stop`。

## 安全边界

- 除配对接口外，所有 `/api/*` 必须带令牌；令牌比较用 `timingSafeEqual`；
- 配对码连续输错 8 次锁定 5 分钟（按来源 IP）；
- 静态资源只从 `public/` 目录白名单读取，路径穿越、仓库文件（如 `.git/config`）一律 404；
- 响应固定带 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`；
- 默认监听 `0.0.0.0` 供手机访问；只想本机调试时加 `--host 127.0.0.1`。

## 连不上时按顺序排查

1. **同一 Wi-Fi？** 手机浏览器直接开 `http://<IP>:<端口>/`；电脑和手机不在同一网段时用 `--tunnel` 或虚拟组网（awl / Tailscale 等）。
2. **Windows 防火墙**：首次监听会弹窗，选“允许专用网络”；没弹窗就手动放行该端口：

```powershell
netsh advfirewall firewall add rule name="Huayuan Mobile 4320" dir=in action=allow protocol=TCP localport=4320
```

3. **配对码错了**：以电脑终端最新一次输出为准；输错 8 次要等 5 分钟，或 `--reset-pairing` 换一个。
4. **静默降级到 HTTPS 页面**：隧道地址是 https，直接开 `MOBILE_REMOTE_PUBLIC` 那一行，不要手动改成 http。
5. **端口被占**：启动器会自动在 4320–4340 之间挑空闲端口，以 `MOBILE_REMOTE_READY` 行为准。
6. **APK 里“没有找到”**：先确认电脑端日志有 `MOBILE_REMOTE_DISCOVERY:udp://4327`；有些路由器会拦广播，这时在 App 里手动输入 `http://<电脑IP>:<端口>/`（公网则粘贴 https 地址）。

## 测试

```powershell
node skills\huayuan-mobile-remote\test\smoke.js   # 35 项：启动 → 配对 → 只读接口 → 发现 → 下载 → 安全 → 停止
node golden-path\check-mobile.js                   # 包级：注册 / Agent 入口 / 资源 / 下载 / 安全 / 冒烟
```
