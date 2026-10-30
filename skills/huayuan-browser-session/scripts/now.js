'use strict';

/**
 * 「我现在该干什么」——以当前时刻为单位的一次性回答。
 *
 * 和 schedule-analyze.js 的分工：
 *   schedule-analyze 负责把「课表 + 偏好 + 任务 + 覆盖层」算成一整周的结构（占用 / 空闲 / 推荐时段 / 冲突）；
 *   now 只负责"此刻怎么用"：现在在不在课上、这半小时够不够、先做哪一件、之后依次做什么。
 *
 * 所以这里不重写排程规则，而是调用 schedule-analyze 生成当次分析，
 * 再把它折算成"唯一第一动作 + 排序待办 + 后续时段"，保证两个入口永远说同一套话。
 *
 * 输出（与 schedule-analysis.json 同目录）：
 *   now.json  机器可读：current / window / first_action / tasks / sequence / data_status
 *   now.md    给人看的一页：先结论，再清单
 *
 * 用法：
 *   node now.js                       # 现在该干什么
 *   node now.js --now 2026-11-04T15:20:00
 *   node now.js --output-dir out --no-analyze   # 复用最近一次分析，不重跑
 *
 * 前置条件（0.5.0 起强制）：`config.json` 的 `setup_state` 必须是 `completed`。
 * 没初始化时只输出 `SETUP_REQUIRED:<state>` 并以退出码 3 结束，不写任何产物——
 * 因为"现在该干什么"只在课表与待办都读到时才成立，否则是假精确。
 * `partial` 允许用 `--allow-partial` 放宽（结果里会标 `setup.partial_override=true`）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { argValue, defaultOutputDir, displayPath, flag, readSetupState } = require('./huayuan-paths');
const { normalizePreferences, preferencesPath, readPreferences } = require('./preferences');
const { readOverrides, summary: overridesSummary } = require('./user-overrides');

const ARGV = process.argv;
const arg = (name, fallback = null) => argValue(ARGV, name, fallback);
const hasFlag = (name) => flag(ARGV, name);

const MIN_BLOCK_MINUTES = 45;
const SHORT_BLOCK_MINUTES = 20;
const MIN_TASK_START_MINUTES = 10;
// 距下一件固定占用不到这么多分钟时，"先去这件事"就是唯一的第一动作
const GO_SOON_MINUTES = 15;
const FOOTER = '回复「完成X」/「X延后到…」/「今天只剩…」/「临时新增…」我会立即重排。';
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DEFAULT_TASK_MINUTES = { 作业: 45, 测试: 60, 讨论: 30, 问卷: 20 };

function fail(code, message) {
  console.error(`${code}:${message}`);
  process.exit(2);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function toMinutes(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value.trim())) return null;
  const [hour, minute] = value.trim().split(':').map(Number);
  return hour * 60 + minute;
}

function toClock(minutes) {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
}

function minutesText(minutes) {
  if (minutes === null || minutes === undefined) return '未知';
  const value = Math.max(0, Math.round(minutes));
  if (value < 60) return `${value} 分钟`;
  const hour = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hour} 小时 ${rest} 分钟` : `${hour} 小时`;
}

/** 解析 --now：不带时区，按本机本地时间理解，和 schedule-analyze 的 --now 口径一致 */
function nowContext() {
  const raw = arg('--now', null);
  let date = new Date();
  let source = 'system';
  if (raw) {
    const text = String(raw).trim();
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? `${text}T00:00:00`
      : /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}$/.test(text)
        ? `${text.replace(' ', 'T')}:00`
        : text;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      date = parsed;
      source = 'arg:--now';
    }
  }
  const dateText = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return {
    date: dateText,
    time: toClock(minutes),
    minutes,
    weekday: WEEKDAY_NAMES[date.getDay()],
    iso: `${dateText}T${toClock(minutes)}:00`,
    display: `${dateText} ${toClock(minutes)}`,
    source,
  };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findLatest(filename, explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    return fs.existsSync(resolved) ? resolved : null;
  }
  const home =
    process.env.HUAYUAN_HOME || path.join(os.homedir(), '.workbuddy', 'huayuan-schedule-butler');
  const roots = [
    path.join(process.cwd(), 'huayuan-output'),
    process.env.HUAYUAN_OUTPUT_DIR,
    process.env.HUAYUAN_SEARCH_ROOT,
    path.join(os.homedir(), 'WorkBuddy'),
    home,
  ].filter(Boolean).map((item) => path.resolve(item));
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const pending = [{ dir: root, depth: 0 }];
    while (pending.length) {
      const current = pending.shift();
      let entries;
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = path.join(current.dir, entry.name);
        if (entry.isFile() && entry.name === filename) {
          candidates.push({ file: candidate, mtime: fs.statSync(candidate).mtimeMs });
        } else if (
          entry.isDirectory() &&
          current.depth < 5 &&
          !['.git', 'node_modules', 'profiles', 'cache'].includes(entry.name)
        ) {
          pending.push({ dir: candidate, depth: current.depth + 1 });
        }
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? candidates[0].file : null;
}

function publishDashboardSnapshot(jsonPath) {
  const home =
    process.env.HUAYUAN_HOME || path.join(os.homedir(), '.workbuddy', 'huayuan-schedule-butler');
  fs.mkdirSync(home, { recursive: true });
  const target = path.join(home, 'live-now.json');
  const temp = `${target}.${process.pid}.tmp`;
  fs.copyFileSync(jsonPath, temp);
  fs.renameSync(temp, target);
  const planPath = path.join(path.dirname(jsonPath), 'plan.json');
  if (fs.existsSync(planPath)) {
    const planTarget = path.join(home, 'live-plan.json');
    const planTemp = `${planTarget}.${process.pid}.tmp`;
    fs.copyFileSync(planPath, planTemp);
    fs.renameSync(planTemp, planTarget);
  }
  return target;
}

/** 跑一次分析（或复用已有结果），拿到 schedule-analysis.json */
function loadAnalysis({ clock, outputDir }) {
  const analysisPath = path.join(outputDir, 'schedule-analysis.json');
  if (hasFlag('--no-analyze')) {
    const existing = fs.existsSync(analysisPath) ? analysisPath : findLatest('schedule-analysis.json', arg('--analysis', null));
    if (!existing) fail('NO_ANALYSIS', '--no-analyze 但找不到已有的 schedule-analysis.json，去掉这个参数重跑');
    const doc = readJsonSafe(existing);
    const ageMs = analysisAgeMs(doc, existing);
    // 时间相关的问题不能用旧结果：超过 5 分钟就自己重算，避免把已经过去的时间当成"现在可用"
    if (ageMs !== null && ageMs > STALE_ANALYSIS_MS && !hasFlag('--allow-stale')) {
      const at = new Date(Date.now() - ageMs);
      const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      console.log(`ANALYSIS_STALE:上一次分析时间为 ${hhmm}，已过期，自动重算`);
      return { ...runAnalyze({ clock, outputDir }), stale_recomputed: true, previous_age_ms: ageMs };
    }
    return { doc, path: existing, reused: true, stderr: '', stale_recomputed: false, previous_age_ms: ageMs };
  }
  return { ...runAnalyze({ clock, outputDir }), stale_recomputed: false, previous_age_ms: null };

  return runAnalyze({ clock, outputDir });
}

function analysisAgeMs(doc, filePath) {
  const declared = doc && (doc.generated_at || doc.checked_at || doc.started_at);
  if (declared) {
    const parsed = Date.parse(declared);
    if (Number.isFinite(parsed)) return Math.max(0, Date.now() - parsed);
  }
  try {
    return Math.max(0, Date.now() - fs.statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}

function runAnalyze({ clock, outputDir }) {
  const analysisPath = path.join(outputDir, 'schedule-analysis.json');
  const timetable = findLatest('jw-timetable.json', arg('--timetable', null));
  const tasks = findLatest('ecourse-tasks.json', arg('--tasks', null));
  const rain = findLatest('rain-fast.json', arg('--rain', null));
  // 偏好不在输出目录里，固定在家目录的 preferences.json
  const prefsArg = arg('--prefs', null);
  const prefsFile = prefsArg ? path.resolve(prefsArg) : preferencesPath();
  const prefs = fs.existsSync(prefsFile) ? prefsFile : null;

  const args = [path.join(__dirname, 'schedule-analyze.js'), '--output-dir', outputDir, '--now', clock.iso];
  if (timetable) args.push('--timetable', timetable);
  if (tasks) args.push('--tasks', tasks);
  if (rain) args.push('--rain', rain);
  if (prefs) args.push('--prefs', prefs);
  for (const name of ['--week-start', '--week-number']) {
    const value = arg(name, null);
    if (value) args.push(name, String(value));
  }
  if (!hasFlag('--validate')) args.push('--no-validate');

  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (res.status !== 0 || !fs.existsSync(analysisPath)) {
    fail(
      'ANALYZE_FAILED',
      `生成分析失败：${String(res.stderr || res.stdout || '').split('\n').filter(Boolean).slice(-2).join(' / ') || '无输出'}`
    );
  }
  return { doc: readJsonSafe(analysisPath), path: analysisPath, reused: false, stderr: res.stderr || '' };
}

/** 时间相关回答允许复用的最大分析年龄：超过就重算（5 分钟） */
const STALE_ANALYSIS_MS = 5 * 60 * 1000;

/**
 * 一句话简报：结论 → 最多 3 条依据 → 一个下一步。
 * 默认回答就照这个说，不铺表格、不复述平台状态。
 */
function buildBrief(view) {
  const reasons = [];
  if (view.current && view.current.status === 'busy') reasons.push(`现在在${describeSource(view.current.item || {})}`);
  else if (view.window && view.window.minutes) reasons.push(`当前空档 ${view.window.start}-${view.window.end}（${view.window.minutes} 分钟）`);
  if (view.tasks && view.tasks.p0 && view.tasks.p0.length) reasons.push(`P0：${view.tasks.p0[0].title}`);
  if (view.readiness && view.readiness.ready === false && view.readiness.blockers && view.readiness.blockers.length) {
    reasons.push(`数据未确认：${view.readiness.blockers[0].label}`);
  }
  if (view.data_status && view.data_status.estimate_only) reasons.push('这是估算，不是正式计划');
  const text = `${view.first_action.headline}。${reasons.slice(0, 3).join('；')}。下一步：${view.first_action.next_hint || '按上面的第一动作执行'}。`;
  return text.length > 300 ? `${text.slice(0, 297)}……` : text;
}

// ---------- 现在的位置 ----------

const SOURCE_LABEL = {
  class: '上课',
  user: '手工课程',
  personal: '个人事项',
  exercise: '运动',
  meal: '用餐',
  rest: '休息',
  fixed: '固定事项',
  study: '学习',
};

function describeSource(item) {
  const label = SOURCE_LABEL[item.source] || item.source || '占用';
  return item.origin === 'user-course' ? '手工课程' : item.origin === 'user-personal' ? '个人事项' : label;
}

function findOngoing(day, nowMinutes) {
  if (!day) return null;
  const hits = (day.items || []).filter((item) => {
    const start = toMinutes(item.start);
    const end = toMinutes(item.end);
    return start !== null && end !== null && start <= nowMinutes && nowMinutes < end;
  });
  if (!hits.length) return null;
  // 同一时刻同时压着多条时，按"更像正在做的事"排：课 > 个人事项 > 运动/用餐
  const rank = { class: 0, user: 1, personal: 1, fixed: 2, exercise: 3, meal: 4, rest: 5 };
  hits.sort((a, b) => (rank[a.source] === undefined ? 9 : rank[a.source]) - (rank[b.source] === undefined ? 9 : rank[b.source]));
  const main = hits[0];
  return {
    item: main,
    also: hits.slice(1).map((item) => ({ title: item.title, start: item.start, end: item.end, source: item.source })),
    end_minutes: toMinutes(main.end),
    remaining: toMinutes(main.end) - nowMinutes,
  };
}

/**
 * 当前窗口 vs 下一个窗口，必须分清：
 *   - 现在正处在某个空档里：current 有值，minutes 是"从现在起还剩多少"
 *   - 现在被课/饭/运动占着：current 为 null，next 是之后第一段空档
 * 之前混成一个字段，会出现"现在正在上课，却说从现在起有 65 分钟可用"这种假话。
 */
function findWindow(freeDay, nowMinutes) {
  if (!freeDay) return { current: null, next: null };
  const windows = (freeDay.windows || [])
    .map((item) => ({ start: item.start, end: item.end, start_min: toMinutes(item.start), end_min: toMinutes(item.end) }))
    .filter((item) => item.start_min !== null && item.end_min !== null && item.end_min > nowMinutes)
    .sort((a, b) => a.start_min - b.start_min);
  if (!windows.length) return { current: null, next: null };
  const inside = windows.find((item) => item.start_min <= nowMinutes && nowMinutes < item.end_min) || null;
  const current = inside
    ? { start: toClock(nowMinutes), end: inside.end, minutes: inside.end_min - nowMinutes, starts_now: true }
    : null;
  const upcoming = windows.find((item) => item.start_min > nowMinutes) || null;
  const next = upcoming
    ? { start: upcoming.start, end: upcoming.end, minutes: upcoming.end_min - upcoming.start_min, starts_now: false }
    : null;
  return { current, next };
}

function findCurrentStudySegment(studyDay, nowMinutes) {
  return (
    ((studyDay && studyDay.slots) || []).find((slot) => {
      const start = toMinutes(slot.start);
      const end = toMinutes(slot.end);
      return slot.task && start !== null && end !== null && start <= nowMinutes + 1 && nowMinutes < end;
    }) || null
  );
}

function dayGap(day, nowMinutes) {
  // 现在不在任何窗口里：说明被课程/用餐/运动占住了，找下一条"还能用"的窗口
  if (!day) return null;
  const upcoming = (day.items || [])
    .map((item) => ({
      title: item.title,
      start: item.start,
      end: item.end,
      source: item.source,
      origin: item.origin || null,
      start_min: toMinutes(item.start),
      end_min: toMinutes(item.end),
    }))
    .filter((item) => item.start_min !== null && item.end_min !== null && item.start_min > nowMinutes)
    .sort((a, b) => a.start_min - b.start_min);
  return upcoming.length ? upcoming[0] : null;
}

// ---------- 待办优先级 ----------

function daysUntil(nowDate, deadline) {
  if (!deadline) return null;
  const target = new Date(`${String(deadline).slice(0, 10)}T00:00:00`);
  const base = new Date(`${nowDate}T00:00:00`);
  if (Number.isNaN(target.getTime()) || Number.isNaN(base.getTime())) return null;
  return Math.round((target.getTime() - base.getTime()) / 86400000);
}

function defaultMinutes(item) {
  const type = String(item.task_type || '');
  for (const key of Object.keys(DEFAULT_TASK_MINUTES)) if (type.includes(key)) return DEFAULT_TASK_MINUTES[key];
  return 45;
}

/**
 * 优先级口径：
 *   用户显式写的 priority 永远优先（那是他自己定的）
 *   其余按"还剩几天到期"推：已过期/今天明天 → P0，3 天内 → P1，更远或没截止 → P2
 * 这样平台任务不用用户手工标 P0/P1，也能排出一个说得通的顺序。
 */
function priorityOf(item, nowDate) {
  if (item.priority && /^P[0-3]$/.test(String(item.priority).toUpperCase())) {
    return { priority: String(item.priority).toUpperCase(), basis: '你设定的优先级' };
  }
  if (item.status === 'overdue') return { priority: 'P0', basis: '已过期且未完成' };
  const days = daysUntil(nowDate, item.deadline);
  if (days === null) return { priority: 'P2', basis: '截止时间待确认' };
  if (days <= 1) return { priority: 'P0', basis: days < 0 ? '已经过了截止' : days === 0 ? '今天截止' : '明天截止' };
  if (days <= 3) return { priority: 'P1', basis: `${days} 天后截止` };
  return { priority: 'P2', basis: `${days} 天后截止，时间充裕` };
}

function taskView(item, nowDate, { timetableKnown }) {
  const { priority, basis } = priorityOf(item, nowDate);
  const estimated = Number(item.estimated_minutes);
  const minutes = Number.isFinite(estimated) && estimated > 0 ? Math.round(estimated) : defaultMinutes(item);
  const sources = (item.sources || [item.source]).map((name) => (name === 'user' ? '手工' : name));
  const confirmReasons = (item.confirm_reasons || []).slice(0, 2);
  const confidence = item.needs_confirmation ? '待确认' : timetableKnown ? '已确认' : '估算（课表未读到）';
  return {
    title: item.title,
    course: item.course || null,
    sources,
    task_type: item.task_type || null,
    deadline: item.deadline || null,
    deadline_display: item.deadline_display || '待确认',
    days_left: daysUntil(nowDate, item.deadline),
    priority,
    priority_basis: basis,
    estimated_minutes: minutes,
    estimated_by_system: !(Number.isFinite(estimated) && estimated > 0),
    confidence,
    needs_confirmation: Boolean(item.needs_confirmation),
    confirm_reasons: confirmReasons,
    deferred_until: item.deferred_until || null,
    status: item.status || 'unfinished',
    evidence: item.evidence || null,
  };
}

function reasonFor(task, { window, nowMinutes }) {
  const parts = [task.priority_basis];
  if (task.deadline_display && task.deadline_display !== '待确认') parts.push(`截止 ${task.deadline_display}`);
  if (window && window.starts_now) {
    parts.push(
      task.estimated_minutes <= window.minutes
        ? `预计 ${task.estimated_minutes} 分钟，刚好放得进现在这 ${minutesText(window.minutes)}`
        : `预计 ${task.estimated_minutes} 分钟，超过现在这 ${minutesText(window.minutes)}，先做能收尾的部分`
    );
  } else if (window) {
    parts.push(`下一个空档 ${window.start}-${window.end}（${minutesText(window.minutes)}）`);
  }
  parts.push(`来源 ${task.sources.join(' + ')}`);
  if (task.needs_confirmation) parts.push('截止时间待确认，先按保守估计排');
  return parts.join('；');
}

// ---------- 主流程 ----------

function buildNow({ analysis, preferences, overrides, clock }) {
  if (!analysis) fail('NO_ANALYSIS', '分析结果为空，无法判断现在该做什么');

  const today = (analysis.occupancy || []).find((day) => day.date === clock.date) || null;
  const freeToday = (analysis.free_windows || []).find((day) => day.date === clock.date) || null;
  const restToday = (analysis.recommended_rest || []).find((day) => day.date === clock.date) || null;
  const studyToday = (analysis.recommended_study || []).find((day) => day.date === clock.date) || null;
  const plannedNow = findCurrentStudySegment(studyToday, clock.minutes);
  const timetableKnown = Boolean(analysis.timetable_known);

  const ongoing = findOngoing(today, clock.minutes);
  const { current: foundWindow, next: nextWindow } = findWindow(freeToday, clock.minutes);
  const gap = ongoing ? null : dayGap(today, clock.minutes);

  // 分析里的空闲窗口按"够 30 分钟才算一段"切，现在离下一件事只剩几分钟时会被整段丢掉。
  // 这种"只剩 X 分钟"必须如实说出来，所以这里直接按占用边界补一段短窗口。
  let window = foundWindow;
  if (!window && !ongoing && today) {
    const boundsEnd = toMinutes(today.bounds && today.bounds.end);
    const nextBusy = (today.items || [])
      .map((item) => toMinutes(item.start))
      .filter((value) => value !== null && value > clock.minutes)
      .sort((a, b) => a - b)[0];
    const edge = nextBusy === undefined ? boundsEnd : nextBusy;
    if (edge !== null && edge !== undefined && edge > clock.minutes && edge - clock.minutes < MIN_BLOCK_MINUTES) {
      window = {
        start: clock.time,
        end: toClock(edge),
        minutes: edge - clock.minutes,
        starts_now: true,
        synthesized: true,
      };
    }
  }

  // 数据完整性：任何一个来源不完整都要在开头说清，不能装成完整数据
  const weekInfo = {
    number: (analysis.user_overrides && analysis.user_overrides.week_number) || null,
    source: (analysis.user_overrides && analysis.user_overrides.week_number_source) || null,
    reliable: Boolean(analysis.user_overrides && analysis.user_overrides.week_number_reliable),
    needs_confirmation: Boolean(analysis.user_overrides && analysis.user_overrides.week_number_needs_confirmation),
    filter: analysis.week_filter
      ? {
          applied: Boolean(analysis.week_filter.applied),
          courses_kept: analysis.week_filter.courses_kept,
          sessions_skipped: analysis.week_filter.sessions_skipped,
          unknown_week_count: analysis.week_filter.unknown_week_count,
          skipped: analysis.week_filter.skipped || [],
        }
      : null,
  };
  const caveats = [];
  if (!timetableKnown) caveats.push('课表未读取成功：下面的时间只是按作息偏好估算，不能当正式计划');
  if (weekInfo.needs_confirmation) {
    caveats.push('当前教学周未确认：带周次范围的课程无法判断本周上不上，按"可能发生"计入，本周课表不是精确结果');
  } else if (weekInfo.filter && weekInfo.filter.unknown_week_count) {
    caveats.push(`有 ${weekInfo.filter.unknown_week_count} 门课没读到周次范围，按"可能发生"计入，本周课表不是完全精确`);
  }
  const pool = analysis.task_pool || {};
  if (pool.complete === false) caveats.push(`任务数据不完整：${pool.incomplete_reason || '有来源只读到一部分'}`);
  if (!(pool.sources_read && (pool.sources_read.ecourse || pool.sources_read.rain))) {
    caveats.push('没有读到任何任务清单：作业时段只做时间预留，不代表真实任务量');
  }
  const pendingList = analysis.pending || [];
  const estimateOnly =
    !timetableKnown ||
    pool.complete === false ||
    weekInfo.needs_confirmation ||
    Boolean(weekInfo.filter && weekInfo.filter.unknown_week_count);

  // 可排程任务：过期、延后、标题不可识别只影响“现在做什么”，不能从全部待办中消失。
  // 第一动作与 sequence 必须使用同一批可排任务，避免出现上有任务、下无绑定。
  const activeTasks = (pool.items || []).filter(
    (item) => item.status !== 'overdue' && !item.deferred_until && !item.exclude_from_plan
  );
  const activeViews = activeTasks.map((item) => taskView(item, clock.date, { timetableKnown }));
  for (const view of activeViews) view.reason = reasonFor(view, { window, nowMinutes: clock.minutes });
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  activeViews.sort((a, b) => {
    if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
    if (a.deadline && b.deadline) return a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return 0;
  });

  // 全部待办：所有仍在任务池中的未完成项都必须出现。
  // 延后项下降一级继续列出；无法进入排程的待确认项保留，但降到 P3，避免它们驱动第一动作。
  const lowerPriority = { P0: 'P1', P1: 'P2', P2: 'P3', P3: 'P3' };
  const allViews = (pool.items || []).map((item) => {
    const view = taskView(item, clock.date, { timetableKnown });
    if (item.deferred_until) {
      view.priority = lowerPriority[view.priority] || 'P3';
      view.priority_basis = `延后至 ${item.deferred_until}，降级列入待办`;
    } else if (item.exclude_from_plan) {
      view.priority = 'P3';
      view.priority_basis = '信息不完整，保留在待办但不参与排程';
    }
    view.reason = reasonFor(view, { window, nowMinutes: clock.minutes });
    if (item.deferred_until) view.reason = `${view.priority_basis}；${view.reason}`;
    return view;
  });
  allViews.sort((a, b) => {
    if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
    if (a.deadline && b.deadline) return a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return 0;
  });

  const overdue = (pool.items || [])
    .filter((item) => item.status === 'overdue')
    .map((item) => ({
      title: item.title,
      course: item.course,
      sources: (item.sources || []).map((name) => (name === 'user' ? '手工' : name)),
      deadline: item.deadline_display,
      note: '已过期未完成：要不要还做需要你定，暂不排进时段',
    }));
  const completedLocal = (pool.hidden_by_user_state || []).map((item) => ({
    title: item.title,
    course: item.course,
    sources: item.sources || [],
    deadline: item.deadline,
    completed_at: item.completed_at,
    evidence: item.evidence,
    note: '你标了已完成，只记在本地，学校平台未变',
  }));
  const deferred = (pool.items || [])
    .filter((item) => item.deferred_until)
    .map((item) => ({
      title: item.title,
      course: item.course,
      sources: (item.sources || []).map((name) => (name === 'user' ? '手工' : name)),
      deadline: item.deadline_display,
      deferred_until: item.deferred_until,
      note: `${item.deferred_until} 之前不排`,
    }));

  // 后续时段：从今天（现在之后）开始，只看今天和明天，避免一屏塞进一整周
  const sequence = [];
  const seenDates = new Set();
  for (const day of analysis.recommended_study || []) {
    if (sequence.length >= 8) break;
    if (day.date < clock.date) continue;
    if (!seenDates.has(day.date) && seenDates.size >= 2) break;
    seenDates.add(day.date);
    const rows = [];
    for (const slot of day.slots || []) {
      const startMin = toMinutes(slot.start);
      if (startMin === null) continue;
      if (day.date === clock.date && startMin < clock.minutes) continue;
      rows.push({
        date: day.date,
        day_name: day.day_name,
        start: slot.start,
        end: slot.end,
        minutes: slot.minutes,
        kind: slot.task ? 'task' : 'study',
        title: slot.task
          ? `${slot.task.title}${
              slot.task.part_count > 1 ? `（第 ${slot.task.part_index}/${slot.task.part_count} 段）` : ''
            }`
          : '自由学习（未绑定任务）',
        course: slot.task ? slot.task.course : null,
        source: slot.task ? slot.task.source : null,
        priority: slot.task ? slot.task.priority || null : null,
        reason: slot.reason || null,
      });
    }
    for (const slot of (day.date === clock.date && restToday ? restToday.slots : []) || []) {
      rows.push({
        date: day.date,
        day_name: day.day_name,
        start: slot.start,
        end: slot.end,
        minutes: slot.minutes,
        kind: 'rest',
        title: '休息',
        course: null,
        source: null,
        priority: null,
        reason: slot.reason || null,
      });
    }
    rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    sequence.push(...rows);
    if (sequence.length >= 8) break;
  }

  const limits = {
    intensity: preferences.study.intensity,
    daily_limit_min: preferences.study.weekday_daily_limit_min,
    weekend_daily_limit_min: preferences.study.weekend_daily_limit_min,
    max_continuous_minutes: preferences.study.max_continuous_minutes,
    max_study_blocks_per_day: preferences.study.max_study_blocks_per_day,
    evening_latest_end: preferences.study.evening_latest_end,
    evening_study_minutes: preferences.study.evening_study_minutes,
    buffer_min: preferences.study.buffer_min,
    rest_daily_minutes: preferences.rest.enabled ? preferences.rest.daily_minutes : 0,
  };

  const first = decideFirstAction({ clock, ongoing, window, gap, nextWindow, tasks: activeViews, sequence, plannedNow });
  const afterCurrent = decideNextAfter({ clock, ongoing, window, gap, sequence, tasks: activeViews });

  return {
    generated_at: new Date().toISOString(),
    now: clock,
    week: weekInfo,
    confidence: timetableKnown && pool.complete !== false ? 'grounded' : 'estimated',
    data_status: {
      timetable_known: timetableKnown,
      tasks_complete: pool.complete !== false,
      tasks_sources_read: pool.sources_read || { ecourse: false, rain: false },
      estimate_only: estimateOnly,
      caveats,
      pending: pendingList.slice(0, 6),
      overrides: {
        courses: overridesSummary(overrides).courses,
        cancelled: overridesSummary(overrides).cancellations,
        manual_tasks: overridesSummary(overrides).tasks,
        external_hidden: completedLocal.length,
        external_deferred: deferred.length,
      },
    },
    current: ongoing
      ? {
          status: 'occupied',
          title: ongoing.item.title,
          kind: describeSource(ongoing.item),
          source: ongoing.item.source,
          start: ongoing.item.start,
          end: ongoing.item.end,
          ends_in_minutes: ongoing.remaining,
          detail: ongoing.item.detail || null,
          evidence: ongoing.item.evidence || null,
          also: ongoing.also,
        }
      : {
          status: window ? 'free' : gap ? 'between' : nextWindow ? 'before_start' : 'day_over',
          title: window
            ? '现在没有课，是自由时间'
            : gap
              ? `现在到 ${gap.start} 之前没有整块空档`
              : nextWindow
                ? `现在还没有可用的整块时间，${nextWindow.start} 开始`
                : '今天的可用时间已经结束',
          kind: null,
          source: null,
          start: null,
          end: null,
          ends_in_minutes: null,
          detail: null,
          evidence: null,
          also: [],
        },
    window: window
      ? {
          start: window.start,
          end: window.end,
          minutes: window.minutes,
          enough_for_block: window.minutes >= MIN_BLOCK_MINUTES,
          short: window.minutes < MIN_BLOCK_MINUTES,
          note:
            plannedNow
              ? `从现在起连续可用 ${minutesText(plannedNow.minutes)}（${window.start}-${plannedNow.end}），之后按计划切到休息或下一项`
              : window.minutes >= MIN_BLOCK_MINUTES
              ? `从现在起有 ${minutesText(window.minutes)} 可用（${window.start}-${window.end}）`
              : first.task
                ? `从现在起有 ${minutesText(window.minutes)} 可用（${window.start}-${window.end}）：先推进「${first.task.title}」，剩余自动接到下一段`
                : `从现在起只剩 ${minutesText(window.minutes)}（${window.start}-${window.end}），没有明确任务：做能随时停下的轻量事（整理笔记、回消息、预习下一节）`,
          next: nextWindow,
        }
      : {
          start: null,
          end: null,
          minutes: 0,
          enough_for_block: false,
          short: true,
          note: nextWindow
            ? `${ongoing ? `现在在「${ongoing.item.title}」里，` : ''}下一个空档是 ${nextWindow.start}-${nextWindow.end}（${minutesText(
                nextWindow.minutes
              )}）`
            : gap
              ? `现在被「${gap.title}」占住，${gap.start} 之后才有空档；这之前的碎片时间不要指望能推进主任务`
              : '今天的可用时段已经用完，不再安排新任务',
          next: nextWindow,
        },
    first_action: first,
    next_after_current: afterCurrent,
    tasks: {
      p0: allViews.filter((item) => item.priority === 'P0'),
      p1: allViews.filter((item) => item.priority === 'P1'),
      p2: allViews.filter((item) => item.priority === 'P2'),
      p3: allViews.filter((item) => item.priority === 'P3'),
      total: allViews.length,
    },
    overdue,
    completed_local: completedLocal,
    deferred,
    sequence,
    limits,
    footer: FOOTER,
  };
}

/**
 * 正在进行的占用，文案必须按类型说，不能一律叫"先上课"。
 * 判断顺序：手工课程仍算上课；个人事项 / 固定事项 / 用餐 / 运动 / 休息各有自己的说法。
 */
function occupiedCopy(item) {
  const origin = item && item.origin;
  const source = origin === 'user-course' ? 'class' : origin === 'user-personal' ? 'personal' : (item && item.source) || 'fixed';
  switch (source) {
    case 'class':
    case 'user':
      return {
        type: 'continue_class',
        verb: '先上课',
        goType: 'go_to_class',
        goVerb: '先去上课',
        detailTail: '这期间不要另开任务，课上先记下要补的点。',
        nextPrefix: '下课',
      };
    case 'personal':
      return {
        type: 'handle_personal',
        verb: '先处理个人安排',
        goType: 'go_to_personal',
        goVerb: '先去处理个人安排',
        detailTail: '先把这件事处理完，再回到学习任务；别在中间插新的学习块。',
        nextPrefix: '处理完',
      };
    case 'fixed':
      return {
        type: 'handle_fixed',
        verb: '先处理固定事项',
        goType: 'go_to_fixed',
        goVerb: '先去处理固定事项',
        detailTail: '固定事项先处理完，这之前不要开新任务。',
        nextPrefix: '结束后',
      };
    case 'meal':
      return {
        type: 'have_meal',
        verb: '先用餐',
        goType: 'go_to_meal',
        goVerb: '先去用餐',
        detailTail: '先吃饭，吃完再安排任务；不要把用餐时间挪去学习。',
        nextPrefix: '吃完',
      };
    case 'exercise':
      return {
        type: 'do_exercise',
        verb: '先运动',
        goType: 'go_to_exercise',
        goVerb: '先去运动',
        detailTail: '按计划练完，不要用学习把运动挤掉。',
        nextPrefix: '练完',
      };
    case 'rest':
      return {
        type: 'take_rest',
        verb: '先休息',
        goType: 'go_to_rest',
        goVerb: '先去休息',
        detailTail: '这段时间用来休息，不要开新任务。',
        nextPrefix: '休息完',
      };
    default:
      return {
        type: 'handle_occupied',
        verb: '先处理当前事项',
        goType: 'go_to_next',
        goVerb: '先去处理下一件事',
        detailTail: '这件事没结束之前不要开新任务。',
        nextPrefix: '结束后',
      };
  }
}

/** 唯一的第一动作：只给一条，不给"你可以…也可以…" */
function decideFirstAction({ clock, ongoing, window, gap, nextWindow, tasks, sequence, plannedNow }) {
  if (ongoing) {
    const after = sequence.find(
      (row) => row.kind === 'task' && `${row.date} ${row.start}` >= `${clock.date} ${ongoing.item.end}`
    );
    const copy = occupiedCopy(ongoing.item);
    const kindLabel = describeSource(ongoing.item);
    return {
      type: copy.type,
      headline: `${copy.verb}：${ongoing.item.title}（${kindLabel}，到 ${ongoing.item.end}）`,
      detail: `还有 ${minutesText(ongoing.remaining)}。${copy.detailTail}`,
      starts_at: ongoing.item.start,
      ends_at: ongoing.item.end,
      task: null,
      next_hint: after
        ? `${copy.nextPrefix}后做「${after.title}」（${after.start}-${after.end}）`
        : nextWindow
          ? `${copy.nextPrefix}后的下一个空档是 ${nextWindow.start}-${nextWindow.end}（${minutesText(nextWindow.minutes)}）`
          : `${copy.nextPrefix}后今天没有整块空档`,
    };
  }

  const top = tasks[0] || null;
  // 距下一件固定占用（上课 / 个人事项 / 用餐 / 运动）不足 GO_SOON_MINUTES 时，
  // 这段时间连一个 45 分钟的块都放不下，开任务必然被打断：
  // 第一动作直接给"先去上课（14:30-16:10）"，而不是"做点轻量的事"。
  if (gap && gap.start_min !== undefined && gap.start_min - clock.minutes <= GO_SOON_MINUTES) {
    const copy = occupiedCopy({ source: gap.source, origin: gap.origin });
    const after = sequence.find((row) => row.kind === 'task' && `${row.date} ${row.start}` >= `${clock.date} ${gap.start}`);
    return {
      type: copy.goType,
      headline: `${copy.goVerb}：${gap.title}（${gap.start}-${gap.end}）`,
      detail: `还有 ${minutesText(gap.start_min - clock.minutes)}，够走到教室/准备，不必再开任务。${copy.detailTail}`,
      starts_at: gap.start,
      ends_at: gap.end,
      task: null,
      next_hint: after
        ? `${copy.nextPrefix}后做「${after.title}」（${after.start}-${after.end}）`
        : nextWindow
          ? `${copy.nextPrefix}后的下一个空档是 ${nextWindow.start}-${nextWindow.end}（${minutesText(nextWindow.minutes)}）`
          : `${copy.nextPrefix}后今天没有整块空档`,
    };
  }

  if (window && window.minutes >= MIN_BLOCK_MINUTES) {
    const availableMinutes = plannedNow ? plannedNow.minutes : window.minutes;
    const fits = top && top.estimated_minutes <= availableMinutes;
    const target = fits ? top : top;
    const actionEnd = plannedNow ? plannedNow.end : fits ? toClock(clock.minutes + target.estimated_minutes) : window.end;
    if (!target) {
      return {
        type: 'study_free',
        headline: `现在开始自习到 ${window.end}（${minutesText(window.minutes)}）`,
        detail: '当前没有待办任务：这段时间用来复习当天的课、整理笔记。',
        starts_at: window.start,
        ends_at: window.end,
        task: null,
        next_hint: window.next ? `之后 ${window.next.start}-${window.next.end} 还有一段空档` : null,
      };
    }
    return {
      type: 'start_task',
      headline: `现在开始：${target.title}（${window.start}-${actionEnd}）`,
      detail: plannedNow
        ? `${target.priority}｜任务共 ${target.estimated_minutes} 分钟，本段 ${minutesText(
            plannedNow.minutes
          )}${
            plannedNow.task.part_count > 1
              ? `（第 ${plannedNow.task.part_index}/${plannedNow.task.part_count} 段，后续自动接上）`
              : ''
          }；${target.priority_basis || '按当前优先级安排'}${target.needs_confirmation ? '；截止时间待确认' : ''}`
        : fits
          ? `${target.priority}｜预计 ${target.estimated_minutes} 分钟，放得进这 ${minutesText(availableMinutes)}；${target.reason}`
          : `${target.priority}｜预计 ${target.estimated_minutes} 分钟，比现在这 ${minutesText(
              availableMinutes
            )} 长：先做能收尾的一段，剩下的接着排到 ${nextWindow ? `${nextWindow.start}-${nextWindow.end}` : '下一个空档'}；${target.reason}`,
      starts_at: window.start,
      ends_at: actionEnd,
      task: target,
      next_hint: nextWindow ? `之后 ${nextWindow.start}-${nextWindow.end} 还有 ${minutesText(nextWindow.minutes)}` : null,
    };
  }

  // 有明确任务时，10 分钟以上就可以立即开始，并按当前窗口先做一段；
  // 不要求必须先有一个 45/90 分钟的“完整空档”。
  if (window && window.minutes >= MIN_TASK_START_MINUTES && top) {
    const partial = top.estimated_minutes > window.minutes;
    return {
      type: 'start_task',
      headline: `现在开始：${top.title}（${window.start}-${window.end}）`,
      detail: partial
        ? `${top.priority}｜任务预计 ${top.estimated_minutes} 分钟，当前先连续做 ${minutesText(
            window.minutes
          )}；剩余 ${minutesText(top.estimated_minutes - window.minutes)} 自动接到后续可用时段。${top.reason}`
        : `${top.priority}｜当前窗口足够开始，完成后自动安排下一项。${top.reason}`,
      starts_at: window.start,
      ends_at: window.end,
      task: top,
      next_hint: partial
        ? nextWindow
          ? `这段结束后，${nextWindow.start}-${nextWindow.end} 继续`
          : '当前任务余量留到下一个可用窗口'
        : nextWindow
          ? `之后 ${nextWindow.start}-${nextWindow.end} 还有 ${minutesText(nextWindow.minutes)}`
          : null,
    };
  }

  if (window && window.minutes >= SHORT_BLOCK_MINUTES) {
    return {
      type: 'short_window',
      headline: `现在只剩 ${minutesText(window.minutes)}（到 ${window.end}），做轻量推进`,
      detail: top
        ? `不够开「${top.title}」（预计 ${top.estimated_minutes} 分钟）：先做它的准备动作（打开资料、列提纲、把要看的部分标出来），到点就停。`
        : '不够开新任务：整理笔记、回消息、预习下一节。',
      starts_at: window.start,
      ends_at: window.end,
      task: top,
      next_hint: nextWindow
        ? `${nextWindow.start}-${nextWindow.end} 有 ${minutesText(nextWindow.minutes)}，那一段再开主任务`
        : '今天没有更长的空档了，主任务顺延到明天',
    };
  }

  if (window) {
    return {
      type: 'too_short',
      headline: `现在只剩 ${minutesText(window.minutes)}（到 ${window.end}），不要开新任务`,
      detail: '这点时间只够收拾和切换：保存进度、准备下一次要用的材料，然后休息一下。',
      starts_at: window.start,
      ends_at: window.end,
      task: null,
      next_hint: nextWindow
        ? `${nextWindow.start}-${nextWindow.end} 有 ${minutesText(nextWindow.minutes)}，那时再开始`
        : '今天没有更长的空档了',
    };
  }

  // 现在没有可用空档，但之后还有一段：先等，不要在碎片里开任务
  if (nextWindow) {
    return {
      type: 'wait_for_window',
      headline: `现在没有整块空档，${nextWindow.start} 开始：${
        top ? `${top.title}（${minutesText(top.estimated_minutes)}）` : '自由学习'
      }`,
      detail: `下一个空档 ${nextWindow.start}-${nextWindow.end}（${minutesText(
        nextWindow.minutes
      )}）${top ? `，先做 ${top.priority} 的「${top.title}」` : '，用来复习或整理笔记'}。这之前的时间不要开新任务。`,
      starts_at: nextWindow.start,
      ends_at: nextWindow.end,
      task: top,
      next_hint: null,
    };
  }

  if (gap) {
    return {
      type: 'blocked',
      headline: `现在被「${gap.title}」占着（到 ${gap.end}），${gap.start} 之后再说`,
      detail: top ? `下一个空档先做「${top.title}」（${top.priority}，预计 ${top.estimated_minutes} 分钟）。` : '下一个空档再安排任务。',
      starts_at: null,
      ends_at: gap.end,
      task: top,
      next_hint: `${gap.start} 之后的下一个空档开始排`,
    };
  }

  return {
    type: 'day_over',
    headline: '今天的时间用完了，收工',
    detail: tasks.length ? `剩下的 ${tasks.length} 条待办顺延到明天，明早第一件事做「${tasks[0].title}」。` : '没有待办，安心休息。',
    starts_at: null,
    ends_at: null,
    task: tasks[0] || null,
    next_hint: null,
  };
}

function decideNextAfter({ clock, ongoing, window, gap, sequence, tasks }) {
  const upcoming = sequence.filter((row) => row.kind === 'task');
  if (ongoing) {
    const edge = `${clock.date} ${ongoing.item.end}`;
    const after = upcoming.find((row) => `${row.date} ${row.start}` >= edge);
    if (after) return { title: after.title, start: after.start, end: after.end, date: after.date, minutes: after.minutes };
  } else if (window) {
    const edge = `${clock.date} ${window.end}`;
    const after = upcoming.find((row) => `${row.date} ${row.start}` >= edge);
    if (after) return { title: after.title, start: after.start, end: after.end, date: after.date, minutes: after.minutes };
  } else if (gap) {
    const edge = `${clock.date} ${gap.start}`;
    const after = upcoming.find((row) => `${row.date} ${row.start}` >= edge);
    if (after) return { title: after.title, start: after.start, end: after.end, date: after.date, minutes: after.minutes };
  }
  if (tasks.length) {
    const first = tasks[0];
    return {
      title: first.title,
      start: null,
      end: null,
      date: null,
      minutes: first.estimated_minutes,
      note: '本周推荐时段已排满，这条还没落到具体时段',
    };
  }
  return null;
}

// ---------- 输出 ----------

function buildMarkdown(view) {
  const lines = [];
  const { now, current, window, first_action: first, tasks } = view;
  lines.push(`# 现在该干什么（${now.display} ${now.weekday}）`);
  lines.push('');
  if (view.week) {
    const week = view.week;
    if (week.number) {
      lines.push(`- 教学周：第 ${week.number} 周（${week.source || '来源未标注'}）`);
      if (week.filter && week.filter.applied) {
        lines.push(
          `- 课表按周次过滤：本周保留 ${week.filter.courses_kept} 段，不上 ${week.filter.sessions_skipped} 段`
        );
      }
    } else {
      lines.push('- 教学周：**未确认**（带周次范围的课按"可能发生"计入，本周课表不是精确结果）');
    }
    lines.push('');
  }
  if (view.data_status.estimate_only) {
    lines.push(`> **部分数据 / 估算**：${view.data_status.caveats.join('；') || '数据不完整'}`);
    lines.push('> 下面的时间是按现有数据推算的，补齐后再看一次会更准。');
    lines.push('');
  }
  lines.push('## 一句话');
  lines.push('');
  lines.push(`**${first.headline}**`);
  lines.push('');
  lines.push(first.detail);
  if (first.next_hint) lines.push('');
  if (first.next_hint) lines.push(`接下来：${first.next_hint}`);
  lines.push('');

  lines.push('## 1. 现在的位置');
  lines.push('');
  if (current.status === 'occupied') {
    lines.push(`- 正在进行：**${current.title}**（${current.kind}）${current.start}-${current.end}，还有 ${minutesText(current.ends_in_minutes)}`);
    if (current.detail) lines.push(`- 详情：${current.detail}`);
    if (current.also.length) lines.push(`- 同时占用：${current.also.map((item) => `${item.title}（${item.start}-${item.end}）`).join('、')}`);
  } else if (current.status === 'free') {
    lines.push('- 现在没有课，也没有固定事项占用。');
  } else if (current.status === 'between') {
    lines.push(`- ${current.title}`);
  } else if (current.status === 'before_start') {
    lines.push(`- ${current.title}`);
  } else {
    lines.push('- 今天的可用时段已经结束。');
  }
  lines.push('');

  lines.push('## 2. 当前可用窗口');
  lines.push('');
  lines.push(`- ${window.note}`);
  if (window.start && window.next) {
    lines.push(`- 之后一段：${window.next.start}-${window.next.end}（${minutesText(window.next.minutes)}）`);
  } else if (window.start) {
    lines.push('- 今天之后没有更长的空档了。');
  }
  lines.push('');

  lines.push('## 3. 待办（按主次）');
  lines.push('');
  if (!tasks.total) {
    lines.push('- 当前没有未完成的待办。');
    lines.push('');
  } else {
    const bucket = [
      ['P0', tasks.p0, '必须优先（已过期 / 今天明天截止）'],
      ['P1', tasks.p1, '本周要推进'],
      ['P2', tasks.p2, '时间充裕，排在后面'],
      ['P3', tasks.p3, '不急'],
    ];
    for (const [name, list, hint] of bucket) {
      if (!list.length) continue;
      lines.push(`### ${name}（${list.length} 条）— ${hint}`);
      lines.push('');
      for (const item of list) {
        const meta = [
          `来源 ${item.sources.join(' + ')}`,
          item.course ? `课程 ${item.course}` : null,
          `截止 ${item.deadline_display}`,
          `预计 ${item.estimated_minutes} 分钟${item.estimated_by_system ? '（系统估的）' : ''}`,
          `置信度 ${item.confidence}`,
        ].filter(Boolean);
        lines.push(`- **${item.title}** — ${meta.join('｜')}`);
        lines.push(`  - 为什么现在：${item.reason}`);
        if (item.confirm_reasons.length) lines.push(`  - 待确认：${item.confirm_reasons.join('；')}`);
      }
      lines.push('');
    }
  }

  lines.push('## 4. 从这里开始的顺序与时段');
  lines.push('');
  if (!view.sequence.length) {
    lines.push('- 从现在到本周结束没有可排的学习时段。');
  } else {
    lines.push('| 时间 | 内容 | 说明 |');
    lines.push('|---|---|---|');
    for (const row of view.sequence) {
      const dateLabel = row.date === now.date ? row.start : `${row.date} ${row.start}`;
      const label = row.kind === 'rest' ? '休息' : row.kind === 'task' ? `作业：${row.title}` : row.title;
      const note = row.kind === 'rest' ? row.reason || '按你的休息目标' : row.priority ? `${row.priority}｜${row.reason || ''}` : row.reason || '';
      lines.push(`| ${dateLabel}-${row.end} | ${label} | ${note} |`);
    }
    lines.push('');
    lines.push(
      `- 节奏约束：单块不超过 ${view.limits.max_continuous_minutes} 分钟、每天最多 ${view.limits.max_study_blocks_per_day} 块、晚间最晚到 ${view.limits.evening_latest_end}，任务之间留 ${view.limits.buffer_min} 分钟缓冲，休息按每天 ${view.limits.rest_daily_minutes} 分钟补足。`
    );
  }
  lines.push('');

  lines.push('## 5. 已过期 / 已完成（本地） / 已延后');
  lines.push('');
  lines.push('**已过期未完成**（要不要还做，需要你定）：');
  if (view.overdue.length) {
    for (const item of view.overdue) lines.push(`- ${item.title}（${item.sources.join('/')}，截止 ${item.deadline}）`);
  } else {
    lines.push('- 无');
  }
  lines.push('');
  lines.push('**已标记完成（只记在本地，学校平台未变）**：');
  if (view.completed_local.length) {
    for (const item of view.completed_local) lines.push(`- ${item.title}（${item.sources.join('/')}｜${item.evidence || '本地记录'}）`);
  } else {
    lines.push('- 无');
  }
  lines.push('');
  lines.push('**已延后**：');
  if (view.deferred.length) {
    for (const item of view.deferred) lines.push(`- ${item.title}（${item.sources.join('/')}，${item.deferred_until} 之前不排）`);
  } else {
    lines.push('- 无');
  }
  lines.push('');

  lines.push('## 6. 数据说明');
  lines.push('');
  lines.push(`- 课表：${view.data_status.timetable_known ? '已读取' : '**未读取**（当前时间只是按偏好估算）'}`);
  lines.push(
    `- 任务：${view.data_status.tasks_complete ? '完整' : '**不完整**'}；eCourse ${view.data_status.tasks_sources_read.ecourse ? '已读' : '未读'} / 雨课堂 ${view.data_status.tasks_sources_read.rain ? '已读' : '未读'}`
  );
  lines.push(`- 学习强度：${view.limits.intensity}；工作日上限 ${view.limits.daily_limit_min} 分钟 / 周末 ${view.limits.weekend_daily_limit_min} 分钟`);
  for (const caveat of view.data_status.caveats) lines.push(`- ⚠️ ${caveat}`);
  for (const pending of view.data_status.pending.slice(0, 3)) lines.push(`- 待确认：${pending}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(view.footer);
  return lines.join('\n');
}

function main() {
  const clock = nowContext();

  // 初始化闸门：没走完初始化就没有"精确的现在该干什么"，只有一段估算。
  // 这里直接拒绝出结果，避免"新用户第一次问就被当成老用户"这种假精确。
  // --allow-partial 只放宽 partial（用户自己愿意先用现有数据），uninitialized 永远不放宽。
  const setup = readSetupState();
  const allowPartial = hasFlag('--allow-partial');
  if (setup.state !== 'completed' && !(setup.state === 'partial' && allowPartial)) {
    const missing = [...(setup.missing || []), ...(setup.partial || [])].filter(Boolean).slice(0, 4);
    console.log(`SETUP_REQUIRED:${setup.state}`);
    if (missing.length) console.log(`SETUP_MISSING:${missing.join('；')}`);
    console.log(
      setup.state === 'uninitialized'
        ? 'SETUP_HINT:还没有完成初始化：先介绍能力并引导初始化，不要用现在这一刻算计划。'
        : 'SETUP_HINT:初始化只差一步：先说清缺哪一平台/哪一步，只给一条恢复命令；用户同意先用现有数据时再加 --allow-partial。'
    );
    console.log('SETUP_NOTE:本次未生成 now.json / now.md');
    process.exit(3);
  }

  const outputDir = path.resolve(arg('--output-dir', defaultOutputDir()));
  fs.mkdirSync(outputDir, { recursive: true });

  const loaded = loadAnalysis({ clock, outputDir });
  const analysis = loaded.doc;
  const analysisPath = loaded.path;
  const reused = loaded.reused;

  const prefsRead = readPreferences();
  const preferences = prefsRead.exists
    ? prefsRead.preferences
    : normalizePreferences({}).preferences;
  const { overrides } = readOverrides();

  const view = buildNow({ analysis, preferences, overrides, clock });
  // 新鲜度：时间相关回答必须基于刚刚算出来的结果
  const analysisAge = analysisAgeMs(analysis, analysisPath);
  view.readiness = analysis && analysis.readiness ? analysis.readiness : { ready: true, blockers: [], estimate_only: false };
  view.freshness = {
    analysis_at: (analysis && (analysis.generated_at || analysis.checked_at)) || null,
    age_seconds: analysisAge === null ? null : Math.round(analysisAge / 1000),
    stale: analysisAge !== null && analysisAge > STALE_ANALYSIS_MS,
    recomputed: Boolean(loaded.stale_recomputed || !reused),
    max_age_seconds: Math.round(STALE_ANALYSIS_MS / 1000),
  };
  view.brief = buildBrief(view);
  // 状态要能追溯：partial 下用 --allow-partial 跑出来的结果必须一眼看出"这是估算口径"
  view.setup = {
    state: setup.state,
    completed_at: setup.completed_at,
    missing: [...(setup.missing || []), ...(setup.partial || [])].filter(Boolean).slice(0, 4),
    partial_override: setup.state === 'partial',
  };
  view.inputs = {
    analysis: displayPath(analysisPath),
    analysis_reused: reused,
    preferences: prefsRead.exists ? 'personal' : 'defaults',
    now_source: clock.source,
  };

  const jsonPath = path.join(outputDir, 'now.json');
  const mdPath = path.join(outputDir, 'now.md');
  fs.writeFileSync(jsonPath, JSON.stringify(view, null, 2), 'utf8');
  fs.writeFileSync(mdPath, buildMarkdown(view), 'utf8');
  const dashboardNowPath = publishDashboardSnapshot(jsonPath);

  console.log(`NOW_JSON:${displayPath(jsonPath)}`);
  console.log(`NOW_MD:${displayPath(mdPath)}`);
  console.log(`DASHBOARD_NOW:${displayPath(dashboardNowPath)}`);
  console.log(`NOW_HEADLINE:${view.first_action.headline}`);
  console.log(`NOW_BRIEF:${view.brief}`);
  console.log(
    `NOW_SUMMARY:state=${view.current.status} window=${view.window.minutes} task=${view.first_action.task ? view.first_action.task.title : '-'} p0=${view.tasks.p0.length} p1=${view.tasks.p1.length} p2=${view.tasks.p2.length} overdue=${view.overdue.length} done_local=${view.completed_local.length} deferred=${view.deferred.length} estimate=${view.data_status.estimate_only ? 1 : 0}`
  );
  if (hasFlag('--json')) console.log(JSON.stringify(view, null, 2));
  return { view, jsonPath, mdPath };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`NOW_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exit(1);
  }
}

module.exports = { STALE_ANALYSIS_MS, buildBrief, buildNow, buildMarkdown, main, nowContext };
