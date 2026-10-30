'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = 4398;
const token = 'self-check-token';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-live-dashboard-'));
const nowPath = path.join(dir, 'now.json');
const activityPath = path.join(dir, 'activity-feed.json');
const timetableDir = path.join(dir, 'history', '2026-10-30');
const timetablePath = path.join(timetableDir, 'jw-timetable.json');
const preferencesPath = path.join(dir, 'preferences.json');

fs.writeFileSync(
  nowPath,
  JSON.stringify({
    now: { date: '2026-11-04', time: '14:20', weekday: '周三' },
    first_action: {
      headline: '先去上课：生产运作管理（样例）（14:30-16:10）',
      next_hint: '下课后做第 6 章作业',
    },
    data_status: { estimate_only: true, pending: ['eCourse 有 2 条记录待确认'] },
    sequence: [
      { start: '16:30', end: '18:00', minutes: 90, kind: 'task', title: '第 6 章作业', source: 'eCourse' },
      { start: '21:10', end: '22:10', minutes: 60, kind: 'rest', title: '休息' },
    ],
    tasks: {
      p0: [{ title: '第 6 章作业', course: '生产运作管理', sources: ['eCourse'], deadline_display: '今天 23:59', priority: 'P0' }],
      p1: [],
      p2: [],
      p3: [],
    },
    overdue: [],
  }),
  'utf8'
);
fs.writeFileSync(
  activityPath,
  JSON.stringify({
    generated_at: new Date().toISOString(),
    date: '2026-10-28',
    item_count: 1,
    items: [
      {
        id: 'activity-1',
        title: '第一届校园AI智能体创新应用大赛',
        source_label: '学院/班级通知（用户提供）',
        type: 'competition',
        deadline: '2026-11-13',
        summary: '报名前请向主办方核实。',
      },
    ],
    sources: [{ id: 'youth', label: '校团委', url: 'https://www2.scut.edu.cn/youth/', status: 'READ_OK', items_seen: 1 }],
    warnings: [],
  }),
  'utf8'
);
fs.mkdirSync(timetableDir, { recursive: true });
fs.writeFileSync(
  timetablePath,
  JSON.stringify({
    status: 'READ_OK',
    campus: {
      key: 'university_town',
      label: '大学城校区 / 广州国际校区',
      campus_text: '大学城校区',
    },
    courses: [
      {
        course: '高级语言程序设计(C++)(上)',
        weekday: 5,
        start_time: '08:50',
        end_time: '10:25',
        weeks: { raw: '1-16周', list: [10], ranges: [[1, 16]] },
        classroom: 'A3-101',
        campus: '大学城校区',
      },
    ],
  }),
  'utf8'
);
fs.writeFileSync(
  preferencesPath,
  JSON.stringify({
    major: '软件工程',
    daily: { wake: '07:30', sleep: '23:30', day_start: '08:00', day_end: '22:30' },
    study: { daily_limit: 180, max_continuous: 90, buffer_minutes: 10 },
    meals: [],
    fixed_events: [],
  }),
  'utf8'
);

const child = spawn(
  process.execPath,
  [
    path.join(__dirname, '..', 'scripts', 'dashboard-server.js'),
    '--now',
    nowPath,
    '--port',
    String(port),
    '--token',
    token,
    '--timetable-refresh-mode',
    'fallback',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);

async function wait() {
  for (let index = 0; index < 30; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      if (response.ok) return;
    } catch {
      // Server is starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('SERVER_START_TIMEOUT');
}

(async () => {
  try {
    await wait();
    let passed = 0;
    const check = (condition, message) => {
      assert.ok(condition, message);
      passed += 1;
    };
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const html = await home.text();
    check(home.status === 200, '首页返回 200');
    check(/CAMPUS DAY ROUTE/.test(html), '首页采用路线 UI');
    check(/id="map"/.test(html), '首页包含校园地图');
    check(/id="wStudy"/.test(html) && /id="wPlay"/.test(html) && /id="wSport"/.test(html), '首页包含三类权重条');
    check(/今日安排/.test(html) && /全部待办/.test(html) && /可参与事项/.test(html), '三个标签全部存在');
    check(/dashboardBriefAction/.test(html), '保留第一动作摘要');
    check(/导入教务课表/.test(html) && /本地文件/.test(html), '课表入口区分教务读取和本地文件');
    check(/id="locationSearch"/.test(html) && /id="locationResults"/.test(html), '首页包含可搜索楼栋选择器');
    check(/设备定位/.test(html) && !/手机定位/.test(html), '定位文案使用设备而非手机');
    check(/id="copyTimetablePromptBtn"/.test(html) && /id="timetableFallback"/.test(html), '教务读取被系统阻止时有复制指令降级入口');
    const shellCss = await (await fetch(`http://127.0.0.1:${port}/dashboard-shell.css`)).text();
    const sharedCss = await (await fetch(`http://127.0.0.1:${port}/styles.css`)).text();
    check(/\.huayuan-page-nav\s*\{[^}]*position:\s*sticky/s.test(shellCss), '今日页三标签吸顶');
    check(/\.page-nav\s*\{[^}]*position:\s*sticky/s.test(sharedCss), '待办与活动页三标签吸顶');
    for (const pathName of ['/route-assets/styles.css', '/route-assets/app.js', '/route-data/campus-data.js', '/route-scripts/route-engine.js', '/dashboard-shell.css', '/dashboard-bridge.js']) {
      const asset = await fetch(`http://127.0.0.1:${port}${pathName}`);
      check(asset.status === 200, `${pathName} 可访问`);
    }
    const routeApp = await (await fetch(`http://127.0.0.1:${port}/route-assets/app.js`)).text();
    check(/api\/timetable\/refresh/.test(routeApp) && /重新导入课表/.test(routeApp), '课表按钮调用教务读取并切换文案');
    check(/function filterLocations/.test(routeApp) && /\.includes\(target\)/.test(routeApp), '楼栋搜索按字段包含关系过滤');
    check(/pointerdown/.test(routeApp) && /picker\.contains/.test(routeApp), '下拉栏只在选择器外点击时关闭');
    check(/scheduleLocationPosition/.test(routeApp) && /addEventListener\('scroll', scheduleLocationPosition/.test(routeApp), '页面滚动时下拉栏跟随输入框定位');
    check(/FALLBACK_REQUIRED/.test(routeApp) && /showTimetableFallback/.test(routeApp), 'EPERM 时前端显示对话读取入口');
    const todoScript = await (await fetch(`http://127.0.0.1:${port}/todo.js`)).text();
    const activityScript = await (await fetch(`http://127.0.0.1:${port}/activities.js`)).text();
    check(/execCommand\('copy'\)/.test(todoScript), '待办复制有本地降级');
    check(/execCommand\('copy'\)/.test(activityScript), '活动复制有本地降级');
    const todoPage = await fetch(`http://127.0.0.1:${port}/todo.html`);
    const todoHtml = await todoPage.text();
    check(todoPage.status === 200, '待办页返回 200');
    check(/所有要做的事/.test(todoHtml), '待办页保留');
    check(/复制刷新指令/.test(todoHtml), '待办页保留刷新指令');
    const activitiesPage = await fetch(`http://127.0.0.1:${port}/activities.html`);
    const activitiesHtml = await activitiesPage.text();
    check(activitiesPage.status === 200, '活动页返回 200');
    check(/现在能参加什么/.test(activitiesHtml), '活动页保留');
    check(/复制刷新指令/.test(activitiesHtml), '活动页保留刷新指令');
    const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    const data = await response.json();
    check(data.ok === true, '驾驶舱 API 正常');
    check(data.service === 'huayuan-live-dashboard', '服务名正确');
    check(data.api_version === 4, 'API 版本为 4');
    check(/先去上课/.test(data.now.first_action.headline), '第一动作保留');
    check(data.prompts.length >= 2 && data.prompts.length <= 3, '提示语数量正确');
    check(/待确认|小步骤|30 分钟/.test(data.prompts.join(' ')), '提示语内容保留');
    check(data.todo.total === 1, '待办总数正确');
    check(data.todo.groups[0].items[0].title === '第 6 章作业', 'P0 待办保留');
    check(typeof data.sync.age_days === 'number', '同步状态保留');
    check(/刷新我的校园待办/.test(data.sync.prompt), '刷新指令保留');
    check(data.activities.items[0].title === '第一届校园AI智能体创新应用大赛', '活动数据保留');
    check(/刷新校园活动/.test(data.activities.prompt), '活动刷新指令保留');
    const activitiesApi = await fetch(`http://127.0.0.1:${port}/api/activities`);
    const activitiesData = await activitiesApi.json();
    check(activitiesData.activities.items.length === 1, '活动 API 保留');
    const routeContext = await fetch(`http://127.0.0.1:${port}/api/route-context`);
    const routeData = await routeContext.json();
    check(routeData.ok === true, '路线上下文 API 正常');
    check(routeData.timetable_available === true, '真实课表自动接入首页');
    check(routeData.timetable_course_count === 1, '真实课表从历史子目录自动发现');
    check(routeData.tasks.length === 1, '主任务池自动接入路线');
    check(routeData.major === '软件工程', '专业偏好自动接入路线');
    const timetableStatus = await fetch(`http://127.0.0.1:${port}/api/timetable/status`);
    const statusData = await timetableStatus.json();
    check(timetableStatus.status === 200 && statusData.status === 'IDLE', '教务刷新状态接口正常');
    const deniedTimetable = await fetch(`http://127.0.0.1:${port}/api/timetable/refresh`, { method: 'POST' });
    check(deniedTimetable.status === 403, '教务刷新接口需要同源动作头');
    const fallbackRefresh = await fetch(`http://127.0.0.1:${port}/api/timetable/refresh`, {
      method: 'POST',
      headers: { 'X-Huayuan-Action': 'refresh-timetable' },
    });
    check(fallbackRefresh.status === 202, '受限环境可启动降级流程');
    const fallbackStatus = await (await fetch(`http://127.0.0.1:${port}/api/timetable/status`)).json();
    check(fallbackStatus.status === 'FALLBACK_REQUIRED' && fallbackStatus.fallback === 'agent_prompt', '子进程受限时返回对话读取降级状态');

    const denied = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' });
    check(denied.status === 403, '关闭接口需要令牌');
    console.log(`LIVE_DASHBOARD_SMOKE:PASS ${passed}/${passed}`);
  } finally {
    child.kill();
  }
})().catch((error) => {
  console.error(`LIVE_DASHBOARD_SMOKE:FAIL ${error.stack || error.message}`);
  child.kill();
  process.exitCode = 1;
});
