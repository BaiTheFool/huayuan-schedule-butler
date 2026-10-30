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
const configPath = path.join(dir, 'config.json');
const userStatePath = path.join(dir, 'user-state.json');

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
    college: '软件学院',
    major: '软件工程',
    daily: { wake: '07:30', sleep: '23:30', day_start: '08:00', day_end: '22:30' },
    study: { daily_limit: 180, max_continuous: 90, buffer_minutes: 10 },
    meals: [],
    fixed_events: [],
    provenance: { confirmation_state: 'confirmed' },
  }),
  'utf8'
);
fs.writeFileSync(
  configPath,
  JSON.stringify({
    setup_state: 'completed',
    authorized_platforms: ['portal', 'ecourse', 'jw', 'rain'],
  }),
  'utf8'
);
fs.writeFileSync(
  userStatePath,
  JSON.stringify({ semester: { current_week: 10, current_week_source: '用户确认' } }),
  'utf8'
);
process.env.HUAYUAN_HOME = dir;

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
let bootstrapChild = null;

async function wait(portNumber = port) {
  for (let index = 0; index < 30; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${portNumber}/api/dashboard`);
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
    check(
      /今日安排/.test(html) && /全部待办/.test(html) && /可参与事项/.test(html) && /手机工作台/.test(html),
      '原三页完整并新增手机工作台标签'
    );
    check(/dashboardBriefAction/.test(html), '保留第一动作摘要');
    check(/导入教务课表/.test(html) && /本地文件/.test(html), '课表入口区分教务读取和本地文件');
    check(/id="locationSearch"/.test(html) && /id="locationResults"/.test(html), '首页包含可搜索楼栋选择器');
    check(/设备定位/.test(html) && !/手机定位/.test(html), '定位文案使用设备而非手机');
    check(/id="copyTimetablePromptBtn"/.test(html) && /id="timetableFallback"/.test(html), '教务读取被系统阻止时有复制指令降级入口');
    check(/dashboard-attention\.css/.test(html) && /dashboard-attention\.js/.test(html), '今日页加载红点引导组件');
    const shellCss = await (await fetch(`http://127.0.0.1:${port}/dashboard-shell.css`)).text();
    const favicon = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    check(favicon.status === 204, 'favicon 不再产生无关 404');
    const sharedCss = await (await fetch(`http://127.0.0.1:${port}/styles.css`)).text();
    check(/\.huayuan-page-nav\s*\{[^}]*position:\s*sticky/s.test(shellCss), '今日页三标签吸顶');
    check(/\.page-nav\s*\{[^}]*position:\s*sticky/s.test(sharedCss), '待办与活动页三标签吸顶');
    for (const pathName of [
      '/route-assets/styles.css',
      '/route-assets/app.js',
      '/route-data/campus-data.js',
      '/route-scripts/route-engine.js',
      '/dashboard-shell.css',
      '/dashboard-bridge.js',
      '/dashboard-attention.css',
      '/dashboard-attention.js',
      '/mobile.js',
      '/mobile-ui.css',
    ]) {
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
    check(/dashboard-attention\.js/.test(todoHtml), '待办页加载共享红点');
    const activitiesPage = await fetch(`http://127.0.0.1:${port}/activities.html`);
    const activitiesHtml = await activitiesPage.text();
    check(activitiesPage.status === 200, '活动页返回 200');
    check(/现在能参加什么/.test(activitiesHtml), '活动页保留');
    check(/复制刷新指令/.test(activitiesHtml), '活动页保留刷新指令');
    check(/dashboard-attention\.js/.test(activitiesHtml), '活动页加载共享红点');
    const mobilePage = await fetch(`http://127.0.0.1:${port}/mobile.html`);
    const mobileHtml = await mobilePage.text();
    check(mobilePage.status === 200, '手机工作台标签页返回 200');
    check(/启动手机工作台/.test(mobileHtml) && /换配对码/.test(mobileHtml), '手机页提供启动与换码控制');
    check(/\/download\/app\.apk/.test(mobileHtml), '手机页提供 APK 下载');
    const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    const data = await response.json();
    check(data.ok === true, '驾驶舱 API 正常');
    check(data.service === 'huayuan-live-dashboard', '服务名正确');
    check(data.api_version === 5, 'API 版本为 5');
    check(/先去上课/.test(data.now.first_action.headline), '第一动作保留');
    check(data.prompts.length >= 2 && data.prompts.length <= 3, '提示语数量正确');
    check(/待确认|小步骤|30 分钟/.test(data.prompts.join(' ')), '提示语内容保留');
    check(data.todo.total === 1, '待办总数正确');
    check(data.todo.groups[0].items[0].title === '第 6 章作业', 'P0 待办保留');
    check(typeof data.sync.age_days === 'number', '同步状态保留');
    check(/刷新我的校园待办/.test(data.sync.prompt), '刷新指令保留');
    check(data.activities.items[0].title === '第一届校园AI智能体创新应用大赛', '活动数据保留');
    check(/刷新校园活动/.test(data.activities.prompt), '活动刷新指令保留');
    check(data.onboarding.initialized === true, '资料齐全时初始化中心判定完成');
    check(data.onboarding.blockers.length === 0, '资料齐全时没有红点');
    check(data.onboarding.total_steps === 9, '初始化中心覆盖 9 类资料');
    const onboardingApi = await fetch(`http://127.0.0.1:${port}/api/onboarding`);
    const onboardingData = await onboardingApi.json();
    check(onboardingApi.status === 200 && onboardingData.setup_state === 'completed', '初始化状态接口正常');
    const heartbeat = await fetch(`http://127.0.0.1:${port}/api/heartbeat`, { method: 'POST' });
    const heartbeatData = await (await fetch(`http://127.0.0.1:${port}/api/dashboard`)).json();
    check(heartbeat.status === 200 && heartbeatData.browser_alive === true, '驾驶舱心跳可避免重复打开窗口');
    const mobileStatus = await (await fetch(`http://127.0.0.1:${port}/api/mobile/status`)).json();
    check(mobileStatus.ok === true && mobileStatus.running === false, '手机页初始显示未启动');
    const deniedMobileStart = await fetch(`http://127.0.0.1:${port}/api/mobile/start`, { method: 'POST' });
    check(deniedMobileStart.status === 403, '手机启动接口要求同源动作头');
    const startedMobile = await fetch(`http://127.0.0.1:${port}/api/mobile/start`, {
      method: 'POST',
      headers: { 'X-Huayuan-Action': 'start-mobile' },
    });
    const startedMobileData = await startedMobile.json();
    check(startedMobile.status === 200 && startedMobileData.running === true, '驾驶舱可启动手机工作台');
    check(/^\d{6}$/.test(startedMobileData.pairing_code || ''), '驾驶舱显示 6 位配对码');
    check(Array.isArray(startedMobileData.urls), '驾驶舱返回手机可访问地址');
    const apkFromDashboard = await fetch(`http://127.0.0.1:${port}/download/app.apk`);
    const apkBytes = await apkFromDashboard.arrayBuffer();
    check(apkFromDashboard.status === 200 && apkBytes.byteLength > 10000, '驾驶舱可下发 APK');
    const stoppedMobile = await fetch(`http://127.0.0.1:${port}/api/mobile/stop`, {
      method: 'POST',
      headers: { 'X-Huayuan-Action': 'stop-mobile' },
    });
    const stoppedMobileData = await stoppedMobile.json();
    check(stoppedMobile.status === 200 && stoppedMobileData.running === false, '驾驶舱可停止手机工作台');
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

    const bootstrapHome = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-dashboard-bootstrap-'));
    const bootstrapPort = port + 1;
    const bootstrapToken = 'bootstrap-token';
    bootstrapChild = spawn(
      process.execPath,
      [
        path.join(__dirname, '..', 'scripts', 'dashboard-server.js'),
        '--port',
        String(bootstrapPort),
        '--token',
        bootstrapToken,
        '--timetable-refresh-mode',
        'fallback',
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, HUAYUAN_HOME: bootstrapHome },
      }
    );
    await wait(bootstrapPort);
    const bootstrapPage = await fetch(`http://127.0.0.1:${bootstrapPort}/`);
    const bootstrapHtml = await bootstrapPage.text();
    const bootstrapData = await (await fetch(`http://127.0.0.1:${bootstrapPort}/api/dashboard`)).json();
    check(bootstrapPage.status === 200, '没有 now.json 时驾驶舱仍可打开');
    check(/dashboard-attention\.js/.test(bootstrapHtml), '未初始化首页加载红点组件');
    check(bootstrapData.ok === true && bootstrapData.now === null, '未初始化 API 正常且不伪造 now');
    check(bootstrapData.onboarding.setup_state === 'uninitialized', '未初始化状态识别正确');
    check(bootstrapData.onboarding.blockers.length >= 5, '未初始化时列出全部主要缺失项');
    check(bootstrapData.onboarding.badges.today >= 2, '今日标签产生红点');
    check(bootstrapData.onboarding.badges.todo >= 2, '待办标签产生红点');
    check(bootstrapData.onboarding.badges.activities >= 1, '活动标签产生红点');
    check(/开始初始化/.test(bootstrapData.onboarding.prompt), '提供可复制初始化指令');
    check(bootstrapData.onboarding.badges.mobile === 1, '未启动时手机标签显示红点');
    check(
      bootstrapData.onboarding.blockers.every((step) => step.prompt && step.tab),
      '每项缺失资料都有复制指令和标签归属'
    );
    const bootstrapMobile = await (
      await fetch(`http://127.0.0.1:${bootstrapPort}/api/mobile/status`)
    ).json();
    check(bootstrapMobile.initialized === false && bootstrapMobile.running === false, '未初始化时手机工作台保持关闭');
    const blockedMobileStart = await fetch(`http://127.0.0.1:${bootstrapPort}/api/mobile/start`, {
      method: 'POST',
      headers: { 'X-Huayuan-Action': 'start-mobile' },
    });
    check(blockedMobileStart.status === 409, '未初始化时拒绝启动手机工作台并引导回初始化');
    const bootstrapShutdown = await fetch(`http://127.0.0.1:${bootstrapPort}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Huayuan-Token': bootstrapToken },
    });
    check(bootstrapShutdown.status === 200, '未初始化测试服务可正常关闭');

    const denied = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' });
    check(denied.status === 403, '关闭接口需要令牌');
    console.log(`LIVE_DASHBOARD_SMOKE:PASS ${passed}/${passed}`);
  } finally {
    child.kill();
    if (bootstrapChild) bootstrapChild.kill();
  }
})().catch((error) => {
  console.error(`LIVE_DASHBOARD_SMOKE:FAIL ${error.stack || error.message}`);
  child.kill();
  if (bootstrapChild) bootstrapChild.kill();
  process.exitCode = 1;
});
