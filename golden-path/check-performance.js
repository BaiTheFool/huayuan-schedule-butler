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
check('Skills 数量为 5', plugin.skills.length === 5, String(plugin.skills.length));
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
