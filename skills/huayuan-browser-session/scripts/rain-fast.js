'use strict';

const fs = require('fs');
const path = require('path');
const { withBrowserSession, injectVisibleNotice } = require('./session-gateway');
const { PLATFORM_URLS, checkPlatform, fetchUserCourses } = require('./platform-adapters');
const { ENDPOINTS, HOST_PATTERNS, base } = require('./endpoints');
const { checkAuthorization, defaultOutputDir, readProfileSelection } = require('./huayuan-paths');

const COURSELIST = ENDPOINTS.rain_courselist;
const USER_COURSES = ENDPOINTS.rain_user_courses;

const STATIC_HEADER_NAMES = [
  'terminal-type',
  'xtbz',
  'university-id',
  'platform-id',
  'x-client',
];

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name, fallback) {
  const parsed = Number(argValue(name, String(fallback)));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ── 雨课堂登录入口 ──────────────────────────────────────────────
// 实测（2026-10-28，未登录访问 scut.yuketang.cn）：
//   /login、/user/login → HTTP 404（旧路由已下线）
//   /pro/login          → HTTP 200，SPA 内置登录路由
//   /                   → HTTP 200，公开首页，需要用户自己找"登录"
// 结论：登录必须直达 /pro/login，停在首页等于让用户自己找入口。
const RAIN_RAIN_BASE = base('rain');
const RAIN_LOGIN_URL = `${RAIN_RAIN_BASE}/pro/login`;
// 直达没落在登录界面时的兜底：仍然只在本校雨课堂域内，绝不跨到教务
const RAIN_LOGIN_FALLBACK_URLS = PLATFORM_URLS.rain
  ? [`${PLATFORM_URLS.rain}`, `${RAIN_RAIN_BASE}/`]
  : [`${RAIN_RAIN_BASE}/`];

const LOGIN_CONTROL_TEXTS = [
  '登录',
  '立即登录',
  '登录/注册',
  '登录注册',
  '登录 | 注册',
  '扫码登录',
  '账号登录',
  '帐号登录',
  '微信登录',
  '手机号登录',
  '登录雨课堂',
];

const LOGIN_ENTRY_NOTICE =
  '雨课堂登录页已打开，请在此扫码或登录；登录成功后会自动继续，请勿关闭本窗口。';

// 落盘只保留 origin + pathname：ticket / redirect / state 之类的查询串一律丢掉
function sanitizeUrl(raw) {
  const value = String(raw || '');
  try {
    const url = new URL(value);
    const trimmed = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    return trimmed || url.origin;
  } catch {
    return value.split('?')[0].split('#')[0];
  }
}

function onRainHost(raw) {
  try {
    return HOST_PATTERNS.rain.test(new URL(String(raw)).host);
  } catch {
    return false;
  }
}

// 判定"这个 frame 里是否已经出现登录界面"：表单 / 二维码 / 明确登录文案，任一即算。
// 站点会用 shadow DOM 藏登录弹窗，所以文本与节点都要连影子根一起找。
// 实测：/pro/login 的二维码是 <img class="qr-img" src="data:image/jpeg;base64,...">，
// 类名里没有 qrcode、src 是 data URL，只能靠 "qr" 前缀 + 尺寸判定。
function detectFrameSurface(frame) {
  return frame
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        return Number(style.opacity || 1) > 0;
      };

      const roots = [document];
      const queue = [document.documentElement];
      while (queue.length && roots.length < 40) {
        const el = queue.pop();
        if (!el) continue;
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          queue.push(...el.shadowRoot.querySelectorAll('*'));
        }
        queue.push(...el.children);
      }
      const queryAll = (selector) => {
        const out = [];
        for (const root of roots) out.push(...root.querySelectorAll(selector));
        return out;
      };

      const passwordInputs = queryAll('input[type="password"]').filter(visible);
      const accountInputs = queryAll(
        'input[type="text"], input[type="tel"], input[type="email"], input:not([type])'
      ).filter((el) => {
        if (!visible(el)) return false;
        const hint = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('name') || ''} ${
          el.getAttribute('id') || ''
        }`;
        return /手机|邮箱|账号|帐号|用户名|学号|密码|phone|account|user|login/i.test(hint);
      });

      const qrNodes = queryAll('img, canvas, svg').filter((el) => {
        if (!visible(el)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 90 || rect.height < 90) return false;
        const hint = `${el.className || ''} ${el.id || ''} ${el.getAttribute('src') || ''} ${
          el.getAttribute('alt') || ''
        }`.toLowerCase();
        // 明确的自证：qr-img / qrcode / qr-code / login-qr 之类
        if (/qr/.test(hint) && !/bg-img|banner|cover|poster|avatar/.test(hint)) return true;
        // 兜底：接近正方形且就近文字提到扫码/二维码
        if (rect.width > 420 || Math.abs(rect.width - rect.height) > 20) return false;
        let node = el.parentElement;
        for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
          const text = (node.innerText || '') + (node.textContent || '');
          if (/扫码|二维码/.test(text)) return true;
        }
        return false;
      });

      let text = '';
      for (const root of roots) {
        const host = root === document ? document.body : root.host;
        if (host) text += ` ${host.innerText || host.textContent || ''}`;
      }
      text = text.replace(/\s+/g, '');

      // 明确写着这些字的，就是登录界面本身，不用等二维码加载完
      const loginTextMatch = (text.match(/微信扫码登录|扫码登录|账号登录|帐号登录|微信扫描二维码|请使用微信扫码/) || [
        null,
      ])[0];

      return {
        login_form: passwordInputs.length > 0 || accountInputs.length > 0,
        password_inputs: passwordInputs.length,
        account_inputs: accountInputs.length,
        qr: qrNodes.length > 0,
        qr_nodes: qrNodes.length,
        login_text: Boolean(loginTextMatch),
        login_text_hit: loginTextMatch,
      };
    })
    .catch(() => null);
}

/**
 * 逐层检查主文档和所有 iframe/frame（含跨域子框架），合并成一份结论。
 * 只看主文档会漏掉"二维码在 iframe 里"的情况，这正是上一版误判的原因。
 */
async function detectLoginSurface(page) {
  const frames = page.frames();
  const merged = {
    login_form: false,
    qr: false,
    login_text: false,
    password_inputs: 0,
    account_inputs: 0,
    qr_nodes: 0,
    login_text_hit: null,
    frames_checked: frames.length,
    matched_frame: null,
  };
  for (const frame of frames) {
    const one = await detectFrameSurface(frame);
    if (!one) continue;
    merged.password_inputs += one.password_inputs || 0;
    merged.account_inputs += one.account_inputs || 0;
    merged.qr_nodes += one.qr_nodes || 0;
    merged.login_form = merged.login_form || Boolean(one.login_form);
    merged.qr = merged.qr || Boolean(one.qr);
    merged.login_text = merged.login_text || Boolean(one.login_text);
    if (one.login_text_hit && !merged.login_text_hit) merged.login_text_hit = one.login_text_hit;
    if (!merged.matched_frame && (one.login_form || one.qr || one.login_text)) {
      merged.matched_frame = frame === page.mainFrame() ? 'main' : sanitizeUrl(frame.url());
    }
  }
  return merged;
}

// 文案先出现、二维码后绘制是常态：报告 qr=true 之前，先确认像素真的画出来了
async function waitQrPainted(page, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const painted = await page
      .evaluate(() => {
        const hintOf = (el) =>
          `${el.className || ''} ${el.id || ''} ${el.getAttribute('src') || ''}`.toLowerCase();
        const imgs = Array.from(document.querySelectorAll('img')).filter(
          (el) => /qr/.test(hintOf(el)) && el.getBoundingClientRect().width >= 90
        );
        if (imgs.some((el) => el.complete && el.naturalWidth > 0)) return true;
        return Array.from(document.querySelectorAll('canvas')).some(
          (el) => el.width >= 90 && el.height >= 90
        );
      })
      .catch(() => false);
    if (painted) return true;
    await page.waitForTimeout(250).catch(() => {});
  }
  return false;
}

function loginSurfaceReady(surface) {
  return Boolean(surface && (surface.login_form || surface.qr || surface.login_text));
}

async function waitLoginSurface(page, timeoutMs) {
  const started = Date.now();
  let surface = { login_form: false, qr: false, login_text: false };
  while (Date.now() - started < timeoutMs) {
    surface = await detectLoginSurface(page);
    if (loginSurfaceReady(surface)) return surface;
    await page.waitForTimeout(600).catch(() => {});
  }
  return surface;
}

// 语义定位"登录"控件：文字完全匹配才算，父子同名只取最内层，避免把导航栏整块点掉
async function collectLoginControls(page) {
  return page
    .evaluate((texts) => {
      document
        .querySelectorAll('[data-huayuan-login-control]')
        .forEach((node) => node.removeAttribute('data-huayuan-login-control'));
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        return Number(style.opacity || 1) > 0;
      };
      const norm = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, '');
      const candidates = Array.from(
        document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="login"], span, div')
      ).filter(visible);
      const found = [];
      for (const el of candidates) {
        const text = norm(el);
        if (!texts.includes(text)) continue;
        // 子元素文字相同说明是外层容器，跳过，只保留最内层可点控件
        if (Array.from(el.children).some((child) => norm(child) === text)) continue;
        el.setAttribute('data-huayuan-login-control', String(found.length));
        found.push({
          index: found.length,
          text,
          tag: el.tagName.toLowerCase(),
          class_name: String(el.className || '').slice(0, 60),
        });
      }
      return found;
    }, LOGIN_CONTROL_TEXTS)
    .catch(() => []);
}

async function visibleButtonTexts(page) {
  return page
    .evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      return Array.from(document.querySelectorAll('button, a, [role="button"], [class*="btn"]'))
        .filter(visible)
        .map((el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((text) => text && text.length <= 20)
        .filter((text, index, list) => list.indexOf(text) === index)
        .slice(0, 25);
    })
    .catch(() => []);
}

async function saveEntryScreenshot(page, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const shot = path.join(outputDir, 'rain-login-entry-ready.png');
  const ok = await page
    .screenshot({ path: shot, fullPage: false })
    .then(() => true)
    .catch(() => false);
  return ok ? shot : null;
}

async function buildEntry(method, page, surface, attempts, outputDir, extra = {}) {
  // 先把"登录页已打开"的置顶提示打上去，截图里能看到用户实际会看到的畫面
  await injectVisibleNotice(page, LOGIN_ENTRY_NOTICE).catch(() => {});
  await page.waitForTimeout(300).catch(() => {});
  return {
    ok: true,
    entry_method: method,
    final_url: sanitizeUrl(page.url()),
    on_rain_host: onRainHost(page.url()),
    login_form_detected: Boolean(surface.login_form),
    qr_detected: Boolean(surface.qr),
    login_text_detected: Boolean(surface.login_text),
    login_text_hit: surface.login_text_hit || null,
    qr_nodes: surface.qr_nodes || 0,
    qr_painted: surface.qr_painted !== false,
    frames_checked: surface.frames_checked || 0,
    matched_frame: surface.matched_frame || null,
    screenshot: await saveEntryScreenshot(page, outputDir),
    attempts,
    notice: LOGIN_ENTRY_NOTICE,
    ...extra,
  };
}

async function failEntry(page, outputDir, reason, attempts, extra = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const shot = path.join(outputDir, 'rain-login-entry-not-found.png');
  await page
    .screenshot({ path: shot, fullPage: false })
    .catch(() => {});
  return {
    ok: false,
    entry_method: null,
    reason,
    final_url: sanitizeUrl(page.url()),
    screenshot: shot,
    visible_buttons: await visibleButtonTexts(page),
    attempts,
    notice: null,
    ...extra,
  };
}

/**
 * 无头判定未登录后，可见浏览器必须直接落到真实登录界面：
 *   1) 直达实测可用的 /pro/login，等登录表单或二维码真正出现
 *   2) 直达没成，再在本校雨课堂域内按文字语义点"唯一"的登录控件
 * 找不到就截图 + 记录可见按钮文字后停，不循环、不盲点坐标、不跨平台。
 */
async function openLoginEntry({ page, outputDir }) {
  const attempts = [];
  for (const url of [RAIN_LOGIN_URL, ...RAIN_LOGIN_FALLBACK_URLS]) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const surface = await waitLoginSurface(page, 9000);
    attempts.push({
      url: sanitizeUrl(url),
      landed_on: sanitizeUrl(page.url()),
      login_form: Boolean(surface.login_form),
      qr: Boolean(surface.qr),
      login_text: Boolean(surface.login_text),
      frames_checked: surface.frames_checked || 0,
    });
    if (loginSurfaceReady(surface)) {
      if (surface.qr) surface.qr_painted = await waitQrPainted(page);
      return buildEntry('direct-url', page, surface, attempts, outputDir);
    }
    // 已经不在本校雨课堂（也不在统一认证）就不要继续，避免被带进教务
    if (!onRainHost(page.url()) && !HOST_PATTERNS.sso.test(page.url())) {
      return failEntry(
        page,
        outputDir,
        `直达登录入口时被带离雨课堂域（当前 ${sanitizeUrl(page.url())}），已停止，不跨平台`,
        attempts
      );
    }
  }

  const controls = await collectLoginControls(page);
  if (controls.length === 1) {
    await page
      .click('[data-huayuan-login-control="0"]', { timeout: 8000 })
      .catch(() => {});
    const surface = await waitLoginSurface(page, 12000);
    if (loginSurfaceReady(surface)) {
      if (surface.qr) surface.qr_painted = await waitQrPainted(page);
      return buildEntry('semantic-click', page, surface, attempts, outputDir, {
        clicked_control: controls[0],
      });
    }
    return failEntry(page, outputDir, '点击登录控件后没有出现登录表单或二维码', attempts, {
      clicked_control: controls[0],
    });
  }
  return failEntry(
    page,
    outputDir,
    controls.length
      ? `页面上匹配到 ${controls.length} 个登录控件，不唯一，未自动点击`
      : '页面上没有可识别的登录控件',
    attempts,
    { login_controls: controls.slice(0, 10) }
  );
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function appendMarkdown(file, lines) {
  fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function captureStaticHeaders(state, request) {
  if (state.headersReady) return;
  const headers = request.headers();
  for (const name of STATIC_HEADER_NAMES) {
    if (headers[name]) state.staticHeaders[name] = headers[name];
  }
  // user-courses 实测最先拒绝缺少 XTBZ 的请求；其他客户端标识可能不会在每个页面都出现。
  state.headersReady = rainHeadersReady(state.staticHeaders);
}

function rainHeadersReady(headers = {}) {
  return Boolean(headers && headers.xtbz);
}

function createRuntimeState() {
  return {
    staticHeaders: {},
    headersReady: false,
    authState: null,
  };
}

function configurePage(page, state) {
  page.on('request', (request) => captureStaticHeaders(state, request));
}

async function inspectAuth({ page, initial, loginWait, state }) {
  if (initial) {
    await page.goto(COURSELIST, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    }).catch(() => {});
    await page.waitForTimeout(2500);
  }

  // 登录等待期间只做一次只读接口检查：不能 reload，否则用户正在扫的二维码会被刷掉
  if (loginWait) return inspectRainPassive(page, state || null);

  const platformState = await checkPlatform('rain', { page, initial: false });
  return platformState;
}

async function rainCourseListVisible(page) {
  return page
    .evaluate(() => {
      const text = document.body ? document.body.innerText.replace(/\s+/g, '') : '';
      return (
        /\/pro\/courselist/i.test(location.pathname) &&
        /搜索课程/.test(text) &&
        /开课学期/.test(text) &&
        /当前学期/.test(text)
      );
    })
    .catch(() => false);
}

async function inspectRainPassive(page, state = null) {
  let response = await fetchUserCourses(page, state && state.staticHeaders ? state.staticHeaders : {});
  if (
    response.status === 200 &&
    response.body &&
    response.body.success === false &&
    state &&
    Object.keys(state.staticHeaders || {}).length === 0
  ) {
    // 页面自然请求可能比接口轮询稍晚，短暂等待后使用已采集的静态标识头重试。
    await page.waitForTimeout(1200).catch(() => {});
    response = await fetchUserCourses(page, state.staticHeaders || {});
  }
  const body = response.body;
  const successFalse = Boolean(body && body.success === false);
  const hasCourses = Boolean(
    body && body.data && Array.isArray(body.data.product_list) && body.data.product_list.length > 0
  );
  const courseListVisible = await rainCourseListVisible(page);
  return {
    authenticated: (response.status === 200 && !successFalse && hasCourses) || courseListVisible,
    reason: hasCourses
      ? '个人课程列表可读'
      : courseListVisible
        ? '已进入个人课程列表页，登录成功'
        : `登录等待中：user-courses HTTP ${response.status}`,
    details: {
      course_count: hasCourses ? body.data.product_list.length : 0,
      http_status: response.status,
      login_wait: true,
      course_list_visible: courseListVisible,
      static_header_names: Object.keys((state && state.staticHeaders) || {}).sort(),
    },
    data: hasCourses ? response : null,
  };
}

async function fetchInPage(page, url, extraHeaders = {}, timeoutMs = 15000) {
  return page.evaluate(
    async ({ targetUrl, extra, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(targetUrl, {
          credentials: 'include',
          signal: controller.signal,
          headers: { Accept: 'application/json', ...extra },
        });
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return { status: response.status, body };
      } finally {
        clearTimeout(timer);
      }
    },
    { targetUrl: url, extra: extraHeaders, timeout: timeoutMs }
  );
}

async function fetchTodos(page, state, course, retries) {
  const url = ENDPOINTS.rain_todo_list(course.classroom_id, course.sku_id);

  if (!state.headersReady) {
    return {
      ok: false,
      error: '页面自然请求的静态标识头未采集完整',
      auth: false,
    };
  }

  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      await page.waitForTimeout(1000 * 2 ** (attempt - 1));
    }
    try {
      const response = await fetchInPage(page, url, {
        ...state.staticHeaders,
      });

      if (
        response.body &&
        Object.prototype.hasOwnProperty.call(response.body, 'success') &&
        response.body.success === false
      ) {
        return {
          ok: false,
          auth: false,
          error: `接口 success=false: ${
            response.body.msg || response.body.error_code || '未知错误'
          }`,
        };
      }
      if (response.status === 200 && response.body && response.body.data) {
        return { ok: true, status: response.status, body: response.body };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, auth: true, status: response.status, error: `HTTP ${response.status}` };
      }

      lastError = `HTTP ${response.status || '0'}`;
      if (response.status === 429 || response.status >= 500 || response.status === 0) {
        continue;
      }
      return { ok: false, auth: false, status: response.status, error: lastError };
    } catch (error) {
      lastError = String(error.message || error).split('\n')[0];
    }
  }
  return { ok: false, auth: false, error: lastError || '请求失败' };
}

function mapTodoItem(item) {
  return {
    name: item.name || '待确认',
    type: item.type !== undefined ? item.type : '待确认',
    leaf_id: item.leaf_id !== undefined ? item.leaf_id : '待确认',
    publish_time: item.publish_time || '待确认',
    score_deadline: item.score_deadline || '待确认',
    is_expired: Boolean(item.is_expired),
    link_url: item.link_url || '待确认',
  };
}

/**
 * 学期识别：不写死学期码，从本人课程数据反推当前学期。
 * 规则：课程数最多的 classroom_term 视为当前学期；数量并列时取学期码较大者（时间更近）。
 * 依据：每个学期码对应的课程条数，一并输出，便于人工复核与 --term 覆盖。
 */
function detectTerm(products, requested) {
  const distribution = new Map();
  for (const item of products) {
    const term = Number(item.classroom_term);
    if (!Number.isFinite(term) || term <= 0) continue;
    distribution.set(term, (distribution.get(term) || 0) + 1);
  }
  const evidence = [...distribution.entries()]
    .map(([term, courseCount]) => ({ term, course_count: courseCount }))
    .sort((a, b) => b.term - a.term);

  const explicit = Number(requested);
  const hasExplicit = Number.isFinite(explicit) && explicit > 0;
  let chosen = null;
  let rule = '';

  if (hasExplicit) {
    chosen = explicit;
    rule = '用户通过 --term 显式指定学期码';
  } else if (evidence.length) {
    chosen = evidence.reduce((best, item) => {
      if (!best) return item;
      if (item.course_count > best.course_count) return item;
      if (item.course_count === best.course_count && item.term > best.term) return item;
      return best;
    }).term;
    rule = '取本人课程数据中课程数最多的学期；数量并列时取学期码较大者';
  }

  const matched = evidence.find((item) => item.term === chosen) || null;
  return {
    mode: hasExplicit ? 'explicit' : 'auto',
    chosen,
    matched_course_count: matched ? matched.course_count : 0,
    rule: rule || '课程数据中没有可用学期码',
    source: '雨课堂 user-courses 返回的 product_list[].classroom_term',
    evidence,
  };
}

async function readRain({
  page,
  state,
  writer,
  outputDir,
  termRequest,
  concurrency,
  retries,
}) {
  const resultJson = path.join(outputDir, 'rain-fast.json');
  const resultMd = path.join(outputDir, 'rain-fast-result.md');
  const startedAt = new Date();
  fs.writeFileSync(
    resultMd,
    [
      '# 雨课堂快速批量读取',
      `开始: ${startedAt.toLocaleString('zh-CN')}`,
      `并发: ${concurrency}`,
      '登录策略: 无头检查；仅失效时可见登录；同一会话读取',
      '',
    ].join('\n'),
    'utf8'
  );

  if (!state.headersReady) {
    if (!/\/pro\/courselist/i.test(page.url())) {
      await page.goto(COURSELIST, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch(() => {});
    }
    // 轮询等待页面自然请求产生静态标识头（最多 12 秒），避免页面慢时全部课程误失败
    for (let waited = 0; waited < 12 && !state.headersReady; waited += 1) {
      await page.waitForTimeout(1000);
    }
  }

  let authData = state.authState && state.authState.data;
  if (!authData || authData.status !== 200 || !authData.body) {
    // 带静态标识头请求（接口可能要求 XTBZ 等，裸 fetch 会被拒）
    authData = await fetchInPage(page, USER_COURSES, state.staticHeaders);
    if (
      authData.status === 200 &&
      authData.body &&
      authData.body.success === false &&
      !state.headersReady
    ) {
      // 头未采集完整时重试一次收集流程
      if (!/\/pro\/courselist/i.test(page.url())) {
        await page
          .reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
          .catch(() => {});
      }
      for (let waited = 0; waited < 12 && !state.headersReady; waited += 1) {
        await page.waitForTimeout(1000);
      }
      if (state.headersReady) {
        authData = await fetchInPage(page, USER_COURSES, state.staticHeaders);
      }
    }
  }

  if (authData.status === 401 || authData.status === 403) {
    throw new Error(`AUTH_EXPIRED:雨课堂 user-courses 返回 HTTP ${authData.status}`);
  }
  if (!authData.body || !authData.body.data || !Array.isArray(authData.body.data.product_list)) {
    throw new Error('RAIN_COURSES_INVALID: 无法解析个人课程列表');
  }

  const products = authData.body.data.product_list;
  // 学期码不再写死：从本人课程数据反推，并输出依据
  const termDetection = detectTerm(products, termRequest);
  const termCode = termDetection.chosen;
  if (!termCode) {
    throw new Error('NO_TERM_DATA: 个人课程数据中没有可用学期码');
  }
  const courses = products
    .filter((item) => Number(item.classroom_term) === Number(termCode))
    .map((item) => ({
      course_name: item.course_name || '待确认',
      classroom_name: item.classroom_name || '待确认',
      classroom_term: item.classroom_term,
      course_id: String(item.course_id),
      classroom_id: String(item.classroom_id),
      sku_id: String(item.sku_id),
      key: `${item.classroom_id}-${item.sku_id}`,
    }));

  if (courses.length === 0) {
    throw new Error(
      `NO_TERM_COURSES: ${termCode} 学期无课程，学期分布=${termDetection.evidence
        .map((item) => `${item.term}:${item.course_count}`)
        .join(',')}`
    );
  }

  writer.emit('RAIN_TERM_DETECTED', `识别当前学期 ${termCode}`, {
    mode: termDetection.mode,
    rule: termDetection.rule,
    matched_course_count: termDetection.matched_course_count,
    evidence: termDetection.evidence,
  });
  writer.emit('RAIN_COURSES_READY', `找到 ${courses.length} 门课程`, {
    course_count: courses.length,
  });
  appendMarkdown(resultMd, [
    `学期识别: ${termCode}（${termDetection.mode === 'explicit' ? '显式指定' : '自动识别'}）`,
    `识别依据: ${termDetection.rule}`,
    `学期分布: ${termDetection.evidence.map((item) => `${item.term}=${item.course_count}门`).join('，')}`,
    `个人课程共 ${products.length} 条，${termCode} 学期 ${courses.length} 条。`,
    `静态标识请求头已收集: ${state.headersReady ? '是' : '否'}`,
    '',
  ]);

  writeJson(resultJson, {
    source: '雨课堂 user-courses + todo_list（页内 fetch，credentials=include）',
    status: 'running',
    started_at: startedAt.toISOString(),
    academic_term_code: termCode,
    term_detection: termDetection,
    courses_requested: courses.length,
    courses: [],
  });

  const results = [];
  let nextIndex = 0;
  let okCount = 0;
  let failedCount = 0;
  let authExpired = false;

  async function worker(workerId) {
    while (nextIndex < courses.length) {
      const index = nextIndex;
      nextIndex += 1;
      const course = courses[index];
      const requestStarted = Date.now();
      const response = await fetchTodos(page, state, course, retries);
      const elapsedMs = Date.now() - requestStarted;

      if (response.ok) {
        const data = response.body.data;
        if (!Array.isArray(data.result)) {
          // 验收项3：HTTP 200 但空结构不得误判为零任务
          results[index] = {
            ...course,
            ok: false,
            http_ms: elapsedMs,
            auth_failed: false,
            error: '响应结构异常：HTTP 200 但 data.result 非数组',
          };
          failedCount += 1;
          writer.emit('RAIN_COURSE_FAILED', `${course.classroom_name} 响应结构异常`, {
            worker: workerId,
            auth_failed: false,
            error: 'data.result 非数组',
          });
          appendMarkdown(resultMd, [
            `- 失败 | ${course.classroom_name} | 响应结构异常（data.result 非数组，不计为零任务）`,
          ]);
          writeJson(resultJson, {
            source: '雨课堂 user-courses + todo_list（页内 fetch，credentials=include）',
            status: 'running',
            started_at: startedAt.toISOString(),
            academic_term_code: termCode,
    term_detection: termDetection,
            courses_requested: courses.length,
            requests_completed: results.filter(Boolean).length,
            ok: okCount,
            failed: failedCount,
            auth_expired: authExpired,
            courses: results.filter(Boolean),
          });
          continue;
        }
        const items = data.result.map(mapTodoItem);
        const count = data.count || {};
        results[index] = {
          ...course,
          ok: true,
          http_ms: elapsedMs,
          count,
          unfinished_count: items.length,
          tasks: items,
        };
        okCount += 1;
        writer.emit('RAIN_COURSE_OK', `${course.classroom_name} 读取完成`, {
          worker: workerId,
          unfinished_count: items.length,
          count_total: count.total,
        });
        appendMarkdown(resultMd, [
          `- 成功 | ${course.classroom_name} | 未完成 ${items.length} | ${elapsedMs}ms`,
          ...items.map(
            (item) =>
              `  - ${item.name} | 截止 ${item.score_deadline} | ${
                item.is_expired ? '已过期' : '未过期'
              }`
          ),
        ]);
      } else {
        results[index] = {
          ...course,
          ok: false,
          http_ms: elapsedMs,
          auth_failed: Boolean(response.auth),
          error: response.error || '未知错误',
        };
        failedCount += 1;
        if (response.auth) authExpired = true;
        writer.emit('RAIN_COURSE_FAILED', `${course.classroom_name} 读取失败`, {
          worker: workerId,
          auth_failed: Boolean(response.auth),
          error: response.error || '未知错误',
        });
        appendMarkdown(resultMd, [
          `- 失败 | ${course.classroom_name} | ${
            response.auth ? '登录失效' : response.error || '未知错误'
          }`,
        ]);
      }

      writeJson(resultJson, {
        source: '雨课堂 user-courses + todo_list（页内 fetch，credentials=include）',
        status: 'running',
        started_at: startedAt.toISOString(),
        academic_term_code: termCode,
    term_detection: termDetection,
        courses_requested: courses.length,
        requests_completed: results.filter(Boolean).length,
        ok: okCount,
        failed: failedCount,
        auth_expired: authExpired,
        courses: results.filter(Boolean),
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, courses.length) }, (_, index) => worker(index + 1))
  );

  const totalUnfinished = results.reduce((total, item) => {
    if (!item || !item.ok) return total;
    const count = Number(item.count.total);
    return total + (Number.isFinite(count) ? count : item.unfinished_count);
  }, 0);

  const finishedAt = new Date();
  const partial = failedCount > 0;
  const output = {
    source: '雨课堂 user-courses + todo_list（页内 fetch，credentials=include）',
    status: authExpired && okCount === 0 ? 'auth_expired' : partial ? 'partial' : 'complete',
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    total_seconds: Number(((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(2)),
    academic_term_code: termCode,
    term_detection: termDetection,
    summary: {
      courses_requested: courses.length,
      ok: okCount,
      failed: failedCount,
      unfinished_total: totalUnfinished,
      auth_expired: authExpired,
    },
    courses: results.filter(Boolean),
  };
  writeJson(resultJson, output);
  JSON.parse(fs.readFileSync(resultJson, 'utf8'));

  appendMarkdown(resultMd, [
    '',
    '## 汇总',
    `- 课程: ${courses.length}`,
    `- 成功: ${okCount}`,
    `- 失败: ${failedCount}`,
    `- 未完成总数: ${totalUnfinished}`,
    `- 登录失效: ${authExpired ? '是' : '否'}`,
    `- 总耗时: ${output.total_seconds}s`,
    '- JSON 校验: 通过',
  ]);

  return {
    partial,
    output_json: resultJson,
    result_md: resultMd,
    courses: courses.length,
    ok: okCount,
    failed: failedCount,
    unfinished_total: totalUnfinished,
    auth_expired: authExpired,
  };
}

async function main() {
  const selection = readProfileSelection(process.argv);
  const outputDir = path.resolve(argValue('--output-dir', defaultOutputDir()));
  const authorization = checkAuthorization('rain');
  if (!authorization.authorized) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`PLATFORM_NOT_AUTHORIZED:rain ${authorization.reason}`);
    return;
  }
  // 学期码默认自动识别（latest/auto）；只有用户明确给数字时才按显式处理
  const termArg = String(argValue('--term', 'latest') || 'latest').trim();
  const termRequest = /^(latest|auto|current|)$/i.test(termArg) ? null : termArg;
  const concurrency = numberArg('--concurrency', 4);
  const retries = numberArg('--retries', 2) - 1;
  const loginTimeoutMs = numberArg('--login-timeout-seconds', 300) * 1000;
  const runtime = createRuntimeState();

  const result = await withBrowserSession({
    platform: 'rain',
    // 直接给真实登录路由，别让可见窗口停在公开首页
    loginUrl: RAIN_LOGIN_URL,
    outputDir,
    profileId: selection.profileId,
    profileDir: selection.profileDir,
    loginTimeoutMs,
    // 无头判定未登录后才走到这里：可见窗口必须落在真实登录界面
    ensureLoginEntry: async ({ page }) => openLoginEntry({ page, outputDir }),
    isAuthenticated: async (args) => {
      const authenticated = await inspectAuth({ ...args, state: runtime });
      runtime.authState = authenticated;
      return authenticated;
    },
    onBrowserStart: async ({ context, page }) => {
      runtime.headersReady = false;
      runtime.staticHeaders = {};
      configurePage(page, runtime);
      context.on('page', (newPage) => configurePage(newPage, runtime));
    },
    onAuthenticated: async ({ page, writer }) => {
      return readRain({
        page,
        state: runtime,
        writer,
        outputDir,
        termRequest,
        concurrency,
        retries,
      });
    },
  });

  const summaryPath = path.join(outputDir, 'rain-fast-session-summary.json');
  writeJson(summaryPath, result);
  console.log(`RAIN_FAST_RESULT:${result.status}`);
  if (result.login_entry && result.login_entry.final_url) {
    console.log(
      `LOGIN_ENTRY:${result.login_entry.entry_method || result.status} url=${result.login_entry.final_url} form=${
        result.login_entry.login_form_detected ? 'yes' : 'no'
      } qr=${result.login_entry.qr_detected ? 'yes' : 'no'}`
    );
  }
  if (
    result.status === 'AUTH_WAIT' ||
    result.status === 'AUTH_REQUIRED' ||
    result.status === 'AUTH_ENTRY_NOT_FOUND'
  ) {
    process.exitCode = 0;
    return;
  }
  if (result.status !== 'READ_OK' && result.status !== 'READ_PARTIAL') {
    process.exitCode = 1;
  }
}

// 离线自检：只校验"入口地址与脱敏"这类纯函数，不联网、不打开浏览器
function selfCheck() {
  const checks = [];
  const assert = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

  assert('登录入口在雨课堂域内', onRainHost(RAIN_LOGIN_URL), RAIN_LOGIN_URL);
  assert('登录入口路径为 /pro/login', new URL(RAIN_LOGIN_URL).pathname === '/pro/login', RAIN_LOGIN_URL);
  assert(
    '兜底地址也都在雨课堂域内',
    RAIN_LOGIN_FALLBACK_URLS.every((url) => onRainHost(url)),
    RAIN_LOGIN_FALLBACK_URLS.join(' | ')
  );
  assert(
    '入口不跨到教务/eCourse',
    !/jwglxt|xsjw|ecourse/i.test([RAIN_LOGIN_URL, ...RAIN_LOGIN_FALLBACK_URLS].join(' ')),
    '无语义越界'
  );
  assert(
    '脱敏去掉 ticket 等查询串',
    sanitizeUrl('https://scut.yuketang.cn/pro/login?ticket=ST-123&redirect=%2Fpro') ===
      'https://scut.yuketang.cn/pro/login',
    sanitizeUrl('https://scut.yuketang.cn/pro/login?ticket=ST-123&redirect=%2Fpro')
  );
  assert(
    '脱敏保留首页域名',
    sanitizeUrl('https://scut.yuketang.cn/') === 'https://scut.yuketang.cn',
    sanitizeUrl('https://scut.yuketang.cn/')
  );
  assert(
    '登录控件词表包含扫码/账号登录',
    LOGIN_CONTROL_TEXTS.includes('扫码登录') && LOGIN_CONTROL_TEXTS.includes('账号登录'),
    LOGIN_CONTROL_TEXTS.length + ' 项'
  );
  assert('XTBZ 存在即允许接口重试', rainHeadersReady({ xtbz: 'test' }), 'xtbz');
  assert('缺少 XTBZ 不提前判定就绪', !rainHeadersReady({}), 'empty');
  assert(
    '静态请求头列表覆盖 XTBZ',
    STATIC_HEADER_NAMES.includes('xtbz'),
    STATIC_HEADER_NAMES.join(',')
  );

  const failed = checks.filter((item) => !item.pass);
  for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'} ${item.name} → ${item.detail}`);
  console.log(`RAIN_SELF_CHECK:${failed.length ? 'FAIL' : 'PASS'} (${checks.length - failed.length}/${checks.length})`);
  return failed.length === 0;
}

if (process.argv.includes('--self-check')) {
  process.exitCode = selfCheck() ? 0 : 1;
} else if (require.main === module) {
  main().catch((error) => {
    console.error(`RAIN_FAST_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exit(1);
  });
}

module.exports = { detectTerm };
