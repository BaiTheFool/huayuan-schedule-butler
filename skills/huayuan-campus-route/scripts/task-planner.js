'use strict';

/**
 * 考试 / 待办 → 复习任务
 *
 * 输入：
 *   - 考试：{ id,title,course,date,start,end,venue,type,majors,credits }
 *   - 手动待办：{ title,due,estimated_minutes,priority,notes }
 *   - 专业：用于筛选考试（考试没写 majors 则视为不限专业）
 *
 * 输出：T-14 / T-7 / T-3 / T-1 四段复习任务 + 手动待办合并后的清单。
 * 只做确定性拆分，不编造考试日期；没有考试数据时返回空清单和原因。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HuayuanTasks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400000;

  const MILESTONES = [
    { key: 't14', daysBefore: 14, label: '第一轮复习 · 梳理框架', minutes: 90, priority: 'P2', factor: 1.2 },
    { key: 't7', daysBefore: 7, label: '第二轮复习 · 刷题与错题', minutes: 90, priority: 'P1', factor: 1 },
    { key: 't3', daysBefore: 3, label: '第三轮复习 · 模拟卷与重点', minutes: 75, priority: 'P0', factor: 0.8 },
    { key: 't1', daysBefore: 1, label: '考前冲刺 · 公式与错题', minutes: 60, priority: 'P0', factor: 0.6 },
  ];

  function parseDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime());
    const text = String(value || '').trim();
    let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!match) return null;
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0)
    );
  }

  function dateKey(date) {
    const d = date instanceof Date ? date : parseDate(date);
    if (!d) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function startOfDay(date) {
    const d = date instanceof Date ? new Date(date.getTime()) : parseDate(date);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(date, days) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
  }

  function atTime(date, time) {
    const d = new Date(date.getTime());
    const match = String(time || '21:00').match(/^(\d{2}):(\d{2})$/);
    if (match) {
      d.setHours(Number(match[1]), Number(match[2]), 0, 0);
    } else {
      d.setHours(21, 0, 0, 0);
    }
    return d;
  }

  function dueIso(date) {
    return `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function normalizeMajor(value) {
    return String(value || '').trim();
  }

  function examMatchesMajor(exam, major) {
    const target = normalizeMajor(major);
    const majors = Array.isArray(exam && exam.majors) ? exam.majors.map(normalizeMajor).filter(Boolean) : [];
    if (!target || !majors.length) return true;
    return majors.some((item) => item === target || item.includes(target) || target.includes(item));
  }

  function normalizeExam(raw) {
    if (!raw || !raw.title) return null;
    const date = parseDate(raw.date || raw.exam_date);
    if (!date) return null;
    return {
      id: String(raw.id || `exam-${dateKey(date)}-${raw.title}`).slice(0, 80),
      title: String(raw.title).trim().slice(0, 80),
      course: raw.course ? String(raw.course).trim().slice(0, 60) : null,
      date: dateKey(date),
      start: raw.start || raw.start_time || null,
      end: raw.end || raw.end_time || null,
      venue: raw.venue || raw.room || null,
      type: raw.type || 'exam',
      scope: raw.scope || 'school',
      majors: Array.isArray(raw.majors) ? raw.majors.map(String).slice(0, 12) : [],
      credits: Number.isFinite(Number(raw.credits)) ? Number(raw.credits) : null,
      demo: Boolean(raw.demo),
    };
  }

  function planExamTasks(exams, options) {
    const opts = options || {};
    const now = parseDate(opts.now || new Date()) || new Date();
    const today = startOfDay(now);
    const horizon = Number.isFinite(Number(opts.horizonDays)) ? Number(opts.horizonDays) : 90;
    const major = normalizeMajor(opts.major);
    const warnings = [];
    const matched = [];
    const tasks = [];

    for (const raw of Array.isArray(exams) ? exams : []) {
      const exam = normalizeExam(raw);
      if (!exam) continue;
      if (!examMatchesMajor(exam, major)) continue;
      const examDay = startOfDay(exam.date);
      if (!examDay) continue;
      const daysLeft = Math.round((examDay.getTime() - today.getTime()) / DAY);
      if (daysLeft < 0) continue;
      if (daysLeft > horizon) continue;
      matched.push({ ...exam, days_left: daysLeft });

      const credits = exam.credits || 3;
      for (const milestone of MILESTONES) {
        const dueDay = addDays(examDay, -milestone.daysBefore);
        if (dueDay < today) continue;
        const due = atTime(dueDay, milestone.daysBefore === 1 ? '20:00' : '21:00');
        if (due.getTime() < now.getTime()) continue;
        const minutes = Math.max(30, Math.round(milestone.minutes * milestone.factor * (0.7 + credits * 0.1)));
        tasks.push({
          id: `exam:${exam.id}:${milestone.key}`,
          title: `${exam.title} · ${milestone.label}`,
          course: exam.course,
          due: dueIso(due),
          due_date: dateKey(due),
          priority: milestone.priority,
          estimated_minutes: minutes,
          source: 'exam',
          exam_id: exam.id,
          exam_title: exam.title,
          exam_date: exam.date,
          exam_start: exam.start,
          venue: exam.venue,
          reason: `距 ${exam.title} 还有 ${daysLeft} 天；按 T-${milestone.daysBefore} 节点自动拆分`,
          done: false,
        });
      }
    }

    if (major && !matched.length) {
      warnings.push(`没有匹配「${major}」的考试；请导入考试安排或先填专业`);
    } else if (!matched.length) {
      warnings.push('还没有考试安排；先导入考试 JSON，或载入示例考试');
    }

    return { tasks, exams: matched, warnings, major };
  }

  function normalizeManualTask(raw, index) {
    if (!raw || !String(raw.title || '').trim()) return null;
    const due = parseDate(raw.due || raw.deadline || raw.due_date);
    const title = String(raw.title).trim().slice(0, 100);
    return {
      id: String(raw.id || `manual-${Date.now()}-${index || 0}`),
      title,
      due: due ? dueIso(due) : null,
      due_date: due ? dateKey(due) : null,
      priority: /^P[0-3]$/.test(String(raw.priority || '').toUpperCase()) ? String(raw.priority).toUpperCase() : 'P2',
      estimated_minutes: Math.max(10, Math.min(480, Number(raw.estimated_minutes) || 60)),
      source: 'manual',
      notes: raw.notes ? String(raw.notes).slice(0, 300) : null,
      done: Boolean(raw.done),
    };
  }

  function normalizeManualTasks(list) {
    return (Array.isArray(list) ? list : []).map(normalizeManualTask).filter(Boolean);
  }

  function mergeTasks(autoTasks, manualTasks) {
    const all = [...(autoTasks || []), ...(manualTasks || [])];
    const seen = new Set();
    return all
      .filter((task) => {
        if (!task || !task.id || seen.has(task.id)) return false;
        seen.add(task.id);
        return true;
      })
      .sort((a, b) => {
        const da = parseDate(a.due);
        const db = parseDate(b.due);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da - db;
      });
  }

  function taskStatus(task, now) {
    const current = parseDate(now || new Date()) || new Date();
    const due = parseDate(task && task.due);
    if (!due) return { key: 'undated', label: '无截止', days: null, overdue: false };
    if (task.done) return { key: 'done', label: '已完成', days: null, overdue: false };
    const days = Math.floor((startOfDay(due) - startOfDay(current)) / DAY);
    if (due < current) return { key: 'overdue', label: '已逾期', days, overdue: true };
    if (days === 0) return { key: 'today', label: '今天截止', days: 0, overdue: false };
    if (days <= 3) return { key: 'soon', label: `${days} 天后`, days, overdue: false };
    return { key: 'later', label: `${days} 天后`, days, overdue: false };
  }

  function summarizeTasks(tasks, now) {
    const list = Array.isArray(tasks) ? tasks : [];
    const pending = list.filter((task) => !task.done);
    const statuses = pending.map((task) => taskStatus(task, now));
    return {
      total: list.length,
      pending: pending.length,
      done: list.length - pending.length,
      overdue: statuses.filter((s) => s.key === 'overdue').length,
      today: statuses.filter((s) => s.key === 'today').length,
      due_7: statuses.filter((s) => s.days !== null && s.days >= 0 && s.days <= 7).length,
      minutes: pending.reduce((sum, task) => sum + (Number(task.estimated_minutes) || 0), 0),
    };
  }

  return {
    MILESTONES,
    parseDate,
    dateKey,
    dueIso,
    taskStatus,
    summarizeTasks,
    planExamTasks,
    normalizeExam,
    normalizeManualTask,
    normalizeManualTasks,
    mergeTasks,
    examMatchesMajor,
  };
});
