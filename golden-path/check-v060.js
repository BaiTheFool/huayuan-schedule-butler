'use strict';

/**
 * 0.6.0 行为回归：不许替用户做决定、不许过早排程、默认回答要短。
 *
 * 三组问题对应三组断言：
 *   A 偏好来源    —— 默认偏好不凭空造固定事项、来源不明按 legacy_unknown 只问一次、
 *                    只有"用户明确 + 已确认"才是不可移动约束
 *   B 过早排程    —— 标题只有"6"、没截止的任务不进计划只问一次；
 *                    周次未确认 + eCourse READ_PARTIAL 时只给估算与一个下一步
 *   C 新鲜度/简洁 —— 分析超过 5 分钟自动重算；默认简报不超过 300 字；时间轴 ≤8 行
 *
 * 用法：
 *   node golden-path/check-v060.js                # 临时目录在系统 temp 下
 *   node golden-path/check-v060.js --work ./tmp   # 指定工作目录
 *   node golden-path/check-v060.js --keep         # 结束后保留产物
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(PKG_ROOT, 'skills', 'huayuan-browser-session', 'scripts');
const TIMELINE = path.join(PKG_ROOT, 'skills', 'timeline-brief', 'scripts', 'timeline-brief.js');
const FIXTURES = path.join(__dirname, 'fixtures');

const argv = process.argv;
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const next = argv[index + 1];
  return next && !next.startsWith('--') ? next : fallback;
};
const KEEP = argv.includes('--keep');
const WORK = path.resolve(argOf('--work', path.join(os.tmpdir(), `huayuan-v060-${Date.now()}`)));
const HOME = path.join(WORK, 'home');
const OUT = path.join(WORK, 'out');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function group(title) {
  console.log(`\n[A/B/C] ${title}`);
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function run(script, args, { home = HOME, cwd = WORK, scriptPath = SCRIPTS } = {}) {
  const res = spawnSync(process.execPath, [path.join(scriptPath, script), ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HUAYUAN_HOME: home, HUAYUAN_OUTPUT_DIR: OUT },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', all: `${res.stdout || ''}${res.stderr || ''}` };
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
for (const name of fs.readdirSync(FIXTURES)) {
  if (name.endsWith('.json')) fs.copyFileSync(path.join(FIXTURES, name), path.join(OUT, name));
}

const prefLib = require(path.join(SCRIPTS, 'preferences.js'));
const nowLib = require(path.join(SCRIPTS, 'now.js'));

const TIMETABLE = path.join(OUT, 'jw-timetable.json');
const RAIN = path.join(OUT, 'rain-fast.json');
const PREFS = path.join(OUT, 'preferences.json');

// 教学周无法确认的课表：拿掉校历的"第一周起始日"，且不给 --week-number
const timetableNoWeek = readJson(TIMETABLE);
timetableNoWeek.semester = { ...(timetableNoWeek.semester || {}), first_week_start: null, raw: null };
const TIMETABLE_NOWEEK = path.join(OUT, 'jw-timetable-noweek.json');
fs.writeFileSync(TIMETABLE_NOWEEK, JSON.stringify(timetableNoWeek, null, 2));

const BASE_ARGS = ['--timetable', TIMETABLE_NOWEEK, '--rain', RAIN, '--prefs', PREFS];
const NOW_ISO = '2026-11-04T14:20:00';

console.log(`0.6.0 行为回归（离线、虚构样例）\n工作目录：${WORK}`);

// ── A 偏好来源与确认 ────────────────────────────────────────────────
group('A 偏好：不许凭空生成，不许把系统默认当成用户说过');

const emptyPrefs = prefLib.normalizePreferences({}).preferences;
check(
  '默认偏好不自动造固定事项（没有班会 / 社团 / 固定运动）',
  Array.isArray(emptyPrefs.fixed_events) && emptyPrefs.fixed_events.length === 0,
  `fixed_events=${(emptyPrefs.fixed_events || []).length}`
);
check(
  '默认偏好的出处标成系统默认且未确认',
  (emptyPrefs.provenance || {}).source === 'default' && (emptyPrefs.provenance || {}).confirmation_state === 'unconfirmed',
  JSON.stringify(emptyPrefs.provenance || {})
);
check(
  '系统默认不是可信偏好（不能说"你告诉过我"）',
  prefLib.trustworthyPreferences(emptyPrefs) === false && prefLib.defaultUnconfirmed(emptyPrefs) === true
);
check(
  '来源标签：系统默认=[系统默认]、来源不明=[待确认]',
  prefLib.SOURCE_LABEL.default === '[系统默认]' && prefLib.SOURCE_LABEL.legacy_unknown === '[待确认]',
  `default=${prefLib.SOURCE_LABEL.default} legacy=${prefLib.SOURCE_LABEL.legacy_unknown}`
);

const legacyPrefs = prefLib.normalizePreferences({
  fixed_events: [{ title: '班会', day: 3, start: '19:00', end: '19:40', movable: 'fixed' }],
}).preferences;
const legacyEvent = (legacyPrefs.fixed_events || [])[0] || {};
check(
  '来源不明的历史「班会」被标成 legacy_unknown，不是用户偏好',
  legacyEvent.source === 'legacy_unknown',
  `source=${legacyEvent.source} state=${legacyEvent.confirmation_state}`
);
check(
  '来源不明的事项在确认前不是不可移动约束',
  prefLib.isHardFixedEvent(legacyEvent) === false,
  `movable=${legacyEvent.movable}`
);
const legacyAsk = prefLib.legacyFixedEventQuestion(legacyPrefs);
check(
  '只问一次：保留 / 修改 / 删除',
  legacyAsk && legacyAsk.count === 1 && /班会/.test(legacyAsk.question) && /保留、修改还是删除/.test(legacyAsk.question),
  legacyAsk ? legacyAsk.question : '没有生成问题'
);
check(
  '问过之后不再重复问',
  prefLib.legacyFixedEventQuestion(prefLib.markLegacyAsked(legacyPrefs, [(legacyAsk.events || [])[0].key])) === null
);
const userFixed = { title: '羽毛球', day: 6, start: '14:00', end: '16:00', movable: 'fixed', source: 'user_explicit', confirmation_state: 'confirmed' };
check('用户明确且已确认才不可移动', prefLib.isHardFixedEvent(userFixed) === true);
check(
  '用户明确但未确认时不算不可移动',
  prefLib.isHardFixedEvent({ ...userFixed, confirmation_state: 'unconfirmed' }) === false
);

// ── B 数据不全时不排程 ──────────────────────────────────────────────
group('B 排程：信息不足的任务不猜、数据不全不下正式计划');

// 标题只有"6"、没有截止时间的任务：不能猜标题、不能猜时间、不能进计划
const unknownTaskDoc = readJson(path.join(OUT, 'ecourse-tasks.json'));
unknownTaskDoc.tasks = [...(unknownTaskDoc.tasks || []), { title: '6', course: '生产运作管理（样例）', task_type: '作业', source: 'eCourse' }];
const UNKNOWN_TASKS = path.join(OUT, 'ecourse-tasks-unknown.json');
fs.writeFileSync(UNKNOWN_TASKS, JSON.stringify(unknownTaskDoc, null, 2));

// 关键：不带 --week-number（教学周未确认），且 eCourse fixture 本身 unparsed=2（READ_PARTIAL）
const analyze = run('schedule-analyze.js', [...BASE_ARGS, '--tasks', UNKNOWN_TASKS, '--now', NOW_ISO, '--output-dir', OUT, '--no-validate']);
const analysis = readJson(path.join(OUT, 'schedule-analysis.json')) || {};
const unconfirmed = analysis.unconfirmed_tasks || [];
const blockers = (analysis.readiness && analysis.readiness.blockers) || [];
const codes = blockers.map((item) => item.code);

check('分析脚本离线可跑', analyze.status === 0 && Boolean(analysis.readiness), `exit=${analyze.status}`);
check(
  '标题只有「6」、无截止的任务被标待确认而不是被猜成正式任务',
  unconfirmed.some((item) => String(item.title).trim() === '6'),
  unconfirmed.map((item) => item.title).join(' / ') || '无'
);
check(
  '待确认任务不进排程（recommended_study 里没有它）',
  !(analysis.recommended_study || []).some((day) =>
    (day.slots || []).some((slot) => slot.task && String(slot.task.title).trim() === '6')
  )
);
check(
  '信息完整的任务没有被误伤（仍留在任务池、未被标待确认）',
  ((analysis.task_pool || {}).items || []).some((item) => /第 6 章作业/.test(item.title || '') && !item.needs_confirmation) &&
    !unconfirmed.some((item) => /第 6 章作业/.test(item.title || '')),
  '第 6 章作业（样例）未进待确认清单'
);
check(
  '教学周未确认 + eCourse READ_PARTIAL → 不是可执行的正式计划',
  analysis.readiness.ready === false && analysis.readiness.estimate_only === true,
  `ready=${analysis.readiness.ready} estimate_only=${analysis.readiness.estimate_only}`
);
check(
  '三个阻塞项都在（week_unconfirmed / ecourse_partial / task_unconfirmed）',
  codes.includes('week_unconfirmed') && codes.includes('ecourse_partial') && codes.includes('task_unconfirmed'),
  codes.join(',')
);
check(
  '冲突只给建议、不自称"已自动调整"',
  !/已自动调整/.test(JSON.stringify(analysis)) && typeof analysis.readiness.conflict_suggestions === 'number',
  `conflict_suggestions=${analysis.readiness.conflict_suggestions}`
);
check(
  '只给一个下一步、最多一个问题',
  Boolean(analysis.readiness.next_action) && (analysis.readiness.question === null || typeof analysis.readiness.question === 'string'),
  `下一步：${analysis.readiness.next_action}${analysis.readiness.question ? `｜问题：${analysis.readiness.question}` : ''}`
);
check(
  '待确认任务的问题只指向信息不足的那一条',
  !analysis.readiness.question || /6/.test(analysis.readiness.question),
  analysis.readiness.question || '无'
);

// ── C 新鲜度与简洁 ──────────────────────────────────────────────────
group('C 回答：时间相关必须现算，默认回答要短');

check('分析结果超过 5 分钟即视为过期', nowLib.STALE_ANALYSIS_MS === 5 * 60 * 1000, `${nowLib.STALE_ANALYSIS_MS} ms`);

const wizard = run('first-run.js', [
  '--wizard', '--yes',
  '--prefs', path.join(FIXTURES, 'preferences.json'),
  '--skip-check', '--skip-read',
  '--output-dir', OUT,
  '--week-number', '10',
  '--profile-id', 'v060',
]);
check('初始化向导离线完成（now.js 的前置条件）', wizard.status === 0, `exit=${wizard.status}`);

// now.js 要求 setup_state=completed：离线场景用产品自己的状态写入接口置位（与黄金路径第 5 步一致）
process.env.HUAYUAN_HOME = HOME;
const paths = require(path.join(SCRIPTS, 'huayuan-paths.js'));
paths.writeSetupState({
  state: 'completed',
  detail: {
    status: 'completed',
    missing: [],
    partial: [],
    timetable_known: true,
    check_plan: 'PASS',
    profile_id: 'v060',
    simulated: '0.6.0 行为回归：三源读取由 fixtures 代替',
  },
});

const freshRun = run('now.js', ['--output-dir', OUT, '--now', NOW_ISO, '--timetable', TIMETABLE, '--rain', RAIN, '--prefs', PREFS, '--week-start', '2026-11-02', '--week-number', '10', '--tasks', UNKNOWN_TASKS]);
const nowDoc = readJson(path.join(OUT, 'now.json')) || {};
check('now.json 正常产出', freshRun.status === 0 && Boolean(nowDoc.first_action), `exit=${freshRun.status}`);
check(
  '新鲜度写进结果（analysis_at / age_seconds / stale）',
  Boolean(nowDoc.freshness) && typeof nowDoc.freshness.age_seconds === 'number',
  JSON.stringify(nowDoc.freshness || {})
);

// 把分析产物改成 10 分钟前，再跑一次：必须自己重算，不能拿旧结论当"现在"
const stalePath = path.join(OUT, 'schedule-analysis.json');
const staleDoc = readJson(stalePath) || {};
staleDoc.generated_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
fs.writeFileSync(stalePath, JSON.stringify(staleDoc, null, 2));
const staleRun = run('now.js', ['--output-dir', OUT, '--now', NOW_ISO, '--no-analyze', '--timetable', TIMETABLE, '--rain', RAIN, '--prefs', PREFS, '--week-start', '2026-11-02', '--week-number', '10', '--tasks', UNKNOWN_TASKS]);
check(
  '上一次分析超过 5 分钟 → 打印 ANALYSIS_STALE 并自动重算',
  /ANALYSIS_STALE/.test(staleRun.all) && staleRun.status === 0,
  (staleRun.all.match(/ANALYSIS_STALE:[^\n]*/) || ['无'])[0]
);

const finalAnalysis = readJson(path.join(OUT, 'schedule-analysis.json')) || {};
check(
  '补上周次后，信息完整的任务照常排入时段（不是一律不排）',
  (finalAnalysis.recommended_study || []).some((day) =>
    (day.slots || []).some((slot) => slot.task && /第 6 章作业/.test(slot.task.title))
  ),
  '第 6 章作业（样例）已排入'
);

const brief = nowDoc.brief || (nowDoc.first_action ? nowLib.buildBrief(nowDoc) : '');
check(
  '默认简报不超过 300 字（结论 + 依据 + 一个下一步）',
  Boolean(brief) && brief.length <= 300,
  `${brief.length} 字`
);
check('简报以结论开头、只给一个下一步', (brief.match(/下一步/g) || []).length === 1, brief.slice(0, 60));

const t0 = Date.now();
const timeline = spawnSync(process.execPath, [TIMELINE, '--now', path.join(OUT, 'now.json'), '--hours', '6'], { encoding: 'utf8' });
const timelineMs = Date.now() - t0;
const timelineText = timeline.stdout || '';
const timelineRows = timelineText.split('\n').filter((line) => /\d{2}:\d{2}/.test(line) && /\[/.test(line));
check('时间轴脚本 <1 秒出结果', timeline.status === 0 && timelineMs < 1000, `${timelineMs} ms`);
check('时间轴最多 8 行', timelineRows.length <= 8, `${timelineRows.length} 行`);
check(
  '每行都带来源标签，只用规定的六种',
  timelineRows.every((line) => /\[(课程|任务|偏好|临时|待确认)\]/.test(line)),
  timelineRows[0] || '无'
);
check('时间轴是纯文本（不画图、不输出 HTML）', !/<svg|<div|<img/i.test(timelineText), timeline.status === 0 ? '纯文本' : `exit=${timeline.status}`);
check(
  '估算口径会先声明（数据未确认）',
  nowDoc.data_status && nowDoc.data_status.estimate_only ? /数据未确认/.test(timelineText) : true,
  nowDoc.data_status && nowDoc.data_status.estimate_only ? '已声明' : '本次为完整数据（无需声明）'
);

// ── 汇总 ────────────────────────────────────────────────────────────
const failed = results.filter((item) => !item.ok);
console.log(`\n========================================================`);
console.log(`V060:${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
console.log(`产物目录：${WORK}`);
if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
