'use strict';

/**
 * 0.11.0 绩点/操行分计分工具回归（离线、虚构样例）：
 * 1. gpa-calculator.js --self-check 全部通过（19/19）；
 * 2. conduct-calculator.js --self-check 全部通过（13/13）；
 * 3. 端到端：--input 虚构成绩文件 → 输出 JSON 结构完整、口径正确。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(PKG_ROOT, 'skills', 'huayuan-score-advisor');
const GPA = path.join(SKILL, 'scripts', 'gpa-calculator.js');
const CONDUCT = path.join(SKILL, 'scripts', 'conduct-calculator.js');
const WORK = path.join(os.tmpdir(), `huayuan-score-${Date.now()}`);
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function runNode(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

console.log('0.11.0 绩点/操行分计分工具回归（离线、虚构样例）');

// 1) gpa self-check
const g = runNode(GPA, ['--self-check']);
check('gpa self-check 退出码', g.status === 0, `status=${g.status}`);
check('gpa self-check 全绿', /GPA_CALCULATOR_SELF_CHECK: PASS 19\/19/.test(g.out), (g.out.match(/SELF_CHECK:.*/) || [''])[0]);

// 2) conduct self-check
const c = runNode(CONDUCT, ['--self-check']);
check('conduct self-check 退出码', c.status === 0, `status=${c.status}`);
check('conduct self-check 全绿', /CONDUCT_CALCULATOR_SELF_CHECK: PASS 13\/13/.test(c.out), (c.out.match(/SELF_CHECK:.*/) || [''])[0]);

// 3) 端到端 gpa --input
const gpaInput = {
  courses: [
    { name: '高等数学', credits: 5, score: 92 },
    { name: '大学英语', credits: 3, score: 85 },
    { name: '思政', credits: 2, level: '优秀' },
    { name: '工程制图', credits: 2, rankPercentile: 15 },
    { name: 'C语言', credits: 3, grade: 'B+' },
  ],
};
const gpaFile = path.join(WORK, 'gpa-input.json');
fs.writeFileSync(gpaFile, JSON.stringify(gpaInput), 'utf8');
const ge = runNode(GPA, ['--input', gpaFile]);
let gOut = null;
try { gOut = JSON.parse(ge.out); } catch { /* 非 JSON 输出 */ }
check('gpa --input 输出 JSON 可解析', !!gOut, ge.status === 0 ? 'ok' : ge.err.slice(0, 120));
check('gpa 百分制绩点字段', gOut && typeof gOut.percentGPA === 'number', `percentGPA=${gOut && gOut.percentGPA}`);
check('gpa 四分制 GPA 字段', gOut && typeof gOut.gpa4 === 'number', `gpa4=${gOut && gOut.gpa4}`);
// 百分制：只算有首次成绩的课程（高数92、英语85、思政95；工程制图/C语言无 score 不计入）→ (92*5+85*3+95*2)/10=905/10=90.5
check('gpa 百分制数值', gOut && Math.abs(gOut.percentGPA - 90.5) < 0.001, `=${gOut && gOut.percentGPA}`);
// GPA：思政 level=优秀→4.0、工程制图 rank15→4.0、C语言 B+→3.7 → (4.0*2+4.0*2+3.7*3)/7=27.1/7=3.8714
check('gpa 四分制数值', gOut && Math.abs(gOut.gpa4 - 3.8714) < 0.001, `=${gOut && gOut.gpa4}`);
check('gpa 学位检查', gOut && gOut.degreeEligible === true, `degreeEligible=${gOut && gOut.degreeEligible}`);

// 4) 端到端 conduct --input
const conductInput = {
  courses: [
    { name: '高数', credits: 5, score: 90 },
    { name: '英语', credits: 3, score: 80 },
    { name: '思政', credits: 2, level: '良好' },
    { name: '体育', credits: 1, score: 95 },
  ],
  conduct: {
    self: { 政治信仰: 8, 践行社会主义核心价值观: 8, 遵纪守法: 6, 维护社会公德: 6, 实践服务: 6, 学习态度: 6, 身心健康: 6, 文化素养: 6, 卫生文明: 4, 勤俭劳动: 4 },
    class: { 政治信仰: 7, 践行社会主义核心价值观: 7, 遵纪守法: 5, 维护社会公德: 5, 实践服务: 5, 学习态度: 5, 身心健康: 5, 文化素养: 5, 卫生文明: 3, 勤俭劳动: 3 },
    advisor: { 政治信仰: 7, 践行社会主义核心价值观: 7, 遵纪守法: 5, 维护社会公德: 5, 实践服务: 5, 学习态度: 5, 身心健康: 5, 文化素养: 5, 卫生文明: 3, 勤俭劳动: 3 },
  },
  conductBonus: { deeds: 8, bloodDonations: 1, groupActivities: 10 },
  virtue: { honors: [{ kind: 'personal', level: '省级' }], deductions: [] },
  intellect: { competitions: [{ team: 'personal', level: '国家级', rank: '2' }], papers: [] },
  sports: { records: [], awards: [{ team: 'personal', level: '学校级', rank: '1' }] },
  arts: { works: [], competitions: [] },
  labor: { plus: [{ type: 'star', stars: 3 }], minus: [] },
};
const cdFile = path.join(WORK, 'conduct-input.json');
fs.writeFileSync(cdFile, JSON.stringify(conductInput), 'utf8');
const ce = runNode(CONDUCT, ['--input', cdFile]);
let cOut = null;
try { cOut = JSON.parse(ce.out); } catch { /* 非 JSON */ }
check('conduct --input 输出 JSON 可解析', !!cOut, ce.status === 0 ? 'ok' : ce.err.slice(0, 120));
// X=(90*5+80*3+85*2+95*1)/11=955/11=86.818
check('conduct X 数值', cOut && Math.abs(cOut.X.value - 86.8182) < 0.001, `X=${cOut && cOut.X && cOut.X.value}`);
// C1=51，C2=8+2.5+10=20.5 → C=71.5
check('conduct C 数值', cOut && cOut.C.value === 71.5, `C=${cOut && cOut.C && cOut.C.value}`);
// D=12（省级 D1），Z=5，T=3，M=0，L=4 → S=12+15+3+0+4=34
check('conduct S 数值', cOut && cOut.S.value === 34, `S=${cOut && cOut.S && cOut.S.value}`);
// H=0.7*86.8182+0.1*71.5+0.2*34=60.7727+7.15+6.8=74.7227
check('conduct H 数值', cOut && Math.abs(cOut.H - 74.7227) < 0.001, `H=${cOut && cOut.H}`);
check('conduct 阈值提示存在', cOut && !!cOut.thresholds, 'thresholds ok');

const failed = results.filter((r) => !r.ok);
console.log(`\nSCORE_GATE: ${failed.length ? `FAIL ${failed.length}/${results.length}` : `PASS ${results.length}/${results.length}`}`);
process.exitCode = failed.length ? 1 : 0;
