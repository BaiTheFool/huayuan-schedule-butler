'use strict';

/**
 * 黄金路径回归（七步，离线、可重复、不用登录）。
 *
 * 黄金路径本身写在 ../GOLDEN-PATH.md，这里把它变成可执行的检查：
 * 每次改文案、改排程规则、改入口，跑一遍就知道"评委看到的那条路"还在不在。
 *
 * 七步与断言：
 *   1/7 首次召唤先介绍   —— intro.js 在全新 Home 上给出开场白，且不含技术细节
 *   2/7 一次集中初始化   —— 向导用 --skip-check --skip-read 离线写入授权与偏好（不再逐个平台问）
 *   3/7 只在需要时弹窗   —— 规则级：无头检查、只开一次、默认 --no-visible-login、平台串行
 *   4/7 串行读取给结果   —— 结果页：课程/待办/待确认/教学周/check_plan，没读到不显示为 0
 *   5/7 我现在该干什么   —— 周三 14:20 → 先去上课 14:30-16:10，课后先缓冲再排 P0
 *   6/7 临时新增并重排   —— 周四 18:30-20:00 实验课：只进本地覆盖层，原安排→新安排，不侵占羽毛球/休息
 *   7/7 日常闭环         —— 结尾只给"完成 / 延后或限时 / 继续问"，不再解释技术架构
 *
 * 用法：
 *   node golden-path/check.js                 # 跑一遍，临时目录在系统 temp 下
 *   node golden-path/check.js --work ./tmp    # 指定工作目录（便于看产物）
 *   node golden-path/check.js --keep          # 结束后不删临时目录
 *
 * 说明：固定样例全部是虚构数据（课程名、教室、"小林"），见 fixtures/ 里的 _note。
 * 本脚本不登录任何平台、不访问网络，第 3 步为规则级校验（真实登录必须由用户本人完成）。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(PKG_ROOT, 'skills', 'huayuan-browser-session', 'scripts');
const FIXTURES = path.join(__dirname, 'fixtures');
const AGENT_MD = path.join(PKG_ROOT, 'agents', 'huayuan-schedule-butler.md');
const SKILL_MD = path.join(PKG_ROOT, 'skills', 'huayuan-browser-session', 'SKILL.md');

const argv = process.argv;
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const next = argv[index + 1];
  return next && !next.startsWith('--') ? next : fallback;
};
const KEEP = argv.includes('--keep');
const WORK = path.resolve(argOf('--work', path.join(os.tmpdir(), `huayuan-golden-${Date.now()}`)));
const HOME = path.join(WORK, 'home');
const HOME_BEFORE = path.join(WORK, 'home-before');
const OUT = path.join(WORK, 'out');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function step(no, title) {
  console.log(`\n[${no}/7] ${title}`);
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}
function run(script, args, { home = HOME, cwd = WORK } = {}) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HUAYUAN_HOME: home },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', all: `${res.stdout || ''}${res.stderr || ''}` };
}
const toMin = (clock) => {
  const [h, m] = String(clock).split(':').map(Number);
  return h * 60 + m;
};
const overlaps = (aStart, aEnd, bStart, bEnd) => toMin(aStart) < toMin(bEnd) && toMin(bStart) < toMin(aEnd);
function planBlocks(planDoc, date, kinds = null) {
  const day = (planDoc.days || []).find((item) => item.date === date);
  if (!day) return [];
  return (day.blocks || []).filter((block) => (kinds ? kinds.includes(block.kind) : true));
}

// ── 准备 ───────────────────────────────────────────────────────────
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
for (const name of fs.readdirSync(FIXTURES)) {
  if (name.endsWith('.json')) fs.copyFileSync(path.join(FIXTURES, name), path.join(OUT, name));
}
const TIMETABLE = path.join(OUT, 'jw-timetable.json');
const TASKS = path.join(OUT, 'ecourse-tasks.json');
const RAIN = path.join(OUT, 'rain-fast.json');
const PREFS = path.join(OUT, 'preferences.json');
const SCHOOL_TIMETABLE_SHA = sha(TIMETABLE);
const COMMON = [
  '--timetable', TIMETABLE,
  '--tasks', TASKS,
  '--rain', RAIN,
  '--prefs', PREFS,
  '--week-start', '2026-11-02',
  '--week-number', '10',
];
console.log(`黄金路径回归（离线、虚构样例）\n工作目录：${WORK}`);

// ── 1/7 首次召唤，先介绍 ───────────────────────────────────────────
step(1, '首次召唤，先介绍（全新 Home，未初始化）');
const intro = run('intro.js', []);
const introText = (intro.stdout.split('INTRO_TEXT:')[1] || '').trim();
check('全新 Home 判定为 uninitialized', /INTRO_STATE:uninitialized/.test(intro.stdout), intro.stdout.split('\n')[0]);
check('开场先讲能做什么（课表、作业与通知 → 计划）', /课表、作业与通知/.test(introText) && /计划/.test(introText), introText.slice(0, 28));
check('明确告知第一次使用需要初始化', /第一次使用时，我会先带你完成/.test(introText));
check('只给一个下一步，不罗列命令', /现在开始初始化吗？$/.test(introText) && !/\d\)\s/.test(introText));
check(
  '开场不含文件路径 / 脚本名 / 命令行',
  !/node |\.js\b|\.json\b|[\\/]|\$|%USERPROFILE%/.test(introText),
  introText.match(/node |\.js\b|\.json\b/)?.[0] || '无'
);
check('同时标注"初始化前不要算现在该干什么"', /INTRO_BLOCK_NOW:1/.test(intro.stdout));
// 未初始化时「现在该干什么」必须被拦住：不猜课表、不写产物、直接退回开场白
const blocked = run('now.js', ['--output-dir', OUT, '--now', '2026-11-04T14:20:00', ...COMMON]);
check(
  '未初始化时 now 拒绝运行（SETUP_REQUIRED，退出码 3）',
  blocked.status === 3 && /SETUP_REQUIRED/.test(blocked.all),
  `exit=${blocked.status} ${(blocked.all.match(/SETUP_REQUIRED[^\n]*/) || ['无'])[0]}`
);
check(
  '被拦住时不产出任何估算文件（不写 now.json）',
  !fs.existsSync(path.join(OUT, 'now.json')),
  fs.existsSync(path.join(OUT, 'now.json')) ? '产出了 now.json' : '未产出'
);

// ── 2/7 一次集中初始化 ─────────────────────────────────────────────
step(2, '一次集中初始化（授权 + 偏好，一条命令问完）');
const wizard = run('first-run.js', [
  '--wizard', '--yes',
  '--prefs', path.join(FIXTURES, 'preferences.json'),
  '--skip-check', '--skip-read',
  '--output-dir', OUT,
  '--week-number', '10',
  '--profile-id', 'golden',
]);
check('向导离线可完成（不发登录、不访问网络）', wizard.status === 0, `exit=${wizard.status}`);
const config = readJson(path.join(HOME, 'config.json')) || {};
const prefsDoc = readJson(path.join(HOME, 'preferences.json')) || {};
const prefsStudy = prefsDoc.study || {};
check(
  '一次授权四平台（不逐个平台重复确认）',
  Array.isArray(config.authorized_platforms) && config.authorized_platforms.length === 4,
  (config.authorized_platforms || []).join(',')
);
check(
  '偏好落盘：上限 180 / 单块 90 / 休息 60',
  Number(prefsStudy.daily_limit_min || prefsStudy.weekday_daily_limit_min) === 180 &&
    Number(prefsStudy.max_continuous_minutes) === 90 &&
    Number((prefsDoc.rest || {}).daily_minutes) === 60,
  JSON.stringify({ limit: prefsStudy.daily_limit_min || prefsStudy.weekday_daily_limit_min, block: prefsStudy.max_continuous_minutes, rest: (prefsDoc.rest || {}).daily_minutes })
);
check(
  '固定事项（周六 14:00-16:00 羽毛球）已记录且不可移动',
  (prefsDoc.fixed_events || []).some(
    (item) =>
      /羽毛球/.test(item.title || '') &&
      (item.movable === false || item.movable === 'fixed') &&
      item.start === '14:00' &&
      item.end === '16:00'
  )
);
check('全程只问一次是否登录（没有逐平台追问）', (wizard.all.match(/（y\/N）/g) || []).length <= 1, String((wizard.all.match(/（y\/N）/g) || []).length));

// ── 3/7 仅在需要时弹出登录（规则级） ───────────────────────────────
step(3, '仅在需要时弹出登录（规则级校验，真实登录需本人操作）');
const agentText = fs.readFileSync(AGENT_MD, 'utf8');
const skillText = fs.readFileSync(SKILL_MD, 'utf8');
const onboardingSrc = fs.readFileSync(path.join(SCRIPTS, 'onboarding.js'), 'utf8');
check('先无头检查，失效才可见登录', /无头/.test(agentText) && /无头/.test(skillText));
check('只打开一次窗口、不反复重试', /打开一次|只开一次/.test(agentText) && /不要循环重试/.test(agentText));
check('四平台串行、同一时刻只有一个 Chrome', /串行/.test(agentText) && /同一时刻/.test(agentText));
check('非交互默认不弹窗（--no-visible-login）', /--no-visible-login/.test(onboardingSrc));
check('登录由本人完成（AUTH_REQUIRED 交给用户扫码/认证）', /AUTH_REQUIRED/.test(agentText) && /本人/.test(agentText));

// ── 4/7 串行读取并给出初始化结果 ───────────────────────────────────
step(4, '给出初始化结果（课程 / 待办 / 待确认 / 教学周 / 校验）');
const report = readJson(path.join(OUT, 'onboarding-report.json')) || {};
const reportMd = fs.existsSync(path.join(OUT, 'onboarding-summary.md'))
  ? fs.readFileSync(path.join(OUT, 'onboarding-summary.md'), 'utf8')
  : '';
const analysis = readJson(path.join(OUT, 'schedule-analysis.json')) || {};
const pendingText = (analysis.pending || []).join('；');
const stepNumbers = [...new Set((report.steps || []).map((item) => item.step))].sort((a, b) => a - b);
check('结果页按七步汇报（1-7 齐全）', stepNumbers.length === 7 && stepNumbers[0] === 1 && stepNumbers[6] === 7, stepNumbers.join(','));
check('当前教学周确认为第 10 周并已保存', report.current_week && report.current_week.week === 10 && report.current_week.saved === true, JSON.stringify(report.current_week && { week: report.current_week.week, source: report.current_week.source, saved: report.current_week.saved }));
check('课程 3 段（按第 10 周过滤）', analysis.inputs && analysis.inputs.timetable_classes === 3, `classes=${analysis.inputs && analysis.inputs.timetable_classes}`);
check('任务 2 条（eCourse 1 / 雨课堂 1）', analysis.task_pool && analysis.task_pool.total === 2, JSON.stringify(analysis.task_pool && analysis.task_pool.by_source));
check(
  '没读到的来源不显示为 0，而是"未读到，可能更多"',
  /真实待办可能更多/.test(wizard.all) || /未读到/.test(reportMd)
);
check(
  'READ_PARTIAL 保持"待确认"：不据此判定没有作业',
  /读取不完整/.test(pendingText) && /不能据此判定/.test(pendingText) && /人工核对/.test(pendingText),
  (analysis.pending || [])[0] ? String(analysis.pending[0]).slice(0, 40) : ''
);
check('硬约束校验通过（check_plan）', report.analysis && report.analysis.check_plan === 'PASS', report.analysis && report.analysis.check_plan);

// ── 5/7 我现在该干什么（周三 14:20） ──────────────────────────────
step(5, '「我现在该干什么」（固定样例：周三 14:20）');
// 三源都读到的 completed 由向导写入；这里为了离线复现，用产品自己的状态写入接口置为 completed
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
    profile_id: 'golden',
    simulated: 'golden-path 固定样例：三源读取由 fixtures 代替',
  },
});
const nowRun = run('now.js', ['--output-dir', OUT, '--now', '2026-11-04T14:20:00', ...COMMON]);
const nowDoc = readJson(path.join(OUT, 'now.json')) || {};
const nowMd = fs.readFileSync(path.join(OUT, 'now.md'), 'utf8');
const first = nowDoc.first_action || {};
const seq = nowDoc.sequence || [];
check('初始化完成后 now 正常输出', nowRun.status === 0 && Boolean(nowDoc.now), `exit=${nowRun.status}`);
check(
  '第一动作：14:30-16:10 先去上课（唯一一条）',
  first.type === 'go_to_class' && /先去上课/.test(first.headline || '') && /14:30-16:10/.test(first.headline || '') && /生产运作管理/.test(first.headline || ''),
  first.headline
);
check('距离上课 10 分钟，如实说"只剩 10 分钟"而非开任务', nowDoc.window && nowDoc.window.minutes === 10 && /只剩 10 分钟/.test(nowDoc.window.note || ''), nowDoc.window && nowDoc.window.note.slice(0, 24));
check('后续安排：下课后先做 P0 作业', /下课.{0,4}后做「第 6 章作业/.test(first.next_hint || ''), first.next_hint);
const todaySeq = seq.filter((row) => row.date === '2026-11-04');
const tasksToday = todaySeq.filter((row) => row.kind === 'task');
const restToday = todaySeq.filter((row) => row.kind === 'rest');
check(
  '学习块不超过单块上限 90 分钟',
  tasksToday.length > 0 && tasksToday.every((row) => row.minutes <= 90),
  tasksToday.map((row) => `${row.start}-${row.end}(${row.minutes})`).join(' ')
);
check('今天排了休息块（保护 60 分钟）', restToday.length > 0, restToday.map((row) => `${row.start}-${row.end}`).join(' '));
check(
  '待办分档：P0 一条（明天截止的作业）、P1 一条（雨课堂）',
  nowDoc.tasks && nowDoc.tasks.p0.length === 1 && nowDoc.tasks.p1.length === 1,
  JSON.stringify(nowDoc.tasks && { p0: nowDoc.tasks.p0.length, p1: nowDoc.tasks.p1.length })
);
check(
  '数据提醒：eCourse 2 条未解析仍标待确认',
  (nowDoc.data_status.pending || []).some((line) => /读取不完整/.test(line)) && nowDoc.data_status.estimate_only === true,
  (nowDoc.data_status.pending || [])[0] ? String(nowDoc.data_status.pending[0]).slice(0, 32) : ''
);
check('教学周与过滤写进结果（第 10 周）', nowDoc.week && nowDoc.week.number === 10 && nowDoc.week.filter.applied === true);
check('结尾固定引导语', /完成X/.test(nowDoc.footer || '') && nowMd.trim().endsWith(nowDoc.footer || 'x'));

// ── 6/7 临时新增安排并重排 ────────────────────────────────────────
step(6, '临时新增实验课并重排（只进本地覆盖层）');
fs.mkdirSync(HOME_BEFORE, { recursive: true });
for (const name of ['config.json', 'preferences.json', 'user-state.json']) {
  const file = path.join(HOME, name);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(HOME_BEFORE, name));
}
const beforeRun = run('now.js', ['--output-dir', path.join(WORK, 'out-before'), '--now', '2026-11-05T18:20:00', ...COMMON], { home: HOME_BEFORE });
const beforeDoc = readJson(path.join(WORK, 'out-before', 'now.json')) || {};
const add = run('manage-items.js', ['add-course', '--title', '实验课（样例临时）', '--date', '2026-11-05', '--start', '18:30', '--end', '20:00']);
const overrides = readJson(path.join(HOME, 'user-overrides.json')) || {};
check('实验课写入本地覆盖层', /ADDED_COURSE:uc-001/.test(add.stdout) && (overrides.courses || []).length === 1, add.stdout.split('\n').find((line) => line.startsWith('ADDED_COURSE')) || '');
check(
  '标明"仅这一天"、不改学校课表',
  /仅 2026-11-05 18:30-20:00/.test(add.stdout) && /不修改学校原始课表/.test(JSON.stringify(overrides)),
  (overrides.courses || [])[0] && (overrides.courses[0].date || '')
);
const afterRun = run('now.js', ['--output-dir', OUT, '--now', '2026-11-05T18:20:00', ...COMMON]);
const afterDoc = readJson(path.join(OUT, 'now.json')) || {};
check(
  '原安排 → 新安排：18:20 从"开始作业"变成"先去上课"',
  beforeDoc.first_action && beforeDoc.first_action.type === 'start_task' && /第 6 章作业/.test(beforeDoc.first_action.headline || '') &&
    afterDoc.first_action && afterDoc.first_action.type === 'go_to_class' && /实验课（样例临时）/.test(afterDoc.first_action.headline || ''),
  `${beforeDoc.first_action && beforeDoc.first_action.headline} → ${afterDoc.first_action && afterDoc.first_action.headline}`
);
const planDoc = readJson(path.join(OUT, 'plan.json')) || {};
const thuTask = planBlocks(planDoc, '2026-11-05', ['task']);
check(
  '18:30-20:00 不再排作业（被实验课占用）',
  !thuTask.some((block) => overlaps(block.start, block.end, '18:30', '20:00')),
  thuTask.map((block) => `${block.start}-${block.end}`).join(' ')
);
check(
  '被挤掉的作业仍在别处排上（没有静默消失）',
  (planDoc.days || []).some((day) => (day.blocks || []).some((block) => block.kind === 'task' && /第 6 章作业/.test(block.title || ''))),
);
const sat = planBlocks(planDoc, '2026-11-07', ['task', 'study']);
check(
  '不侵占周六 14:00-16:00 羽毛球',
  !sat.some((block) => overlaps(block.start, block.end, '14:00', '16:00')),
  sat.map((block) => `${block.start}-${block.end}`).join(' ')
);
const overLimit = (planDoc.days || []).filter((day) => day.blocks.filter((block) => block.kind === 'task').reduce((sum, block) => sum + (toMin(block.end) - toMin(block.start)), 0) > 180);
check('每天学习不超过 180 分钟上限', overLimit.length === 0, overLimit.map((day) => day.date).join(',') || '全部合规');
const lateBlocks = (planDoc.days || []).flatMap((day) => day.blocks.filter((block) => toMin(block.end) > toMin('23:30')));
check('不越过 23:30 睡觉', lateBlocks.length === 0, lateBlocks.map((block) => `${block.start}-${block.end}`).join(' ') || '无');
const restPerDay = (planDoc.days || []).map((day) => ({
  date: day.date,
  minutes: day.blocks.filter((block) => block.kind === 'rest' || block.kind === 'break').reduce((sum, block) => sum + (toMin(block.end) - toMin(block.start)), 0),
}));
check('每天都保留休息（≥30 分钟为底线）', restPerDay.length > 0 && restPerDay.every((day) => day.minutes >= 30), restPerDay.map((day) => `${day.date}:${day.minutes}`).join(' '));
check('学校原始课表一个字节没动', sha(TIMETABLE) === SCHOOL_TIMETABLE_SHA, sha(TIMETABLE));
const remove = run('manage-items.js', ['remove', '--id', 'uc-001']);
check('可撤销：删掉后覆盖层为空', /REMOVED:uc-001/.test(remove.stdout) && (readJson(path.join(HOME, 'user-overrides.json')) || {}).courses.length === 0, remove.stdout.split('\n')[0]);

// ── 7/7 日常闭环 ─────────────────────────────────────────────────
step(7, '形成日常使用闭环（只给三个可继续动作）');
check(
  '结尾给出「完成 / 延后或限时 / 继续问」三种动作',
  /完成X/.test(nowDoc.footer || '') && /延后到/.test(nowDoc.footer || '') && /临时新增/.test(nowDoc.footer || ''),
  nowDoc.footer
);
check('专家说明里固化了这三个动作', /完成某任务/.test(agentText) && /延后|限时/.test(agentText) && /继续问/.test(agentText));
check('结尾不再解释技术架构（now.md 无脚本/架构章节）', !/(##\s*脚本|技术架构|Architecture)/.test(nowMd));

// ── 汇总 ─────────────────────────────────────────────────────────
const failed = results.filter((item) => !item.ok);
console.log(`\n${'='.repeat(56)}`);
console.log(`GOLDEN_PATH:${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const item of failed) console.log(` - ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
}
console.log(`产物目录：${OUT}`);
if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
