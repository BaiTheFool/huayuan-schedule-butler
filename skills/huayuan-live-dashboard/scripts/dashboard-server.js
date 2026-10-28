'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv;
const argValue = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const port = Number(argValue('--port', '4318'));
const token = argValue('--token', '');
const nowPath = path.resolve(argValue('--now', ''));
const activityPath = path.resolve(argValue('--activities', path.join(path.dirname(nowPath), 'activity-feed.json')));
const publicDir = path.resolve(__dirname, '..', 'public');
const API_VERSION = 3;
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
let activityRefreshRunning = false;

function readNow() {
  return JSON.parse(fs.readFileSync(nowPath, 'utf8'));
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
  const args = [activityScript, '--output-dir', path.dirname(nowPath), '--days', '120', '--max-items', '30'];
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    try {
      const now = readNow();
      sendJson(res, 200, {
        ok: true,
        service: 'huayuan-live-dashboard',
        api_version: API_VERSION,
        now_path: nowPath,
        updated_at: fs.statSync(nowPath).mtime.toISOString(),
        now,
        todo: todoSnapshot(now),
        sync: syncInfo(nowPath),
        activities: readActivities(),
        prompts: promptsFor(now),
      });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: String(error.message || error) });
    }
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
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(publicDir, `.${requested}`);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(file);
    const mime = ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
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
