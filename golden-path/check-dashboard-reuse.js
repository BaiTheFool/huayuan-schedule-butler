'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NOW_SCRIPT = path.join(ROOT, 'skills', 'huayuan-browser-session', 'scripts', 'now.js');
const LAUNCH_SCRIPT = path.join(ROOT, 'skills', 'huayuan-live-dashboard', 'scripts', 'launch-dashboard.js');
const TIMETABLE = path.join(ROOT, 'skills', 'huayuan-campus-route', 'test', 'fixtures', 'jw-university-town.json');
const PREFERENCES = path.join(ROOT, 'golden-path', 'fixtures', 'preferences.json');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-dashboard-reuse-'));
const home = path.join(work, 'home');
const output = path.join(work, 'output');
const searchRoot = path.join(work, 'workbuddy');
const timetableDir = path.join(searchRoot, 'huayuan-output', 'latest');

let passed = 0;
function check(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
}

function runNode(script, args, env, cwd = work) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 20000,
  });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  assert.strictEqual(result.status, 0, text);
  return text;
}

function windowsTerminalCount() {
  if (process.platform !== 'win32') return 0;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', '@(Get-Process WindowsTerminal -ErrorAction SilentlyContinue).Count'],
    { encoding: 'utf8', windowsHide: true }
  );
  return Number(String(result.stdout || '0').trim()) || 0;
}

function field(text, name) {
  const match = text.match(new RegExp(`^${name}:(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

async function shutdown(state) {
  if (!state || !state.port || !state.token) return;
  try {
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Huayuan-Token': state.token },
    });
  } catch {
    // The test process may already be gone.
  }
}

(async () => {
  let state = null;
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(timetableDir, { recursive: true });
    fs.copyFileSync(PREFERENCES, path.join(home, 'preferences.json'));
    fs.copyFileSync(TIMETABLE, path.join(timetableDir, 'jw-timetable.json'));
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ setup_state: 'completed', authorized_platforms: ['portal', 'jw', 'ecourse', 'rain'] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(home, 'user-state.json'),
      JSON.stringify({ semester: { current_week: 10, current_week_source: '用户确认' } }),
      'utf8'
    );

    const env = { HUAYUAN_HOME: home, HUAYUAN_SEARCH_ROOT: searchRoot };
    const nowOutput = runNode(NOW_SCRIPT, ['--output-dir', output], env);
    const now = JSON.parse(fs.readFileSync(path.join(output, 'now.json'), 'utf8'));
    check('now.js 能跨会话找到最新本地课表', now.data_status.timetable_known === true, nowOutput.split('\n')[0]);
    check('顶部第一动作使用真实课表，不再误报未读课表', !now.data_status.pending.some((item) => item.includes('未读取到教务课表')));
    check('now.js 发布固定驾驶舱快照', fs.existsSync(path.join(home, 'live-now.json')));

    const terminalsBefore = windowsTerminalCount();
    const launchArgs = ['--now', path.join(output, 'now.json'), '--no-open'];
    const first = runNode(LAUNCH_SCRIPT, launchArgs, env);
    state = JSON.parse(fs.readFileSync(path.join(home, 'live-dashboard.json'), 'utf8'));
    const firstPid = field(first, 'LIVE_DASHBOARD_PID');
    check('首次启动创建独立驻留服务', field(first, 'LIVE_DASHBOARD_ACTION') === 'started' && Boolean(firstPid), firstPid);
    check('驾驶舱使用稳定 now 快照', path.resolve(state.nowPath) === path.resolve(path.join(home, 'live-now.json')));

    const second = runNode(LAUNCH_SCRIPT, launchArgs, env);
    const secondPid = field(second, 'LIVE_DASHBOARD_PID');
    const terminalsAfter = windowsTerminalCount();
    check('再次处理消息只刷新已有服务', field(second, 'LIVE_DASHBOARD_ACTION') === 'refresh-existing');
    check('刷新不会更换服务 PID', firstPid === secondPid, `${firstPid} -> ${secondPid}`);
    check('启动与刷新不会弹出终端窗口', terminalsBefore === terminalsAfter, `${terminalsBefore} -> ${terminalsAfter}`);

    const stale = path.join(work, 'stale-now.json');
    fs.writeFileSync(
      stale,
      JSON.stringify({ now: { date: '2026-10-30', time: '12:00' }, data_status: { timetable_known: false }, first_action: { headline: '旧快照' } }),
      'utf8'
    );
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(stale, oldTime, oldTime);
    runNode(LAUNCH_SCRIPT, ['--now', stale, '--no-open'], env);

    const dashboard = await (await fetch(`http://127.0.0.1:${state.port}/api/dashboard`)).json();
    check('旧快照不能覆盖刚生成的课表数据', dashboard.now?.data_status?.timetable_known === true);
    console.log(`DASHBOARD_REUSE:PASS ${passed}/${passed}`);
  } finally {
    await shutdown(state);
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(`DASHBOARD_REUSE:FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
});
