'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'skills', 'huayuan-browser-session', 'scripts');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-activities-home-'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-activities-out-'));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HUAYUAN_HOME: HOME, HUAYUAN_OUTPUT_DIR: OUT },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

(async () => {
  const selfCheck = run('activity-feed.js', ['--self-check']);
  check('活动解析自检', selfCheck.status === 0 && /ACTIVITY_SELF_CHECK:PASS 8\/8/.test(selfCheck.stdout));

  const list = run('activity-feed.js', ['--list-colleges']);
  const colleges = JSON.parse(list.stdout || '[]');
  check('学院目录覆盖至少 40 个本科相关学院/书院', list.status === 0 && colleges.length >= 40, `${colleges.length} 个`);
  check('目录包含软件学院和计算机科学与工程学院', colleges.some((item) => item.name === '软件学院') && colleges.some((item) => item.name === '计算机科学与工程学院'));
  const { INTERVIEW } = require(path.join(SCRIPTS, 'preferences.js'));
  check('初始化向导第一题询问学院/书院', INTERVIEW[0]?.key === 'college', INTERVIEW[0]?.question || 'missing');

  const saved = run('manage-items.js', ['set-college', '--name', '软件学院']);
  const prefs = JSON.parse(fs.readFileSync(path.join(HOME, 'preferences.json'), 'utf8'));
  check('学院选择写入本地偏好', saved.status === 0 && prefs.college === '软件学院', prefs.college || 'missing');

  const invalid = run('manage-items.js', ['set-college', '--name', '不存在的学院']);
  check('未知学院被拒绝而不是静默保存', invalid.status !== 0 && /COLLEGE_NOT_FOUND/.test(invalid.stderr), invalid.stderr.split('\n')[0]);

  const failed = results.filter((item) => !item.ok);
  console.log(`ACTIVITIES:${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exitCode = failed.length ? 1 : 0;
})();
