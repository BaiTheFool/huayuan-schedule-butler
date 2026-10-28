'use strict';

/**
 * 用户覆盖层（user-overrides.json）与状态层（user-state.json）。
 *
 * 为什么单独成一层：
 *   学校课表是"读回来的"，不能被改写。用户临时加的实验课、补课、停课、
 *   临时任务、个人事项都存在覆盖层里，分析时叠加到学校课表之上。
 *   这样 jw-timetable.json 永远是原始读数，覆盖层随时可以撤销。
 *
 * 只存本地匿名时间数据：标题、时间、备注、状态。不存姓名、学号、Cookie。
 *
 * 文件位置：<HUAYUAN_HOME>/user-overrides.json、<HUAYUAN_HOME>/user-state.json
 */

const fs = require('fs');
const path = require('path');
const { appDataRoot, ensureDir, readJson, writeJson } = require('./huayuan-paths');

const OVERRIDES_FILE = 'user-overrides.json';
const STATE_FILE = 'user-state.json';
const OVERRIDES_VERSION = 1;
const PARITIES = ['all', 'odd', 'even'];
const TASK_STATUS = ['open', 'done', 'deferred'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function overridesPath() {
  return path.join(appDataRoot(), OVERRIDES_FILE);
}

function statePath() {
  return path.join(appDataRoot(), STATE_FILE);
}

function emptyOverrides() {
  return {
    version: OVERRIDES_VERSION,
    updated_at: null,
    note: '用户手工覆盖层：只存时间与状态，不修改学校原始课表',
    courses: [],
    cancellations: [],
    tasks: [],
    external_tasks: [],
    personal: [],
  };
}

function emptyState() {
  return {
    version: OVERRIDES_VERSION,
    updated_at: null,
    seq: 0,
    counters: { courses: 0, cancellations: 0, tasks: 0, personal: 0 },
    semester: { current_week: null, current_week_updated_at: null },
    last_action: null,
    actions: [],
  };
}

function isTime(value) {
  return typeof value === 'string' && TIME_PATTERN.test(value.trim());
}

function toMinutes(value) {
  if (!isTime(value)) return null;
  const [hour, minute] = value.trim().split(':').map(Number);
  return hour * 60 + minute;
}

function toClock(minutes) {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function dateString(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isDateText(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * 只认 `YYYY-MM-DD`，手动拆分后按本地时区构造。
 *
 * 不能直接 `new Date('2026-11-07T00:00:00')`：参数一旦是 undefined / null / 空串，
 * 模板里就成了 `undefinedT00:00:00`，得到 Invalid Date，后面 getFullYear() 全是 NaN，
 * 最终产出 `NaN-NaN-NaN` 并把手工课铺到 7 天上。这里显式校验每一段。
 */
function parseDateText(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  // 拦掉 2026-02-31 这种被静默进位的"假日期"
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** 中文/英文星期都收：1-7、"周一"、"星期一"、"mon" */
function normalizeWeekday(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw).trim().toLowerCase();
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 7) return Math.round(numeric);
  const names = { 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 7, 周天: 7, 星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6, 星期日: 7, 星期天: 7 };
  if (names[text]) return names[text];
  const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const hit = weekdays.findIndex((name) => text.startsWith(name));
  return hit >= 0 ? hit + 1 : null;
}

/** 周次规则："10" / "3-12" / "3-12,15" 都收 */
function parseWeeks(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw).trim().toLowerCase();
  if (text === 'current' || text === '本周' || text === 'this') return { week: 'current' };
  const ranges = [];
  for (const token of text.split(/[,，;\s]+/)) {
    if (!token) continue;
    const single = token.match(/^第?(\d{1,3})周?$/);
    if (single) {
      ranges.push({ start: Number(single[1]), end: Number(single[1]) });
      continue;
    }
    const range = token.match(/^第?(\d{1,3})-(\d{1,3})周?$/);
    if (range) ranges.push({ start: Number(range[1]), end: Number(range[2]) });
  }
  if (!ranges.length) return null;
  const start = Math.min(...ranges.map((item) => item.start));
  const end = Math.max(...ranges.map((item) => item.end));
  // 单周时同时给出 week 字段，分析时能直接按"第 N 周"匹配
  if (start === end) return { week: start };
  return { start_week: start, end_week: end };
}

/**
 * 把一条记录里的时间定位信息归一成规则对象。
 * 优先级：date（具体某天） > week（单周）+ weekday > start_week/end_week + weekday。
 */
function normalizeRule(raw = {}) {
  const rule = {
    date: isDateText(raw.date) ? String(raw.date).trim() : null,
    weekday: normalizeWeekday(raw.weekday),
    week: null,
    start_week: null,
    end_week: null,
    parity: PARITIES.includes(String(raw.parity || '').toLowerCase())
      ? String(raw.parity).toLowerCase()
      : 'all',
  };
  const fromWeeks = parseWeeks(raw.weeks);
  const singleWeek = Number(raw.week);
  if (Number.isFinite(singleWeek) && singleWeek > 0) {
    rule.week = Math.round(singleWeek);
  } else if (raw.week === 'current') {
    rule.week = 'current';
  } else if (fromWeeks && fromWeeks.week !== undefined) {
    rule.week = fromWeeks.week;
  }
  const start = Number(raw.start_week);
  const end = Number(raw.end_week);
  if (rule.week === null) {
    if (Number.isFinite(start) && start > 0) rule.start_week = Math.round(start);
    if (Number.isFinite(end) && end > 0) rule.end_week = Math.round(end);
    if (fromWeeks && fromWeeks.start_week) {
      rule.start_week = fromWeeks.start_week;
      rule.end_week = fromWeeks.end_week;
    }
  }
  // 只给了一端时补成单周，避免出现"3 到 ∞ 周"这种没人看得懂的规则
  if (rule.start_week && !rule.end_week) rule.end_week = rule.start_week;
  if (!rule.start_week && rule.end_week) rule.start_week = rule.end_week;
  return rule;
}

/**
 * 规则是否命中某一周。weekNumber 未知时返回 { match:true, unknown:true }，
 * 让调用方决定"按未知处理但不要静默丢掉用户设的东西"。
 */
function weekMatches(rule, weekNumber) {
  if (!rule) return { match: true, unknown: false };
  if (rule.week === 'current') return { match: true, unknown: false };
  if (rule.week !== null && rule.week !== undefined) {
    if (weekNumber === null || weekNumber === undefined) return { match: true, unknown: true };
    return { match: Number(rule.week) === Number(weekNumber), unknown: false };
  }
  if (rule.start_week || rule.end_week) {
    if (weekNumber === null || weekNumber === undefined) return { match: true, unknown: true };
    const week = Number(weekNumber);
    const start = rule.start_week || 1;
    const end = rule.end_week || 30;
    if (week < start || week > end) return { match: false, unknown: false };
    if (rule.parity === 'odd' && week % 2 === 0) return { match: false, unknown: false };
    if (rule.parity === 'even' && week % 2 === 1) return { match: false, unknown: false };
    return { match: true, unknown: false };
  }
  return { match: true, unknown: false };
}

function describeRule(rule) {
  if (!rule) return '每周';
  if (rule.date) return `仅 ${rule.date}`;
  const parity = rule.parity === 'odd' ? '单周' : rule.parity === 'even' ? '双周' : '';
  if (rule.week === 'current') return `${rule.weekday ? WEEKDAY_NAMES[rule.weekday - 1] : ''} 本周`.trim();
  if (rule.week !== null && rule.week !== undefined) {
    return `${rule.weekday ? WEEKDAY_NAMES[rule.weekday - 1] : ''} 第 ${rule.week} 周`.trim();
  }
  if (rule.start_week || rule.end_week) {
    const range = `第 ${rule.start_week || 1}-${rule.end_week || 30} 周${parity}`;
    return `${rule.weekday ? WEEKDAY_NAMES[rule.weekday - 1] : ''} ${range}`.trim();
  }
  return rule.weekday ? `每周 ${WEEKDAY_NAMES[rule.weekday - 1]}` : '每周';
}

/** 截止时间：接受 YYYY-MM-DD / YYYY-MM-DD HH:MM / 10月30日 22:00；认不出就返回 null 交给待确认 */
function parseDeadline(raw, referenceYear = new Date().getFullYear()) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!text) return { iso: null, display: '待确认' };
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2}))?$/);
  if (iso) {
    const pad = (value) => String(value).padStart(2, '0');
    const date = `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
    return {
      iso: iso[4] ? `${date} ${pad(iso[4])}:${iso[5]}` : `${date} 23:59`,
      display: iso[4] ? `${date} ${pad(iso[4])}:${iso[5]}` : `${date} 23:59`,
      date_only: !iso[4],
    };
  }
  const cn = text.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?$/);
  if (cn) {
    const pad = (value) => String(value).padStart(2, '0');
    const year = cn[1] ? Number(cn[1]) : referenceYear;
    const date = `${year}-${pad(cn[2])}-${pad(cn[3])}`;
    return {
      iso: cn[4] ? `${date} ${pad(cn[4])}:${cn[5]}` : `${date} 23:59`,
      display: cn[4] ? `${date} ${pad(cn[4])}:${cn[5]}` : `${date} 23:59`,
      date_only: !cn[4],
    };
  }
  return { iso: null, display: text, unparsed: true };
}

function normalizeCourse(raw, index) {
  if (!raw) return null;
  const rule = normalizeRule(raw);
  const start = isTime(raw.start) ? String(raw.start).trim() : null;
  const end = isTime(raw.end) ? String(raw.end).trim() : null;
  if (!start || !end) return null;
  if (toMinutes(end) <= toMinutes(start)) return null;
  if (!raw.date && !rule.weekday) return null;
  return {
    id: String(raw.id || `uc-${String(index + 1).padStart(3, '0')}`),
    title: String(raw.title || '未命名课程').slice(0, 60),
    ...rule,
    start,
    end,
    location: raw.location ? String(raw.location).slice(0, 40) : null,
    teacher: raw.teacher ? String(raw.teacher).slice(0, 20) : null,
    kind: ['makeup', 'extra', 'regular'].includes(String(raw.kind || ''))
      ? String(raw.kind)
      : 'extra',
    note: raw.note ? String(raw.note).slice(0, 120) : null,
    source: 'user',
    created_at: raw.created_at || new Date().toISOString(),
  };
}

function normalizeCancellation(raw, index) {
  if (!raw) return null;
  const rule = normalizeRule(raw);
  if (!raw.title) return null;
  return {
    id: String(raw.id || `cx-${String(index + 1).padStart(3, '0')}`),
    title: String(raw.title).slice(0, 60),
    ...rule,
    reason: raw.reason ? String(raw.reason).slice(0, 120) : '停课',
    source: 'user',
    created_at: raw.created_at || new Date().toISOString(),
  };
}

function normalizeTask(raw, index, referenceYear) {
  if (!raw) return null;
  const deadline = parseDeadline(raw.deadline, referenceYear);
  const priority = PRIORITIES.includes(String(raw.priority || '').toUpperCase())
    ? String(raw.priority).toUpperCase()
    : 'P2';
  const status = TASK_STATUS.includes(String(raw.status || '')) ? String(raw.status) : 'open';
  const minutes = Number(raw.estimated_minutes);
  return {
    id: String(raw.id || `ut-${String(index + 1).padStart(3, '0')}`),
    title: String(raw.title || '未命名任务').slice(0, 80),
    course: raw.course ? String(raw.course).slice(0, 40) : null,
    deadline: deadline.iso,
    deadline_display: deadline.display,
    estimated_minutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(600, Math.round(minutes)) : null,
    priority,
    movable: raw.movable !== false,
    status,
    deferred_until: isDateText(raw.deferred_until) ? String(raw.deferred_until).trim() : null,
    completed_at: raw.completed_at || null,
    note: raw.note ? String(raw.note).slice(0, 120) : null,
    source: 'user',
    created_at: raw.created_at || new Date().toISOString(),
  };
}

function normalizePersonal(raw, index) {
  if (!raw) return null;
  const rule = normalizeRule(raw);
  const start = isTime(raw.start) ? String(raw.start).trim() : null;
  const end = isTime(raw.end) ? String(raw.end).trim() : null;
  if (!start || !end || toMinutes(end) <= toMinutes(start)) return null;
  if (!raw.date && !rule.weekday) return null;
  return {
    id: String(raw.id || `up-${String(index + 1).padStart(3, '0')}`),
    title: String(raw.title || '个人事项').slice(0, 60),
    ...rule,
    start,
    end,
    note: raw.note ? String(raw.note).slice(0, 120) : null,
    source: 'user',
    created_at: raw.created_at || new Date().toISOString(),
  };
}

function normalizeOverrides(doc) {
  const raw = doc && typeof doc === 'object' ? doc : {};
  const referenceYear = new Date().getFullYear();
  return {
    version: OVERRIDES_VERSION,
    updated_at: raw.updated_at || null,
    note: raw.note || '用户手工覆盖层：只存时间与状态，不修改学校原始课表',
    courses: (Array.isArray(raw.courses) ? raw.courses : []).map(normalizeCourse).filter(Boolean),
    cancellations: (Array.isArray(raw.cancellations) ? raw.cancellations : [])
      .map(normalizeCancellation)
      .filter(Boolean),
    tasks: (Array.isArray(raw.tasks) ? raw.tasks : [])
      .map((item, index) => normalizeTask(item, index, referenceYear))
      .filter(Boolean),
    external_tasks: (Array.isArray(raw.external_tasks) ? raw.external_tasks : [])
      .map(normalizeExternalTask)
      .filter(Boolean),
    personal: (Array.isArray(raw.personal) ? raw.personal : []).map(normalizePersonal).filter(Boolean),
  };
}

function readOverrides() {
  const raw = readJson(overridesPath());
  if (!raw) return { exists: false, overrides: emptyOverrides() };
  return { exists: true, overrides: normalizeOverrides(raw), raw };
}

function writeOverrides(doc) {
  const normalized = normalizeOverrides(doc);
  normalized.updated_at = new Date().toISOString();
  writeJson(overridesPath(), normalized);
  return normalized;
}

function readState() {
  const raw = readJson(statePath());
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    counters: { ...base.counters, ...(raw.counters || {}) },
    semester: { ...base.semester, ...(raw.semester || {}) },
    actions: Array.isArray(raw.actions) ? raw.actions.slice(-50) : [],
  };
}

function writeState(patch = {}) {
  const previous = readState();
  const merged = {
    ...previous,
    ...patch,
    counters: { ...previous.counters, ...(patch.counters || {}) },
    semester: { ...previous.semester, ...(patch.semester || {}) },
    updated_at: new Date().toISOString(),
  };
  if (patch.actions) merged.actions = patch.actions.slice(-50);
  writeJson(statePath(), merged);
  return merged;
}

/** 生成稳定可读的 id：类型前缀 + 递增序号，重跑不会撞号 */
function nextId(overrides, prefix) {
  const taken = new Set(
    [
      ...(overrides.courses || []),
      ...(overrides.cancellations || []),
      ...(overrides.tasks || []),
      ...(overrides.external_tasks || []),
      ...(overrides.personal || []),
    ].map((item) => item.id)
  );
  let index = 1;
  while (taken.has(`${prefix}-${String(index).padStart(3, '0')}`)) index += 1;
  return `${prefix}-${String(index).padStart(3, '0')}`;
}

function recordAction(action) {
  const state = readState();
  const entry = { at: new Date().toISOString(), ...action };
  return writeState({
    last_action: entry,
    actions: [...state.actions, entry],
  });
}

function currentWeekNumber(explicit = null) {
  const fromArg = Number(explicit);
  if (Number.isFinite(fromArg) && fromArg > 0) return Math.round(fromArg);
  const state = readState();
  const stored = Number(state.semester && state.semester.current_week);
  return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : null;
}

/** 本周 7 天的日期（以周一为起点），用于把 weekday 规则落成具体日期 */
function weekDates(weekStart) {
  const base = parseDateText(weekStart);
  // 传进来的不是合法 YYYY-MM-DD 就直接抛错：宁可这次分析失败，
  // 也不能把 NaN 日期铺出去，最后产出 7 天全一样的假占用。
  if (!base) throw new Error(`weekDates: weekStart 不是合法的 YYYY-MM-DD（收到 ${JSON.stringify(weekStart)}）`);
  const out = [];
  for (let index = 0; index < 7; index += 1) {
    out.push(dateString(new Date(base.getFullYear(), base.getMonth(), base.getDate() + index)));
  }
  return out;
}

/**
 * 把覆盖层展开到"分析中的这一周"。
 *
 * 返回的每一项都已经带具体 date，buildWeek 只需要按日期取用；
 * 不适用本本周的项目不会被丢掉，而是进 skipped 并说明原因（不能静默）。
 */
function expandForWeek({ overrides, weekStart, weekNumber = null }) {
  const dates = weekDates(weekStart);
  const result = {
    week_start: weekStart,
    week_number: weekNumber,
    dates,
    courses: [],
    personal: [],
    cancellations: [],
    applied: { courses: 0, personal: 0, cancellations: 0 },
    skipped: [],
    notes: [],
  };

  const inWeek = (date) => dates.includes(date);

  /**
   * weekday 规则 -> 具体日期。weekday 缺失或越界时返回 null，
   * 由调用方记 skipped；绝不能落到 `dates[undefined]` 得到 undefined 再蒙混过去。
   */
  const dateForWeekday = (weekday) => {
    const index = Number(weekday);
    if (!Number.isInteger(index) || index < 1 || index > 7) return null;
    return dates[index - 1] || null;
  };

  for (const course of overrides.courses || []) {
    if (course.date) {
      if (!inWeek(course.date)) {
        result.skipped.push({
          type: 'course',
          id: course.id,
          title: course.title,
          reason: `${course.date} 不在本次分析的这一周（${weekStart} 起）`,
        });
        continue;
      }
      result.courses.push({ ...course, date: course.date });
      result.applied.courses += 1;
      continue;
    }
    const week = weekMatches(course, weekNumber);
    if (!week.match) {
      result.skipped.push({
        type: 'course',
        id: course.id,
        title: course.title,
        reason: `${describeRule(course)} 与本次分析的周次${weekNumber ? `（第 ${weekNumber} 周）` : ''}不相交`,
      });
      continue;
    }
    const target = dateForWeekday(course.weekday);
    if (!target) {
      result.skipped.push({
        type: 'course',
        id: course.id,
        title: course.title,
        reason: '缺星期信息（既没有 date 也没有 weekday），无法落到具体某天',
      });
      continue;
    }
    if (week.unknown) result.notes.push(`周次未确认：手工课程「${course.title}」按可能发生计入占用（用 set-week 指定当前周次可精确判定）`);
    result.courses.push({ ...course, date: target });
    result.applied.courses += 1;
  }

  for (const item of overrides.personal || []) {
    if (item.date) {
      if (!inWeek(item.date)) {
        result.skipped.push({
          type: 'personal',
          id: item.id,
          title: item.title,
          reason: `${item.date} 不在本次分析的这一周`,
        });
        continue;
      }
      result.personal.push({ ...item, date: item.date });
      result.applied.personal += 1;
      continue;
    }
    const week = weekMatches(item, weekNumber);
    if (!week.match) {
      result.skipped.push({
        type: 'personal',
        id: item.id,
        title: item.title,
        reason: `${describeRule(item)} 与本次分析的周次不相交`,
      });
      continue;
    }
    const target = dateForWeekday(item.weekday);
    if (!target) {
      result.skipped.push({
        type: 'personal',
        id: item.id,
        title: item.title,
        reason: '缺星期信息，无法落到具体某天',
      });
      continue;
    }
    result.personal.push({ ...item, date: target });
    result.applied.personal += 1;
  }

  for (const item of overrides.cancellations || []) {
    if (item.date) {
      if (!inWeek(item.date)) continue;
      result.cancellations.push({ ...item, dates: [item.date] });
      result.applied.cancellations += 1;
      continue;
    }
    const week = weekMatches(item, weekNumber);
    if (!week.match) continue;
    // 没有 weekday 的停课 = 本周这门课全部停掉
    const target = dateForWeekday(item.weekday);
    result.cancellations.push({
      ...item,
      dates: target ? [target] : [...dates],
    });
    result.applied.cancellations += 1;
  }

  return result;
}

/** 任务进任务池之前先剔除已完成、按延后时间排序 */
function tasksForPool({ overrides, referenceYear = new Date().getFullYear() }) {
  const items = [];
  const skipped = [];
  for (const task of overrides.tasks || []) {
    if (task.status === 'done') {
      skipped.push({ id: task.id, title: task.title, reason: '已完成，不再进入待办' });
      continue;
    }
    const deadline = parseDeadline(task.deadline, referenceYear);
    const needsConfirmation = !deadline.iso;
    items.push({
      title: task.title,
      course: task.course,
      task_type: '手工任务',
      source: 'user',
      sources: ['user'],
      entries: [
        {
          source: 'user',
          title: task.title,
          deadline_display: deadline.display,
          priority: task.priority,
          estimated_minutes: task.estimated_minutes,
          movable: task.movable,
        },
      ],
      deadline: deadline.iso,
      deadline_display: deadline.display,
      status: 'unfinished',
      needs_confirmation: needsConfirmation,
      confirm_reasons: needsConfirmation
        ? [deadline.unparsed ? `截止时间格式无法直接比较（原文「${deadline.display}」）` : '未给出截止时间']
        : [],
      priority: task.priority,
      estimated_minutes: task.estimated_minutes,
      movable: task.movable,
      deferred_until: task.status === 'deferred' ? task.deferred_until : null,
      user_task_id: task.id,
      evidence: `${OVERRIDES_FILE}#${task.id}`,
    });
  }
  return { items, skipped };
}

// ---------- 外部任务状态层（雨课堂 / eCourse 任务的"完成 / 延后"） ----------
//
// 学校平台上的任务不能被本地改：说"完成 Homework 5"只是告诉自己"这条别排了"，
// 不上传、不提交、不写回雨课堂或 eCourse。所以状态另存一份，
// 用 source + course + title + deadline 的指纹去认，平台下次刷新还能对上。

const KEY_STRIP = /[\s()（）[\]【】《》<>「」"'’,，.。:：!！?？_\-—/\\]/g;

function keyText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(KEY_STRIP, '')
    .toLowerCase();
}

/**
 * 指纹：来源 + 课程 + 标题 + 截止日期（只取到天，避免平台把 23:59 / 00:00 改来改去就对不上）。
 * 截止时间缺失时用固定占位，保证同一条任务每次算出来都一样。
 */
function taskFingerprint({ source, course, title, deadline } = {}) {
  const datePart = String(deadline || '').slice(0, 10) || 'no-deadline';
  return [keyText(source) || 'unknown', keyText(course) || 'no-course', keyText(title) || 'untitled', datePart].join('|');
}

/** 一条任务可能来自多个平台，每个来源都算一个指纹，任一命中即算同一件事 */
function taskFingerprintKeys(item = {}) {
  const sources = Array.isArray(item.sources) && item.sources.length ? item.sources : [item.source || 'unknown'];
  return sources
    .map((source) => taskFingerprint({ source, course: item.course, title: item.title, deadline: item.deadline }))
    .filter((key, index, list) => list.indexOf(key) === index);
}

function normalizeExternalTask(raw, index) {
  if (!raw) return null;
  const status = ['done', 'deferred'].includes(String(raw.status || '')) ? String(raw.status) : 'open';
  const keys = Array.isArray(raw.keys) ? raw.keys.filter((item) => typeof item === 'string' && item) : [];
  const computed = taskFingerprint(raw);
  const title = String(raw.title || '未命名任务').slice(0, 80);
  return {
    id: String(raw.id || `ue-${String(index + 1).padStart(3, '0')}`),
    key: raw.key || computed,
    keys: keys.length ? keys : [computed],
    source: raw.source ? String(raw.source).slice(0, 20) : 'unknown',
    sources: Array.isArray(raw.sources) ? raw.sources.map(String).slice(0, 5) : null,
    course: raw.course ? String(raw.course).slice(0, 40) : null,
    title,
    deadline: raw.deadline ? String(raw.deadline).slice(0, 16) : null,
    task_type: raw.task_type ? String(raw.task_type).slice(0, 20) : null,
    status,
    deferred_until: isDateText(raw.deferred_until) ? String(raw.deferred_until).trim() : null,
    completed_at: raw.completed_at || null,
    note: raw.note ? String(raw.note).slice(0, 120) : null,
    // 平台原始来源证据：任务来自哪次抓取、哪条记录，永远保留
    platform_evidence: Array.isArray(raw.platform_evidence) ? raw.platform_evidence.slice(0, 5) : [],
    local_only: true,
    created_at: raw.created_at || new Date().toISOString(),
  };
}

/**
 * 在覆盖层里找这条任务的状态记录。
 * 先按完整指纹精确匹配；退一步只看"标题 + 截止日期"，
 * 用于平台把课程名改了、或同名任务只有一门课的情况（matched_by 会如实标出来）。
 */
function matchExternalStatus(item, overrides) {
  const list = (overrides && overrides.external_tasks) || [];
  if (!list.length) return null;
  const keys = taskFingerprintKeys(item);
  for (const entry of list) {
    const entryKeys = Array.isArray(entry.keys) && entry.keys.length ? entry.keys : [entry.key];
    if (entryKeys.some((key) => keys.includes(key))) return { entry, matched_by: 'fingerprint' };
  }
  const titleKey = keyText(item.title);
  if (!titleKey) return null;
  const itemDate = String(item.deadline || '').slice(0, 10);
  for (const entry of list) {
    if (keyText(entry.title) !== titleKey) continue;
    const entryDate = String(entry.deadline || '').slice(0, 10);
    if (entryDate && itemDate && entryDate !== itemDate) continue;
    return { entry, matched_by: 'title+deadline' };
  }
  return null;
}

/**
 * 把外部任务状态叠到合并后的任务池上：
 *   - done：从待办里移出，进 hidden（保留平台来源证据，便于"我什么时候标的"）
 *   - deferred：留在池里但打上 deferred_until，分配时段时跳过
 */
function applyExternalStatuses(items, overrides) {
  const kept = [];
  const hidden = [];
  const deferred = [];
  for (const item of items) {
    const hit = matchExternalStatus(item, overrides);
    if (!hit) {
      kept.push(item);
      continue;
    }
    const evidence = `${OVERRIDES_FILE}#${hit.entry.id}`;
    const platform = (item.entries || []).map((entry) => ({
      source: entry.source,
      course: entry.course || null,
      title: entry.title,
      deadline_display: entry.deadline_display || null,
    }));
    if (hit.entry.status === 'done') {
      hidden.push({
        title: item.title,
        course: item.course,
        sources: item.sources,
        deadline: item.deadline_display,
        status: 'done',
        completed_at: hit.entry.completed_at,
        evidence,
        matched_by: hit.matched_by,
        platform_evidence: platform,
        note: '已完成（仅本地标记，未提交到学校平台）',
      });
      continue;
    }
    item.deferred_until = hit.entry.deferred_until;
    item.status_override = {
      status: 'deferred',
      deferred_until: hit.entry.deferred_until,
      evidence,
      matched_by: hit.matched_by,
      local_only: true,
    };
    deferred.push({ title: item.title, until: hit.entry.deferred_until, evidence });
    kept.push(item);
  }
  return { kept, hidden, deferred };
}

function summary(overrides) {
  return {
    courses: (overrides.courses || []).length,
    cancellations: (overrides.cancellations || []).length,
    tasks: (overrides.tasks || []).length,
    tasks_open: (overrides.tasks || []).filter((item) => item.status === 'open').length,
    tasks_deferred: (overrides.tasks || []).filter((item) => item.status === 'deferred').length,
    tasks_done: (overrides.tasks || []).filter((item) => item.status === 'done').length,
    personal: (overrides.personal || []).length,
    external_tasks: (overrides.external_tasks || []).length,
    external_done: (overrides.external_tasks || []).filter((item) => item.status === 'done').length,
    external_deferred: (overrides.external_tasks || []).filter((item) => item.status === 'deferred').length,
  };
}

module.exports = {
  OVERRIDES_FILE,
  OVERRIDES_VERSION,
  PARITIES,
  PRIORITIES,
  STATE_FILE,
  TASK_STATUS,
  WEEKDAY_NAMES,
  applyExternalStatuses,
  currentWeekNumber,
  dateString,
  describeRule,
  emptyOverrides,
  emptyState,
  expandForWeek,
  isDateText,
  isTime,
  matchExternalStatus,
  nextId,
  normalizeExternalTask,
  normalizeOverrides,
  normalizeRule,
  normalizeWeekday,
  overridesPath,
  parseDateText,
  parseDeadline,
  parseWeeks,
  readOverrides,
  readState,
  recordAction,
  statePath,
  summary,
  taskFingerprint,
  taskFingerprintKeys,
  tasksForPool,
  toClock,
  toMinutes,
  weekDates,
  weekMatches,
  writeOverrides,
  writeState,
};
