'use strict';

/**
 * 用户覆盖层的命令行入口：把"加一节实验课 / 本周停课 / 加个任务 / 完成了 / 延后"落盘。
 *
 * 自然语言解析由专家层（智能体）完成，这个脚本只接受明确的参数，不调用任何云端模型。
 * 所有命令都只写本地匿名时间数据：<HUAYUAN_HOME>/user-overrides.json
 *
 * 任务状态分两种：
 *   - 手工任务（tasks）：本地新建的待办，直接改自己的 status
 *   - 平台任务（external_tasks）：雨课堂 / eCourse 上的作业，只在本地记一条"完成/延后"，
 *     不上传、不提交、不写回学校平台；用 source+course+title+deadline 指纹认任务
 *
 * 用法：
 *   node manage-items.js add-course --title "编译原理实验" --weekday 6 --week 10 --start 09:00 --end 11:00
 *   node manage-items.js add-course --title "补课：高数" --date 2026-11-03 --start 19:00 --end 20:40
 *   node manage-items.js add-task --title "交报告" --deadline "2026-11-01 23:59" --minutes 60 --priority P1
 *   node manage-items.js add-personal --title "家人来访" --date 2026-10-31 --start 14:00 --end 17:00
 *   node manage-items.js cancel-course --title "高级语言程序设计" --weekday 5 --weeks current
 *   node manage-items.js done --title "交报告"
 *   node manage-items.js done --title "Homework 5" --source 雨课堂
 *   node manage-items.js defer --title "Discussion" --until 明天
 *   node manage-items.js remove --id ut-001
 *   node manage-items.js list
 *   node manage-items.js week --timetable ../jw-timetable.json   # 识别当前教学周（只读，不写文件）
 *   node manage-items.js set-week --number 10                    # 用户确认后保存
 *   node manage-items.js set-college --name 软件学院             # 保存学院，活动推送会追加该学院来源
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { argValue, defaultOutputDir, displayPath, flag } = require('./huayuan-paths');
const { resolveWeek, saveSemesterWeek } = require('./semester-week');
const { collegeByInput } = require('./colleges');
const {
  eventKey,
  isHardFixedEvent,
  legacyFixedEventQuestion,
  markLegacyAsked,
  normalizePreferences,
  readPreferences,
  writePreferences,
} = require('./preferences');
const {
  WEEKDAY_NAMES,
  currentWeekNumber,
  describeRule,
  emptyOverrides,
  expandForWeek,
  isDateText,
  nextId,
  overridesPath,
  parseDeadline,
  readOverrides,
  readState,
  recordAction,
  statePath,
  summary,
  taskFingerprintKeys,
  writeOverrides,
  writeState,
} = require('./user-overrides');

const ARGV = process.argv;
const arg = (name, fallback = null) => argValue(ARGV, name, fallback);
const hasFlag = (name) => flag(ARGV, name);

function fail(code, message) {
  console.error(`${code}:${message}`);
  process.exit(2);
}

function todayString(offsetDays = 0) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 今天(周一=1..周日=7) */
function todayWeekday() {
  return ((new Date().getDay() + 6) % 7) + 1;
}

/**
 * "明天 / 后天 / 今天 / 周五 / 2026-11-01" 都收；认不出就返回 null。
 * 周几按"下一个该星期几（含今天）"算，绝不猜成已经过去的日期。
 */
function resolveUntil(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (isDateText(value)) return value;
  if (/^(今天|today)$/i.test(value)) return todayString(0);
  if (/^(明天|tomorrow)$/i.test(value)) return todayString(1);
  if (/^(后天)$/.test(value)) return todayString(2);
  const weekday = WEEKDAY_NAMES.indexOf(value) + 1;
  if (weekday > 0) {
    const offset = (weekday - todayWeekday() + 7) % 7;
    return todayString(offset);
  }
  return null;
}

/** 从参数里取出"这条记录在什么时候发生"的定位信息 */
function ruleFromArgs() {
  return {
    date: arg('--date', null),
    weekday: arg('--weekday', null),
    week: arg('--week', null),
    weeks: arg('--weeks', null),
    start_week: arg('--start-week', null),
    end_week: arg('--end-week', null),
    parity: arg('--parity', null),
  };
}

function requireTitle() {
  const title = arg('--title', null);
  if (!title || !String(title).trim()) fail('MISSING_TITLE', '缺少 --title（要加/改的是哪一门课或哪件事）');
  return String(title).trim();
}

function normalizeTimeArg(name) {
  const value = arg(name, null);
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) fail('INVALID_TIME', `${name} 需要 HH:mm（收到 ${value}）`);
  return `${String(match[1]).padStart(2, '0')}:${match[2]}`;
}

function loadOverrides() {
  return readOverrides().overrides;
}

/**
 * 统一落盘：写覆盖层 + 记一条动作到状态层，并打印机器可读结果。
 * 只写这一次，避免同一份数据被写两遍（两次写就有两次规范化，容易出难查的差异）。
 */
function save(overrides, action, extra = {}) {
  const saved = writeOverrides(overrides);
  recordAction({ action, ...extra });
  const all = [
    ...saved.courses,
    ...saved.cancellations,
    ...saved.tasks,
    ...saved.external_tasks,
    ...saved.personal,
  ];
  const item = extra.id ? all.find((entry) => entry.id === extra.id) || null : null;
  const out = {
    action,
    path: displayPath(overridesPath()),
    item,
    summary: summary(saved),
  };
  console.log(`MANAGE_ITEMS_OK:${JSON.stringify(out)}`);
  return out;
}

// ---------- add-course ----------

function cmdAddCourse() {
  const title = requireTitle();
  const start = normalizeTimeArg('--start');
  const end = normalizeTimeArg('--end');
  if (!start || !end) fail('MISSING_TIME', '--start 与 --end 必填（HH:mm）');
  const rule = ruleFromArgs();
  if (!rule.date && !rule.weekday) {
    fail('MISSING_TARGET', '用 --date 2026-11-07 指定某一天，或用 --weekday 6 + --week 10 指定周次');
  }
  const overrides = loadOverrides();
  const id = nextId(overrides, 'uc');
  overrides.courses.push({
    id,
    title,
    date: rule.date,
    weekday: rule.weekday,
    week: rule.week,
    weeks: rule.weeks,
    start_week: rule.start_week,
    end_week: rule.end_week,
    parity: rule.parity,
    start,
    end,
    location: arg('--location', null),
    teacher: arg('--teacher', null),
    kind: arg('--kind', 'extra'),
    note: arg('--note', null),
    source: 'user',
    created_at: new Date().toISOString(),
  });
  const out = save(overrides, 'add-course', { id, title });
  const item = out.item;
  console.log(`ADDED_COURSE:${item.id} ${item.title} ${describeRule(item)} ${item.start}-${item.end}`);
  return out;
}

// ---------- add-task ----------

function cmdAddTask() {
  const title = requireTitle();
  const deadlineRaw = arg('--deadline', arg('--due', null));
  const deadline = parseDeadline(deadlineRaw);
  if (deadlineRaw && !deadline.iso) {
    fail('INVALID_DEADLINE', `--deadline 认不出（收到 ${deadlineRaw}）；用 "2026-11-01 23:59" 或 "11月1日 23:59"`);
  }
  const overrides = loadOverrides();
  const id = nextId(overrides, 'ut');
  overrides.tasks.push({
    id,
    title,
    course: arg('--course', null),
    deadline: deadline.iso,
    estimated_minutes: arg('--minutes', null),
    priority: arg('--priority', 'P2'),
    movable: arg('--movable', null) === 'false' ? false : true,
    status: 'open',
    note: arg('--note', null),
    source: 'user',
    created_at: new Date().toISOString(),
  });
  const out = save(overrides, 'add-task', { id, title });
  const item = out.item;
  console.log(
    `ADDED_TASK:${item.id} ${item.title} 截止=${item.deadline_display} 预计=${
      item.estimated_minutes || '未给'
    }分钟 优先级=${item.priority}`
  );
  return out;
}

// ---------- add-personal ----------

function cmdAddPersonal() {
  const title = requireTitle();
  const start = normalizeTimeArg('--start');
  const end = normalizeTimeArg('--end');
  if (!start || !end) fail('MISSING_TIME', '--start 与 --end 必填（HH:mm）');
  const rule = ruleFromArgs();
  if (!rule.date && !rule.weekday) fail('MISSING_TARGET', '用 --date 指定某一天，或用 --weekday 指定每周');
  const overrides = loadOverrides();
  const id = nextId(overrides, 'up');
  overrides.personal.push({
    id,
    title,
    date: rule.date,
    weekday: rule.weekday,
    week: rule.week,
    weeks: rule.weeks,
    start_week: rule.start_week,
    end_week: rule.end_week,
    parity: rule.parity,
    start,
    end,
    note: arg('--note', null),
    source: 'user',
    created_at: new Date().toISOString(),
  });
  const out = save(overrides, 'add-personal', { id, title });
  const item = out.item;
  console.log(`ADDED_PERSONAL:${item.id} ${item.title} ${describeRule(item)} ${item.start}-${item.end}`);
  return out;
}

// ---------- cancel-course ----------

function cmdCancelCourse() {
  const title = requireTitle();
  const overrides = loadOverrides();
  const rule = ruleFromArgs();
  // 没给周次时默认"本周"：用户说"周五这门课本周停课"，
  // 不能理解成"以后每周五都停"——那会把整学期悄悄改掉。
  const week = rule.week !== null ? rule.week : rule.weeks !== null ? rule.weeks : 'current';
  const id = nextId(overrides, 'cx');
  overrides.cancellations.push({
    id,
    title,
    date: rule.date,
    weekday: rule.weekday,
    week,
    start_week: rule.start_week,
    end_week: rule.end_week,
    parity: rule.parity,
    reason: arg('--reason', '停课'),
    source: 'user',
    created_at: new Date().toISOString(),
  });
  const out = save(overrides, 'cancel-course', { id, title });
  const item = out.item;
  console.log(`CANCELLED_COURSE:${item.id} ${item.title} ${describeRule(item)}`);
  return out;
}

// ---------- 目标定位（done / defer 共用） ----------

function squash(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\s()（）[\]【】《》<>「」"'’,，.。:：!！?？_\-—/\\]/g, '')
    .toLowerCase();
}

/**
 * 找最近一次分析产出的任务池快照。
 * 平台任务的标题只存在于抓取结果里，本地覆盖层没有它们的原文，
 * 所以先看上一轮分析把哪些任务放进了池子，再从池子里认人。
 */
function latestPoolSnapshot() {
  const explicit = arg('--pool', null);
  const files = [];
  if (explicit) files.push(path.resolve(explicit));
  const roots = [path.join(process.cwd(), 'huayuan-output')];
  if (process.env.HUAYUAN_OUTPUT_DIR) roots.push(path.resolve(process.env.HUAYUAN_OUTPUT_DIR));
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'schedule-analysis.json');
      if (fs.existsSync(file)) files.push(file);
    }
  }
  const sorted = files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file } of sorted) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const items = doc && doc.task_pool && Array.isArray(doc.task_pool.items) ? doc.task_pool.items : null;
      if (items) return { path: file, items, generated_at: doc.generated_at || null };
    } catch {
      /* 坏文件跳过，继续往前找 */
    }
  }
  return null;
}

/** 把任务池里的一条转成外部状态记录（保留平台来源证据） */
function externalFromPoolItem(item) {
  const keys = taskFingerprintKeys(item);
  const sources = Array.isArray(item.sources) && item.sources.length ? item.sources : [item.source || 'unknown'];
  return {
    key: keys[0],
    keys,
    source: sources[0],
    sources,
    course: item.course || null,
    title: item.title,
    deadline: item.deadline || null,
    task_type: item.task_type || null,
    platform_evidence: (item.entries || []).map((entry) => ({
      source: entry.source,
      course: entry.course || null,
      title: entry.title,
      deadline_display: entry.deadline_display || null,
    })),
  };
}

function titleMatches(candidate, query) {
  const target = squash(candidate);
  const needle = squash(query);
  if (!target || !needle) return false;
  if (target === needle) return true;
  // 短词不做包含匹配，避免"作业"把整学期的作业都命中
  if (needle.length < 2) return false;
  return target.includes(needle) || (target.length >= 2 && needle.includes(target));
}

/**
 * 平台任务候选：先看已有状态记录（可以二次修改），再看最近一次任务池快照。
 * 只认平台来源的任务；纯手工任务走 tasks 通道，不在这里重复。
 */
function externalCandidates(overrides, { title, source, course }) {
  const out = [];
  const seen = new Set();
  const pushEntry = (entry) => {
    const key = entry.key || (entry.keys && entry.keys[0]);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  for (const entry of overrides.external_tasks || []) {
    if (title && !titleMatches(entry.title, title)) continue;
    if (source && !(entry.sources || [entry.source]).includes(source)) continue;
    if (course && squash(entry.course) !== squash(course)) continue;
    pushEntry(entry);
  }

  const snapshot = latestPoolSnapshot();
  if (snapshot) {
    for (const item of snapshot.items) {
      const sources = Array.isArray(item.sources) && item.sources.length ? item.sources : [item.source];
      if (sources.every((name) => name === 'user')) continue;
      if (title && !titleMatches(item.title, title)) continue;
      if (source && !sources.includes(source)) continue;
      if (course && squash(item.course) !== squash(course)) continue;
      // 已经被标成完成的，不再作为候选（避免 done 之后又被 defer 拽回来）
      const alreadyDone = (overrides.external_tasks || []).some(
        (entry) =>
          entry.status === 'done' &&
          (entry.keys || [entry.key]).some((key) => taskFingerprintKeys(item).includes(key))
      );
      if (alreadyDone) continue;
      pushEntry(externalFromPoolItem(item));
    }
  }
  return { candidates: out, snapshot };
}

/** 写入/更新一条外部状态：同指纹只留一条，重复说"完成"不会堆记录 */
function upsertExternal(overrides, base, patch) {
  if (!Array.isArray(overrides.external_tasks)) overrides.external_tasks = [];
  const baseKeys = base.keys || taskFingerprintKeys(base);
  const existing = overrides.external_tasks.find(
    (entry) =>
      (base.id && entry.id === base.id) ||
      (entry.keys || [entry.key]).some((key) => baseKeys.includes(key))
  );
  if (existing) {
    if (!Array.isArray(existing.keys) || !existing.keys.length) existing.keys = baseKeys;
    Object.assign(existing, patch);
    return existing;
  }
  const record = {
    ...base,
    keys: baseKeys,
    id: nextId(overrides, 'ue'),
    created_at: new Date().toISOString(),
    ...patch,
  };
  overrides.external_tasks.push(record);
  return record;
}

function findUserTasks(overrides, id, title) {
  if (id) return overrides.tasks.filter((item) => item.id === id);
  const text = squash(title);
  if (!text) return [];
  const exact = overrides.tasks.filter((item) => squash(item.title) === text);
  if (exact.length) return exact;
  return overrides.tasks.filter((item) => squash(item.title).includes(text));
}

function describeCandidates(candidates) {
  return candidates
    .map((item) => `${item.id ? `${item.id}:` : ''}${item.title}${item.course ? `（${item.course}）` : ''}`)
    .join('、');
}

/**
 * 解析这次要改哪一条：
 *   手工任务命中就用手工任务；平台任务命中就写外部状态；两边都命中就一起改。
 * 任何一边命中多条都直接报歧义，绝不替用户猜。
 */
function resolveTargets(overrides, { id = null, title = null } = {}) {
  const source = arg('--source', null);
  const course = arg('--course', null);

  if (id) {
    const userHit = overrides.tasks.filter((item) => item.id === id);
    if (userHit.length) return { user: userHit, external: [] };
    const externalHit = (overrides.external_tasks || []).filter((item) => item.id === id);
    if (externalHit.length) return { user: [], external: externalHit };
    fail('TASK_NOT_FOUND', `没有 id=${id} 的任务（手工任务和平台任务状态里都没有；先 list 看看）`);
  }
  if (!title || !String(title).trim()) fail('MISSING_TARGET', '用 --id 或 --title 指定是哪一条任务');

  const userMatched = findUserTasks(overrides, null, title);
  if (userMatched.length > 1) {
    fail(
      'AMBIGUOUS_TASK',
      `「${title}」在手工作业里匹配到 ${userMatched.length} 条：${userMatched
        .map((item) => `${item.id}(${item.title})`)
        .join('、')}；请用 --id 指定`
    );
  }

  const { candidates, snapshot } = externalCandidates(overrides, { title, source, course });
  if (candidates.length > 1) {
    fail(
      'AMBIGUOUS_TASK',
      `「${title}」匹配到 ${candidates.length} 条平台任务：${describeCandidates(
        candidates
      )}；请加 --source 雨课堂/eCourse 或 --course 课程名，或 --id 指定`
    );
  }
  if (!userMatched.length && !candidates.length) {
    const where = snapshot ? `最近一次任务池（${path.basename(path.dirname(snapshot.path))}）` : '本地任务池快照';
    fail(
      'TASK_NOT_FOUND',
      `手工任务与${where}里都没有标题包含「${title}」的任务；先跑一次 schedule-analyze 生成任务池，或用 --title 写全一点`
    );
  }
  return { user: userMatched, external: candidates, snapshot: snapshot || null };
}

// ---------- done ----------

function cmdDone() {
  const overrides = loadOverrides();
  const id = arg('--id', null);
  const title = arg('--title', null);
  const targets = resolveTargets(overrides, { id, title });
  const now = new Date().toISOString();
  const refs = [];
  for (const task of targets.user) {
    task.status = 'done';
    task.completed_at = now;
    task.deferred_until = null;
    refs.push({ kind: 'user', id: task.id, title: task.title });
  }
  for (const entry of targets.external) {
    const saved = upsertExternal(overrides, entry, {
      status: 'done',
      completed_at: now,
      deferred_until: null,
    });
    refs.push({ kind: 'external', id: saved.id, title: saved.title, sources: saved.sources });
  }
  const out = save(overrides, 'done', { id: refs[0] && refs[0].id, title: refs[0] && refs[0].title, targets: refs });
  for (const ref of refs) {
    if (ref.kind === 'user') console.log(`MARKED_DONE:${ref.id} ${ref.title}`);
    else console.log(`MARKED_DONE:${ref.id} ${ref.title}（平台任务，仅本地标记：${(ref.sources || []).join('/')}）`);
  }
  if (refs.some((ref) => ref.kind === 'external')) {
    console.log('LOCAL_ONLY:true 已完成状态只写在本地覆盖层，未提交到雨课堂 / eCourse');
  }
  return out;
}

// ---------- defer ----------

function cmdDefer() {
  const overrides = loadOverrides();
  const id = arg('--id', null);
  const title = arg('--title', null);
  const raw = arg('--until', null);
  const until = resolveUntil(raw);
  if (!until) fail('INVALID_UNTIL', `--until 认不出（收到 ${raw || '空'}）；用 2026-10-29 / 明天 / 后天 / 周五`);
  const targets = resolveTargets(overrides, { id, title });
  const refs = [];
  for (const task of targets.user) {
    task.status = 'deferred';
    task.deferred_until = until;
    task.completed_at = null;
    refs.push({ kind: 'user', id: task.id, title: task.title });
  }
  for (const entry of targets.external) {
    const saved = upsertExternal(overrides, entry, {
      status: 'deferred',
      deferred_until: until,
      completed_at: null,
    });
    refs.push({ kind: 'external', id: saved.id, title: saved.title, sources: saved.sources });
  }
  const out = save(overrides, 'defer', { id: refs[0] && refs[0].id, title: refs[0] && refs[0].title, until, targets: refs });
  for (const ref of refs) {
    if (ref.kind === 'user') console.log(`DEFERRED:${ref.id} ${ref.title} 从 ${until} 起重新排`);
    else
      console.log(
        `DEFERRED:${ref.id} ${ref.title} 从 ${until} 起重新排（平台任务，仅本地标记：${(ref.sources || []).join('/')}）`
      );
  }
  if (refs.some((ref) => ref.kind === 'external')) {
    console.log('LOCAL_ONLY:true 延后状态只写在本地覆盖层，未提交到雨课堂 / eCourse');
  }
  return out;
}

// ---------- remove ----------

function cmdRemove() {
  const overrides = loadOverrides();
  const id = arg('--id', null);
  const type = arg('--type', null);
  if (!id) fail('MISSING_ID', 'remove 需要 --id（先 list 拿到 id）');
  const buckets = [
    ['course', 'courses'],
    ['cancellation', 'cancellations'],
    ['task', 'tasks'],
    ['external', 'external_tasks'],
    ['personal', 'personal'],
  ].filter(([label]) => !type || type === label || (type === 'external-task' && label === 'external'));
  for (const [label, key] of buckets) {
    const before = overrides[key].length;
    overrides[key] = overrides[key].filter((item) => item.id !== id);
    if (overrides[key].length !== before) {
      const out = save(overrides, 'remove', { id, type: label });
      console.log(`REMOVED:${id} (${label})`);
      return out;
    }
  }
  fail('ITEM_NOT_FOUND', `没有 id=${id} 的记录（先 list 看看）`);
  return null;
}

// ---------- set-week ----------

function cmdSetWeek() {
  const raw = arg('--number', arg('--week', null));
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) fail('MISSING_WEEK', '--number 需要正整数，例如 10');
  const source = arg('--source', '用户确认');
  const saved = saveSemesterWeek({ week: number, source });
  const out = { action: 'set-week', week: saved.week, source: saved.source, path: displayPath(statePath()) };
  console.log(`CURRENT_WEEK:${saved.week}`);
  console.log(`MANAGE_ITEMS_OK:${JSON.stringify(out)}`);
  return out;
}

// ---------- week（当前教学周识别，不写文件） ----------

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

function cmdWeek() {
  const timetableArg = arg('--timetable', null);
  const timetablePath = timetableArg
    ? path.resolve(timetableArg)
    : path.join(defaultOutputDir(), 'jw-timetable.json');
  const campusPath = path.join(defaultOutputDir(), 'campus-sync.json');
  const resolution = resolveWeek({
    explicit: arg('--number', arg('--week', null)),
    timetable: readJson(timetablePath),
    campus: readJson(campusPath),
    now: new Date(),
  });
  console.log(`CURRENT_WEEK:${resolution.week || '-'}`);
  console.log(`WEEK_SOURCE:${resolution.source}`);
  if (resolution.needs_confirmation) {
    console.log('WEEK_NEEDS_CONFIRMATION:1');
    console.log(`  无法从教务数据可靠识别当前教学周，只问用户一次：${resolution.question || '现在是第几周？'}`);
    console.log(`  拿到答案后保存：${resolution.how_to_save || 'node manage-items.js set-week --number N'}`);
  } else {
    console.log('WEEK_NEEDS_CONFIRMATION:0');
    if (resolution.conflict) console.log(`  ${resolution.conflict}`);
  }
  const out = { action: 'week', ...resolution, timetable: displayPath(timetablePath) };
  console.log(`MANAGE_ITEMS_OK:${JSON.stringify(out)}`);
  return out;
}

// ---------- list ----------

function cmdList() {
  const { exists, overrides } = readOverrides();
  const counts = summary(overrides);
  const state = readState();
  const weekNumber = currentWeekNumber(null);
  console.log(`覆盖层文件：${displayPath(overridesPath())}${exists ? '' : '（尚未创建）'}`);
  console.log(`状态层文件：${displayPath(statePath())}`);
  console.log(`当前周次：${weekNumber ? `第 ${weekNumber} 周` : '未设置（用 set-week --number N 指定）'}`);
  console.log(
    `合计：课程 ${counts.courses} / 停课 ${counts.cancellations} / 任务 ${counts.tasks}（未完成 ${counts.tasks_open}、延后 ${counts.tasks_deferred}、已完成 ${counts.tasks_done}）/ 平台任务状态 ${counts.external_tasks}（已完成 ${counts.external_done}、延后 ${counts.external_deferred}）/ 个人事项 ${counts.personal}`
  );

  if (counts.courses) {
    console.log('\n手工课程：');
    for (const item of overrides.courses) {
      console.log(
        `  ${item.id}  ${describeRule(item)} ${item.start}-${item.end}  ${item.title}${
          item.location ? ` @${item.location}` : ''
        }`
      );
    }
  }
  if (counts.cancellations) {
    console.log('\n停课：');
    for (const item of overrides.cancellations) {
      console.log(`  ${item.id}  ${describeRule(item)}  ${item.title}（${item.reason}）`);
    }
  }
  if (counts.tasks) {
    console.log('\n任务：');
    for (const item of overrides.tasks) {
      const status =
        item.status === 'done'
          ? '已完成'
          : item.status === 'deferred'
            ? `延后到 ${item.deferred_until}`
            : '未完成';
      console.log(
        `  ${item.id}  [${status}] ${item.priority} ${item.title} 截止 ${item.deadline_display}${
          item.estimated_minutes ? ` 预计 ${item.estimated_minutes} 分钟` : ''
        }`
      );
    }
  }
  if (counts.personal) {
    console.log('\n个人事项：');
    for (const item of overrides.personal) {
      console.log(`  ${item.id}  ${describeRule(item)} ${item.start}-${item.end}  ${item.title}`);
    }
  }
  if (counts.external_tasks) {
    console.log('\n平台任务状态（只记在本地，学校平台未变）：');
    for (const item of overrides.external_tasks) {
      const status =
        item.status === 'done'
          ? `已完成 ${item.completed_at ? item.completed_at.slice(0, 10) : ''}`.trim()
          : `延后到 ${item.deferred_until} 起再排`;
      console.log(
        `  ${item.id}  [${status}] ${item.title}${item.course ? `（${item.course}）` : ''}｜来源 ${(
          item.sources || [item.source]
        ).join('/')}｜截止 ${item.deadline || '待确认'}`
      );
    }
  }
  if (!exists) console.log('\n还没有任何手工记录。说「第10周周六9点加实验课」这类话即可创建。');
  if (state.last_action) console.log(`\n最近一次操作：${state.last_action.action} @ ${state.last_action.at}`);

  if (hasFlag('--json')) console.log(JSON.stringify(overrides, null, 2));
  console.log(`LIST_OK:${JSON.stringify({ ...counts, week: weekNumber })}`);
  return { counts, week: weekNumber };
}

// ---------- self-check ----------

function selfCheck() {
  const checks = [];
  const assert = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const tempHome = path.join(os.tmpdir(), `huayuan-selfcheck-${Date.now()}`);
  const previousHome = process.env.HUAYUAN_HOME;
  process.env.HUAYUAN_HOME = tempHome;
  try {
    const mod = require('./user-overrides');
    // 1) 周次规则
    const ruleWeek10 = mod.normalizeRule({ weekday: 6, week: 10, start: '09:00', end: '11:00' });
    assert('第10周规则在 week=10 命中', mod.weekMatches(ruleWeek10, 10).match === true);
    assert('第10周规则在 week=9 不命中', mod.weekMatches(ruleWeek10, 9).match === false);
    const range = mod.normalizeRule({ weekday: 5, start_week: 3, end_week: 12, parity: 'odd' });
    assert('3-12周单周规则命中第 5 周', mod.weekMatches(range, 5).match === true);
    assert('3-12周单周规则跳过第 6 周', mod.weekMatches(range, 6).match === false);
    assert('本周规则总是命中', mod.weekMatches(mod.normalizeRule({ week: 'current' }), 99).match === true);

    // 2) 周次解析
    assert('parseWeeks 10', mod.parseWeeks('10').week === 10);
    assert(
      'parseWeeks 3-12',
      mod.parseWeeks('3-12').start_week === 3 && mod.parseWeeks('3-12').end_week === 12
    );

    // 3) 落盘 + 展开 + 删除回滚
    const overrides = emptyOverrides();
    overrides.courses.push({
      id: 'uc-001',
      title: '实验课',
      weekday: 6,
      week: 10,
      start: '09:00',
      end: '11:00',
      source: 'user',
    });
    overrides.tasks.push({
      id: 'ut-001',
      title: '交报告',
      deadline: '2026-11-01 23:59',
      estimated_minutes: 60,
      priority: 'P1',
      status: 'open',
      source: 'user',
    });
    writeOverrides(overrides);
    const reread = readOverrides();
    assert('覆盖层写入后可读回', reread.exists && reread.overrides.courses.length === 1);

    const week9 = expandForWeek({ overrides: reread.overrides, weekStart: '2026-10-26', weekNumber: 9 });
    const week10 = expandForWeek({ overrides: reread.overrides, weekStart: '2026-11-02', weekNumber: 10 });
    assert('week9 不含实验课', week9.courses.length === 0, `applied=${week9.applied.courses}`);
    assert('week10 含实验课', week10.courses.length === 1 && week10.courses[0].date === '2026-11-07');
    assert('week10 实验课 source=user', Boolean(week10.courses[0]) && week10.courses[0].source === 'user');

    // 3b) 日期生成：必须是 7 个真实日期，不能出现 NaN
    const dates10 = mod.weekDates('2026-11-02');
    assert(
      'weekDates 生成 2026-11-02..2026-11-08 七天',
      dates10[0] === '2026-11-02' && dates10[6] === '2026-11-08' && dates10.length === 7,
      dates10.join(',')
    );
    assert('weekDates 里没有 NaN 日期', !dates10.some((item) => /NaN/.test(item)));
    assert('parseDateText 认识 2026-11-07', mod.dateString(mod.parseDateText('2026-11-07')) === '2026-11-07');
    assert('parseDateText 拒绝 null/空串', mod.parseDateText(null) === null && mod.parseDateText('') === null);
    assert('parseDateText 拒绝被进位的 2026-02-31', mod.parseDateText('2026-02-31') === null);
    let threw = false;
    try {
      mod.weekDates('null');
    } catch {
      threw = true;
    }
    assert('weekDates 遇到非法 weekStart 直接报错（不再产出 NaN）', threw);

    // 3c) overlay.date 过滤：只出现在 11-07，不会铺到整周
    const onlyDay = emptyOverrides();
    onlyDay.courses.push({
      id: 'uc-002',
      title: '一次性补课',
      date: '2026-11-07',
      start: '14:00',
      end: '16:00',
      source: 'user',
    });
    const onlyDayWeek = expandForWeek({ overrides: mod.normalizeOverrides(onlyDay), weekStart: '2026-11-02', weekNumber: 10 });
    assert('指定日期的课程只出现 1 次', onlyDayWeek.courses.length === 1, `applied=${onlyDayWeek.applied.courses}`);
    assert(
      '指定日期的课程落在 2026-11-07',
      onlyDayWeek.courses[0] && onlyDayWeek.courses[0].date === '2026-11-07'
    );
    const otherWeek = expandForWeek({ overrides: mod.normalizeOverrides(onlyDay), weekStart: '2026-10-26', weekNumber: 9 });
    assert('指定日期的课程不在 week9 出现', otherWeek.courses.length === 0);

    const pool = mod.tasksForPool({ overrides: reread.overrides, referenceYear: 2026 });
    assert('任务进入任务池且 source=user', pool.items.length === 1 && pool.items[0].source === 'user');
    assert(
      '任务保留优先级与预计时长',
      pool.items[0].priority === 'P1' && pool.items[0].estimated_minutes === 60
    );

    // 4) 已完成不进待办
    const doneDoc = readOverrides().overrides;
    doneDoc.tasks[0].status = 'done';
    writeOverrides(doneDoc);
    const donePool = mod.tasksForPool({ overrides: readOverrides().overrides, referenceYear: 2026 });
    assert('已完成任务不进任务池', donePool.items.length === 0 && donePool.skipped.length === 1);

    // 5) 延后带 deferred_until
    const deferDoc = readOverrides().overrides;
    deferDoc.tasks[0].status = 'deferred';
    deferDoc.tasks[0].deferred_until = '2026-11-03';
    writeOverrides(deferDoc);
    const deferPool = mod.tasksForPool({ overrides: readOverrides().overrides, referenceYear: 2026 });
    assert('延后任务保留 deferred_until', deferPool.items[0].deferred_until === '2026-11-03');

    // 6) 去掉实验课后恢复
    const removed = readOverrides().overrides;
    removed.courses = [];
    writeOverrides(removed);
    const after = expandForWeek({
      overrides: readOverrides().overrides,
      weekStart: '2026-11-02',
      weekNumber: 10,
    });
    assert('删除实验课后 week10 恢复为空', after.courses.length === 0);

    // 7) 平台任务（雨课堂 / eCourse）的本地状态覆盖
    const platformItem = {
      title: 'Homework 5',
      course: '数据结构',
      sources: ['雨课堂'],
      source: '雨课堂',
      entries: [{ source: '雨课堂', course: '数据结构', title: 'Homework 5', deadline_display: '2026-11-08 23:59' }],
      deadline: '2026-11-08 23:59',
      deadline_display: '2026-11-08 23:59',
      status: 'unfinished',
    };
    const externalDoc = emptyOverrides();
    externalDoc.external_tasks.push({
      id: 'ue-001',
      source: '雨课堂',
      course: '数据结构',
      title: 'Homework 5',
      deadline: '2026-11-08 23:59',
      status: 'done',
      completed_at: '2026-11-04T10:00:00.000Z',
      platform_evidence: [{ source: '雨课堂', title: 'Homework 5' }],
    });
    const normalizedExternal = mod.normalizeOverrides(externalDoc);
    const hidden = mod.applyExternalStatuses([platformItem], normalizedExternal);
    assert('平台任务被本地标记完成后从待办隐藏', hidden.kept.length === 0 && hidden.hidden.length === 1);
    assert(
      '隐藏项保留原平台来源与本地证据',
      hidden.hidden[0].sources[0] === '雨课堂' &&
        /user-overrides\.json#ue-001/.test(hidden.hidden[0].evidence) &&
        hidden.hidden[0].platform_evidence[0].source === '雨课堂'
    );

    const deferExternal = mod.normalizeOverrides({
      external_tasks: [
        {
          id: 'ue-002',
          source: '雨课堂',
          course: '数据结构',
          title: 'Homework 5',
          deadline: '2026-11-08 23:59',
          status: 'deferred',
          deferred_until: '2026-11-06',
        },
      ],
    });
    const deferredApply = mod.applyExternalStatuses([{ ...platformItem }], deferExternal);
    assert('平台任务延后仍留在待办里', deferredApply.kept.length === 1 && deferredApply.hidden.length === 0);
    assert(
      '平台任务延后带 deferred_until',
      deferredApply.kept[0].deferred_until === '2026-11-06' &&
        deferredApply.kept[0].status_override.matched_by === 'fingerprint'
    );

    // 平台只改了截止时刻、日期不变时，指纹仍应命中
    const looseApply = mod.applyExternalStatuses(
      [{ ...platformItem, deadline: '2026-11-08 22:00', deadline_display: '2026-11-08 22:00' }],
      deferExternal
    );
    assert(
      '截止时刻变了、日期不变仍能匹配（指纹按天）',
      looseApply.kept.length === 1 &&
        looseApply.kept[0].deferred_until === '2026-11-06' &&
        looseApply.kept[0].status_override.matched_by === 'fingerprint'
    );

    // 平台把课程名去掉了（course 为空）时，靠"标题+截止日"兜底
    const courseMissing = mod.applyExternalStatuses([{ ...platformItem, course: null }], deferExternal);
    assert(
      '课程名缺失仍按标题+截止日匹配',
      courseMissing.kept.length === 1 &&
        courseMissing.kept[0].deferred_until === '2026-11-06' &&
        courseMissing.kept[0].status_override.matched_by === 'title+deadline'
    );

    // 不同课程的同名任务不能被误伤
    const otherCourse = mod.applyExternalStatuses(
      [{ ...platformItem, course: '操作系统', title: 'Homework 5', deadline: '2026-12-01 23:59' }],
      deferExternal
    );
    assert('别的课程同名任务不被误标', otherCourse.kept.length === 1 && !otherCourse.kept[0].deferred_until);
    assert(
      '指纹包含 source/course/title/date',
      mod.taskFingerprint({ source: '雨课堂', course: '数据结构', title: 'Homework 5', deadline: '2026-11-08 23:59' }) ===
        mod.taskFingerprint({ source: '雨课堂', course: '数据结构', title: 'Homework 5', deadline: '2026-11-08 00:00' })
    );
  } finally {
    if (previousHome === undefined) delete process.env.HUAYUAN_HOME;
    else process.env.HUAYUAN_HOME = previousHome;
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }

  const failed = checks.filter((item) => !item.ok);
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
  }
  console.log(`SELF_CHECK:${failed.length ? 'FAILED' : 'PASS'} ${checks.length - failed.length}/${checks.length}`);
  return failed.length === 0;
}

/**
 * 来源不明的固定事项（例如旧配置里不知道谁写的周三班会）的处置。
 *
 *   legacy list                     列出可疑条目与那一条要问的问题
 *   legacy keep   --id <序号|all>    用户确认保留 → 升级为不可移动强约束
 *   legacy remove --id 序号          用户否认 → 立刻从强约束里移除并删除
 *   legacy edit   --id 序号 --title … --day … --start … --end …
 *                                    用户改成别的时间 → 按用户改的写，并标为已确认
 */
function cmdLegacy() {
  const prefsRead = readPreferences();
  const preferences = prefsRead.exists ? prefsRead.preferences : normalizePreferences({}).preferences;
  const action = process.argv[3] || 'list';
  if (action === 'list') {
    const question = legacyFixedEventQuestion(preferences);
    const suspicious = (preferences.fixed_events || []).filter((event) => !isHardFixedEvent(event));
    if (!suspicious.length) {
      console.log('LEGACY_FIXED_NONE:没有来源不明的固定事项');
      return;
    }
    console.log(
      `LEGACY_FIXED_LIST:${suspicious.map((event, index) => `${index + 1}) ${event.title} 周${event.day} ${event.start}-${event.end}（source=${event.source || 'legacy_unknown'}）`).join(' | ')}`
    );
    if (question) console.log(`LEGACY_FIXED_QUESTION:${question.question}`);
    return;
  }
  const idRaw = argValue('--id', null);
  if (!idRaw) {
    console.error('用法：node manage-items.js legacy <list|keep|remove|edit> --id <序号|all> [--title …] [--day …] [--start …] [--end …]');
    process.exitCode = 2;
    return;
  }
  const events = preferences.fixed_events || [];
  const targets = idRaw === 'all' ? events.map((_, index) => index) : [Number(idRaw) - 1];
  const changed = [];
  if (action === 'remove') {
    const kept = events.filter((_, index) => !targets.includes(index));
    preferences.fixed_events = kept;
    changed.push(`删除 ${targets.length} 条`);
  } else {
    for (const index of targets) {
      const event = events[index];
      if (!event) continue;
      const title = argValue('--title', null);
      const day = argValue('--day', null);
      const start = argValue('--start', null);
      const end = argValue('--end', null);
      if (title) event.title = String(title).slice(0, 30);
      if (day) event.day = Number(day);
      if (start) event.start = start;
      if (end) event.end = end;
      // 用户明确回应过 → 来源升级为 user_explicit，从此才是真正的不可移动
      event.source = 'user_explicit';
      event.evidence = action === 'edit' ? '用户确认并修改为当前内容' : '用户确认保留';
      event.confirmation_state = 'confirmed';
      event.confirmed_at = new Date().toISOString();
      changed.push(event.title);
    }
  }
  markLegacyAsked(preferences, (preferences.fixed_events || []).filter((event) => !isHardFixedEvent(event)).map(eventKey));
  writePreferences(preferences);
  console.log(`LEGACY_FIXED_OK:${action} ${changed.join('、') || '无变更'}`);
  console.log(`LEGACY_FIXED_SUMMARY:${JSON.stringify({ fixed: preferences.fixed_events.length, hard: preferences.fixed_events.filter(isHardFixedEvent).length })}`);
}

function cmdSetCollege() {
  const name = String(arg('--name', arg('--college', '')) || '').trim().slice(0, 40);
  if (!name) fail('MISSING_COLLEGE', '请用 --name 指定学院或书院');
  const college = collegeByInput(name);
  if (!college) fail('COLLEGE_NOT_FOUND', `学院「${name}」不在内置目录中；先运行 activity-feed.js --list-colleges`);
  const current = readPreferences();
  const raw = current.exists && current.raw ? current.raw : {};
  raw.college = college.name;
  raw.updated_at = new Date().toISOString();
  const { preferences } = normalizePreferences(raw);
  writePreferences(preferences);
  console.log(`COLLEGE_SET:${preferences.college}`);
  console.log('学院仅用于筛选公开活动来源，不写入学校系统。');
}

function main() {
  const command = process.argv[2];
  if (command === '--self-check') {
    process.exitCode = selfCheck() ? 0 : 1;
    return;
  }
  const table = {
    'add-course': cmdAddCourse,
    'add-task': cmdAddTask,
    'add-personal': cmdAddPersonal,
    'cancel-course': cmdCancelCourse,
    done: cmdDone,
    defer: cmdDefer,
    remove: cmdRemove,
    list: cmdList,
    week: cmdWeek,
    'set-week': cmdSetWeek,
    'set-college': cmdSetCollege,
    legacy: cmdLegacy,
  };
  const handler = table[command];
  if (!handler) {
    console.error(
      '用法：node manage-items.js <add-course|add-task|add-personal|cancel-course|done|defer|remove|list|set-week|set-college|legacy> [参数]'
    );
    console.error(`覆盖层文件：${displayPath(overridesPath())}`);
    process.exit(2);
  }
  handler();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`MANAGE_ITEMS_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exit(1);
  }
}

module.exports = { cmdLegacy, main, resolveUntil, selfCheck };
