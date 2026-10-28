'use strict';

/**
 * eCourse（https://ecourse.scut.edu.cn/）只读拉取
 *
 * 规则（不可放宽）：
 * 1. 只从根地址进入，跟随 302；不拼接、不直接访问无 id 的 index.html
 * 2. 单页运行：全程只使用一个 page，不新开标签、不刷新页面
 * 3. 登录等待期只读当前页与各 frame 状态：不导航、不新开、不刷新、不碰教务
 * 4. 只读：不提交作业、不答题、不报名、不改任何业务数据
 * 5. 结构未知时输出诊断 JSON，不猜、不编造
 */

const fs = require('fs');
const path = require('path');
const { withBrowserSession, pageAuthUrl } = require('./session-gateway');
const { ECOURSE_ROOT, HOST_PATTERNS } = require('./endpoints');
const { checkAuthorization, defaultOutputDir, readProfileSelection } = require('./huayuan-paths');
const { safeFrameExcerpt, sanitizeExcerpt, sanitizeUrl, safeTitle } = require('./privacy');
const {
  LOGIN_SURFACE_POLL_MS,
  LOGIN_SURFACE_TIMEOUT_MS,
  COURSE_SURFACE_TIMEOUT_MS,
  detectLoginSurface,
  planEntryNavigation,
  surfaceMessage,
  waitForCourseSurface,
  waitForSurface,
} = require('./ecourse-wait');
const { ECOURSE_NOTICE, installContextNotice } = require('./session-notice');

// 根入口：只写学校通用域名，302 由站点自己带上 id，绝不拼接无参 index.html
const ROOT_URL = ECOURSE_ROOT;
const ECOURSE_HOST = HOST_PATTERNS.ecourse;
const JW_PATTERN = HOST_PATTERNS.jw;
const SSO_HOST = HOST_PATTERNS.sso;
// eCourse 的主框架只允许停在这两个站点：自己的业务域，和统一认证（登录回跳）
const ALLOWED_TOP_HOSTS = [ECOURSE_HOST, SSO_HOST];
const ENTRY_NO_PARAM = /\/web\/gt\/\d+\/index\.html$/i;
const LOGIN_HINT = /扫码登录|统一身份认证|cas\/login|login_qrcode|请登录|账号登录/i;
const STATIC_ASSET = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|map|mp4)(\?|$)/i;
const NAV_WORDS = /^(首页|主页|登录|退出|登出|更多|全部|设置|帮助|个人中心|我的|学习课程|我的课程|教学课堂|返回|上一页|下一页)$/;
const COURSE_MENU = /学习课程|我的课程|教学课堂/;
const FINISHED = /已提交|已完成|已批阅|已评阅|已作答|已交卷|已结束|已截止|已通过/;
const UNFINISHED = /未提交|未完成|未作答|待提交|待完成|待作答|进行中|未开始|去完成|立即作答|开始答题|去提交/;

const SECTIONS = [
  { key: 'homework', label: '作业', src: '作业' },
  { key: 'quiz', label: '测试', src: '测试|测验' },
  { key: 'survey', label: '问卷', src: '问卷' },
  { key: 'discussion', label: '讨论', src: '讨论' },
];

// ---------- 通用工具 ----------

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name, fallback) {
  const parsed = Number(argValue(name, String(fallback)));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

// ---------- 用户可见进度（eCourse 阶段统一口径） ----------

function emitStep(writer, message, extra = {}) {
  if (writer) {
    writer.emit('ECOURSE_STEP', message, extra);
    return;
  }
  console.log(message);
}

/**
 * 只读读取"登录界面到底长什么样"。
 * 纪律：不导航、不刷新、不 newPage、不点击——用户可能正在扫码，
 * 任何一次跳转都可能在那一刻把二维码刷掉。
 */
async function collectLoginSurface(page) {
  const snapshot = {
    qr_count: 0,
    password_input: 0,
    text_input: 0,
    iframe_total: 0,
    login_text: false,
    course_menu: false,
    main_text_len: 0,
    top_url: null,
  };
  try {
    snapshot.top_url = page.url();
  } catch {
    snapshot.top_url = null;
  }

  for (const frame of page.frames()) {
    const part = await frame
      .evaluate(() => {
        const countVisible = (nodes) =>
          Array.from(nodes).filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }).length;
        const blobOf = (el) =>
          [
            el.getAttribute('src'),
            el.getAttribute('data-src'),
            el.getAttribute('alt'),
            String(el.id || ''),
            String(typeof el.className === 'string' ? el.className : ''),
          ]
            .filter(Boolean)
            .join(' ');
        const qrish = Array.from(document.querySelectorAll('img,canvas,svg,div,span')).filter((el) =>
          /qrcode|qr_|qr-code|login_qrcode|wxqr|二维码/i.test(blobOf(el))
        );
        const text = document.body ? document.body.innerText : '';
        const compact = String(text || '').replace(/\s+/g, '');
        return {
          qr_count: countVisible(qrish),
          password_input: countVisible(document.querySelectorAll('input[type="password"]')),
          text_input: countVisible(document.querySelectorAll('input[type="text"],input[type="tel"]')),
          iframe_total: document.querySelectorAll('iframe').length,
          login_text: /扫码登录|请使用微信扫码|统一身份认证|账号登录|请登录|密码登录/.test(String(text || '').slice(0, 800)),
          course_menu: /学习课程|我的课程|教学课堂/.test(String(text || '')),
          main_text_len: compact.length,
        };
      })
      .catch(() => null);
    if (!part) continue;
    snapshot.qr_count += part.qr_count;
    snapshot.password_input += part.password_input;
    snapshot.text_input += part.text_input;
    snapshot.iframe_total += part.iframe_total;
    snapshot.main_text_len += part.main_text_len;
    snapshot.login_text = snapshot.login_text || part.login_text;
    snapshot.course_menu = snapshot.course_menu || part.course_menu;
  }
  return snapshot;
}

function firstLine(error) {
  return String((error && error.message) || error || '').split('\n')[0];
}

function compact(text, limit = 500) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// ---------- 登录信号采集（只输出布尔与计数，绝不输出姓名/票据/Cookie） ----------

async function frameSignals(frame) {
  const url = frame.url();
  const info = {
    url: sanitizeUrl(url),
    text_len: 0,
    has_course_menu: false,
    is_login: LOGIN_HINT.test(url),
  };
  try {
    const text = await frame.evaluate(() => (document.body ? document.body.innerText : ''));
    info.text_len = String(text || '').replace(/\s+/g, '').length;
    info.has_course_menu = COURSE_MENU.test(text || '');
    if (!info.is_login) info.is_login = /扫码登录|统一身份认证|请登录|账号登录/.test(compact(text, 400));
  } catch {
    info.readable = false;
  }
  return info;
}

async function collectSignals(page) {
  const main = page.mainFrame();
  const url = page.url();
  const title = await page.title().catch(() => '');
  const mainDocLen = await main
    .evaluate(() => (document.body ? document.body.innerText.replace(/\s+/g, '').length : 0))
    .catch(() => 0);

  const userNamePresent = await main
    .evaluate(() => {
      try {
        const value = window.userName;
        return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
      } catch {
        return false;
      }
    })
    .catch(() => false);

  const panel = await main
    .evaluate(() => {
      const el = document.querySelector('#alreadyLoginPanel');
      if (!el) return { present: false, visible: false };
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible =
        rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      return { present: true, visible };
    })
    .catch(() => ({ present: false, visible: false }));

  const frames = [];
  for (const frame of page.frames()) frames.push(await frameSignals(frame));

  const loop = await iframeCount(page);
  const topOnLogin =
    pageAuthUrl(url) || HOST_PATTERNS.sso.test(url) || /\/cas\/login|login_qrcode/i.test(url) || LOGIN_HINT.test(title);
  const anyFrameCourseMenu = frames.some((frame) => frame.has_course_menu);
  const topOnJw = JW_PATTERN.test(url);

  return {
    main_url: sanitizeUrl(url),
    title: safeTitle(title),
    main_doc_len: mainDocLen,
    user_name_present: userNamePresent,
    already_login_panel_present: panel.present,
    already_login_panel_visible: panel.visible,
    frames,
    iframe_total: loop.total,
    iframe_self_count: loop.self_count,
    top_on_login: topOnLogin,
    top_on_jw: topOnJw,
    any_frame_course_menu: anyFrameCourseMenu,
  };
}

async function iframeCount(page) {
  return page
    .mainFrame()
    .evaluate(() => {
      const here = location.href.split('#')[0];
      const frames = Array.from(document.querySelectorAll('iframe'));
      const srcs = [];
      let self = 0;
      for (const frame of frames) {
        // 只认显式非空 src；空串/null 的空占位 iframe 一律忽略
        const raw = frame.getAttribute('src');
        if (raw === null || raw.trim() === '') continue;
        let resolved = null;
        try {
          resolved = new URL(raw, location.href).href.split('#')[0];
        } catch {
          resolved = null;
        }
        if (!resolved) continue;
        srcs.push(resolved);
        const rect = frame.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        if (resolved === here && visible) self += 1;
      }
      return { total: frames.length, counted_srcs: srcs.length, self_count: self, srcs: srcs.slice(0, 20) };
    })
    .then((result) => ({ ...result, srcs: (result.srcs || []).map((src) => sanitizeUrl(src)) }))
    .catch(() => ({ total: 0, counted_srcs: 0, self_count: 0, srcs: [] }));
}

function progressSnapshot(signals) {
  return {
    main_url: signals.main_url,
    title: signals.title,
    main_doc_len: signals.main_doc_len,
    user_name_present: signals.user_name_present,
    already_login_panel_visible: signals.already_login_panel_visible,
    top_on_login: signals.top_on_login,
    top_on_jw: signals.top_on_jw,
    frame_count: signals.frames.length,
    frames: signals.frames.map((frame) => ({
      url: frame.url,
      text_len: frame.text_len,
      has_course_menu: frame.has_course_menu,
      is_login: frame.is_login,
    })),
  };
}

// ---------- 登录态判定 ----------

async function inspectEcourse(page, { initial, state, noticeApi = null }) {
  const writer = state.writer;

  if (initial) {
    // ① 只在页面还是空白 / 尚未进入 eCourse 与 SSO 域时导航一次，杜绝重复 goto
    const plan = planEntryNavigation({
      url: page.url(),
      alreadyNavigated: state.entryNavigated,
      allowedPatterns: [ECOURSE_HOST, SSO_HOST],
    });
    if (plan.navigate) {
      await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      state.entryNavigated = true;
    } else if (writer) {
      emitStep(writer, `eCourse：${plan.reason}，跳过重复导航`, { url: null });
    }

    // ② 事件驱动轮询替代原来的固定 8 秒：二维码 / 表单 / iframe / 登录文字任一出现就立刻返回
    const surface = await waitForSurface({
      probe: () => collectLoginSurface(page),
      emit: (message, extra) => emitStep(writer, message, extra),
      timeoutMs: state.surfaceTimeoutMs,
      intervalMs: LOGIN_SURFACE_POLL_MS,
      label: 'eCourse',
    });
    state.loginSurface = surface;
    emitStep(writer, surfaceMessage(surface.kind), {
      waited_ms: surface.waited_ms,
      polls: surface.polls,
      signals: surface.signals,
    });
    if (surface.ready && noticeApi) {
      await noticeApi.setText(page, surface.kind === 'menu' ? ECOURSE_NOTICE.reading : ECOURSE_NOTICE.login_ready);
    }
    // ③ 这里结束就是登录（或课程页）判定，绝不再追加第二个固定等待
  }

  let signals = await collectSignals(page);

  // 自嵌套只报不拦：登录页与门户都可能出现同名 src 的多重 iframe，
  // 这属于站点布局缺陷，不能拿来当作"未登录"的证据，否则永远等不到登录成功。
  if (signals.iframe_self_count > 1) {
    const loop = await iframeCount(page);
    if (writer && state.lastSelfCount !== signals.iframe_self_count) {
      writer.emit('ECOURSE_SELF_EMBED_LOOP', '检测到页面自我嵌套 iframe', {
        self_count: signals.iframe_self_count,
        total: signals.iframe_total,
        url: signals.main_url,
        sample_srcs: (loop.srcs || []).slice(0, 3),
        blocking: false,
      });
    }
    state.lastSelfCount = signals.iframe_self_count;
    state.selfEmbedLoop = true;
  } else {
    state.lastSelfCount = 0;
  }

  if (signals.top_on_jw) {
    state.aborted = {
      status: 'ECOURSE_TOP_REDIRECTED_TO_JW',
      url: signals.main_url,
      from: ROOT_URL,
      at: new Date().toISOString(),
      detail: 'eCourse 顶层被跳转到教务系统，已立即中止读取',
    };
    if (writer) writer.emit('ECOURSE_TOP_REDIRECTED_TO_JW', '顶层被跳转到教务系统', { url: signals.main_url });
    return { authenticated: false, reason: 'ECOURSE_TOP_REDIRECTED_TO_JW', details: progressSnapshot(signals) };
  }

  const strong =
    signals.user_name_present || signals.already_login_panel_visible || signals.any_frame_course_menu;
  // CAS 带 ticket 回跳成功也是过硬证据：即使门户随后自嵌套导致 DOM 不可读，登录本身已经成立
  const casReturned = state.chain.some((entry) => /casLogin_forPage\.aspx/i.test(entry));
  const authenticated =
    !signals.top_on_login && ECOURSE_HOST.test(signals.main_url) && (strong || casReturned);

  const accepted = [];
  if (signals.user_name_present) accepted.push('window.userName');
  if (signals.already_login_panel_visible) accepted.push('#alreadyLoginPanel');
  if (signals.any_frame_course_menu) accepted.push('frame_course_menu');
  if (casReturned) accepted.push('cas_ticket_return');

  if (writer) {
    writer.emit(authenticated ? 'AUTH_PROGRESS' : 'AUTH_PROGRESS', '登录信号轮询', {
      ...progressSnapshot(signals),
      accepted_signals: accepted,
      verdict: authenticated ? 'authenticated' : 'not_authenticated',
    });
  }

  if (authenticated) {
    return {
      authenticated: true,
      reason: `强信号命中：${accepted.join(' / ')}`,
      details: progressSnapshot(signals),
    };
  }

  const missing = [];
  if (!signals.user_name_present) missing.push('window.userName 为空');
  if (!signals.already_login_panel_visible) missing.push('#alreadyLoginPanel 不可见');
  if (!signals.any_frame_course_menu) missing.push('所有 frame 均无 学习课程/我的课程/教学课堂');
  if (signals.top_on_login) missing.push('顶层仍在登录或统一认证页');

  return {
    authenticated: false,
    reason: `缺少登录信号：${missing.join('；')}`,
    details: { ...progressSnapshot(signals), missing_signals: missing },
  };
}

// ---------- 跨 frame 读取 ----------

async function anchorsAllFrames(page, limit = 400) {
  const out = [];
  const seen = new Set();
  for (const frame of page.frames()) {
    let list = [];
    try {
      list = await frame.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
          text: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          href: anchor.href || '',
        }))
      );
    } catch {
      list = [];
    }
    for (const item of list) {
      const key = `${item.text}|${item.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...item, frame_url: frame.url() });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// 用最小可点击元素定位导航项，跨 frame 搜索，避免点到包裹整页的容器
async function markByTextAnyFrame(page, patternSource) {
  for (const frame of page.frames()) {
    const hit = await frame
      .evaluate((src) => {
        const re = new RegExp(src);
        const nodes = Array.from(document.querySelectorAll('a,button,li,span,div,p,td,dt'));
        const candidates = [];
        for (const el of nodes) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 24 || !re.test(text)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          candidates.push({ text, len: text.length, el });
        }
        if (!candidates.length) return null;
        candidates.sort((a, b) => a.len - b.len);
        const target = candidates[0];
        document.querySelectorAll('[data-huayuan-target]').forEach((node) => {
          node.removeAttribute('data-huayuan-target');
        });
        target.el.setAttribute('data-huayuan-target', '1');
        return {
          text: target.text,
          tag: target.el.tagName,
          href: target.el.getAttribute('href') || null,
        };
      }, patternSource)
      .catch(() => null);
    if (hit) return { frame, ...hit };
  }
  return null;
}

async function extractRecordsAllFrames(page) {
  const rows = [];
  const seen = new Set();
  let recordsTotal = null;

  for (const frame of page.frames()) {
    const result = await frame
      .evaluate(() => {
        const STATUS = /状态[：:]|已提交|未提交|未作答|已作答|已批阅|未批阅|未过期|已过期|已完成|未完成/;
        const HEADER = /序号\s*标题|标题\s*类型|标题\s*答卷|标题\s*测试/;
        const items = [];
        const localSeen = new Set();

        const push = (raw) => {
          const text = String(raw || '').replace(/\s+/g, ' ').trim();
          if (text.length < 8 || text.length > 260) return;
          if (!/截止日期|结束日期/.test(text)) return;
          if (!STATUS.test(text)) return;
          if (HEADER.test(text)) return;
          const key = text;
          if (localSeen.has(key)) return;
          localSeen.add(key);
          items.push(text);
        };

        // 1) 作业区主结构：a.exerciseDiv，文本自带标题+截止日期+状态
        for (const anchor of Array.from(document.querySelectorAll('a.exerciseDiv'))) {
          const own = (anchor.innerText || '').trim();
          if (/截止日期/.test(own)) {
            push(own);
          } else {
            const box = anchor.closest('div,li,tr');
            push(box ? box.innerText : own);
          }
        }

        // 2) 表格型列表：真实数据行（含截止日期 + 提交状态），表头排除
        for (const tr of Array.from(document.querySelectorAll('tr'))) {
          push(tr.innerText);
        }

        const bodyText = document.body ? document.body.innerText : '';
        const countMatch = bodyText.match(/记录总数[：:]\s*(\d+)/);
        return {
          items,
          records_total: countMatch ? Number(countMatch[1]) : null,
        };
      })
      .catch(() => ({ items: [], records_total: null }));

    if (result.records_total !== null && (recordsTotal === null || result.records_total > recordsTotal)) {
      recordsTotal = result.records_total;
    }
    for (const text of result.items) {
      if (seen.has(text)) continue;
      seen.add(text);
      rows.push(text);
    }
  }

  return { rows, recordsTotal };
}

function discussionRequiresAction(text) {
  const value = String(text || '').replace(/\s+/g, ' ');
  return /(?:请|须|必须|务必)[^。；\n]{0,30}(?:回复|跟帖)|(?:回复|跟帖)[^。；\n]{0,30}(?:计分|计入|参与分|平时分|成绩|截止)|(?:必答|讨论作业|回帖作业)/i.test(
    value
  );
}

function classifySectionGap({ sectionKey, declared, rowCount, discussionEvidence }) {
  const gap = Number.isFinite(declared) ? Math.max(0, declared - rowCount) : 0;
  if (!gap) return { gap: 0, informational_count: 0, unparsed_count: 0 };
  if (sectionKey === 'discussion' && discussionEvidence?.found && !discussionEvidence.action_required) {
    return { gap, informational_count: gap, unparsed_count: 0 };
  }
  return { gap, informational_count: 0, unparsed_count: gap };
}

async function collectDiscussionEvidence(page) {
  const texts = [];
  const frameUrls = [];
  for (const frame of page.frames()) {
    let text = '';
    try {
      text = await frame.evaluate(() => (document.body ? document.body.innerText : ''));
    } catch {
      text = '';
    }
    if (!/记录总数[：:]\s*\d+/.test(text)) continue;
    if (!/发帖|讨论|回复/.test(text) && !/\/discussion\//i.test(frame.url())) continue;
    texts.push(text);
    frameUrls.push(sanitizeUrl(frame.url()));
  }
  const combined = texts.join('\n').slice(0, 20000);
  return {
    found: texts.length > 0,
    frame_urls: frameUrls,
    action_required: discussionRequiresAction(combined),
  };
}

// ---------- 网络 JSON 采集（只留 URL/状态/JSON 体，不留请求头与 Cookie） ----------

function attachMonitor(page, state) {
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url || url === 'about:blank') return;
    // 跳转链会落盘：一律脱敏，去掉 ticket/token 等参数
    const safe = sanitizeUrl(url);
    if (state.chain[state.chain.length - 1] !== safe) state.chain.push(safe);
  });

  page.on('response', (response) => {
    const url = response.url();
    const type = response.headers()['content-type'] || '';
    if (!/json|api|ajax|rest/i.test(url) && !/application\/json/i.test(type)) return;
    if (STATIC_ASSET.test(url)) return;
    response
      .json()
      .then((body) => {
        if (state.json.length >= 400) state.json.shift();
        state.json.push({ url, status: response.status(), at: new Date().toISOString(), body });
      })
      .catch(() => {});
  });
}

// ---------- 递归扫描 ----------

function looksLikeTask(obj) {
  const keys = Object.keys(obj);
  const hasDeadline = keys.some((key) => /deadline|end_?time|endTime|start_?time|close_?time|截止/i.test(key));
  const hasStatus = keys.some((key) => /status|state|finished|submitted|submit_?state|完成/i.test(key));
  return hasDeadline && hasStatus;
}

function scanCourses(value, depth, out, seen) {
  if (depth > 6 || out.length >= 200 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 120)) scanCourses(item, depth + 1, out, seen);
    return;
  }
  const keys = Object.keys(value);
  const nameKey = keys.find((key) => /^(course_?name|courseName|class_?name|className|title|name)$/i.test(key));
  const idKey = keys.find((key) => /(course_?id|class_?id|courseId|classId|open_?id|^id$)/i.test(key));
  const name = nameKey ? value[nameKey] : null;
  if (
    typeof name === 'string' &&
    name.trim().length >= 2 &&
    name.trim().length <= 60 &&
    idKey &&
    value[idKey] !== undefined &&
    value[idKey] !== null &&
    value[idKey] !== '' &&
    !looksLikeTask(value)
  ) {
    const id = String(value[idKey]);
    const key = `${name.trim()}|${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      const urlKey = keys.find((k) => /^(url|href|link|redirect|path|course_?url)$/i.test(k));
      out.push({
        name: name.trim(),
        course_id: id,
        url_hint: urlKey && typeof value[urlKey] === 'string' ? value[urlKey] : null,
        matched_keys: keys.slice(0, 12),
        origin: 'json',
      });
    }
  }
  for (const key of keys) scanCourses(value[key], depth + 1, out, seen);
}

function scanTaskItems(value, depth, out) {
  if (depth > 6 || out.length >= 300 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 120)) scanTaskItems(item, depth + 1, out);
    return;
  }
  const keys = Object.keys(value);
  const titleKey = keys.find((key) =>
    /^(title|name|homework_?name|exam_?name|questionnaire_?name|topic|subject|activity_?name)$/i.test(key)
  );
  const title = titleKey ? value[titleKey] : null;
  if (typeof title === 'string' && title.trim().length >= 2 && title.trim().length <= 120) {
    const deadlineKey = keys.find((key) => /deadline|end_?time|endTime|close_?time|expire/i.test(key));
    const statusKey = keys.find((key) => /^(status|state|submit_?status|finish_?status|done)$/i.test(key));
    if (deadlineKey || statusKey) {
      out.push({
        title: title.trim(),
        deadline: deadlineKey ? String(value[deadlineKey]) : null,
        status_raw: statusKey ? String(value[statusKey]) : null,
        raw: keys.slice(0, 14),
        origin: 'json',
      });
    }
  }
  for (const key of keys) scanTaskItems(value[key], depth + 1, out);
}

// ---------- 课程枚举 ----------

function urlParamId(href) {
  try {
    const id = new URL(href).searchParams.get('id');
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

function deriveCoursesFromAnchors(anchors) {
  const out = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const href = anchor.href || '';
    const text = (anchor.text || '').trim();
    if (!href || !ECOURSE_HOST.test(href)) continue;
    if (STATIC_ASSET.test(href) || /login|logout|sso/i.test(href)) continue;
    if (!text || text.length < 2 || text.length > 40) continue;
    if (NAV_WORDS.test(text)) continue;
    const courseShaped =
      /course|class|kecheng|kc\/|classroom|study|learn|stu\/|coursedetail|bjxx|kch/i.test(href) ||
      /课程|课堂/.test(text);
    if (!courseShaped) continue;
    const key = `${text}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: text, course_id: urlParamId(href), url: href, origin: 'dom' });
  }
  return out;
}

function mergeCourses(domCourses, jsonCourses) {
  const merged = [...domCourses];
  const byName = new Map();
  for (const item of merged) byName.set(item.name.replace(/\s+/g, ''), item);
  for (const item of jsonCourses) {
    const key = item.name.replace(/\s+/g, '');
    const existing = byName.get(key);
    if (existing) {
      if (!existing.course_id && item.course_id) existing.course_id = item.course_id;
      if (!existing.url && item.url_hint && /^https?:/i.test(item.url_hint)) existing.url = item.url_hint;
      continue;
    }
    const extra = {
      name: item.name,
      course_id: item.course_id,
      url: item.url_hint && /^https?:/i.test(item.url_hint) ? item.url_hint : null,
      origin: 'json',
    };
    byName.set(key, extra);
    merged.push(extra);
  }
  return merged;
}

// ---------- 课堂读取 ----------

async function safeGoto(page, state, writer, url) {
  // 已经判定越界的运行不再发起任何导航：继续点下去只会在两个系统间反复跳
  if (state.aborted) return { blocked: state.aborted.status, hard: true, loop: false };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const loop = await iframeCount(page);
  // 站点在每页都预置同名 src 的空占位 iframe，自嵌套只作为告警上报，不阻断读取
  if (loop.self_count > 1) {
    if (writer && state.lastSelfCount !== loop.self_count) {
      writer.emit('ECOURSE_SELF_EMBED_LOOP', '导航后检出页面自我嵌套（仅告警，不阻断）', {
        url: page.url(),
        self_count: loop.self_count,
        total: loop.total,
        sample_srcs: (loop.srcs || []).slice(0, 3),
      });
    }
    state.lastSelfCount = loop.self_count;
  }

  const topUrl = page.url();
  const violation = checkTopFrame(topUrl);
  if (!violation) return { blocked: null, loop: loop.self_count > 1 };

  // 越界即中止整次运行：记录脱敏 URL，不后退、不重试、不在 eCourse 会话里打开其他平台
  state.aborted = {
    status: violation.status,
    url: sanitizeUrl(topUrl),
    from: sanitizeUrl(url),
    at: new Date().toISOString(),
    detail: violation.detail,
  };
  if (writer) {
    writer.emit(violation.status, violation.detail, {
      from: sanitizeUrl(url),
      to: sanitizeUrl(topUrl),
      action: '已中止 eCourse 读取，不再继续导航',
      note: 'eCourse 会话只允许主框架停留在 ecourse 与 sso',
    });
  }
  return { blocked: violation.status, hard: true, loop: loop.self_count > 1 };
}

/**
 * 主框架越界判定。
 * - 顶层落到教务（xsjw / jwglxt）：ECOURSE_TOP_REDIRECTED_TO_JW，最严重
 * - 顶层落到其他站点：ECOURSE_TOP_LEFT_PLATFORM
 * 返回 null 表示仍在允许范围内。
 */
function checkTopFrame(url) {
  const value = String(url || '');
  if (!value || value === 'about:blank') return null;
  // 正方教务的业务路径一定带 /jwglxt/，即使换了个域名的教务实例也能认出来
  if (JW_PATTERN.test(value) || /\/jwglxt(\/|$)/i.test(value)) {
    return {
      status: 'ECOURSE_TOP_REDIRECTED_TO_JW',
      detail: 'eCourse 顶层被跳转到教务系统，已立即中止读取',
    };
  }
  if (ALLOWED_TOP_HOSTS.some((pattern) => pattern.test(value))) return null;
  return {
    status: 'ECOURSE_TOP_LEFT_PLATFORM',
    detail: 'eCourse 顶层离开了 ecourse / sso，已立即中止读取',
  };
}

function classifyStatus(text) {
  if (FINISHED.test(text)) return 'finished';
  if (UNFINISHED.test(text)) return 'unfinished';
  return 'unknown';
}

function pickDeadline(text) {
  const iso = text.match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}(\s+\d{1,2}:\d{2}(:\d{2})?)?/);
  if (iso) return iso[0].replace(/\s+/g, ' ').trim();
  const cn = text.match(/(20\d{2}年)?\d{1,2}月\d{1,2}日?(\s*\d{1,2}:\d{2})?/);
  return cn ? cn[0].trim() : '待确认';
}

function pickTitle(text) {
  const cleaned = text
    .replace(/截止日期[：:]/g, ' ')
    .replace(/结束日期[：:]/g, ' ')
    .replace(/状态[：:]/g, ' ')
    .replace(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(\s+\d{1,2}:\d{2}(:\d{2})?)?/g, ' ')
    .replace(/\b20\d{2}\.\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
    .replace(/(未提交|未完成|未作答|待提交|待完成|进行中|未开始|已提交|已完成|已批阅|未批阅|已过期|未过期|已结束|已截止|满分|修改|\d+分)/g, ' ')
    .replace(/^\s*\d{1,2}\s+/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = cleaned.split(/[\s|｜]+/).filter(Boolean).slice(0, 8).join(' ');
  return (cut || text).slice(0, 60);
}

function toTaskCard({ courseName, sectionLabel, text, deadline, status, confidence, origin }) {
  return {
    source_platform: 'eCourse',
    course: courseName,
    title: pickTitle(text),
    task_type: sectionLabel,
    deadline: deadline || pickDeadline(text),
    submit_method: '待确认',
    materials: '待确认',
    estimated_minutes: '待确认',
    priority: '待确认',
    confidence,
    source_excerpt: text.slice(0, 80),
    status,
    origin,
  };
}

async function readSection(page, state, section) {
  // 已越界中止：不再点击、不再解析，如实返回"未读取"，而不是 0 条
  if (state.aborted) {
    return {
      found_entry: false,
      records_total: 0,
      submitted_count: 0,
      unfinished_count: 0,
      unknown_count: 0,
      unparsed_count: 0,
      rows: 0,
      tasks: [],
      aborted: true,
    };
  }

  const target = await markByTextAnyFrame(page, section.src);
  const before = state.json.length;
  if (target) {
    try {
      await target.frame.click('[data-huayuan-target="1"]', { timeout: 8000 });
      await page.waitForTimeout(2200);
    } catch {
      await page.waitForTimeout(500);
    }
  }

  const extracted = await extractRecordsAllFrames(page);
  const rows = extracted.rows;
  const recordsTotal = extracted.recordsTotal;
  const discussionEvidence =
    section.key === 'discussion' ? await collectDiscussionEvidence(page) : null;

  const stats = {
    records_total: recordsTotal,
    submitted_count: 0,
    unfinished_count: 0,
    unknown_count: 0,
    unparsed_count: 0,
    informational_count: 0,
  };
  const tasks = [];

  // 只有出现"未提交/未完成/未作答/去提交"才算待办；
  // "已过期"只代表过期，不等于未提交，不能算未完成
  for (const text of rows) {
    const verdict = classifyStatus(text);
    if (verdict === 'finished') {
      stats.submitted_count += 1;
      continue;
    }
    if (verdict === 'unfinished') {
      stats.unfinished_count += 1;
      const card = toTaskCard({
        courseName: null,
        sectionLabel: section.label,
        text,
        deadline: pickDeadline(text),
        status: '未完成',
        confidence: '高',
        origin: 'dom',
      });
      if (!tasks.some((item) => item.title === card.title && item.deadline === card.deadline)) {
        tasks.push(card);
      }
      continue;
    }
    stats.unknown_count += 1;
  }

  // 差额核对：页面声明「共 N 条」但实际只解析出 M 行时，N-M 条记录去向不明。
  // 这种情况必须计入不确定，绝不能让它静默消失后对外宣称「0 待办」。
  const declared = Number.isFinite(recordsTotal) ? recordsTotal : null;
  const gapStats = classifySectionGap({
    sectionKey: section.key,
    declared,
    rowCount: rows.length,
    discussionEvidence,
  });
  if (gapStats.gap > 0) {
    // 讨论区的普通帖子通常只有作者、发布时间、浏览数和回复按钮，
    // 没有截止日期或提交状态，不应当按"未解析作业"处理。
    // 只有页面明确要求回复、跟帖计分或存在回帖截止时才继续报不确定。
    stats.informational_count = gapStats.informational_count;
    stats.unparsed_count = gapStats.unparsed_count;
    stats.unknown_count += gapStats.unparsed_count;
  }

  const taskRecordsTotal =
    declared === null ? 0 : Math.max(0, declared - stats.informational_count);

  // 列表本身为空时直接返回空结构，不保留任何表头/日期碎片
  if (recordsTotal === 0) {
    return {
      found_entry: Boolean(target),
      records_total: 0,
      source_records_total: 0,
      task_records_total: 0,
      submitted_count: 0,
      unfinished_count: 0,
      unknown_count: 0,
      unparsed_count: 0,
      informational_count: 0,
      rows: 0,
      tasks: [],
      discussion: discussionEvidence,
    };
  }

  return {
    found_entry: Boolean(target),
    ...stats,
    source_records_total: declared,
    task_records_total: taskRecordsTotal,
    rows: rows.length,
    tasks,
    discussion: discussionEvidence,
  };
}

async function classroomSnapshot(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const url = frame.url();
    const info = { url: sanitizeUrl(url), text_head: '', labels: [] };
    try {
      const text = await frame.evaluate(() => (document.body ? document.body.innerText : ''));
      // 名单/成绩类页面整段跳过，只保留占位说明
      info.text_head = safeFrameExcerpt(url, text, 400);
    } catch {
      info.text_head = '[不可读]';
    }
    try {
      info.labels = await frame.evaluate(() => {
        const out = [];
        const seen = new Set();
        for (const el of Array.from(document.querySelectorAll('a,button,li,span,div[class*="tab"],div[class*="menu"] *'))) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 16 || seen.has(text)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          seen.add(text);
          out.push({ text, tag: el.tagName, cls: String(el.className || '').slice(0, 40) });
          if (out.length >= 60) break;
        }
        return out;
      });
    } catch {
      info.labels = [];
    }
    frames.push(info);
  }
  return frames;
}

async function readCourse(page, state, writer, course, index, total, outputDir) {
  emitStep(writer, `eCourse：正在读取第 ${index}/${total} 门课程……`, { index, total, course: course.name });
  const record = {
    index,
    name: course.name,
    course_id: course.course_id || '待确认',
    url: course.url || '待确认',
    ok: false,
    warnings: [],
    sections: {},
    records_total: 0,
    submitted_count: 0,
    unfinished_count: 0,
    unknown_count: 0,
    unparsed_count: 0,
    informational_count: 0,
    source_records_total: 0,
    task_count: 0,
    error: null,
  };

  if (!course.url) {
    record.error = '无可用课程页面地址（仅在接口数据中出现 id，未推导出 URL）';
    return record;
  }

  const nav = await safeGoto(page, state, writer, course.url);
  if (nav.blocked) {
    record.error = nav.blocked;
    return record;
  }
  if (nav.loop) record.warnings.push('ECOURSE_SELF_EMBED_LOOP');

  const classroom = await markByTextAnyFrame(page, '教学课堂');
  if (classroom) {
    try {
      await classroom.frame.click('[data-huayuan-target="1"]', { timeout: 8000 });
      await page.waitForTimeout(2200);
    } catch {
      record.warnings.push('「教学课堂」入口点击失败，改用当前页读取');
    }
  } else {
    record.warnings.push('课程页未找到「教学课堂」入口，按当前页读取');
  }

  const debug = { course: course.name, url: course.url, stages: [] };
  const stage = async (name) => {
    debug.stages.push({ stage: name, top_url: page.url(), frames: await classroomSnapshot(page) });
  };
  await stage('after_classroom_click');

  for (const section of SECTIONS) {
    const result = await readSection(page, state, section);
    const tasks = result.tasks.map((task) => ({ ...task, course: course.name }));
    record.sections[section.key] = {
      label: section.label,
      found_entry: result.found_entry,
      records_total: result.records_total,
      submitted_count: result.submitted_count,
      unfinished_count: result.unfinished_count,
      unknown_count: result.unknown_count,
      unparsed_count: result.unparsed_count || 0,
      informational_count: result.informational_count || 0,
      source_records_total: result.source_records_total || 0,
      task_records_total: result.task_records_total || 0,
      dom_rows: result.rows,
      unfinished: tasks.length,
      tasks,
      discussion: result.discussion || null,
    };
    record.submitted_count += result.submitted_count;
    record.unfinished_count += result.unfinished_count;
    record.unknown_count += result.unknown_count;
    record.unparsed_count += result.unparsed_count || 0;
    record.informational_count += result.informational_count || 0;
    record.source_records_total += result.source_records_total || result.records_total || 0;
    record.records_total += result.task_records_total ?? result.records_total ?? 0;
    record.task_count += tasks.length;
    if (result.unparsed_count > 0) {
      record.warnings.push(
        `ECOURSE_SECTION_UNPARSED:${section.key} 声明 ${result.records_total} 条，仅解析 ${result.rows} 行`
      );
    }
    await stage(`after_${section.key}`);
    if (result.aborted) break;
  }

  if (state.aborted) {
    record.error = state.aborted.status;
    record.aborted = true;
    record.warnings.push(`${state.aborted.status}: 顶层已离开 eCourse（${state.aborted.url}），此处不再继续读取`);
  }

  if (outputDir) {
    writeJson(
      path.join(outputDir, `ecourse-classroom-${course.course_id || index}.debug.json`),
      debug
    );
  }

  record.ok = !record.error;
  if (writer) {
    writer.emit('ECOURSE_COURSE_READ', `${course.name} 读取完成`, {
      index,
      total,
      task_count: record.task_count,
      error: record.error,
    });
  }
  return record;
}

async function readEcourse({ page, state, writer, outputDir, noticeApi = null }) {
  const startedAt = new Date();
  const coursesPath = path.join(outputDir, 'ecourse-courses.json');
  // 登录成功的瞬间就把提示条换成"正在读取"，用户不用猜窗口为什么停着不动
  if (noticeApi) await noticeApi.setText(page, ECOURSE_NOTICE.reading);
  const tasksPath = path.join(outputDir, 'ecourse-tasks.json');
  const discoveryPath = path.join(outputDir, 'ecourse-discovery.json');

  const rootUrl = sanitizeUrl(page.url());
  const title = safeTitle(await page.title().catch(() => ''));
  const head = await page.mainFrame()
    .evaluate(() => (document.body ? document.body.innerText : ''))
    .then((text) => safeFrameExcerpt(rootUrl, text, 500))
    .catch(() => '');

  // 登录成功的第一秒就告诉用户"已经在读了"，不再让用户对着静止的窗口猜进度
  const beforeJson = state.json.length;
  emitStep(writer, 'eCourse：检测到登录成功，正在读取课程列表……');

  // 课程列表稳定窗口改成事件驱动：锚点 / JSON / frame 出现就走，最长 5 秒，不傻等
  await waitForCourseSurface({
    probe: async () => ({
      anchor_count: (await anchorsAllFrames(page, 60)).length,
      json_count: state.json.length - beforeJson,
      frame_count: page.frames().length,
    }),
    emit: (message, extra) => emitStep(writer, message, extra),
    timeoutMs: COURSE_SURFACE_TIMEOUT_MS,
  });

  const anchors = (await anchorsAllFrames(page)).map((anchor) => ({
    href: sanitizeUrl(anchor.href),
    text: sanitizeExcerpt(anchor.text, 60),
  }));
  const loop = await iframeCount(page);
  const frameUrls = page.frames().map((frame) => sanitizeUrl(frame.url()));

  const jsonCourses = [];
  {
    // 登录过程本身就会拉课程列表，因此扫描整个缓冲区而不是只扫增量
    const seen = new Set();
    for (const entry of state.json) scanCourses(entry.body, 0, jsonCourses, seen);
  }
  const domCourses = deriveCoursesFromAnchors(anchors);
  const courses = mergeCourses(domCourses, jsonCourses);

  writeJson(discoveryPath, {
    checked_at: new Date().toISOString(),
    root_url: rootUrl,
    title,
    body_head: head,
    iframes: loop,
    frame_urls: frameUrls,
    jump_chain: state.chain,
    anchors_total: anchors.length,
    anchors: anchors.slice(0, 200),
    json_responses: state.json.map((entry) => ({ url: entry.url, status: entry.status })),
    dom_course_candidates: domCourses,
    json_course_candidates: jsonCourses,
    merged_courses: courses.length,
    note: courses.length
      ? '课程来源已识别'
      : '门户 DOM 与 JSON 均未识别出课程，需按本文件 anchors/json_responses 增补选择器',
  });

  writeJson(coursesPath, {
    source: 'eCourse 根门户动态枚举（只读）',
    status: courses.length ? 'running' : 'no_courses_recognized',
    started_at: startedAt.toISOString(),
    root_url: rootUrl,
    title,
    jump_chain: state.chain,
    course_count: courses.length,
    candidates: { dom: domCourses.length, json: jsonCourses.length },
    courses: courses.map((course, i) => ({
      index: i + 1,
      name: course.name,
      course_id: course.course_id || '待确认',
      url: course.url || '待确认',
      origin: course.origin,
    })),
  });

  if (!courses.length) {
    if (writer) {
      writer.emit('ECOURSE_NO_COURSES_RECOGNIZED', '未从门户识别出课程', {
        anchors: anchors.length,
        json: state.json.length,
        frames: frameUrls.length,
      });
    }
    writeJson(tasksPath, {
      source: 'eCourse 教学课堂（只读）',
      status: 'no_courses_recognized',
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      summary: { courses: 0, ok: 0, failed: 0, tasks: 0 },
      courses: [],
      tasks: [],
      note: '课程未识别，未进入任何课程页；诊断见 ecourse-discovery.json',
    });
    return { partial: true, courses: 0, ok: 0, failed: 0, tasks: 0 };
  }

  if (writer) writer.emit('ECOURSE_COURSES_ENUMERATED', `枚举到 ${courses.length} 门课程`, { count: courses.length });

  const records = [];
  const allTasks = [];
  for (let i = 0; i < courses.length; i += 1) {
    // 顶层一旦进入教务或其他站点就整体收工：继续循环只会在两个系统之间反复跳
    if (state.aborted) {
      console.log(`[ECOURSE_ABORTED] ${state.aborted.status} —— 剩余 ${courses.length - i} 门课程不再读取`);
      break;
    }
    const record = await readCourse(page, state, writer, courses[i], i + 1, courses.length, outputDir);
    records.push(record);
    for (const section of Object.values(record.sections)) allTasks.push(...section.tasks);
    writeJson(tasksPath, {
      source: 'eCourse 教学课堂（只读）',
      status: 'running',
      started_at: startedAt.toISOString(),
      progress: { done: records.length, total: courses.length },
      summary: {
        courses: courses.length,
        ok: records.filter((r) => r.ok).length,
        failed: records.filter((r) => !r.ok).length,
        tasks: allTasks.length,
      },
      courses: records,
      tasks: allTasks,
    });
  }

  const okCount = records.filter((r) => r.ok).length;
  const failedCount = records.length - okCount;
  const unparsed = records.reduce((sum, item) => sum + (item.unparsed_count || 0), 0);
  const informational = records.reduce((sum, item) => sum + (item.informational_count || 0), 0);
  const aborted = state.aborted || null;
  const output = {
    source: 'eCourse 教学课堂（只读）',
    // 越界中止是硬失败：不能因为"读到了几门课"就报 complete
    status: aborted ? 'aborted' : failedCount ? (okCount ? 'partial' : 'failed') : unparsed > 0 ? 'partial' : 'complete',
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    jump_chain: state.chain,
    aborted: aborted
      ? {
          status: aborted.status,
          url: aborted.url,
          from: aborted.from,
          at: aborted.at,
          detail: aborted.detail,
        }
      : null,
    summary: {
      courses: courses.length,
      read: records.length,
      ok: okCount,
      failed: failedCount,
      records_total: records.reduce((sum, item) => sum + (item.records_total || 0), 0),
      source_records_total: records.reduce((sum, item) => sum + (item.source_records_total || 0), 0),
      submitted: records.reduce((sum, item) => sum + (item.submitted_count || 0), 0),
      unfinished: records.reduce((sum, item) => sum + (item.unfinished_count || 0), 0),
      unknown: records.reduce((sum, item) => sum + (item.unknown_count || 0), 0),
      unparsed,
      informational,
      tasks: allTasks.length,
    },
    notes: [
      ...(unparsed > 0
        ? [`有 ${unparsed} 条记录只计入了列表总数、没能解析出具体内容，已计入不确定，请人工核对对应课程页面。`]
        : []),
      ...(informational > 0
        ? [`另有 ${informational} 条讨论区信息型帖子，没有截止时间或强制回复要求，未计入任务和不确定项。`]
        : []),
      ...(aborted
        ? [
            `读取在「${aborted.detail}」处中止，已记录脱敏 URL，未继续导航；剩余课程未读取，不代表没有任务。`,
          ]
        : []),
    ],
    courses: records,
    tasks: allTasks,
  };
  writeJson(tasksPath, output);
  JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  JSON.parse(fs.readFileSync(coursesPath, 'utf8'));

  emitStep(writer, `eCourse：读取完成，共 ${courses.length} 门课程，${unparsed + records.reduce((sum, item) => sum + (item.unknown_count || 0), 0)} 条记录待确认。`, {
    courses: courses.length,
    tasks: allTasks.length,
    unparsed,
  });
  return {
    partial: Boolean(aborted) || failedCount > 0 || unparsed > 0,
    // 越界中止时直接把状态报给会话网关，避免外层误判成 READ_OK
    status: aborted ? 'READ_FAILED' : failedCount > 0 || unparsed > 0 ? 'READ_PARTIAL' : 'READ_OK',
    aborted: aborted ? aborted.status : null,
    courses: courses.length,
    ok: okCount,
    failed: failedCount,
    tasks: allTasks.length,
  };
}

// ---------- 入口 ----------

/**
 * 离线自检（不联网、不打开浏览器）：
 * 验证"顶层越界判定"和几条分类规则，改解析逻辑后先跑它。
 */
function selfCheck() {
  const cases = [
    ['http://xsjw2018.jw.scut.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html', 'ECOURSE_TOP_REDIRECTED_TO_JW'],
    ['http://jw.scut.edu.cn/jwglxt/xtgl/index_initMenu.html', 'ECOURSE_TOP_REDIRECTED_TO_JW'],
    ['https://ecourse.scut.edu.cn/web/gt/1/index.html', null],
    ['https://sso.scut.edu.cn/cas/login?service=x', null],
    ['about:blank', null],
    ['https://my.scut.edu.cn/up/upgrade', 'ECOURSE_TOP_LEFT_PLATFORM'],
    ['https://www.yuketang.cn/lesson', 'ECOURSE_TOP_LEFT_PLATFORM'],
  ];
  let failed = 0;
  for (const [url, expected] of cases) {
    const got = checkTopFrame(url);
    const actual = got ? got.status : null;
    if (actual !== expected) {
      failed += 1;
      console.log(`FAIL checkTopFrame(${url}) => ${actual}，期望 ${expected}`);
    }
  }
  const statusCases = [
    ['已完成 2026-10-20 23:59', 'finished'],
    ['未提交 2026-10-20 23:59', 'unfinished'],
    ['已过期 2026-10-20 23:59', 'unknown'],
  ];
  for (const [text, expected] of statusCases) {
    const actual = classifyStatus(text);
    if (actual !== expected) {
      failed += 1;
      console.log(`FAIL classifyStatus(${text}) => ${actual}，期望 ${expected}`);
    }
  }
  const discussionCases = [
    {
      name: '普通讨论帖不是强制任务',
      input: '记录总数：1 浏览：2 回复：0 发布于 2026-09-01',
      expected: false,
    },
    {
      name: '要求跟帖计分是强制任务',
      input: '请在 10 月 30 日前回复本讨论，回复计入平时分',
      expected: true,
    },
    {
      name: '必须跟帖是强制任务',
      input: '本讨论必须跟帖，作为课堂参与依据',
      expected: true,
    },
  ];
  for (const item of discussionCases) {
    const actual = discussionRequiresAction(item.input);
    if (actual !== item.expected) {
      failed += 1;
      console.log(`FAIL ${item.name} => ${actual}，期望 ${item.expected}`);
    }
  }
  const gapCases = [
    {
      name: '普通讨论帖计入信息项',
      input: { sectionKey: 'discussion', declared: 1, rowCount: 0, discussionEvidence: { found: true, action_required: false } },
      expected: { informational_count: 1, unparsed_count: 0 },
    },
    {
      name: '强制回复讨论仍计为未解析',
      input: { sectionKey: 'discussion', declared: 1, rowCount: 0, discussionEvidence: { found: true, action_required: true } },
      expected: { informational_count: 0, unparsed_count: 1 },
    },
    {
      name: '作业区差额仍计为未解析',
      input: { sectionKey: 'homework', declared: 3, rowCount: 2, discussionEvidence: null },
      expected: { informational_count: 0, unparsed_count: 1 },
    },
  ];
  for (const item of gapCases) {
    const actual = classifySectionGap(item.input);
    if (
      actual.informational_count !== item.expected.informational_count ||
      actual.unparsed_count !== item.expected.unparsed_count
    ) {
      failed += 1;
      console.log(`FAIL ${item.name} => ${JSON.stringify(actual)}，期望 ${JSON.stringify(item.expected)}`);
    }
  }
  console.log(failed ? `SELF_CHECK_FAILED:${failed}` : 'SELF_CHECK_PASS');
  return failed === 0;
}

async function main() {
  if (process.argv.includes('--self-check')) {
    const ok = selfCheck();
    process.exitCode = ok ? 0 : 1;
    return;
  }
  const selection = readProfileSelection(process.argv);
  const outputDir = path.resolve(argValue('--output-dir', defaultOutputDir()));
  const loginTimeoutMs = numberArg('--login-timeout-seconds', 900) * 1000;
  const skipHiddenCheck = process.argv.includes('--skip-hidden-check');
  const surfaceSeconds = numberArg('--surface-timeout-seconds', Math.round(LOGIN_SURFACE_TIMEOUT_MS / 1000));
  const state = {
    chain: [],
    json: [],
    writer: null,
    selfEmbedLoop: false,
    lastSelfCount: 0,
    // 入口导航只允许发生一次：网关已经把窗口带到 eCourse，脚本不再重复 goto
    entryNavigated: false,
    // 登录界面最长等待（默认 12 秒），超时后按"仍在加载"继续，不追加第二个固定等待
    surfaceTimeoutMs: surfaceSeconds * 1000,
    loginSurface: null,
    // 顶层越界后写在这里，后续所有导航与解析都以它为准，不再尝试恢复
    aborted: null,
  };

  const authorization = checkAuthorization('ecourse');
  if (!authorization.authorized) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`PLATFORM_NOT_AUTHORIZED:ecourse ${authorization.reason}`);
    return;
  }

  const result = await withBrowserSession({
    platform: 'ecourse',
    loginUrl: ROOT_URL,
    outputDir,
    profileId: selection.profileId,
    profileDir: selection.profileDir,
    loginTimeoutMs,
    // 初始化前已经跑过 session-probe：明确未登录时不再重复"隐藏 Chrome 检查一遍再关掉"
    skipHiddenCheck,
    openingNotice: ECOURSE_NOTICE.opening,
    isAuthenticated: async (args) => inspectEcourse(args.page, { initial: args.initial, state, noticeApi: args.noticeApi }),
    onBrowserStart: async ({ page, writer }) => {
      state.writer = writer;
      attachMonitor(page, state);
    },
    onAuthenticated: async ({ page, writer, noticeApi }) => readEcourse({ page, state, writer, outputDir, noticeApi }),
  });

  writeJson(path.join(outputDir, 'ecourse-session-summary.json'), { ...result, jump_chain: state.chain });
  console.log(`ECOURSE_PULL_RESULT:${result.status}`);
  if (result.status === 'AUTH_REQUIRED' || result.status === 'AUTH_TIMEOUT') process.exitCode = 0;
  else if (result.status !== 'READ_OK' && result.status !== 'READ_PARTIAL') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`ECOURSE_PULL_FAILED:${firstLine(error)}`);
  process.exit(1);
});
