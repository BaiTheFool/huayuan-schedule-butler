'use strict';

/**
 * 「全部待办」完整性回归：延后、过期、待确认任务都不能从 P0-P3 列表中消失。
 */

const assert = require('assert');
const NOW = require('../skills/huayuan-browser-session/scripts/now.js');
const PREFS = require('../skills/huayuan-browser-session/scripts/preferences.js');

const analysis = {
  timetable_known: true,
  week_filter: { applied: true, courses_kept: 1, sessions_skipped: 0, unknown_week_count: 0 },
  user_overrides: { week_number: 10, week_number_reliable: true },
  occupancy: [
    {
      date: '2026-10-30',
      weekday: '周五',
      bounds: { start: '08:00', end: '23:00' },
      items: [],
    },
  ],
  free_windows: [
    {
      date: '2026-10-30',
      windows: [{ start: '12:00', end: '18:00', minutes: 360 }],
    },
  ],
  recommended_study: [],
  recommended_rest: [],
  pending: [],
  task_pool: {
    complete: true,
    sources_read: { ecourse: true, rain: true },
    hidden_by_user_state: [],
    items: [
      {
        title: '正常任务',
        status: 'unfinished',
        deadline: '2026-11-05',
        deadline_display: '11-05 23:59',
        priority: 'P2',
        estimated_minutes: 45,
        sources: ['user'],
      },
      {
        title: '延后任务',
        status: 'unfinished',
        deadline: '2026-11-02',
        deadline_display: '11-02 23:59',
        priority: 'P1',
        estimated_minutes: 45,
        sources: ['user'],
        deferred_until: '2026-11-01',
      },
      {
        title: '过期任务',
        status: 'overdue',
        deadline: '2026-10-29',
        deadline_display: '10-29 23:59',
        priority: 'P0',
        estimated_minutes: 30,
        sources: ['user'],
      },
      {
        title: '待确认任务',
        status: 'unfinished',
        deadline: null,
        deadline_display: '待确认',
        estimated_minutes: 20,
        sources: ['user'],
        exclude_from_plan: true,
        needs_confirmation: true,
      },
    ],
  },
};

const result = NOW.buildNow({
  analysis,
  preferences: PREFS.normalizePreferences({}).preferences,
  overrides: {},
  clock: {
    date: '2026-10-30',
    time: '12:00',
    minutes: 720,
    source: 'self-check',
  },
});

const grouped = [
  ...(result.tasks.p0 || []),
  ...(result.tasks.p1 || []),
  ...(result.tasks.p2 || []),
  ...(result.tasks.p3 || []),
];
const titles = grouped.map((item) => item.title);
assert.strictEqual(result.tasks.total, 4);
for (const title of ['正常任务', '延后任务', '过期任务', '待确认任务']) {
  assert.ok(titles.includes(title), `全部待办缺少：${title}`);
}
const deferred = grouped.find((item) => item.title === '延后任务');
assert.strictEqual(deferred.priority, 'P2');
assert.match(deferred.reason, /降级列入待办/);
assert.ok(!result.first_action || !result.first_action.task || result.first_action.task.title !== '延后任务');

console.log('ALL_TODOS_CHECK:PASS 4/4');
