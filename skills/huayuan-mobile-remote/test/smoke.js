'use strict';

/**
 * 手机远程工作台冒烟测试（离线、无第三方依赖）。
 *
 * 覆盖：启动器输出 → 配对码/令牌鉴权 → 只读接口载荷 → 静态资源与安全响应头 →
 *       路径穿越与写方法拦截 → 配对码爆破限速 → 正常停止。
 *
 * 用法：node skills/huayuan-mobile-remote/test/smoke.js
 * 产物写系统临时目录，结束后删除；不读写任何真实用户数据。
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'launch-remote.js');
const DISCOVERY_PORT = 4427; // 避开本机正在运行的 4327，防止端口复用导致测试抖动
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-mobile-smoke-'));
const HOME = path.join(WORK, 'home');
const OUT = path.join(WORK, 'out');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', () => resolve(0));
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** 模拟手机 App：广播 HUAYUAN_DISCOVER/1，等电脑回端口。 */
function probeDiscovery(expectedPort, timeoutMs = 3000, discoveryPort = DISCOVERY_PORT) {
  const dgram = require('dgram');
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(result);
    };
    socket.on('message', (message) => {
      try {
        const body = JSON.parse(message.toString('utf8'));
        if (body.service !== 'huayuan-mobile-remote') return;
        if (Number(body.port) === expectedPort) {
          finish({ found: true, port: Number(body.port), detail: `v${body.version || '?'}` });
        }
      } catch {
        // 不认识的报文忽略
      }
    });
    socket.bind(0, '0.0.0.0', () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // ignore
      }
      const payload = Buffer.from('HUAYUAN_DISCOVER/1', 'utf8');
      for (const target of ['255.255.255.255', '127.0.0.1']) {
        try {
          socket.send(payload, discoveryPort, target);
        } catch {
          // ignore
        }
      }
    });
    setTimeout(() => finish({ found: false, port: 0, detail: 'no reply' }), timeoutMs);
  });
}

const NOW = {
  generated_at: new Date().toISOString(),
  now: { date: '2026-11-05', time: '18:20', weekday: '周四', display: '2026-11-05 18:20', source: 'system' },
  week: { number: 10, reliable: true, source: '用户确认', needs_confirmation: false, filter: { applied: true } },
  confidence: 'grounded',
  data_status: {
    timetable_known: true,
    tasks_complete: true,
    tasks_sources_read: { ecourse: true, rain: true },
    estimate_only: false,
    caveats: [],
    pending: ['有 1 条任务截止时间待确认（样例）'],
    overrides: { courses: 0, cancelled: 0, manual_tasks: 0 },
  },
  current: { status: 'free', title: '现在没有课，是自由时间', kind: null },
  window: { start: '18:20', end: '18:30', minutes: 10, enough_for_block: false, short: true, note: '从现在起有 10 分钟可用' },
  first_action: {
    type: 'goto_class',
    headline: '先去上课：实验课（样例）（18:30-20:00）',
    detail: '还有 10 分钟，够走到教室。',
    starts_at: '18:30',
    ends_at: '20:00',
  },
  sequence: [
    { date: '2026-11-05', day_name: '周四', start: '18:30', end: '20:00', minutes: 90, kind: 'fixed', title: '实验课（样例）', course: '软件工程实践', source: null, priority: null, reason: '教务课表固定课程' },
    { date: '2026-11-05', day_name: '周四', start: '20:00', end: '21:00', minutes: 60, kind: 'task', title: '第 6 章作业（样例）', course: '生产运作管理（样例）', source: 'eCourse', priority: 'P0', reason: '截止临近' },
  ],
  tasks: {
    p0: [{ title: '第 6 章作业（样例）', course: '生产运作管理（样例）', sources: ['eCourse'], deadline: '2026-11-05 23:59', deadline_display: '今天 23:59', estimated_minutes: 120, priority: 'P0', confirm_reasons: [] }],
    p1: [],
    p2: [],
    p3: [],
    total: 1,
  },
  overdue: [],
  completed_local: [],
  deferred: [],
  limits: { daily_limit_min: 240, max_continuous_minutes: 90 },
  footer: '回复「完成X」/「X延后到…」我会立即重排。',
  readiness: { ready: true, estimate_only: false, blockers: [], next_action: '按第一动作执行' },
  freshness: { stale: false, age_seconds: 0 },
  brief: '先去上课（样例）。',
  setup: { state: 'completed', completed_at: new Date().toISOString(), missing: [] },
};

const PLAN = {
  generated_at: new Date().toISOString(),
  scope: 'week',
  usable_as_plan: true,
  days: [
    {
      date: '2026-11-05',
      blocks: [
        { title: '实验课（样例）', kind: 'fixed', start: '18:30', end: '20:00' },
        { title: '第 6 章作业（样例）', kind: 'task', start: '20:00', end: '21:00' },
        { title: '休息', kind: 'break', start: '21:00', end: '21:40' },
      ],
    },
  ],
};

const ACTIVITIES = {
  generated_at: new Date().toISOString(),
  college: '软件学院',
  public_web_only: true,
  item_count: 1,
  items: [
    {
      title: '第十届程序设计竞赛校内选拔（样例）',
      url: 'https://example.edu.cn/contest',
      source_label: '软件学院 · 通知公告',
      scope: '学院',
      type: 'competition',
      eligible: true,
      deadline: '2026-11-12',
      summary: '三人一队，现场机试。',
      id: 'sample01',
      status: 'open',
    },
  ],
  sources: [{ id: 'cs', label: '软件学院 · 通知公告', status: 'READ_OK', items_seen: 1 }],
  warnings: [],
};

async function main() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'now.json'), JSON.stringify(NOW, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify(PLAN, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'activity-feed.json'), JSON.stringify(ACTIVITIES, null, 2), 'utf8');

  const port = await freePort();
  check('拿到空闲本地端口', port > 0, String(port));
  const env = { ...process.env, HUAYUAN_HOME: HOME };

  const launch = spawnSync(
    process.execPath,
    [LAUNCHER, '--now', path.join(OUT, 'now.json'), '--no-open', '--port', String(port), '--discovery-port', String(DISCOVERY_PORT)],
    { encoding: 'utf8', env, timeout: 30000 }
  );
  const stdout = `${launch.stdout || ''}${launch.stderr || ''}`;
  check('启动器退出码为 0', launch.status === 0, `exit=${launch.status}`);
  check('输出手机可用地址', /MOBILE_REMOTE_READY:http:\/\//.test(stdout));
  check('输出 6 位配对码', /MOBILE_REMOTE_PAIR:\d{6}/.test(stdout));
  check('输出本机直连地址（带令牌）', /MOBILE_REMOTE_LOCAL:http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32,}/.test(stdout));

  const stateFile = path.join(HOME, 'mobile-remote.json');
  check('状态文件落盘', fs.existsSync(stateFile));
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  check('状态文件含服务名与端口', state.service === 'huayuan-mobile-remote' && Number(state.port) === port);
  check('令牌长度不小于 32', typeof state.token === 'string' && state.token.length >= 32);

  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    const healthBody = await health.json();
    check('健康检查免鉴权', health.status === 200 && healthBody.service === 'huayuan-mobile-remote');
    check('健康检查声明需要配对', healthBody.pair_required === true);

    const anonymous = await fetch(`${base}/api/dashboard`);
    check('未配对访问数据被拒（401）', anonymous.status === 401);

    const wrong = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    const wrongBody = await wrong.json();
    check('错误配对码返回 401 并提示剩余次数', wrong.status === 401 && Number(wrongBody.attempts_left) < 8);

    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: state.code }),
    });
    const pairedBody = await paired.json();
    check('正确配对码换到令牌', paired.status === 200 && pairedBody.token === state.token);

    const headers = { 'X-Huayuan-Token': state.token };
    const dashboard = await fetch(`${base}/api/dashboard`, { headers });
    const body = await dashboard.json();
    check('配对后可读数据', dashboard.status === 200 && body.ok === true);
    check('返回第一动作', body.now && body.now.first_action && body.now.first_action.headline.includes('先去上课'));
    check('返回 P0 待办分组', body.todo && body.todo.groups && body.todo.groups[0].items.length === 1);
    check('返回本周计划', body.plan && body.plan.days && body.plan.days.length === 1);
    check('返回活动列表', body.activities && body.activities.items.length === 1);
    check('返回可复制指令', Array.isArray(body.prompts) && body.prompts.length > 0);

    const queryAuth = await fetch(`${base}/api/dashboard?k=${encodeURIComponent(state.token)}`);
    check('链接内令牌同样可用（手机直连）', queryAuth.status === 200);

    const discovered = await probeDiscovery(port);
    check('局域网发现返回本机端口（App 用）', discovered.found && discovered.port === port, discovered.detail);

    const writeAttempt = await fetch(`${base}/api/dashboard`, { method: 'POST', headers });
    check('写方法被拒（405）', writeAttempt.status === 405);

    const unknownApi = await fetch(`${base}/api/nope`, { headers });
    check('未知接口 404', unknownApi.status === 404);

    const index = await fetch(`${base}/`, { headers: { Accept: 'text/html' } });
    const indexText = await index.text();
    check('首页可打开且含配对入口', index.status === 200 && indexText.includes('手机工作台') && indexText.includes('pairCode'));
    check('首页带 CSP 与 nosniff', Boolean(index.headers.get('content-security-policy')) && index.headers.get('x-content-type-options') === 'nosniff');

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    const manifestBody = await manifest.json();
    check('manifest 可安装（standalone + 192/512 图标）', manifest.status === 200 && manifestBody.display === 'standalone' && manifestBody.icons.some((icon) => icon.sizes === '192x192') && manifestBody.icons.some((icon) => icon.sizes === '512x512'));

    const appJs = await fetch(`${base}/app.js`);
    check('前端脚本可加载', appJs.status === 200 && appJs.headers.get('content-type').includes('javascript'));

    const icon = await fetch(`${base}/icon-192.png`);
    check('PNG 图标存在', icon.status === 200 && icon.headers.get('content-type') === 'image/png');

    const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
    check('路径穿越被拦（非 200）', traversal.status !== 200);

    const secretFile = await fetch(`${base}/.git/config`);
    check('不暴露仓库文件（非 200）', secretFile.status !== 200);

    // 爆破限速：同一 IP 连续错误后锁定
    let locked = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '111111' }),
      });
      if (response.status === 429) {
        locked = true;
        break;
      }
    }
    check('连续错误配对触发限速（429）', locked);
  } finally {
    const stop = spawnSync(process.execPath, [LAUNCHER, '--stop'], { encoding: 'utf8', env, timeout: 20000 });
    check('可正常停止', /MOBILE_REMOTE_STOPPED/.test(`${stop.stdout || ''}${stop.stderr || ''}`));
    const after = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true).catch(() => false);
    check('停止后端口不再响应', after === false);
    fs.rmSync(WORK, { recursive: true, force: true });
  }

  const failed = checks.filter((item) => !item.ok);
  console.log(`MOBILE_REMOTE_SMOKE:${failed.length ? 'FAIL' : 'PASS'} ${checks.length - failed.length}/${checks.length}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(`MOBILE_REMOTE_SMOKE_FAILED:${String((error && error.stack) || error)}`);
  process.exitCode = 1;
});
