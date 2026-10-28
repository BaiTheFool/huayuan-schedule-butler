'use strict';

/**
 * 教务系统 · 个人课表查询（华南理工大学本科生，只读）
 *
 * 落地顺序（按优先级，失败即降级，不猜数据）：
 *   1. HTTP 入口：把语义点击过程中捕获到的课表请求原样重放一次，拿干净响应
 *   2. 网络响应：解析页面自然请求返回的 JSON（最结构化，优先采信）
 *   3. DOM 兜底：解析已渲染的课表表格
 *
 * 硬约束：
 *   - 只在同一个标签内操作：不新开标签、不打开探测页抢前台
 *   - 空 src 的 iframe 不阻断：占位 iframe 不计入统计
 *   - 只有「eCourse 顶层跳到教务」才是错误；本脚本是教务自己的读取，不受此限
 *   - 只读：不点击选课、退课、成绩、个人资料等任何业务入口
 *
 * 用法：
 *   node jw-timetable.js
 *   node jw-timetable.js --profile-id acc-b --campus 大学城
 *   node jw-timetable.js --login-timeout-seconds 600 --output-dir ./out
 *   node jw-timetable.js --self-check        # 只跑解析器自检，不联网
 */

const fs = require('fs');
const path = require('path');
const { withBrowserSession, pageAuthUrl } = require('./session-gateway');
const { HOST_PATTERNS, PLATFORM_URLS, base } = require('./endpoints');
const {
  checkAuthorization,
  defaultOutputDir,
  displayPath,
  readConfig,
  readProfileSelection,
  resolvePlatformDir,
} = require('./huayuan-paths');
const { safeTitle, sanitizeExcerpt, sanitizeUrl } = require('./privacy');
const { bodyText, iframeStats, clickMinimalByText, openPageCount, safeGoto } = require('./dom-signals');
const {
  PERIOD_SOURCE,
  dayName,
  parsePeriodTokens,
  periodRange,
  referenceForOutput,
  resolveSchedule,
  scheduleOf,
} = require('./period-times');

const JW_BASE = base('jw');
const JW_HOST = HOST_PATTERNS.jw;
const MAX_BODY_CHARS = 400000;

// 教务「个人课表查询」的公认入口（正方系列常见路径），仅作为语义点击失败后的直连候选
const TIMETABLE_PATHS = [
  '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default',
  '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151',
  '/jwglxt/kbcx/xskbcx_cxXsKbIndex.html?gnmkdm=N2151',
];

const TIMETABLE_URL_HINT = /kbcx|xskbcx|cxXsKb|kbtable|grkb/i;
const MENU_QUERY = '^信息查询$';
const MENU_TIMETABLE = '个人课表查询|课表查询|我的课表';
const LOGIN_TEXT = /统一身份认证|二次认证|扫码登录|请输入|账号登录/i;

// 教务返回字段的别名表：不同年份的正方版本字段名不一致，按别名兜底
const FIELD_ALIASES = {
  name: ['kcmc', 'kcmcstr', 'kc_name', 'courseName', 'course_name', 'kcmc_mc'],
  teacher: ['jsxm', 'jsxx', 'jsmc', 'teacher', 'teacherName', 'jzgxx', 'xm'],
  weekday: ['xqj', 'xingqi', 'weekday', 'week_day', 'xqjmc', 'xqj_mc'],
  periods: ['jcs', 'jcor', 'jc', 'skjc', 'jcstr', 'jcmc', 'skjcs'],
  weeks: ['zcd', 'zcmc', 'zc', 'skzc', 'zcs', 'xqzcd'],
  classroom: ['cdmc', 'jxdd', 'cdmcstr', 'classroom', 'cd_name', 'jxddmc'],
  campus: ['xqmc', 'xqm', 'campus', 'xq_name', 'xqmstr'],
  credit: ['xf', 'credit'],
  courseCode: ['kch', 'kch_id', 'courseCode'],
};

// ---------- 通用 ----------

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function numberArg(name, fallback) {
  const parsed = Number(argValue(name, String(fallback)));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstLine(error) {
  return String((error && error.message) || error || '').split('\n')[0];
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function pickAlias(object, aliases) {
  if (!object || typeof object !== 'object') return null;
  for (const key of aliases) {
    const value = object[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') continue;
    return { key, value: String(value).trim() };
  }
  return null;
}

// 只保留排障必需的头，绝不记录 Cookie / Authorization
const SAFE_HEADERS = ['content-type', 'accept', 'x-requested-with'];

function safeHeaderSubset(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase();
    if (!SAFE_HEADERS.includes(lower)) continue;
    out[lower] = String(value).slice(0, 200);
  }
  return out;
}

// ---------- 登录态判定（单标签、零导航轮询） ----------

async function inspectJw({ page, initial, writer }) {
  if (initial) {
    await safeGoto(page, PLATFORM_URLS.jw, { settleMs: 3000 });
  }
  const url = page.url();
  const title = safeTitle(await page.title().catch(() => ''));
  const details = { final_url: sanitizeUrl(url), title };

  if (HOST_PATTERNS.sso.test(url) || pageAuthUrl(url)) {
    if (writer && !initial) {
      writer.emit('AUTH_WAIT:jw', '教务仍在统一身份认证页', {
        final_url: details.final_url,
        user_action: '请在同一窗口本人完成统一认证（含二次认证），完成后不要关闭窗口',
      });
    }
    return { authenticated: false, reason: '停留在统一身份认证或登录页', details };
  }

  const onJw = JW_HOST.test(url);
  const business = onJw && /jwglxt|xtgl\/index|index_init/i.test(url);
  if (business) return { authenticated: true, reason: '教务业务页可读', details };

  if (onJw) {
    // 兜底：教务首页有时是框架页，URL 不含 jwglxt，但菜单文本已可见
    const text = await bodyText(page);
    if (/个人课表|信息查询|课表查询|我的课表|选课/.test(text) && !LOGIN_TEXT.test(title || '')) {
      return {
        authenticated: true,
        reason: '教务菜单文本可见',
        details: { ...details, signal: 'menu_text', text_len: text.length },
      };
    }
  }

  return { authenticated: false, reason: '未进入教务业务页', details };
}

// ---------- 网络与请求捕获 ----------

function attachMonitor(page, state) {
  page.on('framenavigated', (frame) => {
    try {
      if (frame !== page.mainFrame()) return;
      const url = sanitizeUrl(frame.url());
      if (!url || url === 'about:blank') return;
      if (state.chain[state.chain.length - 1] !== url) state.chain.push(url);
      if (state.chain.length > 80) state.chain.shift();
    } catch {
      // 页面关闭后的事件忽略
    }
  });

  page.on('request', (request) => {
    try {
      const url = request.url();
      if (!JW_HOST.test(url) || !TIMETABLE_URL_HINT.test(url)) return;
      state.queryRequests.push({
        url,
        method: request.method(),
        post_data: request.postData() || null,
        headers: safeHeaderSubset(request.headers()),
        at: new Date().toISOString(),
      });
      if (state.queryRequests.length > 20) state.queryRequests.shift();
    } catch {
      // 忽略无法读取的请求
    }
  });

  page.on('response', (response) => {
    try {
      const url = response.url();
      if (!JW_HOST.test(url)) return;
      const contentType = String(response.headers()['content-type'] || '');
      const interesting =
        /application\/json/i.test(contentType) ||
        /text\/html/i.test(contentType) ||
        TIMETABLE_URL_HINT.test(url);
      if (!interesting) return;
      response
        .text()
        .then((text) => {
          state.responses.push({
            url: sanitizeUrl(url),
            status: response.status(),
            content_type: contentType.split(';')[0],
            body: String(text || '').slice(0, MAX_BODY_CHARS),
            origin: 'page-network',
            at: new Date().toISOString(),
          });
          if (state.responses.length > 60) state.responses.shift();
        })
        .catch(() => {});
    } catch {
      // 忽略
    }
  });
}

// HTTP 入口：把捕获到的课表请求原样重放（cookie 由浏览器自带，不落盘）
async function httpReplay(page, request) {
  try {
    const result = await page.evaluate(
      async ({ url, method, body, headers }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          const response = await fetch(url, {
            method,
            body: method === 'GET' || method === 'HEAD' ? undefined : body,
            headers,
            credentials: 'include',
            signal: controller.signal,
          });
          const text = await response.text();
          return {
            status: response.status,
            content_type: response.headers.get('content-type') || '',
            body: text.slice(0, 400000),
          };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        url: request.url,
        method: request.method,
        body: request.post_data,
        headers: { 'x-requested-with': 'XMLHttpRequest', ...request.headers },
      }
    );
    return { ok: true, ...result, origin: 'http-replay' };
  } catch (error) {
    return { ok: false, reason: firstLine(error), origin: 'http-replay' };
  }
}

// ---------- 数据解析 ----------

function parseWeeks(raw) {
  const text = String(raw || '');
  if (!text.trim()) return { raw: null, list: [], ranges: [], parity: null, pending: '未读到周次' };
  const compact = text.replace(/[（）()【】\s]/g, '');
  const ranges = [];
  const tokens = compact.match(/\d{1,2}\s*[-~—至]\s*\d{1,2}|\d{1,2}/g) || [];
  for (const token of tokens) {
    const range = token.match(/^(\d{1,2})\s*[-~—至]\s*(\d{1,2})$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to <= 30) ranges.push([from, to]);
      continue;
    }
    const single = Number(token);
    if (Number.isFinite(single) && single >= 1 && single <= 30) ranges.push([single, single]);
  }
  const parity = /单/.test(text) ? 'odd' : /双/.test(text) ? 'even' : null;
  const list = [];
  for (const [from, to] of ranges) {
    for (let week = from; week <= to; week += 1) {
      if (parity === 'odd' && week % 2 === 0) continue;
      if (parity === 'even' && week % 2 === 1) continue;
      list.push(week);
    }
  }
  return {
    raw: text.slice(0, 60),
    list: Array.from(new Set(list)).sort((a, b) => a - b),
    ranges,
    parity,
    pending: ranges.length ? null : '周次格式未识别',
  };
}

function parseWeekday(raw) {
  const text = String(raw || '');
  const cn = text.match(/[周星期]\s*([一二三四五六日天])/);
  if (cn) {
    const order = '一二三四五六日';
    const index = cn[1] === '天' ? 7 : order.indexOf(cn[1]) + 1;
    if (index >= 1 && index <= 7) return index;
  }
  const digits = text.match(/([1-7])/);
  if (digits) return Number(digits[1]);
  return null;
}

function scanCourseRows(value, depth, out) {
  if (depth > 6 || out.length >= 500 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) scanCourseRows(item, depth + 1, out);
    return;
  }
  const name = pickAlias(value, FIELD_ALIASES.name);
  if (name && name.value.length >= 2 && name.value.length <= 80) {
    const weekday = pickAlias(value, FIELD_ALIASES.weekday);
    const periods = pickAlias(value, FIELD_ALIASES.periods);
    const weeks = pickAlias(value, FIELD_ALIASES.weeks);
    if (weekday || periods || weeks) {
      const teacher = pickAlias(value, FIELD_ALIASES.teacher);
      const classroom = pickAlias(value, FIELD_ALIASES.classroom);
      const campus = pickAlias(value, FIELD_ALIASES.campus);
      const credit = pickAlias(value, FIELD_ALIASES.credit);
      const courseCode = pickAlias(value, FIELD_ALIASES.courseCode);
      out.push({
        name: name.value,
        teacher: teacher ? teacher.value : null,
        weekday: weekday ? weekday.value : null,
        periods: periods ? periods.value : null,
        weeks: weeks ? weeks.value : null,
        classroom: classroom ? classroom.value : null,
        campus: campus ? campus.value : null,
        credit: credit ? credit.value : null,
        course_code: courseCode ? courseCode.value : null,
        alias_keys: {
          name: name.key,
          teacher: teacher ? teacher.key : null,
          weekday: weekday ? weekday.key : null,
          periods: periods ? periods.key : null,
          weeks: weeks ? weeks.key : null,
          classroom: classroom ? classroom.key : null,
        },
      });
    }
  }
  for (const key of Object.keys(value)) scanCourseRows(value[key], depth + 1, out);
}

function parseResponseBody(response) {
  const body = String(response.body || '').trim();
  if (!body) return { kind: 'empty', rows: [], reason: '响应为空' };
  if (/^[[{]/.test(body)) {
    try {
      const parsed = JSON.parse(body);
      const rows = [];
      scanCourseRows(parsed, 0, rows);
      return { kind: 'json', rows, parsed };
    } catch {
      return { kind: 'json-broken', rows: [], reason: 'JSON 解析失败' };
    }
  }
  if (/<table|<tr|<td/i.test(body)) {
    return { kind: 'html', rows: [], html: body };
  }
  return { kind: 'text', rows: [], reason: '非 JSON / 非表格响应' };
}

/**
 * DOM 兜底解析：优先「列表视图」(#kblist_table)，其次「表格视图」(#kbgrid_table_0)。
 *
 * 实测结构（2026-10 正方教学管理信息服务平台）：
 *   列表视图：第 0 行是标题（含姓名与学号，必须跳过且不落盘）、第 1 行是表头，
 *            之后每行是「星期（rowspan）」+「节次」+「课表信息」
 *   表格视图：时间段(rowspan) | 节次 | 星期一..星期日，单元格形如
 *            「课程名(1-2节)3-12周,15-16周大学城校区A1202张老师」
 */
async function parseDomTimetable(page) {
  const frames = page.frames();
  for (const frame of frames) {
    let result = null;
    try {
      result = await frame.evaluate(() => {
        const DAY_RE = /^(星期|周)([一二三四五六日天])$/;
        const dayOf = (text) => {
          const match = String(text || '').replace(/\s+/g, '').match(DAY_RE);
          if (!match) return null;
          const order = '一二三四五六日';
          return match[2] === '天' ? 7 : order.indexOf(match[2]) + 1;
        };

        // ① 列表视图
        const list = document.querySelector('#kblist_table');
        if (list && list.rows.length > 2) {
          const entries = [];
          let currentDay = null;
          for (let i = 0; i < list.rows.length; i += 1) {
            const row = list.rows[i];
            const cells = Array.from(row.cells);
            if (!cells.length) continue;
            const first = (cells[0].innerText || '').replace(/\s+/g, ' ').trim();
            // 标题行含姓名/学号，直接跳过
            if (i === 0 || /学号|的课表/.test(first)) continue;
            if (/^星期|^节次/.test(first) && cells.length <= 3 && /节次/.test(first)) continue;

            if (cells.length === 1) {
              const day = dayOf(first);
              if (day) currentDay = day;
              continue;
            }
            if (!currentDay) {
              const day = dayOf(first);
              if (day) {
                currentDay = day;
                // 星期与节次同在一行时，节次在第二列
                if (cells.length >= 3) {
                  entries.push({
                    day,
                    periods_text: (cells[1].innerText || '').trim(),
                    info_text: (cells[2].innerText || '').replace(/\s+/g, ' ').trim(),
                  });
                }
                continue;
              }
            }
            const periodsText = (cells[0].innerText || '').trim();
            const infoText = (cells[1] ? cells[1].innerText : '').replace(/\s+/g, ' ').trim();
            if (!infoText || infoText.length < 4) continue;
            if (/^节次$/.test(periodsText)) continue;
            entries.push({ day: currentDay, periods_text: periodsText, info_text: infoText });
          }
          if (entries.length) return { table: 'kblist_table', entries };
        }

        // ② 表格视图：用表头单元格的水平位置对齐星期，避开 rowspan 造成的列错位
        const grid = document.querySelector('#kbgrid_table_0');
        if (grid && grid.rows.length > 2) {
          const header = Array.from(grid.rows).find((row) =>
            Array.from(row.cells).some((cell) => dayOf((cell.innerText || '').trim()))
          );
          if (header) {
            const dayAnchors = Array.from(header.cells)
              .map((cell) => {
                const day = dayOf((cell.innerText || '').trim());
                if (!day) return null;
                const rect = cell.getBoundingClientRect();
                return { day, center: rect.left + rect.width / 2 };
              })
              .filter(Boolean);
            if (dayAnchors.length >= 3) {
              const entries = [];
              for (const row of Array.from(grid.rows)) {
                if (row === header) continue;
                const rowCells = Array.from(row.cells);
                if (rowCells.length === 1 && rowCells[0].colSpan > 3) continue; // 标题行
                for (const cell of rowCells) {
                  const text = (cell.innerText || '').replace(/\s+/g, ' ').trim();
                  if (!text || text.length < 6) continue;
                  const rect = cell.getBoundingClientRect();
                  const center = rect.left + rect.width / 2;
                  let best = null;
                  for (const anchor of dayAnchors) {
                    if (!best || Math.abs(anchor.center - center) < Math.abs(best.center - center)) best = anchor;
                  }
                  if (!best) continue;
                  entries.push({ day: best.day, periods_text: '', info_text: text });
                }
              }
              if (entries.length) return { table: 'kbgrid_table_0', entries };
            }
          }
        }
        return null;
      });
    } catch {
      result = null;
    }
    if (result && result.entries && result.entries.length) {
      return { ...result, frame_url: sanitizeUrl(frame.url()) };
    }
  }
  return null;
}

/**
 * 把「课表信息」单元格拆成结构化字段。
 * 实测格式：课程名周数：3-12周,15周校区:大学城校区上课地点：A0000教师：王老师教学班：(2026-2027-1)-0000
 */
function parseCourseInfo(infoText) {
  const text = String(infoText || '').replace(/\s+/g, ' ').trim();

  // 形态 A（列表视图，带标签）：课程名周数：3-12周,15周校区:大学城校区上课地点：A0000教师：王老师教学班：…
  if (/周数\s*[：:]/.test(text)) {
    const weeksMatch = text.match(/周数\s*[：:]\s*([^\s课教校区上]+)/);
    const campusMatch = text.match(/校区\s*[：:]\s*([^\s课教上]+)/);
    const roomMatch = text.match(/上课地点\s*[：:]\s*(.+?)(?=教师\s*[：:]|教学班\s*[：:]|$)/);
    const teacherMatch = text.match(/教师\s*[：:]\s*([^\s教]+?)(?=教学班\s*[：:]|$)/);
    const classMatch = text.match(/教学班\s*[：:]\s*(.+)$/);
    const name = text.split(/周数\s*[：:]/)[0].replace(/[（(]\d{1,2}-\d{1,2}节[）)]/g, '').trim();
    return {
      name: name || null,
      weeks: weeksMatch ? weeksMatch[1] : null,
      campus: campusMatch ? campusMatch[1] : null,
      classroom: roomMatch ? roomMatch[1].trim().slice(0, 40) : null,
      teacher: teacherMatch ? teacherMatch[1].trim().slice(0, 30) : null,
      teaching_class: classMatch ? classMatch[1].trim().slice(0, 60) : null,
    };
  }

  // 形态 B（表格视图，无标签）：线性代数与解析几何(1-2节)3-12周,15-16周大学城校区A1202张老师
  let name = text;
  let rest = text;
  const periodTag = text.match(/[（(]\s*\d{1,2}\s*-\s*\d{1,2}\s*节\s*[）)]/);
  if (periodTag) {
    name = text.slice(0, periodTag.index);
    rest = text.slice(periodTag.index + periodTag[0].length);
  }
  const weeksMatch = rest.match(
    /^(\d{1,2}(?:\s*-\s*\d{1,2})?\s*周(?:\s*[,，]\s*\d{1,2}(?:\s*-\s*\d{1,2})?\s*周)*)/
  );
  let weeks = null;
  if (weeksMatch) {
    weeks = weeksMatch[1].replace(/\s+/g, '');
    rest = rest.slice(weeksMatch[0].length);
  }
  const campusMatch = rest.match(/(五山|大学城|广州国际)校区/);
  let campus = null;
  if (campusMatch) {
    campus = `${campusMatch[1]}校区`;
    rest = rest.replace(campusMatch[0], ' ');
  }
  const roomMatch = rest.match(/[A-Za-z]{0,2}\d{3,4}[A-Za-z]?|[\u4e00-\u9fa5]{1,4}[楼室][A-Za-z0-9-]*/);
  let classroom = null;
  if (roomMatch) {
    classroom = roomMatch[0].trim();
    rest = rest.replace(roomMatch[0], ' ');
  }
  const teacher = rest.replace(/[（()）\s、,，]/g, '').slice(0, 12) || null;

  return {
    name: name.trim() || null,
    weeks,
    campus,
    classroom,
    teacher,
    teaching_class: null,
  };
}

// ---------- 合成课程条目 ----------

function normalizeEntries(rawEntries, { schedule, campusInfo, extraction }) {
  const courses = [];
  const pending = new Set();
  const seen = new Set();

  for (const raw of rawEntries) {
    const name = String(raw.name || '').trim();
    if (!name) continue;
    const weekday = raw.weekday_number || parseWeekday(raw.weekday);
    const periodList = Array.isArray(raw.period_list)
      ? raw.period_list
      : parsePeriodTokens(raw.periods || raw.periods_text);
    const weeks = parseWeeks(raw.weeks);

    const key = [name, weekday || '?', periodList.join('-') || '?', weeks.raw || '?'].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const range = periodRange(schedule, periodList);
    const entryPending = [];
    if (!weekday) entryPending.push('星期');
    if (!periodList.length) entryPending.push('节次');
    else if (!range.start) entryPending.push('起止时间');
    if (!weeks.list.length) entryPending.push('周次');
    if (!raw.teacher) entryPending.push('教师');
    if (!raw.classroom) entryPending.push('教室');
    if (!raw.campus) entryPending.push('校区');

    for (const field of entryPending) pending.add(`${name}：缺${field}`);

    courses.push({
      course: name,
      course_code: raw.course_code || null,
      teacher: raw.teacher || '待确认',
      weekday: weekday || null,
      weekday_name: dayName(weekday) || '待确认',
      periods: periodList,
      period_text: periodList.length ? `${Math.min(...periodList)}-${Math.max(...periodList)}节` : '待确认',
      start_time: range.start,
      end_time: range.end,
      time_note: range.start ? `${range.start}-${range.end}（按${schedule.label}作息换算）` : range.reason || '待确认',
      weeks: {
        raw: weeks.raw || '待确认',
        ranges: weeks.ranges,
        list: weeks.list,
        parity: weeks.parity,
        count: weeks.list.length,
      },
      classroom: raw.classroom || '待确认',
      campus: raw.campus || campusInfo.campus_text || '待确认',
      credit: raw.credit || null,
      extraction: raw.extraction || extraction,
      pending_fields: entryPending,
      source_excerpt: sanitizeExcerpt(raw.source_text || `${name} ${raw.periods || ''} ${raw.classroom || ''}`, 80),
    });
  }

  courses.sort(
    (a, b) =>
      (a.weekday || 9) - (b.weekday || 9) ||
      (a.periods[0] || 99) - (b.periods[0] || 99) ||
      a.course.localeCompare(b.course)
  );

  return { courses, pending: Array.from(pending) };
}

// ---------- 学期与校区 ----------

function semesterFromTermCode(year, term) {
  const startYear = Number(year);
  const termCode = String(term || '').trim();
  if (!Number.isFinite(startYear) || !termCode) return null;
  const map = { '3': 1, '12': 2, '16': 3, '1': 1, '2': 2 };
  const index = map[termCode];
  if (!index) return { raw: `${year}-${term}`, label: `${startYear}-${startYear + 1}学年（学期码 ${termCode}）`, term: null };
  const names = { 1: '第一学期', 2: '第二学期', 3: '第三学期' };
  return {
    raw: `${startYear}-${startYear + 1}-${index}`,
    year: String(startYear),
    term: String(index),
    label: `${startYear}-${startYear + 1}学年${names[index]}`,
  };
}

async function detectSemester(page, responses) {
  // 1) 页面隐藏域（正方常用 #xnm / #xqm）
  try {
    const hidden = await page
      .mainFrame()
      .evaluate(() => {
        const read = (id) => {
          const el = document.querySelector(id);
          if (!el) return null;
          if (el.value) return String(el.value);
          const selected = el.querySelector && el.querySelector('option[selected]');
          return selected ? String(selected.value) : null;
        };
        return { xnm: read('#xnm'), xqm: read('#xqm') };
      })
      .catch(() => null);
    if (hidden && hidden.xnm && hidden.xqm) {
      const parsed = semesterFromTermCode(hidden.xnm, hidden.xqm);
      if (parsed) return { ...parsed, detected_by: '页面隐藏域 #xnm/#xqm', pending: null };
    }
  } catch {
    // 继续下一种方式
  }

  // 2) 页面正文里的「2026-2027学年第一学期」
  const text = await bodyText(page);
  const textMatch = text.match(/(\d{4})-(\d{4})\s*学年\s*第?([一二三1-3])?\s*学期/);
  if (textMatch) {
    const cn = { 一: '1', 二: '2', 三: '3' };
    const term = cn[textMatch[3]] || textMatch[3] || null;
    return {
      raw: textMatch[0],
      year: textMatch[1],
      term,
      label: `${textMatch[1]}-${textMatch[2]}学年${textMatch[3] ? `第${textMatch[3]}学期` : ''}`.trim(),
      detected_by: '页面正文学期文本',
      pending: term ? null : '未读到学期序号',
    };
  }

  // 3) 响应体里的学期字段
  for (const response of responses) {
    const parsed = parseResponseBody(response);
    if (parsed.kind !== 'json' || !parsed.parsed) continue;
    const found = pickAlias(parsed.parsed, ['xnxqmc', 'xqmcstr', 'semester', 'term_name']);
    if (found) {
      return {
        raw: found.value,
        label: found.value,
        year: null,
        term: null,
        detected_by: `响应字段 ${found.key}`,
        pending: null,
      };
    }
  }

  return {
    raw: null,
    label: '待确认',
    year: null,
    term: null,
    detected_by: '未识别',
    pending: '未读到学期，请在教务「个人课表查询」页确认当前学期',
  };
}

// ---------- 主读取流程 ----------

// 教务菜单是 target=_blank：点击后新标签出现，需要接管。返回新页面或 null
async function waitForNewPage(context, knownPages, timeoutMs) {
  const known = new Set(knownPages.map((item) => item.url()));
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const fresh = context
      .pages()
      .filter((candidate) => !candidate.isClosed() && !knownPages.includes(candidate));
    if (fresh.length) {
      const target = fresh[fresh.length - 1];
      await target.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await target.waitForTimeout(2500).catch(() => {});
      return target;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  void known;
  return null;
}

async function openTimetablePage(page, state, writer) {
  const attempts = [];
  const startUrl = page.url();
  if (TIMETABLE_URL_HINT.test(startUrl)) {
    attempts.push({ method: 'already-open', ok: true, url: sanitizeUrl(startUrl) });
    return { attempts, opened_by: 'already-open', readPage: page };
  }

  const context = page.context();
  const pagesBefore = context.pages().filter((candidate) => !candidate.isClosed());

  // 语义点击：信息查询（下拉）→ 个人课表查询（新标签）
  const queryMenu = await clickMinimalByText(page, MENU_QUERY, { maxLen: 8, waitAfterMs: 1500 });
  attempts.push({
    method: 'click-信息查询',
    ok: queryMenu.clicked,
    text: queryMenu.text || null,
    reason: queryMenu.clicked ? null : queryMenu.reason || null,
  });

  const timetableMenu = await clickMinimalByText(page, MENU_TIMETABLE, { maxLen: 12, waitAfterMs: 1500 });
  attempts.push({
    method: 'click-个人课表查询',
    ok: timetableMenu.clicked,
    text: timetableMenu.text || null,
    href: timetableMenu.href || null,
    reason: timetableMenu.clicked ? null : timetableMenu.reason || null,
  });

  if (timetableMenu.clicked) {
    const child = await waitForNewPage(context, pagesBefore, 12000);
    if (child) {
      const url = child.url();
      const ok = TIMETABLE_URL_HINT.test(url);
      attempts.push({ method: 'adopt-new-tab', ok, url: sanitizeUrl(url) });
      if (ok) return { attempts, opened_by: 'semantic-click-new-tab', readPage: child };
    } else {
      // 没开新标签时，也可能在当前页内导航
      if (TIMETABLE_URL_HINT.test(page.url())) {
        attempts.push({ method: 'same-tab-navigated', ok: true, url: sanitizeUrl(page.url()) });
        return { attempts, opened_by: 'semantic-click-same-tab', readPage: page };
      }
      attempts.push({ method: 'adopt-new-tab', ok: false, reason: '点击后未出现新标签，当前页也不是课表页' });
    }
  }

  // 直连候选入口（HTTP 入口）；失败再退回当前页
  for (const candidate of TIMETABLE_PATHS) {
    const url = `${JW_BASE}${candidate}`;
    const finalUrl = await safeGoto(page, url, { settleMs: 3000 });
    const ok = TIMETABLE_URL_HINT.test(finalUrl) && !HOST_PATTERNS.sso.test(finalUrl);
    attempts.push({ method: 'url-entry', ok, url: sanitizeUrl(finalUrl), tried: sanitizeUrl(url) });
    if (ok) return { attempts, opened_by: 'url-entry', readPage: page };
  }

  if (writer) {
    writer.emit('JW_TIMETABLE_PAGE_FALLBACK', '语义点击与直连入口均未命中，改用当前页做 DOM 兜底解析', {
      current_url: sanitizeUrl(page.url()),
      attempts,
    });
  }
  return { attempts, opened_by: 'fallback-current-page', readPage: page };
}

function buildMarkdown(result) {
  const lines = [];
  lines.push('# 教务个人课表（只读）');
  lines.push('');
  lines.push(`- 状态：${result.status}`);
  lines.push(`- 学期：${result.semester.label}`);
  lines.push(`- 校区口径：${result.campus.label}（判定依据：${result.campus.decided_by}）`);
  lines.push(`- 提取方式：${result.extraction.primary}`);
  lines.push(`- 课程条目：${result.summary.sessions} 段 / ${result.summary.courses} 门`);
  lines.push(
    `- 节次时间参考：${result.period_reference.source.name}（${result.period_reference.campus}）`
  );
  lines.push('');

  if (result.summary.sessions) {
    lines.push('## 周课表');
    lines.push('');
    lines.push('| 节次 | 星期一 | 星期二 | 星期三 | 星期四 | 星期五 | 星期六 | 星期日 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    const periodKeys = Array.from(
      new Set(
        result.courses.flatMap((item) =>
          item.periods.length ? item.periods.map((p) => `${Math.min(...item.periods)}-${Math.max(...item.periods)}`) : ['待确认']
        )
      )
    ).sort((a, b) => {
      if (a === '待确认') return 1;
      if (b === '待确认') return -1;
      return Number(a.split('-')[0]) - Number(b.split('-')[0]);
    });
    for (const key of periodKeys) {
      const cells = [1, 2, 3, 4, 5, 6, 7].map((day) => {
        const hit = result.courses.filter((item) => {
          const label = item.periods.length
            ? `${Math.min(...item.periods)}-${Math.max(...item.periods)}`
            : '待确认';
          return item.weekday === day && label === key;
        });
        return hit.length
          ? hit.map((item) => `${item.course}｜${item.classroom}｜${item.teacher}`).join('<br>')
          : '';
      });
      const sample = result.courses.find((item) => {
        const label = item.periods.length
          ? `${Math.min(...item.periods)}-${Math.max(...item.periods)}`
          : '待确认';
        return label === key && item.start_time;
      });
      const timeLabel = sample ? `${key}节<br>${sample.start_time}-${sample.end_time}` : `${key}节`;
      lines.push(`| ${timeLabel} | ${cells.join(' | ')} |`);
    }
    lines.push('');
    lines.push('## 课程明细');
    lines.push('');
    lines.push('| 课程 | 教师 | 星期 | 节次 | 起止时间 | 周次 | 教室 | 校区 | 提取方式 |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const item of result.courses) {
      lines.push(
        `| ${item.course} | ${item.teacher} | ${item.weekday_name} | ${item.period_text} | ${
          item.start_time ? `${item.start_time}-${item.end_time}` : '待确认'
        } | ${item.weeks.raw} | ${item.classroom} | ${item.campus} | ${item.extraction} |`
      );
    }
  } else {
    lines.push('## 未读到课表');
    lines.push('');
    lines.push(...result.diagnostics.notes.map((note) => `- ${note}`));
  }

  if (result.pending.length) {
    lines.push('');
    lines.push(`## 待确认（${result.pending.length} 条）`);
    lines.push('');
    result.pending.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }

  lines.push('');
  lines.push('## 说明');
  lines.push('');
  lines.push(`- ${PERIOD_SOURCE.note}`);
  lines.push('- 本文件只是只读采集结果，不含学号、姓名、Cookie 或票据。');
  return `${lines.join('\n')}\n`;
}

async function readTimetable({ page, writer, outputDir, state, selection }) {
  const startedAt = new Date().toISOString();
  const config = readConfig() || {};
  const pageCount = await openPageCount(page.context());
  if (writer && pageCount > 1) {
    writer.emit('JW_EXTRA_PAGES_IGNORED', '当前上下文存在多个标签，本次只使用其中一个，不打开任何探测页', {
      open_pages: pageCount,
      using_url: sanitizeUrl(page.url()),
    });
  }

  // 把上下文里的标签收敛到教务业务页（不改动用户其他标签）
  const pages = page.context().pages().filter((candidate) => !candidate.isClosed());
  const jwPage = pages.find((candidate) => JW_HOST.test(candidate.url())) || page;

  const opened = await openTimetablePage(jwPage, state, writer);
  // 教务菜单是 target=_blank：点击后在同一个上下文里新开标签，这里接管它
  const readPage = opened.readPage || jwPage;
  if (opened.readPage && opened.readPage !== jwPage) attachMonitor(opened.readPage, state);
  const iframes = await iframeStats(readPage);

  const attempts = [];
  let extractionPrimary = 'none';
  let rawEntries = [];

  // 1) HTTP 入口：重放捕获到的课表请求
  const replayTargets = state.queryRequests.slice(-3).reverse();
  for (const request of replayTargets) {
    const replay = await httpReplay(readPage, request);
    if (!replay.ok) {
      attempts.push({ method: 'http-replay', ok: false, reason: replay.reason, url: sanitizeUrl(request.url) });
      continue;
    }
    state.responses.push({ ...replay, url: sanitizeUrl(request.url) });
    const parsed = parseResponseBody(replay);
    if (parsed.kind === 'json' && parsed.rows.length) {
      rawEntries = parsed.rows.map((row) => ({ ...row, extraction: 'http-json' }));
      extractionPrimary = 'http-json';
      attempts.push({ method: 'http-replay', ok: true, entries: parsed.rows.length, url: sanitizeUrl(request.url) });
      break;
    }
    attempts.push({
      method: 'http-replay',
      ok: false,
      reason: parsed.reason || `响应为 ${parsed.kind}，未解析出课程行`,
      url: sanitizeUrl(request.url),
    });
  }

  // 2) 网络响应优先
  if (!rawEntries.length) {
    const scored = [];
    for (const response of state.responses) {
      const parsed = parseResponseBody(response);
      if (parsed.kind !== 'json' || !parsed.rows.length) continue;
      scored.push({ response, rows: parsed.rows, count: parsed.rows.length });
    }
    scored.sort((a, b) => b.count - a.count);
    if (scored.length) {
      rawEntries = scored[0].rows.map((row) => ({ ...row, extraction: 'network-json' }));
      extractionPrimary = 'network-json';
      attempts.push({
        method: 'network-json',
        ok: true,
        entries: scored[0].count,
        url: scored[0].response.url,
        sampled: scored.length,
      });
    } else {
      attempts.push({ method: 'network-json', ok: false, reason: '未捕获到含课程行的 JSON 响应' });
    }
  }

  // 3) DOM 兜底
  let domResult = null;
  if (!rawEntries.length) {
    domResult = await parseDomTimetable(readPage);
    if (domResult && domResult.entries.length) {
      rawEntries = domResult.entries.map((entry) => {
        const info = parseCourseInfo(entry.info_text);
        // 表格视图的节次写在单元格文本里（形如「课程名(1-2节)…」），列表视图有独立节次列
        const periodsFromInfo = (entry.info_text.match(/[（(](\d{1,2})\s*-\s*(\d{1,2})节[）)]/) || [])[0];
        const periodsText = entry.periods_text || periodsFromInfo || '';
        return {
          name: info.name,
          teacher: info.teacher,
          weekday: String(entry.day),
          weekday_number: entry.day,
          periods: periodsText,
          weeks: info.weeks,
          classroom: info.classroom,
          campus: info.campus,
          source_text: entry.info_text,
          extraction: 'dom-table',
        };
      });
      extractionPrimary = 'dom-table';
      attempts.push({
        method: 'dom-table',
        ok: true,
        entries: rawEntries.length,
        table: domResult.table,
        frame_url: domResult.frame_url,
      });
    } else {
      attempts.push({ method: 'dom-table', ok: false, reason: '页面上未找到可解析的课表表格' });
    }
  }

  // 校区：课表内读到优先，其次参数，其次配置，最后默认
  const campusFromCourses = rawEntries.map((row) => (row.campus ? String(row.campus) : '')).find(Boolean) || null;
  const campusInfo = resolveSchedule({
    explicit: argValue('--campus', null),
    campusText: campusFromCourses,
    configCampus: config.campus || null,
  });
  const schedule = scheduleOf(campusInfo.key, config.period_times);
  const normalized = normalizeEntries(rawEntries, { schedule, campusInfo, extraction: extractionPrimary });
  const semester = await detectSemester(readPage, state.responses);

  const pending = [...normalized.pending];
  if (semester.pending) pending.unshift(`学期：${semester.pending}`);
  if (campusInfo.pending) pending.push(`校区：${campusInfo.pending}`);
  if (!normalized.courses.length) {
    pending.push('课表未读到任何课程：请确认教务系统内当前学期是否已开放个人课表查询');
  }

  const byWeekday = {};
  for (const course of normalized.courses) {
    const key = course.weekday_name;
    byWeekday[key] = (byWeekday[key] || 0) + 1;
  }
  const times = normalized.courses.filter((item) => item.start_time);
  const notes = [];
  if (!normalized.courses.length) {
    notes.push(`入口打开方式：${opened.opened_by}`);
    notes.push('解析尝试记录见 jw-timetable-raw.json 的 extraction.attempts');
    notes.push('dom 兜底是否命中：' + (domResult ? `是（${domResult.entries.length} 个单元格）` : '否'));
  }

  const status = normalized.courses.length ? 'READ_OK' : 'READ_EMPTY';
  const result = {
    source: '教务系统 · 个人课表查询（只读）',
    status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    profile: {
      id: selection.profileId,
      namespace: 'cas',
      dir_hint: displayPath(selection.profileDir || resolvePlatformDir(selection.profileId, 'jw')),
    },
    page_url: sanitizeUrl(readPage.url()),
    page_title: safeTitle(await readPage.title().catch(() => '')),
    semester,
    campus: {
      key: campusInfo.key,
      label: schedule.label,
      decided_by: campusInfo.decided_by,
      campus_text: campusInfo.campus_text,
      pending: campusInfo.pending || null,
    },
    extraction: {
      primary: extractionPrimary,
      opened_by: opened.opened_by,
      attempts,
      entry_attempts: opened.attempts,
      responses_seen: state.responses.length,
      query_requests_seen: state.queryRequests.length,
      iframes,
    },
    period_reference: referenceForOutput(schedule),
    courses: normalized.courses,
    summary: {
      sessions: normalized.courses.length,
      courses: new Set(normalized.courses.map((item) => item.course)).size,
      by_weekday: byWeekday,
      earliest_start: times.length ? times.map((item) => item.start_time).sort()[0] : null,
      latest_end: times.length ? times.map((item) => item.end_time).sort().slice(-1)[0] : null,
    },
    pending,
    diagnostics: {
      notes,
      jump_chain: state.chain.slice(-20),
      response_index: state.responses.map((item) => ({
        url: item.url,
        status: item.status,
        content_type: item.content_type,
        origin: item.origin || 'page-network',
        length: String(item.body || '').length,
      })),
    },
  };

  return result;
}

async function writeOutputs(result, state, outputDir) {
  const jsonPath = path.join(outputDir, 'jw-timetable.json');
  const mdPath = path.join(outputDir, 'jw-timetable.md');
  const rawPath = path.join(outputDir, 'jw-timetable-raw.json');
  writeJson(jsonPath, result);
  fs.writeFileSync(mdPath, buildMarkdown(result), 'utf8');
  writeJson(rawPath, {
    checked_at: new Date().toISOString(),
    page_url: result.page_url,
    page_title: result.page_title,
    jump_chain: state.chain.slice(-40),
    query_requests: state.queryRequests.map((item) => ({
      url: sanitizeUrl(item.url),
      method: item.method,
      has_post_data: Boolean(item.post_data),
      post_data_length: item.post_data ? String(item.post_data).length : 0,
      headers: item.headers,
    })),
    responses: state.responses.map((item) => ({
      url: item.url,
      status: item.status,
      content_type: item.content_type,
      origin: item.origin || 'page-network',
      // 只留结构摘要与截断摘录，避免把整页 HTML 与可能的名单写进诊断
      head: sanitizeExcerpt(String(item.body || ''), 300),
      length: String(item.body || '').length,
    })),
    note: '本文件用于维护选择器：只保留 URL、状态、计数与截断摘录，不含 Cookie / 票据 / 学号',
  });
  return { jsonPath, mdPath, rawPath };
}

// ---------- 自检（不联网，仅验证解析器） ----------

function selfCheck() {
  const checks = [];
  const schedule = scheduleOf('wushan');

  const periods = parsePeriodTokens('3-4节');
  checks.push({
    name: 'parsePeriodTokens("3-4节")',
    pass: JSON.stringify(periods) === JSON.stringify([3, 4]),
    got: periods,
  });

  const range = periodRange(schedule, [3, 4]);
  checks.push({
    name: 'periodRange 五山 3-4 节',
    pass: range.start === '10:00' && range.end === '11:40',
    got: range,
  });

  const weeks = parseWeeks('1-16周(单)');
  checks.push({
    name: 'parseWeeks("1-16周(单)")',
    pass: weeks.list.length === 8 && weeks.list[0] === 1 && weeks.list[7] === 15 && weeks.parity === 'odd',
    got: { count: weeks.list.length, parity: weeks.parity },
  });

  const weekday = parseWeekday('星期三');
  checks.push({ name: 'parseWeekday("星期三")', pass: weekday === 3, got: weekday });

  const jsonPayload = JSON.stringify({
    items: [
      { kcmc: '高等数学(一)', jsxm: '张三', xqj: '1', jcs: '1-2', zcd: '1-16周', cdmc: '310101', xqmc: '五山校区' },
      { kcmc: '大学物理', jsxm: '李四', xqj: '3', jcs: '5-6', zcd: '2-14周(双)', cdmc: 'A2-201', xqmc: '大学城校区' },
    ],
  });
  const parsed = parseResponseBody({ body: jsonPayload });
  checks.push({
    name: 'parseResponseBody 正方 JSON 取行',
    pass: parsed.kind === 'json' && parsed.rows.length === 2 && parsed.rows[0].name === '高等数学(一)',
    got: { kind: parsed.kind, rows: parsed.rows.length },
  });

  const normalized = normalizeEntries(
    parsed.rows.map((row) => ({ ...row, extraction: 'http-json' })),
    { schedule, campusInfo: { campus_text: null }, extraction: 'http-json' }
  );
  const first = normalized.courses.find((item) => item.course === '高等数学(一)');
  checks.push({
    name: 'normalizeEntries 生成起止时间',
    pass: Boolean(first && first.start_time === '08:00' && first.end_time === '09:40' && first.teacher === '张三'),
    got: first ? { start: first.start_time, end: first.end_time, teacher: first.teacher } : null,
  });

  const info = parseCourseInfo(
    '计算机与软件工程基础研讨周数：3-12周,15周校区:大学城校区上课地点：A0000教师：王老师教学班：(2026-2027-1)-0000'
  );
  checks.push({
    name: 'parseCourseInfo 解析真实课表信息',
    pass:
      info.name === '计算机与软件工程基础研讨' &&
      info.teacher === '王老师' &&
      info.classroom === 'A0000' &&
      info.weeks === '3-12周,15周' &&
      /大学城/.test(String(info.campus || '')),
    got: info,
  });

  const gridInfo = parseCourseInfo(
    '线性代数与解析几何(1-2节)3-12周,15-16周大学城校区A1202张老师'
  );
  checks.push({
    name: 'parseCourseInfo 兼容表格视图（无标签）',
    pass: gridInfo.name === '线性代数与解析几何',
    got: { name: gridInfo.name, weeks: gridInfo.weeks },
  });

  const term = semesterFromTermCode('2026', '3');
  checks.push({
    name: 'semesterFromTermCode(2026, 3)',
    pass: Boolean(term && term.label.includes('第一学期')),
    got: term ? term.label : null,
  });

  const failed = checks.filter((item) => !item.pass);
  for (const item of checks) {
    console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}  ${JSON.stringify(item.got)}`);
  }
  console.log(`SELF_CHECK:${failed.length ? 'FAILED' : 'PASS'} (${checks.length - failed.length}/${checks.length})`);
  return failed.length === 0;
}

// ---------- 入口 ----------

async function main() {
  if (flag('--self-check')) {
    process.exitCode = selfCheck() ? 0 : 1;
    return;
  }

  const selection = readProfileSelection(process.argv);
  const outputDir = path.resolve(argValue('--output-dir', defaultOutputDir()));
  const loginTimeoutMs = numberArg('--login-timeout-seconds', 600) * 1000;
  fs.mkdirSync(outputDir, { recursive: true });

  const authorization = checkAuthorization('jw');
  if (!authorization.authorized) {
    console.log(`PLATFORM_NOT_AUTHORIZED:jw ${authorization.reason}`);
    return;
  }

  const state = { chain: [], responses: [], queryRequests: [] };
  // --no-visible-login：只做静默检查，需要登录时立刻返回 AUTH_REQUIRED，不打开任何窗口
  const allowVisibleLogin = !flag('--no-visible-login');
  const result = await withBrowserSession({
    platform: 'jw',
    loginUrl: PLATFORM_URLS.jw,
    outputDir,
    profileId: selection.profileId,
    profileDir: selection.profileDir,
    loginTimeoutMs,
    allowVisibleLogin,
    isAuthenticated: (args) => inspectJw(args),
    onBrowserStart: async ({ page, writer }) => {
      attachMonitor(page, state);
      if (writer) {
        writer.emit('JW_STAGE', '正在检查教务登录态（单标签，不新开窗口）', {
          stage: 'auth_check',
          single_tab: true,
        });
      }
    },
    onAuthenticated: async ({ page, writer }) => {
      if (writer) writer.emit('JW_STAGE', '开始读取个人课表（HTTP → 网络响应 → DOM）', { stage: 'read' });
      const data = await readTimetable({ page, writer, outputDir, state, selection });
      const files = await writeOutputs(data, state, outputDir);
      if (writer) {
        writer.emit('JW_STAGE', '课表已写入', {
          stage: 'write',
          json_hint: displayPath(files.jsonPath),
          md_hint: displayPath(files.mdPath),
          sessions: data.summary.sessions,
          extraction: data.extraction.primary,
        });
      }
      return { ...data, files: { json_hint: displayPath(files.jsonPath), md_hint: displayPath(files.mdPath) } };
    },
  });

  const summaryPath = path.join(outputDir, 'jw-timetable-session.json');
  writeJson(summaryPath, {
    status: result.status,
    started_at: result.started_at,
    finished_at: result.finished_at,
    browser_visibility: result.browser_visibility,
    login_waited_ms: result.login_waited_ms,
    profile: result.profile,
    error: result.error,
    summary: result.data ? result.data.summary : null,
    extraction: result.data ? result.data.extraction.primary : null,
    pending_count: result.data ? result.data.pending.length : null,
  });

  console.log(`JW_TIMETABLE_RESULT:${result.status}`);
  if (result.data && result.data.summary) {
    console.log(
      `JW_TIMETABLE_SUMMARY:sessions=${result.data.summary.sessions} courses=${result.data.summary.courses} extraction=${result.data.extraction.primary}`
    );
  }
  if (result.status === 'READ_EMPTY') process.exitCode = 2;
  else if (result.status !== 'READ_OK' && result.status !== 'READ_PARTIAL') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`JW_TIMETABLE_FAILED:${firstLine(error)}`);
  process.exit(1);
});
