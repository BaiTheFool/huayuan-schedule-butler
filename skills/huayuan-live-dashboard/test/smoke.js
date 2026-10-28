'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = 4398;
const token = 'self-check-token';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huayuan-live-dashboard-'));
const nowPath = path.join(dir, 'now.json');
const activityPath = path.join(dir, 'activity-feed.json');

fs.writeFileSync(
  nowPath,
  JSON.stringify({
    now: { date: '2026-11-04', time: '14:20', weekday: '周三' },
    first_action: {
      headline: '先去上课：生产运作管理（样例）（14:30-16:10）',
      next_hint: '下课后做第 6 章作业',
    },
    data_status: { estimate_only: true, pending: ['eCourse 有 2 条记录待确认'] },
    sequence: [
      { start: '16:30', end: '18:00', minutes: 90, kind: 'task', title: '第 6 章作业', source: 'eCourse' },
      { start: '21:10', end: '22:10', minutes: 60, kind: 'rest', title: '休息' },
    ],
    tasks: {
      p0: [{ title: '第 6 章作业', course: '生产运作管理', sources: ['eCourse'], deadline_display: '今天 23:59', priority: 'P0' }],
      p1: [],
      p2: [],
      p3: [],
    },
    overdue: [],
  }),
  'utf8'
);
fs.writeFileSync(
  activityPath,
  JSON.stringify({
    generated_at: new Date().toISOString(),
    date: '2026-10-28',
    item_count: 1,
    items: [
      {
        id: 'activity-1',
        title: '第一届校园AI智能体创新应用大赛',
        source_label: '学院/班级通知（用户提供）',
        type: 'competition',
        deadline: '2026-11-13',
        summary: '报名前请向主办方核实。',
      },
    ],
    sources: [{ id: 'youth', label: '校团委', url: 'https://www2.scut.edu.cn/youth/', status: 'READ_OK', items_seen: 1 }],
    warnings: [],
  }),
  'utf8'
);

const child = spawn(
  process.execPath,
  [path.join(__dirname, '..', 'scripts', 'dashboard-server.js'), '--now', nowPath, '--port', String(port), '--token', token],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);

async function wait() {
  for (let index = 0; index < 30; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      if (response.ok) return;
    } catch {
      // Server is starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('SERVER_START_TIMEOUT');
}

(async () => {
  try {
    await wait();
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /下一步可以这样问/);
    assert.match(html, /全部待办/);
    const todoPage = await fetch(`http://127.0.0.1:${port}/todo.html`);
    const todoHtml = await todoPage.text();
    assert.equal(todoPage.status, 200);
    assert.match(todoHtml, /所有要做的事/);
    assert.match(todoHtml, /复制刷新指令/);
    const activitiesPage = await fetch(`http://127.0.0.1:${port}/activities.html`);
    const activitiesHtml = await activitiesPage.text();
    assert.equal(activitiesPage.status, 200);
    assert.match(activitiesHtml, /现在能参加什么/);
    assert.match(activitiesHtml, /复制刷新指令/);
    const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.service, 'huayuan-live-dashboard');
    assert.equal(data.api_version, 3);
    assert.match(data.now.first_action.headline, /先去上课/);
    assert.ok(data.prompts.length >= 2 && data.prompts.length <= 3);
    assert.match(data.prompts.join(' '), /待确认|小步骤|30 分钟/);
    assert.equal(data.todo.total, 1);
    assert.equal(data.todo.groups[0].items[0].title, '第 6 章作业');
    assert.equal(typeof data.sync.age_days, 'number');
    assert.match(data.sync.prompt, /刷新我的校园待办/);
    assert.equal(data.activities.items[0].title, '第一届校园AI智能体创新应用大赛');
    assert.match(data.activities.prompt, /刷新校园活动/);
    const activitiesApi = await fetch(`http://127.0.0.1:${port}/api/activities`);
    const activitiesData = await activitiesApi.json();
    assert.equal(activitiesData.activities.items.length, 1);

    const denied = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' });
    assert.equal(denied.status, 403);
    console.log('LIVE_DASHBOARD_SMOKE:PASS 20/20');
  } finally {
    child.kill();
  }
})().catch((error) => {
  console.error(`LIVE_DASHBOARD_SMOKE:FAIL ${error.stack || error.message}`);
  child.kill();
  process.exitCode = 1;
});
