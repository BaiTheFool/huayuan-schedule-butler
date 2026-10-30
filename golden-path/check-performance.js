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
    /收到用户的任何有效指令后，先执行/.test(agent) &&
    /launch-dashboard\.js --no-open/.test(agent) &&
    /不得因缺少数据跳过/.test(agent)
);
check(
  '侧边浏览器通过 WorkBuddy present_files 打开',
  /present_files/.test(agent) &&
    /LIVE_DASHBOARD_ALREADY_OPEN:0/.test(agent) &&
    /右侧内置浏览器面板/.test(agent) &&
    /LIVE_DASHBOARD_SIDEBAR_FILE/.test(agent) &&
    /"files":\[/.test(agent)
);
check(
  '禁止二次启动器或外部浏览器兜底',
  /禁止第二次启动器/.test(agent) &&
    /去掉 `--no-open`/.test(agent) &&
    !/才重跑启动器且不加 `--no-open`/.test(agent)
);
check(
  '启动器区分侧边页面已开与需要重新打开',
  /LIVE_DASHBOARD_ALREADY_OPEN:/.test(dashboardLauncher) &&
    /requestedPagePath\(\)/.test(dashboardLauncher) &&
    /LIVE_DASHBOARD_SIDEBAR_FILE:/.test(dashboardLauncher) &&
    /location\.replace/.test(dashboardLauncher)
);
check(
  '未初始化也必须进入驾驶舱引导模式',
  /LIVE_DASHBOARD_ONBOARDING_MODE:1/.test(agent) &&
    /未初始化也必须打开/.test(agent)
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
