'use strict';

/**
 * 0.8.1 排程回归：
 * 1. 任务按真实预计耗时入槽，不再整段占用空档；
 * 2. 长任务可拆成多段，并标注第 N/M 段；
 * 3. 无截止时间但标题明确的手工任务仍可立即安排；
 * 4. 当前空档只有 20 分钟时也直接开始，不等所谓“完整空档”；
 * 5. 第一动作与“接下来”必须引用同一条已绑定任务。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(PKG_ROOT, 'skills', 'huayuan-browser-session', 'scripts');
const FIXTURES = path.join(__dirname, 'fixtures');
const WORK = path.join(os.tmpdir(), `huayuan-v081-${Date.now()}`);
const HOME = path.join(WORK, 'home');
const OUT = path.join(WORK, 'out');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function run(script, args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: WORK,
    encoding: 'utf8',
    env: { ...process.env, HUAYUAN_HOME: HOME, HUAYUAN_OUTPUT_DIR: OUT, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    all: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
for (const name of fs.readdirSync(FIXTURES)) {
  if (name.endsWith('.json')) fs.copyFileSync(path.join(FIXTURES, name), path.join(OUT, name));
}

console.log('0.8.1 即时排程回归（离线、虚构样例）');

const { assignTasksToStudy } = require(path.join(SCRIPTS, 'schedule-analyze.js'));

console.log('\n[1] 任务按实际耗时切片');
const oneTask = {
  title: '背英语单词',
  course: null,
  task_type: '手工任务',
  source: 'user',
  sources: ['user'],
  deadline: null,
  deadline_display: '待确认',
  priority: 'P1',
  estimated_minutes: 45,
  status: 'unfinished',
  needs_confirmation: true,
  confirm_reasons: ['未给出截止时间'],
};
const shortPlan = [
  {
    date: '2026-10-28',
    day_name: '周三',
    daily_limit_min: 180,
    planned_minutes: 60,
    slots: [{ start: '20:10', end: '21:10', minutes: 60, reason: '当前空档' }],
  },
  {
    date: '2026-10-29',
    day_name: '周四',
    daily_limit_min: 180,
    planned_minutes: 90,
    slots: [{ start: '09:00', end: '10:30', minutes: 90, reason: '后续空档' }],
  },
];
assignTasksToStudy(shortPlan, { items: [oneTask] }, { bufferMinutes: 15 });
check(
  '45 分钟任务只绑定 45 分钟，不占满 60 分钟空档',
  shortPlan[0].slots.length === 1 &&
    shortPlan[0].slots[0].start === '20:10' &&
    shortPlan[0].slots[0].end === '20:55' &&
    shortPlan[0].slots[0].task.title === '背英语单词',
  shortPlan[0].slots.map((slot) => `${slot.start}-${slot.end}:${slot.task ? slot.task.title : '未绑定'}`).join(', ')
);
check('任务完成后不再展示无绑定的明日自由学习', shortPlan[1].slots.length === 0, JSON.stringify(shortPlan[1].slots));

console.log('\n[2] 长任务可拆段');
const longTask = { ...oneTask, title: '课程设计报告', estimated_minutes: 120 };
const splitPlan = [
  {
    date: '2026-10-28',
    day_name: '周三',
    daily_limit_min: 180,
    planned_minutes: 150,
    slots: [
      { start: '18:30', end: '20:00', minutes: 90, reason: '第一段空档' },
      { start: '20:15', end: '21:15', minutes: 60, reason: '第二段空档' },
    ],
  },
];
assignTasksToStudy(splitPlan, { items: [longTask] }, { bufferMinutes: 15 });
check(
  '120 分钟任务拆为 90 + 30 分钟，并标第 1/2、2/2 段',
  splitPlan[0].slots.length === 2 &&
    splitPlan[0].slots[0].minutes === 90 &&
    splitPlan[0].slots[1].minutes === 30 &&
    splitPlan[0].slots[0].task.part_index === 1 &&
    splitPlan[0].slots[0].task.part_count === 2 &&
    splitPlan[0].slots[1].task.part_index === 2,
  splitPlan[0].slots.map((slot) => `${slot.start}-${slot.end}(${slot.minutes})`).join(', ')
);

console.log('\n[3] 当前短空档直接开始');
const wizard = run('first-run.js', [
  '--wizard',
  '--yes',
  '--prefs',
  path.join(FIXTURES, 'preferences.json'),
  '--skip-check',
  '--skip-read',
  '--output-dir',
  OUT,
  '--week-number',
  '10',
  '--profile-id',
  'v081',
]);
process.env.HUAYUAN_HOME = HOME;
const paths = require(path.join(SCRIPTS, 'huayuan-paths.js'));
paths.writeSetupState({
  state: 'completed',
  detail: {
    status: 'completed',
    missing: [],
    partial: [],
    timetable_known: true,
    profile_id: 'v081',
    simulated: '0.8.1 回归：空任务清单 + 手工任务',
  },
});
const emptyTasks = path.join(OUT, 'ecourse-tasks.json');
fs.writeFileSync(
  emptyTasks,
  JSON.stringify({
    status: 'READ_OK',
    summary: { total: 0, submitted: 0, unfinished: 0, unparsed: 0, failed: 0 },
    tasks: [],
    unparsed_records: [],
  }),
  'utf8'
);
const emptyRain = path.join(OUT, 'rain-fast.json');
fs.writeFileSync(
  emptyRain,
  JSON.stringify({
    source: '回归空任务',
    summary: { courses_total: 0, failed: 0, unfinished_total: 0 },
    courses: [],
  }),
  'utf8'
);
const addTask = run('manage-items.js', [
  'add-task',
  '--title',
  '背英语单词',
  '--minutes',
  '45',
  '--priority',
  'P1',
]);
const nowRun = run('now.js', [
  '--output-dir',
  OUT,
  '--now',
  '2026-11-04T17:20:00',
  '--timetable',
  path.join(OUT, 'jw-timetable.json'),
  '--tasks',
  emptyTasks,
  '--rain',
  emptyRain,
  '--prefs',
  path.join(FIXTURES, 'preferences.json'),
  '--week-start',
  '2026-11-02',
  '--week-number',
  '10',
]);
const nowDoc = readJson(path.join(OUT, 'now.json')) || {};
const first = nowDoc.first_action || {};
const firstToday = (nowDoc.sequence || []).find((row) => row.date === '2026-11-04');
check('向导与手工任务准备成功', wizard.status === 0 && addTask.status === 0, `${wizard.status}/${addTask.status}`);
check(
  '20 分钟当前空档也直接开始，不等待完整 45 分钟',
  nowRun.status === 0 &&
    first.type === 'start_task' &&
    /背英语单词/.test(first.headline || '') &&
    /17:20-17:40/.test(first.headline || ''),
  first.headline || nowRun.all.slice(-300)
);
check(
  '短窗口提示与第一动作一致，不再说“不要开新任务”',
  nowDoc.window &&
    /(先推进「背英语单词」|连续可用 20 分钟)/.test(nowDoc.window.note || '') &&
    !/不要开新任务/.test(nowDoc.window.note || ''),
  nowDoc.window && nowDoc.window.note
);
check(
  '第一动作与“接下来”绑定同一条任务',
  firstToday &&
    firstToday.kind === 'task' &&
    /^背英语单词（第 1\/2 段）$/.test(firstToday.title || '') &&
    firstToday.start === '17:20' &&
    firstToday.end === '17:40',
  firstToday ? `${firstToday.kind} ${firstToday.start}-${firstToday.end} ${firstToday.title}` : '无'
);

const nightRun = run('now.js', [
  '--output-dir',
  OUT,
  '--now',
  '2026-11-04T20:30:00',
  '--timetable',
  path.join(OUT, 'jw-timetable.json'),
  '--tasks',
  emptyTasks,
  '--rain',
  emptyRain,
  '--prefs',
  path.join(FIXTURES, 'preferences.json'),
  '--week-start',
  '2026-11-02',
  '--week-number',
  '10',
]);
const nightDoc = readJson(path.join(OUT, 'now.json')) || {};
const nightRows = (nightDoc.sequence || []).filter((row) => row.date === '2026-11-04');
const nightTask = nightRows.find((row) => row.kind === 'task');
const nightRest = nightRows.find((row) => row.kind === 'rest');
check(
  '45 分钟任务先连续完成，不被偏好休息时间切开',
  nightRun.status === 0 &&
    /20:30-21:15/.test(nightDoc.first_action?.headline || '') &&
    nightTask?.start === '20:30' &&
    nightTask?.end === '21:15' &&
    nightTask?.minutes === 45,
  nightTask ? `${nightTask.start}-${nightTask.end} ${nightTask.title}` : '无任务段'
);
check(
  '休息移到任务完成之后',
  nightRest && nightRest.start >= '21:15',
  nightRest ? `${nightRest.start}-${nightRest.end}` : '无休息段'
);

const failed = results.filter((item) => !item.ok);
console.log(`\n========================================================`);
console.log(`V081:${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
console.log(`产物目录：${WORK}`);
if (!failed.length) fs.rmSync(WORK, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
