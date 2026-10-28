'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_PROFILE_ID,
  NAMESPACE_LABEL,
  appDataRoot,
  defaultProfileDir,
  displayPath,
  ensureNamespaceDir,
  ensureProfileMeta,
  migrateLegacyProfile,
  normalizeProfileId,
  platformNamespace,
  readConfig,
  resolveNamespaceDir,
  resolveProfileDir,
} = require('./huayuan-paths');
const { HOST_PATTERNS } = require('./endpoints');
const { installContextNotice, NOTICE_CSS, NOTICE_ID, TEXT_VARIABLE, updateNoticeText } = require('./session-notice');

// 登录等待期的轮询间隔：默认 800ms —— 登录成功后最多不到 1 秒就能切到"正在读取"
const LOGIN_POLL_INTERVAL_MS = 800;

/**
 * 是否需要发起入口导航：页面仍是空白，或还没在目标域（含统一认证）里。
 * 已经落在目标域时再 goto 一次，就是用户看到的"页面又被刷了一遍"。
 */
function needsEntryNavigation(url, loginUrl) {
  const value = String(url || '');
  if (!value || value === 'about:blank') return true;
  let targetHost = '';
  let currentHost = '';
  try { targetHost = new URL(loginUrl).host; } catch { targetHost = ''; }
  try { currentHost = new URL(value).host; } catch { currentHost = ''; }
  if (targetHost && currentHost === targetHost) return false;
  if (HOST_PATTERNS.sso.test(value)) return false;
  return true;
}

// 默认 Profile 跟随当前 Windows 用户的 USERPROFILE，不写死任何机器路径
const DEFAULT_PROFILE = defaultProfileDir();
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_HIDDEN_TIMEOUT_MS = 45 * 1000;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch (firstError) {
    const fallback = path.join(
      process.env.USERPROFILE || '',
      '.workbuddy',
      'binaries',
      'node',
      'workspace',
      'node_modules',
      'playwright-core'
    );
    try {
      return require(fallback);
    } catch {
      throw new Error('PLAYWRIGHT_NOT_FOUND: 无法加载 playwright-core');
    }
  }
}

function chromeExecutable() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function acquireProfileLock(profileDir) {
  ensureDir(profileDir);
  const lockPath = path.join(profileDir, '.huayuan-session.lock');
  if (fs.existsSync(lockPath)) {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      existing = null;
    }
    if (existing && processIsAlive(Number(existing.pid))) {
      const error = new Error(`PROFILE_BUSY: 会话 Profile 正被 PID ${existing.pid} 使用`);
      error.code = 'PROFILE_BUSY';
      throw error;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      const error = new Error('PROFILE_BUSY: 检测到无法清理的会话锁');
      error.code = 'PROFILE_BUSY';
      throw error;
    }
  }
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
    'utf8'
  );
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Number(current.pid) === process.pid) fs.unlinkSync(lockPath);
    } catch {
      // Lock cleanup must not hide the primary result.
    }
  };
}

/**
 * 全局单浏览器锁：命名空间隔离后各平台目录不同，单靠目录锁已经拦不住并发，
 * 但"同一时刻只允许一个 Chrome"这条纪律仍然要成立（两个窗口互相抢前台 = 用户看到的就是乱跳）。
 * 因此额外在数据根目录放一把跨命名空间的锁。
 */
const BROWSER_LOCK_STALE_MS = 30 * 60 * 1000;

function acquireBrowserLock() {
  const lockPath = path.join(appDataRoot(), '.browser-singleton.lock');
  ensureDir(path.dirname(lockPath));
  if (fs.existsSync(lockPath)) {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      existing = null;
    }
    const startedAt = existing && existing.created_at ? Date.parse(existing.created_at) : NaN;
    const stale = Number.isFinite(startedAt) ? Date.now() - startedAt > BROWSER_LOCK_STALE_MS : true;
    if (existing && processIsAlive(Number(existing.pid)) && !stale) {
      const error = new Error(
        `BROWSER_BUSY: 已有浏览器会话在运行（PID ${existing.pid}），同一时刻只允许一个 Chrome`
      );
      error.code = 'BROWSER_BUSY';
      throw error;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      const error = new Error('BROWSER_BUSY: 检测到无法清理的浏览器锁');
      error.code = 'BROWSER_BUSY';
      throw error;
    }
  }
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
    'utf8'
  );
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Number(current.pid) === process.pid) fs.unlinkSync(lockPath);
    } catch {
      // 释放锁失败不能盖住主结果
    }
  };
}

async function closeContext(context) {
  if (!context) return;
  await Promise.race([
    context.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
}

async function launchPersistent(playwright, profileDir, visible) {
  // 可见窗口只在登录时出现：不开全屏、不最大化，靠左上角放置，避免整屏遮挡用户工作区
  const options = {
    headless: !visible,
    viewport: visible ? null : { width: 1440, height: 900 },
    locale: 'zh-CN',
    args: visible
      ? ['--no-first-run', '--disable-features=Translate', '--window-size=1280,860', '--window-position=60,60']
      : ['--no-first-run', '--disable-features=Translate', '--window-size=1440,900'],
  };

  let lastError = null;
  try {
    return await playwright.chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      ...options,
    });
  } catch (error) {
    lastError = error;
  }

  const executablePath = chromeExecutable();
  if (executablePath) {
    try {
      return await playwright.chromium.launchPersistentContext(profileDir, {
        executablePath,
        ...options,
      });
    } catch (error) {
      lastError = error;
    }
  }

  const message = String(lastError && lastError.message ? lastError.message : lastError || '');
  if (/ProcessSingleton|profile.*in use|already.*open|user data directory/i.test(message)) {
    const error = new Error('PROFILE_BUSY: Chrome Profile 正被其他进程占用');
    error.code = 'PROFILE_BUSY';
    throw error;
  }
  throw new Error(`BROWSER_LAUNCH_FAILED: ${message.split('\n')[0]}`);
}

function createEventWriter(outputDir, platform) {
  ensureDir(outputDir);
  const eventsPath = path.join(outputDir, `${platform}-session-events.jsonl`);
  const statusPath = path.join(outputDir, `${platform}-session-status.json`);
  fs.writeFileSync(eventsPath, '', 'utf8');
  let sequence = 0;

  function emit(status, message, extra = {}) {
    const event = {
      seq: ++sequence,
      at: new Date().toISOString(),
      platform,
      status,
      message,
      ...extra,
    };
    fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify(event, null, 2), 'utf8');
    console.log(`[${status}] ${message}`);
    return event;
  }

  return { emit, eventsPath, statusPath };
}

async function injectVisibleNotice(page, text) {
  try {
    await page.evaluate((noticeText) => {
      if (!document.documentElement) return;
      const existing = document.getElementById('__huayuan_session_notice');
      if (existing) existing.remove();
      const notice = document.createElement('div');
      notice.id = '__huayuan_session_notice';
      notice.textContent = noticeText;
      notice.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'right:0',
        'z-index:2147483647',
        'background:#0b5cad',
        'color:#fff',
        'padding:10px 18px',
        'font:14px/1.5 Microsoft YaHei,sans-serif',
        'box-shadow:0 2px 10px rgba(0,0,0,.28)',
        'pointer-events:none',
      ].join(';');
      document.documentElement.appendChild(notice);
    }, text);
  } catch {
    // A cross-origin auth frame can reject DOM injection; the browser window is still usable.
  }
}

function pageAuthUrl(url) {
  const value = String(url || '');
  return HOST_PATTERNS.sso.test(value) || /\/cas\/login|login_qrcode|login|signin|auth/i.test(value);
}

/**
 * 解析本次使用的匿名账号槽位 + 该平台的会话命名空间。
 *
 * 目录规则（会话隔离的核心）：
 *   portal / jw → profiles/<id>/cas
 *   ecourse     → profiles/<id>/ecourse
 *   rain        → profiles/<id>/rain
 * 显式 profileDir 仍然优先（测试或便携部署时整体覆盖），此时 namespace 记为 external。
 */
function resolveSessionProfile({ profileId, profileDir, platform }) {
  if (profileDir) {
    const resolved = path.resolve(profileDir);
    return {
      profile_id: profileId ? normalizeProfileId(profileId) : path.basename(resolved),
      profile_dir: resolved,
      profile_root_dir: resolved,
      namespace: 'external',
      namespace_label: '外部指定目录',
      source: 'explicit-dir',
    };
  }
  const config = readConfig() || {};
  const id = normalizeProfileId(profileId || config.profile_id || DEFAULT_PROFILE_ID);
  const namespace = platformNamespace(platform);
  if (!namespace) {
    // 没有明确平台（例如聚合探测）时落到 CAS 命名空间，绝不隐式共享 eCourse 的会话
    return {
      profile_id: id,
      profile_dir: resolveNamespaceDir(id, 'cas'),
      profile_root_dir: resolveProfileDir(id),
      namespace: 'cas',
      namespace_label: NAMESPACE_LABEL.cas,
      source: profileId ? 'explicit-id' : config.profile_id ? 'config' : 'default',
      configured_id: config.profile_id || null,
    };
  }
  return {
    profile_id: id,
    profile_dir: resolveNamespaceDir(id, namespace),
    profile_root_dir: resolveProfileDir(id),
    namespace,
    namespace_label: NAMESPACE_LABEL[namespace],
    source: profileId ? 'explicit-id' : config.profile_id ? 'config' : 'default',
    configured_id: config.profile_id || null,
  };
}

async function withBrowserSession(options) {
  const {
    platform,
    loginUrl,
    outputDir,
    isAuthenticated,
    onBrowserStart,
    onAuthenticated,
    ensureLoginEntry = null,
    profileId = null,
    profileDir = null,
    loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
    hiddenTimeoutMs = DEFAULT_HIDDEN_TIMEOUT_MS,
    forceVisible = false,
    allowVisibleLogin = true,
    // 初始化前已经跑过 session-probe：明确未登录时跳过"隐藏 Chrome 再检查一遍"
    skipHiddenCheck = false,
    // 浏览器一打开就贴在页面顶部的中文提示（避免白屏无反馈）
    openingNotice = null,
    loginPollMs = LOGIN_POLL_INTERVAL_MS,
  } = options;

  if (!platform || !loginUrl || !outputDir || typeof isAuthenticated !== 'function') {
    throw new Error('INVALID_OPTIONS: platform/loginUrl/outputDir/isAuthenticated 为必填项');
  }

  const active = resolveSessionProfile({ profileId, profileDir, platform });
  const writer = createEventWriter(outputDir, platform);
  const result = {
    platform,
    started_at: new Date().toISOString(),
    finished_at: null,
    status: 'STARTING',
    browser_visibility: null,
    login_waited_ms: 0,
    profile: {
      id: active.profile_id,
      namespace: active.namespace,
      namespace_label: active.namespace_label,
      source: active.source,
      dir_hint: displayPath(active.profile_dir),
    },
    auth: null,
    data: null,
    error: null,
  };
  const resultPath = path.join(outputDir, `${platform}-session-result.json`);
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');

  let releaseLock = null;
  let releaseBrowserLock = null;
  let context = null;
  const playwright = loadPlaywright();

  try {
    const migration = migrateLegacyProfile(active.profile_id);
    if (migration.migrated) {
      writer.emit('PROFILE_MIGRATED', '已把旧版单目录 Profile 迁移到匿名槽位目录', {
        profile_id: active.profile_id,
        from_hint: displayPath(migration.from),
        to_hint: displayPath(migration.to),
      });
    }
    // 命名空间目录按平台就位。只有 cas 会继承旧版共享会话；
    // ecourse / rain 从空目录开始，必须单独登录一次，并明确提示（不静默）
    const namespaceInfo = ensureNamespaceDir(active.profile_id, active.namespace === 'external' ? 'cas' : active.namespace);
    ensureProfileMeta(active.profile_root_dir, active.profile_id);
    if (namespaceInfo.created) {
      writer.emit(
        'PROFILE_NAMESPACE_CREATED',
        `已为「${active.namespace_label}」建立独立会话目录`,
        {
          namespace: active.namespace,
          inherited_entries: namespaceInfo.inherited.length,
          needs_login: Boolean(namespaceInfo.needs_login),
          notice: namespaceInfo.notice || null,
          note: namespaceInfo.notice
            ? namespaceInfo.notice
            : '各平台会话从此互不影响；旧的共享会话不会再被任何平台直接打开',
        }
      );
    }
    writer.emit('PROFILE_INFO', `使用匿名账号槽位 ${active.profile_id}`, {
      profile_id: active.profile_id,
      namespace: active.namespace,
      namespace_label: active.namespace_label,
      profile_dir_hint: displayPath(active.profile_dir),
      source: active.source,
    });
    if (active.configured_id && active.source === 'explicit-id' && active.configured_id !== active.profile_id) {
      writer.emit('PROFILE_ID_OVERRIDE', `本次改用槽位 ${active.profile_id}（配置中为 ${active.configured_id}）`, {
        profile_id: active.profile_id,
        configured_id: active.configured_id,
        user_action: '确认这是切换到了另一个学校账号；不同账号必须使用不同 profile-id，不能共用槽位',
      });
    }
    if (!readConfig()) {
      writer.emit('FIRST_RUN_RECOMMENDED', '尚未完成首次运行向导', {
        user_action: '运行 node first-run.js --wizard --login 完成平台授权、个人偏好与首次登录',
        blocking: false,
      });
    }

    releaseLock = acquireProfileLock(active.profile_dir);
    releaseBrowserLock = acquireBrowserLock();

    // 已经知道没登录时不再重复一次"启动隐藏 Chrome → 检查 → 关闭 → 再启动可见 Chrome"，
    // 直接进可见登录：这一步能省掉一次浏览器启停和十几秒等待。
    if (skipHiddenCheck && !forceVisible) {
      writer.emit('SESSION_CHECK_SKIPPED', '已知未登录，跳过重复的无头检查，直接进入可见登录', {
        platform,
        note: '只有在登录态未知或可能已登录时才做无头检查',
      });
    } else if (!forceVisible) {
      writer.emit('SESSION_CHECK', '正在无头检查登录状态');
      context = await launchPersistent(playwright, active.profile_dir, false);
      let page = context.pages()[0] || (await context.newPage());
      if (onBrowserStart) await onBrowserStart({ context, page, visible: false, writer });

      const hiddenState = await isAuthenticated({
        context,
        page,
        initial: true,
        timeoutMs: hiddenTimeoutMs,
      });
      if (hiddenState && hiddenState.authenticated) {
        result.browser_visibility = 'hidden';
        result.auth = hiddenState.details || null;
        writer.emit('SESSION_READY', '登录态有效，浏览器保持隐藏');
        const data = await onAuthenticated({
          context,
          page,
          state: hiddenState,
          visible: false,
          writer,
          noticeApi: null,
        });
        result.data = data || null;
        // 读取部分失败时不能报 READ_OK：状态必须反映真实结果
        result.status = data && data.partial ? 'READ_PARTIAL' : 'READ_OK';
        writer.emit(
          result.status,
          result.status === 'READ_OK' ? '无头读取完成' : '无头读取部分完成（有平台未读到）'
        );
        return result;
      }

      // 静默检查也要保留逐平台原始状态，AUTH_REQUIRED 不能只有结论没有原因
      result.auth = hiddenState
        ? {
            authenticated: false,
            reason: hiddenState.reason || null,
            details: hiddenState.details || null,
          }
        : null;
      writer.emit('SESSION_CHECK_FAILED', '无头登录态检查未通过', {
        reason: hiddenState && hiddenState.reason ? hiddenState.reason : null,
        details: hiddenState && hiddenState.details ? hiddenState.details : null,
      });
      await closeContext(context);
      context = null;
    }

    if (!allowVisibleLogin) {
      result.status = 'AUTH_REQUIRED';
      result.error = `AUTH_REQUIRED:${platform}`;
      writer.emit(`AUTH_REQUIRED:${platform}`, `登录态无效，需要用户登录 ${platform}`, {
        user_action: '下一步运行带登录等待的正式读取流程',
      });
      return result;
    }

    writer.emit(`AUTH_REQUIRED:${platform}`, `需要登录 ${platform}`, {
      user_action: '请在即将打开的专用 Chrome 窗口中本人完成统一认证或扫码',
    });

    result.browser_visibility = 'visible-login';
    context = await launchPersistent(playwright, active.profile_dir, true);
    let page = context.pages()[0] || (await context.newPage());

    // 提示条用 addInitScript 注入：每次导航（含 CAS 回跳、站点内部跳转）都会重新执行，
    // 所以二维码出现后无论页面怎么跳，顶部那句中文都不会被刷掉。
    const defaultNotice =
      openingNotice || '华园日程管家正在等待你本人完成登录；登录成功后会自动继续，请勿关闭本窗口。';
    const noticeApi = await installContextNotice(context, { text: defaultNotice });
    const setNotice = async (text) => {
      await updateNoticeText(page, text).catch(() => {});
      for (const candidate of context.pages().filter((item) => !item.isClosed())) {
        await updateNoticeText(candidate, text).catch(() => {});
      }
    };
    if (onBrowserStart) await onBrowserStart({ context, page, visible: true, writer, noticeApi });

    // 提示语以平台钩子返回的为准（例如雨课堂："登录页已打开，请在此扫码或登录"）
    let noticeText = defaultNotice;
    // 窗口一出现就先把提示条挂上，不等目标页面渲染，避免纯白屏
    await injectVisibleNotice(page, noticeText).catch(() => {});

    // 只有当前页还没进入目标域（仍是空白页）时才导航，杜绝连续两次打开入口
    if (needsEntryNavigation(page.url(), loginUrl)) {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    } else {
      writer.emit('SESSION_ENTRY_REUSED', '当前页已在目标域内，未重复导航', { url: page.url() });
    }

    // 平台自己决定"登录界面到底长什么样"：给了钩子就以钩子的结论为准，
    // 不再默认"打开了首页就算给到用户入口"。
    let loginEntry = null;
    if (typeof ensureLoginEntry === 'function') {
      loginEntry = await ensureLoginEntry({ context, page, writer, platform, loginUrl }).catch((error) => ({
        ok: false,
        reason: String(error.message || error).split('\n')[0],
        final_url: null,
        visible_buttons: [],
      }));
      result.login_entry = loginEntry || null;
      if (!loginEntry || loginEntry.ok === false) {
        result.status = 'AUTH_ENTRY_NOT_FOUND';
        result.error = `AUTH_ENTRY_NOT_FOUND:${platform}`;
        writer.emit(`AUTH_ENTRY_NOT_FOUND:${platform}`, '没能自动打开登录入口，已停止（不循环重试）', {
          reason: (loginEntry && loginEntry.reason) || '未知原因',
          final_url: (loginEntry && loginEntry.final_url) || null,
          visible_buttons: (loginEntry && loginEntry.visible_buttons) || [],
          screenshot: (loginEntry && loginEntry.screenshot) || null,
          user_action: '按上面的截图与按钮文字手动打开登录页后重跑同一条命令；不要反复重试',
        });
        await closeContext(context);
        context = null;
        return result;
      }
      writer.emit(`AUTH_ENTRY_READY:${platform}`, '登录入口已打开，等本人在窗口里扫码或登录', {
        entry_method: loginEntry.entry_method,
        final_url: loginEntry.final_url,
        login_form_detected: Boolean(loginEntry.login_form_detected),
        qr_detected: Boolean(loginEntry.qr_detected),
        attempts: loginEntry.attempts || [],
      });
    }

    const waitNotice = (loginEntry && loginEntry.notice) || noticeText;
    noticeText = waitNotice;
    await injectVisibleNotice(page, waitNotice);

    writer.emit(`AUTH_WAIT:${platform}`, `请在专用 Chrome 窗口中完成 ${platform} 登录`, {
      timeout_seconds: Math.round(loginTimeoutMs / 1000),
      user_action: '完成登录后不要关闭窗口；脚本会自动继续读取',
    });

    const waitStarted = Date.now();
    let loggedInState = null;
    let lastProgressAt = 0;
    while (Date.now() - waitStarted < loginTimeoutMs) {
      const state = await isAuthenticated({
        context,
        page,
        initial: false,
        // 等待登录期间禁止任何会刷新页面的检查：用户可能正在扫码
        loginWait: true,
        timeoutMs: 15000,
        noticeApi,
      }).catch((error) => ({
        authenticated: false,
        reason: String(error.message || error).split('\n')[0],
      }));
      if (state && state.authenticated) {
        loggedInState = state;
        break;
      }
      if (pageAuthUrl(page.url())) {
        // 页面被登录流程自己刷新过，顶部提示会丢，这里补回同一句话
        await injectVisibleNotice(page, waitNotice).catch(() => {});
      }
      const waitedSeconds = Math.round((Date.now() - waitStarted) / 1000);
      if (waitedSeconds !== lastProgressAt && waitedSeconds % 5 === 0) {
        lastProgressAt = waitedSeconds;
        writer.emit(`AUTH_WAITING:${platform}`, `仍在等待本人登录，已等待 ${waitedSeconds} 秒`, {
          waited_seconds: waitedSeconds,
          note: '登录二维码出现后请在本窗口完成登录；本机不会代填账号、密码、验证码',
        });
      }
      await page.waitForTimeout(loginPollMs).catch(() => {});
    }

    result.login_waited_ms = Date.now() - waitStarted;
    if (!loggedInState) {
      result.status = 'AUTH_TIMEOUT';
      result.error = `AUTH_TIMEOUT:${platform}`;
      writer.emit(`AUTH_TIMEOUT:${platform}`, `等待 ${platform} 登录超时`, {
        timeout_seconds: Math.round(loginTimeoutMs / 1000),
      });
      return result;
    }

    result.auth = loggedInState.details || null;
    writer.emit(`AUTH_LOGIN_OK:${platform}`, `${platform} 登录成功，当前会话继续读取`);
    const activePages = context.pages().filter((candidate) => !candidate.isClosed());
    page = activePages.find((candidate) => !pageAuthUrl(candidate.url())) || page;
    const data = await onAuthenticated({
      context,
      page,
      state: loggedInState,
      visible: true,
      writer,
      noticeApi,
    });
    result.data = data || null;
    // 脚本自报状态优先（READ_EMPTY 等）：只有脚本没给状态时才按 partial 推断
    const reported = data && ['READ_OK', 'READ_PARTIAL', 'READ_EMPTY', 'READ_FAILED'].includes(data.status)
      ? data.status
      : null;
    result.status = reported || (data && data.partial ? 'READ_PARTIAL' : 'READ_OK');
    writer.emit(result.status, result.status === 'READ_OK' ? '可见会话读取完成' : `可见会话读取结束：${result.status}`);
    return result;
  } catch (error) {
    const code = error.code || '';
    if (code === 'PROFILE_BUSY' || code === 'BROWSER_BUSY') {
      result.status = code;
    } else {
      result.status = 'READ_FAILED';
    }
    result.error = String(error.message || error).split('\n')[0];
    writer.emit(result.status, result.error);
    return result;
  } finally {
    await closeContext(context);
    if (releaseLock) releaseLock();
    if (releaseBrowserLock) releaseBrowserLock();
    result.finished_at = new Date().toISOString();
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  }
}

module.exports = {
  LOGIN_POLL_INTERVAL_MS,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_PROFILE,
  DEFAULT_PROFILE_ID,
  acquireBrowserLock,
  defaultProfileDir,
  injectVisibleNotice,
  needsEntryNavigation,
  pageAuthUrl,
  resolveProfileDir,
  resolveSessionProfile,
  withBrowserSession,
};
