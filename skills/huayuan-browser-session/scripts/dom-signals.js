'use strict';

/**
 * 页面信号与交互的最小公共工具。
 *
 * 设计约束（来自实测教训）：
 * 1. 只在一个标签内操作：本模块不创建新页面，只使用调用方传入的 page。
 * 2. 空 src 的 iframe 是站点常见占位，不能当作"自嵌套 / 未登录 / 循环"证据。
 * 3. 语义点击只点"最小可点元素"，避免命中包裹整页的容器导致误跳转。
 */

const TARGET_ATTR = 'data-huayuan-target';
const CLICKABLE_SELECTOR = 'a,button,li,span,div,p,td,dt,label';

async function bodyText(page) {
  try {
    const text = await page.locator('body').innerText({ timeout: 5000 });
    return String(text || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

async function frameBodyText(frame) {
  try {
    const text = await frame.evaluate(() => (document.body ? document.body.innerText : ''));
    return String(text || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * iframe 统计：只统计显式非空 src 的 iframe。
 * 空串 / null / 仅 #  的 src 是占位，不计入 total_counted，也不参与自嵌套判定。
 */
async function iframeStats(page) {
  try {
    const result = await page.mainFrame().evaluate(() => {
      const here = location.href.split('#')[0];
      const frames = Array.from(document.querySelectorAll('iframe'));
      let counted = 0;
      let selfCount = 0;
      const srcs = [];
      for (const frame of frames) {
        const raw = frame.getAttribute('src');
        if (raw === null || raw.trim() === '' || raw.trim() === '#') continue;
        let resolved = null;
        try {
          resolved = new URL(raw, location.href).href.split('#')[0];
        } catch {
          resolved = null;
        }
        if (!resolved || resolved === 'about:blank') continue;
        counted += 1;
        srcs.push(resolved);
        const rect = frame.getBoundingClientRect();
        const visible = rect.width > 4 && rect.height > 4;
        if (resolved === here && visible) selfCount += 1;
      }
      return { declared: frames.length, counted, self_count: selfCount, srcs: srcs.slice(0, 20) };
    });
    return {
      ...result,
      empty_src: result.declared - result.counted,
      blocking: false,
      note: '空 src 的 iframe 不计入统计，也不作为阻断条件',
    };
  } catch {
    return { declared: 0, counted: 0, self_count: 0, empty_src: 0, srcs: [], blocking: false };
  }
}

/**
 * 跨 frame 找出「文本完全匹配且面积最小」的可点元素并打标记。
 * 返回 { frame, text, tag, href } 或 null。
 */
async function markMinimalByText(page, patternSource, maxLen = 24) {
  const frames = page.frames();
  for (const frame of frames) {
    let hit = null;
    try {
      hit = await frame.evaluate(
        ({ src, limit, attr, selector }) => {
          const re = new RegExp(src);
          const nodes = Array.from(document.querySelectorAll(selector));
          const candidates = [];
          for (const el of nodes) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length > limit || !re.test(text)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 4 || rect.height < 4) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            candidates.push({ text, area: rect.width * rect.height, el });
          }
          if (!candidates.length) return null;
          candidates.sort((a, b) => a.text.length - b.text.length || a.area - b.area);
          document.querySelectorAll(`[${attr}]`).forEach((node) => node.removeAttribute(attr));
          const target = candidates[0];
          target.el.setAttribute(attr, '1');
          return {
            text: target.text,
            tag: target.el.tagName,
            href: target.el.getAttribute('href') || null,
            candidates: candidates.length,
          };
        },
        { src: patternSource, limit: maxLen, attr: TARGET_ATTR, selector: CLICKABLE_SELECTOR }
      );
    } catch {
      hit = null;
    }
    if (hit) {
      try {
        if (frame.isDetached()) continue;
      } catch {
        continue;
      }
      return { frame, ...hit };
    }
  }
  return null;
}

async function clickMinimalByText(page, patternSource, options = {}) {
  const { maxLen = 24, waitAfterMs = 2200 } = options;
  const hit = await markMinimalByText(page, patternSource, maxLen);
  if (!hit) return { clicked: false, reason: '未找到匹配入口' };
  try {
    await hit.frame.click(`[${TARGET_ATTR}="1"]`, { timeout: 8000 });
    await page.waitForTimeout(waitAfterMs);
    return { clicked: true, text: hit.text, tag: hit.tag, href: hit.href, candidates: hit.candidates };
  } catch (error) {
    return {
      clicked: false,
      text: hit.text,
      tag: hit.tag,
      reason: String(error.message || error).split('\n')[0],
    };
  }
}

// 安全导航：失败不抛错，把结果交给调用方判定
async function safeGoto(page, url, options = {}) {
  const { waitUntil = 'domcontentloaded', timeout = 45000, settleMs = 2000 } = options;
  try {
    await page.goto(url, { waitUntil, timeout });
  } catch {
    // 超时也继续读当前页面，由调用方按 URL/正文判定
  }
  if (settleMs > 0) await page.waitForTimeout(settleMs).catch(() => {});
  return page.url();
}

async function activePage(context) {
  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  return pages[0] || null;
}

async function openPageCount(context) {
  return context.pages().filter((candidate) => !candidate.isClosed()).length;
}

module.exports = {
  TARGET_ATTR,
  activePage,
  bodyText,
  clickMinimalByText,
  frameBodyText,
  iframeStats,
  markMinimalByText,
  openPageCount,
  safeGoto,
};
