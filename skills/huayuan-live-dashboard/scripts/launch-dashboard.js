'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_PORT = 4318;
const MAX_PORT = 4338;
const SERVICE = 'huayuan-live-dashboard';
const REQUIRED_API_VERSION = 5;
const stateDir =
  process.env.HUAYUAN_HOME || path.join(os.homedir(), '.workbuddy', 'huayuan-schedule-butler');
const statePath = path.join(stateDir, 'live-dashboard.json');
const pagePaths = {
  today: '/',
  todo: '/todo.html',
  activities: '/activities.html',
  mobile: '/mobile.html',
};

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function requestedPagePath() {
  return pagePaths[String(argValue('--page', '')).toLowerCase()] || '/';
}

function dashboardUrl(port) {
  return `http://127.0.0.1:${port}${requestedPagePath()}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findLatestNow() {
  const explicit = argValue('--now');
  if (explicit) return path.resolve(explicit);
  const roots = [
    process.env.HUAYUAN_OUTPUT_DIR,
    path.join(process.cwd(), 'huayuan-output'),
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'now.json');
      if (fs.existsSync(file)) candidates.push(file);
    }
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
}

async function waitForHealth(port, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      if (response.ok) {
        const data = await response.json();
        if (data && data.ok && data.service === SERVICE && Number(data.api_version || 0) >= REQUIRED_API_VERSION) {
          return data;
        }
      }
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function stopOld(state) {
  if (!state || !state.port || !state.token) return;
  try {
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Huayuan-Token': state.token },
    });
  } catch {
    // A stale dashboard may already be gone.
  }
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  if (process.argv.includes('--self-check')) {
    console.log('SELF_CHECK_PASS');
    return;
  }
  const candidateNow = findLatestNow();
  const nowPath = candidateNow && fs.existsSync(candidateNow) ? candidateNow : null;
  if (nowPath) {
    const nowDoc = readJson(nowPath);
    if (!nowDoc) throw new Error('INVALID_NOW_JSON');
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const oldState = readJson(statePath);
  const oldNowPath = oldState && oldState.nowPath ? path.resolve(oldState.nowPath) : null;
  if (oldState && oldNowPath === nowPath) {
    const health = await waitForHealth(oldState.port, 400);
    if (health) {
      const url = dashboardUrl(oldState.port);
      if (!process.argv.includes('--no-open') && (!health.browser_alive || requestedPagePath() !== '/')) {
        openBrowser(url);
      }
      console.log(`LIVE_DASHBOARD_READY:${url}`);
      return;
    }
  }
  await stopOld(oldState);

  const serverPath = path.join(__dirname, 'dashboard-server.js');
  let chosen = null;
  for (let port = DEFAULT_PORT; port <= MAX_PORT; port += 1) {
    const health = await waitForHealth(port, 250);
    if (health) continue;
    const token = require('crypto').randomBytes(24).toString('hex');
    const serverArgs = [serverPath];
    if (nowPath) serverArgs.push('--now', nowPath);
    serverArgs.push('--port', String(port), '--token', token);
    const child = spawn(process.execPath, serverArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(serverPath),
    });
    child.unref();
    const ready = await waitForHealth(port);
    if (ready) {
      chosen = { port, token };
      break;
    }
  }
  if (!chosen) throw new Error('DASHBOARD_START_FAILED');
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        service: SERVICE,
        port: chosen.port,
        token: chosen.token,
        nowPath,
        onboarding_mode: !nowPath,
        pid: null,
        started_at: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
  const url = dashboardUrl(chosen.port);
  if (!process.argv.includes('--no-open')) openBrowser(url);
  if (!nowPath) console.log('LIVE_DASHBOARD_ONBOARDING_MODE:1');
  console.log(`LIVE_DASHBOARD_READY:${url}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`LIVE_DASHBOARD_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exitCode = 1;
  });
}

module.exports = { findLatestNow };
