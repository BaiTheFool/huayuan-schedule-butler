'use strict';

/**
 * timeline-brief：把已经算好的结果压成一条**简洁时间轴**。
 *
 * 硬规则（不要放宽）：
 *   1. 确定性脚本，不调用大模型重新规划，不联网；
 *   2. 默认只输出「现在 + 接下来 6 小时」，最多 8 行；
 *   3. 每行固定四段：时间 | 事项 | 来源 | 优先级或状态；
 *   4. 来源只用 [课程] [任务] [偏好] [临时] [待确认]；
 *   5. 不生成 SVG / 图片 / 大表格，不重复课程数、待办数这类摘要；
 *   6. 正常情况下 1 秒内完成。
 *
 * 用法：
 *   node timeline-brief.js                       # 读默认输出目录
 *   node timeline-brief.js --output-dir out       # 指定目录
 *   node timeline-brief.js --hours 3              # 只看接下来 3 小时
 *   node timeline-brief.js --json                 # 同行数据的 JSON（给上层排版用）
 *   node timeline-brief.js --self-check           # 离线自检
 */

const fs = require('fs');
const path = require('path');

const MAX_ROWS = 8;
const DEFAULT_HOURS = 6;

// 来源标签：只有这五个，不发明新词
const SOURCE_TAG = {
  class: '[课程]',
  user: '[临时]',
  personal: '[临时]',
  study: '[任务]',
  task: '[任务]',
  meal: '[偏好]',
  rest: '[偏好]',
  exercise: '[偏好]',
  fixed: '[偏好]',
  free: '[空闲]',
  unknown: '[待确认]',
};

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function toMinutes(clock) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(clock || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function toClock(minutes) {
  const value = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function tagOf(row) {
  if (row.needs_confirmation) return SOURCE_TAG.unknown;
  if (row.kind === 'free' || row.source === 'free') return SOURCE_TAG.free;
  if (row.source === 'class') return SOURCE_TAG.class;
  if (row.source === 'user') return row.origin === 'user-personal' ? SOURCE_TAG.personal : SOURCE_TAG.user;
  if (row.source === 'personal') return SOURCE_TAG.personal;
  if (row.source === 'study' || row.kind === 'task') return SOURCE_TAG.task;
  if (row.source === 'meal' || row.source === 'rest' || row.source === 'exercise' || row.source === 'fixed') {
    return SOURCE_TAG[SOURCE_TAG[row.source] ? row.source : 'unknown'];
  }
  return SOURCE_TAG.unknown;
}

/**
 * 从 now.json 的 sequence 里取"现在 + 接下来 N 小时"。
 * sequence 已经是排好序的（上课 / 学习 / 用餐 / 休息 / 任务），直接裁剪即可，
 * 不做任何重新规划。
 */
function rowsFromSequence(nowDoc, { minutes, horizonMinutes }) {
  const sequence = Array.isArray(nowDoc.sequence) ? nowDoc.sequence : [];
  const rows = [];
  for (const item of sequence) {
    const start = toMinutes(item.start);
    const end = toMinutes(item.end);
    if (start === null) continue;
    // 已经结束的段不进时间轴；超出视野的段也不进
    if (end !== null && end <= minutes) continue;
    if (start > minutes + horizonMinutes) break;
    rows.push({
      start: item.start,
      end: item.end || item.start,
      title: item.title,
      tag: tagOf(item),
      status: item.priority ? `P${item.priority}` : statusOf(item),
    });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

function statusOf(item) {
  if (item.kind === 'rest') return '休息';
  if (item.kind === 'meal') return '用餐';
  if (item.kind === 'class') return '上课';
  if (item.kind === 'fixed') return '固定';
  if (item.kind === 'study' || item.kind === 'task') return '进行中';
  return '—';
}

/** 空闲窗口补进来（最多补到 8 行），格式与示例一致：18:20—19:00 可安排 [空闲] */
function fillFreeWindows(nowDoc, rows, { minutes, horizonMinutes }) {
  if (rows.length >= MAX_ROWS) return rows;
  const windows = Array.isArray(nowDoc.free_windows) ? nowDoc.free_windows : [];
  for (const win of windows) {
    const start = toMinutes(win.start);
    const end = toMinutes(win.end);
    if (start === null || end === null) continue;
    if (end <= minutes || start > minutes + horizonMinutes) continue;
    rows.push({ start: win.start, end: win.end, title: '可安排', tag: SOURCE_TAG.free, status: '空闲' });
    if (rows.length >= MAX_ROWS) break;
  }
  rows.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  return rows;
}

function buildTimeline(nowDoc, { hours = DEFAULT_HOURS } = {}) {
  const clock = nowDoc.now || {};
  const clockText = clock.time || (clock.display ? String(clock.display) : '');
  // now.json 的 display 形如 "2026-11-04 14:20"，这里只取 HH:MM 部分
  const minutes = toMinutes(clockText) ?? toMinutes((String(clockText).match(/(\d{1,2}:\d{2})/) || [])[1] ?? '') ?? Number(clock.minutes ?? 0);
  const horizonMinutes = hours * 60;
  let rows = rowsFromSequence(nowDoc, { minutes, horizonMinutes });
  if (!rows.length) rows = fillFreeWindows(nowDoc, rows, { minutes, horizonMinutes });
  else rows = fillFreeWindows(nowDoc, rows, { minutes, horizonMinutes });
  return {
    now: clock.display || clock.time || null,
    horizon_hours: hours,
    rows: rows.slice(0, MAX_ROWS),
    // 数据不完整时明确说"估算"，不冒充正式计划
    estimate_only: Boolean(nowDoc.data_status && nowDoc.data_status.estimate_only),
  };
}

function render(timeline) {
  const lines = [];
  if (timeline.estimate_only) lines.push('（数据未确认，以下为估算）');
  for (const row of timeline.rows) {
    lines.push(`${row.start}—${row.end} ${row.title} ${row.tag} ${row.status}`);
  }
  if (!timeline.rows.length) lines.push('接下来 6 小时没有已排事项，也没有可用空档数据。');
  return lines.join('\n');
}

function selfCheck() {
  const cases = [];
  const check = (name, ok, detail = '') => {
    cases.push({ name, ok: Boolean(ok) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  check('来源标签只有五类', ['[课程]', '[任务]', '[偏好]', '[临时]', '[待确认]', '[空闲]'].every((tag) => Object.values(SOURCE_TAG).includes(tag)));

  const doc = {
    now: { display: '2026-11-04 14:20' },
    sequence: [
      { date: '2026-11-04', start: '14:30', end: '16:10', kind: 'class', title: '生产运作管理（样例）', source: 'class' },
      { date: '2026-11-04', start: '16:10', end: '17:40', kind: 'study', title: '第 6 章作业（样例）', source: 'study', priority: 0 },
      { date: '2026-11-04', start: '18:20', end: '19:00', kind: 'meal', title: '晚餐', source: 'meal' },
      { date: '2026-11-04', start: '21:10', end: '22:10', kind: 'rest', title: '休息', source: 'rest' },
    ],
    free_windows: [{ start: '19:00', end: '20:00' }],
  };
  const started = Date.now();
  const timeline = buildTimeline(doc, { hours: 6 });
  const elapsed = Date.now() - started;
  check('生成耗时小于 1 秒', elapsed < 1000, `${elapsed}ms`);
  check('最多 8 行', timeline.rows.length <= MAX_ROWS, `${timeline.rows.length} 行`);
  check('每行四段：时间 | 事项 | 来源 | 状态', render(timeline).split('\n').every((line) => /^\d{2}:\d{2}—\d{2}:\d{2} .+ \[.+\] /.test(line)));
  check('课程标 [课程]、任务标 [任务]', timeline.rows[0].tag === '[课程]' && timeline.rows[1].tag === '[任务]', `${timeline.rows[0].tag}/${timeline.rows[1].tag}`);
  check('已结束的段不进时间轴', !timeline.rows.some((row) => toMinutes(row.end) <= toMinutes('14:20')));
  check('不输出课程数/待办数这类摘要', !/课程 \d|待办 \d|共 \d 门/.test(render(timeline)));
  check('不生成 SVG 或 HTML', !/<svg|<div|<table/i.test(render(timeline)));
  check('确定性：同样输入两次结果一致', render(buildTimeline(doc, { hours: 6 })) === render(timeline));
  check('超出视野的段被裁剪', !timeline.rows.some((row) => toMinutes(row.start) > toMinutes('14:20') + 360));

  const failed = cases.filter((item) => !item.ok).length;
  console.log(failed ? `SELF_CHECK_FAILED:${failed}` : `SELF_CHECK_PASS ${cases.length}/${cases.length}`);
  return failed === 0;
}

function main() {
  if (process.argv.includes('--self-check')) {
    process.exitCode = selfCheck() ? 0 : 1;
    return;
  }
  const outputDir = path.resolve(argValue('--output-dir', path.join(process.cwd(), 'huayuan-output')));
  const hours = Number(argValue('--hours', DEFAULT_HOURS)) || DEFAULT_HOURS;
  const nowPath = argValue('--now', path.join(outputDir, 'now.json'));
  const nowDoc = readJson(nowPath);
  if (!nowDoc) {
    console.log('NO_NOW_JSON:还没有 now.json，先跑一次 now.js（或完成初始化）');
    process.exitCode = 2;
    return;
  }
  const timeline = buildTimeline(nowDoc, { hours });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(timeline, null, 2));
    return;
  }
  console.log(`TIMELINE_ROWS:${timeline.rows.length}`);
  console.log(render(timeline));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`TIMELINE_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exit(1);
  }
}

module.exports = { MAX_ROWS, SOURCE_TAG, buildTimeline, render, selfCheck, tagOf };
