'use strict';

/**
 * 官方节次时间参考（华南理工大学 · 一校三区课程安排时间表）
 *
 * 教务课表只给「第几节」时，用本表换算成起止时间；表内数值来自学校公开的
 * 《教师授课温馨指南》一校三区课程安排时间表（www2.scut.edu.cn 公开 PDF）。
 * 学校调整作息后本表会滞后，因此：
 *   - 换算结果一律带 source=period_reference，不做静默假设
 *   - 用户可用 config.json 的 period_times 覆盖单个节次
 *   - 输出里同时保留原始「节次」字段，便于人工核对
 */

const PERIOD_SOURCE = {
  name: '华南理工大学 一校三区课程安排时间表（教师授课温馨指南）',
  publisher: '华南理工大学教务处（学校公开 PDF）',
  note: '一校三区作息不同：五山校区单独一套，大学城校区与广州国际校区共用一套；以当学期教务公告为准',
};

function periods(pairs) {
  return pairs.map((pair, index) => ({ index: index + 1, start: pair[0], end: pair[1] }));
}

const SCHEDULES = {
  wushan: {
    key: 'wushan',
    label: '五山校区',
    campus_keys: ['五山', 'wushan', 'ws'],
    periods: periods([
      ['08:00', '08:45'],
      ['08:55', '09:40'],
      ['10:00', '10:45'],
      ['10:55', '11:40'],
      ['14:30', '15:15'],
      ['15:25', '16:10'],
      ['16:20', '17:05'],
      ['17:15', '18:00'],
      ['19:00', '19:45'],
      ['19:55', '20:40'],
      ['20:50', '21:35'],
    ]),
    anchors: {
      早餐: '06:40-07:25',
      午餐: '11:40-12:30',
      午休: '12:30-14:00',
      晚餐: '18:00-19:00',
      自习结束: '22:20',
      熄灯: '23:00',
      课间操: '09:40-10:00',
    },
  },
  university_town: {
    key: 'university_town',
    label: '大学城校区 / 广州国际校区',
    campus_keys: ['大学城', '广州国际', '国际校区', 'gzic', 'university_town', 'hgc'],
    periods: periods([
      ['08:50', '09:35'],
      ['09:40', '10:25'],
      ['10:40', '11:25'],
      ['11:30', '12:15'],
      ['14:00', '14:45'],
      ['14:50', '15:35'],
      ['15:45', '16:30'],
      ['16:35', '17:20'],
      ['19:00', '19:45'],
      ['19:55', '20:40'],
      ['20:50', '21:35'],
    ]),
    anchors: {
      早餐: '07:30-08:10',
      午餐: '12:15-14:00',
      晚餐: '17:30-18:30',
      自习结束: '22:00',
      熄灯: '23:00',
      课间: '10:25-10:40',
    },
  },
};

const DEFAULT_SCHEDULE_KEY = 'wushan';
const DAY_NAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
const DAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];

function normalizeKey(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (SCHEDULES[value]) return value;
  for (const [key, schedule] of Object.entries(SCHEDULES)) {
    if (schedule.campus_keys.some((alias) => value.includes(String(alias).toLowerCase()))) return key;
  }
  return null;
}

/**
 * 解析校区。优先级：显式参数 > 课表里读到的校区文本 > 配置 > 默认五山。
 * 永远返回可用的 key，并把判定依据一并返回，避免"静默猜错校区"。
 */
function resolveSchedule({ explicit, campusText, configCampus } = {}) {
  const fromExplicit = normalizeKey(explicit);
  if (fromExplicit) return { key: fromExplicit, decided_by: '参数 --campus', campus_text: explicit };
  const fromText = normalizeKey(campusText);
  if (fromText) {
    return { key: fromText, decided_by: '课表内校区字段', campus_text: String(campusText || '').trim() };
  }
  const fromConfig = normalizeKey(configCampus);
  if (fromConfig) return { key: fromConfig, decided_by: '配置文件 campus', campus_text: String(configCampus) };
  return {
    key: DEFAULT_SCHEDULE_KEY,
    decided_by: '默认值（未读到校区）',
    campus_text: null,
    pending: '未读到校区，节次时间按五山校区换算，请确认是否在大学城或广州国际校区',
  };
}

function scheduleOf(key, overrides) {
  const base = SCHEDULES[normalizeKey(key) || DEFAULT_SCHEDULE_KEY];
  const merged = { ...base, periods: base.periods.map((period) => ({ ...period })) };
  if (overrides && typeof overrides === 'object') {
    for (const [rawIndex, value] of Object.entries(overrides)) {
      const index = Number(rawIndex);
      const period = merged.periods.find((item) => item.index === index);
      if (!period || !value) continue;
      const text = String(value);
      const match = text.match(/^(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})$/);
      if (!match) continue;
      period.start = match[1];
      period.end = match[2];
      period.overridden = true;
    }
  }
  return merged;
}

// 「3-4节」「第3,4节」「3~4」「1-2,5-6」等写法统一解析为节次数组
function parsePeriodTokens(raw) {
  const text = String(raw || '');
  const out = [];
  const matches = text.match(/\d{1,2}\s*[-~—至]\s*\d{1,2}|\d{1,2}/g) || [];
  for (const token of matches) {
    const range = token.match(/^(\d{1,2})\s*[-~—至]\s*(\d{1,2})$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to - from < 15) {
        for (let i = from; i <= to; i += 1) out.push(i);
      }
      continue;
    }
    out.push(Number(token));
  }
  return Array.from(new Set(out.filter((n) => Number.isFinite(n) && n >= 1 && n <= 20))).sort((a, b) => a - b);
}

/**
 * 节次 → 起止时间。缺节次或缺该校作息时返回 null，由调用方写「待确认」，不猜时间。
 */
function periodRange(schedule, periodList) {
  const list = Array.isArray(periodList) ? periodList.filter((n) => Number.isFinite(n)) : [];
  if (!list.length) return { start: null, end: null, reason: '未读到节次' };
  const first = schedule.periods.find((item) => item.index === Math.min(...list));
  const last = schedule.periods.find((item) => item.index === Math.max(...list));
  if (!first || !last) {
    return { start: null, end: null, reason: `节次 ${list.join(',')} 超出官方作息表范围` };
  }
  return { start: first.start, end: last.end, reason: null };
}

function dayName(day) {
  const index = Number(day) - 1;
  return DAY_NAMES[index] || null;
}

function dayShort(day) {
  const index = Number(day) - 1;
  return DAY_SHORT[index] || null;
}

function referenceForOutput(schedule) {
  return {
    source: PERIOD_SOURCE,
    campus: schedule.label,
    campus_key: schedule.key,
    periods: schedule.periods.map((item) => ({
      period: item.index,
      start: item.start,
      end: item.end,
      ...(item.overridden ? { overridden: true } : {}),
    })),
    anchors: schedule.anchors,
    note: '仅用于把「第几节」换算成起止时间；学校调整作息时以教务公告为准，可用 config.json 的 period_times 覆盖',
  };
}

module.exports = {
  DAY_NAMES,
  DAY_SHORT,
  DEFAULT_SCHEDULE_KEY,
  PERIOD_SOURCE,
  SCHEDULES,
  dayName,
  dayShort,
  normalizeKey,
  parsePeriodTokens,
  periodRange,
  referenceForOutput,
  resolveSchedule,
  scheduleOf,
};
