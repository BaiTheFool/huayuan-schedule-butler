'use strict';

/**
 * 校园可参与事项抓取（只访问公开网页，不需要学校登录）。
 *
 * 覆盖：
 * - 校团委：通知公告、文化育人、实践育人、创新育人
 * - 学生工作处：思教天地信息公告、心理中心信息公告
 * - 软件学院学生工作：活动预览、竞赛通知、科技竞赛、心理活动
 * - 就业在线：通知公告、事务通知、宣讲会
 *
 * 微信公众号是学生活动的重要补充，但搜狗微信检索存在验证码、跳转和时效限制，
 * 因此不把搜索结果当作稳定数据源。用户转发的公众号消息通过 knownItem 保留为
 * “用户提供，待核实”，并带上报名截止时间。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { argValue, defaultOutputDir, displayPath } = require('./huayuan-paths');
const { readPreferences } = require('./preferences');
const { collegeByInput } = require('./colleges');

const ARGV = process.argv;
const arg = (name, fallback = null) => argValue(ARGV, name, fallback);
const flag = (name) => ARGV.includes(name);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const POSITIVE =
  /大赛|竞赛|比赛|挑战杯|创新创业|活动|讲座|报告会|论坛|沙龙|工作坊|宣讲|招聘会|双选会|开放日|训练营|培训|报名|招募|征集|志愿|公益|社团|艺术节|文化节|心理|就业|职场/i;
const NEGATIVE =
  /获奖名单|获奖结果|比赛结果|评审结果|名单|拟录取|资格审查|工作安排|值班|放假|安全提醒|停课|考试安排|成绩|招标|采购|招聘启事|人员招聘|活动回顾|活动总结|顺利举行|圆满结束|会议纪要|教师|师资|导师|团干部|青马|教学报告|教学创新|科研教学|排课|学籍卡|学籍电子注册|教务管理|课堂教学竞赛|说课比赛|方案立项|立项申报/i;

const SOURCES = [
  { id: 'youth-notice', label: '校团委 · 通知公告', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/youth/tzgg/list.htm', scope: '校级' },
  { id: 'youth-culture', label: '校团委 · 文化育人', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/youth/11251/list.htm', scope: '校级' },
  { id: 'youth-practice', label: '校团委 · 实践育人', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/youth/11252/list.htm', scope: '校级' },
  { id: 'youth-innovation', label: '校团委 · 创新育人', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/youth/11253/list.htm', scope: '校级' },
  { id: 'student-thought', label: '学生工作处 · 思教信息公告', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/student/xxgg_9924/list.htm', scope: '校级' },
  { id: 'student-psych', label: '学生工作处 · 心理信息公告', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/student/xxgg_46254/list.htm', scope: '校级' },
  { id: 'sse-events', label: '软件学院 · 活动预览', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/sse/16843/list.htm', scope: '学院' },
  { id: 'sse-competition', label: '软件学院 · 竞赛通知', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/sse/16845/list.htm', scope: '学院' },
  { id: 'sse-tech', label: '软件学院 · 科技竞赛', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/sse/17495/list.htm', scope: '学院' },
  { id: 'sse-psych', label: '软件学院 · 心理活动', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/sse/16861/list.htm', scope: '学院' },
  { id: 'career-notice', label: '就业在线 · 通知公告', base: 'https://jyzx.scut.edu.cn', url: 'https://jyzx.scut.edu.cn/37779/list.htm', scope: '校级' },
  { id: 'career-affairs', label: '就业在线 · 事务通知', base: 'https://jyzx.scut.edu.cn', url: 'https://jyzx.scut.edu.cn/37785/list.htm', scope: '校级' },
  { id: 'career-events', label: '就业在线 · 宣讲会', base: 'https://jyzx.scut.edu.cn', url: 'https://jyzx.scut.edu.cn/37755/list.htm', scope: '校级' },
  { id: 'undergrad-notice', label: '本科生院 · 通知公告', base: 'https://jw.scut.edu.cn', url: 'https://jw.scut.edu.cn/zhinan/cms/article/v2/findInformNotice.do', scope: '校级', kind: 'jwc-json' },
  { id: 'graduate-notice', label: '研究生院 · 通知公告', base: 'https://www2.scut.edu.cn', url: 'https://www2.scut.edu.cn/graduate/14562/list.htm', scope: '校级' },
];

function decodeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'");
}

function stripHtml(html) {
  return decodeHtml(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeDate(raw, referenceYear) {
  const text = String(raw || '').trim();
  let match = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
  match = text.match(/(?:^|\D)(\d{1,2})[-/.月](\d{1,2})(?:日|\D|$)/);
  if (match) return `${referenceYear}-${pad(match[1])}-${pad(match[2])}`;
  return null;
}

function normalizeUrl(raw, base) {
  try {
    return new URL(decodeHtml(raw), base).href;
  } catch {
    return null;
  }
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.protocol = 'https:';
    parsed.hostname = parsed.hostname.replace(/^www\./i, '');
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url || '');
  }
}

function classify(title) {
  if (/挑战杯|大赛|竞赛|比赛|创新创业|科技赛/i.test(title)) return 'competition';
  if (/志愿|公益|支教|社会实践/i.test(title)) return 'volunteer';
  if (/招聘|就业|职场|宣讲|双选|实习/i.test(title)) return 'career';
  if (/讲座|报告会|论坛|沙龙|分享会/i.test(title)) return 'lecture';
  if (/培训|工作坊|训练营|课程/i.test(title)) return 'training';
  if (/心理|健康|安全/i.test(title)) return 'wellbeing';
  if (/社团|文化|艺术|晚会|展览|演出/i.test(title)) return 'culture';
  return 'activity';
}

function extractDeadline(text) {
  const source = String(text || '').replace(/\s+/g, ' ');
  const patterns = [
    /(?:报名|提交|申报|征集)?截止(?:时间|日期)?[^0-9]{0,12}(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/,
    /(?:请|须|务必)?于[^0-9]{0,12}(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)[^。；]{0,8}前/,
    /(?:报名|活动)时间[：:]?[^。；]{0,40}(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return normalizeDate(match[1], new Date().getFullYear());
  }
  const monthDay = source.match(
    /(?:请|须|务必)?于\s*(\d{1,2})月(\d{1,2})日\s*(?:前|之前)|(?:报名|提交|申报|征集)?截止(?:时间|日期)?[^0-9]{0,8}(\d{1,2})月(\d{1,2})日/
  );
  if (monthDay) {
    const month = monthDay[1] || monthDay[3];
    const day = monthDay[2] || monthDay[4];
    return `${new Date().getFullYear()}-${pad(month)}-${pad(day)}`;
  }
  return null;
}

function extractEventDate(text) {
  const source = String(text || '').slice(0, 2200);
  const contexts = [];
  const contextPattern = /.{0,12}(?:定于|活动时间|举办时间|培训时间|比赛时间|时间地点)[\s\S]{0,120}/g;
  let context;
  while ((context = contextPattern.exec(source))) contexts.push(context[0]);
  const head = contexts.length ? contexts.join(' ') : '';
  if (!head) return null;
  const dates = [];
  const rangePattern =
    /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?\s*(?:至|到|—|-)\s*(?:(\d{1,2})[-/.月])?(\d{1,2})(?:日)?/g;
  let range;
  while ((range = rangePattern.exec(head))) {
    const endMonth = range[4] || range[2];
    dates.push(`${range[1]}-${pad(endMonth)}-${pad(range[5])}`);
  }
  const pattern = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/g;
  let match;
  while ((match = pattern.exec(head))) {
    dates.push(`${match[1]}-${pad(match[2])}-${pad(match[3])}`);
  }
  const year =
    (source.match(/(20\d{2})年/) || [])[1] ||
    String(new Date().getFullYear());
  const shortPattern = /(?:时间|日期)[：:]?\s*(\d{1,2})月(\d{1,2})日/g;
  while ((match = shortPattern.exec(source))) {
    dates.push(`${year}-${pad(match[1])}-${pad(match[2])}`);
  }
  dates.sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function extractArticleText(html) {
  const source = String(html || '');
  const startMatch = source.match(/<(?:div|section)[^>]*class\s*=\s*["'][^"']*wp_articlecontent[^"']*["'][^>]*>/i);
  if (startMatch && startMatch.index !== undefined) {
    let body = source.slice(startMatch.index, startMatch.index + 30000);
    const close = body.search(/<\/div>\s*(?:<\/div>|<div[^>]*class=["'][^"']*(?:share|article|footer))/i);
    if (close >= 0) body = body.slice(0, close);
    return stripHtml(body);
  }
  return stripHtml(source);
}

function extractListItems(html, source, referenceYear) {
  const items = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html))) {
    const attrs = match[1] || '';
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = decodeHtml(hrefMatch[1]);
    const isArticle =
      /\/20\d{2}\/\d{4}\/c\d+a\d+\/page\.htm/i.test(href) ||
      /\/_redirect\?siteId=\d+&(?:amp;)?columnId=\d+&(?:amp;)?articleId=\d+/i.test(href);
    if (!isArticle) continue;
    const titleAttr = attrs.match(/\btitle\s*=\s*["']([^"']+)["']/i);
    const title = (titleAttr ? decodeHtml(titleAttr[1]) : stripHtml(match[2]))
      .replace(/\s+/g, ' ')
      .replace(/^\s*20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s*/, '')
      .replace(/\s*20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s*$/, '')
      .trim();
    if (!title || title.length < 4) continue;
    const tail = html.slice(match.index + match[0].length, match.index + match[0].length + 700);
    const dateRegion = `${match[0]} ${tail}`;
    const dateMatch = dateRegion.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/) || dateRegion.match(/(?:^|\D)(\d{1,2})-(\d{1,2})(?:\D|$)/);
    const publishedAt = dateMatch
      ? dateMatch.length === 4
        ? `${dateMatch[1]}-${pad(dateMatch[2])}-${pad(dateMatch[3])}`
        : `${referenceYear}-${pad(dateMatch[1])}-${pad(dateMatch[2])}`
      : null;
    const url = normalizeUrl(href, source.base);
    if (!url) continue;
    items.push({ title, url, published_at: publishedAt, source_id: source.id, source_label: source.label, scope: source.scope });
  }
  return items;
}

async function fetchDocument(url, timeoutMs, redirectDepth = 0) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  const finalUrl = response.url || url;
  const metaRefresh = text.match(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"']+)["']/i
  );
  if (metaRefresh && redirectDepth < 2) {
    return fetchDocument(new URL(decodeHtml(metaRefresh[1]), finalUrl).href, timeoutMs, redirectDepth + 1);
  }
  return { text, url: finalUrl };
}

async function fetchText(url, timeoutMs) {
  const document = await fetchDocument(url, timeoutMs);
  return document.text;
}

async function fetchJwcItems(source, timeoutMs, referenceYear) {
  const response = await fetch(source.url, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: 'https://jw.scut.edu.cn/zhinan/cms/toPosts.do',
    },
    body: new URLSearchParams({
      category: '0',
      tag: '0',
      pageNum: '1',
      pageSize: '30',
      keyword: '',
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  return (json.list || [])
    .filter((item) => item && item.id && item.title)
    .map((item) => {
      const published = normalizeDate(item.createTime, referenceYear);
      return {
        title: String(item.title).trim(),
        url: `https://jw.scut.edu.cn/zhinan/cms/article/view.do?type=posts&id=${encodeURIComponent(item.id)}`,
        published_at: published,
        source_id: source.id,
        source_label: source.label,
        scope: source.scope,
      };
    });
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function discoverCollegeSources(college, timeoutMs) {
  const home = await fetchDocument(college.url, timeoutMs);
  const anchors = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(home.text))) {
    const href = (match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href || href === '#' || /^javascript:/i.test(href)) continue;
    if (/\/page\.htm|_redirect\?/i.test(href)) continue;
    if (!/\/(?:list\d*|main)\.htm/i.test(href)) continue;
    const text = stripHtml(match[2]).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 40 || !/通知|公告|学生工作|团学|团委|活动|竞赛|讲座|报告|新闻动态|就业|创新|实践/.test(text)) continue;
    const url = normalizeUrl(href, home.url);
    if (!url || !/^https?:\/\/(?:[^/]+\.)?scut\.edu\.cn/i.test(url)) continue;
    let score = 0;
    if (/通知公告|通知/.test(text)) score += 5;
    if (/学生工作|团学|团委/.test(text)) score += 4;
    if (/活动|竞赛|讲座|报告/.test(text)) score += 3;
    if (/新闻动态/.test(text)) score += 1;
    anchors.push({ text, url, score });
  }
  const discovered = [];
  const seen = new Set([canonicalUrl(home.url)]);
  for (const item of anchors.sort((a, b) => b.score - a.score)) {
    const key = canonicalUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    discovered.push({
      id: `${college.id}-${discovered.length + 1}`,
      label: `${college.name} · ${item.text}`,
      base: new URL(item.url).origin,
      url: item.url,
      scope: '我的学院',
    });
    if (discovered.length >= 4) break;
  }
  return [
    {
      id: `${college.id}-home`,
      label: `${college.name} · 学院主页`,
      base: new URL(home.url).origin,
      url: home.url,
      scope: '我的学院',
    },
    ...discovered,
  ];
}

function makeId(title, url) {
  return crypto.createHash('sha1').update(`${title}|${url || ''}`).digest('hex').slice(0, 12);
}

function knownItems(nowDate) {
  const deadline = '2026-11-13';
  if (deadline < nowDate) return [];
  return [
    {
      id: 'known-ai-agent-competition-2026',
      title: '第一届校园AI智能体创新应用大赛',
      source_id: 'user-forwarded',
      source_label: '学院/班级通知（用户提供）',
      scope: '校级',
      type: 'competition',
      published_at: null,
      deadline,
      registration_start: '2026-10-14',
      event_at: '2026-11-28',
      summary: '中国联通广州公司与腾讯 WorkBuddy 联合举办，设 AI+教学科研、校园服务、生活创意和本校特色四大赛道；报名截止 11 月 13 日。',
      url: null,
      eligible: true,
      verification: '用户提供，报名前请向学院或主办方再次核实',
    },
  ];
}

function selfCheck() {
  const sample = `
    <li><a href="/youth/2026/1023/c25651a638393/page.htm">
      <div class="title"><span>关于组织学生报名参加第二届南粤乡村故事演讲大赛的通知</span></div>
      <div class="date">2026-10-23</div>
    </a></li>`;
  const items = extractListItems(sample, SOURCES[0], 2026);
  const checks = [
    ['extracts article', items.length === 1],
    ['extracts title', /南粤乡村故事演讲大赛/.test(items[0]?.title || '')],
    ['extracts date', items[0]?.published_at === '2026-10-23'],
    ['classifies competition', classify(items[0]?.title || '') === 'competition'],
    ['extracts deadline', extractDeadline('报名截止：2026年11月13日') === '2026-11-13'],
    ['extracts month-day deadline', extractDeadline('请于10月28日前提交报名表') === `${new Date().getFullYear()}-10-28`],
    ['uses range end as event date', extractEventDate('培训时间：2026年10月31日至11月3日') === '2026-11-03'],
    ['rejects result notice', NEGATIVE.test('关于公示大赛获奖名单的通知')],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  console.log(`ACTIVITY_SELF_CHECK:${checks.every((item) => item[1]) ? 'PASS' : 'FAIL'} ${checks.filter((item) => item[1]).length}/${checks.length}`);
  return checks.every((item) => item[1]);
}

async function main() {
  if (flag('--self-check')) {
    process.exitCode = selfCheck() ? 0 : 1;
    return;
  }
  if (flag('--list-colleges')) {
    const { COLLEGES } = require('./colleges');
    console.log(JSON.stringify(COLLEGES.map(({ name, url, wechat_hint }) => ({ name, url, wechat_hint })), null, 2));
    return;
  }
  const outputDir = path.resolve(arg('--output-dir', defaultOutputDir()));
  const days = Math.max(1, Number(arg('--days', 120)) || 120);
  const maxItems = Math.max(1, Number(arg('--max-items', 30)) || 30);
  const timeoutMs = Math.max(3000, Number(arg('--timeout-seconds', 15)) || 15) * 1000;
  const now = new Date();
  const today = localDate(now);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffText = localDate(cutoff);
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'activity-feed.json');
  const mdPath = path.join(outputDir, 'activity-feed.md');
  const staleHours = Number(arg('--if-stale-hours', null));
  if (Number.isFinite(staleHours) && staleHours > 0 && fs.existsSync(jsonPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const generatedAt = Date.parse(existing.generated_at);
      if (Number.isFinite(generatedAt) && Date.now() - generatedAt < staleHours * 3600 * 1000) {
        console.log(`ACTIVITY_FEED_FRESH:${displayPath(jsonPath)}`);
        console.log(`ACTIVITY_FEED_SUMMARY:items=${existing.item_count || 0} sources=${(existing.sources || []).length} fresh=1`);
        return existing;
      }
    } catch {
      // Corrupt cache: fall through and rebuild it.
    }
  }

  const savedPreferences = readPreferences();
  const collegeInput = arg('--college', savedPreferences.preferences?.college || null);
  const college = collegeByInput(collegeInput);
  const earlyWarnings = [];
  if (collegeInput && !college) earlyWarnings.push(`学院「${collegeInput}」不在内置目录中，本次只抓取校级来源`);
  if (!collegeInput) earlyWarnings.push('尚未选择学院/书院；初始化时选择后会自动追加该学院官网来源');
  const runtimeSources = [...SOURCES];
  if (college) {
    try {
      runtimeSources.push(...(await discoverCollegeSources(college, timeoutMs)));
    } catch (error) {
      earlyWarnings.push(`${college.name}官网栏目发现失败：${String(error.message || error).split('\n')[0]}`);
    }
  }

  const sourceResults = await Promise.all(
    runtimeSources.map(async (source) => {
      try {
        const raw =
          source.kind === 'jwc-json'
            ? await fetchJwcItems(source, timeoutMs, now.getFullYear())
            : extractListItems(await fetchText(source.url, timeoutMs), source, now.getFullYear());
        return { source, ok: true, status: raw.length ? 'READ_OK' : 'READ_EMPTY', raw };
      } catch (error) {
        return { source, ok: false, status: 'READ_FAILED', raw: [], error: String(error.message || error).split('\n')[0] };
      }
    })
  );

  const seen = new Set();
  let candidates = [];
  for (const result of sourceResults) {
    for (const item of result.raw) {
      const key = `${item.title.replace(/\s+/g, '')}|${item.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (item.published_at && item.published_at < cutoffText) continue;
      if (!POSITIVE.test(item.title) || NEGATIVE.test(item.title)) continue;
      candidates.push({
        ...item,
        type: classify(item.title),
        eligible: true,
        verification: '公开网页，报名前请以原通知为准',
      });
    }
  }
  candidates = candidates
    .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))
    .slice(0, Math.min(18, maxItems * 2));

  await mapLimit(candidates, 4, async (item) => {
    if (!item.url) return;
    try {
      const detail = await fetchText(item.url, timeoutMs);
      const text = extractArticleText(detail);
      item.deadline = extractDeadline(`${item.title} ${text}`);
      item.event_at = extractEventDate(text);
      const excerpt = text.lastIndexOf(item.title);
      item.summary = (excerpt >= 0 ? text.slice(excerpt + item.title.length) : text).slice(0, 260).trim();
    } catch {
      item.deadline = extractDeadline(item.title);
      item.summary = null;
    }
  });

  const known = knownItems(today);
  const all = [...known, ...candidates].filter((item) => {
    if (item.deadline && item.deadline < today) return false;
    if (!item.deadline && item.event_at && item.event_at < today) return false;
    return item.eligible !== false;
  });
  all.sort((a, b) => {
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return String(b.published_at || '').localeCompare(String(a.published_at || ''));
  });
  const items = all.slice(0, maxItems).map((item) => ({
    ...item,
    id: item.id || makeId(item.title, item.url),
    status: item.deadline ? 'open' : 'unknown',
  }));

  const sourceSummary = sourceResults.map((result) => ({
    id: result.source.id,
    label: result.source.label,
    url: result.source.url,
    scope: result.source.scope,
    status: result.status,
    items_seen: result.raw.length,
    error: result.error || null,
  }));
  const warnings = [
    ...earlyWarnings,
    ...sourceSummary.filter((item) => item.status === 'READ_FAILED').map((item) => `${item.label}：${item.error}`),
  ];
  if (!items.length) warnings.push('本次没有筛出仍在开放的可参与事项；请查看原始栏目或再次刷新');

  const doc = {
    source: '华南理工大学公开学生活动/竞赛/就业信息',
    generated_at: new Date().toISOString(),
    date: today,
    public_web_only: true,
    college: college ? { name: college.name, url: college.url, wechat_hint: college.wechat_hint } : null,
    note: '微信公众号和班级群属于补充渠道；未能公开稳定抓取的内容必须由用户提供并核实。',
    item_count: items.length,
    items,
    sources: sourceSummary,
    warnings,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2), 'utf8');
  const lines = [
    `# 可参与事项（${today}）`,
    '',
    '> 只读公开网页；报名前请打开原通知核实。',
    '',
  ];
  if (!items.length) lines.push('- 当前没有筛到仍开放的活动。');
  items.forEach((item, index) => {
    lines.push(`${index + 1}. **${item.title}**`);
    lines.push(`   - 来源：${item.source_label}`);
    lines.push(`   - 类型：${item.type}；截止：${item.deadline || '待确认'}`);
    if (item.url) lines.push(`   - 原文：${item.url}`);
    if (item.summary) lines.push(`   - 摘要：${item.summary}`);
  });
  if (warnings.length) {
    lines.push('', '## 读取提醒');
    warnings.forEach((warning) => lines.push(`- ${warning}`));
  }
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`ACTIVITY_FEED_JSON:${displayPath(jsonPath)}`);
  console.log(`ACTIVITY_FEED_MD:${displayPath(mdPath)}`);
  console.log(`ACTIVITY_FEED_SUMMARY:items=${items.length} sources=${sourceSummary.length} failed=${warnings.length}`);
  return doc;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ACTIVITY_FEED_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exitCode = 1;
  });
}

module.exports = {
  classify,
  extractArticleText,
  extractDeadline,
  extractEventDate,
  extractListItems,
  knownItems,
  selfCheck,
};
