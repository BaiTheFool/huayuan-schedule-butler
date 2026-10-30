'use strict';

/**
 * 华园日程管家 · 手机远程工作台（只读服务端）
 *
 * 把电脑上的 now.json / plan.json / activity-feed.json 以只读方式提供给手机浏览器：
 *   - 绑定 0.0.0.0（手机同 Wi-Fi 或隧道可访问），只读、无任何写接口；
 *   - 首次连接用电脑上显示的 6 位配对码换令牌，之后手机自动记住；
 *   - 静态资源只发 public/ 里的白名单文件，不暴露电脑文件系统。
 *
 * 用法（一般由 launch-remote.js 调用）：
 *   node remote-server.js --now <now.json> --port 4320 --host 0.0.0.0 --token <hex> --code 123456
 */

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createSnapshot } = require('../../huayuan-live-dashboard/lib/snapshot');
const routeEngine = require('../../huayuan-campus-route/scripts/route-engine');
const campusData = require('../../huayuan-campus-route/data/campus-data');

const SERVICE = 'huayuan-mobile-remote';
const API_VERSION = 1;
const MAX_PAIR_FAILURES = 8;
const PAIR_WINDOW_MS = 5 * 60 * 1000;
const DISCOVERY_REQUEST = 'HUAYUAN_DISCOVER/1';

const argv = process.argv;
const argValue = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const port = Number(argValue('--port', '4320'));
const host = argValue('--host', '0.0.0.0');
const nowPath = path.resolve(argValue('--now', ''));
const activityPath = path.resolve(argValue('--activities', path.join(path.dirname(nowPath), 'activity-feed.json')));
const planPath = path.resolve(argValue('--plan', path.join(path.dirname(nowPath), 'plan.json')));
const token = String(argValue('--token', '') || '');
const pairCode = String(argValue('--code', '') || '');
const publicDir = path.resolve(__dirname, '..', 'public');

if (!token || token.length < 32) {
  console.error('MOBILE_REMOTE_BAD_TOKEN');
  process.exit(2);
}
if (!/^\d{6}$/.test(pairCode)) {
  console.error('MOBILE_REMOTE_BAD_CODE');
  process.exit(2);
}

const snap = createSnapshot({ nowPath, activityPath, planPath });

// ── 鉴权 ────────────────────────────────────────────────────────────
const tokenDigest = crypto.createHash('sha256').update(token).digest();
function presentedToken(req, url) {
  const header = req.headers['x-huayuan-token'];
  if (typeof header === 'string' && header) return header;
  const query = url.searchParams.get('k') || url.searchParams.get('t');
  if (query) return query;
  const cookie = req.headers.cookie || '';
  const match = /(?:^|;\s*)huayuan_token=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : '';
}
function authorized(req, url) {
  const presented = presentedToken(req, url);
  if (!presented) return false;
  const digest = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(digest, tokenDigest);
}

// ── 配对码限速（防爆破）────────────────────────────────────────────
const pairAttempts = new Map();
function pairGuard(ip) {
  const now = Date.now();
  const record = pairAttempts.get(ip) || { fails: 0, since: now, lockedUntil: 0 };
  if (record.lockedUntil && record.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
  if (now - record.since > PAIR_WINDOW_MS) {
    record.fails = 0;
    record.since = now;
    record.lockedUntil = 0;
  }
  return { locked: false, record };
}
function notePairFailure(ip) {
  const guard = pairGuard(ip);
  if (guard.locked) return;
  const record = guard.record;
  record.fails += 1;
  if (record.fails >= MAX_PAIR_FAILURES) record.lockedUntil = Date.now() + PAIR_WINDOW_MS;
  pairAttempts.set(ip, record);
}
function notePairSuccess(ip) {
  pairAttempts.delete(ip);
}

// ── HTTP 基础设施 ──────────────────────────────────────────────────
const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...COMMON_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname, headOnly = false) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(publicDir, relative);
  const inside = file === publicDir || file.startsWith(publicDir + path.sep);
  if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext];
  if (!type) return false;
  res.writeHead(200, {
    ...COMMON_HEADERS,
    'Content-Type': type,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
  });
  if (headOnly) {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findLatestTimetable() {
  const roots = [
    path.dirname(nowPath),
    process.env.HUAYUAN_SEARCH_ROOT,
    process.env.HUAYUAN_HOME,
    path.join(require('os').homedir(), 'WorkBuddy'),
  ].filter(Boolean);
  let best = null;
  for (const root of roots.map((item) => path.resolve(item))) {
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
            best = { file: candidate, mtimeMs: stat.mtimeMs, data: readJsonIfExists(candidate) };
          }
        } else if (
          entry.isDirectory() &&
          current.depth < 5 &&
          !['.git', 'node_modules', 'profiles', 'cache'].includes(entry.name)
        ) {
          pending.push({ dir: candidate, depth: current.depth + 1 });
        }
      }
    }
  }
  return best;
}

function nowTasks(nowDoc) {
  const tasks = (nowDoc && nowDoc.tasks) || {};
  return [tasks.p0 || [], tasks.p1 || [], tasks.p2 || [], tasks.p3 || []]
    .flat()
    .filter((task) => task && !task.done)
    .map((task) => ({
      ...task,
      due: task.due || task.deadline || null,
    }));
}

function routePayload(nowDoc) {
  const timetableResult = findLatestTimetable();
  const timetable = timetableResult && timetableResult.data;
  if (!timetable) {
    return {
      ok: false,
      available: false,
      message: '还没有找到本地教务课表，手机端暂时不能绘制路线。',
    };
  }
  const preferences =
    readJsonIfExists(path.join(process.env.HUAYUAN_HOME || '', 'preferences.json')) ||
    readJsonIfExists(path.join(require('os').homedir(), '.workbuddy', 'huayuan-schedule-butler', 'preferences.json'));
  const preset =
    preferences &&
    ['balanced', 'grind', 'play', 'sport'].includes(preferences.study && preferences.study.intensity)
      ? preferences.study.intensity
      : 'balanced';
  const plan = routeEngine.planDay({
    date: nowDoc && nowDoc.now ? nowDoc.now.date : undefined,
    timetable,
    preferences,
    preset,
    weekNumber: nowDoc && nowDoc.week ? nowDoc.week.number : null,
    tasks: nowTasks(nowDoc),
    weather: { condition: 'cloudy', temperature: 26, source: 'manual' },
  });
  if (!plan || !plan.ok) {
    return {
      ok: false,
      available: false,
      message: (plan && plan.message) || '路线生成失败。',
    };
  }
  const poiById = new Map(campusData.POIS.map((poi) => [poi.id, poi]));
  const pois = (plan.stops || [])
    .map((stop) => poiById.get(stop.poiId))
    .filter(Boolean)
    .map((poi) => ({
      id: poi.id,
      name: poi.name,
      short: poi.short,
      category: poi.category,
      icon: poi.icon,
      lat: poi.lat,
      lng: poi.lng,
    }));
  return {
    ok: true,
    available: true,
    timetable_available: true,
    timetable_course_count: Array.isArray(timetable.courses) ? timetable.courses.length : 0,
    campus: campusData.CAMPUS,
    meta: plan.meta,
    summary: plan.summary,
    blocks: plan.blocks,
    stops: plan.stops,
    route: plan.route,
    pois,
    warnings: plan.warnings,
    validation: plan.validation,
  };
}

function dashboardPayload() {
  const base = snap.dashboard();
  const plan = snap.readPlan();
  return {
    ok: true,
    service: SERVICE,
    api_version: API_VERSION,
    server: { name: '华园日程管家 · 手机工作台', read_only: true, api_version: API_VERSION },
    ...base,
    route: routePayload(base.now),
    plan: plan
      ? {
          generated_at: plan.generated_at || null,
          scope: plan.scope || null,
          plan_note: plan.plan_note || null,
          available: Boolean(plan.usable_as_plan),
          days: Array.isArray(plan.days) ? plan.days : [],
        }
      : null,
  };
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    res.writeHead(400, COMMON_HEADERS);
    res.end();
    return;
  }
  const ip = req.socket.remoteAddress || 'unknown';

  if (url.pathname === '/api/health') {
    let ready = true;
    try {
      snap.readNow();
    } catch {
      ready = false;
    }
    sendJson(res, 200, {
      ok: true,
      service: SERVICE,
      api_version: API_VERSION,
      ready,
      pair_required: true,
      now_available: ready,
      time: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === '/api/pair') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    const guard = pairGuard(ip);
    if (guard.locked) {
      sendJson(res, 429, { ok: false, error: 'PAIR_LOCKED', retry_after: guard.retryAfter });
      return;
    }
    let code = '';
    try {
      const type = String(req.headers['content-type'] || '');
      if (type.includes('application/json')) {
        const body = JSON.parse((await readBody(req)) || '{}');
        code = String(body.code || '');
      } else {
        code = new URLSearchParams(await readBody(req)).get('code') || '';
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'BAD_REQUEST' });
      return;
    }
    code = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code) || code !== pairCode) {
      notePairFailure(ip);
      const left = Math.max(0, MAX_PAIR_FAILURES - (pairGuard(ip).record?.fails || 0));
      sendJson(res, 401, { ok: false, error: 'PAIR_CODE_INVALID', attempts_left: left });
      return;
    }
    notePairSuccess(ip);
    sendJson(res, 200, {
      ok: true,
      token,
      service: SERVICE,
      api_version: API_VERSION,
      expires_hint: '一直有效，直到你在电脑上重新生成配对码',
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'READ_ONLY' });
      return;
    }
    if (!authorized(req, url)) {
      sendJson(res, 401, { ok: false, error: 'PAIR_REQUIRED' });
      return;
    }
    if (url.pathname === '/api/ping') {
      sendJson(res, 200, { ok: true, service: SERVICE, api_version: API_VERSION, time: new Date().toISOString() });
      return;
    }
    if (url.pathname === '/api/dashboard') {
      try {
        sendJson(res, 200, dashboardPayload());
      } catch (error) {
        sendJson(res, 503, {
          ok: false,
          error: 'NOW_UNAVAILABLE',
          message: String((error && error.message) || error).split('\n')[0],
        });
      }
      return;
    }
    if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => server.close(() => process.exit(0)), 50);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, COMMON_HEADERS);
    res.end();
    return;
  }

  // 把随包的 Android 壳直接发给手机：配对页底部「装到手机桌面」就指到这里。
  // 只是静态二进制，不需要令牌；文件不在时 404，不影响其它功能。
  if (url.pathname === '/download/app.apk') {
    const apkPath = path.resolve(__dirname, '..', 'apk', 'huayuan-workbench.apk');
    if (!fs.existsSync(apkPath)) {
      res.writeHead(404, { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('APK_NOT_BUNDLED');
      return;
    }
    const stat = fs.statSync(apkPath);
    res.writeHead(200, {
      ...COMMON_HEADERS,
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': String(stat.size),
      'Content-Disposition': 'attachment; filename="huayuan-workbench.apk"',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(apkPath).pipe(res);
    return;
  }

  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, COMMON_HEADERS);
    res.end();
    return;
  }
  const headOnly = req.method === 'HEAD';
  if (serveStatic(res, pathname, headOnly)) return;

  // 前端是单页应用：只有浏览器导航（Accept 含 text/html）才回落到 index.html，
  // 其它未知路径一律 404，避免把不存在的文件伪装成页面。
  if (String(req.headers.accept || '').includes('text/html') && serveStatic(res, '/index.html', headOnly)) return;
  res.writeHead(404, COMMON_HEADERS);
  res.end('Not found');
});

server.on('error', (error) => {
  console.error(`MOBILE_REMOTE_SERVER_ERROR:${String((error && error.message) || error).split('\n')[0]}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`MOBILE_REMOTE_SERVER_LISTENING:http://${host}:${port}`);
});

// ── 局域网发现（给手机 App 用）──────────────────────────────────────
// App 向 255.255.255.255:4327 广播 HUAYUAN_DISCOVER/1，这里只回一个端口 + 版本，
// 不回令牌、不回配对码、不回任何数据；只应答来源是私有地址的请求。
const version = String(argValue('--version', '') || '');
const discoveryPort = Number(argValue('--discovery-port', '4327'));

function isPrivateAddress(address) {
  if (!address) return false;
  if (address === '127.0.0.1' || address.startsWith('::ffff:127.')) return true;
  const parts = address.replace(/^::ffff:/, '').split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

if (Number.isFinite(discoveryPort) && discoveryPort > 0) {
  const discovery = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  discovery.on('error', () => {
    try {
      discovery.close();
    } catch {
      // 端口被另一个实例占用时静默跳过：发现只是便利功能
    }
  });
  discovery.on('message', (message, remote) => {
    if (!isPrivateAddress(remote.address)) return;
    if (message.toString('utf8').trim() !== DISCOVERY_REQUEST) return;
    const reply = Buffer.from(
      JSON.stringify({ service: SERVICE, api_version: API_VERSION, port, version, name: '华园日程管家 · 手机工作台' }),
      'utf8'
    );
    discovery.send(reply, remote.port, remote.address, () => {});
  });
  discovery.bind(discoveryPort, '0.0.0.0', () => {
    try {
      discovery.setBroadcast(true);
    } catch {
      // 某些网络不允许，忽略
    }
  });
}
