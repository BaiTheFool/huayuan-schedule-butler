'use strict';

/**
 * eCourse 白屏 / 等待反馈回归（**离线**：不联网、不开浏览器、不碰真实账号）
 *
 * 证明四件事改掉了：
 * 1. 页面不再重复导航（planEntryNavigation / needsEntryNavigation）
 * 2. 固定 8 秒 + 8 秒换成事件驱动轮询（waitForSurface 一命中就返回，补足秒数的事没有了）
 * 3. 登录界面没出现时持续输出"已等待 N 秒"心跳，而不是白屏干等
 * 4. 顶部提示条经得起页面重定向（addInitScript 每次导航 reinstall）
 *
 * 用法：
 *   node golden-path/check-ecourse-ux.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'skills', 'huayuan-browser-session', 'scripts');

const {
  detectLoginSurface,
  needsInitialNavigation,
  planEntryNavigation,
  surfaceMessage,
  waitForCourseSurface,
  waitForSurface,
  LOGIN_SURFACE_TIMEOUT_MS,
} = require(path.join(SCRIPTS, 'ecourse-wait.js'));
const {
  buildNoticeInstaller,
  ECOURSE_NOTICE,
  NOTICE_ID,
  TEXT_VARIABLE,
} = require(path.join(SCRIPTS, 'session-notice.js'));
const { needsEntryNavigation } = require(path.join(SCRIPTS, 'session-gateway.js'));
const { streamScript } = require(path.join(SCRIPTS, 'onboarding.js'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function group(title) {
  console.log(`\n${title}`);
}

const ECOURSE_PATTERN = /ecourse\.scut\.edu\.cn/i;
const SSO_PATTERN = /sso\.scut\.edu\.cn/i;
const ALLOWED = [ECOURSE_PATTERN, SSO_PATTERN];

async function runAll() {
// ---------- 1. 不再重复导航 ----------

group('[1] eCourse 入口只导航一次');
{
  check('空白页需要导航', planEntryNavigation({ url: 'about:blank', allowedPatterns: ALLOWED }).navigate === true);
  const stay = planEntryNavigation({ url: 'https://ecourse.scut.edu.cn/web/gt/1/index.html', allowedPatterns: ALLOWED });
  check('已在 eCourse 域内不再导航', stay.navigate === false, stay.reason);
  const ssoStay = planEntryNavigation({ url: 'https://sso.scut.edu.cn/cas/login?service=x', allowedPatterns: ALLOWED });
  check('已在统一认证页不再导航（二维码不能被刷掉）', ssoStay.navigate === false, ssoStay.reason);
  const twice = planEntryNavigation({ url: 'about:blank', alreadyNavigated: true, allowedPatterns: ALLOWED });
  check('同一次登录流程里不会第二次打开首页', twice.navigate === false, twice.reason);
  check(
    'needsInitialNavigation 空白页为真、目标域为假',
    needsInitialNavigation('about:blank', ALLOWED) === true &&
      needsInitialNavigation('https://ecourse.scut.edu.cn/', ALLOWED) === false
  );
  check(
    '网关层同源落点不重复 goto',
    needsEntryNavigation('https://ecourse.scut.edu.cn/web/gt/1/index.html', 'https://ecourse.scut.edu.cn/') === false &&
      needsEntryNavigation('about:blank', 'https://ecourse.scut.edu.cn/') === true
  );
}

// ---------- 2. 固定等待被替换成事件驱动 ----------

// 假时钟：不真睡觉，只推进虚拟时间，保证测试秒级返回
function virtualClock({ stepMs = 300 } = {}) {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    stepMs,
  };
}

group('[2] 二维码一出现立刻返回，不补足固定秒数');
{
  const clock = virtualClock();
  let polls = 0;
  const emitted = [];
  const surface = await waitForSurface({
    probe: () => {
      polls += 1;
      // 第 3 次探测（约 900ms）二维码出现
      return polls >= 3
        ? { qr_count: 1, password_input: 0, text_input: 0, iframe_total: 1, login_text: true, main_text_len: 40 }
        : { qr_count: 0, password_input: 0, text_input: 0, iframe_total: 0, login_text: false, main_text_len: 0 };
    },
    emit: (message) => emitted.push(message),
    sleep: clock.sleep,
    now: clock.now,
    timeoutMs: LOGIN_SURFACE_TIMEOUT_MS,
    intervalMs: 300,
  });
  check('二维码出现即判定就绪', surface.ready === true && surface.kind === 'qr', `${surface.kind}`);
  check('没有等待满 12 秒预算', surface.waited_ms < LOGIN_SURFACE_TIMEOUT_MS, `实际等待 ${surface.waited_ms}ms / 预算 ${LOGIN_SURFACE_TIMEOUT_MS}ms`);
  check('命中当次就停止轮询', surface.polls === 3, `polls=${surface.polls}`);
  check(
    '二维码就绪才说扫码',
    /请在当前窗口使用微信扫码/.test(surfaceMessage(surface.kind)),
    surfaceMessage(surface.kind)
  );
}

group('[3] 登录页未出现时持续输出心跳（不白屏干等）');
{
  const clock = virtualClock();
  const emitted = [];
  const surface = await waitForSurface({
    probe: () => ({ qr_count: 0, password_input: 0, text_input: 0, iframe_total: 0, login_text: false, main_text_len: 0 }),
    emit: (message) => emitted.push(message),
    sleep: clock.sleep,
    now: clock.now,
    timeoutMs: 5000,
    intervalMs: 300,
  });
  const waitingLines = emitted.filter((line) => /已等待 \d+ 秒/.test(line));
  check('超时后如实判定为未出现登录界面', surface.ready === false && surface.timed_out === true);
  check('等待期间每秒都有可读进度', waitingLines.length >= 3, `${waitingLines.length} 行，例如：${waitingLines[1] || '无'}`);
  check('进度文案是"正在加载登录方式"', waitingLines.every((line) => /正在加载登录方式，已等待/.test(line)));
  check(
    '没识别到二维码时不提前说"请扫码登录"',
    emitted.every((line) => !/微信扫码/.test(line)),
    '等待期无扫码字样'
  );
}

group('[4] 登录成功后立即进入读取');
{
  const clock = virtualClock();
  let polls = 0;
  const ready = await waitForCourseSurface({
    probe: () => {
      polls += 1;
      return { anchor_count: 12, json_count: 3, frame_count: 2 };
    },
    sleep: clock.sleep,
    now: clock.now,
    timeoutMs: 5000,
    intervalMs: 300,
  });
  check('第一次探测到课程信号就走（0 毫秒额外等待）', ready.ready === true && ready.waited_ms === 0 && polls === 1, `waited=${ready.waited_ms}ms polls=${polls}`);

  const menu = surfaceMessage('menu');
  check('已登录形态直接说无需登录', /登录态有效/.test(menu), menu);
  const form = surfaceMessage('form');
  check('只有表单时不提扫码，只说完成登录', !/扫码/.test(form) && /完成登录/.test(form), form);
}

group('[5] 源码里不再有固定 8 秒 / 第二个 8 秒');
{
  const ecourseSrc = fs.readFileSync(path.join(SCRIPTS, 'ecourse-pull.js'), 'utf8');
  check('ecourse-pull.js 没有 waitForTimeout(8000)', !/waitForTimeout\(8000\)/.test(ecourseSrc));
  const eightSecHits = (ecourseSrc.match(/waitForTimeout\(8\d{3}\)/g) || []).length;
  check('没有留下第二个固定 8 秒缓冲', eightSecHits === 0, `命中 ${eightSecHits} 处`);
  check('入口导航走 planEntryNavigation 守卫', /planEntryNavigation\(/.test(ecourseSrc));
  check('等待走 waitForSurface（事件驱动）', /waitForSurface\(\{/.test(ecourseSrc));
  const gatewaySrc = fs.readFileSync(path.join(SCRIPTS, 'session-gateway.js'), 'utf8');
  check('登录轮询间隔缩短到 1 秒以内', /loginPollMs = LOGIN_POLL_INTERVAL_MS/.test(gatewaySrc) && /LOGIN_POLL_INTERVAL_MS = 800/.test(gatewaySrc));
  check('网关可见分支不再无条件 goto', /needsEntryNavigation\(page\.url\(\), loginUrl\)/.test(gatewaySrc));
}

// ---------- 6. 顶部提示条经得起重定向 ----------

group('[6] 提示条在页面重定向后仍存在');
{
  // 极简假 DOM：够跑安装脚本，不需要浏览器
  function makeDoc() {
    const nodes = [];
    const listeners = {};
    const element = (tag) => ({
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      textContent: '',
      children: [],
      attributes: {},
      style: { cssText: '' },
      setAttribute(key, value) {
        this.attributes[key] = value;
      },
      appendChild(child) {
        this.children.push(child);
        nodes.push(child);
        return child;
      },
      remove() {
        const index = this.parent ? this.parent.children.indexOf(this) : -1;
        if (index >= 0) this.parent.children.splice(index, 1);
      },
    });
    const doc = {
      documentElement: element('html'),
      body: null,
      listeners,
      createElement: element,
      getElementById: (id) => nodes.find((node) => node.id === id && doc.documentElement.children.includes(node)) || null,
      addEventListener: (type, fn) => {
        (listeners[type] = listeners[type] || []).push(fn);
      },
    };
    return { doc, nodes, listeners };
  }

  const { doc, nodes, listeners } = makeDoc();
  const timers = [];
  const win = {
    addEventListener: (type, fn) => {
      (win.listeners = win.listeners || {}), ((win.listeners[type] = win.listeners[type] || []).push(fn));
    },
    listeners: {},
  };
  const setInterval = (fn) => {
    timers.push(fn);
    return timers.length;
  };

  const source = buildNoticeInstaller({ text: ECOURSE_NOTICE.opening, intervalMs: 250 });
  const runInstaller = new Function('window', 'document', 'setInterval', source);
  runInstaller(win, doc, setInterval);

  const bar = doc.getElementById(NOTICE_ID);
  check('document-start 阶段就把提示条挂上了', Boolean(bar), bar ? bar.textContent : '未创建');
  check('首帧文案是"正在打开 eCourse，并建立只读会话"', bar && /正在打开 eCourse，并建立只读会话/.test(bar.textContent));
  check('提示条不拦截点击（不遮挡二维码/输入框/登录按钮）', Boolean(bar) && /pointer-events:none/.test(bar.style.cssText));

  // 模拟一次站内跳转：整个文档被替换，安装脚本重新执行
  doc.documentElement.children = [];
  check('重定向后旧提示条确实消失了', doc.getElementById(NOTICE_ID) === null || !doc.documentElement.children.includes(bar));
  runInstaller(win, doc, setInterval);
  const restored = doc.getElementById(NOTICE_ID);
  check('重定向后提示条自动恢复', Boolean(restored), restored ? restored.textContent.slice(0, 20) : '未恢复');

  // DOMContentLoaded 事件再次补挂
  doc.documentElement.children = [];
  (listeners.DOMContentLoaded || []).forEach((fn) => fn());
  check('DOMContentLoaded 也会补挂提示条', Boolean(doc.getElementById(NOTICE_ID)));

  // 文案切换（等待扫码 → 正在读取）不需要重新导航
  win[TEXT_VARIABLE] = ECOURSE_NOTICE.reading;
  timers.forEach((fn) => fn());
  check('登录成功后文案即时切换为"正在读取"', /正在读取课程列表/.test(doc.getElementById(NOTICE_ID).textContent), doc.getElementById(NOTICE_ID).textContent);
  check('提示条 z-index 置顶且只有一个', nodes.filter((node) => node.id === NOTICE_ID).length >= 1 && /z-index:2147483647/.test(doc.getElementById(NOTICE_ID).style.cssText));
  check('iframe 内不再重复挂提示条', /window\.top !== window\.self/.test(source));
  check('跨页面导航保留最新提示文案', /sessionStorage/.test(source) && /STORAGE/.test(source));
}

// ---------- 7. 子进程流式输出与心跳 ----------

group('[7] spawn 流式输出（不再攒到最后一次性吐出）');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-ecourse-ux-'));
  const childPath = path.join(work, 'slow-child.js');
  fs.writeFileSync(
    childPath,
    [
      "console.log('第一行：立刻输出');",
      "setTimeout(() => { console.log('第二行：5 秒后'); process.exit(0); }, 5000);",
    ].join('\n'),
    'utf8'
  );

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push({ at: Date.now(), text: args.join(' ') });
    originalLog(...args);
  };
  const started = Date.now();
  const run = await streamScript(childPath, [], { heartbeatMs: 3000, label: '测试脚本' });
  console.log = originalLog;

  const first = logs.find((item) => /第一行/.test(item.text));
  check('第一行立刻出现在终端', Boolean(first) && first.at - started < 1500, first ? `${first.at - started}ms` : '未出现');
  check(
    '长时间无输出时打了心跳',
    logs.some((item) => /仍在运行，已 \d+ 秒没有新输出/.test(item.text)),
    (logs.find((item) => /仍在运行/.test(item.text)) || {}).text || '无心跳'
  );
  check('两条输出都完整收到', /第一行/.test(run.stdout) && /第二行/.test(run.stdout));
  check('退出码与 ok 保留', run.status === 0 && run.ok === true, `exit=${run.status}`);
  check('elapsed_ms 反映真实耗时', run.elapsed_ms >= 4500, `${run.elapsed_ms}ms`);
  fs.rmSync(work, { recursive: true, force: true });

  const failed = results.filter((item) => !item.ok);
  console.log(`\n========================================================`);
  console.log(`ECOURSE_UX:${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    for (const item of failed) console.log(`  FAIL ${item.name} — ${item.detail}`);
    process.exitCode = 1;
  }
}

runAll();
