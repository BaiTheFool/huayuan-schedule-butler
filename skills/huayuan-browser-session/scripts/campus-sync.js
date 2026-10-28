'use strict';

/**
 * 校园平台正式同步：门户 + 教务（v4）
 *
 * 范围收敛：
 *   - 只做「门户 + 教务」这一条统一认证链路，建立 CAS 会话并确认课表入口可达
 *   - **不再读取 eCourse**：eCourse 有自己的登录体系与页面结构，只由 ecourse-pull.js 负责
 *     （两个脚本都碰 eCourse 会互相抢标签、互相判错登录态）
 *
 * 单标签纪律（实测教训）：
 *   1. 登录等待期零页面开销：只读当前页的 URL 与正文，绝不开探测页、绝不重复导航。
 *      每 2.5 秒开一个新标签，会触发 CAS 重定向风暴，甚至风控验证码。
 *   2. 读取阶段也只用同一个标签，按 门户 → 教务 顺序顺序导航，不并行、不多开。
 *   3. 空 src 的 iframe 是站点占位，不参与判定，也不阻断读取。
 *
 * 错误边界：
 *   - 只有「eCourse 顶层被跳到教务」才是错误，由 ecourse-pull.js 判定
 *   - 本脚本自身被跳到统一认证页只代表"还没登录"，不是错误
 *
 * 只读：门户首页可见区、教务首页与课表入口；不碰成绩、个人资料、任何提交按钮。
 */

const fs = require('fs');
const path = require('path');
const { withBrowserSession, pageAuthUrl } = require('./session-gateway');
const { PLATFORM_URLS, checkPlatform } = require('./platform-adapters');
const { HOST_PATTERNS } = require('./endpoints');
const { checkAuthorization, defaultOutputDir, displayPath, readProfileSelection } = require('./huayuan-paths');
const { bodyText, iframeStats, safeGoto } = require('./dom-signals');
const { safeTitle, sanitizeUrl } = require('./privacy');

// 只保留"页面结构信号"，不保留正文原文：门户页头会显示真实姓名，正文不能落盘
const STRUCTURE_HINTS = [
  '统一门户',
  '信息中心',
  '应用中心',
  '办事大厅',
  '个人课表',
  '课表查询',
  '选课',
  '考试',
  '通知',
  '二次认证',
  '统一身份认证',
];

function structureSignals(text) {
  const compact = String(text || '').replace(/\s+/g, '');
  return {
    text_length: compact.length,
    matched: STRUCTURE_HINTS.filter((keyword) => compact.includes(keyword)),
  };
}

// 只保留统一认证链路能覆盖的两个平台
const TARGETS = ['portal', 'jw'];
const CAS_ANCHOR = 'portal';
const PLATFORM_LABEL = { portal: '校园门户', jw: '教务系统' };

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name, fallback) {
  const parsed = Number(argValue(name, String(fallback)));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function md(file, lines) {
  fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function stageProgress(index, total, platform) {
  return `${index}/${total} ${PLATFORM_LABEL[platform] || platform}`;
}

/**
 * 等待期判定：只看当前这一个标签，不导航、不开新页。
 * 返回 authenticated=true 表示"当前页已经是登录后的业务页"，可以结束等待。
 */
async function inspectCurrentPage(page, { initial }) {
  if (initial) {
    await safeGoto(page, PLATFORM_URLS[CAS_ANCHOR], { settleMs: 2500 });
  }
  const url = page.url();
  const details = {
    final_url: sanitizeUrl(url),
    title: safeTitle(await page.title().catch(() => '')),
  };

  if (HOST_PATTERNS.sso.test(url) || pageAuthUrl(url)) {
    return { authenticated: false, reason: '等待本人完成统一认证', details };
  }

  if (HOST_PATTERNS.jw.test(url)) {
    const state = await checkPlatform('jw', { page, initial: false });
    return { ...state, details: { ...details, matched: 'jw' } };
  }

  if (HOST_PATTERNS.portal.test(url)) {
    const state = await checkPlatform('portal', { page, initial: false });
    return { ...state, details: { ...details, matched: 'portal' } };
  }

  const text = await bodyText(page);
  if (!text) {
    return { authenticated: false, reason: '当前页无正文（可能正在跳转）', details };
  }
  return { authenticated: false, reason: '当前页既不是门户也不是教务业务页', details };
}

// 单标签读取：顺序导航同一个 page
async function readPlatform(page, platform) {
  const entry = {
    platform,
    status: 'READ_FAILED',
    final_url: null,
    title: null,
    signals: null,
    iframes: null,
    authenticated: false,
    error: null,
    note: null,
  };
  try {
    await safeGoto(page, PLATFORM_URLS[platform], { settleMs: 2500 });
    entry.final_url = sanitizeUrl(page.url());
    entry.title = safeTitle(await page.title().catch(() => ''));
    const text = await bodyText(page);
    // 正文只折算成结构信号（含姓名等个人信息，不落盘原文）
    entry.signals = structureSignals(text);
    // 空 src iframe 只记录不阻断（正方教务常年有占位 iframe）
    entry.iframes = await iframeStats(page);
    const state = await checkPlatform(platform, { page, initial: false });
    entry.authenticated = Boolean(state.authenticated);
    entry.reason = state.reason || null;
    entry.status = state.authenticated ? 'READ_OK' : 'READ_FAILED';
    if (!state.authenticated) entry.error = state.reason || '登录态判定未通过';
    if (platform === 'jw' && state.authenticated) {
      entry.note = /个人课表|课表查询/.test(text)
        ? '课表入口可见，可继续运行 jw-timetable.js 读取详细课表'
        : '教务业务页已打开，但未在首页看到课表入口文本；详细课表由 jw-timetable.js 语义点击读取';
    }
  } catch (error) {
    entry.error = String(error.message || error).split('\n')[0];
  }
  return entry;
}

async function main() {
  const selection = readProfileSelection(process.argv);
  const outputDir = path.resolve(argValue('--output-dir', defaultOutputDir()));
  fs.mkdirSync(outputDir, { recursive: true });

  const targets = TARGETS.filter((platform) => checkAuthorization(platform).authorized);
  if (!targets.length) {
    console.log('PLATFORM_NOT_AUTHORIZED:campus 未授权门户或教务，请先运行 first-run.js');
    return;
  }
  if (!targets.includes(CAS_ANCHOR)) {
    console.log('PLATFORM_NOT_AUTHORIZED:portal 门户是统一认证锚点，必须授权门户才能同步教务');
    return;
  }

  const resultMd = path.join(outputDir, 'campus-sync-result.md');
  const resultJson = path.join(outputDir, 'campus-sync.json');
  const summaryPath = path.join(outputDir, 'campus-sync-session-summary.json');
  const loginTimeoutMs = numberArg('--login-timeout-seconds', 300) * 1000;
  const startedAt = new Date().toISOString();

  if (selection.config_migration) {
    console.log(`CONFIG_MIGRATED: ${selection.config_migration.changes.join(' | ')}`);
  }

  fs.writeFileSync(
    resultMd,
    [
      '# 校园平台同步（门户 + 教务）',
      `开始: ${startedAt}`,
      `读取范围: ${targets.map((item) => PLATFORM_LABEL[item]).join(' + ')}（eCourse 不在此列，由 ecourse-pull.js 单独负责）`,
      `登录等待上限: ${Math.round(loginTimeoutMs / 1000)} 秒`,
      '流程: 单标签无头检查 → 未登录才开一次可见窗口（零页面开销轮询）→ 同一标签顺序读取 → 关闭',
      '',
    ].join('\n'),
    'utf8'
  );
  json(resultJson, { status: 'started', started_at: startedAt, platforms: {}, targets });

  const result = await withBrowserSession({
    platform: 'campus',
    loginUrl: PLATFORM_URLS[CAS_ANCHOR],
    outputDir,
    profileId: selection.profileId,
    profileDir: selection.profileDir,
    loginTimeoutMs,
    // 用户在初始化里拒绝登录时，这一步也不能弹窗，只能如实报未登录
    allowVisibleLogin: !process.argv.includes('--no-visible-login'),
    isAuthenticated: async ({ page, initial, writer }) => {
      const state = await inspectCurrentPage(page, { initial });
      if (writer && !state.authenticated && state.details) {
        writer.emit('AUTH_PROGRESS', '登录进度（只看当前标签）', {
          stage: 'auth_wait',
          single_tab: true,
          ...state.details,
          reason: state.reason || null,
        });
      }
      return state;
    },
    onAuthenticated: async ({ page, writer }) => {
      const platforms = {};
      const record = (platform, entry, index) => {
        platforms[platform] = entry;
        json(resultJson, {
          status: 'running',
          started_at: startedAt,
          targets,
          platforms: { ...platforms },
        });
        md(resultMd, [
          `- ${entry.status} | ${entry.platform} | ${entry.final_url || ''}`,
          ...(entry.error ? [`  - 失败原因: ${entry.error}`] : []),
          ...(entry.note ? [`  - 说明: ${entry.note}`] : []),
        ]);
        if (writer) {
          writer.emit('CAMPUS_STAGE', `${stageProgress(index, targets.length, platform)} 读取完成：${entry.status}`, {
            stage: 'read',
            platform,
            progress: `${index}/${targets.length}`,
            status: entry.status,
          });
        }
      };

      for (let i = 0; i < targets.length; i += 1) {
        const platform = targets[i];
        if (writer) {
          writer.emit('CAMPUS_STAGE', `正在读取 ${stageProgress(i + 1, targets.length, platform)}`, {
            stage: 'read',
            platform,
            progress: `${i + 1}/${targets.length}`,
          });
        }
        record(platform, await readPlatform(page, platform), i + 1);
      }

      const okCount = Object.values(platforms).filter((item) => item.status === 'READ_OK').length;
      const jwEntry = platforms.jw;
      return {
        platforms,
        ok: okCount,
        partial: okCount < targets.length,
        next_steps:
          jwEntry && jwEntry.status !== 'READ_OK'
            ? ['教务未就绪：如门户已登录仍失败，请在统一认证中补做教务的二次认证后重跑本脚本']
            : ['运行 jw-timetable.js 读取教务个人课表', '运行 ecourse-pull.js 读取 eCourse 课程与未完成项'],
      };
    },
  });

  const platforms = { ...((result.data && result.data.platforms) || {}) };
  const okCount = Object.values(platforms).filter((item) => item.status === 'READ_OK').length;
  const finalStatus = okCount === targets.length ? 'READ_OK' : okCount > 0 ? 'READ_PARTIAL' : 'READ_FAILED';

  const summary = {
    platform: 'campus',
    scope: targets,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: finalStatus,
    browser_visibility: result.browser_visibility,
    login_waited_ms: result.login_waited_ms || 0,
    profile: result.profile,
    auth_phase: { status: result.status, login_waited_ms: result.login_waited_ms, auth: result.auth },
    data: { platforms, ok: okCount, partial: okCount < targets.length },
    next_steps: (result.data && result.data.next_steps) || [],
    error: result.error || null,
  };
  json(summaryPath, summary);
  // resultJson 在读取过程中是 running，收尾必须写终态，否则外部读到的永远是"还在跑"
  json(resultJson, {
    status: finalStatus,
    started_at: startedAt,
    finished_at: summary.finished_at,
    targets,
    platforms,
    ok: okCount,
    total: targets.length,
  });
  md(resultMd, [
    '',
    '## 汇总',
    `- 最终状态: ${finalStatus}`,
    `- 读取成功平台: ${okCount}/${targets.length}`,
    `- 登录阶段: ${result.status}（等待 ${Math.round((result.login_waited_ms || 0) / 1000)} 秒）`,
    `- 输出目录: ${displayPath(outputDir)}`,
    `- 结束: ${summary.finished_at}`,
  ]);
  console.log(`CAMPUS_SYNC_RESULT:${finalStatus}`);
  if (finalStatus === 'READ_OK' || finalStatus === 'READ_PARTIAL') return;
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`CAMPUS_SYNC_FAILED:${String(error.message || error).split('\n')[0]}`);
  process.exit(1);
});
