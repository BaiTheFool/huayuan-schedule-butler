'use strict';

/**
 * 华园日程管家 · 手机远程工作台启动器
 *
 * 找到最新 now.json → 起只读服务（remote-server.js）→ 打印手机可用的地址与 6 位配对码。
 * 需要公网访问时加 --tunnel，用本机 cloudflared 快速隧道（无需账号）拿一个临时 https 地址。
 *
 * 用法：
 *   node launch-remote.js                       # 局域网
 *   node launch-remote.js --tunnel              # 局域网 + 公网临时地址
 *   node launch-remote.js --no-open             # 不自动打开电脑浏览器
 *   node launch-remote.js --stop                # 停止工作台与隧道
 *   node launch-remote.js --reset-pairing       # 换新配对码并让已配对手机失效
 *   node launch-remote.js --self-check
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { findLatestNow } = require('../../huayuan-live-dashboard/scripts/launch-dashboard');

const SERVICE = 'huayuan-mobile-remote';
const DEFAULT_PORT = 4320;
const MAX_PORT = 4340;
const stateDir = process.env.HUAYUAN_HOME || path.join(os.homedir(), '.workbuddy', 'huayuan-schedule-butler');
const statePath = path.join(stateDir, 'mobile-remote.json');
const tunnelLogPath = path.join(stateDir, 'mobile-remote-tunnel.log');
const serverPath = path.join(__dirname, 'remote-server.js');

const argv = process.argv;
const argValue = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const hasFlag = (name) => argv.includes(name);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

async function waitForHealth(port, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const data = await response.json();
        if (data && data.service === SERVICE) return data;
      }
    } catch {
      // 服务还在启动
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function shutdown(port, token) {
  if (!port || !token) return;
  try {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Huayuan-Token': token },
    });
  } catch {
    // 可能已经停了
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch {
    // 进程可能已经不在了
  }
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function newPairCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function lanAddresses() {
  const rows = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal || entry.address.startsWith('169.254.')) continue;
      rows.push({ name, address: entry.address });
    }
  }
  const virtual = /awl|tailscale|vgate|zerotier|hamachi|virtual|vmware|vethernet|hyper-v/i;
  rows.sort((a, b) => Number(virtual.test(a.name)) - Number(virtual.test(b.name)));
  return rows;
}

function localUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
}

function findCloudflared() {
  const candidates =
    process.platform === 'win32'
      ? [
          'cloudflared.exe',
          'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
          'C:\\Program Files\\cloudflared\\cloudflared.exe',
          path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
        ]
      : ['cloudflared', '/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!candidate.includes(path.sep) && !candidate.includes('/')) {
      const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', windowsHide: true });
      if (probe.status === 0) return candidate;
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function startTunnel(port) {
  const binary = findCloudflared();
  if (!binary) return { ok: false, reason: 'CLOUDFLARED_NOT_FOUND' };
  try {
    fs.writeFileSync(tunnelLogPath, '', 'utf8');
  } catch {
    // 日志不可写不影响隧道
  }
  const logFd = fs.openSync(tunnelLogPath, 'a');
  const child = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  try {
    fs.closeSync(logFd);
  } catch {
    // ignore
  }
  const deadline = Date.now() + 45000;
  let publicUrl = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let text = '';
    try {
      text = fs.readFileSync(tunnelLogPath, 'utf8');
    } catch {
      continue;
    }
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
    if (match) {
      publicUrl = match[0];
      break;
    }
  }
  if (!publicUrl) {
    killPid(child.pid);
    return { ok: false, reason: 'TUNNEL_TIMEOUT', pid: child.pid, log: tunnelLogPath };
  }

  // 校园网常把 *.trycloudflare.com 的 DNS 拦掉（本机解析失败但隧道本身是通的），
  // 所以先用 DoH/系统 DNS 拿 IP，再用 curl --resolve 绕过本机 DNS 验证。
  const host = publicUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
  // 域名刚生成时 DoH 还查不到，等它传播（最多 75 秒），拿到 IP 后用 curl --resolve 验证。
  const verifyDeadline = Date.now() + 75000;
  let sawDns = false;
  while (Date.now() < verifyDeadline) {
    const ips = await resolveHost(host);
    if (ips.length) {
      sawDns = true;
      if (ips.some((ip) => probeViaResolve(host, ip).ok)) return { ok: true, url: publicUrl, pid: child.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  if (!sawDns) {
    return { ok: false, reason: 'TUNNEL_DNS_BLOCKED', pid: child.pid, url: publicUrl, keepAlive: true };
  }
  killPid(child.pid);
  return { ok: false, reason: 'TUNNEL_UNREACHABLE', pid: child.pid, url: publicUrl };
}

function dohLookup(url) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const result = spawnSync(curl, ['-sS', '--max-time', '8', '-H', 'Accept: application/dns-json', url], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 12000,
  });
  if (result.status !== 0 || !result.stdout) return [];
  try {
    const body = JSON.parse(result.stdout);
    const answers = Array.isArray(body.Answer) ? body.Answer : body.Answer ? [body.Answer] : [];
    return answers.filter((answer) => answer.type === 1).map((answer) => answer.data);
  } catch {
    return [];
  }
}

async function resolveHost(hostname) {
  // 校园网会屏蔽 cloudflare-dns.com / dns.google，且 Node 的 fetch 走 AliDNS 会握手失败；
  // 这里统一用 curl 查 DoH（阿里 / 腾讯 / Cloudflare），再退回系统 DNS。
  const providers = [
    `https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`,
    `https://doh.pub/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
  ];
  for (const url of providers) {
    const ips = dohLookup(url);
    if (ips.length) return ips;
  }
  try {
    const ips = await require('dns').promises.resolve4(hostname);
    if (ips.length) return ips;
  } catch {
    // 系统 DNS 也被拦
  }
  return [];
}
function probeViaResolve(host, ip) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const sink = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const result = spawnSync(
    curl,
    ['-sS', '-o', sink, '-w', '%{http_code}', '--max-time', '12', '--resolve', `${host}:443:${ip}`, `https://${host}/api/health`],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }
  );
  return { ok: String(result.stdout || '').trim() === '200', code: String(result.stdout || '').trim() };
}

async function stopExisting() {
  const state = readJson(statePath);
  if (!state) return false;
  await shutdown(state.port, state.token);
  killPid(state.tunnel_pid);
  if (state.pid) killPid(state.pid);
  try {
    fs.rmSync(statePath, { force: true });
  } catch {
    // ignore
  }
  return true;
}

async function main() {
  if (hasFlag('--self-check')) {
    // 只检查依赖与公开文件是否齐备，不起服务
    const required = ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest'].map((file) =>
      path.join(__dirname, '..', 'public', file)
    );
    const missing = required.filter((file) => !fs.existsSync(file));
    if (missing.length) throw new Error(`PUBLIC_MISSING:${missing.map((file) => path.basename(file)).join(',')}`);
    if (!fs.existsSync(serverPath)) throw new Error('SERVER_MISSING');
    console.log('MOBILE_REMOTE_SELF_CHECK_PASS');
    return;
  }

  if (hasFlag('--stop')) {
    const stopped = await stopExisting();
    console.log(stopped ? 'MOBILE_REMOTE_STOPPED' : 'MOBILE_REMOTE_NOT_RUNNING');
    return;
  }

  const nowPath = path.resolve(argValue('--now', '') || findLatestNow() || '');
  if (!nowPath || !fs.existsSync(nowPath)) throw new Error('NO_NOW_JSON:请先完成初始化或运行 now.js');
  const nowDoc = readJson(nowPath);
  if (!nowDoc || !nowDoc.first_action) throw new Error('INVALID_NOW_JSON');

  const old = readJson(statePath);
  if (old && path.resolve(old.nowPath || '') === nowPath && !hasFlag('--reset-pairing')) {
    const health = await waitForHealth(old.port, 800);
    if (health) {
      printReady({ ...old, reused: true });
      return;
    }
  }
  await stopExisting();

  const host = argValue('--host', '0.0.0.0');
  const token = newToken();
  const code = newPairCode();

  let chosen = null;
  const fixedPort = argValue('--port', '');
  const ports = fixedPort ? [Number(fixedPort)] : Array.from({ length: MAX_PORT - DEFAULT_PORT + 1 }, (_, index) => DEFAULT_PORT + index);
  for (const port of ports) {
    if (await waitForHealth(port, 200)) continue;
    const child = spawn(
      process.execPath,
      [serverPath, '--now', nowPath, '--port', String(port), '--host', host, '--token', token, '--code', code],
      { detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname }
    );
    child.unref();
    const ready = await waitForHealth(port, 5000);
    if (ready) {
      chosen = { port, pid: child.pid };
      break;
    }
    killPid(child.pid);
  }
  if (!chosen) throw new Error('MOBILE_REMOTE_START_FAILED');

  const state = {
    service: SERVICE,
    host,
    port: chosen.port,
    token,
    code,
    nowPath,
    pid: chosen.pid,
    tunnel_pid: null,
    public_url: null,
    started_at: new Date().toISOString(),
  };

  if (hasFlag('--tunnel')) {
    const tunnel = await startTunnel(chosen.port);
    if (tunnel.ok) {
      state.public_url = tunnel.url;
      state.public_verified = true;
      state.tunnel_pid = tunnel.pid;
    } else {
      if (tunnel.keepAlive && tunnel.url) {
        state.public_url = tunnel.url;
        state.public_verified = false;
        state.tunnel_pid = tunnel.pid;
      }
      console.log(`MOBILE_REMOTE_TUNNEL_FAILED:${tunnel.reason}`);
    }
  }

  writeState(state);
  printReady(state);

  if (!hasFlag('--no-open')) openBrowser(`http://127.0.0.1:${chosen.port}/?k=${token}`);
}

function printReady(state) {
  const urls = lanAddresses().map((row) => ({ url: `http://${row.address}:${state.port}/`, label: row.name }));
  const primary = urls[0] || { url: localUrl(state.port), label: 'loopback' };
  console.log(`MOBILE_REMOTE_READY:${primary.url}`);
  if (urls.length > 1) console.log(`MOBILE_REMOTE_URLS:${urls.map((row) => row.url).join(' ')}`);
  console.log(`MOBILE_REMOTE_PAIR:${state.code}`);
  console.log(`MOBILE_REMOTE_LOCAL:http://127.0.0.1:${state.port}/?k=${state.token}`);
  console.log(`MOBILE_REMOTE_PORT:${state.port}`);
  if (state.public_url) {
    console.log(`${state.public_verified === false ? 'MOBILE_REMOTE_PUBLIC_UNVERIFIED' : 'MOBILE_REMOTE_PUBLIC'}:${state.public_url}`);
  }
  if (state.reused) console.log('MOBILE_REMOTE_REUSED:true');
  console.log(`MOBILE_REMOTE_STATE:${statePath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`MOBILE_REMOTE_FAILED:${String((error && error.message) || error).split('\n')[0]}`);
    process.exitCode = 1;
  });
}

module.exports = { findLatestNow, lanAddresses };
