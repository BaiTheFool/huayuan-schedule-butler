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
const stableNowPath = path.join(stateDir, 'live-now.json');
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
  const matches = [];
  const explicit = argValue('--now');
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (readJson(resolved)) matches.push(resolved);
  } else {
    for (const root of [
      process.env.HUAYUAN_OUTPUT_DIR,
      process.env.HUAYUAN_SEARCH_ROOT,
      path.join(process.cwd(), 'huayuan-output'),
      path.join(os.homedir(), 'WorkBuddy'),
      stateDir,
    ].filter(Boolean)) {
      if (!fs.existsSync(root)) continue;
      const pending = [{ dir: path.resolve(root), depth: 0 }];
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
          if (entry.isFile() && entry.name === 'now.json' && readJson(candidate)) {
            matches.push(candidate);
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
  }
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0] || null;
}

function publishStableNow(source) {
  fs.mkdirSync(stateDir, { recursive: true });
  if (!source || !fs.existsSync(source)) {
    return fs.existsSync(stableNowPath) ? stableNowPath : null;
  }
  if (path.resolve(source) === path.resolve(stableNowPath)) return stableNowPath;
  if (
    fs.existsSync(stableNowPath) &&
    fs.statSync(stableNowPath).mtimeMs >= fs.statSync(source).mtimeMs
  ) {
    return stableNowPath;
  }
  const temp = `${stableNowPath}.${process.pid}.tmp`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, stableNowPath);
  return stableNowPath;
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

async function verifyDashboardPage(port) {
  const url = dashboardUrl(port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'text/html' },
    });
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const html = await response.text();
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.trim() || '';
    const isHuayuanPage = /华园/.test(title) && /HUAYUAN|dashboard-brief/i.test(html);
    if (!response.ok || !type.includes('text/html') || !isHuayuanPage) {
      throw new Error(`DASHBOARD_PAGE_INVALID:${response.status}`);
    }
    return { url, title };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('DASHBOARD_PAGE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function reportReady(port, alreadyOpen, action, pid) {
  const verified = await verifyDashboardPage(port);
  console.log(`LIVE_DASHBOARD_ALREADY_OPEN:${alreadyOpen ? '1' : '0'}`);
  console.log(`LIVE_DASHBOARD_ACTION:${action}`);
  if (pid) console.log(`LIVE_DASHBOARD_PID:${pid}`);
  console.log('LIVE_DASHBOARD_OPEN_REQUIRED:1');
  console.log('LIVE_DASHBOARD_VERIFIED:1');
  console.log('LIVE_DASHBOARD_PREVIEW_TOOL:preview_url');
  console.log(`LIVE_DASHBOARD_PREVIEW_ARGS:${JSON.stringify({ url: verified.url })}`);
  console.log(`LIVE_DASHBOARD_PAGE_TITLE:${verified.title}`);
  console.log(`LIVE_DASHBOARD_READY:${verified.url}`);
}

function startPersistentServer(serverArgs, cwd) {
  if (process.platform === 'win32') {
    const runtimeDir = path.join(stateDir, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const scriptPath = path.join(runtimeDir, `dashboard-start-${process.pid}-${Date.now()}.vbs`);
    const vbsQuote = (value) => `"${String(value).replace(/"/g, '""')}"`;
    const commandLine = [process.execPath, ...serverArgs]
      .map((value) => `"${String(value).replace(/"/g, '\\"')}"`)
      .join(' ');
    const script = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Environment("Process")("HUAYUAN_HOME") = ${vbsQuote(stateDir)}`,
      `sh.CurrentDirectory = ${vbsQuote(cwd)}`,
      `sh.Run ${vbsQuote(commandLine)}, 0, False`,
    ].join('\r\n');
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf16le');
    const taskName = `HuayuanDashboard-${process.pid}-${Date.now()}`;
    const taskAction = `wscript.exe "${scriptPath}"`;
    const created = spawnSync(
      'schtasks.exe',
      ['/Create', '/TN', taskName, '/TR', taskAction, '/SC', 'ONCE', '/ST', '23:59', '/F', '/RL', 'LIMITED'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }
    );
    if (created.status !== 0) {
      fs.rmSync(scriptPath, { force: true });
      throw new Error(`PERSISTENT_TASK_CREATE_FAILED:${String(created.stderr || created.stdout || '').trim().slice(0, 160)}`);
    }
    const started = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    const cleanup = () => {
      if (process.env.HUAYUAN_KEEP_LAUNCH_RUNTIME === '1') return;
      spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      fs.rmSync(scriptPath, { force: true });
    };
    if (started.status !== 0) {
      cleanup();
      throw new Error(`PERSISTENT_TASK_RUN_FAILED:${String(started.stderr || started.stdout || '').trim().slice(0, 160)}`);
    }
    return { pid: null, cleanup };
  }
  const child = spawn(process.execPath, serverArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd,
  });
  child.unref();
  return { pid: child.pid || null, cleanup() {} };
}

async function stopOld(state) {
  if (!state || !state.port) return;
  const before = await waitForHealth(state.port, 250);
  if (!before) return;
  try {
    if (state.token) {
      await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
        method: 'POST',
        headers: { 'X-Huayuan-Token': state.token },
      });
    }
  } catch {
    // A stale dashboard may already be gone.
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = await waitForHealth(state.port, 250);
  if (after && Number(after.pid) > 0 && Number(after.pid) !== process.pid) {
    try {
      process.kill(Number(after.pid));
    } catch {
      // If the service disappeared between checks, there is nothing to stop.
    }
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
  fs.mkdirSync(stateDir, { recursive: true });
  const nowPath = publishStableNow(candidateNow);
  const oldState = readJson(statePath);
  const oldNowPath = oldState && oldState.nowPath ? path.resolve(oldState.nowPath) : null;
  if (oldState && oldNowPath === stableNowPath) {
    const health = await waitForHealth(oldState.port, 400);
    if (health) {
      const url = dashboardUrl(oldState.port);
      if (!process.argv.includes('--no-open') && (!health.browser_alive || requestedPagePath() !== '/')) {
        openBrowser(url);
      }
      const alreadyOpen =
        Boolean(health.browser_alive) && requestedPagePath() === '/' ? '1' : '0';
      await reportReady(oldState.port, alreadyOpen === '1', 'refresh-existing', health.pid || oldState.pid);
      return;
    }
  }
  await stopOld(oldState);

  const serverPath = path.join(__dirname, 'dashboard-server.js');
  let chosen = null;
  const requestedPort = Number(argValue('--port', '0'));
  const candidatePorts =
    Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535
      ? [requestedPort]
      : Array.from({ length: MAX_PORT - DEFAULT_PORT + 1 }, (_, index) => DEFAULT_PORT + index);
  for (const port of candidatePorts) {
    const health = await waitForHealth(port, 250);
    if (health) continue;
    const token = require('crypto').randomBytes(24).toString('hex');
    const serverArgs = [serverPath];
    if (nowPath) serverArgs.push('--now', nowPath);
    serverArgs.push('--port', String(port), '--token', token);
    const persistent = startPersistentServer(serverArgs, path.dirname(serverPath));
    const ready = await waitForHealth(port);
    persistent.cleanup();
    if (ready) {
      chosen = { port, token, pid: ready.pid || persistent.pid };
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
        pid: chosen.pid,
        now_source: candidateNow,
        mode: 'stable',
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
  await reportReady(chosen.port, false, 'started', chosen.pid);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`LIVE_DASHBOARD_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exitCode = 1;
  });
}

module.exports = { findLatestNow, publishStableNow, stableNowPath };
