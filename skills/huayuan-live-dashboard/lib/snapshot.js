'use strict';

/**
 * 只读快照层（驾驶舱 / 手机工作台共用）。
 *
 * 数据只来自本机运行产物：now.json、plan.json、activity-feed.json。
 * 这里不读浏览器 Cookie、不读账号信息、不写任何文件，也不改学校数据。
 * 抽出本模块的原因：网页驾驶舱与手机远程工作台必须展示**同一份**结论，
 * 否则两端会出现「电脑说 A、手机说 B」的不一致。
 */

const fs = require('fs');
const path = require('path');

const SYNC_INTERVAL_DAYS = 7;
const SYNC_PROMPT =
  '刷新我的校园待办：请重新读取教务、eCourse、雨课堂和校园门户，更新待办与日程，并告诉我新增、临近截止、已过期和发生变化的事项。';
const ACTIVITY_PROMPT =
  '刷新校园活动：请重新拉取校团委、学生工作处、本科生院、研究生院、软件学院和就业在线的公开活动公告，筛出仍可报名的活动，并按截止时间排好。';

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function mtimeIso(file) {
  return fs.statSync(file).mtime.toISOString();
}

/**
 * 建立一个只读快照读取器。
 * @param {{nowPath: string, activityPath?: string, planPath?: string}} options
 */
function createSnapshot({ nowPath, activityPath, planPath }) {
  const nowFile = path.resolve(nowPath);
  const activityFile = path.resolve(activityPath || path.join(path.dirname(nowFile), 'activity-feed.json'));
  const planFile = path.resolve(planPath || path.join(path.dirname(nowFile), 'plan.json'));

  function readNow() {
    return readJsonFile(nowFile);
  }

  function readActivities() {
    if (!fs.existsSync(activityFile)) {
      return {
        ok: false,
        status: 'NOT_SYNCED',
        generated_at: null,
        items: [],
        sources: [],
        warnings: ['还没有活动数据，请先发送“刷新校园活动”。'],
        prompt: ACTIVITY_PROMPT,
      };
    }
    try {
      return { ok: true, status: 'READY', prompt: ACTIVITY_PROMPT, ...readJsonFile(activityFile) };
    } catch (error) {
      return {
        ok: false,
        status: 'INVALID',
        generated_at: null,
        items: [],
        sources: [],
        warnings: [`活动数据无法读取：${String(error.message || error).split('\n')[0]}`],
        prompt: ACTIVITY_PROMPT,
      };
    }
  }

  function readPlan() {
    if (!fs.existsSync(planFile)) return null;
    try {
      return readJsonFile(planFile);
    } catch {
      return null;
    }
  }

  function taskList(nowDoc) {
    const tasks = nowDoc.tasks || {};
    return [...(tasks.p0 || []), ...(tasks.p1 || []), ...(tasks.p2 || []), ...(tasks.p3 || [])];
  }

  function todoSnapshot(nowDoc) {
    const tasks = nowDoc.tasks || {};
    const groups = [
      { key: 'p0', label: 'P0 · 必须优先', hint: '已过期、今天或明天截止', items: tasks.p0 || [] },
      { key: 'p1', label: 'P1 · 本周推进', hint: '三天内截止或你设定为高优先级', items: tasks.p1 || [] },
      { key: 'p2', label: 'P2 · 时间充裕', hint: '截止较远或暂未确认', items: tasks.p2 || [] },
      { key: 'p3', label: 'P3 · 不急', hint: '低优先级与阅读类事项', items: tasks.p3 || [] },
    ];
    return {
      groups,
      total: groups.reduce((sum, group) => sum + group.items.length, 0),
      overdue: nowDoc.overdue || [],
      completed_local: nowDoc.completed_local || [],
      deferred: nowDoc.deferred || [],
    };
  }

  function syncInfo() {
    const dir = path.dirname(nowFile);
    const sources = [
      ['campus-sync.json', '校园门户'],
      ['jw-timetable.json', '教务系统'],
      ['ecourse-tasks.json', 'eCourse'],
      ['rain-fast.json', '雨课堂'],
    ];
    const available = sources
      .map(([name, label]) => {
        const file = path.join(dir, name);
        try {
          return { label, at: mtimeIso(file) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const syncTimes = available.map((item) => item.at).sort();
    const lastSyncAt = syncTimes.length ? syncTimes[syncTimes.length - 1] : mtimeIso(nowFile);
    const ageMs = Math.max(0, Date.now() - new Date(lastSyncAt).getTime());
    const ageDays = Math.floor(ageMs / 86400000);
    const due = ageDays >= SYNC_INTERVAL_DAYS;
    return {
      interval_days: SYNC_INTERVAL_DAYS,
      last_sync_at: lastSyncAt,
      age_days: ageDays,
      due,
      prompt: SYNC_PROMPT,
      sources: available,
      message: due
        ? `距上次平台刷新已有 ${ageDays} 天，建议现在复制下方指令发到左侧。`
        : ageDays === 0
          ? '平台数据今天已刷新。新课、临时作业或通知变化时，可随时再刷新。'
          : `距上次平台刷新已有 ${ageDays} 天；建议每 ${SYNC_INTERVAL_DAYS} 天刷新一次。`,
    };
  }

  function promptsFor(nowDoc) {
    const prompts = [SYNC_PROMPT];
    const first = nowDoc.first_action || {};
    if (first.headline) prompts.push('关于“' + String(first.headline).slice(0, 42) + '”，请告诉我具体第一步怎么做。');
    const pending = (nowDoc.data_status && nowDoc.data_status.pending) || [];
    if (pending.length) prompts.push('请重新核对目前标为待确认的信息，确认哪些需要我处理。');
    const tasks = taskList(nowDoc);
    if (tasks[0]) prompts.push('请把“' + String(tasks[0].title || '当前任务').slice(0, 30) + '”拆成我今天能完成的小步骤。');
    if (tasks[0]) prompts.push('我只有 30 分钟，“' + String(tasks[0].title || '当前任务').slice(0, 28) + '”先做哪一部分？');
    prompts.push('我今天想留出 60 分钟休息，请重新安排。');
    return [...new Set(prompts)].slice(0, 3);
  }

  /** 与网页驾驶舱 `/api/dashboard` 完全一致的载荷。 */
  function dashboard() {
    const now = readNow();
    return {
      generated_at: new Date().toISOString(),
      updated_at: mtimeIso(nowFile),
      now,
      todo: todoSnapshot(now),
      sync: syncInfo(),
      activities: readActivities(),
      prompts: promptsFor(now),
    };
  }

  return { nowFile, activityFile, planFile, readNow, readActivities, readPlan, todoSnapshot, syncInfo, promptsFor, dashboard };
}

module.exports = { createSnapshot, SYNC_INTERVAL_DAYS, SYNC_PROMPT, ACTIVITY_PROMPT };
