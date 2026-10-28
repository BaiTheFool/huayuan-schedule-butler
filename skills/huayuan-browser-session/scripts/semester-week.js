'use strict';

/**
 * 「当前教学周」的唯一判定入口。
 *
 * 判定顺序（越靠前越可信）：
 *   1. 命令行 --week-number（等于用户当场明确指定）
 *   2. 用户在初始化时确认过、存在状态层 user-state.json 的 current_week
 *   3. 教务校历里明确写着"第 1 周周一"的字段（timetable.semester.first_week_start 等）
 *   4. 都推不出来 —— 返回 needs_confirmation: true，只问用户一次，再用 manage-items.js set-week 存下来
 *
 * 不猜：只接受字段名本身就表明"第 1 周"的日期，不拿 semester.start_date 之类的
 * 模糊字段硬算——那可能是注册日、开学典礼日，算出来会整体错一两周。
 */

const { dateString, parseDateText, readState, writeState } = require('./user-overrides');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** 明确表示"第 1 周周一"的字段（按可信度排序） */
const FIRST_WEEK_FIELDS = [
  ['semester.first_week_start', (doc) => doc && doc.semester && doc.semester.first_week_start],
  ['semester.first_week_monday', (doc) => doc && doc.semester && doc.semester.first_week_monday],
  ['semester.week1_monday', (doc) => doc && doc.semester && doc.semester.week1_monday],
  ['semester.week1_start', (doc) => doc && doc.semester && doc.semester.week1_start],
  ['calendar.first_week_start', (doc) => doc && doc.calendar && doc.calendar.first_week_start],
  ['calendar.week1_monday', (doc) => doc && doc.calendar && doc.calendar.week1_monday],
];

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const text = String(value).trim().slice(0, 10);
  return parseDateText(text);
}

function utcDay(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** 第 1 周周一 + 今天 → 第几周 */
function weekFromFirstMonday(firstMonday, at) {
  const start = toDate(firstMonday);
  const today = toDate(at || new Date());
  if (!start || !today) return null;
  const diff = Math.floor((utcDay(today) - utcDay(start)) / WEEK_MS);
  const week = diff + 1;
  if (!Number.isFinite(week) || week < 1 || week > 30) return null;
  return week;
}

/** 从教务课表 / 校园门户数据里找"第 1 周周一" */
function findFirstWeekStart({ timetable = null, campus = null } = {}) {
  const checked = [];
  for (const [name, pick] of FIRST_WEEK_FIELDS) {
    const raw = pick(timetable);
    const date = toDate(raw);
    checked.push({ field: name, value: raw || null, ok: Boolean(date) });
    if (date) return { date, source: `教务数据字段 ${name}`, checked };
  }
  // 校园门户的校历条目：只认同时带"第 1 周"字样的日期
  const portal = campus && campus.platforms && campus.platforms.portal;
  const calendar = (portal && (portal.calendar || portal.semester_calendar)) || (campus && campus.calendar);
  if (calendar && typeof calendar === 'object') {
    const raw = calendar.first_week_start || calendar.week1_monday;
    const date = toDate(raw);
    checked.push({ field: 'portal.calendar.first_week_start', value: raw || null, ok: Boolean(date) });
    if (date) return { date, source: '校园门户校历', checked };
  } else {
    checked.push({ field: 'portal.calendar.first_week_start', value: null, ok: false });
  }
  return { date: null, source: null, checked };
}

/**
 * 只做识别，不写任何文件。
 * @returns {{week:number|null, source:string, reliable:boolean, needs_confirmation:boolean, first_week_start:string|null, checked:Array}}
 */
function detectSemesterWeek({ timetable = null, campus = null, now = new Date() } = {}) {
  const found = findFirstWeekStart({ timetable, campus });
  if (found.date) {
    const week = weekFromFirstMonday(found.date, now);
    if (week) {
      return {
        week,
        source: `${found.source}（第 1 周周一 ${dateString(found.date)}）`,
        reliable: true,
        needs_confirmation: false,
        first_week_start: dateString(found.date),
        checked: found.checked,
      };
    }
  }
  return {
    week: null,
    source: '未识别',
    reliable: false,
    needs_confirmation: true,
    first_week_start: null,
    checked: found.checked,
    question: '现在是本学期的第几周？（例如：第 10 周）',
    how_to_save: 'node manage-items.js set-week --number N',
  };
}

/** 用户确认过（或上一次自动识别）的周次 */
function storedWeek() {
  const state = readState();
  const semester = state.semester || {};
  const week = Number(semester.current_week);
  if (!Number.isFinite(week) || week <= 0) return null;
  return {
    week: Math.round(week),
    source: semester.current_week_source || '状态层 user-state.json（已保存）',
    updated_at: semester.current_week_updated_at || null,
    confirmed_by_user: /用户|确认|手动/.test(String(semester.current_week_source || '')),
  };
}

/** 保存周次（manage-items set-week / onboarding 自动识别都走这里） */
function saveSemesterWeek({ week, source = '用户确认' } = {}) {
  const number = Number(week);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`saveSemesterWeek: week 需要正整数（收到 ${week}）`);
  writeState({
    semester: {
      current_week: Math.round(number),
      current_week_updated_at: new Date().toISOString(),
      current_week_source: source,
    },
  });
  return { week: Math.round(number), source };
}

/**
 * 解析本次分析该用第几周。now.js / schedule-analyze.js / onboarding 共用。
 * @returns {{week:number|null, source:string, reliable:boolean, needs_confirmation:boolean, saved:boolean}}
 */
function resolveWeek({ explicit = null, timetable = null, campus = null, now = new Date() } = {}) {
  const explicitNumber = Number(explicit);
  if (Number.isFinite(explicitNumber) && explicitNumber > 0) {
    const week = Math.round(explicitNumber);
    // 命令行指定的优先，但不要覆盖用户之前确认过的值以外的状态：
    // 这里只记录"本次用的是参数"，不写文件，避免脚本被调用时产生副作用。
    return { week, source: '参数 --week-number', reliable: true, needs_confirmation: false, saved: false };
  }

  const stored = storedWeek();
  const detected = detectSemesterWeek({ timetable, campus, now });

  // 教务校历能算出来时以它为准：存过的自动值可能已经过期（隔了一两周）
  if (detected.reliable) {
    if (stored && stored.week === detected.week) {
      return { week: stored.week, source: `${stored.source}，与教务校历一致`, reliable: true, needs_confirmation: false, saved: true };
    }
    if (stored && stored.confirmed_by_user) {
      // 用户明确说过第几周：以用户为准，但把冲突说出来
      return {
        week: stored.week,
        source: stored.source,
        reliable: true,
        needs_confirmation: false,
        saved: true,
        conflict: `教务校历推算为第 ${detected.week} 周，用户确认的是第 ${stored.week} 周，已按用户确认值计算`,
        detected_week: detected.week,
      };
    }
    return {
      week: detected.week,
      source: detected.source,
      reliable: true,
      needs_confirmation: false,
      saved: false,
      stale_stored: stored && stored.week !== detected.week ? stored.week : null,
      first_week_start: detected.first_week_start,
    };
  }

  if (stored) {
    return {
      week: stored.week,
      source: stored.source,
      reliable: true,
      needs_confirmation: false,
      saved: true,
      updated_at: stored.updated_at,
    };
  }

  return {
    week: null,
    source: '未确认（无法从教务数据可靠识别）',
    reliable: false,
    needs_confirmation: true,
    saved: false,
    question: detected.question,
    how_to_save: detected.how_to_save,
  };
}

module.exports = {
  detectSemesterWeek,
  findFirstWeekStart,
  resolveWeek,
  saveSemesterWeek,
  storedWeek,
  weekFromFirstMonday,
};
