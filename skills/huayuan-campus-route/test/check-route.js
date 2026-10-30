#!/usr/bin/env node
'use strict';

/**
 * 华园一日路线 · 离线回归
 *
 * 运行：node skills/huayuan-campus-route/test/check-route.js
 * 不联网、不登录、不依赖浏览器；样例课表全部虚构。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('../scripts/route-engine.js');
const DATA = require('../data/campus-data.js');
const T = require('../scripts/timetable-import.js');
const TP = require('../scripts/task-planner.js');
const EXAMS = require('../data/exam-catalog.js');
const REAL_SHAPE = require('./fixtures/jw-university-town.json');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`not ok ${passed + failures.length} - ${name}`);
    console.error(`  ${error.message}`);
  }
}

function minutes(value) {
  return R.parseTime(value);
}

const base = R.planDay({ date: '2026-10-29', preset: 'balanced' });

check('POI 数据完整，且每个 POI 都能接入步行图', () => {
  assert.ok(DATA.POIS.length >= 14);
  const nodeIds = new Set([...DATA.POIS, ...DATA.WALK_NODES].map((n) => n.id));
  for (const [a, b] of DATA.WALK_EDGES) {
    assert.ok(nodeIds.has(a), `边起点不存在：${a}`);
    assert.ok(nodeIds.has(b), `边终点不存在：${b}`);
  }
  for (const poi of DATA.POIS) {
    assert.ok(DATA.WALK_EDGES.some(([a, b]) => a === poi.id || b === poi.id), `${poi.id} 没有接入步行图`);
  }
});

check('校园楼栋目录包含教学区、学院楼和公共设施，并可按字段搜索', () => {
  assert.ok(DATA.LOCATIONS.length >= 75, `地点只有 ${DATA.LOCATIONS.length} 个`);
  const names = DATA.LOCATIONS.map((item) => item.name).join(' ');
  for (const keyword of ['A1 教学楼', 'A6 教学楼', 'B3 计算机学院', 'B7 软件学院', 'T1 礼堂', '图书馆', 'C11 宿舍', 'C17 宿舍', 'D5 宿舍', 'G17 宿舍', 'E3 学生宿舍']) {
    assert.ok(names.includes(keyword), `缺少 ${keyword}`);
  }
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /locationSearchText/);
  assert.match(app, /\.includes\(target\)/);
});

check('从楼栋目录选择起点后，路线使用所选楼栋名称', () => {
  const location = DATA.LOCATIONS.find((item) => item.id === 'b7');
  const plan = R.planDay({
    date: '2026-10-29',
    gps: {
      lat: location.lat,
      lng: location.lng,
      coord: location.coord,
      simulated: true,
      label: location.name,
    },
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.gps.label, 'B7 软件学院');
  assert.ok(plan.blocks.some((block) => block.title === '从B7 软件学院出发'));
});

check('教务课表导入：识别大学城、课程数和当前教学周', () => {
  const result = T.summarizeTimetable(DATA.DEMO_TIMETABLE, { date: '2026-10-29' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.campus.key, 'university_town');
  assert.strictEqual(result.summary.total, 6);
  assert.strictEqual(result.summary.usable, 6);
  assert.strictEqual(result.week_number, 9);
  assert.strictEqual(T.weekNumberForDate(DATA.DEMO_TIMETABLE, '2026-11-02'), 10);
});

check('教务课表导入：五山课表被拒绝，不硬套大学城', () => {
  const result = T.summarizeTimetable(require('../../../golden-path/fixtures/jw-timetable.json'), { date: '2026-10-29' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'CAMPUS_UNSUPPORTED');
});

check('教务课表导入：真实大学城结构不被“广州国际校区”参考标签误伤', () => {
  const result = T.summarizeTimetable(REAL_SHAPE, { date: '2026-10-30' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.campus.key, 'university_town');
  assert.strictEqual(result.summary.total, 3);
});

check('真实大学城课表能生成完整路线，且晚餐前保留有效通勤', () => {
  const plan = R.planDay({ date: '2026-10-30', timetable: REAL_SHAPE, weekNumber: 10, preset: 'balanced' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.validation.ok, true, plan.validation.issues.join('；'));
  assert.deepStrictEqual(
    plan.blocks.filter((block) => block.type === 'class').map((block) => block.title),
    ['高级语言程序设计(C++)(上)', '学术英语（一）', '习近平新时代中国特色社会主义思想概论']
  );
  assert.ok(
    plan.blocks.filter((block) => block.type === 'walk').every((block) => block.duration_min >= 1),
    '不应生成 0 分钟步行块'
  );
  const dinner = plan.blocks.find((block) => block.title.startsWith('晚餐'));
  const dinnerWalk = plan.blocks.find(
    (block) => block.type === 'walk' && dinner && block.end <= dinner.start
  );
  assert.ok(dinner, '真实课表日应保留晚餐');
  assert.ok(dinnerWalk, '晚餐前应有通勤块');
});

check('教务课表导入：坏 JSON / 空课程有明确错误', () => {
  const badJson = T.parseTimetableText('{not json');
  assert.strictEqual(badJson.ok, false);
  assert.strictEqual(badJson.error, 'INVALID_JSON');
  const empty = T.summarizeTimetable({ campus: { key: 'university_town' }, courses: [] });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.error, 'NO_COURSES');
});

check('教务课表导入：缺校区时保留警告，允许继续但提示确认', () => {
  const result = T.summarizeTimetable(
    {
      courses: [{ course: '样例课', weekday: 4, start_time: '08:50', end_time: '10:25', classroom: 'A1-101' }],
    },
    { date: '2026-10-29' }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.campus.key, 'unknown');
  assert.ok(result.warnings.some((w) => w.includes('没写校区')));
});

check('专业写入日程元数据，但不影响课程时间', () => {
  const plan = R.planDay({ date: '2026-10-29', major: '软件工程' });
  assert.strictEqual(plan.meta.major, '软件工程');
  const classes = plan.blocks.filter((b) => b.type === 'class');
  assert.deepStrictEqual(classes.map((b) => `${b.start}-${b.end}`), ['08:50-10:25', '10:40-12:15', '14:00-15:35']);
});

check('专业写入偏好文件，能出现在偏好描述里', () => {
  const P = require('../../huayuan-browser-session/scripts/preferences.js');
  const { preferences } = P.normalizePreferences({ major: '软件工程' });
  assert.strictEqual(preferences.major, '软件工程');
  assert.ok(P.describePreferences(preferences).some((line) => line.includes('专业：软件工程')));
});

check('考试按专业筛选，并按 T-14/T-7/T-3/T-1 拆复习任务', () => {
  const planned = TP.planExamTasks(EXAMS.DEMO_EXAMS.exams, { major: '软件工程', now: '2026-10-29' });
  assert.ok(planned.exams.length >= 2);
  assert.ok(planned.tasks.length >= 4);
  assert.ok(planned.tasks.every((task) => task.source === 'exam' && task.id.startsWith('exam:')));
  assert.ok(planned.tasks.some((task) => task.due === '2026-10-30T21:00'));
  assert.ok(planned.tasks.some((task) => task.priority === 'P0'));
  const otherMajor = TP.planExamTasks(EXAMS.DEMO_EXAMS.exams, { major: '建筑学', now: '2026-10-29' });
  assert.ok(otherMajor.exams.length < planned.exams.length);
});

check('手动待办会去重、排序，并写进路线自习块', () => {
  const manual = TP.normalizeManualTasks([
    { id: 'm1', title: '交实验报告', due: '2026-10-30T23:59', priority: 'P0', estimated_minutes: 60 },
    { id: 'm1', title: '重复项', due: '2026-10-30T23:59', priority: 'P0', estimated_minutes: 60 },
  ]);
  assert.strictEqual(manual.length, 2);
  const merged = TP.mergeTasks([], manual);
  assert.strictEqual(merged.length, 1);
  const plan = R.planDay({ date: '2026-10-29', tasks: merged });
  const taskBlocks = plan.blocks.filter((block) => block.task);
  assert.ok(taskBlocks.length >= 1);
  assert.ok(taskBlocks.every((block) => block.task.title === '交实验报告'));
  assert.ok(plan.summary.task_minutes > 0);
});

check('任务状态能区分今天/逾期/正常', () => {
  const tasks = [
    { id: 'a', title: '今天', due: '2026-10-29T23:59', estimated_minutes: 30 },
    { id: 'b', title: '逾期', due: '2026-10-28T21:00', estimated_minutes: 30 },
    { id: 'c', title: '以后', due: '2026-11-05T21:00', estimated_minutes: 30 },
  ];
  assert.strictEqual(TP.taskStatus(tasks[0], '2026-10-29T12:00').key, 'today');
  assert.strictEqual(TP.taskStatus(tasks[1], '2026-10-29T12:00').key, 'overdue');
  assert.strictEqual(TP.taskStatus(tasks[2], '2026-10-29T12:00').key, 'later');
  assert.strictEqual(TP.summarizeTasks(tasks, '2026-10-29T12:00').today, 1);
});

check('周四样例生成 3 节课，且课程时间原样保留', () => {
  assert.strictEqual(base.ok, true);
  const classes = base.blocks.filter((b) => b.type === 'class');
  assert.strictEqual(classes.length, 3);
  assert.deepStrictEqual(classes.map((b) => `${b.start}-${b.end}`), ['08:50-10:25', '10:40-12:15', '14:00-15:35']);
});

check('时间轴严格有序且没有重叠', () => {
  for (let i = 1; i < base.blocks.length; i += 1) {
    assert.ok(base.blocks[i].start_min >= base.blocks[i - 1].start_min, '时间没有递增');
    assert.ok(base.blocks[i - 1].end_min <= base.blocks[i].start_min + 0.01, `${base.blocks[i - 1].title} 与 ${base.blocks[i].title} 重叠`);
  }
});

check('洗澡落在热水 17:00–24:00 内，并在门禁前回到宿舍', () => {
  const shower = base.blocks.find((b) => b.type === 'shower');
  assert.ok(shower);
  assert.ok(shower.start_min >= 17 * 60, '洗澡早于热水开始');
  assert.ok(shower.end_min <= 24 * 60, '洗澡晚于热水结束');
  assert.strictEqual(shower.poi_id, 'c11');
  assert.ok(shower.end_min <= 23 * 60, '洗澡结束晚于工作日门禁');
});

check('步行路线至少包含 10 个点，总距离与时间都大于 0', () => {
  assert.ok(base.route.points.length >= 10);
  assert.ok(base.summary.walk_meters > 1000);
  assert.ok(base.summary.walk_minutes > 20);
});

check('路线覆盖课程、自习、运动、放松、用餐五类地点', () => {
  const types = new Set(base.blocks.map((b) => b.type));
  for (const type of ['class', 'study', 'sport', 'play', 'meal']) assert.ok(types.has(type), `缺少 ${type}`);
});

check('卷王画像的自习时间多于玩咖，运动画像的运动时间多于均衡', () => {
  const grind = R.planDay({ date: '2026-10-29', preset: 'grind' });
  const play = R.planDay({ date: '2026-10-29', preset: 'play' });
  const sport = R.planDay({ date: '2026-10-29', preset: 'sport' });
  assert.ok(grind.summary.study_minutes > play.summary.study_minutes, '卷王自习没有更多');
  assert.ok(sport.summary.sport_minutes > base.summary.sport_minutes, '运动画像运动没有更多');
  assert.ok(play.summary.play_minutes > grind.summary.play_minutes, '玩咖放松没有更多');
});

check('周六没有课，仍会排自习、运动和放松', () => {
  const weekend = R.planDay({ date: '2026-10-31', preset: 'balanced' });
  assert.strictEqual(weekend.blocks.filter((b) => b.type === 'class').length, 0);
  assert.ok(weekend.summary.study_minutes >= 60);
  assert.ok(weekend.summary.sport_minutes >= 20);
  assert.ok(weekend.summary.play_minutes >= 20);
});

check('GPS 定位在图书馆时，起点被识别为图书馆', () => {
  const plan = R.planDay({
    date: '2026-10-29',
    preset: 'balanced',
    gps: { lat: 23.046927, lng: 113.405395, coord: 'gcj02' },
  });
  assert.strictEqual(plan.gps.in_campus, true);
  assert.strictEqual(plan.gps.nearest_poi, 'library');
  assert.ok(plan.blocks.some((b) => b.type === 'place' && b.poi_id === 'library'));
});

check('00:00 睡觉按当天 24:00 封口，不从零点出发也不产生重叠', () => {
  const c10 = DATA.LOCATIONS.find((item) => item.id === 'c10');
  const plan = R.planDay({
    date: '2026-10-30',
    preset: 'balanced',
    preferences: { daily: { wake: '07:00', sleep: '00:00' } },
    gps: {
      lat: c10.lat,
      lng: c10.lng,
      coord: c10.coord,
      simulated: true,
      label: c10.name,
    },
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.validation.ok, true, plan.validation.issues.join('；'));
  assert.ok(plan.blocks.every((block) => block.start_min >= 7 * 60), '不应出现 00:00 块');
  assert.ok(plan.blocks.some((block) => block.title === '从C10 宿舍出发'));
  assert.ok(!plan.blocks.some((block) => block.type === 'sleep' && block.start === '00:00'));
  assert.ok(plan.warnings.some((warning) => warning.includes('按 24:00 封口')));
});

check('次日凌晨睡觉同样封口到 24:00，不把凌晨时间排到时间轴开头', () => {
  const plan = R.planDay({
    date: '2026-10-30',
    preferences: { daily: { wake: '07:00', sleep: '01:30' } },
  });
  assert.strictEqual(plan.validation.ok, true, plan.validation.issues.join('；'));
  assert.ok(plan.blocks.every((block) => block.start_min >= 7 * 60));
  assert.strictEqual(plan.blocks.find((block) => block.type === 'sleep'), undefined);
});

check('GPS 在校外时给出提示，并回退到 C11 出发', () => {
  const plan = R.planDay({
    date: '2026-10-29',
    preset: 'balanced',
    gps: { lat: 23.13, lng: 113.32, coord: 'wgs84' },
  });
  assert.strictEqual(plan.gps.in_campus, false);
  assert.ok(plan.warnings.some((w) => w.includes('定位不在大学城校区')));
  assert.strictEqual(plan.meta.start_poi, 'c11');
});

check('WGS-84 会换算成 GCJ-02，且结果落在校园附近', () => {
  const converted = R.wgs84ToGcj02(23.0444, 113.4002);
  assert.ok(Math.abs(converted.lat - 23.0444) < 0.01);
  assert.ok(Math.abs(converted.lng - 113.4002) < 0.01);
  assert.notStrictEqual(converted.lat, 23.0444);
});

check('雨天走路时间变长，骑行时间变短', () => {
  const rain = R.planDay({ date: '2026-10-29', preset: 'balanced', rain: true });
  const bike = R.planDay({ date: '2026-10-29', preset: 'balanced', mode: 'bike' });
  assert.ok(rain.summary.walk_minutes > base.summary.walk_minutes, '雨天没有变慢');
  assert.ok(bike.summary.walk_minutes < base.summary.walk_minutes, '骑行没有变快');
});

check('雨天把运动改到体育馆，并给出带伞提醒', () => {
  const rain = R.planDay({ date: '2026-10-29', preset: 'balanced', weather: { condition: 'rain', temperature: 23 } });
  const sport = rain.blocks.find((b) => b.type === 'sport');
  assert.ok(sport, '雨天没有安排运动');
  assert.strictEqual(sport.poi_id, 'gym');
  assert.ok(rain.meta.weather.is_wet);
  assert.ok(rain.meta.weather_advice.some((item) => item.includes('带伞')));
  assert.ok(rain.summary.walk_minutes > base.summary.walk_minutes);
});

check('大雨取消露天活动，运动仍在室内', () => {
  const storm = R.planDay({ date: '2026-10-29', preset: 'balanced', weather: { condition: 'storm', temperature: 22 } });
  const sport = storm.blocks.find((b) => b.type === 'sport');
  if (sport) assert.strictEqual(sport.poi_id, 'gym');
  assert.ok(storm.meta.weather.is_severe);
  assert.ok(storm.meta.weather_advice.some((item) => item.includes('雷雨')));
});

check('高温和污染天不排白天露天跑步，并给出对应提醒', () => {
  const heat = R.planDay({ date: '2026-10-29', preset: 'sport', weather: { condition: 'clear', temperature: 35 } });
  const heatSports = heat.blocks.filter((b) => b.type === 'sport');
  assert.ok(heatSports.length);
  for (const block of heatSports) {
    if (block.start_min < 19 * 60 + 30) assert.strictEqual(block.poi_id, 'gym');
  }
  assert.ok(heat.meta.weather.is_hot);
  assert.ok(heat.meta.weather_advice.some((item) => item.includes('高温')));

  const polluted = R.planDay({ date: '2026-10-29', preset: 'sport', weather: { condition: 'polluted', temperature: 24, aqi: 180 } });
  const pollutedSports = polluted.blocks.filter((b) => b.type === 'sport');
  assert.ok(pollutedSports.length);
  for (const block of pollutedSports) assert.strictEqual(block.poi_id, 'gym');
  assert.ok(polluted.meta.weather.is_polluted);
  assert.ok(polluted.meta.weather_advice.some((item) => item.includes('口罩')));
});

check('天气写进 Markdown，不把估算说成实时', () => {
  const md = R.buildMarkdown(R.planDay({ date: '2026-10-29', weather: { condition: 'rain', temperature: 23 } }));
  assert.ok(md.includes('## 天气'));
  assert.ok(md.includes('小雨'));
  assert.ok(md.includes('手动选择/估算'));
});

check('图书馆开放时间：07:00 未开，12:00 开放', () => {
  const library = R.poi('library');
  assert.strictEqual(R.openState(library, 4, minutes('07:00')).open, false);
  assert.strictEqual(R.openState(library, 4, minutes('12:00')).open, true);
});

check('咖啡厅并到图书馆，不在同一栋楼出现第二个编号', () => {
  const plan = R.planDay({ date: '2026-10-29', preset: 'balanced' });
  const libraryStops = plan.stops.filter((s) => s.poiId === 'library');
  assert.ok(libraryStops.length >= 1);
  assert.strictEqual(plan.stops.filter((s) => s.poiId === 'cafe').length, 0);
});

check('五山课表会被明确拒绝，不会硬套大学城教室', () => {
  const plan = R.planDay({
    date: '2026-10-29',
    timetable: { campus: { key: 'wushan', label: '五山校区' }, courses: [] },
  });
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.error, 'CAMPUS_UNSUPPORTED');
});

check('未知教室会标待确认，并按 A3 保守估算', () => {
  const plan = R.planDay({
    date: '2026-10-29',
    timetable: {
      campus: { key: 'university_town', label: '大学城校区' },
      courses: [{ course: '样例课', weekday: 4, start_time: '08:50', end_time: '10:25', classroom: 'B9-101' }],
    },
  });
  assert.ok(plan.warnings.some((w) => w.includes('未识别')));
  assert.strictEqual(plan.blocks.find((b) => b.type === 'class').poi_id, 'a3');
});

check('Markdown 导出包含日期、时间轴、热水与依据', () => {
  const md = R.buildMarkdown(base);
  assert.ok(md.includes('2026-10-29'));
  assert.ok(md.includes('## 时间轴'));
  assert.ok(md.includes('热水'));
  assert.ok(md.includes('图书馆'));
  assert.ok(md.length > 800);
});

check('一天内所有可移动块都在 07:00–24:00 之间', () => {
  for (const b of base.blocks) {
    assert.ok(b.start_min >= 7 * 60, `${b.title} 开始过早`);
    assert.ok(b.end_min <= 24 * 60, `${b.title} 结束过晚`);
  }
});

check('命令行默认不静默使用示例课表', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-route-noarg-'));
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'scripts', 'day-route.js'),
      '--date',
      '2026-10-30',
      '--output-dir',
      path.join(dir, 'out'),
    ],
    {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, HUAYUAN_ROUTE_SEARCH_ROOT: dir },
    }
  );
  assert.strictEqual(result.status, 4, result.stderr);
  assert.match(result.stderr, /NO_TIMETABLE/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'out', 'day-route.json')), false);
});

check('命令行无参数可自动发现真实课表并完成校验', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-route-auto-'));
  fs.writeFileSync(path.join(dir, 'jw-timetable.json'), JSON.stringify(REAL_SHAPE), 'utf8');
  const outDir = path.join(dir, 'out');
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'day-route.js'), '--date', '2026-10-30', '--output-dir', outDir],
    {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, HUAYUAN_ROUTE_SEARCH_ROOT: dir },
    }
  );
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(fs.readFileSync(path.join(outDir, 'day-route.json'), 'utf8'));
  assert.strictEqual(output.validation.ok, true);
  assert.ok(output.blocks.some((block) => block.type === 'class'));
});

check('路线页面默认日期使用当天，不再写死演示日期', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(app, /date:\s*todayIso\(\)/);
  assert.doesNotMatch(app, /date:\s*'2026-10-29'/);
  assert.doesNotMatch(html, /value="2026-10-29"/);
});

console.log('');
if (failures.length) {
  console.error(`ROUTE_CHECK:FAIL ${passed}/${passed + failures.length}`);
  process.exitCode = 1;
} else {
  console.log(`ROUTE_CHECK:PASS ${passed}/${passed}`);
}
