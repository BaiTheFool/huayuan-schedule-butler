'use strict';

/**
 * 日程分析：把「课表 + 个人偏好 + 已读到的任务」折算成可解释的时间结构。
 *
 * 输出（写入动态 huayuan-output 目录）：
 *   schedule-analysis.json  当前占用 / 空闲窗口 / 推荐休息 / 推荐作业时段 / 冲突 / 待确认
 *   schedule-analysis.md    给人看的版本，每条建议都带一句"为什么"
 *   plan.json               可交给 huayuan-task-card/scripts/check_plan.py 校验的计划骨架
 *
 * 关键原则：
 *   - 课表没读到就明说"未读到课表"，不用空数组假装"本周没课"
 *   - 任务清单没读到就只给"学习时段"，不编造任务名与截止时间
 *   - 每条推荐都带 reason，指向具体约束（固定课 / 作息 / 上限 / 缓冲）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  argValue,
  defaultOutputDir,
  displayPath,
  flag,
  readConfig,
} = require('./huayuan-paths');
const {
  SOURCE_LABEL,
  defaultUnconfirmed,
  describePreferences,
  isHardFixedEvent,
  normalizePreferences,
  preferencesPath,
  readPreferences,
  toClock,
  toMinutes,
} = require('./preferences');
const {
  OVERRIDES_FILE,
  applyExternalStatuses,
  expandForWeek,
  overridesPath,
  parseDateText,
  readOverrides,
  summary: overridesSummary,
  tasksForPool,
} = require('./user-overrides');
const { resolveWeek } = require('./semester-week');

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MIN_SLOT_MINUTES = 30;
const MIN_FREE_WINDOW_MINUTES = 10;
const MIN_STUDY_SLOT_MINUTES = 15;
const MIN_TASK_SLICE_MINUTES = 10;
const DEFAULT_TASK_MINUTES = { 作业: 45, 测试: 60, 讨论: 30, 问卷: 20 };
// 休息是"补足到目标分钟数"的配额，不是"整块时段"：
// 允许最后一段只有 10-30 分钟，否则 60 分钟的目标永远只能排出 40 分钟。
const MIN_REST_CHUNK_MINUTES = 10;

// huayuan-paths 里的 argValue/flag 签名是 (argv, name, fallback)，这里收成两个参数的本地封装
const ARGV = process.argv;
const arg = (name, fallback = null) => argValue(ARGV, name, fallback);
const hasFlag = (name) => flag(ARGV, name);

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

// 找最近一次采集结果：显式路径优先，其次当前工作区 huayuan-output 下最新
function findLatest(filename, explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (fs.existsSync(resolved)) return resolved;
    return null;
  }
  const roots = [path.join(process.cwd(), 'huayuan-output')];
  if (process.env.HUAYUAN_OUTPUT_DIR) roots.push(path.resolve(process.env.HUAYUAN_OUTPUT_DIR));
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, filename);
      if (fs.existsSync(file)) candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? candidates[0].file : null;
}

function mondayOf(date = new Date()) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = copy.getDay() === 0 ? 7 : copy.getDay();
  copy.setDate(copy.getDate() - (weekday - 1));
  return copy;
}

function dateString(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 当前时刻：所有"今天/本周"的推荐都必须以它为下界。
 *
 * 之前用"本周从周一 00:00 开始"生成，会把任务排到已经过去的周一上午，
 * 也会把已经过去的整段算成"今天可用时间"。这里统一拿一个 now：
 *   - 过去的日期：只保留为历史占用，不排任务、不推荐休息
 *   - 今天：可用时段从 max(作息起点, 现在) 起算
 * 支持 --now 覆盖，便于回归测试与补算。
 */
function nowContext() {
  const override = arg('--now', null);
  let date = null;
  if (override) {
    const parsed = new Date(String(override).length <= 10 ? `${override}T00:00:00` : String(override));
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) date = new Date();
  const minutes = date.getHours() * 60 + date.getMinutes();
  return {
    date: dateString(date),
    minutes,
    clock: toClock(minutes),
    display: `${dateString(date)} ${toClock(minutes)}`,
    source: override && date ? 'arg:--now' : 'system',
  };
}

// ---------- 统一任务池：JW 课表之外，eCourse 与雨课堂的任务合并到一处 ----------

const PAD = (value) => String(value).padStart(2, '0');

/**
 * 截止时间归一化成可直接比较的 `YYYY-MM-DD HH:MM`。
 * 认不出来就返回 null，并让任务进入"待确认"，绝不用猜的时间去倒推排程。
 */
function normalizeDeadline(raw, referenceYear) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!text || /待确认|未知|暂无|--/.test(text)) return { iso: null, display: '待确认' };

  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2}))?$/);
  if (iso) {
    const date = `${iso[1]}-${PAD(iso[2])}-${PAD(iso[3])}`;
    return {
      iso: iso[4] ? `${date} ${PAD(iso[4])}:${iso[5]}` : `${date} 23:59`,
      display: text,
      date_only: !iso[4],
    };
  }

  // 中文写法：10月30日 / 2026年10月30日 22:00
  const cn = text.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?$/);
  if (cn) {
    const year = cn[1] ? Number(cn[1]) : referenceYear;
    const date = `${year}-${PAD(cn[2])}-${PAD(cn[3])}`;
    return {
      iso: cn[4] ? `${date} ${PAD(cn[4])}:${cn[5]}` : `${date} 23:59`,
      display: text,
      date_only: !cn[4],
    };
  }

  return { iso: null, display: text, unparsed: true };
}

function taskKey(title, deadlineDisplay) {
  return `${String(title || '待确认').replace(/\s+/g, '')}|${String(deadlineDisplay || '待确认')}`;
}

/**
 * 标题不可信判定（0.6.0）。
 * 例：雨课堂里解析出标题只有「6」、也没有截止时间——这种条目
 * 一律标"待确认"，不推断成"第六次作业"，也不排进任何时段。
 */
function unreliableTaskTitle(title) {
  const value = String(title == null ? '' : title).replace(/\s+/g, '');
  if (!value) return true;
  if (/^\d{1,3}$/.test(value)) return true;          // 纯数字：6、12、202
  if (/^[\d.、,，()（）\-\/_]{1,6}$/.test(value)) return true; // 只有数字与符号
  if (value.length < 2) return true;
  return false;
}

function taskNeedsConfirmation(item) {
  if (unreliableTaskTitle(item.title)) return '标题无法识别（只有数字或符号），需要你确认它是什么';
  return null;
}

function makePoolItem(fields) {
  return {
    title: '待确认',
    course: null,
    task_type: '待确认',
    source: '未知',
    sources: [],
    entries: [],
    deadline: null,
    deadline_display: '待确认',
    status: 'unfinished',
    needs_confirmation: false,
    confirm_reasons: [],
    ...fields,
  };
}

/**
 * 三类输入合并：JW 课表（由 buildWeek 直接用）、eCourse 任务、雨课堂待办。
 * 同一件事在多个平台出现时合并成一条但保留全部来源，不删任何一条证据。
 */
function buildTaskPool({ ecourseDoc, rainDoc, referenceYear, userTasks = [], overrides = null }) {
  const items = new Map();
  const stats = {
    by_source: { eCourse: 0, 雨课堂: 0, user: 0 },
    overdue: 0,
    needs_confirmation: 0,
    unfinished: 0,
    hidden_by_user_state: 0,
    deferred_by_user_state: 0,
  };

  const push = (item) => {
    // 标题只有「6」这类不可识别条目才禁止进入时间表。标题明确但截止时间
    // 未知的任务仍按保守耗时直接排，只是显示“截止待确认”，不能让明确待办消失。
    const reason = taskNeedsConfirmation(item);
    if (reason) {
      item.needs_confirmation = true;
      item.exclude_from_plan = true;
      if (!item.confirm_reasons.includes(reason)) item.confirm_reasons.push(reason);
    }
    if (!item.deadline) {
      item.needs_confirmation = true;
      if (!item.confirm_reasons.includes('未给出截止时间')) item.confirm_reasons.push('未给出截止时间');
    }
    const key = taskKey(item.title, item.deadline_display);
    const existing = items.get(key);
    if (!existing) {
      item.sources = [item.source];
      items.set(key, item);
      return;
    }
    // 合并：保留两边的来源与明细，status 取"更紧急"的那个
    existing.entries.push(...item.entries);
    for (const source of item.sources) if (!existing.sources.includes(source)) existing.sources.push(source);
    if (item.status === 'overdue' && existing.status !== 'overdue') existing.status = 'overdue';
    if (!existing.course && item.course) existing.course = item.course;
    // 手工任务与平台任务同名同截止时不合并成一条假记录：来源都留着，用户填的字段补齐进来
    if (item.priority && !existing.priority) existing.priority = item.priority;
    if (item.estimated_minutes && !existing.estimated_minutes) existing.estimated_minutes = item.estimated_minutes;
    if (item.deferred_until && !existing.deferred_until) existing.deferred_until = item.deferred_until;
    if (item.user_task_id && !existing.user_task_id) existing.user_task_id = item.user_task_id;
    if (item.evidence) {
      const merged = [].concat(existing.evidence || [], item.evidence);
      existing.evidence = [...new Set(merged)];
    }
    existing.duplicated_across_sources = existing.sources.length > 1;
  };

  // 1) eCourse：只保留未完成项（ecourse-pull 已筛过，这里再核一次）
  const ecourseTasks = ecourseDoc && Array.isArray(ecourseDoc.tasks) ? ecourseDoc.tasks : [];
  for (const task of ecourseTasks) {
    const deadline = normalizeDeadline(task.deadline, referenceYear);
    const item = makePoolItem({
      title: task.title || '待确认',
      course: task.course || null,
      task_type: task.task_type || '待确认',
      source: 'eCourse',
      sources: ['eCourse'],
      entries: [
        {
          source: 'eCourse',
          course: task.course || null,
          title: task.title || '待确认',
          deadline_display: deadline.display,
        },
      ],
      deadline: deadline.iso,
      deadline_display: deadline.display,
      // 平台自己给了预计耗时就用它；没给才按任务类型估（作业 45 / 测试 60 / 讨论 30）
      estimated_minutes: Number(task.estimated_minutes) > 0 ? Number(task.estimated_minutes) : null,
      status: 'unfinished',
    });
    if (!deadline.iso) {
      item.needs_confirmation = true;
      item.confirm_reasons.push(
        deadline.unparsed ? `截止时间格式无法直接比较（原文「${deadline.display}」）` : '未给出截止时间'
      );
    }
    push(item);
  }
  // 2) 雨课堂：is_expired=true 的未完成项不是"待办"，是"已过期未完成"
  const rainCourses = rainDoc && Array.isArray(rainDoc.courses) ? rainDoc.courses : [];
  for (const course of rainCourses) {
    if (!course || !course.ok) continue;
    for (const task of Array.isArray(course.tasks) ? course.tasks : []) {
      const deadline = normalizeDeadline(task.score_deadline, referenceYear);
      const item = makePoolItem({
        title: task.name || '待确认',
        course: course.classroom_name || null,
        task_type: task.type === undefined || task.type === null ? '待确认' : `类型 ${task.type}`,
        source: '雨课堂',
        sources: ['雨课堂'],
        entries: [
          {
            source: '雨课堂',
            course: course.classroom_name || null,
            title: task.name || '待确认',
            deadline_display: deadline.display,
            is_expired: Boolean(task.is_expired),
          },
        ],
        deadline: deadline.iso,
        deadline_display: deadline.display,
        estimated_minutes: Number(task.estimated_minutes) > 0 ? Number(task.estimated_minutes) : null,
        status: task.is_expired ? 'overdue' : 'unfinished',
      });
      if (!deadline.iso) {
        item.needs_confirmation = true;
        item.confirm_reasons.push(
          deadline.unparsed ? `截止时间格式无法直接比较（原文「${deadline.display}」）` : '未给出截止时间'
        );
      }
      push(item);
    }
  }

  // 3) 用户手工任务：已完成的不在这里（tasksForPool 已剔除），延后项带 deferred_until
  for (const item of userTasks) {
    push(makePoolItem({ ...item, sources: ['user'] }));
  }

  // 4) 本地"外部任务状态"覆盖：雨课堂 / eCourse 的任务只在本地标记完成或延后，
  //    不回写学校平台。已完成的不进待办，延后的带 deferred_until 等时间到了再排。
  const applied = overrides
    ? applyExternalStatuses([...items.values()], overrides)
    : { kept: [...items.values()], hidden: [], deferred: [] };
  const list = applied.kept;
  stats.hidden_by_user_state = applied.hidden.length;
  stats.deferred_by_user_state = applied.deferred.length;
  // by_source 必须和 items 对得上：被本地标成 done 的平台任务已经从待办隐藏，
  // 不能再计入任何来源，否则会出现 total=6 而 by_source 合计=7 的自相矛盾。
  // 合并后的条目按主来源计一次，所以 sum(by_source) === items.length 恒成立。
  stats.by_source = { eCourse: 0, 雨课堂: 0, user: 0 };
  for (const item of list) {
    const key = stats.by_source[item.source] === undefined ? null : item.source;
    if (key) stats.by_source[key] += 1;
    else stats.by_source[item.source] = 1;
  }
  stats.total_items = list.length;
  for (const item of list) {
    if (item.status === 'overdue') stats.overdue += 1;
    else stats.unfinished += 1;
    if (item.needs_confirmation) stats.needs_confirmation += 1;
  }
  list.sort((a, b) => {
    const rank = (item) => (item.status === 'overdue' ? 0 : item.deadline ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.deadline && b.deadline) return a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;
    return String(a.title).localeCompare(String(b.title));
  });

  return { items: list, stats, hidden_by_user_state: applied.hidden, deferred_by_user_state: applied.deferred };
}

/**
 * 把任务按优先级/截止时间铺到本周的时间预算上。
 *
 * 旧实现把每个候选时段整段绑给一个任务，导致 45 分钟任务占掉 60 分钟槽，
 * 或任务放不进 45 分钟槽就出现“有第一动作、下面却没有绑定任务”。现在改为：
 * - 标题可识别的任务一进入任务池就参与排程；
 * - 按任务真实预计耗时切片，可跨多个空档；
 * - 同一槽可依次容纳多个短任务，任务之间保留用户设定的缓冲；
 * - 剩余空档保留为空闲，不再伪装成未绑定任务；
 * - 截止前放不下的部分明确列为 unschedulable/leftover，不越过截止硬塞。
 */
function estimateTaskMinutes(task) {
  const explicit = Number(task.estimated_minutes);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.round(explicit));
  const type = String(task.task_type || '');
  for (const key of Object.keys(DEFAULT_TASK_MINUTES)) {
    if (type.includes(key)) return DEFAULT_TASK_MINUTES[key];
  }
  return 45;
}

function assignTasksToStudy(studyPlan, pool, options = {}) {
  const bufferMinutes = Math.max(0, Number(options.bufferMinutes) || 0);
  const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const remaining = pool.items
    .filter((item) => item.status !== 'overdue')
    .filter((item) => !item.exclude_from_plan)
    .map((task) => ({
      task,
      remaining_minutes: estimateTaskMinutes(task),
      total_minutes: estimateTaskMinutes(task),
      scheduled_minutes: 0,
      segments: [],
    }))
    .sort((a, b) => {
      const leftPriority = priorityRank[String(a.task.priority || '').toUpperCase()];
      const rightPriority = priorityRank[String(b.task.priority || '').toUpperCase()];
      if (leftPriority !== undefined || rightPriority !== undefined) {
        const diff = (leftPriority === undefined ? 9 : leftPriority) - (rightPriority === undefined ? 9 : rightPriority);
        if (diff !== 0) return diff;
      }
      if (a.task.deadline && b.task.deadline) return a.task.deadline < b.task.deadline ? -1 : a.task.deadline > b.task.deadline ? 1 : 0;
      if (a.task.deadline) return -1;
      if (b.task.deadline) return 1;
      return 0;
    });

  const hadSchedulableTasks = remaining.length > 0;
  const scheduled = new Set();
  const unschedulable = [];
  const eligibility = (state, day) => !state.task.deferred_until || day.date >= state.task.deferred_until;
  const deadlineOnDay = (state, day) => {
    const deadline = String(state.task.deadline || '');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(deadline)) return null;
    if (deadline.slice(0, 10) !== day.date) return null;
    return toMinutes(deadline.slice(11, 16));
  };
  const sourceLabel = (task) => task.sources.map((name) => (name === 'user' ? '手工' : name)).join(' + ');

  for (const day of studyPlan) {
    if (!hadSchedulableTasks) continue;
    if (!remaining.length) {
      day.slots = [];
      day.planned_minutes = 0;
      day.note = '当前任务已全部落到具体时段，剩余时间保持机动';
      continue;
    }

    const nextSlots = [];
    for (const originalSlot of day.slots || []) {
      const slotStart = toMinutes(originalSlot.start);
      const slotEnd = toMinutes(originalSlot.end);
      if (slotStart === null || slotEnd === null || slotEnd <= slotStart) continue;
      let cursor = slotStart;

      while (cursor < slotEnd && remaining.length) {
        const index = remaining.findIndex((state) => eligibility(state, day));
        if (index < 0) break;
        const state = remaining[index];
        const deadlineDate = state.task.deadline ? String(state.task.deadline).slice(0, 10) : null;

        if (deadlineDate && deadlineDate < day.date) {
          unschedulable.push({
            title: state.task.title,
            course: state.task.course,
            deadline: state.task.deadline_display,
            sources: state.task.sources,
            reason: `在排到可用时段前已超过截止 ${state.task.deadline_display}`,
          });
          remaining.splice(index, 1);
          continue;
        }

        const sameDayDeadline = deadlineOnDay(state, day);
        const latestEnd = sameDayDeadline === null ? slotEnd : Math.min(slotEnd, sameDayDeadline);
        const available = latestEnd - cursor;
        if (available < MIN_TASK_SLICE_MINUTES) {
          if (sameDayDeadline !== null && sameDayDeadline <= slotEnd) {
            unschedulable.push({
              title: state.task.title,
              course: state.task.course,
              deadline: state.task.deadline_display,
              sources: state.task.sources,
              reason: `截止 ${state.task.deadline_display} 前只剩 ${Math.max(0, available)} 分钟，未强行塞入`,
            });
            remaining.splice(index, 1);
            continue;
          }
          break;
        }

        // 任务剩余量不足一个最小切片时，允许在已经开始的最后一段收尾。
        const canFinishSmallTail = state.scheduled_minutes > 0 || state.remaining_minutes < MIN_TASK_SLICE_MINUTES;
        const minutes = Math.min(state.remaining_minutes, available);
        if (minutes < MIN_TASK_SLICE_MINUTES && !canFinishSmallTail) break;

        const start = cursor;
        const end = cursor + minutes;
        const taskSegment = {
          title: state.task.title,
          course: state.task.course,
          source: sourceLabel(state.task),
          deadline: state.task.deadline_display,
          due: state.task.deadline,
          priority: state.task.priority || null,
          estimated_minutes: state.total_minutes,
          assigned_minutes: minutes,
          needs_confirmation: Boolean(state.task.needs_confirmation),
          task_key: state.task.user_task_id || taskKey(state.task.title, state.task.deadline_display),
        };
        const splitNote = state.total_minutes > minutes ? `任务共 ${state.total_minutes} 分钟，本段 ${minutes} 分钟` : null;
        nextSlots.push({
          start: toClock(start),
          end: toClock(end),
          minutes,
          task: taskSegment,
          reason: [originalSlot.reason, splitNote].filter(Boolean).join('；'),
        });
        state.segments.push(taskSegment);
        scheduled.add(state);
        state.scheduled_minutes += minutes;
        state.remaining_minutes -= minutes;
        cursor = end;

        if (state.remaining_minutes <= 0) {
          state.remaining_minutes = 0;
          remaining.splice(index, 1);
          // 下一个任务从缓冲之后开始；缓冲留在空档里，不伪装成学习任务。
          if (remaining.length) cursor += bufferMinutes;
          continue;
        }

        // 同一任务未完成时优先在下一个连续/后续窗口继续，不插入其他任务。
        break;
      }
    }

    // 有可排任务时只落盘真实任务片段，剩余自由时间不伪装成“未绑定学习”。
    day.slots = nextSlots;
    day.planned_minutes = nextSlots.reduce((sum, slot) => sum + slot.minutes, 0);
    if (nextSlots.length) day.note = `已按任务预计耗时排入 ${day.planned_minutes} 分钟，剩余时间保持机动`;
  }

  for (const state of new Set([...scheduled, ...remaining])) {
    if (state.segments.length < 2) continue;
    state.segments.forEach((segment, index) => {
      segment.part_index = index + 1;
      segment.part_count = state.segments.length;
    });
  }

  const leftover = remaining.map((state) => ({
    title: state.task.title,
    course: state.task.course,
    deadline: state.task.deadline_display,
    sources: state.task.sources,
    reason: state.task.deferred_until
      ? `已延后到 ${state.task.deferred_until}，在此之前不重新排`
      : state.scheduled_minutes > 0
        ? `已排 ${state.scheduled_minutes}/${state.total_minutes} 分钟，还差 ${state.remaining_minutes} 分钟`
        : '本周可用时段不足，尚未安排到具体时间',
  }));

  return { assigned: [...scheduled].map((state) => state.task), unschedulable, leftover };
}


function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((item) => item.start_min !== null && item.end_min !== null && item.end_min > item.start_min)
    .sort((a, b) => a.start_min - b.start_min);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    // 首尾相接（如运动 17:30 结束、晚餐 17:30 开始）不算重叠，只有真正压住才算
    if (last && item.start_min < last.end_min) {
      last.end_min = Math.max(last.end_min, item.end_min);
      last.items.push(item);
    } else {
      merged.push({ start_min: item.start_min, end_min: item.end_min, items: [item] });
    }
  }
  return merged;
}

function complement(bounds, busy) {
  const windows = [];
  let cursor = bounds.start;
  for (const block of busy) {
    if (block.start_min > cursor) windows.push({ start_min: cursor, end_min: Math.min(block.start_min, bounds.end) });
    cursor = Math.max(cursor, block.end_min);
    if (cursor >= bounds.end) break;
  }
  if (cursor < bounds.end) windows.push({ start_min: cursor, end_min: bounds.end });
  return windows.filter((item) => item.end_min - item.start_min >= MIN_FREE_WINDOW_MINUTES);
}

// 从空闲窗口里扣掉已经排进去的段落（如休息），避免"自习和休息互相压"
function subtractWindows(windows, taken) {
  const toRange = (item) => {
    const start = Number.isFinite(item.start_min) ? item.start_min : toMinutes(item.start);
    const end = Number.isFinite(item.end_min) ? item.end_min : toMinutes(item.end);
    return start !== null && end !== null && end > start ? { start_min: start, end_min: end } : null;
  };
  const takenList = taken
    .map(toRange)
    .filter(Boolean)
    .sort((a, b) => a.start_min - b.start_min);
  let current = windows.map(toRange).filter(Boolean);
  for (const blockRange of takenList) {
    const next = [];
    for (const window of current) {
      if (blockRange.end_min <= window.start_min || blockRange.start_min >= window.end_min) {
        next.push(window);
        continue;
      }
      if (blockRange.start_min > window.start_min) {
        next.push({ start_min: window.start_min, end_min: blockRange.start_min });
      }
      if (blockRange.end_min < window.end_min) {
        next.push({ start_min: blockRange.end_min, end_min: window.end_min });
      }
    }
    current = next;
  }
  return current.filter((item) => item.end_min - item.start_min >= MIN_FREE_WINDOW_MINUTES);
}

function block(source, title, start, end, extra = {}) {
  const startMin = toMinutes(start);
  const endMin = toMinutes(end);
  return {
    source,
    title,
    start,
    end,
    start_min: startMin,
    end_min: endMin,
    ...extra,
  };
}

// 同一条课表在时间上压住、但周次完全不相交时（例如「4-13周」与「第14周」），
// 它们永远不可能在同一周同时发生，不能算冲突。
function weekSet(item) {
  const list = item && item.week_list;
  return Array.isArray(list) && list.length ? new Set(list) : null;
}

function weeksIntersect(a, b) {
  const left = weekSet(a);
  const right = weekSet(b);
  // 任一方没有周次信息时保守判定为可能冲突，宁可多提示也不漏
  if (!left || !right) return true;
  for (const week of left) if (right.has(week)) return true;
  return false;
}

function overlaps(a, b) {
  return a.start_min < b.end_min && b.start_min < a.end_min;
}

// 学校原始课表里每门课都带 weeks（raw / list / parity）。
// week_number 已知时必须用它过滤：否则「第14周」的分析会把只在 3-12 周上的课全排进来。
function courseWeekList(course) {
  const weeks = course && course.weeks;
  if (!weeks || typeof weeks !== 'object') return null;
  const list = Array.isArray(weeks.list) ? weeks.list.map((value) => Number(value)).filter((value) => Number.isFinite(value)) : [];
  return list.length ? list : null;
}

function courseParity(course) {
  const parity = course && course.weeks && course.weeks.parity;
  return parity === 'odd' || parity === 'even' ? parity : null;
}

/**
 * 一门课在某一周到底上不上。
 * - week_number 未知：{ state: 'unknown' }，保留课程但必须标注"周次未确认，按可能发生"
 * - 有 weeks.list：以 list 为准（解析器已把 "3-12周,15周" 展开成具体周次）
 * - 只有 parity：按单/双周判定
 * - 两者都没有：{ state: 'unknown' }
 */
function courseWeekMatch(course, weekNumber) {
  const week = Number(weekNumber);
  const known = Number.isFinite(week) && week > 0;
  const list = courseWeekList(course);
  const parity = courseParity(course);
  const raw = (course && course.weeks && course.weeks.raw) || null;
  if (!known) {
    return { state: 'unknown', raw, reason: '本次未确认当前教学周，按"可能发生"计入' };
  }
  if (list) {
    if (list.includes(week)) return { state: 'match', raw, reason: null };
    return { state: 'off', raw, reason: raw ? `${raw} 不含第 ${week} 周` : `周次列表不含第 ${week} 周` };
  }
  if (parity) {
    const odd = week % 2 === 1;
    const hit = (parity === 'odd' && odd) || (parity === 'even' && !odd);
    return hit
      ? { state: 'match', raw: raw || `${parity === 'odd' ? '单' : '双'}周`, reason: null }
      : { state: 'off', raw: raw || `${parity === 'odd' ? '单' : '双'}周`, reason: `仅${parity === 'odd' ? '单' : '双'}周（第 ${week} 周不上）` };
  }
  return { state: 'unknown', raw, reason: '课表没有给出周次范围' };
}

/** 按当前教学周过滤学校原始课程，并把跳过的课留下证据（不改原 JSON） */
function filterCoursesByWeek(courses, weekNumber) {
  const week = Number(weekNumber);
  const known = Number.isFinite(week) && week > 0;
  const result = {
    applied: known,
    week_number: known ? Math.round(week) : null,
    total: courses.length,
    kept: [],
    skipped: [],
    unknown: [],
    unknown_count: 0,
  };
  for (const course of courses) {
    const match = courseWeekMatch(course, weekNumber);
    if (match.state === 'match') {
      result.kept.push(course);
      continue;
    }
    if (match.state === 'off') {
      result.skipped.push({
        title: course.course,
        weekday: course.weekday,
        start: course.start_time,
        end: course.end_time,
        weeks: match.raw,
        reason: match.reason,
      });
      continue;
    }
    // 周次未确认：保留课程（宁可多算占用），但单独登记，输出里必须写明不精确
    result.kept.push(course);
    result.unknown.push({ title: course.course, weeks: match.raw, reason: match.reason });
    result.unknown_count += 1;
  }
  // 同一门课多个时段时，unknown 只保留一次标题
  const seen = new Set();
  result.unknown = result.unknown.filter((item) => {
    const key = `${item.title}|${item.weeks}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return result;
}

function buildWeek({ preferences, timetable, now = null, overrides = null, weekNumber = null }) {
  const clock = now || nowContext();
  // 这里必须走 arg()（内部是 argValue(ARGV, name, fallback)）。
  // 之前写成 argValue('--week-start')，第 1 个形参是 argv，等于没传 name，
  // 拿回 null 后拼成 "nullT00:00:00" -> Invalid Date -> 7 天全成 NaN-NaN-NaN。
  const weekStartArg = arg('--week-start', null);
  const parsedWeekStart = weekStartArg ? parseDateText(String(weekStartArg)) : null;
  let weekStartNote = null;
  if (weekStartArg && !parsedWeekStart) {
    weekStartNote = `--week-start 收到「${weekStartArg}」不是合法的 YYYY-MM-DD，本次改用本周一 ${dateString(
      mondayOf()
    )} 重新计算（不会按无效日期排程）`;
  }
  let weekStart = parsedWeekStart || mondayOf();
  // --week-start 必须是周一：否则 weekday=1 会落到周二，整周的星期与日期全错位。
  if ((weekStart.getDay() + 6) % 7 !== 0) {
    const shifted = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    weekStartNote = `${weekStartNote ? `${weekStartNote}；` : ''}--week-start「${dateString(
      weekStart
    )}」不是周一，已对齐到该周周一 ${dateString(shifted)}`;
    weekStart = shifted;
  }
  const days = [];
  const conflicts = [];
  const pending = [];
  const occupancy = [];
  if (weekStartNote) pending.push(weekStartNote);

  // 覆盖层叠加到本周：手工课程 / 个人事项 / 停课。
  // 学校原始 JSON 一个字节都不改，这里只做"读的时候叠加"。
  const overlay = expandForWeek({
    overrides: overrides || { courses: [], cancellations: [], tasks: [], personal: [] },
    weekStart: dateString(weekStart),
    weekNumber,
  });

  const timedCourses = (timetable && Array.isArray(timetable.courses) ? timetable.courses : []).filter(
    (course) => course.weekday && course.start_time && course.end_time
  );
  // weeks.list / parity 必须参与过滤：第14周只上「智能配送管理」，不能把 3-12 周的课全排进来
  const weekFilter = filterCoursesByWeek(timedCourses, weekNumber);
  const classes = weekFilter.kept;
  const missingClassTime = (timetable && Array.isArray(timetable.courses) ? timetable.courses : []).filter(
    (course) => !course.start_time || !course.end_time
  );

  if (timetable) {
    // 正常按周次排除的课不是"待确认"，明细在 week_filter.skipped 与 md 的"本周不上"里；
    // pending 只放真正需要用户确认的事，避免把确定结论说成待确认。
    if (weekFilter.unknown_count) {
      pending.push(
        `周次未确认：${weekFilter.unknown
          .map((item) => item.title)
          .slice(0, 5)
          .join('、')} 的周次范围没有读到，按"可能发生"计入占用，这一周的课表不是精确结果`
      );
    }
  }

  if (!timetable) {
    pending.push('未读取到教务课表：本周只按个人偏好排，课表时间需要先运行 jw-timetable.js');
  } else {
    if (missingClassTime.length) {
      pending.push(
        `有 ${missingClassTime.length} 段课程缺起止时间（${missingClassTime
          .map((item) => item.course)
          .filter((value, index, array) => array.indexOf(value) === index)
          .slice(0, 5)
          .join('、')}），这些时段未计入占用`
      );
    }
    if (timetable.pending && timetable.pending.length) {
      for (const item of timetable.pending.slice(0, 8)) pending.push(`课表待确认：${item}`);
    }
  }

  const normalizeTitle = (value) => String(value || '').replace(/[\s()（）[\]【】]/g, '');
  /**
   * 停课匹配：只看标题，日期由 expandForWeek 落成具体日期（dates 为 null 表示本周全部）。
   * 完全相等优先，其次才允许包含——避免"课"这种短词把整天的课都停掉。
   */
  const cancellationFor = (dateText, title) => {
    const target = normalizeTitle(title);
    if (!target) return null;
    for (const item of overlay.cancellations) {
      if (Array.isArray(item.dates) && !item.dates.includes(dateText)) continue;
      const cancelTitle = normalizeTitle(item.title);
      if (!cancelTitle) continue;
      if (target === cancelTitle) return item;
      if (cancelTitle.length >= 3 && target.includes(cancelTitle)) return item;
      if (target.length >= 3 && cancelTitle.includes(target)) return item;
    }
    return null;
  };

  for (let index = 0; index < 7; index += 1) {
    const day = index + 1;
    const isWeekend = day >= 6;
    const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index);
    const dateText = dateString(date);
    // 过去的日期只作为历史占用；今天只剩"现在之后"的部分可用
    const isPast = dateText < clock.date;
    const isToday = dateText === clock.date;
    const wake = isWeekend ? preferences.weekend.wake : preferences.daily.wake;
    const sleep = isWeekend ? preferences.weekend.sleep : preferences.daily.sleep;
    const dayStart = Math.max(toMinutes(wake) || 420, toMinutes(preferences.daily.day_start) || 450);
    const dayEnd = Math.min(toMinutes(sleep) || 1410, toMinutes(preferences.daily.day_end) || 1370);
    // 今天已过去的时间不能再排任何东西：把下界抬到现在（向上取整到 5 分钟）
    // “现在开始”就是现在：不再把 19:44 抬到 19:45，制造一分钟的假等待窗口。
    const effectiveStart = isToday ? Math.max(dayStart, clock.minutes) : dayStart;
    const unconfirmedFixed = [];
  const blocks = [];
    const cancelledToday = [];

    for (const course of classes.filter((item) => item.weekday === day)) {
      const cancellation = cancellationFor(dateText, course.course);
      if (cancellation) {
        // 停课只影响这一周/这一天，学校课表文件仍然保留原始记录
        cancelledToday.push({
          title: course.course,
          start: course.start_time,
          end: course.end_time,
          weeks: course.weeks ? course.weeks.raw : null,
          user_override_id: cancellation.id,
          reason: cancellation.reason,
          evidence: `${OVERRIDES_FILE}#${cancellation.id}`,
        });
        continue;
      }
      blocks.push(
        block('class', course.course, course.start_time, course.end_time, {
          detail: `${course.period_text}｜${course.classroom}｜${course.teacher}`,
          weeks: course.weeks ? course.weeks.raw : null,
          week_list: course.weeks && Array.isArray(course.weeks.list) ? course.weeks.list : null,
        })
      );
    }

    // 手工课程（实验课 / 补课 / 临时加课）：source=user，来源证据指向覆盖层记录
    for (const item of overlay.courses.filter((entry) => entry.date === dateText)) {
      const kindLabel = item.kind === 'makeup' ? '补课' : item.kind === 'regular' ? '常规课' : '临时加课';
      blocks.push(
        block('user', item.title, item.start, item.end, {
          origin: 'user-course',
          detail: `手工${kindLabel}${item.location ? `｜${item.location}` : ''}${item.teacher ? `｜${item.teacher}` : ''}`,
          user_override_id: item.id,
          evidence: `${OVERRIDES_FILE}#${item.id}`,
        })
      );
    }

    // 个人事项：同样是不可移动占用，参与冲突与空闲计算
    for (const item of overlay.personal.filter((entry) => entry.date === dateText)) {
      blocks.push(
        block('personal', item.title, item.start, item.end, {
          origin: 'user-personal',
          detail: '个人事项（手工添加）',
          user_override_id: item.id,
          evidence: `${OVERRIDES_FILE}#${item.id}`,
        })
      );
    }

    for (const meal of preferences.meals) {
      blocks.push(block('meal', meal.label, meal.start, meal.end, { protected: meal.protected }));
    }

    if (preferences.exercise.enabled && preferences.exercise.days.includes(day)) {
      blocks.push(
        block('exercise', '运动', preferences.exercise.start, preferences.exercise.end, {
          note: preferences.exercise.note,
        })
      );
    }

    for (const event of preferences.fixed_events.filter((item) => item.day === day)) {
      // 只有"用户明确说过并确认过"的固定事项才是硬占用；
      // 来源不明的旧条目、系统默认值一律降级为可移动建议，不当不可移动约束
      const hard = isHardFixedEvent(event);
      blocks.push(
        block(hard ? 'fixed' : 'fixed_unconfirmed', event.title, event.start, event.end, {
          movable: hard ? event.movable : 'flexible',
          source: event.source || 'legacy_unknown',
          note: hard ? null : '来源未确认，暂按可移动处理，请确认保留还是删除',
        })
      );
      if (!hard) unconfirmedFixed.push({ title: event.title, day, start: event.start, end: event.end, source: event.source || 'legacy_unknown' });
    }

    // 用餐与运动属于"可以压边"的占用：超出可用时段就裁到边界，并说明裁掉了什么
    const clampToBounds = (item) => {
      if (item.start_min === null || item.end_min === null) return null;
      const start = Math.max(item.start_min, dayStart);
      const end = Math.min(item.end_min, dayEnd);
      if (end - start < 15) return null;
      return {
        ...item,
        start: toClock(start),
        end: toClock(end),
        start_min: start,
        end_min: end,
        clamped: start !== item.start_min || end !== item.end_min,
      };
    };

    const clamped = blocks.map((item) =>
      item.source === 'meal' || item.source === 'exercise' ? clampToBounds(item) : item
    );
    let usable = clamped.filter(Boolean);

    // 课程和「不可移动的固定事项」是骨架，不能为了用餐/运动让步；
    // 用餐与运动属于「可以小幅挪动」的占用，撞上骨架时自动挪到课前/课后，
    // 并作为"已自动调整"上报，而不是丢给用户一个"两件事同时发生"的计划。
    const reported = new Set();
    const pairKey = (a, b) => [a.title, b.title].sort().join('|');

    // 让位优先级：课程/固定事项（不可动） > 用餐（受保护） > 运动（最该动）。
    // 所以排用餐时不把运动当成障碍（运动随后会让开），排运动时才让开所有已就位的块。
    const shiftOne = (item, movableSourceLabel, pool, ignoreSources = []) => {
      const blocked = pool.filter(
        (other) => other !== item && !ignoreSources.includes(other.source) && overlaps(item, other)
      );
      if (!blocked.length) return item;

      const duration = item.end_min - item.start_min;
      // 相对"实际挡住它的那一段"来挪：课程、固定事项、用餐都算。
      // 用餐虽然不是骨架，但运动也不该压住吃饭，所以对运动来说用餐同样是锚点。
      const anchors = blocked;
      const candidates = [];
      for (const anchor of anchors) {
        candidates.push({ start: anchor.end_min, end: anchor.end_min + duration, anchor, order: '顺延' });
        candidates.push({ start: anchor.start_min - duration, end: anchor.start_min, anchor, order: '提前' });
      }
      // 候选按"离原位置最近"排序，优先做最小改动
      candidates.sort(
        (a, b) => Math.abs(a.start - item.start_min) - Math.abs(b.start - item.start_min)
      );

      for (const candidate of candidates) {
        if (candidate.start < dayStart || candidate.end > dayEnd) continue;
        if (candidate.end - candidate.start < MIN_SLOT_MINUTES) continue;
        const probe = { ...item, start_min: candidate.start, end_min: candidate.end };
        if (pool.some((other) => other !== item && overlaps(probe, other))) continue;
        conflicts.push({
          date: dateString(date),
          day,
          type: `${item.source}_shifted`,
          severity: 'info',
          detail: `${movableSourceLabel}由 ${item.start}-${item.end} ${candidate.order}到 ${toClock(candidate.start)}-${toClock(candidate.end)}`,
          reason: `因为${blocked.map((b) => `${b.title}(${b.start}-${b.end})`).join('、')}不可移动，所以${movableSourceLabel}让位，两者不再重叠`,
        });
        return {
          ...item,
          start: toClock(candidate.start),
          end: toClock(candidate.end),
          start_min: candidate.start,
          end_min: candidate.end,
        };
      }

      // 挪不开就如实报冲突，并且不再让通用重叠检测重复报同一对
      for (const other of blocked) reported.add(pairKey(item, other));
      conflicts.push({
        date: dateString(date),
        day,
        type: `${item.source}_clash`,
        severity: 'warn',
        detail: `${movableSourceLabel} ${item.start}-${item.end} 与${blocked
          .map((b) => `${b.title}(${b.start}-${b.end})`)
          .join('、')}撞车，且当天挪不开`,
        reason:
          item.source === 'meal'
            ? '当天课程排满，放不下这段用餐时间，建议改用餐时间或确认是否跳过'
            : '当天可用时段放不下运动，建议改运动日或缩短运动时长',
      });
      return item;
    };

    // 先挪用餐（只让开课程/固定事项），再挪运动（让开课程、固定事项和已就位的用餐）
    for (let i = 0; i < usable.length; i += 1) {
      if (usable[i].source !== 'meal') continue;
      usable[i] = shiftOne(usable[i], usable[i].title, usable, ['exercise']);
    }
    for (let i = 0; i < usable.length; i += 1) {
      if (usable[i].source !== 'exercise') continue;
      usable[i] = shiftOne(usable[i], '运动', usable);
    }

    const valid = usable.filter((item) => item.start_min !== null && item.end_min !== null);
    const busy = mergeIntervals(valid);

    // 冲突 1：占用互相重叠（周次不相交的不算冲突）
    for (const merged of busy) {
      if (merged.items.length < 2) continue;
      const pairs = [];
      for (let i = 0; i < merged.items.length; i += 1) {
        for (let j = i + 1; j < merged.items.length; j += 1) {
          const left = merged.items[i];
          const right = merged.items[j];
          if (!overlaps(left, right)) continue;
          if (!weeksIntersect(left, right)) continue;
          if (reported.has(pairKey(left, right))) continue;
          pairs.push([left, right]);
        }
      }
      const seen = new Set();
      for (const [left, right] of pairs) {
        const key = pairKey(left, right);
        if (seen.has(key)) continue;
        seen.add(key);
        const weekNote =
          left.week_list || right.week_list
            ? `（${left.weeks || '每周'} / ${right.weeks || '每周'}）`
            : '';
        conflicts.push({
          date: dateString(date),
          day,
          type: 'overlap',
          severity: 'warn',
          detail: `${left.title}(${left.start}-${left.end}) 与 ${right.title}(${right.start}-${right.end}) 时间重叠${weekNote}`,
          reason: '两段占用落在同一时间区间，需要二选一或调整个人安排',
        });
      }
    }

    // 冲突 2：占用超出可用时段（早于起床 / 晚于睡觉）
    for (const item of valid) {
      if (item.start_min < dayStart) {
        conflicts.push({
          date: dateString(date),
          day,
          type: 'out_of_bounds',
          severity: 'warn',
          detail: `${item.title} ${item.start} 早于可用时段起点 ${toClock(dayStart)}`,
          reason: '按当前作息，这段时间还没开始一天',
        });
      }
      if (item.end_min > dayEnd) {
        conflicts.push({
          date: dateString(date),
          day,
          type: 'out_of_bounds',
          severity: 'warn',
          detail: `${item.title} ${item.end} 晚于可用时段终点 ${toClock(dayEnd)}`,
          reason: '按当前作息，这段时间已经该休息了',
        });
      }
    }

    const free = isPast
      ? []
      : complement({ start: effectiveStart, end: dayEnd }, busy);
    days.push({
      date: dateText,
      day,
      day_name: DAY_NAMES[index],
      is_weekend: isWeekend,
      past: isPast,
      is_today: isToday,
      // 今天可用时段的实际起点：可能是作息起点，也可能是"现在"
      effective_start: toClock(effectiveStart),
      now_cut: isToday ? toClock(clock.minutes) : null,
      wake,
      sleep,
      bounds: { start: toClock(dayStart), end: toClock(dayEnd) },
      occupancy: valid
        .sort((a, b) => a.start_min - b.start_min)
        .map((item) => ({
          title: item.title,
          source: item.source,
          start: item.start,
          end: item.end,
          minutes: item.end_min - item.start_min,
          detail: item.detail || null,
          note: item.note || null,
          weeks: item.weeks || null,
          week_list: Array.isArray(item.week_list) && item.week_list.length ? item.week_list : null,
          // 手工来源必须能追溯：是哪一条覆盖记录加的
          origin: item.origin || (item.source === 'user' ? 'user-course' : null),
          user_override_id: item.user_override_id || null,
          evidence: item.evidence || null,
          // 已经结束的段只是历史，不再参与推荐
          history: isPast || (isToday && item.end_min <= clock.minutes),
        })),
      // 来源未确认的固定事项：只列出，不当不可移动占用
      unconfirmed_fixed: unconfirmedFixed,
      cancelled: cancelledToday,
      busy_minutes: busy.reduce((sum, item) => sum + (item.end_min - item.start_min), 0),
      free_windows: free.map((item) => ({
        start: toClock(item.start_min),
        end: toClock(item.end_min),
        minutes: item.end_min - item.start_min,
      })),
    });
    occupancy.push(...valid);
  }

  const cancelledCount = days.reduce((sum, day) => sum + (day.cancelled ? day.cancelled.length : 0), 0);
  return {
    days,
    conflicts,
    pending,
    weekStart: dateString(weekStart),
    classCount: classes.length,
    weekFilter,
    // 手工叠加的部分单独计数：结果里要能说清"14 段里有 1 段是你自己加的"
    manualClassCount: overlay.courses.length,
    personalCount: overlay.personal.length,
    cancelledCount,
    overlay: {
      week_number: overlay.week_number,
      applied: overlay.applied,
      skipped: overlay.skipped,
      notes: overlay.notes,
    },
  };
}

/**
 * 休息配额：目标是每天 rest.daily_minutes 分钟，必须真的排到这个分钟数。
 *
 * 旧实现只认"偏好时段整段"，60 分钟目标在 13:00-13:40 排出 40 分钟后，
 * 剩余 20 分钟小于 30 分钟的整块阈值就被丢弃，于是每天永远只有 40 分钟。
 * 现在的顺序是：偏好整段 → 就近顺延/提前 → 其它空闲窗口补齐，
 * 允许最后一段 10-30 分钟；确实排不下时如实给出差额与原因。
 */
function recommendRest(preferences, days) {
  const target = preferences.rest.enabled ? preferences.rest.daily_minutes : 0;
  const preferred = preferences.rest.preferred
    .map((item) => {
      const match = String(item).match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
      return match ? { start: match[1], end: match[2] } : null;
    })
    .filter(Boolean);

  return days.map((day) => {
    const base = {
      date: day.date,
      day_name: day.day_name,
      target_minutes: target,
      planned_minutes: 0,
      shortfall_minutes: 0,
      slots: [],
      note: null,
    };
    if (day.past) {
      return { ...base, skipped: 'past', note: '已过去的日期只保留历史占用，不再推荐休息' };
    }
    if (!target) {
      return { ...base, note: '按偏好不启用休息推荐' };
    }

    let remaining = target;
    let available = day.free_windows
      .map((window) => ({
        start_min: Number.isFinite(window.start_min) ? window.start_min : toMinutes(window.start),
        end_min: Number.isFinite(window.end_min) ? window.end_min : toMinutes(window.end),
      }))
      .filter((range) => range.start_min !== null && range.end_min !== null)
      .filter((range) => range.end_min - range.start_min >= MIN_REST_CHUNK_MINUTES);
    const totalFree = available.reduce((sum, range) => sum + (range.end_min - range.start_min), 0);
    const chosen = [];

    const place = (start, end, reason) => {
      const minutes = end - start;
      if (minutes < MIN_REST_CHUNK_MINUTES) return 0;
      chosen.push({ start: toClock(start), end: toClock(end), minutes, reason });
      available = subtractWindows(available, [{ start_min: start, end_min: end }]);
      remaining -= minutes;
      return minutes;
    };

    // 1) 先放用户指定的偏好休息时段（整段优先；不足目标也不会被丢弃）
    for (const candidate of preferred) {
      if (remaining < MIN_REST_CHUNK_MINUTES) break;
      const cStart = toMinutes(candidate.start);
      const cEnd = toMinutes(candidate.end);
      let guard = 0;
      while (remaining >= MIN_REST_CHUNK_MINUTES && guard < 8) {
        guard += 1;
        const overlap = available
          .map((range) => ({
            range,
            start: Math.max(range.start_min, cStart),
            end: Math.min(range.end_min, cEnd),
          }))
          .filter((item) => item.end - item.start >= MIN_REST_CHUNK_MINUTES)
          .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
        if (!overlap) break;
        place(
          overlap.start,
          Math.min(overlap.end, overlap.start + remaining),
          `与你设定的偏好休息时段 ${candidate.start}-${candidate.end} 重合，且该段未被课程占用`
        );
      }
    }

    // 2) 还没凑满：在偏好段前后就近顺延/提前，保持休息是整块而不是碎片
    if (remaining >= MIN_REST_CHUNK_MINUTES && chosen.length) {
      for (const slot of chosen.slice()) {
        if (remaining < MIN_REST_CHUNK_MINUTES) break;
        const slotStart = toMinutes(slot.start);
        const slotEnd = toMinutes(slot.end);
        let guard = 0;
        while (remaining >= MIN_REST_CHUNK_MINUTES && guard < 6) {
          guard += 1;
          const adjacent = available
            .slice()
            .sort(
              (a, b) =>
                Math.min(Math.abs(a.start_min - slotEnd), Math.abs(slotStart - a.end_min)) -
                Math.min(Math.abs(b.start_min - slotEnd), Math.abs(slotStart - b.end_min))
            )[0];
          if (!adjacent) break;
          if (Math.abs(adjacent.start_min - slotEnd) <= 5) {
            const take = Math.min(remaining, adjacent.end_min - adjacent.start_min);
            if (take < MIN_REST_CHUNK_MINUTES) break;
            place(
              adjacent.start_min,
              adjacent.start_min + take,
              `在偏好休息段 ${slot.start}-${slot.end} 之后顺延，补足每天 ${target} 分钟`
            );
          } else if (Math.abs(adjacent.end_min - slotStart) <= 5) {
            const take = Math.min(remaining, adjacent.end_min - adjacent.start_min);
            if (take < MIN_REST_CHUNK_MINUTES) break;
            place(
              adjacent.end_min - take,
              adjacent.end_min,
              `在偏好休息段 ${slot.start}-${slot.end} 之前提前，补足每天 ${target} 分钟`
            );
          } else {
            break;
          }
        }
      }
    }

    // 3) 仍然不够：按空闲窗口从早到晚补齐（最后一段允许小于 30 分钟）
    let guard = 0;
    while (remaining >= MIN_REST_CHUNK_MINUTES && available.length && guard < 20) {
      guard += 1;
      const range = available.slice().sort((a, b) => a.start_min - b.start_min)[0];
      const take = Math.min(remaining, range.end_min - range.start_min);
      if (take < MIN_REST_CHUNK_MINUTES) {
        available = available.filter((item) => item !== range);
        continue;
      }
      place(
        range.start_min,
        range.start_min + take,
        `偏好时段放不下整段，改放在空闲窗口 ${toClock(range.start_min)}-${toClock(range.end_min)} 内，按每天 ${target} 分钟补足`
      );
    }

    const planned = target - remaining;
    const shortfall = Math.max(0, target - planned);
    chosen.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    // 相接的两段（13:25-13:40 + 13:40-13:55）本质是一整段休息，
    // 不合并会让结果页看起来像被切碎的碎片时间
    const merged = [];
    for (const slot of chosen) {
      const last = merged[merged.length - 1];
      if (last && toMinutes(last.end) === toMinutes(slot.start)) {
        last.end = slot.end;
        last.minutes += slot.minutes;
        continue;
      }
      merged.push({ ...slot });
    }
    let note = null;
    if (!merged.length) {
      note = `当天可用空闲合计只有 ${totalFree} 分钟，放不下 ${target} 分钟休息；建议放宽作息或减少固定占用`;
    } else if (shortfall > 0) {
      note = `当天只排出 ${planned}/${target} 分钟：扣掉课程与用餐后可用空闲合计 ${totalFree} 分钟，确实差 ${shortfall} 分钟，未强行塞入碎片`;
    }
    return { ...base, planned_minutes: planned, slots: merged, shortfall_minutes: shortfall, note };
  });
}

/**
 * 学习时段：在"扣掉课程 / 用餐 / 休息"的空闲窗口里，按偏好切成若干块。
 *
 * 新增的偏好在这里真正生效（不是只存不用）：
 *   weekday_daily_limit_min / weekend_daily_limit_min  当日上限（旧字段 daily_limit_min 仍兼容）
 *   max_continuous_minutes      单块最长；超过就拆块并留 10 分钟间隔，不再一坐三小时
 *   max_study_blocks_per_day    每天最多几块
 *   evening_latest_end / evening_study_minutes  晚间学习的截止时间与总额
 *   preferred_study_periods     优先落在这几个时段里
 */
function recommendStudy(preferences, days, restPlan) {
  const study = preferences.study || {};
  const weekdayLimit =
    study.weekday_daily_limit_min !== undefined
      ? study.weekday_daily_limit_min
      : study.daily_limit_min !== undefined
        ? study.daily_limit_min
        : 240;
  const weekendLimit = study.weekend_daily_limit_min !== undefined ? study.weekend_daily_limit_min : 180;
  const maxContinuous = Math.max(45, Number(study.max_continuous_minutes) || 90);
  const maxBlocks = Math.max(1, Number(study.max_study_blocks_per_day) || 4);
  const eveningEndMin = toMinutes(study.evening_latest_end);
  const eveningEnd = eveningEndMin === null ? 22 * 60 + 30 : eveningEndMin;
  const eveningBudget = study.evening_study_minutes === undefined ? 60 : Number(study.evening_study_minutes);
  const EVENING_FROM = 18 * 60;
  const SPLIT_GAP = 10;
  const preferred = (Array.isArray(study.preferred_study_periods) ? study.preferred_study_periods : [])
    .map((item) => {
      const match = String(item).match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
      return match ? { start: toMinutes(match[1]), end: toMinutes(match[2]) } : null;
    })
    .filter(Boolean);

  return days.map((day) => {
    const limit = day.is_weekend ? weekendLimit : weekdayLimit;
    if (day.past) {
      return {
        date: day.date,
        day_name: day.day_name,
        daily_limit_min: limit,
        planned_minutes: 0,
        slots: [],
        skipped: 'past',
        note: '已过去的日期不再排学习时段，只保留历史占用',
      };
    }
    const rest = restPlan.find((item) => item.date === day.date);
    // 先扣掉已经排进去的休息段，再在剩下的空闲里放学习，避免两块时间重叠
    const windows = subtractWindows(day.free_windows, (rest && rest.slots) || []);

    // 1) 把空闲窗口切成候选块：每块不超过 maxContinuous，块之间留 10 分钟起身
    const candidates = [];
    for (const window of windows) {
      let cursor = window.start_min;
      while (window.end_min - cursor >= MIN_STUDY_SLOT_MINUTES) {
        const length = Math.min(maxContinuous, window.end_min - cursor);
        candidates.push({ start: cursor, end: cursor + length, window });
        cursor += length + SPLIT_GAP;
      }
    }

    // 2) 偏好学习时段优先，其余按时间先后（靠前放，避免和睡前休息挤在一起）
    const hitsPreferred = (candidate) =>
      preferred.some((period) => candidate.start < period.end && period.start < candidate.end);
    const currentStart = toMinutes(day.effective_start);
    const startsNow = (candidate) => day.is_today && currentStart !== null && candidate.start === currentStart;
    candidates.sort((a, b) => {
      // 今天先吃“现在就能开始”的窗口，再谈偏好时段。否则会出现
      // 第一动作说现在开始，但计划表却把任务放到晚上的矛盾。
      const nowDiff = (startsNow(b) ? 1 : 0) - (startsNow(a) ? 1 : 0);
      if (nowDiff !== 0) return nowDiff;
      const prefDiff = (hitsPreferred(a) ? 0 : 1) - (hitsPreferred(b) ? 0 : 1);
      if (prefDiff !== 0) return prefDiff;
      return a.start - b.start;
    });

    const slots = [];
    let used = 0;
    let eveningUsed = 0;
    let stopReason = null;

    for (const candidate of candidates) {
      if (slots.length >= maxBlocks) {
        stopReason = `已按偏好每天最多 ${maxBlocks} 块停止`;
        break;
      }
      if (used >= limit) {
        stopReason = `已达当日上限 ${limit} 分钟`;
        break;
      }
      let start = candidate.start;
      let end = candidate.end;
      const trimmed = [];
      if (end - start > maxContinuous) {
        end = start + maxContinuous;
        trimmed.push(`单块不超过 ${maxContinuous} 分钟`);
      }

      // 晚间部分同时受限：最晚到 evening_latest_end，总额不超过 evening_study_minutes
      const eveningStart = Math.max(start, EVENING_FROM);
      let eveningTrimmed = false;
      if (eveningStart < end) {
        const budgetLeft = Math.max(0, eveningBudget - eveningUsed);
        const cappedEnd = Math.min(end, Math.max(eveningStart, eveningEnd), eveningStart + budgetLeft);
        if (cappedEnd - start < MIN_STUDY_SLOT_MINUTES) {
          trimmed.push('晚间额度已用完');
          continue;
        }
        if (cappedEnd < end) {
          end = cappedEnd;
          eveningTrimmed = true;
        }
      }
      if (eveningTrimmed) {
        trimmed.push(`晚间最晚到 ${toClock(eveningEnd)}、合计不超过 ${eveningBudget} 分钟`);
      }

      const restOfLimit = limit - used;
      if (end - start > restOfLimit) {
        end = start + restOfLimit;
        trimmed.push(`当日上限 ${limit} 分钟`);
      }
      const minutes = end - start;
      if (minutes < MIN_STUDY_SLOT_MINUTES) continue;

      const reasons = [`空闲 ${toClock(candidate.window.start_min)}-${toClock(candidate.window.end_min)} 已扣掉休息`];
      if (hitsPreferred(candidate)) reasons.push('落在你偏好的学习时段内');
      reasons.push(...trimmed);
      slots.push({ start: toClock(start), end: toClock(end), minutes, reason: reasons.join('；') });
      used += minutes;
      const eveningOverlap = Math.max(0, end - Math.max(start, EVENING_FROM));
      eveningUsed += eveningOverlap;
    }

    let note = null;
    if (!slots.length) {
      const totalFree = windows.reduce((sum, item) => sum + (item.end_min - item.start_min), 0);
      note =
        totalFree < MIN_STUDY_SLOT_MINUTES
          ? `当天可用空闲不足 ${MIN_STUDY_SLOT_MINUTES} 分钟，建议把任务顺延或压缩固定占用`
          : `当天可用空闲不足 ${MIN_STUDY_SLOT_MINUTES} 分钟，或晚间额度已用完，未排学习时段`;
    } else if (used < limit) {
      note = `当天只排到 ${used}/${limit} 分钟：${stopReason || '整块空闲不足或受晚间上限限制'}`;
    }

    return {
      date: day.date,
      day_name: day.day_name,
      daily_limit_min: limit,
      planned_minutes: used,
      evening_minutes: eveningUsed,
      slots,
      note,
    };
  });
}

function buildPlan({ preferences, days, restPlan, studyPlan, taskPool, meta = {} }) {
  const pool = Array.isArray(taskPool) ? taskPool : [];
  const forwardDays = days.filter((day) => !day.past);
  return {
    generated_at: new Date().toISOString(),
    source: 'huayuan-schedule-butler 日程分析（可解释）',
    // 计划只覆盖"现在及以后"：过去的日子已经发生，放进来只会让人以为还能调
    scope: 'forward_only',
    generated_now: meta.now ? meta.now.display : null,
    timetable_known: Boolean(meta.timetable_known),
    confidence: meta.timetable_known ? 'grounded' : 'estimated',
    // 课表没读到时这份计划只是"按偏好估的空档"，不能当作可执行计划
    usable_as_plan: Boolean(meta.timetable_known),
    plan_note: meta.timetable_known
      ? null
      : '课表未读到：本计划只按作息偏好估算空档，未扣除上课时间，不能直接当最终日程',
    preferences: {
      // check_plan 只认一个上限：取工作日/周末的较大值，避免周末上限更低时被误判为超限
      daily_limit_min: Math.max(
        Number(preferences.study.weekday_daily_limit_min !== undefined
          ? preferences.study.weekday_daily_limit_min
          : preferences.study.daily_limit_min) || 240,
        Number(preferences.study.weekend_daily_limit_min) || 180
      ),
      weekday_daily_limit_min:
        preferences.study.weekday_daily_limit_min !== undefined
          ? preferences.study.weekday_daily_limit_min
          : preferences.study.daily_limit_min,
      weekend_daily_limit_min: preferences.study.weekend_daily_limit_min,
      buffer_min: preferences.study.buffer_min,
      max_continuous_minutes: preferences.study.max_continuous_minutes,
      day_start: preferences.daily.day_start,
      day_end: preferences.daily.day_end,
    },
    notes: [
      ...(meta.timetable_known ? [] : ['课表未读到：所有时段仅为按偏好的估算']),
      ...(pool.length
        ? ['任务块来自已读取的任务清单；截止时间缺失的条目标为待确认']
        : ['未读取到任务清单，学习时段仅作时间预留，未绑定具体任务']),
    ],
    days: forwardDays.map((day) => {
      const blocks = [];
      for (const item of day.occupancy) {
        // 今天已经结束的课/饭/运动属于历史，不再进入计划
        if (item.history) continue;
        // 课程、用餐、运动、固定事项都属于"不可移动骨架"，
        // 可移动负荷只统计真正需要排的学习时段（下面 kind=personal 的那部分）
        const blockItem = { title: item.title, kind: 'fixed', start: item.start, end: item.end };
        // 周次随块一起落盘，供 check_plan.py 判断"时间撞了但周次不相交"
        if (item.weeks) blockItem.weeks = item.weeks;
        if (Array.isArray(item.week_list) && item.week_list.length) blockItem.week_list = item.week_list;
        blocks.push(blockItem);
      }
      const rest = restPlan.find((item) => item.date === day.date);
      for (const slot of (rest && rest.slots) || []) {
        blocks.push({ title: '休息', kind: 'break', start: slot.start, end: slot.end });
      }
      const study = studyPlan.find((item) => item.date === day.date);
      for (const slot of (study && study.slots) || []) {
        // 绑上任务的时段用 kind=task 并带上 due，check_plan 才能校验"结束不晚于截止"
        if (slot.task) {
          const partLabel =
            slot.task.part_count > 1 ? `（第 ${slot.task.part_index}/${slot.task.part_count} 段）` : '';
          const blockItem = {
            title: `作业：${slot.task.title}${partLabel}`,
            kind: 'task',
            start: slot.start,
            end: slot.end,
          };
          if (slot.task.due) blockItem.due = slot.task.due;
          if (slot.task.priority) blockItem.priority = slot.task.priority;
          blocks.push(blockItem);
          continue;
        }
        blocks.push({
          title: pool.length ? '学习时段（待分配任务）' : '自习时段（未绑定任务）',
          kind: 'personal',
          start: slot.start,
          end: slot.end,
        });
      }
      blocks.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
      return { date: day.date, blocks };
    }),
  };
}

function analyze() {
  const outputDir = path.resolve(arg('--output-dir', defaultOutputDir()));
  fs.mkdirSync(outputDir, { recursive: true });

  const preferencesFromFile = readPreferences();
  const prefsOverride = arg('--prefs', null);
  let preferences;
  let prefSource;
  if (prefsOverride) {
    const raw = readJsonSafe(path.resolve(prefsOverride));
    preferences = normalizePreferences(raw || {}).preferences;
    prefSource = `参数 --prefs（${displayPath(path.resolve(prefsOverride))}）`;
  } else if (preferencesFromFile.exists) {
    preferences = preferencesFromFile.preferences;
    prefSource = `偏好文件（${displayPath(preferencesPath())}）`;
  } else {
    preferences = normalizePreferences({}).preferences;
    prefSource = '尚未采集偏好，本次全部使用默认值（请运行初始化向导）';
  }

  const timetablePath = findLatest('jw-timetable.json', arg('--timetable', null));
  const timetable = timetablePath ? readJsonSafe(timetablePath) : null;

  const tasksPath = findLatest('ecourse-tasks.json', arg('--tasks', null));
  const tasksDoc = tasksPath ? readJsonSafe(tasksPath) : null;

  // 雨课堂是第三类输入：授权了就必须合并进来，不能当它不存在
  const rainPath = findLatest('rain-fast.json', arg('--rain', null));
  const rainDoc = rainPath ? readJsonSafe(rainPath) : null;

  // 读取不完整（有课程失败、有记录只出现在总数里没解析出内容）时不能宣称"没有待办"
  const tasksSummary = (tasksDoc && tasksDoc.summary) || {};
  const tasksUnparsed = Number(tasksSummary.unparsed || 0);
  const tasksFailed = Number(tasksSummary.failed || 0);
  const tasksIncomplete = Boolean(tasksDoc) && (tasksUnparsed > 0 || tasksFailed > 0);
  const rainFailed = Number((rainDoc && rainDoc.summary && rainDoc.summary.failed) || 0);
  const rainAuthExpired = Boolean(rainDoc && rainDoc.summary && rainDoc.summary.auth_expired);

  const config = readConfig() || {};
  const clock = nowContext();
  // 覆盖层：本次分析要叠加的手工课程/停课/任务/个人事项
  const overridesRead = readOverrides();
  const overridesDoc = overridesRead.overrides;
  // 周次决定"第 10 周的实验课"到底算不算这一周，也决定 3-12 周的课在第 14 周要不要排。
  // 顺序：--week-number > 用户确认/已保存的周次 > 教务校历自动识别 > 未确认（明确说明不精确）
  const weekNumberArg = arg('--week-number', null);
  const weekResolution = resolveWeek({
    explicit: weekNumberArg,
    timetable,
    campus: readJsonSafe(path.join(outputDir, 'campus-sync.json')),
    now: new Date(),
  });
  const weekNumber = weekResolution.week;
  const week = buildWeek({ preferences, timetable, now: clock, overrides: overridesDoc, weekNumber });
  // pending 在下面才声明，这里先攒着，避免 TDZ
  const weekPending = [];
  if (weekResolution.needs_confirmation) {
    weekPending.push(
      '当前教学周未确认：课表里带周次范围的课程无法判断本周上不上，按"可能发生"计入占用，这一周的分析不是精确结果（用 manage-items.js set-week --number N 指定一次即可）'
    );
  }
  if (weekResolution.conflict) weekPending.push(weekResolution.conflict);
  // 课表"已知"必须同时满足：文件存在、状态是读到、并且真的解析出课程。
  // 只要有一项不满足，本周所有空档都只是按偏好估的，不能当正式计划。
  const timetableStatus = timetable ? String(timetable.status || '') : null;
  // 课表"已知"看的是课表本身解析出了课程，而不是本周排了几节：
  // 第 14 周只有一门课、假期周可能一节都没有，那都不是"课表没读到"。
  const timetableCourses = timetable && Array.isArray(timetable.courses) ? timetable.courses.length : 0;
  const timetableKnown =
    Boolean(timetable) && timetableCourses > 0 && timetableStatus !== 'READ_EMPTY' && timetableStatus !== 'READ_FAILED';
  const weekRefYear = Number(String(week.weekStart).slice(0, 4)) || new Date().getFullYear();
  // 手工任务先过一遍：completed 不进待办，deferred 带上 deferred_until
  const userTasks = tasksForPool({ overrides: overridesDoc, referenceYear: weekRefYear });
  const pool = buildTaskPool({
    ecourseDoc: tasksDoc,
    rainDoc,
    referenceYear: weekRefYear,
    userTasks: userTasks.items,
    overrides: overridesDoc,
  });
  const hasSchedulableTasks = pool.items.some(
    (item) => item.status !== 'overdue' && !item.exclude_from_plan
  );
  // 有明确任务时先排任务，最后在剩余时间里放休息。休息是配额，不是固定时间栅栏；
  // 只有当天完全没有任务时才沿用偏好休息时段做时间预留。
  let restPlan = hasSchedulableTasks ? [] : recommendRest(preferences, week.days);
  const studyPlan = recommendStudy(preferences, week.days, restPlan);
  const taskAssignment = assignTasksToStudy(studyPlan, pool, {
    bufferMinutes: preferences.study.buffer_min,
  });
  if (hasSchedulableTasks) {
    const daysAfterTasks = week.days.map((day) => {
      const taken = (studyPlan.find((item) => item.date === day.date)?.slots || []).filter((slot) => slot.task);
      return { ...day, free_windows: subtractWindows(day.free_windows, taken) };
    });
    restPlan = recommendRest(preferences, daysAfterTasks);
  }
  const plan = buildPlan({
    preferences,
    days: week.days,
    restPlan,
    studyPlan,
    taskPool: pool.items,
    meta: { timetable_known: timetableKnown, now: clock },
  });
  const conflictList = week.conflicts.filter((item) => item.severity !== 'info');
  const adjustments = week.conflicts.filter((item) => item.severity === 'info');
  // 首屏能直接引用的空闲时间只算"现在之后"，否则会把已经过去的周一整段当成可用
  const forwardFreeMinutes = week.days
    .filter((day) => !day.past)
    .reduce((sum, day) => sum + day.free_windows.reduce((inner, item) => inner + item.minutes, 0), 0);
  const totalFreeMinutes = week.days.reduce(
    (sum, day) => sum + day.free_windows.reduce((inner, item) => inner + item.minutes, 0),
    0
  );

  const pending = [...week.pending, ...weekPending];
  const notes = [];
  if (!timetableKnown) {
    pending.push(
      '课表未知：本周的空闲时间只是按你的作息偏好做的估算，没有扣除上课时间，不能当最终计划；补齐课表后重跑 node first-run.js --wizard --login'
    );
  }
  const restShortfalls = restPlan.filter((day) => day.shortfall_minutes > 0);
  if (restShortfalls.length) {
    notes.push(
      `${restShortfalls.length} 天没有排满休息目标（${restShortfalls
        .map((day) => `${day.day_name} ${day.planned_minutes}/${day.target_minutes}`)
        .join('、')}），原因见各天说明`
    );
  }
  if (!preferencesFromFile.exists && !prefsOverride) {
    pending.push('个人偏好尚未采集，当前按默认值排程');
  }

  const noTaskSource = !tasksDoc && !rainDoc;
  if (noTaskSource) {
    pending.push('未读取到 eCourse / 雨课堂任务清单：作业时段只做时间预留，不代表真实任务量');
  } else if (tasksIncomplete || rainFailed > 0 || rainAuthExpired) {
    const reasons = [];
    if (tasksUnparsed > 0) reasons.push(`eCourse ${tasksUnparsed} 条记录只出现在列表总数里、没解析出具体内容`);
    if (tasksFailed > 0) reasons.push(`eCourse ${tasksFailed} 门课程读取失败`);
    if (rainFailed > 0) reasons.push(`雨课堂 ${rainFailed} 门课程读取失败`);
    if (rainAuthExpired) reasons.push('雨课堂登录已失效');
    pending.push(
      `任务清单读取不完整（${reasons.join('，')}）：不能据此判定"没有作业"，请到对应课程页面人工核对`
    );
  } else if (!pool.items.length) {
    // 两个来源都读到了、且确实没有未完成项：这是"真实的 0"，不是"没读到"
    notes.push('已读取 eCourse 与雨课堂任务清单：当前没有未完成的任务，作业时段只作时间预留');
  }

  const overdueItems = pool.items.filter((item) => item.status === 'overdue');
  if (overdueItems.length) {
    const names = overdueItems.slice(0, 5).map((item) => `${item.title}（${item.course || item.sources.join('+')}）`);
    pending.push(
      `有 ${overdueItems.length} 条已过期但未完成：${names.join('、')}${overdueItems.length > 5 ? ' 等' : ''} —— 需要你决定是否还做，已过期项不参与排程`
    );
  }

  const needConfirm = pool.items.filter((item) => item.needs_confirmation);
  const unconfirmedTasks = pool.items.filter((item) => item.exclude_from_plan);
  if (needConfirm.length) {
    const courses = [...new Set(needConfirm.map((item) => item.course).filter(Boolean))];
    pending.push(
      `有 ${needConfirm.length} 条任务截止时间待确认${courses.length ? `（涉及 ${courses.slice(0, 4).join('、')}）` : ''}：已排在作业时段最后，未按截止倒推`
    );
  }

  for (const item of taskAssignment.unschedulable.slice(0, 5)) {
    pending.push(`任务「${item.title}」本周排不进：${item.reason}`);
  }

  // ── 0.6.0：排程就绪度 ──
  // 数据不完整时**不下正式计划**：只说清"读到什么 / 缺什么 / 下一步 / 一个问题"，
  // 不允许输出"已自动调整 N 条""本周已排入 X 分钟"这类确定性结论。
  const blockers = [];
  const weekUnknown = !weekNumber || Boolean(week.weekFilter && week.weekFilter.unknown_count);
  if (weekUnknown) blockers.push({ code: 'week_unconfirmed', label: '当前教学周未确认' });
  if (tasksIncomplete) blockers.push({ code: 'ecourse_partial', label: 'eCourse 只读到一部分（READ_PARTIAL）' });
  if (rainFailed > 0 || rainAuthExpired) blockers.push({ code: 'rain_partial', label: '雨课堂只读到一部分或登录态已过期' });
  if (!timetableKnown) blockers.push({ code: 'timetable_unknown', label: '教务课表未读到' });
  if (defaultUnconfirmed(preferences)) blockers.push({ code: 'preferences_unconfirmed', label: '偏好仍是系统默认值，未经你确认' });
  if (unconfirmedTasks.length) blockers.push({ code: 'task_unconfirmed', label: `有 ${unconfirmedTasks.length} 条任务标题或截止时间待确认` });

  const planReady = blockers.length === 0;
  const readiness = {
    ready: planReady,
    estimate_only: !planReady,
    blockers,
    // 冲突不再自称"已自动调整"，只说发现多少处、确认后重排
    conflict_suggestions: week.conflicts.filter((item) => item.severity === 'info').length,
    next_action: planReady
      ? '可以按这个安排执行'
      : blockers[0].code === 'week_unconfirmed'
        ? '先回答现在是第几周，我会保存并重算'
        : blockers[0].code === 'preferences_unconfirmed'
          ? '先确认作息偏好（或明确说"就用默认值"），我再排'
          : '把缺的那一项补齐后重算（保留已读到的部分）',
    question: planReady
      ? null
      : unconfirmedTasks.length
        ? `任务「${unconfirmedTasks[0].title}」具体是什么，截止时间是什么时候？`
        : blockers[0].code === 'week_unconfirmed'
          ? '现在是第几周？'
          : null,
  };

  // ── 覆盖层：用户手工改过的东西必须能追溯，不能悄悄生效或悄悄失效 ──
  const overridesCounts = overridesSummary(overridesDoc);
  for (const item of week.overlay.skipped.slice(0, 5)) {
    pending.push(`手工记录「${item.title}」本次未生效：${item.reason}`);
  }
  for (const note of week.overlay.notes.slice(0, 3)) pending.push(note);
  if (week.cancelledCount) {
    notes.push(
      `按你的停课记录，本周有 ${week.cancelledCount} 段学校课程不计入占用（教务原始课表文件未改动，随时可撤销）`
    );
  }
  if (week.manualClassCount) notes.push(`手工课程 ${week.manualClassCount} 段已叠加到本周占用（来源标记为 user）`);
  if (week.personalCount) notes.push(`个人事项 ${week.personalCount} 段已叠加到本周占用`);
  const deferredTasks = pool.items.filter((item) => item.deferred_until);
  if (deferredTasks.length) {
    pending.push(
      `有 ${deferredTasks.length} 条任务处于延后状态：${deferredTasks
        .slice(0, 5)
        .map((item) => `${item.title}（从 ${item.deferred_until} 起才排）`)
        .join('、')}`
    );
  }
  if (userTasks.skipped.length) {
    notes.push(`手工任务里 ${userTasks.skipped.length} 条已完成，不再进入待办`);
  }
  // 外部任务（雨课堂 / eCourse）的本地状态：只影响本地排程，从未提交到学校平台
  for (const item of pool.hidden_by_user_state) {
    notes.push(`「${item.title}」已按你的标记视为完成（仅本地，未提交到${item.sources.join('/')}）`);
  }
  const externalDeferred = pool.items.filter((item) => item.status_override);
  if (externalDeferred.length) {
    notes.push(
      `${externalDeferred.length} 条平台任务按你的要求延后（仅本地）：${externalDeferred
        .slice(0, 5)
        .map((item) => `${item.title}（从 ${item.deferred_until} 起才排）`)
        .join('、')}`
    );
  }

  if (config.campus && preferences.campus && config.campus !== preferences.campus) {
    pending.push(`校区口径不一致：配置 ${config.campus} / 偏好 ${preferences.campus}，节次时间可能不准`);
  }

  const result = {
    generated_at: new Date().toISOString(),
    now: clock,
    week_start: week.weekStart,
    // 课表是否真的读到：false 时下面所有空闲/学习时段都只是估算
    timetable_known: timetableKnown,
    confidence: timetableKnown ? 'grounded' : 'estimated',
    usable_as_plan: timetableKnown,
    confidence_note: timetableKnown
      ? null
      : '课表未读到：空闲时间只是按偏好估算，未扣除上课时间，不能当最终计划',
    inputs: {
      timetable: timetablePath ? displayPath(timetablePath) : null,
      timetable_status: timetableStatus,
      timetable_semester: timetable ? timetable.semester && timetable.semester.label : null,
      timetable_classes: week.classCount,
      tasks: tasksPath ? displayPath(tasksPath) : null,
      task_count: tasksDoc && Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks.length : 0,
      rain: rainPath ? displayPath(rainPath) : null,
      rain_status: rainDoc ? rainDoc.status : null,
      preferences: prefSource,
      campus: preferences.campus || '未指定',
      week_number: weekNumber,
      manual_classes: week.manualClassCount,
    },
    // 学校原始课表的周次过滤：第14周只上「智能配送管理」，3-12 周的课必须被排除
    week_filter: {
      applied: week.weekFilter.applied,
      week_number: week.weekFilter.week_number,
      courses_total: week.weekFilter.total,
      courses_kept: week.weekFilter.kept.length,
      sessions_skipped: week.weekFilter.skipped.length,
      skipped: week.weekFilter.skipped,
      unknown_week: week.weekFilter.unknown,
      unknown_week_count: week.weekFilter.unknown_count,
      note: week.weekFilter.applied
        ? week.weekFilter.unknown_count
          ? '部分课程没有周次范围，按"可能发生"计入，本周课表不是精确结果'
          : `已按第 ${week.weekFilter.week_number} 周过滤学校原始课表`
        : '当前教学周未确认：带周次范围的课程无法判断，按"可能发生"计入，本周课表不是精确结果',
    },
    user_overrides: {
      path: displayPath(overridesPath()),
      exists: overridesRead.exists,
      counts: overridesCounts,
      week_number: weekNumber,
      week_number_source: weekResolution.source,
      week_number_reliable: weekResolution.reliable,
      week_number_needs_confirmation: Boolean(weekResolution.needs_confirmation),
      applied: week.overlay.applied,
      skipped: week.overlay.skipped,
      manual_classes: week.manualClassCount,
      personal_items: week.personalCount,
      cancelled_courses: week.cancelledCount,
      tasks_in_pool: userTasks.items.length,
      tasks_done_excluded: userTasks.skipped.length,
      tasks_deferred: deferredTasks.length,
      // 平台任务的本地状态：只影响本地排程，不提交、不回写学校平台
      external_state: {
        total: overridesCounts.external_tasks,
        done: overridesCounts.external_done,
        deferred: overridesCounts.external_deferred,
        hidden_this_run: pool.hidden_by_user_state.length,
        deferred_this_run: pool.stats.deferred_by_user_state,
        local_only: true,
        note: '雨课堂 / eCourse 任务的完成与延后只记在本地，学校平台不变',
      },
    },
    preferences_echo: describePreferences(preferences),
    preferences_provenance: preferences.provenance || null,
    readiness,
    unconfirmed_tasks: unconfirmedTasks.map((item) => ({
      title: item.title,
      course: item.course || null,
      source: item.source || null,
      deadline: item.deadline_display || '待确认',
      reasons: item.confirm_reasons || [],
    })),
    task_pool: {
      total: pool.items.length,
      by_source: pool.stats.by_source,
      overdue: pool.stats.overdue,
      unfinished: pool.stats.unfinished,
      needs_confirmation: pool.stats.needs_confirmation,
      assigned: taskAssignment.assigned.length,
      unschedulable: taskAssignment.unschedulable,
      leftover: taskAssignment.leftover,
      items: pool.items,
      hidden_by_user_state: pool.hidden_by_user_state,
      // 两个来源都没读到时，total=0 不是"没有作业"，而是"不知道"。
      // 结果页必须能区分这两种情况，否则等于伪造了一个 0。
      sources_read: { ecourse: Boolean(tasksDoc), rain: Boolean(rainDoc) },
      complete: !noTaskSource && !tasksIncomplete && rainFailed === 0 && !rainAuthExpired,
      incomplete_reason: noTaskSource
        ? 'eCourse 与雨课堂都没有读取'
        : tasksIncomplete || rainFailed > 0 || rainAuthExpired
          ? '有来源只读到一部分'
          : null,
    },
    free_minutes_forward: forwardFreeMinutes,
    free_minutes_total: totalFreeMinutes,
    rest_target_minutes: preferences.rest.enabled ? preferences.rest.daily_minutes : 0,
    rest_planned_minutes_forward: restPlan
      .filter((day) => !day.skipped)
      .reduce((sum, day) => sum + (day.planned_minutes || 0), 0),
    rest_shortfall_days: restShortfalls.map((day) => ({
      date: day.date,
      day_name: day.day_name,
      planned: day.planned_minutes,
      target: day.target_minutes,
      note: day.note,
    })),
    occupancy: week.days.map((day) => ({
      date: day.date,
      day_name: day.day_name,
      past: day.past,
      is_today: day.is_today,
      effective_start: day.effective_start,
      bounds: day.bounds,
      busy_minutes: day.busy_minutes,
      items: day.occupancy,
      cancelled: day.cancelled || [],
    })),
    free_windows: week.days.map((day) => ({
      date: day.date,
      day_name: day.day_name,
      past: day.past,
      is_today: day.is_today,
      effective_start: day.effective_start,
      windows: day.free_windows,
      total_minutes: day.free_windows.reduce((sum, item) => sum + item.minutes, 0),
    })),
    recommended_rest: restPlan,
    recommended_study: studyPlan,
    conflicts: conflictList,
    adjustments,
    pending,
    notes,
    plan_path: displayPath(path.join(outputDir, 'plan.json')),
  };

  const jsonPath = path.join(outputDir, 'schedule-analysis.json');
  const mdPath = path.join(outputDir, 'schedule-analysis.md');
  const planPath = path.join(outputDir, 'plan.json');
  writeJson(planPath, plan);

  // 默认就校验：排出来的计划合不合法，不应该是一个需要用户额外打开的开关
  let validation = hasFlag('--no-validate') ? null : runCheckPlan(planPath);
  if (validation) {
    result.validation = {
      ok: validation.ok,
      python: validation.python,
      hard_conflict_lines: (validation.output.match(/^\s*\[X\].*$/gm) || []).map((line) => line.trim()),
      output: validation.output,
    };
  }

  writeJson(jsonPath, result);
  fs.writeFileSync(mdPath, buildMarkdown(result), 'utf8');

  console.log(`SCHEDULE_ANALYSIS_OK:${displayPath(jsonPath)}`);
  console.log(`SCHEDULE_PLAN:${displayPath(planPath)}`);
  console.log(
    `SUMMARY:classes=${week.classCount} timetable_known=${timetableKnown ? 1 : 0} now=${clock.display} free_minutes_forward=${forwardFreeMinutes} tasks=${pool.items.length} overdue=${pool.stats.overdue} assigned=${taskAssignment.assigned.length} conflicts=${conflictList.length} adjusted=${adjustments.length} pending=${pending.length} rest_target=${result.rest_target_minutes} rest_planned=${result.rest_planned_minutes_forward} week=${weekNumber || '-'} week_filter=${week.weekFilter.applied ? week.weekFilter.week_number : 'off'} week_skipped=${week.weekFilter.skipped.length} week_unknown=${week.weekFilter.unknown_count} manual_classes=${week.manualClassCount} cancelled=${week.cancelledCount} user_tasks=${userTasks.items.length} task_done_local=${pool.hidden_by_user_state.length} task_deferred_local=${pool.stats.deferred_by_user_state}`
  );
  if (validation) console.log(`CHECK_PLAN:${validation.ok ? 'PASS' : 'FAILED'}\n${validation.output.trim()}`);
  return { result, planPath, jsonPath, mdPath, validation };
}

function runCheckPlan(planPath) {
  const script = path.join(__dirname, '..', '..', 'huayuan-task-card', 'scripts', 'check_plan.py');
  const candidates = [process.env.HUAYUAN_PYTHON, 'python', 'python3', 'py'].filter(Boolean);
  for (const python of candidates) {
    const attempt = spawnSync(python, [script, planPath], { encoding: 'utf8' });
    if (attempt.error && attempt.error.code === 'ENOENT') continue;
    return {
      ok: attempt.status === 0,
      status: attempt.status,
      output: `${attempt.stdout || ''}${attempt.stderr || ''}`,
      python,
    };
  }
  return { ok: false, status: null, output: '未找到可用的 python 解释器，跳过 check_plan 校验', python: null };
}

function buildMarkdown(result) {
  const lines = [];
  lines.push('# 日程分析（可解释）');
  lines.push('');
  lines.push(`- 生成时间：${result.generated_at}`);
  lines.push(`- 统计基准：现在 = ${result.now ? result.now.display : '未知'}（今天只用这个时刻之后的时间）`);
  lines.push(`- 本周起始：${result.week_start}`);
  if (!result.timetable_known) {
    lines.push(
      '- **课表未知**：下面的空闲时间与作业时段只是按作息偏好估算，没有扣除上课时间，**不能当最终计划**'
    );
  }
  lines.push(`- 课表来源：${result.inputs.timetable || '未读取到（先运行 jw-timetable.js）'}`);
  lines.push(`- 学期：${result.inputs.timetable_semester || '待确认'}`);
  lines.push(`- 任务来源：${result.inputs.tasks || '未读取到（先运行 ecourse-pull.js）'}`);
  lines.push(
    `- 雨课堂来源：${result.inputs.rain ? `${result.inputs.rain}（${result.inputs.rain_status || '状态未知'}）` : '未读取到（先运行 rain-fast.js）'}`
  );
  lines.push(`- 偏好来源：${result.inputs.preferences}`);
  const weekInfo = (result.user_overrides && result.user_overrides.week_number) || null;
  lines.push(
    `- 周次：${
      weekInfo
        ? `第 ${weekInfo} 周（来源：${(result.user_overrides && result.user_overrides.week_number_source) || '未标注'}）`
        : '未确认（带周次范围的课程按"可能发生"计入，本周课表不是精确结果；用 manage-items.js set-week --number N 指定）'
    }`
  );
  if (result.week_filter) {
    const wf = result.week_filter;
    if (wf.applied) {
      lines.push(
        `- 周次过滤：学校原始课表 ${wf.courses_total} 段，按第 ${wf.week_number} 周保留 ${wf.courses_kept} 段、排除 ${wf.sessions_skipped} 段`
      );
      if (wf.skipped.length) {
        lines.push(
          `  - 本周不上：${wf.skipped
            .map((item) => `${item.title}（${item.weeks || '周次未知'}）`)
            .filter((value, index, array) => array.indexOf(value) === index)
            .join('、')}`
        );
      }
    } else {
      lines.push('- 周次过滤：**未执行**（当前教学周未知），带周次范围的课程全部按"可能发生"计入，本周不是精确课表');
    }
    if (wf.unknown_week_count) {
      lines.push(
        `  - 周次未确认：${wf.unknown_week
          .map((item) => item.title)
          .join('、')}（没有读到周次范围，按"可能发生"计入）`
      );
    }
  }
  lines.push('');
  lines.push('## 统一任务池');
  lines.push('');
  const pool = result.task_pool;
  lines.push(
    `- 未完成合计 ${pool.unfinished + pool.overdue} 条：eCourse ${pool.by_source.eCourse} 条 / 雨课堂 ${
      pool.by_source['雨课堂']
    } 条 / 手工 ${pool.by_source.user || 0} 条`
  );
  lines.push(`- 其中已过期 ${pool.overdue} 条、截止时间待确认 ${pool.needs_confirmation} 条、已排入作业时段 ${pool.assigned} 条`);
  if (pool.items.length) {
    lines.push('');
    lines.push('| 状态 | 任务 | 课程 | 来源 | 截止 |');
    lines.push('|---|---|---|---|---|');
    for (const item of pool.items.slice(0, 40)) {
      const status = item.status === 'overdue' ? '已过期未完成' : item.needs_confirmation ? '待确认' : '未完成';
      const sources = item.sources.map((name) => (name === 'user' ? '手工' : name)).join(' + ');
      lines.push(
        `| ${status} | ${item.title} | ${item.course || '待确认'} | ${sources} | ${item.deadline_display} |`
      );
    }
    if (pool.items.length > 40) lines.push(`| … | 另有 ${pool.items.length - 40} 条 | | | |`);
  }
  if (pool.unschedulable.length) {
    lines.push('');
    lines.push('本周排不进去的任务：');
    for (const item of pool.unschedulable) lines.push(`- ${item.title}（${item.course || '课程待确认'}）：${item.reason}`);
  }
  if (Array.isArray(pool.hidden_by_user_state) && pool.hidden_by_user_state.length) {
    lines.push('');
    lines.push('你标记为已完成（只记在本地，学校平台未变）：');
    for (const item of pool.hidden_by_user_state) {
      lines.push(
        `- ${item.title}（${item.sources.join(' + ')}｜截止 ${item.deadline}｜证据 ${item.evidence}${
          item.matched_by === 'title+deadline' ? '｜按标题+截止日匹配' : ''
        }）`
      );
    }
  }
  const deferredPlatform = pool.items.filter((item) => item.status_override);
  if (deferredPlatform.length) {
    lines.push('');
    lines.push('你要求延后的平台任务（只记在本地，学校平台未变）：');
    for (const item of deferredPlatform) {
      lines.push(
        `- ${item.title}（${item.sources.join(' + ')}）：${item.deferred_until} 之前不排｜证据 ${item.status_override.evidence}`
      );
    }
  }
  if (pool.leftover.length) {
    lines.push('');
    lines.push('本周作业时段已排满、未安排到具体时段：');
    for (const item of pool.leftover.slice(0, 10)) lines.push(`- ${item.title}（截止 ${item.deadline}）`);
  }
  lines.push('');
  lines.push('## 个人偏好（本次排程口径）');
  lines.push('');
  for (const line of result.preferences_echo) lines.push(`- ${line}`);
  lines.push('');
  lines.push('## 手工覆盖（你添加 / 停掉的部分）');
  lines.push('');
  {
    const ov = result.user_overrides || null;
    if (!ov || (!ov.applied.courses && !ov.applied.personal && !ov.applied.cancellations && !ov.tasks_in_pool)) {
      lines.push('- 本次没有任何手工记录（学校课表原样生效）');
    } else {
      lines.push(
        `- 已生效：手工课程 ${ov.applied.courses} 段、个人事项 ${ov.applied.personal} 段、停课 ${ov.applied.cancellations} 段；手工任务进入待办 ${ov.tasks_in_pool} 条（已完成 ${ov.tasks_done_excluded} 条不进待办、延后 ${ov.tasks_deferred} 条按延后日期起排）`
      );
      if (ov.skipped.length) {
        lines.push('- 本次未生效：');
        for (const item of ov.skipped) lines.push(`  - ${item.title}：${item.reason}`);
      }
      lines.push(`- 覆盖层文件：${ov.path}（学校原始课表未被修改）`);
    }
  }
  lines.push('');
  lines.push('## 当前占用');
  lines.push('');
  lines.push('已过去的时段只作为历史占用列出，不参与任何推荐与排程。');
  lines.push('');
  lines.push('| 日期 | 可用时段 | 已占用分钟 | 明细 |');
  lines.push('|---|---|---|---|');
  for (const day of result.occupancy) {
    const rows = [];
    for (const item of day.items) {
      // 同一时段可能有不同周次的同名课程（如「4-13周 9-11节」与「第14周 9-10节」），
      // 带上周次才不会看起来像重复条目
      const weeks = item.source === 'class' && item.weeks ? `（${item.weeks}）` : '';
      const sourceTag =
        item.source === 'user' ? '（手工添加）' : item.source === 'personal' ? '（个人事项）' : '';
      const tag = item.history ? '（已过去）' : '';
      rows.push(`${item.start}-${item.end} ${item.title}${weeks}${sourceTag}${tag}`);
    }
    for (const item of day.cancelled || []) {
      rows.push(`${item.start}-${item.end} ${item.title}（已按你的记录停课）`);
    }
    const items = rows.length ? rows.join('<br>') : '无';
    const range = day.past ? '（已过去）' : day.effective_start && day.effective_start !== day.bounds.start
      ? `${day.effective_start}-${day.bounds.end}（现在之后）`
      : `${day.bounds.start}-${day.bounds.end}`;
    lines.push(`| ${day.date} ${day.day_name} | ${range} | ${day.busy_minutes} | ${items} |`);
  }
  lines.push('');
  lines.push('## 空闲窗口');
  lines.push('');
  lines.push('| 日期 | 空闲窗口 | 合计 |');
  lines.push('|---|---|---|');
  for (const day of result.free_windows) {
    if (day.past) {
      lines.push(`| ${day.date} ${day.day_name} | 已过去，不再计算空闲 | 0 分钟 |`);
      continue;
    }
    const windows = day.windows.length
      ? day.windows.map((item) => `${item.start}-${item.end}（${item.minutes} 分钟）`).join('<br>')
      : '无整块空闲';
    lines.push(`| ${day.date} ${day.day_name} | ${windows} | ${day.total_minutes} 分钟 |`);
  }
  lines.push('');
  lines.push('## 推荐休息');
  lines.push('');
  for (const day of result.recommended_rest) {
    if (!day.slots.length) {
      lines.push(`- ${day.date} ${day.day_name}：${day.note || '无需安排'}`);
      continue;
    }
    lines.push(
      `- ${day.date} ${day.day_name}：合计 ${day.planned_minutes}/${day.target_minutes} 分钟 —— ${day.slots
        .map((slot) => `${slot.start}-${slot.end}（${slot.reason}）`)
        .join('；')}${day.note ? `；${day.note}` : ''}`
    );
  }
  lines.push('');
  lines.push('## 推荐作业/自习时段');
  lines.push('');
  for (const day of result.recommended_study) {
    if (!day.slots.length) {
      lines.push(`- ${day.date} ${day.day_name}：${day.note}`);
      continue;
    }
    lines.push(
      `- ${day.date} ${day.day_name}：${day.slots
        .map((slot) => (slot.task ? `${slot.start}-${slot.end} 作业「${slot.task.title}」` : `${slot.start}-${slot.end}`))
        .join('、')}；合计 ${day.planned_minutes}/${day.daily_limit_min} 分钟`
    );
  }
  lines.push('');
  if (result.conflicts.length) {
    lines.push(`## 需要你决定的冲突（${result.conflicts.length} 条）`);
    lines.push('');
    for (const item of result.conflicts) {
      lines.push(`- ${item.date} ${item.detail} —— 因为${item.reason}，所以需要调整`);
    }
    lines.push('');
  } else {
    lines.push('## 需要你决定的冲突：0 条');
    lines.push('');
  }
  if (result.adjustments.length) {
    lines.push(`## 已自动调整（${result.adjustments.length} 条，仅告知）`);
    lines.push('');
    for (const item of result.adjustments) {
      lines.push(`- ${item.date} ${item.detail} —— 因为${item.reason}`);
    }
    lines.push('');
  }
  if ((result.notes || []).length) {
    lines.push('## 说明');
    lines.push('');
    for (const note of result.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  if (result.pending.length) {
    lines.push(`## 待确认（${result.pending.length} 条）`);
    lines.push('');
    result.pending.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    lines.push('');
  }
  lines.push('## 下一步');
  lines.push('');
  lines.push(`- 计划骨架：${result.plan_path}`);
  if (result.validation) {
    lines.push(
      `- 硬约束校验：${result.validation.ok ? '通过（0 条硬冲突）' : `未通过（${result.validation.hard_conflict_lines.length} 条）`}`
    );
    for (const line of result.validation.hard_conflict_lines) lines.push(`  - ${line}`);
  } else {
    lines.push('- 校验：`python ../../huayuan-task-card/scripts/check_plan.py <plan.json>`');
  }
  lines.push('- 想改偏好：告诉智能体新的作息/上限/运动时间，重跑本脚本即可，不需要重新登录');
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  try {
    analyze();
  } catch (error) {
    console.error(`SCHEDULE_ANALYSIS_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exit(1);
  }
}

module.exports = {
  analyze,
  assignTasksToStudy,
  buildWeek,
  recommendRest,
  recommendStudy,
  runCheckPlan,
  subtractWindows,
};
