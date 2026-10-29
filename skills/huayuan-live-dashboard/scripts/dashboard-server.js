'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createSnapshot } = require('../lib/snapshot');

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
const snap = createSnapshot({ nowPath, activityPath });
const { readNow, readActivities } = snap;
const activityScript = path.resolve(
  __dirname,
  '..',
  '..',
  'huayuan-browser-session',
  'scripts',
  'activity-feed.js'
);
let activityRefreshRunning = false;

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
        todo: snap.todoSnapshot(now),
        sync: snap.syncInfo(),
        activities: readActivities(),
        prompts: snap.promptsFor(now),
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
