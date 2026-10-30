'use strict';

/**
 * 华园综合测评/操行分计算器（官方《2026 本科生手册》口径）
 *
 * 依据：《本科生综合测评及奖励办法（2025 年修订）》（华南工学〔2025〕23 号）及附件 1。
 *   H = 0.7X + 0.1C + 0.2S；C = C1 + C2；S = D + 3Z + T + M + L
 *
 * 用法：
 *   node conduct-calculator.js --input <测评输入.json>
 *   node conduct-calculator.js --self-check
 *
 * 输入 JSON 结构（示例见 --self-check 内 fixtures）：
 * {
 *   "courses": [ {"name","credits","score"|"level","failed"?,"retake"?} ],   // X：必修(含体育)+选修(院系自定)
 *   "conduct": {                                                            // C1：三个测评来源，各 10 项
 *     "self":     { "政治信仰":8, "践行社会主义核心价值观":8, "遵纪守法":6, "维护社会公德":6, "实践服务":6, "学习态度":6, "身心健康":6, "文化素养":6, "卫生文明":4, "勤俭劳动":4 },
 *     "class":    { ... 同上 ... },
 *     "advisor":  { ... 同上 ... }
 *   },
 *   "conductBonus": { "deeds": 8, "bloodDonations": 1, "groupActivities": 15 },   // C2
 *   "virtue": {                                                                   // D = D1 - D2（D1 上限 25）
 *     "honors": [ {"kind":"personal"|"group","level":"国家级|省级|学校级|院（系）级","type":"团干|团员|党员|...","role":"leader|coLeader|member"} ],
 *     "deductions": [ {"kind":"personal","type":"旷课","count":2} | {"kind":"personal","type":"学校通报批评"|"学院通报批评"|"警告"|"严重警告"|"记过"|"留校察看"} | {"kind":"group","level":"学校|院（系）","role":"leader|member"} ]
 *   },
 *   "intellect": {                                                              // Z
 *     "competitions": [ {"team":"personal|group","level":"国际级|国家级|省级|校级|院（系）级","rank":"1|2|3","role":"leader|main|member"} ],
 *     "papers": [ {"tier":"顶尖|高水平|一般","author":"first|second|other","score":8} ]   // score 由院系认定，必填
 *   },
 *   "sports": { "records": [ {"team":"personal|group","level":"...","role":"leader|member"} ], "awards": [ {"team":"personal|group","level":"...","rank":"1|2|3","role":"main|normal"} ] },
 *   "arts": { "works": [ {"team":"solo|group","level":"...","role":"first|other"} ], "competitions": [ {"team":"personal|group","level":"...","rank":"1|2|3","role":"main|normal"} ] },
 *   "labor": { "plus": [ {"type":"practice","level":"国家级|省级|学校级|院（系）级","role":"leader|member"} | {"type":"star","stars":1} ], "minus": [ {"type":"absent","score":1} | {"type":"dorm","level":"学校|院（系）","role":"leader|member"} ] }
 * }
 *
 * 口径注意（与 knowledge/002 一致）：
 *  - X：含选修课（院系自定）；首次考核；五级 95/85/75/65/0、两级 80/0；不及格/不通过/重考/重修通过记 0。
 *  - C1 满分 60 = 自评 10% + 班级评议 60% + 班主任 30%；十个维度满分 8/8/6/6/6/6/6/6/4/4。
 *  - C2 上限 40；D1 上限 25；T/M/L 各自上限 15；Z 学术成果按院系认定（score 必填）。
 *  - 具体加分认定以院（系）实施细则为准；校级固定表为默认值，单项可用 score 覆盖。
 */

const fs = require('fs');

// ---------- 官方常量表（与 knowledge/ 双份事实源，改动须同步） ----------
const FIVE_LEVEL_TO_PERCENT = { 优秀: 95, 良好: 85, 中等: 75, 及格: 65, 不及格: 0 };
const TWO_LEVEL_TO_PERCENT = { 通过: 80, 不通过: 0 };
const CONDUCT_DIMENSIONS = ['政治信仰', '践行社会主义核心价值观', '遵纪守法', '维护社会公德', '实践服务', '学习态度', '身心健康', '文化素养', '卫生文明', '勤俭劳动'];
const CONDUCT_DIM_MAX = { 政治信仰: 8, 践行社会主义核心价值观: 8, 遵纪守法: 6, 维护社会公德: 6, 实践服务: 6, 学习态度: 6, 身心健康: 6, 文化素养: 6, 卫生文明: 4, 勤俭劳动: 4 };

// D1 个人荣誉
const D1_PERSONAL = {
  国家级: 15, 省级: 12,
  学校级优秀党员团干骨干: 7, 学校级优秀团员: 5, 院系级: 4,
  省级积极分子: 4, 学校积极分子: 3, 院系积极分子: 2,
};
// D1 集体荣誉（负责人 / 其他负责人 / 一般成员）
const D1_GROUP = {
  全国: { leader: 12, coLeader: 10, member: 8 },
  全省: { leader: 9, coLeader: 7, member: 6 },
  学校: { leader: 6, coLeader: 5, member: 4 },
  院系: { leader: 5, coLeader: 4, member: 3 },
};
// D2 个人扣分
const D2_PERSONAL = {
  旷课: { per: 1, note: '1 分/学时' },
  学院通报批评: { per: 2 }, 学校通报批评: { per: 4 },
  警告: { per: 10 }, 严重警告: { per: 15 }, 记过: { per: 20 }, 留校察看: { per: 25 },
};
// D2 集体扣分（负责人 / 一般成员）
const D2_GROUP = { 学校: { leader: 4, member: 3 }, 院系: { leader: 2, member: 1 } };

// Z 学科竞赛个人（1名 / 2名 / 3-6名）
const Z_CONTEST_PERSONAL = {
  国际级: [8, 6, 5], 国家级: [6, 5, 3], 省级: [5, 3, 2], 校级: [3, 2, 1], 院系级: [2, 1, 0.5],
};
// Z 学科竞赛集体（leader / main / member），rank: 1=第1名 2=第2名 3=第3、4名
const Z_CONTEST_GROUP = {
  国际级: { 1: [8, 6, 5], 2: [6, 5, 4], 3: [5, 4, 3] },
  国家级: { 1: [6, 4.5, 3.5], 2: [5, 3.5, 2.5], 3: [3, 2.5, 1.5] },
  省级: { 1: [5, 3.5, 2], 2: [3, 2, 1.5], 3: [2, 1.5, 1] },
  校级: { 1: [3, 2, 1.5], 2: [2, 1.5, 1], 3: [1, 0.5, 0.5] },
  院系级: { 1: [1.5, 1, 0.5], 2: [0.5, 0.5, 0.5], 3: [0.5, 0.5, 0.5] },
};
// Z 学术成果区间（first/second/other）——院系认定，输入给 score
const Z_PAPER_RANGE = {
  顶尖: { first: [8, 10], second: [5, 7], other: [3, 4] },
  高水平: { first: [3, 8], second: [2, 4], other: [1, 2] },
  一般: { first: [0.5, 3], second: [0, 2], other: [0, 1] },
};

// T 破纪录
const T_RECORD = { 国际级: [10, 8], 国家级: [9, 7], 省级: [7, 5], 学校级: [5, 4], 院系级: [4, 3] }; // [个人, 集体主力/一般 → 集体用同一对? ]
// 集体破纪录：主力/一般 = [10,8]...
const T_RECORD_GROUP = { 国际级: { leader: 10, member: 8 }, 国家级: { leader: 9, member: 7 }, 省级: { leader: 7, member: 5 }, 学校级: { leader: 5, member: 4 }, 院系级: { leader: 4, member: 3 } };
const T_RECORD_PERSONAL = { 国际级: 10, 国家级: 9, 省级: 7, 学校级: 5, 院系级: 4 };
// T 竞赛获奖个人（1-3名 / 4-6名 / 7-8名）
const T_AWARD_PERSONAL = { 国际级: [8, 7, 6], 国家级: [6, 5, 3], 省市级: [5, 3, 2], 学校级: [3, 2, 1], 院系级: [2, 1, 0.5] };
// T 竞赛获奖集体（主要成员 / 普通成员），rank 1/2/3
const T_AWARD_GROUP = {
  国际级: { 1: [8, 6], 2: [7, 5], 3: [6, 4] },
  国家级: { 1: [6, 4], 2: [5, 3], 3: [3, 2] },
  省市级: { 1: [5, 3], 2: [3, 2], 3: [2, 1.5] },
  学校级: { 1: [3, 2], 2: [2, 1.5], 3: [1.5, 1] },
  院系级: { 1: [2, 1.5], 2: [1.5, 1], 3: [1, 0.5] },
};

// M 作品（个人 / 集体 第一作者-其他作者）
const M_WORK = { 国际级: [8, 6], 国家级: [6, 4], 省市级: [5, 3], 学校级: [3, 2], 院系级: [2, 1] };
// M 知识/演讲/辩论竞赛（个人 1/2/3-4名；集体 主要/普通）
const M_CONTEST_PERSONAL = { 国际级: [8, 7, 6], 国家级: [6, 5, 3], 省市级: [5, 4, 2], 学校级: [3, 2, 1.5], 院系级: [2, 1.5, 1] };
const M_CONTEST_GROUP = {
  国际级: { 1: [8, 6], 2: [7, 5], 3: [6, 4] },
  国家级: { 1: [6, 4], 2: [5, 3], 3: [3, 2] },
  省市级: { 1: [5, 3], 2: [3, 2], 3: [2, 1.5] },
  学校级: { 1: [3, 2], 2: [2, 1.5], 3: [1.5, 1] },
  院系级: { 1: [2, 1.5], 2: [1.5, 1], 3: [1, 0.5] },
};

// L1 社会实践个人
const L_PRACTICE_PERSONAL = { 国家级: 8, 省级: 6, 学校级: 5, 院系级: 3 };
const L_STAR = { 1: 3, 2: 3, 3: 4, 4: 5, 5: 6 };
// L1 集体
const L_PRACTICE_GROUP = { 国家级: { leader: 8, member: 6 }, 省级: { leader: 6, member: 4 }, 学校级: { leader: 4, member: 3 }, 院系级: { leader: 3, member: 2 } };
const L_DORM = { 学校文明宿舍: { leader: 3, member: 2 }, 院系文明宿舍: { leader: 2, member: 1 } };
// L2 扣分
const L_MINUS_ABSENT = { min: 0.5, max: 2 }; // 无故缺席集体劳动/志愿服务（输入 score）
const L_MINUS_DORM = { 学校: { leader: 3, member: 2 }, 院系: { leader: 2, member: 1 } };

const ROUND = (x) => Math.round(x * 1000) / 1000;

// ---------- X：学业成绩积分 ----------
function computeX(courses) {
  let sum = 0;
  let credits = 0;
  const details = [];
  for (const c of courses || []) {
    let s = null;
    if (c.failed || c.retake || c.rework) s = 0;
    else if (typeof c.score === 'number') s = c.score;
    else if (c.level && FIVE_LEVEL_TO_PERCENT[c.level] !== undefined) s = FIVE_LEVEL_TO_PERCENT[c.level];
    else if (c.level && TWO_LEVEL_TO_PERCENT[c.level] !== undefined) s = TWO_LEVEL_TO_PERCENT[c.level];
    details.push({ name: c.name, credits: c.credits, score: s === null ? '缺成绩' : s, note: s === null ? '未提供成绩' : '' });
    if (s === null) continue;
    sum += s * c.credits;
    credits += c.credits;
  }
  return { value: credits ? ROUND(sum / credits) : null, sum, credits, details };
}

// ---------- C1：操行评定基本分 ----------
function computeC1(conduct) {
  if (!conduct) return { value: null, detail: '未提供 conduct' };
  const sources = [
    { key: 'self', weight: 0.1, label: '个人自我测评' },
    { key: 'class', weight: 0.6, label: '班级评议小组' },
    { key: 'advisor', weight: 0.3, label: '班主任（辅导员）' },
  ];
  const parts = [];
  let totalWeight = 0;
  let weighted = 0;
  for (const src of sources) {
    const srcData = conduct[src.key];
    if (!srcData || typeof srcData !== 'object') continue;
    let s = 0;
    const dims = [];
    for (const dim of CONDUCT_DIMENSIONS) {
      const v = Number(srcData[dim]);
      if (!(v >= 0)) continue;
      const max = CONDUCT_DIM_MAX[dim];
      const clamped = Math.min(v, max);
      s += clamped;
      dims.push({ dim, given: v, max, used: clamped });
    }
    parts.push({ source: src.label, weight: src.weight, total: ROUND(s), dims });
    totalWeight += src.weight;
    weighted += src.weight * s;
  }
  const value = totalWeight ? ROUND(weighted / totalWeight) : null;
  return { value, parts, note: 'C1 满分 60 = 自评 10% + 班级评议 60% + 班主任 30%' };
}

// ---------- C2：操行评定加分 ----------
function computeC2(bonus) {
  if (!bonus) return { value: 0, details: [] };
  let deeds = Number(bonus.deeds) || 0;
  let blood = Math.min((Number(bonus.bloodDonations) || 0) * 2.5, 5);
  let group = Number(bonus.groupActivities) || 0;
  const raw = deeds + blood + group;
  const details = [
    { item: '典型事迹', score: deeds, cap: 15 },
    { item: '义务献血', score: blood, cap: 5, rawCount: bonus.bloodDonations || 0 },
    { item: '集体活动', score: group, cap: 20 },
  ];
  return { value: Math.min(raw, 40), details, cap: 40 };
}

// ---------- D：德育 ----------
function d1Of(entry) {
  if (!entry) return 0;
  if (entry.kind === 'group') {
    const t = D1_GROUP[entry.level];
    if (t) return t[entry.role] !== undefined ? t[entry.role] : t.member;
    return 0;
  }
  if (entry.kind === 'personal') {
    // level 匹配 D1_PERSONAL
    const key = `${entry.level}${entry.type ? '' : ''}`;
    if (D1_PERSONAL[key] !== undefined) return D1_PERSONAL[key];
    // 简化匹配：国家级/省级 直接按 level；学校级按 type 区分骨干/团员
    if (entry.level === '国家级') return 15;
    if (entry.level === '省级') return 12;
    if (entry.level === '学校级') return entry.type === '优秀共青团员' ? 5 : 7;
    if (entry.level === '院系级') return 4;
    return 0;
  }
  return 0;
}

function d2Of(entry) {
  if (!entry) return 0;
  if (entry.kind === 'group') {
    const t = D2_GROUP[entry.level];
    return t ? (entry.role === 'leader' ? t.leader : t.member) : 0;
  }
  const t = D2_PERSONAL[entry.type];
  if (t) return entry.count ? t.per * entry.count : t.per;
  return 0;
}

function computeD(virtue) {
  if (!virtue) return { value: 0, d1: 0, d2: 0, details: [] };
  let d1 = 0;
  let d2 = 0;
  const details = [];
  for (const h of virtue.honors || []) {
    const s = d1Of(h);
    d1 += s;
    details.push({ section: 'D1 荣誉', item: `${h.kind} ${h.level || ''} ${h.type || ''}`, score: s });
  }
  d1 = Math.min(d1, 25);
  for (const d of virtue.deductions || []) {
    const s = d2Of(d);
    d2 += s;
    details.push({ section: 'D2 扣分', item: `${d.kind === 'group' ? '集体' : '个人'} ${d.type || d.level || ''}`, score: -s });
  }
  return { value: ROUND(d1 - d2), d1, d2, capD1: 25, details };
}

// ---------- Z：智育 ----------
function contestZ(c) {
  if (c.team === 'group') {
    const t = Z_CONTEST_GROUP[c.level];
    if (t && t[c.rank]) {
      const arr = t[c.rank];
      const roleIdx = c.role === 'leader' ? 0 : c.role === 'main' ? 1 : 2;
      return arr[roleIdx] !== undefined ? arr[roleIdx] : arr[2];
    }
    return 0;
  }
  const t = Z_CONTEST_PERSONAL[c.level];
  if (t) {
    const idx = c.rank === '1' ? 0 : c.rank === '2' ? 1 : 2;
    return t[idx] !== undefined ? t[idx] : 0;
  }
  return 0;
}

function computeZ(intellect) {
  if (!intellect) return { value: 0, details: [] };
  let z = 0;
  const details = [];
  for (const c of intellect.competitions || []) {
    const s = contestZ(c);
    z += s;
    details.push({ section: 'Z 竞赛', item: `${c.team === 'group' ? '集体' : '个人'} ${c.level || ''} 第${c.rank || ''}名`, score: s });
  }
  for (const p of intellect.papers || []) {
    const s = Number(p.score);
    if (!(s >= 0)) {
      const r = Z_PAPER_RANGE[p.tier] && Z_PAPER_RANGE[p.tier][p.author];
      details.push({ section: 'Z 论文', item: `${p.tier || ''} ${p.author || ''}`, score: null, note: '未给 score，院系认定区间 ' + (r ? `${r[0]}-${r[1]}` : '') });
      continue;
    }
    z += s;
    details.push({ section: 'Z 论文', item: `${p.tier || ''} ${p.author || ''}`, score: s });
  }
  return { value: ROUND(z), details };
}

// ---------- T / M / L ----------
function contestT(a) {
  if (a.team === 'group') {
    const t = T_AWARD_GROUP[a.level];
    if (t && t[a.rank]) return a.role === 'main' ? t[a.rank][0] : t[a.rank][1];
    return 0;
  }
  const t = T_AWARD_PERSONAL[a.level];
  if (t) {
    const idx = a.rank === '1' ? 0 : a.rank === '2' ? 1 : 2;
    return t[idx] !== undefined ? t[idx] : 0;
  }
  return 0;
}

function computeT(sports) {
  if (!sports) return { value: 0, details: [] };
  let t = 0;
  const details = [];
  for (const r of sports.records || []) {
    const s = r.team === 'group' ? (T_RECORD_GROUP[r.level] || {}).leader : T_RECORD_PERSONAL[r.level];
    const v = r.team === 'group' ? (r.role === 'member' ? (T_RECORD_GROUP[r.level] || {}).member : (T_RECORD_GROUP[r.level] || {}).leader) : s;
    t += v || 0;
    details.push({ section: 'T 破纪录', item: `${r.team === 'group' ? '集体' : '个人'} ${r.level || ''}`, score: v || 0 });
  }
  for (const a of sports.awards || []) {
    const v = contestT(a);
    t += v;
    details.push({ section: 'T 竞赛', item: `${a.team === 'group' ? '集体' : '个人'} ${a.level || ''} 第${a.rank || ''}名`, score: v });
  }
  return { value: Math.min(t, 15), details, cap: 15 };
}

function contestM(c) {
  if (c.team === 'group') {
    const t = M_CONTEST_GROUP[c.level];
    if (t && t[c.rank]) return c.role === 'main' ? t[c.rank][0] : t[c.rank][1];
    return 0;
  }
  const t = M_CONTEST_PERSONAL[c.level];
  if (t) {
    const idx = c.rank === '1' ? 0 : c.rank === '2' ? 1 : 2;
    return t[idx] !== undefined ? t[idx] : 0;
  }
  return 0;
}

function computeM(arts) {
  if (!arts) return { value: 0, details: [] };
  let m = 0;
  const details = [];
  for (const w of arts.works || []) {
    const pair = M_WORK[w.level];
    const v = pair ? (w.team === 'group' ? (w.role === 'first' ? pair[0] : pair[1]) : pair[0]) : 0;
    m += v;
    details.push({ section: 'M 作品', item: `${w.team === 'group' ? '集体' : '个人'} ${w.level || ''}`, score: v });
  }
  for (const c of arts.competitions || []) {
    const v = contestM(c);
    m += v;
    details.push({ section: 'M 竞赛', item: `${c.team === 'group' ? '集体' : '个人'} ${c.level || ''} 第${c.rank || ''}名`, score: v });
  }
  return { value: Math.min(m, 15), details, cap: 15 };
}

function computeL(labor) {
  if (!labor) return { value: 0, details: [] };
  let l1 = 0;
  let l2 = 0;
  const details = [];
  for (const p of labor.plus || []) {
    let v = 0;
    if (p.type === 'star') v = L_STAR[p.stars] || 0;
    else if (p.type === 'practice') v = p.role === 'group' || p.role === 'member' || p.role === 'leader'
      ? (p.role === 'leader' ? (L_PRACTICE_GROUP[p.level] || {}).leader : (L_PRACTICE_GROUP[p.level] || {}).member)
      : L_PRACTICE_PERSONAL[p.level];
    else if (p.type === 'dorm') v = (L_DORM[p.level] || {})[p.role || 'member'];
    l1 += v || 0;
    details.push({ section: 'L1 加分', item: `${p.type || ''} ${p.level || ''}`, score: v || 0 });
  }
  for (const m2 of labor.minus || []) {
    let v = 0;
    if (m2.type === 'absent') v = Number(m2.score) || 1;
    else if (m2.type === 'dorm') v = (L_MINUS_DORM[m2.level] || {})[m2.role === 'leader' ? 'leader' : 'member'];
    l2 += v;
    details.push({ section: 'L2 扣分', item: `${m2.type || ''} ${m2.level || ''}`, score: -v });
  }
  return { value: ROUND(Math.min(l1, 15) - l2), l1: Math.min(l1, 15), l2, capL1: 15, details };
}

// ---------- 汇总 ----------
function computeAll(data) {
  const X = computeX(data.courses);
  const C1 = computeC1(data.conduct);
  const C2 = computeC2(data.conductBonus);
  const C = { value: C1.value === null ? null : ROUND(C1.value + C2.value), c1: C1.value, c2: C2.value };
  const D = computeD(data.virtue);
  const Z = computeZ(data.intellect);
  const T = computeT(data.sports);
  const M = computeM(data.arts);
  const L = computeL(data.labor);
  const S = { value: ROUND(D.value + 3 * Z.value + T.value + M.value + L.value), d: D.value, z: Z.value, t: T.value, m: M.value, l: L.value };
  const H = X.value === null || C.value === null
    ? null
    : ROUND(0.7 * X.value + 0.1 * C.value + 0.2 * S.value);
  return {
    X, C1, C2, C, D, Z, T, M, L, S, H,
    thresholds: {
      bodyTest75: '体测 75 分及以上方可参评各类奖学金',
      bodyTest80: '体测 80 分及以上方可参评荣誉称号',
      noFailFirst: '本学年必修课程首次考试无不及格',
      national: '国家奖学金：综测前 10% + 学业前 10%',
      liZhi: '励志奖学金：综测前 50% + 学业前 50% + 家庭经济困难',
      school1: '校一等：综测前 10% + 学业前 15%',
      school2: '校二等：综测前 20% + 学业前 25%',
      school3: '校三等：综测前 33% + 学业前 38%',
    },
    disclaimer: '依据《2026 年本科生手册》综合测评办法口径计算；具体加分以院（系）实施细则为准。',
  };
}

// ---------- 主入口 ----------
function run() {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) return selfCheck();
  const idx = args.indexOf('--input');
  if (idx < 0) {
    console.error('用法：node conduct-calculator.js --input <文件.json> | --self-check');
    process.exit(2);
  }
  const file = args[idx + 1];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`无法读取或解析 ${file}: ${e.message}`);
    process.exit(2);
  }
  console.log(JSON.stringify(computeAll(data), null, 2));
}

// ---------- 自检（固定虚构样例） ----------
function selfCheck() {
  const results = [];
  function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  const sample = {
    courses: [
      { name: '高数', credits: 5, score: 90 },
      { name: '英语', credits: 3, score: 80 },
      { name: '思政', credits: 2, level: '良好' },   // 85
      { name: '体育', credits: 1, score: 95 },
      { name: '挂科重考课', credits: 2, score: 88, retake: true }, // →0
    ],
    conduct: {
      self: { 政治信仰: 8, 践行社会主义核心价值观: 8, 遵纪守法: 6, 维护社会公德: 6, 实践服务: 6, 学习态度: 6, 身心健康: 6, 文化素养: 6, 卫生文明: 4, 勤俭劳动: 4 },
      class: { 政治信仰: 7, 践行社会主义核心价值观: 7, 遵纪守法: 5, 维护社会公德: 5, 实践服务: 5, 学习态度: 5, 身心健康: 5, 文化素养: 5, 卫生文明: 3, 勤俭劳动: 3 },
      advisor: { 政治信仰: 7, 践行社会主义核心价值观: 7, 遵纪守法: 5, 维护社会公德: 5, 实践服务: 5, 学习态度: 5, 身心健康: 5, 文化素养: 5, 卫生文明: 3, 勤俭劳动: 3 },
    },
    conductBonus: { deeds: 8, bloodDonations: 2, groupActivities: 12 },
    virtue: {
      honors: [{ kind: 'personal', level: '省级' }],
      deductions: [{ kind: 'personal', type: '旷课', count: 2 }],
    },
    intellect: {
      competitions: [{ team: 'personal', level: '国家级', rank: '2' }], // 5
      papers: [{ tier: '高水平', author: 'first', score: 5 }],
    },
    sports: { records: [], awards: [{ team: 'personal', level: '学校级', rank: '1' }] }, // 3
    arts: { works: [], competitions: [{ team: 'personal', level: '院系级', rank: '1' }] }, // 2
    labor: { plus: [{ type: 'star', stars: 3 }], minus: [{ type: 'absent', score: 1 }] }, // 4-1=3
  };

  const out = computeAll(sample);

  // X = (90*5+80*3+85*2+95*1+0*2)/13 = (450+240+170+95)/13 = 955/13 = 73.4615
  check('X 学业成绩积分', Math.abs(out.X.value - 73.4615) < 0.001, `X=${out.X.value}`);
  // C1：self=60, class=50, advisor=50 → 0.1*60+0.6*50+0.3*50 = 6+30+15 = 51
  check('C1 操行基本分', out.C1.value === 51, `C1=${out.C1.value}`);
  // C2：8 + min(2*2.5,5)=5 + 12 = 25
  check('C2 操行加分', out.C2.value === 25, `C2=${out.C2.value}`);
  check('C = C1+C2', out.C.value === 76, `C=${out.C.value}`);
  // D = min(12,25) - 2 = 10
  check('D 德育', out.D.value === 10, `D=${out.D.value}`);
  // Z = 5 + 5 = 10
  check('Z 智育', out.Z.value === 10, `Z=${out.Z.value}`);
  // T=3, M=2, L=4-1=3
  check('T 体育', out.T.value === 3, `T=${out.T.value}`);
  check('M 美育', out.M.value === 2, `M=${out.M.value}`);
  check('L 劳育', out.L.value === 3, `L=${out.L.value}`);
  // S = 10 + 3*10 + 3 + 2 + 3 = 48
  check('S 综合素养', out.S.value === 48, `S=${out.S.value}`);
  // H = 0.7*73.4615 + 0.1*76 + 0.2*48 = 51.4231 + 7.6 + 9.6 = 68.6231
  check('H 综合测评总积分', Math.abs(out.H - 68.6231) < 0.001, `H=${out.H}`);
  check('C2 献血封顶 5', out.C2.details.find((d) => d.item === '义务献血').score === 5, '献血=5');
  check('D1 封顶 25', out.D.d1 === 12, `d1=${out.D.d1}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nCONDUCT_CALCULATOR_SELF_CHECK: ${failed.length ? `FAIL ${failed.length}/${results.length}` : `PASS ${results.length}/${results.length}`}`);
  return failed.length ? 1 : 0;
}

if (require.main === module) {
  const code = run();
  process.exitCode = code || 0;
}

module.exports = { computeX, computeC1, computeC2, computeD, computeZ, computeT, computeM, computeL, computeAll };
