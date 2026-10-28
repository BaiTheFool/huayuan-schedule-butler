'use strict';

/**
 * 可见会话提示条（只读，不改页面内容、不拦截点击）
 *
 * 要解决的问题：浏览器打开后到页面渲染出第一帧之间是一片白。
 * 用户不知道"是不是卡住了"，也不确定该做什么。
 *
 * 做法：
 * 1. 用 addInitScript 把安装脚本注入到**每次导航**的最开始（含 iframe），
 *    页面一有 <html> 就把提示条挂到顶部，不等 DOMContentLoaded，更不等首屏资源；
 * 2. 页面自己刷新 / CAS 回跳 / 站点内部跳转后，安装脚本会重新执行，提示条自动恢复；
 * 3. 文案存在 window.__HUAYUAN_NOTICE_TEXT__ 上，脚本轮询它，
 *    所以"等待扫码 → 正在读取"这种变化不需要重新导航。
 *
 * 不遮挡：position:fixed 贴顶、pointer-events:none，扫码区、输入框、登录按钮都能点。
 */

const NOTICE_ID = '__huayuan_session_notice';
const TEXT_VARIABLE = '__HUAYUAN_NOTICE_TEXT__';

// 贴顶、窄条、半透明阴影，绝不铺满屏幕，也不参与命中测试
const NOTICE_CSS = [
  'position:fixed',
  'top:0',
  'left:0',
  'right:0',
  'z-index:2147483647',
  'height:auto',
  'max-width:100%',
  'margin:0',
  'padding:8px 16px',
  'background:#0b5cad',
  'color:#fff',
  'font:14px/1.4 "Microsoft YaHei","PingFang SC",sans-serif',
  'text-align:left',
  'box-shadow:0 2px 10px rgba(0,0,0,.25)',
  // 关键：提示条自身不接收事件，页面上的二维码 / 输入框 / 按钮照常可用
  'pointer-events:none',
  'user-select:none',
].join(';');

// eCourse 各阶段的用户可见文案（登录仍然由本人完成，本机不代填任何信息）
const ECOURSE_NOTICE = {
  opening: '正在打开 eCourse，并建立只读会话，请稍候……',
  loading: '正在打开 eCourse，并建立只读会话，请稍候……',
  login_ready: 'eCourse 登录页已就绪，请在本窗口扫码登录（只读会话，不会代填任何信息）',
  reading: '登录成功，正在读取课程列表，请稍候……',
};

function escapeText(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, ' ');
}

/**
 * 生成一段自包含的安装脚本源码，交给 context.addInitScript 使用。
 *
 * 源码里只引用 window / document / setInterval 三个宿主对象，
 * 这样离线测试可以用假 DOM 直接执行它，不需要真的起浏览器。
 */
function buildNoticeInstaller({ text = '', intervalMs = 250 } = {}) {
  const interval = Number(intervalMs) > 0 ? Number(intervalMs) : 250;
  return `(function () {
  var TEXT = '${escapeText(text)}';
  var ID = '${NOTICE_ID}';
  var VAR = '${TEXT_VARIABLE}';
  var CSS = ${JSON.stringify(NOTICE_CSS)};
  function ensure() {
    try {
      var win = window;
      if (win[VAR] === undefined || win[VAR] === null) win[VAR] = TEXT;
      var root = document.documentElement || document.body;
      if (!root) return;
      var bar = document.getElementById(ID);
      if (!bar) {
        bar = document.createElement('div');
        bar.id = ID;
        bar.setAttribute('data-huayuan-notice', '1');
        bar.style.cssText = CSS;
        root.appendChild(bar);
      }
      var next = win[VAR] || TEXT;
      if (bar.textContent !== next) bar.textContent = next;
      return bar;
    } catch (e) { return null; }
  }
  ensure();
  try { document.addEventListener('DOMContentLoaded', ensure, true); } catch (e) {}
  try { window.addEventListener('load', ensure, true); } catch (e) {}
  try { setInterval(ensure, ${interval}); } catch (e) {}
})();`;
}

/**
 * 给整个浏览器上下文装上"每次导航都自动恢复"的提示条。
 * 返回 setText(page, text) —— 只改内存里的文案，不跳转、不刷新。
 */
async function installContextNotice(context, { text = '', intervalMs = 250 } = {}) {
  const source = buildNoticeInstaller({ text, intervalMs });
  try {
    await context.addInitScript(source);
  } catch {
    return { setText: async () => false, installed: false, source };
  }
  return {
    installed: true,
    source,
    setText: async (page, nextText) => updateNoticeText(page, nextText),
  };
}

/**
 * 把当前页（含已打开的页面）的提示文案改掉。
 * 提示条自己会轮询这个变量，所以即使页面正在跳转也不会丢。
 */
async function updateNoticeText(page, text) {
  if (!page) return false;
  try {
    await page.evaluate(
      ({ variable, value }) => {
        try {
          window[variable] = value;
        } catch {
          return false;
        }
        const bar = document.getElementById('__huayuan_session_notice');
        if (bar) bar.textContent = value;
        return true;
      },
      { variable: TEXT_VARIABLE, value: String(text == null ? '' : text) }
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ECOURSE_NOTICE,
  NOTICE_CSS,
  NOTICE_ID,
  TEXT_VARIABLE,
  buildNoticeInstaller,
  escapeText,
  installContextNotice,
  updateNoticeText,
};
