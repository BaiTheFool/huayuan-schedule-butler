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
  '普通“现在该干什么”不自动 Widget',
  /不自动生成 Widget/.test(agent)
);
check(
  '打开/网页/分屏只走外部网页驾驶舱',
  /路径互斥规则/.test(agent) && /show_widget` 不执行/.test(agent)
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
