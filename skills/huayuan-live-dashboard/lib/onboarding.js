'use strict';

/**
 * 初始化健康状态（只读）。
 *
 * 只读取本机配置、偏好和已知运行产物，不读取 Cookie、密码、学号或姓名。
 * 驾驶舱用它统一渲染顶部缺失项、标签页红点和可复制补全指令。
 */

const fs = require('fs');
const path = require('path');

const START_SETUP_PROMPT =
  '开始初始化：请引导我依次完成学院信息、校园门户与教务、eCourse、雨课堂登录、作息偏好和当前教学周，并读取课表与待办。需要登录时一次只打开一个窗口，我完成后再继续。';

const PLATFORM_STEPS = [
  {
    key: 'portal',
    label: '校园门户 / 教务',
    platforms: ['portal', 'jw'],
    detail: '授权后用于读取身份、课表、考试与教学通知。',
    prompt:
      '请检查我的校园门户和教务系统登录状态；需要登录时打开一次清晰可见的认证窗口，我本人完成后再继续读取。',
  },
  {
    key: 'ecourse',
    label: 'eCourse',
    platforms: ['ecourse'],
    detail: '授权后用于读取课程页、作业、讨论与测验。',
    prompt:
      '请检查我的 eCourse 登录状态；需要登录时直接打开 eCourse 登录入口，我本人扫码或认证后再读取课程和未完成任务。',
  },
  {
    key: 'rain',
    label: '雨课堂',
    platforms: ['rain'],
    detail: '授权后用于读取课程与“未完成”待办。',
    prompt:
      '请检查我的雨课堂登录状态；未登录时直接打开清楚的登录页面，我本人完成登录后再读取课程与未完成任务。',
  },
];

const STEPS = [
  {
    key: 'college',
    label: '学院 / 书院',
    detail: '用于筛选学院活动、通知和竞赛。',
    prompt: '我的学院/书院是 ____，请保存后继续检查平台授权、课表和待办。',
    tab: 'activities',
  },
  {
    key: 'portal',
    label: '校园门户 / 教务',
    detail: '用于读取课表、考试和教学通知。',
    prompt: PLATFORM_STEPS[0].prompt,
    tab: 'today',
  },
  {
    key: 'ecourse',
    label: 'eCourse',
    detail: '用于读取课程作业、讨论和测验。',
    prompt: PLATFORM_STEPS[1].prompt,
    tab: 'todo',
  },
  {
    key: 'rain',
    label: '雨课堂',
    detail: '用于读取课程和“未完成”任务。',
    prompt: PLATFORM_STEPS[2].prompt,
    tab: 'todo',
  },
  {
    key: 'preferences',
    label: '作息与学习偏好',
    detail: '决定什么时候学习、休息，以及每天安排多少任务。',
    prompt:
      '请逐项询问我的作息和学习偏好，不要替我使用默认值；至少确认起床、睡觉、用餐、每天可学习时长、单次专注时长、休息时长和晚间最晚结束时间，保存后重新安排。',
    tab: 'today',
  },
  {
    key: 'week',
    label: '当前教学周',
    detail: '没有教学周，单双周课程和本周课表无法精确判断。',
    prompt: '现在是第 ____ 教学周，请保存后重新读取课表并刷新驾驶舱。',
    tab: 'today',
  },
  {
    key: 'timetable',
    label: '教务课表',
    detail: '用于判断上课时间、空档和校园路线。',
    prompt:
      '请只读读取我的教务课表；如果登录失效，只打开一次登录窗口让我本人认证，成功后保存课表并刷新驾驶舱。',
    tab: 'today',
  },
  {
    key: 'tasks',
    label: '平台待办',
    detail: '用于汇总 eCourse、雨课堂、门户和教务中的未完成任务。',
    prompt:
      '请刷新我的校园待办：重新读取教务、eCourse、雨课堂和校园门户，更新待办与日程，并告诉我新增、临近截止、已过期和发生变化的事项。',
    tab: 'todo',
  },
  {
    key: 'activities',
    label: '可参与事项',
    detail: '用于展示竞赛、讲座、志愿和学院通知。',
    prompt:
      '刷新校园活动：请按我的学院重新拉取公开活动公告，筛出仍可报名的事项，并按截止时间排好。',
    tab: 'activities',
  },
];

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function currentWeek(config, preferences, state, now) {
  const candidates = [
    state && state.semester && state.semester.current_week,
    config && config.current_week,
    config && config.teaching_week,
    preferences && preferences.current_week,
    now && now.now && now.now.week,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0 && number < 60) return number;
  }
  return null;
}

function platformReady(config, platforms) {
  const authorized = new Set(Array.isArray(config && config.authorized_platforms) ? config.authorized_platforms : []);
  return platforms.every((platform) => authorized.has(platform));
}

function createStep(definition, complete, extra = {}) {
  return {
    key: definition.key,
    label: definition.label,
    detail: definition.detail,
    prompt: definition.prompt,
    tab: definition.tab,
    complete: Boolean(complete),
    ...extra,
  };
}

/**
 * @param {{homeDir:string, now:object|null, hasTimetable:boolean, hasActivities:boolean}} input
 */
function buildOnboardingStatus({ homeDir, now, hasTimetable, hasActivities }) {
  const home = path.resolve(homeDir);
  const config = readJson(path.join(home, 'config.json'));
  const preferences = readJson(path.join(home, 'preferences.json'));
  const state = readJson(path.join(home, 'user-state.json'));
  const setupState = String((config && config.setup_state) || (config ? 'partial' : 'uninitialized'));
  const college = String((preferences && preferences.college) || '').trim();
  const major = String((preferences && preferences.major) || '').trim();
  const week = currentWeek(config, preferences, state, now);
  const preferencesReady = Boolean(
    preferences &&
      preferences.daily &&
      preferences.study &&
      (preferences.provenance?.confirmation_state === 'confirmed' ||
        preferences.confirmed_at ||
        setupState === 'completed')
  );

  const values = {
    college: Boolean(college),
    portal: platformReady(config, PLATFORM_STEPS[0].platforms),
    ecourse: platformReady(config, PLATFORM_STEPS[1].platforms),
    rain: platformReady(config, PLATFORM_STEPS[2].platforms),
    preferences: preferencesReady,
    week: Boolean(week),
    timetable: Boolean(hasTimetable),
    tasks: Boolean(now),
    activities: Boolean(hasActivities),
  };

  const steps = STEPS.map((definition) =>
    createStep(definition, values[definition.key], {
      meta:
        ['portal', 'ecourse', 'rain'].includes(definition.key) && values[definition.key]
          ? '已授权；登录状态在读取时校验'
          : definition.key === 'week' && week
            ? `第 ${week} 周`
            : definition.key === 'college' && college
              ? college
              : '',
    })
  );
  const blockers = steps.filter((step) => !step.complete);
  const badges = { today: 0, todo: 0, activities: 0 };
  for (const blocker of blockers) {
    if (badges[blocker.tab] != null) badges[blocker.tab] += 1;
  }
  const initialized = blockers.length === 0 && setupState === 'completed';
  const completed = steps.filter((step) => step.complete).length;

  return {
    ok: true,
    setup_state: setupState,
    initialized,
    college,
    major,
    current_week: week,
    completed_steps: completed,
    total_steps: steps.length,
    blockers,
    steps,
    badges,
    prompt: START_SETUP_PROMPT,
    headline: initialized
      ? '基础资料已齐，可以开始安排今天。'
      : blockers.length
        ? `还有 ${blockers.length} 项资料没有补齐`
        : '初始化记录尚未正式完成',
  };
}

module.exports = { buildOnboardingStatus, START_SETUP_PROMPT };
