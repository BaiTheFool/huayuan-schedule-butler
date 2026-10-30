'use strict';

/**
 * 日程驾驶舱 Widget 回归（离线、确定性、不启动服务器）。
 *
 * 覆盖三种输入状态：
 *   1 完整       —— now.json 无 estimate_only、无 pending → 紧凑卡片，标"数据已整理"
 *   2 PARTIAL    —— 真实 now.json（eCourse 有未解析记录）→ 标"部分数据""N 条待确认"
 *   3 未初始化   —— now.json 缺失 / 不完整 → 降级卡片，不伪造任何安排
 *
 * 同时校验红线：不落地 HTML 文件、不引入外部脚本、不含 Cookie/Token/学号、生成确定性。
 *
 * 用法：
 *   node golden-path/check-widget.js                # 临时目录在系统 temp 下
 *   node golden-path/check-widget.js --work ./tmp   # 指定工作目录
 *   node golden-path/check-widget.js --keep         # 结束后保留产物
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(PKG_ROOT, 'skills', 'huayuan-browser-session', 'scripts');
const WIDGET_DIR = path.join(PKG_ROOT, 'skills', 'huayuan-dashboard-widget');
const BUILD = path.join(WIDGET_DIR, 'scripts', 'build-widget.js');
const FIXTURES = path.join(__dirname, 'fixtures');

const argv = process.argv;
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const next = argv[index + 1];
  return next && !next.startsWith('--') ? next : fallback;
};
const KEEP = argv.includes('--keep');
const WORK = path.resolve(argOf('--work', path.join(os.tmpdir(), `huayuan-widget-${Date.now()}`)));
const HOME = path.join(WORK, 'home');
const OUT = path.join(WORK, 'out');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function group(title) {
  console.log(`\n${title}`);
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function run(script, args, { home = HOME, cwd = WORK } = {}) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HUAYUAN_HOME: home, HUAYUAN_OUTPUT_DIR: OUT },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', all: `${res.stdout || ''}${res.stderr || ''}` };
}
function build(args) {
  const res = spawnSync(process.execPath, [BUILD, ...args], { encoding: 'utf8', cwd: WORK });
  const text = res.stdout || '';
  if (args.includes('--text')) return { status: res.status, text, doc: null };
  return { status: res.status, text, doc: JSON.parse(text) };
}
function htmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /\.html?$/i.test(name));
}

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
const NOW_ISO = '2026-11-04T14:20:00';

console.log(`驾驶舱 Widget 回归（离线、虚构样例）\n工作目录：${WORK}`);

// ── 0 自检 ─────────────────────────────────────────────────────────
group('[0] build-widget.js --self-check');
const selfCheck = spawnSync(process.execPath, [BUILD, '--self-check'], { encoding: 'utf8', cwd: WORK });
const selfLines = (selfCheck.stdout || '').split('\n').filter(Boolean);
const selfPass = (selfCheck.stdout || '').match(/SELF_CHECK:PASS (\d+)\/(\d+)/);
check(
  '自检全部通过且不少于 6 项',
  selfCheck.status === 0 && selfPass && Number(selfPass[1]) >= 6 && Number(selfPass[1]) === Number(selfPass[2]),
  selfPass ? selfPass[0] : selfLines.slice(-1)[0] || '无输出'
);

// ── 准备真实 now.json ──────────────────────────────────────────────
const wizard = run('first-run.js', [
  '--wizard', '--yes',
  '--prefs', path.join(FIXTURES, 'preferences.json'),
  '--skip-check', '--skip-read',
  '--output-dir', OUT,
  '--week-number', '10',
  '--profile-id', 'widget',
]);
process.env.HUAYUAN_HOME = HOME;
const paths = require(path.join(SCRIPTS, 'huayuan-paths.js'));
paths.writeSetupState({ state: 'completed', detail: { status: 'completed', missing: [], partial: [], timetable_known: true, profile_id: 'widget', simulated: 'widget 回归：三源读取由 fixtures 代替' } });
const nowRun = run('now.js', ['--output-dir', OUT, '--now', NOW_ISO, '--timetable', TIMETABLE, '--tasks', TASKS, '--rain', RAIN, '--prefs', PREFS, '--week-start', '2026-11-02', '--week-number', '10']);
const NOW_JSON = path.join(OUT, 'now.json');
const nowDoc = readJson(NOW_JSON) || {};
check('真实 now.json 已生成（now.js 前置条件就绪）', wizard.status === 0 && nowRun.status === 0 && Boolean(nowDoc.first_action), `exit=${nowRun.status}`);

// 完整态：由真实 now.json 派生，清掉 estimate_only 与 pending
const COMPLETE = path.join(OUT, 'now-complete.json');
fs.writeFileSync(COMPLETE, JSON.stringify({ ...nowDoc, data_status: { ...(nowDoc.data_status || {}), estimate_only: false, pending: [] } }, null, 2));
// PARTIAL 态：真实 now.json 原样（eCourse 有未解析记录 → estimate_only / pending）
const PARTIAL = path.join(OUT, 'now-partial.json');
fs.writeFileSync(PARTIAL, JSON.stringify({ ...nowDoc, data_status: { ...(nowDoc.data_status || {}), estimate_only: true, pending: ['eCourse 有 2 条记录只出现在总数里', '教学周未确认'] } }, null, 2));
const MISSING = path.join(OUT, 'now-not-there.json');

// ── 1 完整 ─────────────────────────────────────────────────────────
group('[1] 完整数据：紧凑驾驶舱');
const t0 = Date.now();
const full = build(['--now', COMPLETE, '--plan', path.join(OUT, 'plan.json')]);
const fullMs = Date.now() - t0;
const fullCode = (full.doc && full.doc.widget_code) || '';
check('生成成功且 <1 秒', full.status === 0 && full.doc && full.doc.meta.ok === true && fullMs < 1000, `${fullMs} ms`);
check('标记数据已整理（不是估算）', full.doc.meta.partial === false, `partial=${full.doc.meta.partial}`);
check('只展示最多 3 段后续安排', full.doc.meta.sequence_rows <= 3, `${full.doc.meta.sequence_rows} 段`);
check('包含唯一第一动作', /唯一第一动作/.test(fullCode) && fullCode.includes(String((nowDoc.first_action || {}).headline || '').slice(0, 6)));
check('包含来源标签（eCourse / 课程 / 休息…）', /eCourse|固定|休息|任务|个人/.test(fullCode));
check('体积 <30KB', full.doc.meta.bytes < 30 * 1024, `${full.doc.meta.bytes} B`);
check('采用扁平样式，无渐变与阴影', !/(linear-gradient|radial-gradient|box-shadow)/i.test(fullCode));
check('Widget 最小字号不低于 11px', !/font-size\s*:\s*(?:[0-9]|10)px/i.test(fullCode));
check('支持 prefers-color-scheme 深色主题', /prefers-color-scheme\s*:\s*dark/i.test(fullCode));
check('外层容器透明，使用内层卡片', /\.hyw\{[^}]*background:transparent/i.test(fullCode) && /class="hyw-card"/.test(fullCode));

// ── 2 PARTIAL ──────────────────────────────────────────────────────
group('[2] PARTIAL：先行动，但声明不是最终排程');
const partial = build(['--now', PARTIAL]);
const partialCode = (partial.doc && partial.doc.widget_code) || '';
check('标记为部分数据', partial.doc.meta.partial === true, `partial=${partial.doc.meta.partial} pending=${partial.doc.meta.pending_count}`);
check('卡片里写明"部分数据"和待确认条数', /部分数据/.test(partialCode) && /条数据待确认/.test(partialCode));
check('说明当前结果不作最终精确排程', /不作最终精确排程/.test(partialCode));

// ── 3 未初始化 / 数据缺失 ───────────────────────────────────────────
group('[3] 未初始化：不伪造，只降级');
const missing = build(['--now', MISSING]);
check('now.json 缺失时不伪造数据', missing.doc.meta.ok === false && missing.doc.meta.reason === 'NOW_DATA_MISSING', `reason=${missing.doc.meta.reason}`);
check('降级卡片说明"暂时没有可展示的最新安排"', /暂时没有可展示的最新安排/.test(missing.doc.widget_code));
const brokenPath = path.join(OUT, 'now-broken.json');
fs.writeFileSync(brokenPath, '{ 不是合法 JSON');
const broken = build(['--now', brokenPath]);
check('now.json 损坏时同样降级（不猜内容）', broken.doc.meta.ok === false && /暂时没有可展示的最新安排/.test(broken.doc.widget_code));

// ── 4 文本降级 ─────────────────────────────────────────────────────
group('[4] show_widget 失败时的文字降级');
const textFull = build(['--now', COMPLETE, '--text']);
const textLine = (textFull.text || '').trim().split('\n')[0];
check('只有一行：第一动作 + 下一步', textFull.status === 0 && (textFull.text || '').trim().split('\n').length === 1, textLine);
check('包含"下一步"且不超过 120 字', /下一步/.test(textLine) && textLine.length <= 120, `${textLine.length} 字`);
const textMissing = build(['--now', MISSING, '--text']);
check('未初始化时文字版引导初始化，不编造安排', /初始化|重新生成/.test(textMissing.text || ''), (textMissing.text || '').trim());

// ── 5 红线 ─────────────────────────────────────────────────────────
group('[5] 红线：不外链、不落地 HTML、不放敏感信息');
check('没有 <script> / <form>', !/<script|<form/i.test(fullCode));
check('没有外链资源（http(s):// 的 src/href）', !/(src|href)\s*=\s*["']https?:/i.test(fullCode));
check('不含 Cookie / Token / 学号 / 姓名', !/cookie|token|学号|student_id|真实姓名/i.test(fullCode));
check('运行前后没有产生任何 HTML 文件', htmlFiles(OUT).length === 0 && htmlFiles(WORK).length === 0, `${htmlFiles(OUT).length + htmlFiles(WORK).length} 个`);
const source = fs.readFileSync(BUILD, 'utf8');
check('脚本本身不启动本地服务器、不写文件', !/createServer|\.listen\(|writeFileSync/.test(source));
check('不调用网络（没有 http/https 请求）', !/require\((['"])(https?|node:https)\1\)|fetch\(/.test(source));

// ── 6 确定性 ───────────────────────────────────────────────────────
group('[6] 确定性：同一输入两次结果一致');
const again = build(['--now', PARTIAL]);
check('两次生成的 widget_code 完全一致', again.doc.widget_code === partial.doc.widget_code, `${partial.doc.meta.bytes} B vs ${again.doc.meta.bytes} B`);

// ── 7 Widget 与网页驾驶舱路由 ──────────────────────────────────────
group('[7] 每轮外部驾驶舱优先，内嵌卡片只在明确要求时出现');
const agentText = fs.readFileSync(path.join(PKG_ROOT, 'agents', 'huayuan-schedule-butler.md'), 'utf8');
const widgetSkill = fs.readFileSync(path.join(WIDGET_DIR, 'SKILL.md'), 'utf8');
const liveSkill = fs.readFileSync(
  path.join(PKG_ROOT, 'skills', 'huayuan-live-dashboard', 'SKILL.md'),
  'utf8'
);
check('专家说明要求每轮先打开外部驾驶舱', /驾驶舱总闸/.test(agentText) && /任何有效指令后/.test(agentText));
check('外部驾驶舱技能覆盖自动打开与未初始化模式', /用户任何有效指令/.test(liveSkill) && /ONBOARDING_MODE/.test(liveSkill));
check('Widget Skill 把“打开驾驶舱”转给外部驾驶舱', /打开驾驶舱.*外部网页驾驶舱/.test(widgetSkill));
check('Widget 只在明确“看卡片”时生成', /在对话里看卡片/.test(widgetSkill) && /不能替代外部驾驶舱/.test(widgetSkill));

const failed = results.filter((item) => !item.ok);
console.log(`\n========================================================`);
console.log(`WIDGET:${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
console.log(`产物目录：${WORK}`);
if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
