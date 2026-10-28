'use strict';

/**
 * eCourse 登录与读取的**等待逻辑**（全部纯函数 / 可离线测试，不联网、不开浏览器）
 *
 * 之前慢的三个根因，都落在这一个文件里：
 * 1. 重复导航：进 eCourse 的整个过程里，只要页面已经在 eCourse / SSO 域内，就不再 goto；
 * 2. 固定 8 秒 + 8 秒：改成事件驱动轮询，二维码 / 表单 / iframe / 登录文字任一出现就立刻返回，
 *    首次最多 10—12 秒，且**不再追加第二个固定等待**；
 * 3. 白屏：等待期间每整秒输出一次"已等待 X 秒"，用户永远看得到进度。
 *
 * 纪律：等待期的探测函数必须只读——不导航、不刷新、不 newPage、不点击。
 * 用户可能正在扫二维码，任何一次跳转都可能在那一刻把二维码刷掉。
 */

// 首次进入登录页的最长等待：网再慢也不能无限等，超时后按"仍在加载"继续（交给外层登录等待循环）
const LOGIN_SURFACE_TIMEOUT_MS = 12000;
// 250—500ms 轮询：够快到"二维码一出现就走"，也不会把 CPU 打满
const LOGIN_SURFACE_POLL_MS = 300;
// 登录成功后的课程列表稳定窗口：出现课程信号就立刻走，不傻等
const COURSE_SURFACE_TIMEOUT_MS = 5000;
const COURSE_SURFACE_POLL_MS = 300;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * 是否需要发起**初始**导航。
 * 只有页面还是 about:blank，或者还没进入目标域（eCourse / SSO）时才导航。
 *
 * @param {string} url              当前 page.url()
 * @param {RegExp[]} allowedPatterns 允许停留的域（ecourse、sso）
 */
function needsInitialNavigation(url, allowedPatterns = []) {
  const value = String(url || '');
  if (!value || value === 'about:blank') return true;
  return !allowedPatterns.some((pattern) => pattern && pattern.test(value));
}

/**
 * 决定本次是否真的要 goto。
 *
 * 除了"是否已在目标域"，还要挡住第二种重复：同一个可见登录流程里已经打开过一次 eCourse 首页
 * （网关负责开浏览器并落地到入口，脚本不应该再打开一次）。
 *
 * @returns {{navigate: boolean, reason: string}}
 */
function planEntryNavigation({ url, alreadyNavigated = false, allowedPatterns = [] } = {}) {
  if (alreadyNavigated) {
    return { navigate: false, reason: '本次登录流程已经导航过入口，不重复打开' };
  }
  if (!needsInitialNavigation(url, allowedPatterns)) {
    return { navigate: false, reason: '当前页已在 eCourse / 统一认证域内，无需重复导航' };
  }
  return { navigate: true, reason: '页面尚未进入目标域（仍是空白页），发起一次入口导航' };
}

/**
 * 登录界面是否"已经出现"。
 * 任一信号命中即算就绪：二维码、登录表单、iframe、登录文字、课程菜单。
 *
 * 注意区分 kind：只有真的识别到二维码时才可以说"扫码"，
 * 别的信号只能说"请登录"，不能提前要求用户扫码。
 */
function detectLoginSurface(snapshot = {}) {
  const signals = [];
  const {
    qr_count = 0,
    password_input = 0,
    text_input = 0,
    iframe_total = 0,
    login_text = false,
    course_menu = false,
    main_text_len = 0,
  } = snapshot;

  if (course_menu) signals.push('course_menu');
  if (qr_count > 0) signals.push('qr');
  if (password_input > 0) signals.push('password_input');
  if (text_input > 0 && login_text) signals.push('login_form');
  if (Number(iframe_total) > 0) signals.push('iframe');
  if (login_text) signals.push('login_text');
  if (Number(main_text_len) > 0) signals.push('any_text');

  let kind = null;
  if (course_menu) kind = 'menu';
  else if (qr_count > 0) kind = 'qr';
  else if (password_input > 0 || (text_input > 0 && login_text)) kind = 'form';
  else if (Number(iframe_total) > 0 && login_text) kind = 'iframe_login';
  else if (login_text) kind = 'login_text';
  else if (Number(main_text_len) > 0) kind = 'page_ready';

  return { ready: signals.length > 0, kind, signals };
}

/**
 * 事件驱动轮询：登录界面一出现就返回，绝不补足剩下的固定秒数。
 *
 * @param {object}   options.probe      只读探测函数，返回一份快照
 * @param {function} options.emit       可读进度输出 (message, extra)
 * @param {function} options.sleep      (ms) => Promise
 * @param {number}   options.timeoutMs  最长等待（默认 12 秒）
 * @param {number}   options.intervalMs 轮询间隔（默认 300ms）
 * @param {function} options.detect     判定函数（默认 detectLoginSurface）
 * @param {string}   options.label      平台名，用于文案
 */
async function waitForSurface(options = {}) {
  const {
    probe,
    emit = () => {},
    sleep = defaultSleep,
    timeoutMs = LOGIN_SURFACE_TIMEOUT_MS,
    intervalMs = LOGIN_SURFACE_POLL_MS,
    detect = detectLoginSurface,
    label = 'eCourse',
    now = () => Date.now(),
  } = options;

  if (typeof probe !== 'function') throw new Error('waitForSurface: probe 必填');

  const started = now();
  let polls = 0;
  let lastSecond = -1;
  let lastSnapshot = null;
  const trace = [];

  for (;;) {
    const elapsed = now() - started;
    const second = Math.floor(elapsed / 1000);
    if (second !== lastSecond) {
      lastSecond = second;
      if (second > 0) {
        emit(`${label}：正在加载登录方式，已等待 ${second} 秒……`, { waited_seconds: second });
      }
    }

    let snapshot;
    try {
      snapshot = await probe();
    } catch {
      snapshot = null;
    }
    polls += 1;
    if (snapshot) lastSnapshot = snapshot;
    trace.push({ at: elapsed, snapshot: snapshot || null });

    if (snapshot) {
      const verdict = detect(snapshot);
      if (verdict && verdict.ready) {
        return {
          ready: true,
          kind: verdict.kind,
          signals: verdict.signals,
          waited_ms: elapsed,
          polls,
          snapshot,
          trace,
        };
      }
    }

    if (elapsed >= timeoutMs) {
      return {
        ready: false,
        kind: null,
        signals: [],
        waited_ms: elapsed,
        polls,
        timed_out: true,
        snapshot: lastSnapshot,
        trace,
      };
    }
    await sleep(Math.min(intervalMs, Math.max(1, timeoutMs - elapsed)));
  }
}

/**
 * 登录成功后的课程列表等待：抓到课程信号（DOM 锚点或 JSON）就立刻返回。
 * 同样是事件驱动，不再盲等 5 秒。
 */
async function waitForCourseSurface(options = {}) {
  const {
    probe,
    emit = () => {},
    sleep = defaultSleep,
    timeoutMs = COURSE_SURFACE_TIMEOUT_MS,
    intervalMs = COURSE_SURFACE_POLL_MS,
    now = () => Date.now(),
  } = options;

  if (typeof probe !== 'function') throw new Error('waitForCourseSurface: probe 必填');

  const started = now();
  let polls = 0;
  let seen = null;

  for (;;) {
    const elapsed = now() - started;
    let snapshot;
    try {
      snapshot = await probe();
    } catch {
      snapshot = null;
    }
    polls += 1;
    if (snapshot && (snapshot.anchor_count > 0 || snapshot.json_count > 0 || snapshot.frame_count > 0)) {
      seen = snapshot;
      return { ready: true, waited_ms: elapsed, polls, snapshot: seen };
    }
    if (snapshot) seen = snapshot;
    if (elapsed >= timeoutMs) {
      return { ready: false, waited_ms: elapsed, polls, timed_out: true, snapshot: seen };
    }
    await sleep(Math.min(intervalMs, Math.max(1, timeoutMs - elapsed)));
  }
}

/**
 * 登录界面出现后的可读文案。
 * kind=qr 才提"扫码"；其余一律说"请登录"，不误导用户去找不存在的二维码。
 */
function surfaceMessage(kind, label = 'eCourse') {
  switch (kind) {
    case 'qr':
      return `${label}：登录页已就绪，请在当前窗口使用微信扫码。`;
    case 'form':
      return `${label}：登录页已就绪，请在当前窗口完成登录（本机不代填账号、密码、验证码）。`;
    case 'iframe_login':
      return `${label}：登录页已就绪，请在当前窗口完成登录。`;
    case 'login_text':
      return `${label}：登录页已就绪，请在当前窗口完成登录。`;
    case 'page_ready':
      return `${label}：页面已加载，正在确认是否需要登录。`;
    case 'menu':
      return `${label}：已进入课程页，登录态有效。`;
    default:
      return `${label}：仍在加载登录页。`;
  }
}

module.exports = {
  COURSE_SURFACE_POLL_MS,
  COURSE_SURFACE_TIMEOUT_MS,
  LOGIN_SURFACE_POLL_MS,
  LOGIN_SURFACE_TIMEOUT_MS,
  defaultSleep,
  detectLoginSurface,
  needsInitialNavigation,
  planEntryNavigation,
  surfaceMessage,
  waitForCourseSurface,
  waitForSurface,
};
