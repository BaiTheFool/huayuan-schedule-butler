'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const agent = fs.readFileSync(path.join(ROOT, 'agents', 'huayuan-schedule-butler.md'), 'utf8');
const browserSkill = fs.readFileSync(
  path.join(ROOT, 'skills', 'huayuan-browser-session', 'SKILL.md'),
  'utf8'
);
const dashboardLauncher = fs.readFileSync(
  path.join(ROOT, 'skills', 'huayuan-live-dashboard', 'scripts', 'launch-dashboard.js'),
  'utf8'
);
const plugin = JSON.parse(
  fs.readFileSync(path.join(ROOT, '.codebuddy-plugin', 'plugin.json'), 'utf8')
);

check('Agent 提示词不超过 16KB', Buffer.byteLength(agent) <= 16 * 1024, `${Buffer.byteLength(agent)} B`);
check(
  '浏览器 Skill 不超过 12KB',
  Buffer.byteLength(browserSkill) <= 12 * 1024,
  `${Buffer.byteLength(browserSkill)} B`
);
check('maxTurns 不超过 30', /maxTurns:\s*30\b/.test(agent));
const agentSkillsMatch = agent.match(/^skills:\s*\[(.*?)\]\s*$/m);
const agentSkills = agentSkillsMatch
  ? agentSkillsMatch[1].split(',').map((item) => item.trim()).filter(Boolean)
  : [];
const pluginSkills = plugin.skills.map((item) => path.basename(item));
const directorySkills = fs
  .readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'skills', entry.name, 'SKILL.md')))
  .map((entry) => entry.name);
const sameSkills = (left, right) =>
  left.length === right.length && [...left].sort().every((item, index) => item === [...right].sort()[index]);
check(
  'Skills 注册、Agent frontmatter 与实际目录一致',
  sameSkills(agentSkills, pluginSkills) && sameSkills(pluginSkills, directorySkills),
  `agent=${agentSkills.length} plugin=${pluginSkills.length} dir=${directorySkills.length}`
);
check(
  '每个用户回合先确保侧边驾驶舱打开',
  /驾驶舱总闸/.test(agent) &&
    /收到任何消息.*第一个工具调用必须是/.test(agent) &&
    /launch-dashboard\.js --no-open/.test(agent) &&
    /不得因缺少数据跳过/.test(agent)
);
check(
  '侧边浏览器通过 WorkBuddy preview_url 打开真实网页',
  /preview_url\(\{"url":/.test(agent) &&
    /LIVE_DASHBOARD_READY/.test(agent) &&
    /处理原请求和运行 `intro\.js`\/`now\.js` 前/.test(agent)
);
check(
  '禁止用文件、卡片或外部浏览器替代驾驶舱',
  /禁止.*`present_files`.*本地 HTML/.test(agent) &&
    /外部浏览器/.test(agent) &&
    !/才重跑启动器且不加 `--no-open`/.test(agent)
);
check(
  '启动器验证真实网页并要求每轮打开',
  /LIVE_DASHBOARD_ALREADY_OPEN:/.test(dashboardLauncher) &&
    /requestedPagePath\(\)/.test(dashboardLauncher) &&
    /LIVE_DASHBOARD_OPEN_REQUIRED:1/.test(dashboardLauncher) &&
    /LIVE_DASHBOARD_VERIFIED:1/.test(dashboardLauncher) &&
    /LIVE_DASHBOARD_PREVIEW_ARGS:/.test(dashboardLauncher) &&
    /verifyDashboardPage/.test(dashboardLauncher)
);
check(
  '未初始化也必须进入驾驶舱引导模式',
  /LIVE_DASHBOARD_ONBOARDING_MODE:1/.test(agent) &&
    /未初始化时.*也必须打开/.test(agent)
);
check(
  '内嵌卡片不自动生成',
  /不自动生成内嵌 Widget/.test(agent)
);

const intro = spawnSync(
  process.execPath,
  [path.join(ROOT, 'skills', 'huayuan-browser-session', 'scripts', 'intro.js')],
  { encoding: 'utf8', timeout: 5000 }
);
check('intro.js 在 5 秒内完成', intro.status === 0, `exit=${intro.status}`);

const failed = checks.filter((item) => !item.ok);
console.log(`PERFORMANCE:${failed.length ? 'FAIL' : 'PASS'} ${checks.length - failed.length}/${checks.length}`);
process.exitCode = failed.length ? 1 : 0;
