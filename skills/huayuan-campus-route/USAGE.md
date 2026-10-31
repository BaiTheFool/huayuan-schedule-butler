# 华园一日路线 · 使用说明

> 适用版本：0.13.9（大学城校区 · 专业 / 课表 / 考试待办 / 天气版）
> 目录：`skills/huayuan-campus-route/`

## 一、最快用法：打开页面

**不用安装、不用起服务器**，直接双击：

```
skills/huayuan-campus-route/public/index.html
```

页面里按顺序做四步：

0. 先在「专业」里填自己的专业（例如“软件工程”），点 **保存**；再点 **导入教务课表** 选择 `jw-timetable.json`（没有就先用示例）；
1. 顶部选**日期**；
2. 选**人格**（卷王 / 均衡 / 玩咖 / 运动），或直接拖下面的三条权重；
3. 点 **生成今日路线**。

然后可以：

- 看右侧地图：数字 1、2、3 是当天的停留顺序，点地点看开放时间和说明；
- 看左侧时间轴：每段都写了“为什么这样排”；
- 选**天气**（晴/多云/小雨/大雨/高温/寒冷/污染）和温度，路线会跟着变；
- 点 **实时** 用 Open-Meteo 取当天天气（不用 Key；失败会保留手动值）；
- 点 **设备定位** 使用当前浏览器所在电脑的系统定位；
- 在 **我现在在** 搜索框输入楼栋编号或名称（例如 `C11`、`B3`、`软件学院`、`图书馆`），下拉列表会按字段包含关系实时筛选；选中后点 **设为起点**，路线会立即按该楼栋重算；
- 点 **模拟在图书馆** 可快速体验；
- 点 **导出 Markdown** 存进笔记软件，或 **打印** 成 PDF。

### 专业和课表从哪来

**专业**：

- 页面输入后保存在本机 `localStorage`，不上传；只用于顶部标题、时间轴和导出文件，不改变教务读取。
- 专家里也可以保存：`node skills\huayuan-browser-session\scripts\manage-items.js set-major --name 软件工程`
- 命令行排路线时：`--major 软件工程`

**课表**：

1. 先在专家里完成初始化，让它读取一次教务课表；
2. 读取产物里会有 `jw-timetable.json`（通常在 `huayuan-output\<时间戳>\`）；
3. 从网页驾驶舱打开首页时，它会自动搜索最近一次本地 `jw-timetable.json`，包括历史会话目录；找到后直接生效，按钮变为 **重新导入课表**。
4. 点 **导入教务课表 / 重新导入课表** 会直接启动教务只读读取；需要登录时会打开专用 Chrome 窗口。网页驾驶舱不可用时，会复制同一读取指令，让你粘贴到左侧对话。
5. **本地文件** 是备用入口，只在自动读取和教务直连都不可用时使用。

导入后的课表保存在本机 `localStorage`，刷新页面仍然在；点 **用示例** 会清除并切回虚构课表。

导入时会自动检查：

- 是不是**大学城校区**；以 `campus.key`、`campus.campus_text` 和课程自身的 `campus` 为准。`大学城校区 / 广州国际校区` 这类组合标签不会误伤真实大学城课表；明确属于其他校区的课程会被跳过；
- 一共几门课、几门缺起止时间；
- 课表里有没有学期起始周，能算出现在第几周；
- 读取状态是不是 `READ_PARTIAL`（有课程没读全）。

页面顶部状态栏会显示“驾驶舱真实课表 · 14/14 门本周课程 · 大学城校区”。没有读到真实课表时，页面先显示不含课程的基础路线；只有明确点“用示例”才加载虚构课表。

### 考试与待办

点开左侧「考试与待办」：

- **导入考试**：选择 `exams.json`，按你的专业筛选，自动生成 T-14 / T-7 / T-3 / T-1 四段复习任务；
- **载入示例**：用虚构考试演示，页面会明确标“示例考试（虚构）”，不是真实考试；
- **手动加待办**：填标题、截止日期、预计分钟、优先级，点“添加”；
- **开启页面提醒**：浏览器通知权限允许后，页面开着时，任务截止前 1 小时提醒一次；
- 勾选任务完成、删除手动待办；考试自动任务不能删，但可以勾完成。

考试 JSON 格式：

```json
{
  "source": "教务考试安排",
  "exams": [
    {
      "id": "ds-mid-2026",
      "title": "数据结构期中",
      "course": "数据结构",
      "date": "2026-11-06",
      "start": "09:00",
      "end": "11:00",
      "venue": "A3-201",
      "type": "midterm",
      "scope": "school",
      "majors": ["软件工程", "计算机科学与技术"],
      "credits": 4
    }
  ]
}
```

没有 `majors` 的考试视为不限专业；专业为空时展示全部并提示。真实考试安排目前需要你从教务页面导出/整理成这个格式，**不会自动编造考试日期**。

任务会标进当天自习块：时间轴上显示“任务：…”，统计里出现“任务 N 分钟”；临近截止但当天排不完时，会提示“还有 N 项近两天任务没排完”。

命令行：

```powershell
node skills\huayuan-campus-route\scripts\day-route.js --demo --major 软件工程 --exams exams.json
node skills\huayuan-campus-route\scripts\day-route.js --demo --tasks tasks.json
```

`tasks.json` 可以是数组，也可以是 `{ "tasks": [...] }`。

示例文件：`demo/exams.json`（虚构考试）、`demo/tasks.json`（手动待办）。

## 二、页面上的按钮

| 控件 | 作用 |
|---|---|
| 专业 | 填写后点保存，存在本机；显示在标题和时间轴 |
| 导入教务课表 | 选择 `jw-timetable.json`，校验后按真实课表排 |
| 用示例 | 切回虚构课表，方便演示 |
| 考试与待办 | 展开后导入考试、载入示例、手动加待办、开提醒 |
| 日期 | 排哪一天；周末会自动按周末作息 |
| 卷王/均衡/玩咖/运动 | 四个预设权重 |
| 学习/放松/运动滑杆 | 自定义空档分配，改完立即重排 |
| 天气 + 温度 | 决定室内/室外、步行系数、提醒 |
| 实时 | 用 Open-Meteo 取当天预报 |
| 避开人流 | 对课间人流做一点修正 |
| 骑行 | 把步行时间换成骑行时间 |
| 定位我 | 读取手机定位，作为当天起点 |
| 我现在在 | 搜索并选择 A/B/C/T 区楼栋、学院楼、饭堂、体育馆等校园地点作为起点 |
| 模拟在图书馆 | 没定位权限时演示用 |
| 生成今日路线 | 重新计算 |
| 导出 Markdown / 打印 | 带走时间轴 |

楼栋目录依据 `华南理工大学大学城校区地图资料.docx` 和官方地图补充到 82 个地点，覆盖 A1–A6、B1–B12、C2–C17、D1–D5、G2–G17、E1–E3、数字宿舍及主要公共设施。没有独立坐标依据的生活区楼栋会标为“位置约值”。

页面也支持 URL 参数，方便收藏或分享某一天：

```
index.html?date=2026-10-30&preset=sport&weather=rain&temp=23
index.html?gps=library
index.html?live=1
```

`live=1` 会在打开时自动取一次实时天气。

## 三、命令行用法

在项目根目录执行。

### 1. 先看演示（虚构课表，不登录）

```powershell
node skills\huayuan-campus-route\scripts\day-route.js --demo --date 2026-10-30 --preset balanced
```

输出会写到一个新目录，并打印：

```
SUMMARY: 2026-10-30 星期五 · 均衡 · ☁️ 多云 32°C · 7 站 · 步行 4950 m / 69 分钟 ...
```

### 2. 用真实教务课表

先确保已经跑过初始化，拿到了 `jw-timetable.json`：

```powershell
node skills\huayuan-campus-route\scripts\day-route.js `
  --timetable huayuan-output\<时间戳>\jw-timetable.json `
  --major 软件工程 --date 2026-10-30 --preset balanced
```

不传 `--timetable` 时，脚本会自动找最新的 `huayuan-output/*/jw-timetable.json`；找不到才退回 demo。

### 3. 用已保存的作息偏好

```powershell
node skills\huayuan-campus-route\scripts\day-route.js `
  --preferences "%USERPROFILE%\.workbuddy\huayuan-schedule-butler\preferences.json" `
  --date 2026-10-30
```

### 4. 天气

```powershell
# 小雨
node skills\huayuan-campus-route\scripts\day-route.js --demo --weather rain --temp 23

# 高温（>=33°C 自动按高温处理）
node skills\huayuan-campus-route\scripts\day-route.js --demo --weather heat --temp 35

# 空气污染
node skills\huayuan-campus-route\scripts\day-route.js --demo --weather polluted --aqi 180

# 旧参数仍然可用，等价于 --weather rain
node skills\huayuan-campus-route\scripts\day-route.js --demo --rain
```

### 5. 定位 / 骑行 / 人流

```powershell
node skills\huayuan-campus-route\scripts\day-route.js --demo --gps 23.0469,113.4054,wgs84
node skills\huayuan-campus-route\scripts\day-route.js --demo --mode bike --traffic peak
```

### 6. 只想要某几个参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--date` | 今天 | `YYYY-MM-DD` |
| `--preset` | `balanced` | `grind` / `balanced` / `play` / `sport` |
| `--study/--play/--sport` | 按画像 | 0–1，会归一化 |
| `--weather` | `cloudy` | `clear/cloudy/rain/storm/heat/cold/polluted` |
| `--temp` | 按天气 | 温度，≥33 自动高温 |
| `--precip` / `--aqi` | 按天气 | 降水量 / 空气质量 |
| `--timetable` | 自动找 | 教务课表 JSON |
| `--preferences` | 自动找 | 作息偏好 JSON |
| `--major` | 无 | 专业名称，写入日程元数据 |
| `--exams` | 无 | 考试 JSON，按专业生成复习任务 |
| `--tasks` | 无 | 手动待办 JSON，合并进当天计划 |
| `--week` | 不过滤 | 按教学周过滤 |
| `--dorm` | `c11` | 宿舍起点 `c11` / `c1` |
| `--gps` | 无 | `lat,lng[,wgs84\|gcj02]` |
| `--mode` | `walk` | `walk` / `bike` |
| `--rain` | 关 | 旧参数，等价于 rain |
| `--traffic` | `auto` | `auto/peak/clear` |
| `--output-dir` | 自动 | 产物目录 |

## 四、接到“华园日程管家”里

专家已经注册了这个技能。直接对它说：

- “今天怎么走？”
- “下雨天从宿舍到教室怎么安排？”
- “上完课顺路去哪个饭堂？”
- “图书馆闭馆前怎么安排？”
- “按运动模式排明天，晚上别安排太晚。”

专家会运行 `day-route.js`，然后用“结论 → 依据 → 下一步”回答；要看图时给出 `public/index.html`。

## 五、产物

默认写到 `huayuan-output/route-<日期>-<时间>/`：

- `day-route.json`：结构化数据（`blocks` / `legs` / `stops` / `route` / `weather` / `warnings` / `validation`）
- `day-route.md`：可直接贴进笔记软件的时间轴、天气说明和依据

## 六、常见问题

**Q：为什么五山课表排不出来？**
A：当前只覆盖大学城校区。读到五山/广州国际校区会返回 `CAMPUS_UNSUPPORTED`，不会把教室硬套到大学城。

**Q：专业填了有什么用？**
A：目前用于顶部身份、时间轴标题和导出文件，不改变教务读取和课程匹配；专业保存在本机，不上传。

**Q：导入后课程数/周次不对？**
A：页面会显示“已导入 X/Y 门本周课程 · 第 N 周”。如果周次不对，通常是 `jw-timetable.json` 里没有 `semester.first_week_start`，或教务读取状态不是 `READ_OK`；可以先在助手里重新读一次，命令行也可以用 `--week N` 手动指定。

**Q：实时天气取不到？**
A：Open-Meteo 不可达时会提示失败并保留手动天气；出门前自己再看一眼预报。

**Q：定位失败？**
A：浏览器拒绝授权或定位超时会明确提示。点“模拟在图书馆”可以继续看效果，定位不上传。

**Q：饭堂时间准吗？**
A：图书馆、热水、门禁是官方来源；一饭/二饭/体育馆时段是参考值，页面标“以现场为准”。

**Q：地图能导航吗？**
A：底图是高德标准地图（GCJ-02），路线与点位是规划叠加层，不是导航底图；步行线优先用 OSM foot routing 沿道路绘制，失败/离线时回退直线；点地点卡片里的“在高德地图打开”可跳真实地图。

**Q：天气会怎么改路线？**
A：小雨/大雨运动改体育馆、放松改室内；高温/污染取消白天露天跑步；寒冷加热身提醒；步行时间按天气系数加时。
