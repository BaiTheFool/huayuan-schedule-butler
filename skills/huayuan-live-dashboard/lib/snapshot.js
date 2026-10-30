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
const os = require('os');
const path = require('path');

const SYNC_INTERVAL_DAYS = 7;
const INITIALIZE_PROMPT =
  '开始初始化：请引导我依次完成学院信息、校园门户与教务、eCourse、雨课堂登录、作息偏好和当前教学周，并读取课表与待办。需要登录时一次只打开一个窗口，我完成后再继续。';
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

function findLatestFile(filename, roots) {
  const candidates = [];
  for (const root of roots.filter(Boolean).map((item) => path.resolve(item))) {
    if (!fs.existsSync(root)) continue;
    const pending = [{ dir: root, depth: 0 }];
    while (pending.length) {
      const current = pending.shift();
      let entries;
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = path.join(current.dir, entry.name);
        if (entry.isFile() && entry.name === filename) {
          candidates.push(candidate);
        } else if (
          entry.isDirectory() &&
          current.depth < 5 &&
          !['.git', 'node_modules', 'profiles', 'cache'].includes(entry.name)
        ) {
          pending.push({ dir: candidate, depth: current.depth + 1 });
        }
      }
    }
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
}

/**
 * 建立一个只读快照读取器。
 * @param {{nowPath?: string|null, activityPath?: string, planPath?: string, homeDir?: string}} options
 */
function createSnapshot({ nowPath, activityPath, planPath, homeDir }) {
  const nowFile = nowPath ? path.resolve(nowPath) : null;
  const home = path.resolve(
    homeDir || process.env.HUAYUAN_HOME || path.join(require('os').homedir(), '.workbuddy', 'huayuan-schedule-butler')
  );
  const dataDir = nowFile ? path.dirname(nowFile) : home;
  const activityFile = path.resolve(activityPath || path.join(dataDir, 'activity-feed.json'));
  const stableActivityFile = path.join(home, 'live-activities.json');
  const planFile = path.resolve(planPath || path.join(dataDir, 'plan.json'));
  const stablePlanFile = path.join(home, 'live-plan.json');

  function readNow() {
    if (!nowFile || !fs.existsSync(nowFile)) return null;
    return readJsonFile(nowFile);
  }

  function readActivities() {
    const selectedActivityFile = fs.existsSync(stableActivityFile)
      ? stableActivityFile
      : fs.existsSync(activityFile)
        ? activityFile
        : findLatestFile('activity-feed.json', [
            dataDir,
            home,
            process.env.HUAYUAN_SEARCH_ROOT,
            path.join(os.homedir(), 'WorkBuddy'),
          ]);
    if (!selectedActivityFile) {
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
      return { ok: true, status: 'READY', prompt: ACTIVITY_PROMPT, ...readJsonFile(selectedActivityFile) };
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
    const selectedPlanFile = fs.existsSync(stablePlanFile)
      ? stablePlanFile
      : fs.existsSync(planFile)
        ? planFile
        : findLatestFile('plan.json', [
            dataDir,
            home,
            process.env.HUAYUAN_SEARCH_ROOT,
            path.join(os.homedir(), 'WorkBuddy'),
          ]);
    if (!selectedPlanFile) return null;
    try {
      return readJsonFile(selectedPlanFile);
    } catch {
      return null;
    }
  }

  function taskList(nowDoc) {
    const tasks = (nowDoc && nowDoc.tasks) || {};
    return [...(tasks.p0 || []), ...(tasks.p1 || []), ...(tasks.p2 || []), ...(tasks.p3 || [])];
  }

  function todoSnapshot(nowDoc) {
    const tasks = (nowDoc && nowDoc.tasks) || {};
    const groups = [
      { key: 'p0', label: 'P0 · 必须优先', hint: '已过期、今天或明天截止', items: tasks.p0 || [] },
      { key: 'p1', label: 'P1 · 本周推进', hint: '三天内截止或你设定为高优先级', items: tasks.p1 || [] },
      { key: 'p2', label: 'P2 · 时间充裕', hint: '截止较远或暂未确认', items: tasks.p2 || [] },
      { key: 'p3', label: 'P3 · 不急', hint: '低优先级与阅读类事项', items: tasks.p3 || [] },
    ];
    return {
      groups,
      total: groups.reduce((sum, group) => sum + group.items.length, 0),
      overdue: (nowDoc && nowDoc.overdue) || [],
      completed_local: (nowDoc && nowDoc.completed_local) || [],
      deferred: (nowDoc && nowDoc.deferred) || [],
    };
  }

  function syncInfo() {
    const dir = dataDir;
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
    const lastSyncAt = syncTimes.length
      ? syncTimes[syncTimes.length - 1]
      : nowFile && fs.existsSync(nowFile)
        ? mtimeIso(nowFile)
        : null;
    if (!lastSyncAt) {
      return {
        interval_days: SYNC_INTERVAL_DAYS,
        last_sync_at: null,
        age_days: null,
        due: true,
        prompt: INITIALIZE_PROMPT,
        sources: available,
        message: '还没有平台数据。先复制初始化指令到左侧对话，完成后这里会自动更新。',
      };
    }
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
    if (!nowDoc) return [INITIALIZE_PROMPT];
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
      updated_at: nowFile && fs.existsSync(nowFile) ? mtimeIso(nowFile) : null,
      now,
      todo: todoSnapshot(now),
      sync: syncInfo(),
      activities: readActivities(),
      prompts: promptsFor(now),
    };
  }

  return { nowFile, activityFile, planFile, readNow, readActivities, readPlan, todoSnapshot, syncInfo, promptsFor, dashboard };
}

module.exports = { createSnapshot, SYNC_INTERVAL_DAYS, INITIALIZE_PROMPT, SYNC_PROMPT, ACTIVITY_PROMPT };
