'use strict';

/**
 * 华园绩点计算器（官方《2026 本科生手册》口径）
 *
 * 依据：
 *  - 《学籍管理办法（2026 年修订）》第 39 条：百分制平均学分绩点 / 四分制 GPA（动态转换）
 *  - 《学士学位授予实施细则（2025 年修订）》第 5 条：GPA ≥ 2.0 授学位
 *
 * 用法：
 *   node gpa-calculator.js --input <成绩文件.json>
 *   node gpa-calculator.js --self-check
 *   node gpa-calculator.js --input <成绩文件.json> --target-percent 85   # 反推剩余课程所需平均分
 *
 * 输入 JSON（courses 数组，字段按需给出）：
 *   {
 *     "courses": [
 *       { "name": "高等数学", "credits": 5, "score": 92 },
 *       { "name": "大学英语", "credits": 3, "score": 85 },
 *       { "name": "思政",     "credits": 2, "level": "优秀" },          // 五级制
 *       { "name": "公益劳动", "credits": 1, "level": "通过" },          // 二级制
 *       { "name": "某挂科课", "credits": 2, "score": 58, "failed": true },  // 不及格→0
 *       { "name": "某重考课", "credits": 2, "score": 90, "retake": true },  // 重考通过→百分制记 0
 *       { "name": "工程制图", "credits": 2, "rankPercentile": 15 },     // GPA 动态转换：班级前 20%→4.0
 *       { "name": "C语言",   "credits": 3, "grade": "B+" },            // 直接给四分制等级
 *       { "name": "下学期高数", "credits": 5, "planned": true }        // 待考课程（反推用）
 *     ]
 *   }
 *
 * 口径注意（与 knowledge/001-绩点规则.md 保持一致）：
 *  - 百分制平均学分绩点：只放【必修课】；按首次考核成绩；不及格/不通过/重考/重修通过记 0；五级 95/85/75/65/0、两级 80/0。
 *  - 四分制 GPA：只放【主修专业综合培养计划要求的课程】；按最高成绩；动态转换需班级排名（rankPercentile）或等级（grade）；
 *    只给了 score 没有班级分布的课程无法精算 GPA，会单独列出。重考绩点按原班级正考区间封顶 3.3。
 */

const fs = require('fs');
const path = require('path');

// ---------- 官方常量表（与 knowledge/ 双份事实源，改动须同步） ----------
const FIVE_LEVEL_TO_PERCENT = { 优秀: 95, 良好: 85, 中等: 75, 及格: 65, 不及格: 0 };
const TWO_LEVEL_TO_PERCENT = { 通过: 80, 不通过: 0 };
const FIVE_LEVEL_TO_GRADE = { 优秀: 'A', 良好: 'B', 中等: 'C', 及格: 'D', 不及格: 'F' };
// 五级制直接对应绩点（手册附表，不经动态百分比表）：优秀 A 4.0 / 良好 B 3.7 / 中等 C 2.7 / 及格 D 1.7 / 不及格 F 0.0
const FIVE_LEVEL_TO_POINT = { 优秀: 4.0, 良好: 3.7, 中等: 2.7, 及格: 1.7, 不及格: 0.0 };
const GRADE_TO_POINT = { A: 4.0, 'B+': 3.7, B: 3.3, 'B-': 3.0, 'C+': 2.7, C: 2.3, 'C-': 2.0, D: 1.7, F: 0.0, P: 3.0 };
const RANK_TO_POINT = [
  { max: 20, point: 4.0, grade: 'A' },
  { max: 35, point: 3.7, grade: 'B+' },
  { max: 50, point: 3.3, grade: 'B' },
  { max: 60, point: 3.0, grade: 'B-' },
  { max: 70, point: 2.7, grade: 'C+' },
  { max: 80, point: 2.3, grade: 'C' },
  { max: 90, point: 2.0, grade: 'C-' },
  { max: 100, point: 1.7, grade: 'D' },
];
const RETAKE_GPA_CAP = 3.3;

function rankToPoint(percentile) {
  const p = Number(percentile);
  if (!(p >= 0 && p <= 100)) return null;
  for (const r of RANK_TO_POINT) {
    if (p <= r.max) return { point: r.point, grade: r.grade, fromRank: true };
  }
  return { point: 0.0, grade: 'F', fromRank: true };
}

/** 百分制成绩（首次考核口径） */
function percentScoreOf(c) {
  if (c.failed || c.retake || c.rework) return 0; // 不及格/不通过/重考/重修通过 → 0
  if (typeof c.score === 'number') return c.score;
  if (c.level) {
    if (FIVE_LEVEL_TO_PERCENT[c.level] !== undefined) return FIVE_LEVEL_TO_PERCENT[c.level];
    if (TWO_LEVEL_TO_PERCENT[c.level] !== undefined) return TWO_LEVEL_TO_PERCENT[c.level];
  }
  return null; // 缺成绩
}

/** 四分制绩点（动态转换 / 等级直给） */
function gpaPointOf(c) {
  if (c.failed || c.grade === 'F' || c.level === '不及格' || c.level === '不通过') {
    return { point: 0.0, grade: 'F', source: 'failed' };
  }
  let res = null;
  let source = null;
  if (typeof c.rankPercentile === 'number') {
    res = rankToPoint(c.rankPercentile);
    if (res) source = 'rank';
  }
  if (!res && c.grade && GRADE_TO_POINT[c.grade] !== undefined) {
    res = { point: GRADE_TO_POINT[c.grade], grade: c.grade, fromRank: false };
    source = 'grade';
  }
  if (!res && c.level) {
    const p = FIVE_LEVEL_TO_POINT[c.level];
    if (p !== undefined) {
      res = { point: p, grade: FIVE_LEVEL_TO_GRADE[c.level] || c.level, fromRank: false };
      source = 'level';
    } else if (c.level === '通过') {
      res = { point: 3.0, grade: 'P', fromRank: false };
      source = 'level';
    }
  }
  if (res && (c.retake || c.rework)) {
    // 重考/重修：按原班级正考区间认定，封顶 3.3
    res = { ...res, point: Math.min(res.point, RETAKE_GPA_CAP), capped: true };
  }
  return res ? { ...res, source } : null; // score-only → 无法精算
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

// ---------- 计算 ----------
function computePercentGPA(courses) {
  let sum = 0;
  let credits = 0;
  const details = [];
  for (const c of courses) {
    const s = percentScoreOf(c);
    details.push({
      name: c.name,
      credits: c.credits,
      percentScore: s === null ? '缺成绩' : s,
      note: s === null ? '未提供首次成绩（score/level），不计入百分制绩点' : '',
    });
    if (s === null) continue;
    sum += s * c.credits;
    credits += c.credits;
  }
  return { value: credits ? round3(sum / credits) : null, sum, credits, details };
}

function computeGPA(courses) {
  let sum = 0;
  let credits = 0;
  const details = [];
  const unresolved = [];
  for (const c of courses) {
    const p = gpaPointOf(c);
    if (!p) {
      unresolved.push({ name: c.name, credits: c.credits, reason: '只有 score，缺少班级排名(rankPercentile)或等级(grade)，动态转换无法精算' });
      continue;
    }
    sum += p.point * c.credits;
    credits += c.credits;
    details.push({ name: c.name, credits: c.credits, point: p.point, grade: p.grade, source: p.source, capped: !!p.capped });
  }
  return { value: credits ? round3(sum / credits) : null, sum, credits, details, unresolved };
}

// ---------- 反推：达到目标百分制绩点所需剩余课程平均分 ----------
function reverseTarget(courses, target) {
  const done = [];
  const planned = [];
  for (const c of courses) {
    if (c.planned) planned.push(c);
    else done.push(c);
  }
  let s0 = 0;
  let c0 = 0;
  for (const c of done) {
    const s = percentScoreOf(c);
    if (s === null) continue;
    s0 += s * c.credits;
    c0 += c.credits;
  }
  const plannedCredits = planned.reduce((a, c) => a + c.credits, 0);
  if (!plannedCredits) {
    return { ok: false, reason: '没有标记 planned 的待考课程，无法反推' };
  }
  const totalCredits = c0 + plannedCredits;
  const need = (target * totalCredits - s0) / plannedCredits;
  return {
    ok: true,
    current: c0 ? round3(s0 / c0) : null,
    currentCredits: c0,
    plannedCredits,
    target,
    requiredAverage: round3(need),
    hint: need <= 100 && need >= 0 ? '可行' : need > 100 ? '目标过高：剩余课程平均需超过 100 分才能达到' : '目标过低：当前已达到',
  };
}

// ---------- 主入口 ----------
function run() {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf('--input');
  const targetIdx = args.indexOf('--target-percent');

  if (args.includes('--self-check')) {
    return selfCheck();
  }
  if (inputIdx < 0) {
    console.error('用法：node gpa-calculator.js --input <文件.json> [--target-percent N] | --self-check');
    process.exit(2);
  }
  const file = args[inputIdx + 1];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`无法读取或解析 ${file}: ${e.message}`);
    process.exit(2);
  }
  const courses = data.courses || [];
  const percent = computePercentGPA(courses);
  const gpa = computeGPA(courses);

  const out = {
    tool: 'huayuan-score-advisor/gpa-calculator',
    version: '0.11.0',
    percentGPA: percent.value,
    percentCredits: percent.credits,
    gpa4: gpa.value,
    gpa4Credits: gpa.credits,
    degreeEligible: gpa.value === null ? null : gpa.value >= 2.0,
    detailPercent: percent.details,
    detailGPA: gpa.details,
    unresolvedGPA: gpa.unresolved,
    disclaimer: '依据《2026 年本科生手册》学籍管理办法第 39 条口径计算；百分制绩点=必修课首次考核；GPA=主修培养方案课程动态转换。以官方最新通知为准。',
  };
  if (targetIdx >= 0) {
    const target = Number(args[targetIdx + 1]);
    if (!(target >= 0 && target <= 100)) {
      console.error('--target-percent 需要 0-100 之间的数值');
      process.exit(2);
    }
    out.reverse = reverseTarget(courses, target);
  }

  console.log(JSON.stringify(out, null, 2));
}

// ---------- 自检（固定虚构样例） ----------
function selfCheck() {
  const results = [];
  function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  // 百分制样例（必修课口径）
  const pCourses = [
    { name: '高等数学', credits: 5, score: 92 },
    { name: '大学英语', credits: 3, score: 85 },
    { name: '思政', credits: 2, level: '优秀' },     // →95
    { name: '公益劳动', credits: 1, level: '通过' },  // →80
    { name: '挂科课', credits: 2, score: 58, failed: true },   // →0
    { name: '重考通过课', credits: 2, score: 90, retake: true }, // →0
  ];
  const p = computePercentGPA(pCourses);
  // (92*5+85*3+95*2+80*1+0+0)/(5+3+2+1+2+2)=985/15=65.6667
  check('百分制绩点加权和', p.sum === 985, `sum=${p.sum}`);
  check('百分制绩点学分', p.credits === 15, `credits=${p.credits}`);
  check('百分制绩点数值', Math.abs(p.value - 65.6667) < 0.001, `value=${p.value}`);
  check('挂科课记 0', p.details.find((d) => d.name === '挂科课').percentScore === 0, '挂科课=0');
  check('重考通过记 0', p.details.find((d) => d.name === '重考通过课').percentScore === 0, '重考课=0');
  check('五级折算优秀=95', p.details.find((d) => d.name === '思政').percentScore === 95, '思政=95');
  check('两级折算通过=80', p.details.find((d) => d.name === '公益劳动').percentScore === 80, '公益=80');

  // GPA 样例（动态转换 + 等级 + 五级/二级）
  const gCourses = [
    { name: '课A', credits: 3, rankPercentile: 10 },    // 前20%→A 4.0
    { name: '课B', credits: 3, rankPercentile: 30 },    // 20.1-35%→B+ 3.7
    { name: '课C', credits: 2, grade: 'B' },            // 3.3
    { name: '课D', credits: 2, level: '中等' },          // C→2.7
    { name: '课E', credits: 1, level: '通过' },          // P→3.0
  ];
  const g = computeGPA(gCourses);
  // (4.0*3+3.7*3+3.3*2+2.7*2+3.0*1)/11 = 38.1/11 = 3.4636...
  check('GPA 数值', Math.abs(g.value - 3.4636) < 0.001, `value=${g.value}`);
  check('GPA 学分', g.credits === 11, `credits=${g.credits}`);
  check('GPA 排名转换 A', g.details.find((d) => d.name === '课A').point === 4.0, '课A=4.0');
  check('GPA 排名转换 B+', g.details.find((d) => d.name === '课B').point === 3.7, '课B=3.7');
  check('GPA 等级直给', g.details.find((d) => d.name === '课C').point === 3.3, '课C=3.3');
  check('GPA 五级折算', g.details.find((d) => d.name === '课D').point === 2.7, '课D=2.7');
  check('GPA 二级折算', g.details.find((d) => d.name === '课E').point === 3.0, '课E=3.0');

  // score-only 无法精算
  const uCourses = [{ name: '只有分数', credits: 2, score: 85 }];
  const u = computeGPA(uCourses);
  check('score-only 标记未解析', u.unresolved.length === 1 && u.value === null, 'unresolved=1');

  // 重考封顶 3.3
  const rCourses = [
    { name: '重考A', credits: 3, rankPercentile: 5, retake: true }, // 原区间 A=4.0 → 封顶 3.3
    { name: '重考B', credits: 3, rankPercentile: 40, retake: true }, // B=3.3 → 不封
  ];
  const r = computeGPA(rCourses);
  check('重考绩点封顶 3.3', r.details.find((d) => d.name === '重考A').point === 3.3, '重考A=3.3');
  check('重考未超 3.3 不封', r.details.find((d) => d.name === '重考B').point === 3.3, '重考B=3.3');

  // 学位检查
  check('学位检查(GPA≥2.0)', (3.4636 >= 2.0) === true, '样例 GPA 满足学位要求');

  // 反推
  const rev = reverseTarget(
    [
      { name: '已修高数', credits: 5, score: 80 },
      { name: '已修英语', credits: 3, score: 70 },
      { name: '下学期专业课', credits: 4, planned: true },
      { name: '下学期通识', credits: 2, planned: true },
    ],
    85
  );
  // 目标总分 = 85*(8+6)=1190；当前 = 80*5+70*3=610；需 580/6 = 96.667
  check('反推所需平均分', Math.abs(rev.requiredAverage - 96.6667) < 0.001, `need=${rev.requiredAverage}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nGPA_CALCULATOR_SELF_CHECK: ${failed.length ? `FAIL ${failed.length}/${results.length}` : `PASS ${results.length}/${results.length}`}`);
  return failed.length ? 1 : 0;
}

if (require.main === module) {
  const code = run();
  process.exitCode = code || 0;
}

module.exports = { computePercentGPA, computeGPA, reverseTarget, rankToPoint };
