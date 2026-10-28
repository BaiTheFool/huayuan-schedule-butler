'use strict';

/**
 * 登录态探测（只读，不弹窗）
 *
 * 关键纪律：每个平台用**自己的会话命名空间**检查。
 * 门户/教务 → profiles/<id>/cas；eCourse → profiles/<id>/ecourse；雨课堂 → profiles/<id>/rain。
 * 一次只开一个 Chrome、一个 page，检查完立刻关闭，不并发、不抢前台。
 */

const fs = require('fs');
const path = require('path');
const { withBrowserSession } = require('./session-gateway');
const { PLATFORM_URLS, checkPlatform } = require('./platform-adapters');
const { defaultOutputDir, readProfileSelection, resolvePlatformDir } = require('./huayuan-paths');

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

// 并行探测没有意义：同一时刻只允许一个 Chrome，所以这里就是顺序执行
const PROBE_ORDER = ['portal', 'jw', 'ecourse', 'rain'];

async function probeOne(platform, { selection, outputDir }) {
  const result = await withBrowserSession({
    platform,
    loginUrl: PLATFORM_URLS[platform],
    outputDir,
    profileId: selection.profileId,
    profileDir: selection.profileDir,
    forceVisible: false,
    allowVisibleLogin: false,
    isAuthenticated: (args) => checkPlatform(platform, args),
    // 登录成功时把 checkPlatform 的完整判定原样带出来（含 reason 与细节）
    onAuthenticated: async ({ state }) => ({
      platform,
      authenticated: Boolean(state && state.authenticated),
      reason: (state && state.reason) || null,
      details: (state && state.details) || null,
    }),
  });
  const data = result.data || null;
  const authenticated = Boolean(
    (data && data.authenticated) || result.status === 'READ_OK' || result.status === 'READ_PARTIAL'
  );
  const reason =
    (data && data.reason) ||
    (result.auth && result.auth.reason) ||
    result.error ||
    null;
  return {
    authenticated,
    reason: reason ? String(reason).slice(0, 200) : null,
    status: result.status,
    namespace: result.profile && result.profile.namespace ? result.profile.namespace : null,
    details: data && data.details && typeof data.details === 'object' ? data.details : null,
  };
}

async function main() {
  const platform = argValue('--platform', 'all');
  const selection = readProfileSelection(process.argv);
  const outputDir = path.resolve(argValue('--output-dir', defaultOutputDir()));
  fs.mkdirSync(outputDir, { recursive: true });

  if (platform === 'all') {
    const startedAt = new Date().toISOString();
    const platforms = {};
    const namespaces = {};
    for (const item of PROBE_ORDER) {
      if (!PLATFORM_URLS[item]) continue;
      namespaces[item] = resolvePlatformDir(selection.profileId, item);
      const state = await probeOne(item, { selection, outputDir });
      platforms[item] = state;
      console.log(`[PROBE] ${item}: ${state.authenticated ? '已登录' : '需要登录'}（${state.reason || '无原因'}）`);
    }
    const allReady = Object.values(platforms).every((item) => item.authenticated);
    const doc = {
      platform: 'all',
      status: allReady ? 'READ_OK' : 'AUTH_REQUIRED',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      profile: {
        id: selection.profileId,
        // 每个平台各自一个目录，这里只给相对写法，避免把本机路径写进产物
        namespaces: Object.fromEntries(
          Object.entries(namespaces).map(([key, dir]) => [key, path.basename(dir)])
        ),
      },
      auth: { authenticated: allReady, details: platforms },
      data: { platforms, partial: !allReady },
    };
    fs.writeFileSync(path.join(outputDir, 'all-session-probe.json'), JSON.stringify(doc, null, 2), 'utf8');
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  if (!PLATFORM_URLS[platform]) {
    throw new Error(`UNSUPPORTED_PLATFORM:${platform}`);
  }

  const state = await probeOne(platform, { selection, outputDir });
  const doc = {
    platform,
    status: state.status,
    finished_at: new Date().toISOString(),
    profile: { id: selection.profileId, namespace: state.namespace },
    auth: { authenticated: state.authenticated, reason: state.reason, details: state.details },
    data: { platform, authenticated: state.authenticated, details: state.details },
  };
  const summaryPath = path.join(outputDir, `${platform}-session-probe.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(doc, null, 2), 'utf8');
  console.log(`PROBE_RESULT:${state.status}`);
  console.log(`PROBE_PLATFORM:${platform} READY:${state.authenticated ? 'yes' : 'no'} REASON:${state.reason || '-'}`);
}

main().catch((error) => {
  console.error(`PROBE_FAILED:${String(error.message || error)}`);
  process.exit(1);
});
