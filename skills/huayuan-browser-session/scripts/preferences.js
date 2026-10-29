'use strict';

/**
 * 个人偏好（本科生初始化向导采集，后续排程直接读取）。
 *
 * 只存时间与开关，不存身份信息；所有时间都用 HH:mm。
 * 采集不到或用户跳过时保留默认值，并记入 pending，绝不假装"用户已确认"。
 */

const fs = require('fs');
const path = require('path');
const { appDataRoot, ensureDir, readJson, writeJson } = require('./huayuan-paths');

const PREFERENCES_FILE = 'preferences.json';
const PREFERENCES_VERSION = 4;

/**
 * 0.6.0 起：偏好必须能追溯来源，且必须区分"用户说过"和"系统估的"。
 *
 * source：
 *   user_explicit —— 用户明确录入或明确回答过的
 *   imported      —— 来自用户明确导入的数据
 *   legacy_unknown—— 旧配置里来源不明的残留（例如不知道谁写的周三班会）
 *   default       —— 系统估计值，**绝对不能**说成"你告诉我的安排"
 *
 * confirmation_state：
 *   unconfirmed —— 用户还没确认（默认值就是这个）
 *   partial     —— 部分字段确认过
 *   confirmed   —— 用户明确确认过（包含"我知道这是默认值，就用默认"这种选择）
 *
 * 只有 source=user_explicit 且 confirmation_state=confirmed 的**具体条目**
 * 才能作为"不可移动"的强约束。
 */
const PREFERENCE_SOURCES = ['user_explicit', 'imported', 'legacy_unknown', 'default'];
const CONFIRMATION_STATES = ['unconfirmed', 'partial', 'confirmed'];

// 来源标签（回答里展示给用户看的那几个词）
const SOURCE_LABEL = {
  user_explicit: '[用户偏好]',
  imported: '[用户偏好]',
  legacy_unknown: '[待确认]',
  default: '[系统默认]',
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * 学习强度：只用来决定"用户没明说的那些默认建议值"。
 *
 * 严格边界：强度**不能**突破用户明确设定的休息时长与睡觉时间。
 * 所以这里只有学习相关的数字，休息 / 作息仍以 preferences 里的显式值为准，
 * 夜间学习截止超过睡觉时间时会被拉回睡觉时间并给出提示。
 */
const INTENSITY_PRESETS = {
  light: {
    label: '轻量',
    weekday_daily_limit_min: 120,
    weekend_daily_limit_min: 90,
    max_continuous_minutes: 50,
    max_study_blocks_per_day: 3,
    evening_study_minutes: 30,
    evening_latest_end: '21:30',
  },
  balanced: {
    label: '均衡',
    weekday_daily_limit_min: 240,
    weekend_daily_limit_min: 180,
    max_continuous_minutes: 90,
    max_study_blocks_per_day: 4,
    evening_study_minutes: 60,
    evening_latest_end: '22:30',
  },
  intense: {
    label: '高强度',
    weekday_daily_limit_min: 300,
    weekend_daily_limit_min: 240,
    max_continuous_minutes: 120,
    max_study_blocks_per_day: 5,
    evening_study_minutes: 90,
    evening_latest_end: '23:00',
  },
};
const INTENSITIES = Object.keys(INTENSITY_PRESETS);

const DEFAULT_PREFERENCES = {
  version: PREFERENCES_VERSION,
  daily: {
    wake: '07:00',
    sleep: '23:30',
    day_start: '07:30',
    day_end: '22:50',
  },
  meals: [
    { key: 'breakfast', label: '早餐', start: '07:00', end: '07:30', protected: false },
    { key: 'lunch', label: '午餐', start: '12:00', end: '12:40', protected: true },
    { key: 'dinner', label: '晚餐', start: '17:30', end: '18:20', protected: true },
  ],
  exercise: { enabled: true, days: [1, 3, 5], start: '17:00', end: '18:00', note: '默认隔天运动一次' },
  rest: { enabled: true, daily_minutes: 60, preferred: ['13:00-13:40', '21:30-22:00'] },
  fixed_events: [],
  study: {
    intensity: 'balanced',
    // daily_limit_min 是旧字段，保留它作为"工作日上限"的别名，老文件与老调用方都不会失效
    daily_limit_min: 240,
    weekday_daily_limit_min: 240,
    weekend_daily_limit_min: 180,
    buffer_min: 20,
    max_continuous_minutes: 90,
    max_study_blocks_per_day: 4,
    evening_latest_end: '22:30',
    evening_study_minutes: 60,
    preferred_study_periods: ['09:00-11:30', '14:30-17:00', '19:00-22:00'],
  },
  weekend: { wake: '08:30', sleep: '23:30', prefer_morning_study: true },
  campus: null,
  college: null,
  major: null,
  pending: [],
};

function eventKey(event = {}) {
  return `${event.title || ''}|${event.day || ''}|${event.start || ''}`;
}

/** 固定事项是否够格当"不可移动"的强约束。 */
function isHardFixedEvent(event = {}) {
  if (!event || !event.title) return false;
  if (event.movable === 'flexible') return false;
  if (event.source === 'default' || event.source === 'legacy_unknown') return false;
  if (event.source && event.source !== 'user_explicit' && event.source !== 'imported') return false;
  if (event.confirmation_state && event.confirmation_state !== 'confirmed') return false;
  // 没写来源的一律不当强约束：来源不明不等于用户说过
  return Boolean(event.source) && event.source !== 'default';
}

/** 来源不明（旧配置残留）的固定事项：要问用户一次，且在此之前不是强约束。 */
function legacyFixedEvents(preferences) {
  const asked = new Set(((preferences && preferences.provenance && preferences.provenance.legacy_asked) || []).map(String));
  return ((preferences && preferences.fixed_events) || [])
    .filter((event) => !isHardFixedEvent(event))
    .filter((event) => !asked.has(eventKey(event)));
}

/** 生成那条"最多问一次"的问题。没有可疑条目时返回 null。 */
function legacyFixedEventQuestion(preferences) {
  const suspects = legacyFixedEvents(preferences);
  if (!suspects.length) return null;
  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const target = suspects[0];
  return {
    count: suspects.length,
    question: `检测到来源不明的${days[(target.day || 1) - 1]} ${target.start}-${target.end}「${target.title}」，保留、修改还是删除？`,
    hint: '回复「保留 / 改成… / 删除」即可；在你说之前它不会被当成不可移动事项。',
    events: suspects.map((event) => ({ ...event, key: eventKey(event) })),
  };
}

function markLegacyAsked(preferences, keys = []) {
  if (!preferences) return preferences;
  const provenance = preferences.provenance || {};
  const asked = new Set([...(provenance.legacy_asked || []), ...keys.map(String)]);
  preferences.provenance = { ...provenance, legacy_asked: [...asked] };
  return preferences;
}

function preferencesPath() {
  return path.join(appDataRoot(), PREFERENCES_FILE);
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
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeDays(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,，\s]+/);
  const out = [];
  for (const item of list) {
    const value = Number(item);
    if (Number.isFinite(value) && value >= 1 && value <= 7 && !out.includes(value)) out.push(value);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 偏好学习时段：只接受 HH:mm-HH:mm，且结束晚于开始。
 * 传进来不是数组（老文件里可能是字符串）时按逗号/分号拆开，容忍自然语言残留。
 */
function normalizePeriods(raw) {
  const list = Array.isArray(raw) ? raw : String(raw === undefined || raw === null ? '' : raw).split(/[,，;；]+/);
  const out = [];
  for (const item of list) {
    const match = String(item || '').trim().match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!match) continue;
    const start = toMinutes(match[1]);
    const end = toMinutes(match[2]);
    if (start === null || end === null || end <= start) continue;
    const text = `${toClock(start)}-${toClock(end)}`;
    if (!out.includes(text)) out.push(text);
  }
  return out.sort((a, b) => toMinutes(a.split('-')[0]) - toMinutes(b.split('-')[0]));
}

/**
 * 判断一份偏好输入到底是哪来的。
 * 没写来源但有用户字段 → legacy_unknown（来源不明的旧配置，必须先问用户）
 * 完全没用户字段 → default（系统估计值）
 */
function hasUserSuppliedFields(input = {}) {
  const keys = ['daily', 'meals', 'exercise', 'rest', 'study', 'weekend', 'campus', 'college', 'fixed_events'];
  return keys.some((key) => input[key] !== undefined && input[key] !== null);
}

function buildProvenance(input = {}, { pending = [] } = {}) {
  const declared = String(
    (input.provenance && input.provenance.source) || input.source || input.preference_source || ''
  ).toLowerCase();
  let source;
  if (PREFERENCE_SOURCES.includes(declared)) source = declared;
  else if (hasUserSuppliedFields(input)) source = 'legacy_unknown';
  else source = 'default';

  const declaredState = String(
    (input.provenance && input.provenance.confirmation_state) || input.confirmation_state || ''
  ).toLowerCase();
  const confirmedAt =
    (input.provenance && input.provenance.confirmed_at) || input.confirmed_at || input.accepted_defaults_at || null;
  let confirmation_state;
  if (CONFIRMATION_STATES.includes(declaredState)) confirmation_state = declaredState;
  else if (confirmedAt) confirmation_state = 'confirmed';
  else if (source === 'default') confirmation_state = 'unconfirmed';
  else confirmation_state = pending.length ? 'partial' : 'unconfirmed';

  return {
    source,
    confirmation_state,
    confirmed_at: confirmation_state === 'confirmed' ? confirmedAt || new Date().toISOString() : confirmedAt,
    // 用户是否明确说过"就用默认值"——说了才算数，不能替他默认同意
    accepted_defaults: confirmation_state === 'confirmed' && source === 'default' ? true : Boolean(input.accepted_defaults),
    legacy_asked: (input.provenance && input.provenance.legacy_asked) || [],
  };
}

/** 偏好能不能作为强约束使用（排程里的不可移动、禁止侵占） */
function trustworthyPreferences(preferences) {
  const provenance = (preferences && preferences.provenance) || {};
  return provenance.source === 'user_explicit' && provenance.confirmation_state === 'confirmed';
}

/** 排程是否处在"偏好仍是系统估计值"的状态——此时禁止下正式计划 */
function defaultUnconfirmed(preferences) {
  const provenance = (preferences && preferences.provenance) || {};
  return provenance.source === 'default' && provenance.confirmation_state !== 'confirmed';
}

/**
 * 合并用户输入与默认值，产出可直接用于排程的偏好对象。
 * 返回 { preferences, pending, warnings }：pending 里是"用户没给、用了默认"的项。
 */
function normalizePreferences(input = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULT_PREFERENCES));
  const warnings = [];
  const pending = [];

  const daily = input.daily || {};
  for (const key of ['wake', 'sleep', 'day_start', 'day_end']) {
    if (daily[key] === undefined) {
      pending.push(`作息：${key} 用默认 ${base.daily[key]}`);
      continue;
    }
    if (!isTime(daily[key])) {
      warnings.push(`daily.${key} 不是 HH:mm（收到 ${daily[key]}），用默认 ${base.daily[key]}`);
      pending.push(`作息：${key} 格式无效，已用默认值`);
      continue;
    }
    base.daily[key] = String(daily[key]).trim();
  }

  if (Array.isArray(input.meals) && input.meals.length) {
    base.meals = input.meals
      .filter((meal) => meal && (meal.key || meal.label))
      .map((meal) => {
        const start = isTime(meal.start) ? meal.start : '12:00';
        const end = isTime(meal.end) ? meal.end : toClock((toMinutes(start) || 720) + 40);
        if (!isTime(meal.start) || !isTime(meal.end)) warnings.push(`用餐时段 ${meal.label || meal.key} 时间无效，已用默认`);
        return {
          key: String(meal.key || meal.label || 'meal'),
          label: String(meal.label || meal.key || '用餐'),
          start,
          end,
          protected: meal.protected !== false,
        };
      });
  } else {
    pending.push('用餐：未指定，沿用默认三餐时段');
  }

  if (input.exercise && typeof input.exercise === 'object') {
    const exercise = input.exercise;
    base.exercise = {
      enabled: exercise.enabled !== false,
      days: normalizeDays(exercise.days && exercise.days.length ? exercise.days : base.exercise.days),
      start: isTime(exercise.start) ? exercise.start : base.exercise.start,
      end: isTime(exercise.end) ? exercise.end : base.exercise.end,
      note: exercise.note ? String(exercise.note).slice(0, 60) : base.exercise.note,
    };
    if (!base.exercise.days.length) {
      base.exercise.days = [...DEFAULT_PREFERENCES.exercise.days];
      warnings.push('运动日为空，已用默认 周一/周三/周五');
    }
  } else {
    pending.push('运动：未指定，默认周一/周三/周五 17:00-18:00');
  }

  if (input.rest && typeof input.rest === 'object') {
    const rest = input.rest;
    base.rest = {
      enabled: rest.enabled !== false,
      daily_minutes: clampNumber(rest.daily_minutes, 0, 480, base.rest.daily_minutes),
      preferred: Array.isArray(rest.preferred) && rest.preferred.length
        ? rest.preferred
            .map((item) => String(item))
            .filter((item) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(item))
        : [...base.rest.preferred],
    };
    if (!base.rest.preferred.length) base.rest.preferred = [...DEFAULT_PREFERENCES.rest.preferred];
  } else {
    pending.push('休息：未指定，默认每天 60 分钟，优先 13:00 与 21:30 附近');
  }

  // 固定事项只能来自用户明确说出或明确导入的数据。
  // 来源不明的旧条目（例如不知道谁写的周三班会）降级为 legacy_unknown 并且 movable=flexible，
  // 在用户确认之前它不是"不可移动"强约束。
  const declaredEventSource = String(input.fixed_events_source || '').toLowerCase();
  if (Array.isArray(input.fixed_events)) {
    base.fixed_events = input.fixed_events
      .filter((event) => event && event.title)
      .map((event) => {
        const day = Number(event.day);
        const start = isTime(event.start) ? event.start : null;
        const end = isTime(event.end) ? event.end : null;
        if (!day || day < 1 || day > 7 || !start || !end) {
          warnings.push(`固定事项「${event.title}」的星期或时间无效，已跳过`);
          return null;
        }
        const known = PREFERENCE_SOURCES.includes(String(event.source || '').toLowerCase())
          ? String(event.source).toLowerCase()
          : null;
        const source =
          known || (declaredEventSource && PREFERENCE_SOURCES.includes(declaredEventSource) ? declaredEventSource : 'legacy_unknown');
        const confirmed = Boolean(event.confirmed_at) || event.confirmation_state === 'confirmed';
        return {
          title: String(event.title).slice(0, 30),
          day,
          start,
          end,
          movable: event.movable === 'flexible' ? 'flexible' : 'fixed',
          source,
          evidence: event.evidence ? String(event.evidence).slice(0, 80) : null,
          confirmation_state: event.confirmation_state && CONFIRMATION_STATES.includes(event.confirmation_state)
            ? event.confirmation_state
            : confirmed ? 'confirmed' : 'unconfirmed',
          confirmed_at: event.confirmed_at || null,
        };
      })
      .filter(Boolean);
    const weak = base.fixed_events.filter((event) => !isHardFixedEvent(event));
    for (const event of weak) {
      pending.push(`固定事项「${event.title}」来源不明（${event.source}），在确认前不作为不可移动约束`);
    }
  }

  /**
   * 学习相关字段（含 0.3.2 新增的强度、连续上限、每日块数、晚间截止、偏好学习时段）。
   *
   * 向后兼容规则（老 preferences.json 没有新字段时）：
   *   1. 强度缺省 → balanced，与旧版默认值（工作日 240 / 周末 180）完全一致，行为不变
   *   2. 工作日上限：weekday_daily_limit_min 优先，其次旧的 daily_limit_min，都没有才用强度预设
   *   3. 用户显式给了的数字永远优先于强度预设；强度只补"没说的"
   *   4. 晚间截止晚于睡觉时间时拉回睡觉时间——强度不能突破用户明确的作息
   */
  const study = input.study && typeof input.study === 'object' ? input.study : {};
  const intensityRaw =
    study.intensity === undefined || study.intensity === null
      ? base.study.intensity
      : String(study.intensity).trim().toLowerCase();
  let intensity = INTENSITIES.includes(intensityRaw) ? intensityRaw : null;
  if (!intensity) {
    warnings.push(`学习强度「${intensityRaw}」不是 light / balanced / intense，已按 balanced 处理`);
    intensity = 'balanced';
  }
  const preset = INTENSITY_PRESETS[intensity];
  const explicitWeekday =
    study.weekday_daily_limit_min !== undefined ? study.weekday_daily_limit_min : study.daily_limit_min;
  const weekdayLimit = clampNumber(explicitWeekday, 30, 720, preset.weekday_daily_limit_min);
  base.study = {
    intensity,
    daily_limit_min: weekdayLimit,
    weekday_daily_limit_min: weekdayLimit,
    weekend_daily_limit_min: clampNumber(
      study.weekend_daily_limit_min,
      30,
      720,
      preset.weekend_daily_limit_min
    ),
    buffer_min: clampNumber(study.buffer_min, 0, 120, DEFAULT_PREFERENCES.study.buffer_min),
    max_continuous_minutes: clampNumber(
      study.max_continuous_minutes,
      20,
      240,
      preset.max_continuous_minutes
    ),
    max_study_blocks_per_day: clampNumber(
      study.max_study_blocks_per_day,
      1,
      8,
      preset.max_study_blocks_per_day
    ),
    evening_latest_end: isTime(study.evening_latest_end)
      ? String(study.evening_latest_end).trim()
      : preset.evening_latest_end,
    evening_study_minutes: clampNumber(study.evening_study_minutes, 0, 300, preset.evening_study_minutes),
    preferred_study_periods: normalizePeriods(
      study.preferred_study_periods === undefined
        ? DEFAULT_PREFERENCES.study.preferred_study_periods
        : study.preferred_study_periods
    ),
  };
  if (study.intensity === undefined && (study.daily_limit_min === undefined && study.weekday_daily_limit_min === undefined)) {
    pending.push('学习强度：未指定，按 balanced（均衡）的默认建议');
  }
  if (study.daily_limit_min === undefined && study.weekday_daily_limit_min === undefined) {
    pending.push(`学习上限：未指定，按 ${INTENSITY_PRESETS[intensity].label} 强度默认工作日 ${weekdayLimit} 分钟`);
  }
  if (study.buffer_min === undefined) pending.push('缓冲：未指定，默认 20 分钟');
  if (study.evening_latest_end === undefined) {
    pending.push(`晚间学习截止：未指定，按 ${preset.label} 强度默认 ${preset.evening_latest_end}`);
  }
  // 强度（以及任何来源的建议值）都不能把学习排到睡觉之后：以用户明确的睡觉时间为硬边界
  {
    const sleepMin = toMinutes(base.daily.sleep);
    const eveningMin = toMinutes(base.study.evening_latest_end);
    if (eveningMin !== null && sleepMin !== null && eveningMin > sleepMin) {
      warnings.push(
        `晚间学习截止 ${base.study.evening_latest_end} 晚于睡觉时间 ${base.daily.sleep}，已按睡觉时间对齐（强度只调整默认建议，不突破你设定的作息）`
      );
      base.study.evening_latest_end = base.daily.sleep;
    }
  }

  if (input.weekend && typeof input.weekend === 'object') {
    const weekend = input.weekend;
    base.weekend = {
      wake: isTime(weekend.wake) ? weekend.wake : base.weekend.wake,
      sleep: isTime(weekend.sleep) ? weekend.sleep : base.weekend.sleep,
      prefer_morning_study: weekend.prefer_morning_study !== false,
    };
  } else {
    pending.push('周末：未指定，默认 08:30 起床、上午优先学习');
  }

  if (isTime(input.campus) || typeof input.campus === 'string') {
    base.campus = input.campus ? String(input.campus).slice(0, 20) : null;
  }
  if (typeof input.college === 'string' && input.college.trim()) {
    base.college = input.college.trim().slice(0, 40);
  }
  if (typeof input.major === 'string' && input.major.trim()) {
    base.major = input.major.trim().slice(0, 40);
  }

  // 作息一致性检查：不阻断，但要说清楚
  const wake = toMinutes(base.daily.wake);
  const sleep = toMinutes(base.daily.sleep);
  const dayStart = toMinutes(base.daily.day_start);
  const dayEnd = toMinutes(base.daily.day_end);
  if (wake !== null && dayStart !== null && dayStart < wake) {
    warnings.push('可用时段开始早于起床时间，已按起床时间对齐');
    base.daily.day_start = base.daily.wake;
  }
  if (sleep !== null && dayEnd !== null && dayEnd > sleep) {
    warnings.push('可用时段结束晚于睡觉时间，已按睡觉时间对齐');
    base.daily.day_end = base.daily.sleep;
  }
  if (wake !== null && sleep !== null && sleep <= wake) {
    warnings.push('睡觉时间不晚于起床时间，视为跨天作息，请确认');
  }

  base.pending = pending;
  base.version = PREFERENCES_VERSION;
  base.updated_at = new Date().toISOString();
  base.warnings = warnings;
  base.provenance = buildProvenance(input, { pending });
  return { preferences: base, pending, warnings };
}

function readPreferences() {
  const raw = readJson(preferencesPath());
  if (!raw) return { exists: false, preferences: null };
  const { preferences, pending, warnings } = normalizePreferences(raw);
  return { exists: true, preferences, pending, warnings, raw };
}

function writePreferences(preferences) {
  ensureDir(path.dirname(preferencesPath()));
  writeJson(preferencesPath(), preferences);
  return preferencesPath();
}

function describePreferences(preferences) {
  if (!preferences) return ['（尚未采集个人偏好）'];
  const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const lines = [
    `学院：${preferences.college || '未选择（活动推送仅展示校级来源）'}`,
    `专业：${preferences.major || '未填写（只影响展示，不影响课表读取）'}`,
    `作息：${preferences.daily.wake} 起床 / ${preferences.daily.sleep} 睡觉；可用 ${preferences.daily.day_start}-${preferences.daily.day_end}`,
    `周末：${preferences.weekend.wake} 起床，${preferences.weekend.prefer_morning_study ? '上午优先学习' : '不强制上午学习'}`,
    `用餐：${preferences.meals.map((meal) => `${meal.label} ${meal.start}-${meal.end}`).join('；')}`,
    preferences.exercise.enabled
      ? `运动：${preferences.exercise.days.map((day) => dayNames[day - 1]).join('、')} ${preferences.exercise.start}-${preferences.exercise.end}`
      : '运动：未启用',
    preferences.rest.enabled
      ? `休息：每天 ${preferences.rest.daily_minutes} 分钟，优先 ${preferences.rest.preferred.join('、')}`
      : '休息：未启用',
    `学习强度：${INTENSITY_PRESETS[preferences.study.intensity] ? INTENSITY_PRESETS[preferences.study.intensity].label : '均衡'}（${preferences.study.intensity || 'balanced'}）`,
    `学习上限：工作日 ${
      preferences.study.weekday_daily_limit_min !== undefined
        ? preferences.study.weekday_daily_limit_min
        : preferences.study.daily_limit_min
    } 分钟 / 周末 ${preferences.study.weekend_daily_limit_min} 分钟；任务缓冲 ${preferences.study.buffer_min} 分钟`,
    `学习节奏：单块不超过 ${preferences.study.max_continuous_minutes || 90} 分钟，每天最多 ${
      preferences.study.max_study_blocks_per_day || 4
    } 块；晚间学习 ${preferences.study.evening_study_minutes === undefined ? 60 : preferences.study.evening_study_minutes} 分钟、最晚到 ${
      preferences.study.evening_latest_end || '22:30'
    }`,
    `偏好学习时段：${
      Array.isArray(preferences.study.preferred_study_periods) && preferences.study.preferred_study_periods.length
        ? preferences.study.preferred_study_periods.join('、')
        : '未指定，按空闲窗口从早到晚'
    }`,
    preferences.fixed_events.length
      ? `固定事项：${preferences.fixed_events
          .map((event) => `${dayNames[event.day - 1]} ${event.start}-${event.end} ${event.title}`)
          .join('；')}`
      : '固定事项：无',
    `校区：${preferences.campus || '未指定（节次时间按五山校区换算）'}`,
  ];
  return lines;
}

// 向导逐题采集用的题面（TTY 交互与其他入口共用同一套默认值）
const INTERVIEW = [
  {
    key: 'college',
    question: '1) 你所在学院/书院？（例如：软件学院、计算机科学与工程学院、建筑学院）',
    fallback: '',
    apply: (input, value) => {
      if (value) input.college = value;
    },
  },
  {
    key: 'daily.wake',
    question: '2) 工作日几点起床？（HH:mm）',
    fallback: '07:00',
    apply: (input, value) => {
      input.daily = { ...(input.daily || {}), wake: value };
    },
  },
  {
    key: 'daily.sleep',
    question: '3) 几点睡觉？（HH:mm）',
    fallback: '23:30',
    apply: (input, value) => {
      input.daily = { ...(input.daily || {}), sleep: value };
    },
  },
  {
    key: 'meals',
    question: '4) 三餐时段（如 07:00-07:30,12:00-12:40,17:30-18:20，回车用默认）',
    fallback: '',
    apply: (input, value) => {
      if (!value) return;
      const labels = ['早餐', '午餐', '晚餐'];
      const keys = ['breakfast', 'lunch', 'dinner'];
      const meals = [];
      value.split(/[,，;；\s]+/).forEach((token, index) => {
        const match = token.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
        if (!match || index > 2) return;
        meals.push({ key: keys[index], label: labels[index], start: match[1], end: match[2], protected: true });
      });
      if (meals.length) input.meals = meals;
    },
  },
  {
    key: 'exercise',
    question: '5) 运动安排（如 1,3,5 17:00-18:00；输入 none 表示不运动）',
    fallback: '',
    apply: (input, value) => {
      if (!value) return;
      if (/^none$/i.test(value)) {
        input.exercise = { enabled: false };
        return;
      }
      const match = value.match(/^([\d,，\s]+)\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
      if (!match) return;
      input.exercise = {
        enabled: true,
        days: match[1].split(/[,，\s]+/).map(Number).filter(Boolean),
        start: match[2],
        end: match[3],
      };
    },
  },
  {
    key: 'rest',
    question: '6) 每天休息多久（分钟）？',
    fallback: '60',
    apply: (input, value) => {
      if (!value) return;
      input.rest = { ...(input.rest || {}), daily_minutes: Number(value) };
    },
  },
  {
    key: 'study.daily_limit_min',
    question: '7) 工作日每天最多投入多少分钟学习？',
    fallback: '240',
    apply: (input, value) => {
      if (!value) return;
      input.study = { ...(input.study || {}), daily_limit_min: Number(value) };
    },
  },
  {
    key: 'study.buffer_min',
    question: '8) 两个任务之间留多少分钟缓冲？',
    fallback: '20',
    apply: (input, value) => {
      if (!value) return;
      input.study = { ...(input.study || {}), buffer_min: Number(value) };
    },
  },
  {
    key: 'fixed_events',
    question: '9) 固定事项（如 2 19:00-20:30 组会；多个用分号隔开，回车跳过）',
    fallback: '',
    apply: (input, value) => {
      if (!value) return;
      const events = [];
      for (const token of value.split(/[;；]+/)) {
        const match = token.trim().match(/^([1-7])\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s+(.+)$/);
        if (!match) continue;
        events.push({ day: Number(match[1]), start: match[2], end: match[3], title: match[4].trim() });
      }
      if (events.length) input.fixed_events = events;
    },
  },
  {
    key: 'weekend',
    question: '10) 周末几点起床？（HH:mm）',
    fallback: '08:30',
    apply: (input, value) => {
      if (!value) return;
      input.weekend = { ...(input.weekend || {}), wake: value };
    },
  },
  {
    key: 'study.intensity',
    question: '11) 学习强度（light 轻量 / balanced 均衡 / intense 高强度，回车用 balanced）',
    fallback: 'balanced',
    apply: (input, value) => {
      const key = String(value).trim().toLowerCase();
      if (!INTENSITIES.includes(key)) return;
      input.study = { ...(input.study || {}), intensity: key };
    },
  },
];

module.exports = {
  CONFIRMATION_STATES,
  DEFAULT_PREFERENCES,
  INTENSITIES,
  INTENSITY_PRESETS,
  INTERVIEW,
  PREFERENCES_FILE,
  PREFERENCES_VERSION,
  PREFERENCE_SOURCES,
  SOURCE_LABEL,
  buildProvenance,
  defaultUnconfirmed,
  eventKey,
  isHardFixedEvent,
  legacyFixedEventQuestion,
  legacyFixedEvents,
  markLegacyAsked,
  trustworthyPreferences,
  describePreferences,
  isTime,
  normalizeDays,
  normalizePeriods,
  normalizePreferences,
  preferencesPath,
  readPreferences,
  toClock,
  toMinutes,
  writePreferences,
};
