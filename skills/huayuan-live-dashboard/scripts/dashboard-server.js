'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createSnapshot } = require('../lib/snapshot');
const { buildOnboardingStatus } = require('../lib/onboarding');

const argv = process.argv;
const argValue = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const port = Number(argValue('--port', '4318'));
const token = argValue('--token', '');
const timetableRefreshMode = argValue('--timetable-refresh-mode', 'auto');
const homeDir = process.env.HUAYUAN_HOME || path.join(os.homedir(), '.workbuddy', 'huayuan-schedule-butler');
const nowArg = argValue('--now', '');
const nowPath = nowArg ? path.resolve(nowArg) : null;
const activityPath = path.resolve(
  argValue('--activities', path.join(nowPath ? path.dirname(nowPath) : homeDir, 'activity-feed.json'))
);
const publicDir = path.resolve(__dirname, '..', 'public');
const snap = createSnapshot({ nowPath, activityPath, homeDir });
const routeSkillDir = path.resolve(__dirname, '..', '..', 'huayuan-campus-route');
const routePublicDir = path.join(routeSkillDir, 'public');
const routeDataDir = path.join(routeSkillDir, 'data');
const routeScriptsDir = path.join(routeSkillDir, 'scripts');
const browserSkillDir = path.resolve(__dirname, '..', '..', 'huayuan-browser-session');
const jwTimetableScript = path.join(browserSkillDir, 'scripts', 'jw-timetable.js');
const API_VERSION = 5;
const SYNC_INTERVAL_DAYS = 7;
const SYNC_PROMPT =
  '刷新我的校园待办：请重新读取教务、eCourse、雨课堂和校园门户，更新待办与日程，并告诉我新增、临近截止、已过期和发生变化的事项。';
const ACTIVITY_PROMPT =
  '刷新校园活动：请重新拉取校团委、学生工作处、本科生院、研究生院、软件学院和就业在线的公开活动公告，筛出仍可报名的活动，并按截止时间排好。';
const activityScript = path.resolve(
  __dirname,
  '..',
  '..',
  'huayuan-browser-session',
  'scripts',
  'activity-feed.js'
);
const mobileSkillDir = path.resolve(__dirname, '..', '..', 'huayuan-mobile-remote');
const mobileLaunchScript = path.join(mobileSkillDir, 'scripts', 'launch-remote.js');
const mobileStatePath = path.join(homeDir, 'mobile-remote.json');
const mobileApkPath = path.join(mobileSkillDir, 'apk', 'huayuan-workbench.apk');
let activityRefreshRunning = false;
let lastBrowserHeartbeat = 0;
let timetableScanCache = { at: 0, startDir: null, value: null };
let timetableRefreshJob = {
  status: 'IDLE',
  running: false,
  started_at: null,
  finished_at: null,
  message: null,
  fallback: null,
};

function readNow() {
  return snap.readNow();
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readPreferences() {
  const home = homeDir;
  const candidates = [
    nowPath ? path.join(path.dirname(nowPath), 'preferences.json') : null,
    path.join(home, 'preferences.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const value = readJsonIfExists(candidate);
    if (value) return value;
  }
  return null;
}

function findLatestTimetable(startDir) {
  const cacheKey = path.resolve(startDir);
  if (
    timetableScanCache.startDir === cacheKey &&
    Date.now() - timetableScanCache.at < 5000
  ) {
    return timetableScanCache.value;
  }
  const home = homeDir;
  const roots = Array.from(
    new Set([
      startDir,
      path.join(process.cwd(), 'huayuan-output'),
      home,
      path.join(os.homedir(), 'WorkBuddy'),
    ].filter(Boolean).map((item) => path.resolve(item)))
  );
  let best = null;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const pending = [{ dir: root, depth: 0 }];
    while (pending.length) {
      const current = pending.shift();
      let entries;
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = path.join(current.dir, entry.name);
        if (entry.isFile() && entry.name === 'jw-timetable.json') {
          const stat = fs.statSync(candidate);
          if (!best || stat.mtimeMs > best.mtimeMs) {
            best = {
              file: candidate,
              mtimeMs: stat.mtimeMs,
              data: readJsonIfExists(candidate),
            };
          }
        } else if (entry.isDirectory() && current.depth < 4) {
          pending.push({ dir: candidate, depth: current.depth + 1 });
        }
      }
    }
  }
  timetableScanCache = { at: Date.now(), startDir: cacheKey, value: best };
  return best;
}

function routeContext() {
  const now = readNow();
  const dir = nowPath ? path.dirname(nowPath) : homeDir;
  const timetableResult = findLatestTimetable(dir);
  const timetable = timetableResult && timetableResult.data;
  const preferences = readPreferences();
  const tasks = taskList(now || {}).map((task) => ({
    ...task,
    done: Boolean(task.done),
  }));
  return {
    ok: true,
    timetable,
    timetable_available: Boolean(timetable),
    timetable_updated_at: timetableResult ? new Date(timetableResult.mtimeMs).toISOString() : null,
    timetable_course_count: timetable && Array.isArray(timetable.courses) ? timetable.courses.length : 0,
    preferences,
    major: preferences && preferences.major ? preferences.major : null,
    tasks,
  };
}

function onboardingStatus(nowDoc = readNow()) {
  const dataDir = nowPath ? path.dirname(nowPath) : homeDir;
  return buildOnboardingStatus({
    homeDir,
    now: nowDoc,
    hasTimetable: Boolean(findLatestTimetable(dataDir)),
    hasActivities: fs.existsSync(activityPath),
  });
}

function mobileLanUrls(port) {
  const rows = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if ((entry.family !== 'IPv4' && entry.family !== 4) || entry.internal || entry.address.startsWith('169.254.')) {
        continue;
      }
      rows.push(`http://${entry.address}:${port}/`);
    }
  }
  return [...new Set(rows)];
}

async function mobileHealth(port) {
  if (!port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data && data.service === 'huayuan-mobile-remote';
  } catch {
    return false;
  }
}

async function mobileStatusPayload() {
  const state = readJsonIfExists(mobileStatePath);
  const running = Boolean(state && (await mobileHealth(state.port)));
  return {
    ok: true,
    running,
    initialized: Boolean(readNow()),
    port: running ? state.port : null,
    pairing_code: running ? state.code : null,
    urls: running ? mobileLanUrls(state.port) : [],
    public_url: running ? state.public_url || null : null,
    public_verified: running ? state.public_verified !== false : null,
    discovery_port: running ? state.discovery_port || null : null,
    started_at: running ? state.started_at || null : null,
    apk_url: '/download/app.apk',
    prompt: snap.syncInfo().prompt,
  };
}

function runMobileLauncher(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mobileLaunchScript, ...args], {
      cwd: mobileSkillDir,
      windowsHide: true,
      env: { ...process.env, HUAYUAN_HOME: homeDir },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MOBILE_CONTROL_TIMEOUT'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout: stdout.slice(-4000), stderr: stderr.slice(-1000) });
      else reject(new Error((stderr || stdout || `MOBILE_CONTROL_EXIT_${code}`).trim().slice(-1000)));
    });
  });
}

function readActivities() {
  if (!fs.existsSync(activityPath)) {
    return {
      ok: false,
      status: 'NOT_SYNCED',
      generated_at: null,
      items: [],
      sources: [],
      warnings: ['还没有活动数据，请先发送“刷新校园活动”。'],
      prompt: ACTIVITY_PROMPT,
    };
  }
  try {
    return {
      ok: true,
      status: 'READY',
      prompt: ACTIVITY_PROMPT,
      ...JSON.parse(fs.readFileSync(activityPath, 'utf8')),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'INVALID',
      generated_at: null,
      items: [],
      sources: [],
      warnings: [`活动数据无法读取：${String(error.message || error).split('\n')[0]}`],
      prompt: ACTIVITY_PROMPT,
    };
  }
}

function runActivityRefresh({ force = false } = {}) {
  if (activityRefreshRunning) return Promise.reject(new Error('ACTIVITY_REFRESH_BUSY'));
  if (!fs.existsSync(activityScript)) return Promise.reject(new Error('ACTIVITY_SCRIPT_MISSING'));
  activityRefreshRunning = true;
  const args = [
    activityScript,
    '--output-dir',
    nowPath ? path.dirname(nowPath) : homeDir,
    '--days',
    '120',
    '--max-items',
    '30',
  ];
  if (!force) args.push('--if-stale-hours', '6');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('ACTIVITY_REFRESH_TIMEOUT'));
    }, 120000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) });
      else reject(new Error((stderr || stdout || `ACTIVITY_REFRESH_EXIT_${code}`).trim().slice(-1000)));
    });
  }).finally(() => {
    activityRefreshRunning = false;
  });
}

function runTimetableRefresh() {
  if (timetableRefreshJob.running) return Promise.reject(new Error('TIMETABLE_REFRESH_BUSY'));
  if (timetableRefreshMode === 'fallback' || !fs.existsSync(jwTimetableScript)) {
    timetableRefreshJob = {
      status: 'FALLBACK_REQUIRED',
      running: false,
      started_at: null,
      finished_at: new Date().toISOString(),
      message: '当前 WorkBuddy 权限不允许驾驶舱启动本地教务脚本。请允许本专家运行本地命令，或复制指令到左侧对话发送。',
      fallback: 'agent_prompt',
    };
    return Promise.resolve(timetableRefreshJob);
  }
  const outputDir = path.dirname(nowPath);
  timetableRefreshJob = {
    status: 'RUNNING',
    running: true,
    started_at: new Date().toISOString(),
    finished_at: null,
    message: '正在连接教务系统；如需登录会打开专用 Chrome 窗口。',
    fallback: null,
  };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        jwTimetableScript,
        '--output-dir',
        outputDir,
        '--login-timeout-seconds',
        '600',
      ],
      { cwd: browserSkillDir, windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      timetableRefreshJob = {
        ...timetableRefreshJob,
        status: 'FAILED',
        running: false,
        finished_at: new Date().toISOString(),
        message: '教务课表读取超时，请检查登录状态后重试。',
        fallback: null,
      };
      resolve(timetableRefreshJob);
    }, 660000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      const detail = String(error.code || error.message || error);
      const permissionBlocked = ['EPERM', 'EACCES', 'ENOENT'].includes(error.code);
      timetableRefreshJob = {
        ...timetableRefreshJob,
        status: permissionBlocked ? 'FALLBACK_REQUIRED' : 'FAILED',
        running: false,
        finished_at: new Date().toISOString(),
        message: permissionBlocked
          ? `当前 WorkBuddy 权限或系统策略拒绝了本地脚本启动（${detail}）。请允许本专家运行本地命令/浏览器自动化，或复制指令到左侧对话发送。`
          : String(error.message || error).slice(0, 500),
        fallback: permissionBlocked ? 'agent_prompt' : null,
      };
      resolve(timetableRefreshJob);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const latest = findLatestTimetable(outputDir);
      const hasCourses = Boolean(
        latest &&
        latest.data &&
        Array.isArray(latest.data.courses) &&
        latest.data.courses.length > 0
      );
      const summaryLine = stdout
        .split(/\r?\n/)
        .reverse()
        .find((line) => /JW_TIMETABLE_(RESULT|SUMMARY):/.test(line));
      timetableRefreshJob = {
        ...timetableRefreshJob,
        status: hasCourses ? 'SUCCESS' : 'FAILED',
        running: false,
        finished_at: new Date().toISOString(),
        message: hasCourses
          ? `已更新教务课表${summaryLine ? `：${summaryLine.trim()}` : ''}`
          : (stderr || stdout || `JW_TIMETABLE_EXIT_${code}`).trim().split(/\r?\n/).slice(-1)[0].slice(0, 500),
        fallback: null,
      };
      resolve(timetableRefreshJob);
    });
  }).finally(() => {
    timetableRefreshJob.running = false;
  });
}

function taskList(nowDoc) {
  const tasks = nowDoc.tasks || {};
  return [...(tasks.p0 || []), ...(tasks.p1 || []), ...(tasks.p2 || []), ...(tasks.p3 || [])];
}

function todoSnapshot(nowDoc) {
  const tasks = nowDoc.tasks || {};
  const groups = [
    { key: 'p0', label: 'P0 · 必须优先', hint: '已过期、今天或明天截止', items: tasks.p0 || [] },
    { key: 'p1', label: 'P1 · 本周推进', hint: '三天内截止或你设定为高优先级', items: tasks.p1 || [] },
    { key: 'p2', label: 'P2 · 时间充裕', hint: '截止较远或暂未确认', items: tasks.p2 || [] },
    { key: 'p3', label: 'P3 · 不急', hint: '低优先级与阅读类事项', items: tasks.p3 || [] },
  ];
  return {
    groups,
    total: groups.reduce((sum, group) => sum + group.items.length, 0),
    overdue: nowDoc.overdue || [],
    completed_local: nowDoc.completed_local || [],
    deferred: nowDoc.deferred || [],
  };
}

function syncInfo(filePath) {
  const dir = path.dirname(filePath);
  const sources = [
    ['campus-sync.json', '校园门户'],
    ['jw-timetable.json', '教务系统'],
    ['ecourse-tasks.json', 'eCourse'],
    ['rain-fast.json', '雨课堂'],
  ];
  const available = sources
    .map(([name, label]) => {
      const file = path.join(dir, name);
      try {
        return { label, at: fs.statSync(file).mtime.toISOString() };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const syncTimes = available.map((item) => item.at).sort();
  const lastSyncAt = syncTimes.length ? syncTimes[syncTimes.length - 1] : fs.statSync(filePath).mtime.toISOString();
  const ageMs = Math.max(0, Date.now() - new Date(lastSyncAt).getTime());
  const ageDays = Math.floor(ageMs / 86400000);
  const due = ageDays >= SYNC_INTERVAL_DAYS;
  return {
    interval_days: SYNC_INTERVAL_DAYS,
    last_sync_at: lastSyncAt,
    age_days: ageDays,
    due,
    prompt: SYNC_PROMPT,
    sources: available,
    message: due
      ? `距上次平台刷新已有 ${ageDays} 天，建议现在复制下方指令发到左侧。`
      : ageDays === 0
        ? '平台数据今天已刷新。新课、临时作业或通知变化时，可随时再刷新。'
        : `距上次平台刷新已有 ${ageDays} 天；建议每 ${SYNC_INTERVAL_DAYS} 天刷新一次。`,
  };
}

function promptsFor(nowDoc) {
  const prompts = [SYNC_PROMPT];
  const first = nowDoc.first_action || {};
  if (first.headline) prompts.push('关于“' + String(first.headline).slice(0, 42) + '”，请告诉我具体第一步怎么做。');
  const pending = (nowDoc.data_status && nowDoc.data_status.pending) || [];
  if (pending.length) prompts.push('请重新核对目前标为待确认的信息，确认哪些需要我处理。');
  const tasks = taskList(nowDoc);
  if (tasks[0]) prompts.push('请把“' + String(tasks[0].title || '当前任务').slice(0, 30) + '”拆成我今天能完成的小步骤。');
  if (tasks[0]) prompts.push('我只有 30 分钟，“' + String(tasks[0].title || '当前任务').slice(0, 28) + '”先做哪一部分？');
  prompts.push('我今天想留出 60 分钟休息，请重新安排。');
  return [...new Set(prompts)].slice(0, 3);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function dashboardIndexHtml() {
  const source = path.join(routePublicDir, 'index.html');
  if (!fs.existsSync(source)) {
    return fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  }
  let html = fs.readFileSync(source, 'utf8');
  const pageNav = `
    <nav class="huayuan-page-nav" aria-label="驾驶舱页面">
      <a class="active" href="/" aria-current="page">今日安排</a>
      <a href="/todo.html">全部待办</a>
      <a href="/activities.html">可参与事项</a>
      <a href="/mobile.html">手机工作台</a>
    </nav>`;
  const brief = `
        <section class="dashboard-brief" aria-label="实时第一动作">
          <div class="dashboard-brief-head">
            <span class="dashboard-brief-kicker">LIVE · 来自最新 now.json</span>
            <span class="dashboard-brief-status" id="dashboardBriefStatus"><i></i>正在读取</span>
          </div>
          <h2 id="dashboardBriefAction">正在整理最新安排…</h2>
          <p id="dashboardBriefHint">路线读取与 WorkBuddy 任务同步会同时进行。</p>
          <div class="dashboard-brief-sync" id="dashboardBriefSync">正在读取最近一次平台同步时间…</div>
          <div class="dashboard-brief-pending" id="dashboardBriefPending" hidden></div>
          <div class="dashboard-brief-prompts" id="dashboardBriefPrompts" hidden></div>
          <div class="dashboard-brief-foot">
            <span class="dashboard-brief-status"><i></i>第一动作来自主任务池</span>
            <span class="dashboard-brief-status" id="dashboardBriefUpdated"></span>
          </div>
        </section>`;
  html = html
    .replace('href="styles.css"', 'href="/route-assets/styles.css"')
    .replaceAll('src="../data/', 'src="/route-data/')
    .replaceAll('src="../scripts/', 'src="/route-scripts/')
    .replace('src="app.js"', 'src="/route-assets/app.js"')
    .replace('<!-- HUAYUAN_PAGE_NAV -->', pageNav)
    .replace('<!-- HUAYUAN_DASHBOARD_BRIEF -->', brief)
    .replace(
      '</head>',
      '  <link rel="stylesheet" href="/dashboard-shell.css" />\n  <link rel="stylesheet" href="/dashboard-attention.css" />\n</head>'
    )
    .replace(
      '</body>',
      '  <script src="/dashboard-bridge.js"></script>\n  <script src="/dashboard-attention.js"></script>\n</body>'
    );
  return html;
}

function resolveMountedFile(pathname) {
  const mounts = [
    ['/route-assets/', routePublicDir],
    ['/route-data/', routeDataDir],
    ['/route-scripts/', routeScriptsDir],
  ];
  for (const [prefix, root] of mounts) {
    if (!pathname.startsWith(prefix)) continue;
    const relative = decodeURIComponent(pathname.slice(prefix.length));
    const file = path.resolve(root, relative);
    const withinRoot = file === root || file.startsWith(root + path.sep);
    if (!withinRoot || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return file;
  }
  return null;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.svg') return 'image/svg+xml';
  return 'text/html; charset=utf-8';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    mobileStatusPayload().then((mobile) => {
      const now = readNow();
      const onboarding = onboardingStatus(now);
      onboarding.badges.mobile = mobile.running ? 0 : 1;
      sendJson(res, 200, {
        ok: true,
        service: 'huayuan-live-dashboard',
        api_version: API_VERSION,
        browser_alive: Date.now() - lastBrowserHeartbeat < 15000,
        now_path: nowPath,
        updated_at: nowPath && fs.existsSync(nowPath) ? fs.statSync(nowPath).mtime.toISOString() : null,
        now,
        todo: snap.todoSnapshot(now),
        sync: snap.syncInfo(),
        activities: snap.readActivities(),
        prompts: snap.promptsFor(now),
        onboarding,
        mobile,
      });
    }).catch((error) => {
      sendJson(res, 503, { ok: false, error: String(error.message || error) });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/onboarding') {
    mobileStatusPayload().then((mobile) => {
      const onboarding = onboardingStatus();
      onboarding.badges.mobile = mobile.running ? 0 : 1;
      sendJson(res, 200, { ...onboarding, mobile });
    }).catch((error) => {
      sendJson(res, 503, { ok: false, error: String(error.message || error) });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
    lastBrowserHeartbeat = Date.now();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/mobile/status') {
    mobileStatusPayload()
      .then((mobile) => sendJson(res, 200, mobile))
      .catch((error) => sendJson(res, 503, { ok: false, error: String(error.message || error) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/mobile/start') {
    if (req.headers['x-huayuan-action'] !== 'start-mobile') {
      sendJson(res, 403, { ok: false, error: 'INVALID_ACTION' });
      return;
    }
    if (!nowPath || !fs.existsSync(nowPath)) {
      sendJson(res, 409, {
        ok: false,
        error: 'SETUP_REQUIRED',
        message: '先完成初始化并生成 now.json，再启动手机工作台。',
      });
      return;
    }
    runMobileLauncher(['--now', nowPath, '--no-open'])
      .then(async () => sendJson(res, 200, await mobileStatusPayload()))
      .catch((error) => sendJson(res, 503, { ok: false, error: String(error.message || error) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/mobile/stop') {
    if (req.headers['x-huayuan-action'] !== 'stop-mobile') {
      sendJson(res, 403, { ok: false, error: 'INVALID_ACTION' });
      return;
    }
    runMobileLauncher(['--stop'])
      .then(async () => sendJson(res, 200, await mobileStatusPayload()))
      .catch((error) => sendJson(res, 503, { ok: false, error: String(error.message || error) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/mobile/reset-pairing') {
    if (req.headers['x-huayuan-action'] !== 'reset-mobile-pairing') {
      sendJson(res, 403, { ok: false, error: 'INVALID_ACTION' });
      return;
    }
    if (!nowPath || !fs.existsSync(nowPath)) {
      sendJson(res, 409, { ok: false, error: 'SETUP_REQUIRED', message: '先完成初始化。' });
      return;
    }
    runMobileLauncher(['--now', nowPath, '--no-open', '--reset-pairing'])
      .then(async () => sendJson(res, 200, await mobileStatusPayload()))
      .catch((error) => sendJson(res, 503, { ok: false, error: String(error.message || error) }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/route-context') {
    try {
      sendJson(res, 200, routeContext());
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error.message || error) });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/timetable/status') {
    sendJson(res, 200, { ok: true, ...timetableRefreshJob });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/timetable/refresh') {
    if (req.headers['x-huayuan-action'] !== 'refresh-timetable') {
      sendJson(res, 403, { ok: false, error: 'INVALID_ACTION' });
      return;
    }
    if (timetableRefreshJob.running) {
      sendJson(res, 409, { ok: false, error: 'TIMETABLE_REFRESH_BUSY', ...timetableRefreshJob });
      return;
    }
    runTimetableRefresh().catch((error) => {
      timetableRefreshJob = {
        ...timetableRefreshJob,
        status: 'FAILED',
        running: false,
        finished_at: new Date().toISOString(),
        message: String(error.message || error),
      };
    });
    sendJson(res, 202, { ok: true, status: 'RUNNING', started_at: timetableRefreshJob.started_at });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/activities') {
    try {
      sendJson(res, 200, { ok: true, service: 'huayuan-live-dashboard', activities: readActivities() });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error.message || error) });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/activities/refresh') {
    if (req.headers['x-huayuan-action'] !== 'refresh-activities') {
      sendJson(res, 403, { ok: false, error: 'INVALID_ACTION' });
      return;
    }
    runActivityRefresh({ force: true })
      .then((result) => sendJson(res, 200, { ok: true, result, activities: readActivities() }))
      .catch((error) => sendJson(res, 503, { ok: false, error: String(error.message || error) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    if (!token || req.headers['x-huayuan-token'] !== token) {
      sendJson(res, 403, { ok: false });
      return;
    }
    sendJson(res, 200, { ok: true });
    setTimeout(() => server.close(() => process.exit(0)), 50);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      res.end();
      return;
    }
    if (url.pathname === '/download/app.apk') {
      if (!fs.existsSync(mobileApkPath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="huayuan-workbench.apk"',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(mobileApkPath).pipe(res);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/route.html') {
      const html = dashboardIndexHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    const mounted = resolveMountedFile(url.pathname);
    if (mounted) {
      const mime = contentType(mounted);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': mime.startsWith('text/html') ? 'no-store' : 'public, max-age=300' });
      fs.createReadStream(mounted).pipe(res);
      return;
    }
    const requested = url.pathname;
    const file = path.resolve(publicDir, `.${requested}`);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const mime = contentType(file);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': path.extname(file) === '.html' ? 'no-store' : 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(405);
  res.end();
});

server.listen(port, '127.0.0.1');

const activityRefreshHours = Number(argValue('--activity-refresh-hours', '6'));
if (Number.isFinite(activityRefreshHours) && activityRefreshHours > 0) {
  const refresh = () => {
    runActivityRefresh({ force: false }).catch(() => {
      // Keep the last good feed visible; /api/activities exposes existing warnings.
    });
  };
  setTimeout(refresh, 800);
  setInterval(refresh, activityRefreshHours * 3600 * 1000);
}
