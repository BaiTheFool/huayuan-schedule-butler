'use strict';

const { pageAuthUrl } = require('./session-gateway');
const { ENDPOINTS, HOST_PATTERNS, PLATFORM_URLS } = require('./endpoints');

async function bodyText(page) {
  return page
    .locator('body')
    .innerText({ timeout: 5000 })
    .then((text) => text.replace(/\s+/g, ' ').trim())
    .catch(() => '');
}

async function inspectRain(page) {
  let response = await fetchUserCourses(page);
  let headerRetry = false;
  // HTTP 200 + success=false 可能只是缺静态标识头（如 XTBZ IS REQUIRED），不是登录失效证据：
  // 收集页面自然请求的标识头后带带头重试一次，避免把接口拒绝误判为 AUTH_REQUIRED
  if (
    response.status === 200 &&
    response.body &&
    response.body.success === false
  ) {
    const harvested = await harvestRainHeaders(page);
    if (RAIN_STATIC_HEADERS.every((name) => harvested[name])) {
      response = await fetchUserCourses(page, harvested);
      headerRetry = true;
    }
  }
  const body = response.body;
  const successFalse = Boolean(body && body.success === false);
  const hasCourses = Boolean(
    body &&
      body.data &&
      Array.isArray(body.data.product_list) &&
      body.data.product_list.length > 0
  );
  let reason;
  if (successFalse) {
    // HTTP 200 + success=false 不是"无课程"，是接口拒绝，不得与空列表混淆
    reason = `接口 success=false: ${body.msg || body.error_code || '未知错误'}${
      headerRetry ? '（已尝试带静态标识头重试）' : ''
    }`;
  } else if (response.status === 200) {
    reason = hasCourses
      ? '个人课程列表可读'
      : '个人课程列表为空或结构异常';
  } else {
    reason = `user-courses HTTP ${response.status}`;
  }
  return {
    authenticated: response.status === 200 && !successFalse && hasCourses,
    reason,
    details: {
      course_count: hasCourses ? body.data.product_list.length : 0,
      http_status: response.status,
      success_false: successFalse,
      header_retry: headerRetry,
    },
    data: response,
  };
}

const RAIN_STATIC_HEADERS = [
  'terminal-type',
  'xtbz',
  'university-id',
  'platform-id',
  'x-client',
];

// 从页面自然请求中收集静态标识头（仅内存使用，不落盘、不含 Cookie/Token）
async function harvestRainHeaders(page, maxWaitMs = 8000) {
  const found = {};
  const onRequest = (request) => {
    try {
      const headers = request.headers();
      for (const name of RAIN_STATIC_HEADERS) {
        if (headers[name] && !found[name]) found[name] = headers[name];
      }
    } catch {
      // 忽略无法读取的请求
    }
  };
  page.on('request', onRequest);
  try {
    // 重新加载触发页面自然 API 请求（只读刷新，不点击任何元素）
    await page
      .reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {});
    const started = Date.now();
    while (
      Date.now() - started < maxWaitMs &&
      !RAIN_STATIC_HEADERS.every((name) => found[name])
    ) {
      await page.waitForTimeout(500);
    }
  } finally {
    page.off('request', onRequest);
  }
  return found;
}

async function fetchUserCourses(page, extraHeaders = {}) {
  const url = ENDPOINTS.rain_user_courses;
  try {
    return await page.evaluate(
      async ({ targetUrl, extra }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
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
      { targetUrl: url, extra: extraHeaders }
    );
  } catch (error) {
    return {
      status: 0,
      body: null,
      error: String(error.message || error).split('\n')[0],
    };
  }
}

async function checkPlatform(platform, { page, initial }) {
  const loginUrl = PLATFORM_URLS[platform];
  if (!loginUrl) throw new Error(`UNSUPPORTED_PLATFORM:${platform}`);

  if (initial) {
    await page.goto(loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  const finalUrl = page.url();
  if (pageAuthUrl(finalUrl) || HOST_PATTERNS.sso.test(finalUrl)) {
    return {
      authenticated: false,
      reason: '当前停留在统一认证或登录页',
      details: { final_url: finalUrl },
    };
  }

  if (platform === 'rain') {
    return inspectRain(page);
  }

  const text = await bodyText(page);
  if (platform === 'portal') {
    const authenticated =
      HOST_PATTERNS.portal.test(finalUrl) &&
      /信息中心|校园门户|待办|校历|统一身份认证/.test(text) &&
      !/密码登录|扫码登录|请登录/.test(text.slice(0, 500));
    return {
      authenticated,
      reason: authenticated ? '校园门户个人页可读' : '校园门户仍是登录页或正文不足',
      details: { final_url: finalUrl },
    };
  }

  if (platform === 'ecourse') {
    // 已验证的未登录形态：SPA 空壳页，正文仅"知识图谱 智能问答"（压缩后约 8 字）
    // 登录成功后的正文从未实测，不能只依赖"学习课程|教学课堂|我的课程"这类未验证词
    const compact = text.replace(/\s+/g, '');
    const shellLike = compact.length <= 12;
    const hasCourseSignal = /课程|课堂|作业|考试|公告|日历|讨论/.test(text);
    const onLoginPrompt = /扫码登录|请使用微信扫码|账号登录|请登录/.test(text.slice(0, 800));
    const authenticated =
      HOST_PATTERNS.ecourse.test(finalUrl) && !shellLike && hasCourseSignal && !onLoginPrompt;
    return {
      authenticated,
      reason: authenticated
        ? 'eCourse 课程区可读'
        : shellLike
          ? 'eCourse 仍停留在登录或空页面（SPA 空壳）'
          : onLoginPrompt
            ? 'eCourse 停留在登录提示页'
            : 'eCourse 页面无课程内容信号',
      details: { final_url: finalUrl, text_length: compact.length, shell_like: shellLike },
    };
  }

  if (platform === 'jw') {
    const authenticated =
      HOST_PATTERNS.jw.test(finalUrl) &&
      /jwglxt|xtgl\/index/i.test(finalUrl);
    return {
      authenticated,
      reason: authenticated ? '教务系统登录态可读' : '未进入教务系统业务页',
      details: { final_url: finalUrl },
    };
  }

  return { authenticated: false, reason: `平台 ${platform} 没有检查实现` };
}

async function checkAllPlatforms({ context }) {
  const results = {};
  for (const platform of Object.keys(PLATFORM_URLS)) {
    const page = await context.newPage();
    try {
      results[platform] = await checkPlatform(platform, { page, initial: true });
    } catch (error) {
      results[platform] = {
        authenticated: false,
        reason: String(error.message || error).split('\n')[0],
      };
    } finally {
      await page.close().catch(() => {});
    }
  }
  return results;
}

module.exports = {
  PLATFORM_URLS,
  checkPlatform,
  checkAllPlatforms,
  fetchUserCourses,
};
