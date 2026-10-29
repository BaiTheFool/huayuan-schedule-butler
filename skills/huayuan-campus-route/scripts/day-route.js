#!/usr/bin/env node
'use strict';

/**
 * 华园一日路线 · 命令行入口
 *
 * 用法：
 *   node day-route.js --demo
 *   node day-route.js --date 2026-10-29 --preset balanced
 *   node day-route.js --timetable ..\huayuan-output\2026...\jw-timetable.json --preferences ...\preferences.json
 *   node day-route.js --demo --preset sport --rain --traffic peak --mode bike
 *   node day-route.js --demo --gps 23.0469,113.4054,wgs84
 *
 * 产物：day-route.json / day-route.md（默认写到 huayuan-output/route-<日期>-<时间>/）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('./route-engine.js');
const taskPlanner = require('./task-planner.js');
const DATA = require('../data/campus-data.js');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return true;
  return value;
}

function has(name) {
  return process.argv.includes(name);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function findLatestTimetable(startDir) {
  const roots = [path.join(startDir, 'huayuan-output'), path.join(process.cwd(), 'huayuan-output')];
  let best = null;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const candidate = path.join(root, name, 'jw-timetable.json');
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.statSync(candidate);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file: candidate, mtimeMs: stat.mtimeMs };
    }
  }
  return best ? best.file : null;
}

function defaultPreferencesPath() {
  const home = process.env.HUAYUAN_HOME || path.join(os.homedir(), '.workbuddy', 'huayuan-schedule-butler');
  const file = path.join(home, 'preferences.json');
  return fs.existsSync(file) ? file : null;
}

function parseGps(text) {
  if (!text || text === true) return null;
  const parts = String(text).split(',');
  if (parts.length < 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, coord: (parts[2] || 'wgs84').toLowerCase() };
}

function main() {
  const demo = has('--demo') || !has('--timetable');
  const date = arg('--date', null);
  const preset = arg('--preset', 'balanced');
  const mode = arg('--mode', 'walk');
  const rain = has('--rain');
  const avoidCrowd = has('--avoid-crowd');
  const traffic = arg('--traffic', 'auto');
  const weekNumber = arg('--week', null);
  const startPoiId = arg('--start', null);
  const dormPoiId = arg('--dorm', null);
  const major = arg('--major', null);
  const gps = parseGps(arg('--gps', null));
  const outDirArg = arg('--output-dir', null);

  let weather = null;
  const weatherJson = arg('--weather-json', null);
  const weatherCondition = arg('--weather', null);
  const tempArg = arg('--temp', null);
  const precipArg = arg('--precip', null);
  const aqiArg = arg('--aqi', null);
  if (weatherJson && weatherJson !== true) {
    try {
      weather = readJson(String(weatherJson));
    } catch (error) {
      console.error(`WEATHER_READ_FAILED: ${weatherJson}（${error.message}）`);
    }
  }
  if (!weather && (weatherCondition || rain)) {
    weather = {
      condition: weatherCondition && weatherCondition !== true ? String(weatherCondition) : 'rain',
      source: 'manual',
    };
    if (tempArg !== null && tempArg !== true && Number.isFinite(Number(tempArg))) weather.temperature = Number(tempArg);
    if (precipArg !== null && precipArg !== true && Number.isFinite(Number(precipArg))) weather.precipitation = Number(precipArg);
    if (aqiArg !== null && aqiArg !== true && Number.isFinite(Number(aqiArg))) weather.aqi = Number(aqiArg);
  }

  let timetable = DATA.DEMO_TIMETABLE;
  let timetableSource = 'demo';
  let preferences = null;
  let preferencesSource = 'defaults';

  if (!demo) {
    const file = arg('--timetable', null) || findLatestTimetable(process.cwd());
    if (!file) {
      console.error('NO_TIMETABLE: 没找到 jw-timetable.json，请用 --timetable 指定，或直接 --demo');
      process.exitCode = 4;
      return;
    }
    timetable = readJson(file);
    timetableSource = file;
  }

  const prefArg = arg('--preferences', null) || defaultPreferencesPath();
  if (prefArg) {
    try {
      preferences = readJson(prefArg);
      preferencesSource = prefArg;
    } catch (error) {
      console.error(`PREFERENCES_READ_FAILED: ${prefArg}（${error.message}）`);
    }
  }

  // 显式权重优先于画像
  const weights = {};
  for (const key of ['study', 'play', 'sport']) {
    const value = arg(`--${key}`, null);
    if (value !== null && value !== true && Number.isFinite(Number(value))) weights[key] = Number(value);
  }

  // 考试 → 复习任务；手动待办 → 直接合并
  const majorValue = major && major !== true ? String(major).trim() : (preferences && preferences.major) || '';
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const nowLocal = `${todayIso}T${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
  const dateForTasks = date || todayIso;
  const nowForTasks = !date || date === todayIso ? nowLocal : dateForTasks;
  let examTasks = [];
  let manualTasks = [];
  const examsArg = arg('--exams', null);
  if (examsArg && examsArg !== true) {
    try {
      const rawExams = readJson(String(examsArg));
      const exams = Array.isArray(rawExams) ? rawExams : rawExams.exams || [];
      const planned = taskPlanner.planExamTasks(exams, { major: majorValue, now: nowForTasks });
      examTasks = planned.tasks;
      for (const warning of planned.warnings) console.error(`EXAMS_NOTE: ${warning}`);
    } catch (error) {
      console.error(`EXAMS_READ_FAILED: ${examsArg}（${error.message}）`);
    }
  }
  const tasksArg = arg('--tasks', null);
  if (tasksArg && tasksArg !== true) {
    try {
      const rawTasks = readJson(String(tasksArg));
      manualTasks = taskPlanner.normalizeManualTasks(Array.isArray(rawTasks) ? rawTasks : rawTasks.tasks || []);
    } catch (error) {
      console.error(`TASKS_READ_FAILED: ${tasksArg}（${error.message}）`);
    }
  }
  const planningTasks = taskPlanner.mergeTasks(examTasks, manualTasks);

  const plan = engine.planDay({
    date: date || undefined,
    timetable,
    preferences,
    preset,
    weights: Object.keys(weights).length ? weights : undefined,
    mode,
    rain,
    weather,
    avoidCrowd,
    traffic,
    weekNumber: weekNumber ? Number(weekNumber) : null,
    startPoiId: startPoiId || undefined,
    dormPoiId: dormPoiId || undefined,
    major: majorValue || undefined,
    tasks: planningTasks,
    gps,
  });

  if (!plan.ok) {
    console.error(`${plan.error}: ${plan.message}`);
    process.exitCode = 2;
    return;
  }

  const baseDir = outDirArg
    ? path.resolve(String(outDirArg))
    : path.join(process.cwd(), 'huayuan-output', `route-${plan.meta.date}-${timestamp()}`);
  fs.mkdirSync(baseDir, { recursive: true });

  const jsonPath = path.join(baseDir, 'day-route.json');
  const mdPath = path.join(baseDir, 'day-route.md');
  const payload = {
    ...plan,
    source: {
      timetable: timetableSource,
      preferences: preferencesSource,
      generated_by: 'skills/huayuan-campus-route/scripts/day-route.js',
    },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(mdPath, engine.buildMarkdown(plan), 'utf8');

  console.log(`DAY_ROUTE_OK:${jsonPath}`);
  console.log(`DAY_ROUTE_MD:${mdPath}`);
  console.log(
    `SUMMARY: ${plan.meta.date} ${plan.meta.day_name} · ${plan.meta.preset_name} · ${plan.meta.weather.icon} ${plan.meta.weather.label} ${plan.meta.weather.temperature}°C · ${plan.summary.stops} 站 · 步行 ${plan.summary.walk_meters} m / ${plan.summary.walk_minutes} 分钟 · 自习 ${plan.summary.study_minutes} 分钟 · 运动 ${plan.summary.sport_minutes} 分钟 · 放松 ${plan.summary.play_minutes} 分钟 · 任务 ${plan.summary.task_minutes || 0} 分钟`
  );
  if (plan.warnings.length) {
    console.log(`WARNINGS: ${plan.warnings.join('；')}`);
  }
  if (plan.meta.weather_advice && plan.meta.weather_advice.length) {
    console.log(`WEATHER: ${plan.meta.weather.label} ${plan.meta.weather.temperature}°C · ${plan.meta.weather_advice.join('；')}`);
  }
  if (!plan.validation.ok) {
    console.log(`VALIDATION_FAILED: ${plan.validation.issues.join('；')}`);
    process.exitCode = 5;
  }
}

if (require.main === module) main();

module.exports = { main };
