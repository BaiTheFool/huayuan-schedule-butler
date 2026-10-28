'use strict';

/**
 * 本科初始化向导（由 first-run.js 调用）
 *
 * 七步：
 *   1. 匿名槽位 profile-id（不采集姓名学号）
 *   2. 授权平台（默认四平台）
 *   3. 个人偏好（作息 / 用餐 / 运动 / 休息 / 固定事项 / 学习上限 / 缓冲 / 周末）
 *   4. 逐平台登录态检查（只读，不弹窗）
 *   5. 读取（教务课表优先，eCourse 任务其次；未就绪的平台如实跳过）
 *   6. 当前教学周（优先按教务校历自动识别；识别不出来只问一次并保存到状态层）
 *   7. 日程分析（当前占用 / 空闲窗口 / 推荐休息与作业时段 / 冲突 / 待确认）
 *
 * 纪律：
 *   - 任何阶段失败都如实报告，不伪造"0 任务 / 空课表"
 *   - 只有在用户同意（--login 或交互确认）时才打开可见浏览器
 *   - 各平台串行执行，一个脚本结束再跑下一个，避免互相抢前台
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const {
  argValue,
  defaultOutputDir,
  displayPath,
  ensureProfileMeta,
  flag,
  namespaceNotices,
  normalizeProfileId,
  readConfig,
  resolveProfileDir,
  writeSetupState,
} = require('./huayuan-paths');
const {
  INTERVIEW,
  describePreferences,
  normalizePreferences,
  preferencesPath,
  readPreferences,
  writePreferences,
} = require('./preferences');
const { resolveWeek, saveSemesterWeek } = require('./semester-week');
const { legacyFixedEventQuestion } = require('./preferences');

const PLATFORM_LABEL = {
  portal: '校园门户',
  ecourse: 'eCourse',
  jw: '教务系统',
  rain: '雨课堂',
};
const PLATFORMS = ['portal', 'ecourse', 'jw', 'rain'];

// 各脚本收尾时会打印 `<PREFIX>:<STATUS>`，用它判断这一步到底是读到了还是卡在认证
const RESULT_PREFIX = {
  campus: 'CAMPUS_SYNC_RESULT',
  jw: 'JW_TIMETABLE_RESULT',
  ecourse: 'ECOURSE_PULL_RESULT',
  rain: 'RAIN_FAST_RESULT',
};

// 这些状态意味着"需要本人在窗口里操作"，不能自己往下走
// AUTH_ENTRY_NOT_FOUND：登录入口都没能自动打开，同样只能停一次等本人处理
const PAUSE_STATUSES = ['AUTH_REQUIRED', 'AUTH_WAIT', 'AUTH_TIMEOUT', 'AUTH_ENTRY_NOT_FOUND'];

// 读取状态的中文说明，结果页与完整性判定共用一份，避免两处口径不一致
const READ_LABEL = {
  READ_OK: '已读取',
  READ_PARTIAL: '部分读取（有未读到或未解析的内容）',
  READ_EMPTY: '页面可读但没有内容',
  READ_FAILED: '读取失败',
  AUTH_REQUIRED: '需要登录',
  AUTH_WAIT: '等待登录',
  AUTH_TIMEOUT: '登录超时',
  AUTH_ENTRY_NOT_FOUND: '登录入口未能自动打开',
};
const READ_GOOD = new Set(['READ_OK', 'READ_PARTIAL', 'READ_EMPTY']);

// 决定"初始化到底算不算完成"的关键来源。缺任何一个，日程就是缺一块的。
const KEY_SOURCES = [
  { platform: 'jw', label: '教务课表', readKey: 'jw' },
  { platform: 'ecourse', label: 'eCourse', readKey: 'ecourse' },
  { platform: 'rain', label: '雨课堂', readKey: 'rain' },
];
const STATUS_LABEL = {
  completed: '已完成',
  partial: '部分完成',
  paused: '已暂停（等本人完成登录）',
};

function resultStatusOf(stdout, prefix) {
  if (!prefix) return null;
  const match = String(stdout || '').match(new RegExp(`${prefix}:([A-Z_]+)`));
  return match ? match[1] : null;
}

function numberArg(argv, name, fallback) {
  const raw = argValue(argv, name, null);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 判定初始化处在哪一态：completed / partial / paused。
 *
 * 判定标准（与用户可见文案一致，宁可保守也不虚报）：
 *   - 中途需要本人登录且已停下            → paused
 *   - 任一已授权关键来源完全没读到        → partial
 *   - 某来源只读到一部分（有未解析内容）  → partial
 *   - 教务读到但没有解析出课程（课表未知）→ partial
 *   - 分析没跑成功或硬约束校验未通过      → partial
 *   - 以上都没有                          → completed
 */
function assessCompleteness(report) {
  const authorized = report.platforms_authorized || [];
  const classes = (report.analysis && report.analysis.classes) || 0;
  const sources = [];

  for (const item of KEY_SOURCES) {
    if (!authorized.includes(item.platform)) {
      sources.push({ ...item, state: 'not_authorized', detail: '初始化时未勾选，本次不读取' });
      continue;
    }
    const read = report.reads[item.readKey] || {};
    if (read.skipped || !read.status) {
      sources.push({
        ...item,
        state: 'missing',
        detail: read.reason || (read.ok ? '未执行读取' : '读取未完成'),
      });
      continue;
    }
    if (!READ_GOOD.has(read.status)) {
      sources.push({ ...item, state: 'missing', detail: READ_LABEL[read.status] || read.status });
      continue;
    }
    if (item.platform === 'jw') {
      if (!classes) {
        sources.push({ ...item, state: 'missing', detail: '读取完成但没有解析到任何课程（课表未知）' });
      } else if (read.status === 'READ_PARTIAL') {
        sources.push({ ...item, state: 'partial', detail: `读到 ${classes} 段，但有课程未解析` });
      } else {
        sources.push({ ...item, state: 'complete', detail: `${classes} 段课程` });
      }
      continue;
    }
    if (read.status === 'READ_OK') {
      sources.push({ ...item, state: 'complete', detail: '已读取' });
    } else {
      sources.push({ ...item, state: 'partial', detail: READ_LABEL[read.status] });
    }
  }

  const missing = sources.filter((item) => item.state === 'missing');
  const partial = sources.filter((item) => item.state === 'partial');
  const timetableKnown = Boolean(report.analysis_doc && report.analysis_doc.timetable_known);
  const analysisOk = Boolean(report.analysis && report.analysis.ok);
  const checkPlan = report.analysis ? report.analysis.check_plan : null;

  let status;
  if (report.paused) status = 'paused';
  else if (missing.length || partial.length) status = 'partial';
  else if (!analysisOk || !timetableKnown) status = 'partial';
  else if (checkPlan && checkPlan !== 'PASS') status = 'partial';
  else status = 'completed';

  return {
    status,
    status_label: STATUS_LABEL[status],
    sources,
    missing,
    partial,
    timetable_known: timetableKnown,
    analysis_ok: analysisOk,
    check_plan: checkPlan,
    // 只把真正读全的来源算作 ok，其余都进"下一步要补什么"
    key_ok: sources.filter((item) => item.state === 'complete').length,
    key_total: sources.filter((item) => item.state !== 'not_authorized').length,
  };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function tailLines(text, count = 6) {
  return String(text || '')
    .trim()
    .split('\n')
    .slice(-count)
    .join('\n');
}

function step(label, index, total) {
  console.log(`\n[阶段 ${index}/${total}] ${label}`);
}

/**
 * 运行子脚本。
 *
 * 之前用 spawnSync：子进程的输出被攒到退出那一刻才一次性吐出来，
 * eCourse 这种要等本人扫码的步骤会出现"十几分钟没有任何字"，看着像卡死。
 * 现在改成异步 spawn + 逐行转发：子脚本每打印一行，用户在终端立刻就能看到；
 * 连续 3 秒没有新输出时打一行心跳，说明进程还在跑。
 * 退出码、stdout/stderr、既有 JSON 结构全部保持不变。
 */
function runScript(scriptName, args, options = {}) {
  const scriptPath = path.join(__dirname, scriptName);
  if (!fs.existsSync(scriptPath)) {
    return Promise.resolve({
      ok: false,
      status: null,
      stdout: '',
      stderr: `脚本不存在：${scriptName}`,
      skipped: true,
      elapsed_ms: 0,
    });
  }
  return streamScript(scriptPath, args, options);
}

function streamScript(scriptPath, args, options = {}) {
  const scriptName = path.basename(scriptPath);
  const started = Date.now();
  const heartbeatMs = options.heartbeatMs || 3000;
  const label = options.label || scriptName;
  const quiet = Boolean(options.quiet);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [scriptPath, ...args], {
        env: process.env,
        cwd: options.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        status: null,
        stdout: '',
        stderr: String((error && error.message) || error),
        elapsed_ms: Date.now() - started,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let lastOutputAt = Date.now();
    let lastHeartbeatAt = Date.now();

    const forward = (line, prefix = '') => {
      const trimmed = String(line).replace(/\s+$/, '');
      if (!trimmed) return;
      lastOutputAt = Date.now();
      if (!quiet) console.log(prefix ? `${prefix} ${trimmed}` : trimmed);
    };
    const pump = (chunk, sink) => {
      const text = String(chunk || '');
      sink.value += text;
      let index = sink.value.indexOf('\n');
      while (index >= 0) {
        forward(sink.value.slice(0, index));
        sink.value = sink.value.slice(index + 1);
        index = sink.value.indexOf('\n');
      }
    };
    const outSink = { value: '' };
    const errSink = { value: '' };

    const heartbeat = setInterval(() => {
      const silent = Date.now() - lastOutputAt;
      if (silent >= heartbeatMs && Date.now() - lastHeartbeatAt >= heartbeatMs) {
        lastHeartbeatAt = Date.now();
        const seconds = Math.round(silent / 1000);
        console.log(`  …${label} 仍在运行，已 ${seconds} 秒没有新输出（进程正常，等待中）`);
      }
    }, 1000);

    let killer = null;
    if (options.timeout) {
      killer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // 超时杀进程失败时也要把结果交回去，由上层判定
        }
      }, options.timeout);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      outSink.value += String(chunk);
      let index = outSink.value.indexOf('\n');
      while (index >= 0) {
        forward(outSink.value.slice(0, index));
        outSink.value = outSink.value.slice(index + 1);
        index = outSink.value.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      errSink.value += String(chunk);
      let index = errSink.value.indexOf('\n');
      while (index >= 0) {
        const line = errSink.value.slice(0, index);
        errSink.value = errSink.value.slice(index + 1);
        // 子脚本把进度写进 stdout，stderr 一般是噪声，这里只在必要时展示
        if (/错误|Error|FAIL|Exception/i.test(line)) forward(line);
        index = errSink.value.indexOf('\n');
      }
    });
    const finish = (status) => {
      clearInterval(heartbeat);
      if (killer) clearTimeout(killer);
      if (outSink.value.trim()) forward(outSink.value.slice(0));
      if (errSink.value.trim()) forward(errSink.value.slice(0));
      resolve({
        ok: status === 0,
        status,
        stdout,
        stderr,
        elapsed_ms: Date.now() - started,
      });
    };
    child.on('close', (code) => finish(Number.isInteger(code) ? code : null));
    child.on('error', (error) => {
      stderr += String((error && error.message) || error);
      finish(null);
    });
  });
}

function collectPlatformState(outputDir) {
  const candidates = [
    path.join(outputDir, 'all-session-probe.json'),
    path.join(outputDir, 'campus-sync-session-summary.json'),
  ];
  for (const file of candidates) {
    const doc = readJsonSafe(file);
    if (!doc) continue;
    // session-probe 把各平台状态放在 auth.details
    const details = (doc.auth && doc.auth.details) || null;
    if (details && Object.keys(details).length) return details;
    // campus-sync 把结果放在 data.platforms，需要折算成同样的形状
    const platforms = doc.data && doc.data.platforms;
    if (platforms && Object.keys(platforms).length) {
      const normalized = {};
      for (const [key, value] of Object.entries(platforms)) {
        normalized[key] = {
          authenticated: Boolean(value.authenticated),
          reason: value.reason || value.error || null,
        };
      }
      return normalized;
    }
  }
  return null;
}

async function askPreferences(existingAnswers) {
  const answers = { ...existingAnswers };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) =>
    new Promise((resolve) => {
      rl.question(question, (value) => resolve(String(value || '').trim()));
    });
  try {
    console.log('按回车使用括号里的默认值；不确定的题可以直接回车，之后随时能改。\n');
    for (const item of INTERVIEW) {
      const answer = await ask(`${item.question} [${item.fallback || '跳过'}]：`);
      if (answer) item.apply(answers, answer);
    }
    return answers;
  } finally {
    rl.close();
  }
}

function mergePreferencesInput(rawInput, sourceLabel) {
  const { preferences, pending, warnings } = normalizePreferences(rawInput || {});
  if (warnings.length) {
    console.log('偏好提示：');
    warnings.forEach((item) => console.log(`  - ${item}`));
  }
  if (pending.length) {
    console.log('用了默认值的项（后续可修改）：');
    pending.forEach((item) => console.log(`  - ${item}`));
  }
  console.log(`偏好来源：${sourceLabel}`);
  return preferences;
}

/**
 * 主流程。返回结构化结果，供 first-run 输出与测试断言使用。
 */
async function runWizard({ argv = process.argv, existingConfig = null, interactive = false } = {}) {
  const total = 7;
  const config = existingConfig || readConfig() || {};
  const outputDir = path.resolve(argValue(argv, '--output-dir', defaultOutputDir()));
  fs.mkdirSync(outputDir, { recursive: true });
  const report = {
    started_at: new Date().toISOString(),
    output_dir: displayPath(outputDir),
    profile_id: null,
    platforms_authorized: [],
    preferences_source: null,
    platform_state: {},
    login_decision: null,
    login_missing: [],
    namespace_notices: [],
    reads: {},
    skipped: [],
    paused: null,
    analysis: null,
    analysis_doc: null,
    completeness: null,
    status: null,
    steps: [],
  };

  // ── 1. 匿名槽位 ──
  step('匿名账号槽位（不采集姓名、学号）', 1, total);
  const profileId = normalizeProfileId(
    argValue(argv, '--profile-id', config.profile_id || 'default')
  );
  const profileDir = resolveProfileDir(profileId);
  ensureProfileMeta(profileDir, profileId);
  report.profile_id = profileId;
  report.steps.push({ step: 1, name: 'profile', status: 'done', profile_id: profileId });
  console.log(`本次使用槽位：${profileId}`);
  console.log(`槽位目录：${displayPath(profileDir)}`);

  // ── 2. 授权平台 ──
  step('授权平台（未勾选的平台不会被打开）', 2, total);
  const platformArg = argValue(argv, '--platforms', null);
  let platforms = Array.isArray(config.authorized_platforms) && config.authorized_platforms.length
    ? config.authorized_platforms.filter((item) => PLATFORMS.includes(item))
    : [...PLATFORMS];
  if (platformArg) {
    const parsed = String(platformArg)
      .split(/[,，\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter((item) => PLATFORMS.includes(item));
    if (parsed.length) platforms = parsed;
  }
  report.platforms_authorized = platforms;
  report.steps.push({ step: 2, name: 'platforms', status: 'done', platforms });
  console.log(platforms.map((item) => `${PLATFORM_LABEL[item]}(${item})`).join('、'));

  // ── 3. 个人偏好 ──
  step('个人偏好（作息 / 用餐 / 运动 / 休息 / 固定事项 / 学习上限 / 缓冲 / 周末）', 3, total);
  const prefsFile = argValue(argv, '--prefs', null);
  let prefsAnswers = {};
  let prefsSource = '';
  if (prefsFile) {
    const raw = readJsonSafe(path.resolve(prefsFile));
    if (!raw) {
      console.log(`偏好文件无法读取：${displayPath(path.resolve(prefsFile))}，改用交互/默认值`);
    } else {
      prefsAnswers = raw;
      prefsSource = `参数 --prefs（${displayPath(path.resolve(prefsFile))}）`;
    }
  }
  if (!prefsSource && interactive) {
    const fromExisting = readPreferences();
    prefsAnswers = fromExisting.exists ? { ...fromExisting.raw } : {};
    prefsAnswers = await askPreferences(prefsAnswers);
    prefsSource = '本次交互录入';
  }
  if (!prefsSource && interactive) {
    // 0.6.0：先让用户选"用默认值"还是"自己填写"，不给用户偷偷生成一套偏好
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const choice = await new Promise((resolve) => {
      rl.question('\n偏好怎么定？1) 先用系统默认值（之后随时能改） 2) 我自己填写 [1]：', (value) =>
        resolve(String(value || '').trim())
      );
    });
    rl.close();
    if (choice === '2') {
      const fromExisting = readPreferences();
      prefsAnswers = fromExisting.exists ? { ...fromExisting.raw } : {};
      prefsAnswers = await askPreferences(prefsAnswers);
      prefsSource = '本次交互录入';
      prefsAnswers.source = 'user_explicit';
      prefsAnswers.confirmation_state = 'confirmed';
      prefsAnswers.confirmed_at = new Date().toISOString();
    } else {
      // 用户明确说"就用默认值"——这时才允许把默认值标为已确认
      prefsAnswers = { source: 'default', confirmation_state: 'confirmed', accepted_defaults: true, confirmed_at: new Date().toISOString() };
      prefsSource = '用户明确选择使用系统默认值（仍是估计值，之后可改）';
    }
  }
  if (!prefsSource) {
    // 非交互运行且没给 --prefs：已采集过的偏好必须原样沿用，
    // 否则加 --yes 重跑一次就会把用户的作息、运动时间悄悄改回默认值。
    const fromExisting = readPreferences();
    if (fromExisting.exists) {
      prefsAnswers = { ...fromExisting.raw };
      prefsSource = `沿用已保存的偏好（${displayPath(preferencesPath())}）`;
    } else {
      // 非交互又没人确认过：只能算系统估计值，绝不能说成"你告诉我的安排"
      prefsAnswers = { source: 'default', confirmation_state: 'unconfirmed' };
      prefsSource = '默认值（尚未确认：先用它算，但不能说成你的偏好）';
    }
  }
  const preferences = mergePreferencesInput(prefsAnswers, prefsSource);
  preferences.campus = argValue(argv, '--campus', preferences.campus || config.campus || null);
  preferences.college = argValue(argv, '--college', preferences.college || null);
  const prefsPath = writePreferences(preferences);
  const provenance = preferences.provenance || {};
  if (provenance.source === 'default' && provenance.confirmation_state !== 'confirmed') {
    console.log('  偏好来源：系统默认值，尚未经你确认（排程只作估算，不会说成你的安排）');
  }
  // 来源不明的固定事项（例如不知道谁写的周三班会）：只问一次，之前不当不可移动约束
  const legacyAsk = legacyFixedEventQuestion(preferences);
  if (legacyAsk) {
    console.log(`  LEGACY_FIXED_EVENT:${legacyAsk.question}`);
    console.log(`  LEGACY_FIXED_HINT:${legacyAsk.hint}`);
    report.legacy_fixed_event = { count: legacyAsk.count, question: legacyAsk.question };
  }
  report.preferences_source = prefsSource;
  report.college = preferences.college || null;
  report.steps.push({ step: 3, name: 'preferences', status: 'done', path: displayPath(prefsPath) });
  for (const line of describePreferences(preferences)) console.log(`  ${line}`);
  if (!preferences.college) {
    console.log('COLLEGE_UNKNOWN:尚未选择学院/书院，活动推送目前只能覆盖校级来源');
    console.log('COLLEGE_HINT:只问一次“你属于哪个学院/书院？”，回答后执行 manage-items.js set-college --name <学院名>');
  }

  // ── 4. 平台登录态检查（只读，不弹窗）──
  step('逐平台检查登录态（只读，不打开窗口）', 4, total);
  const checkEnabled = !flag(argv, '--skip-check');
  let platformState = {};
  if (checkEnabled) {
    const probe = await runScript('session-probe.js', [
      '--platform',
      'all',
      '--profile-id',
      profileId,
      '--output-dir',
      outputDir,
    ]);
    platformState = collectPlatformState(outputDir) || {};
    report.reads.probe = { ok: probe.ok, status: probe.status, elapsed_ms: probe.elapsed_ms };
    if (!Object.keys(platformState).length) {
      console.log('未能解析平台检查结果，按"未知"处理（不会因此判定为已登录）');
    }
  } else {
    console.log('已按参数跳过检查');
  }
  for (const platform of platforms) {
    const state = platformState[platform];
    const label = PLATFORM_LABEL[platform];
    if (!state) {
      console.log(`  ${label}：未检查`);
      report.platform_state[platform] = { ready: null, reason: '未检查' };
      continue;
    }
    console.log(`  ${label}：${state.authenticated ? '已登录' : '需要登录'}（${state.reason || '无原因'}）`);
    report.platform_state[platform] = {
      ready: Boolean(state.authenticated),
      reason: state.reason || null,
    };
  }
  report.steps.push({ step: 4, name: 'check', status: 'done', platform_state: report.platform_state });

  const missing = platforms.filter(
    (platform) => report.platform_state[platform] && report.platform_state[platform].ready === false
  );

  // 登录决策：整轮初始化只问一次，绝不在每个平台上分别弹问题
  let allowLogin = flag(argv, '--login');
  let loginDecision = allowLogin ? 'forced' : 'not_needed';
  if (!allowLogin && missing.length && interactive && !flag(argv, '--yes')) {
    const labelList = missing.map((item) => PLATFORM_LABEL[item]).join('、');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(`\n检测到${labelList}未登录，是否开始逐平台登录？(y/N)：`, (value) =>
        resolve(String(value || '').trim().toLowerCase())
      );
    });
    rl.close();
    const accepted = answer === 'y' || answer === 'yes' || answer === '是';
    loginDecision = accepted ? 'accepted' : 'declined';
    allowLogin = accepted;
  } else if (!allowLogin && missing.length) {
    // 非交互又没有 --login：不打开任何窗口，如实标记未登录
    loginDecision = 'declined_noninteractive';
  }
  report.login_decision = loginDecision;
  report.login_missing = missing;
  report.steps.push({ step: 4, name: 'login_decision', status: loginDecision, missing });

  if (missing.length) {
    console.log(
      allowLogin
        ? `检测到 ${missing.map((item) => PLATFORM_LABEL[item]).join('、')} 未登录，将按顺序逐个登录并读取（同一时间只开一个窗口）`
        : `检测到 ${missing.map((item) => PLATFORM_LABEL[item]).join('、')} 未登录，本次不打开登录窗口，相关读取将如实标记为未登录`
    );
  }

  // ── 5. 读取：严格串行，campus-sync → jw-timetable → ecourse-pull → rain-fast ──
  step('读取课表与任务（严格串行，同一时间只有一个活动标签）', 5, total);
  const readEnabled = !flag(argv, '--skip-read');
  const loginTimeout = String(numberArg(argv, '--login-timeout-seconds', 600));
  const jwReady = report.platform_state.jw ? report.platform_state.jw.ready : null;
  const portalReady = report.platform_state.portal ? report.platform_state.portal.ready : null;
  const ecourseReady = report.platform_state.ecourse ? report.platform_state.ecourse.ready : null;
  const rainReady = report.platform_state.rain ? report.platform_state.rain.ready : null;

  const finishReadStep = () => {
    report.steps.push({
      step: 5,
      name: 'read',
      status: report.paused ? 'paused' : 'done',
      reads: report.reads,
      skipped: report.skipped,
    });
  };

  if (!readEnabled) {
    console.log('已按参数跳过读取');
    report.steps.push({ step: 5, name: 'read', status: 'skipped' });
  } else if (report.paused) {
    console.log('已暂停，未执行读取');
    finishReadStep();
  } else {
    // 按顺序执行，每一步 spawnSync 返回（子进程退出、浏览器已关闭）后才启动下一步：
    // 上一个 Chrome 已经关掉，下一个才打开，不会互相抢前台
    const notAuthorized = (key) => `未授权（初始化时未勾选 ${PLATFORM_LABEL[key]}）`;
    const notLoggedIn = (key) => `未登录（${(report.platform_state[key] && report.platform_state[key].reason) || '登录态无效'}），本次未打开登录窗口`;
    const order = [];
    if (platforms.includes('portal') || platforms.includes('jw')) {
      order.push({
        key: 'campus',
        platform: platforms.includes('portal') ? 'portal' : 'jw',
        script: 'campus-sync.js',
        label: '门户 + 教务（共用 CAS，先建立统一认证会话）',
        args: [
          '--login-timeout-seconds',
          loginTimeout,
          ...(allowLogin ? [] : ['--no-visible-login']),
        ],
        // 门户或教务任一已登录都要跑：campus-sync 同时覆盖两者，
        // 不能因为教务没登录就把已登录的门户也一起跳过
        run: Boolean(jwReady) || Boolean(portalReady) || allowLogin,
        skipReason: allowLogin ? null : notLoggedIn('portal'),
      });
    }
    if (platforms.includes('jw')) {
      order.push({
        key: 'jw',
        platform: 'jw',
        script: 'jw-timetable.js',
        label: '教务个人课表',
        args: ['--login-timeout-seconds', loginTimeout, ...(allowLogin ? [] : ['--no-visible-login'])],
        run: Boolean(jwReady) || allowLogin,
        skipReason: notLoggedIn('jw'),
      });
    }
    if (platforms.includes('ecourse')) {
      order.push({
        key: 'ecourse',
        platform: 'ecourse',
        script: 'ecourse-pull.js',
        label: 'eCourse 课程与未完成项',
        args: ['--login-timeout-seconds', loginTimeout],
        run: Boolean(ecourseReady) || allowLogin,
        skipReason: notLoggedIn('ecourse'),
      });
    } else {
      report.skipped.push({ platform: 'ecourse', reason: notAuthorized('ecourse') });
    }
    if (platforms.includes('rain')) {
      order.push({
        key: 'rain',
        platform: 'rain',
        script: 'rain-fast.js',
        label: '雨课堂待办',
        args: ['--login-timeout-seconds', loginTimeout],
        // 雨课堂只要授权且登录态有效就必须跑，不能因为"数据量大"默认跳过
        run: Boolean(rainReady) || allowLogin,
        skipReason: notLoggedIn('rain'),
      });
    } else {
      report.skipped.push({ platform: 'rain', reason: notAuthorized('rain') });
    }

    let index = 0;
    for (const item of order) {
      index += 1;
      const prefix = `（${index}/${order.length}）`;
      if (!item.run) {
        const label = PLATFORM_LABEL[item.platform] || item.key;
        console.log(`${prefix} ${label}：${item.skipReason || '未就绪'}，跳过读取`);
        report.reads[item.key] = { ok: false, skipped: true, reason: item.skipReason || '未就绪' };
        report.skipped.push({ platform: item.platform, reason: item.skipReason || '未就绪' });
        continue;
      }
      // 短进度，不中途生成报告：这行就是用户在这段时间看到的全部反馈
      console.log(`[${index}/${order.length}] ${PLATFORM_LABEL[item.platform] || item.key}：正在打开专用浏览器……`);
      const run = await runScript(item.script, [
        '--profile-id',
        profileId,
        '--output-dir',
        outputDir,
        // 第 4 步已经探测过：明确"未登录"时直接进可见登录，不再重复隐藏 Chrome 检查一遍
        ...(report.platform_state[item.platform] && report.platform_state[item.platform].ready === false
          ? ['--skip-hidden-check']
          : []),
        ...item.args,
      ]);
      const status = resultStatusOf(run.stdout, RESULT_PREFIX[item.key]);
      report.reads[item.key] = {
        ok: run.ok,
        status,
        exit_code: run.status,
        elapsed_ms: run.elapsed_ms,
      };

      if (item.key === 'campus') {
        const refreshed = collectPlatformState(outputDir);
        if (refreshed) platformState = { ...platformState, ...refreshed };
      }

      if (status && PAUSE_STATUSES.includes(status)) {
        // 需要本人在窗口里完成认证：停下，不再启动下一个平台，也不绕过
        const label = PLATFORM_LABEL[item.platform] || item.key;
        report.paused = {
          at_step: 5,
          platform: item.platform,
          label,
          status,
          reason:
            status === 'AUTH_ENTRY_NOT_FOUND'
              ? item.platform === 'rain'
                ? '雨课堂登录页没能自动打开（截图与可见按钮文字已记录在输出目录）'
                : '登录入口没能自动打开（截图与可见按钮文字已记录在输出目录）'
              : item.platform === 'jw'
                ? '教务系统通常需要二次认证（微信企业号 / 短信验证码），只能由本人完成'
                : '该平台需要本人登录后才能读取',
          resume_hint:
            item.platform === 'jw'
              ? `在打开的窗口里完成二次认证后，重跑：node first-run.js --wizard --login（或 node jw-timetable.js --profile-id ${profileId}）`
              : `重跑：node first-run.js --wizard --login（或 node ${item.script} --profile-id ${profileId}）`,
        };
        // 本次没跑到的平台也要如实记下来，别让用户以为"没任务"
        for (const rest of order.slice(index)) {
          report.skipped.push({
            platform: rest.platform,
            reason: `因「${label}」需要本人登录而暂停，本平台本次未读取`,
          });
        }
        console.log(`${prefix} ${label}：需要你本人完成登录/二次认证`);
        console.log('  已暂停后续读取，先不启动下一个平台，避免多个窗口互相抢前台。');
        console.log(`  ${report.paused.resume_hint}`);
        break;
      }

      console.log(`  → ${status || (run.ok ? '完成' : '未完成')}`);
    }

    // 第 4 步的快照是登录前的状态；如果某平台是在读取时才完成登录，
    // 这里要回写，否则结果页会出现"未登录｜已读取"这种自相矛盾的说法
    for (const [key, read] of Object.entries(report.reads)) {
      if (!read || read.skipped) continue;
      if (!['READ_OK', 'READ_PARTIAL', 'READ_EMPTY'].includes(read.status)) continue;
      const platform = key === 'campus' ? 'portal' : key;
      const state = report.platform_state[platform];
      if (state && state.ready === false) {
        state.ready = true;
        state.logged_in_during_read = true;
        state.reason = `检查时未登录，读取时已完成登录（${read.status}）`;
      }
    }
    finishReadStep();
  }

  // ── 6. 当前教学周（优先自动识别；识别不出来只问一次，然后用 manage-items.js set-week 保存）──
  step('当前教学周（优先按教务校历自动识别）', 6, total);
  const timetablePath = path.join(outputDir, 'jw-timetable.json');
  const tasksPath = path.join(outputDir, 'ecourse-tasks.json');
  const rainPath = path.join(outputDir, 'rain-fast.json');
  const weekResolution = resolveWeek({
    explicit: argValue(argv, '--week-number', null),
    timetable: readJsonSafe(timetablePath),
    campus: readJsonSafe(path.join(outputDir, 'campus-sync.json')),
    now: new Date(),
  });
  let weekSaved = null;
  if (weekResolution.week && !weekResolution.needs_confirmation && !weekResolution.saved && !weekResolution.conflict) {
    // 自动识别到的周次要落盘：now.js / schedule-analyze.js 都从状态层读它
    try {
      weekSaved = saveSemesterWeek({ week: weekResolution.week, source: `自动识别：${weekResolution.source}` });
    } catch (error) {
      weekSaved = null;
      console.log(`当前教学周保存失败：${error.message}（不影响本次分析，下次可能再识别一次）`);
    }
  }
  if (weekResolution.needs_confirmation) {
    console.log('WEEK_UNKNOWN: 教务数据里没有可靠的校历起点，无法自动判断当前教学周');
    console.log('  只问用户一次：现在是第几周？（例如：第 10 周）');
    console.log('  拿到答案后执行：node manage-items.js set-week --number N');
    console.log('  在用户回答之前，带周次范围的课程按"可能发生"计入，本周课表不是精确结果');
  } else {
    console.log(`当前教学周：第 ${weekResolution.week} 周（${weekResolution.source}）`);
    if (weekResolution.conflict) console.log(`  ${weekResolution.conflict}`);
    if (weekSaved) console.log(`  已保存到状态层：${weekSaved.week} 周（来源 ${weekSaved.source}）`);
  }
  report.current_week = {
    week: weekResolution.week,
    source: weekResolution.source,
    reliable: Boolean(weekResolution.reliable),
    needs_confirmation: Boolean(weekResolution.needs_confirmation),
    saved: Boolean(weekSaved) || Boolean(weekResolution.saved),
    conflict: weekResolution.conflict || null,
    question: weekResolution.needs_confirmation ? weekResolution.question : null,
    how_to_save: weekResolution.needs_confirmation ? 'node manage-items.js set-week --number N' : null,
  };
  report.steps.push({
    step: 6,
    name: 'current_week',
    status: weekResolution.needs_confirmation ? 'needs_confirmation' : 'done',
    week: weekResolution.week,
    source: weekResolution.source,
  });

  // ── 7. 日程分析（即使第 5 步暂停也要跑：用已读到的部分出分析，缺的部分如实标注）──
  step('生成日程分析（当前占用 / 空闲窗口 / 推荐休息与作业时段 / 冲突 / 待确认）', 7, total);
  const analysisArgs = [
    '--output-dir',
    outputDir,
    ...(weekResolution.week ? ['--week-number', String(weekResolution.week)] : []),
    ...(fs.existsSync(timetablePath) ? ['--timetable', timetablePath] : []),
    ...(fs.existsSync(tasksPath) ? ['--tasks', tasksPath] : []),
    ...(fs.existsSync(rainPath) ? ['--rain', rainPath] : []),
  ];
  const analysis = await runScript('schedule-analyze.js', analysisArgs);
  const analysisDoc = readJsonSafe(path.join(outputDir, 'schedule-analysis.json'));
  // 0.6.0：数据不完整时不下正式计划——只说状态、缺什么、一个下一步、最多一个问题
  if (analysisDoc && analysisDoc.readiness && analysisDoc.readiness.ready === false) {
    const readiness = analysisDoc.readiness;
    report.readiness = readiness;
    console.log(`PLAN_STATUS:estimate_only（数据未确认，本次只给估算，不下正式计划）`);
    console.log(`缺少：${readiness.blockers.map((item) => item.label).join('；')}`);
    console.log(`下一步：${readiness.next_action}`);
    if (readiness.question) console.log(`要问的一个问题：${readiness.question}`);
  } else if (analysisDoc) {
    report.readiness = analysisDoc.readiness || { ready: true };
  }
  report.analysis = analysisDoc
    ? {
        ok: analysis.ok,
        path: displayPath(path.join(outputDir, 'schedule-analysis.json')),
        md_path: displayPath(path.join(outputDir, 'schedule-analysis.md')),
        plan_path: displayPath(path.join(outputDir, 'plan.json')),
        conflicts: analysisDoc.conflicts.length,
        adjustments: (analysisDoc.adjustments || []).length,
        pending: analysisDoc.pending.length,
        classes: analysisDoc.inputs.timetable_classes,
        free_minutes: analysisDoc.free_windows.reduce((sum, day) => sum + day.total_minutes, 0),
        tasks: analysisDoc.task_pool ? analysisDoc.task_pool.total : 0,
        tasks_by_source: analysisDoc.task_pool ? analysisDoc.task_pool.by_source : null,
        overdue: analysisDoc.task_pool ? analysisDoc.task_pool.overdue : 0,
        needs_confirmation: analysisDoc.task_pool ? analysisDoc.task_pool.needs_confirmation : 0,
        assigned: analysisDoc.task_pool ? analysisDoc.task_pool.assigned : 0,
        check_plan: /CHECK_PLAN:PASS/.test(analysis.stdout) ? 'PASS' : /CHECK_PLAN:FAILED/.test(analysis.stdout) ? 'FAILED' : '未执行',
      }
    : { ok: false, reason: tailLines(analysis.stderr || analysis.stdout, 3) };
  report.steps.push({ step: 7, name: 'analyze', status: analysis.ok ? 'done' : 'failed' });
  // 结果页需要用到明细（今天/本周可用、建议时段、需确认项），这里只留渲染需要的字段
  report.analysis_doc = analysisDoc
    ? {
        now: analysisDoc.now,
        week_start: analysisDoc.week_start,
        timetable_known: Boolean(analysisDoc.timetable_known),
        confidence: analysisDoc.confidence,
        usable_as_plan: Boolean(analysisDoc.usable_as_plan),
        free_minutes_forward: analysisDoc.free_minutes_forward,
        rest_target_minutes: analysisDoc.rest_target_minutes,
        rest_planned_minutes_forward: analysisDoc.rest_planned_minutes_forward,
        rest_shortfall_days: analysisDoc.rest_shortfall_days || [],
        inputs: analysisDoc.inputs,
        week_filter: analysisDoc.week_filter || null,
        free_windows: analysisDoc.free_windows,
        recommended_rest: analysisDoc.recommended_rest,
        recommended_study: analysisDoc.recommended_study,
        conflicts: analysisDoc.conflicts,
        adjustments: analysisDoc.adjustments,
        pending: analysisDoc.pending,
        task_pool: analysisDoc.task_pool || null,
      }
    : null;

  // 会话目录迁移提示：哪些平台继承了旧登录态、哪些需要单独登录一次，必须说出来
  report.namespace_notices = namespaceNotices(profileId);

  // 完成 / 部分完成 / 暂停三态，由关键来源与分析的可用性共同决定
  report.completeness = assessCompleteness(report);
  report.status = report.completeness.status;
  report.status_label = report.completeness.status_label;
  report.finished_at = new Date().toISOString();
  const reportPath = path.join(outputDir, 'onboarding-report.json');

  // 持久初始化标记：只有三源读到且分析可用才写 completed，
  // 否则写 partial —— 专家下次对话据此判断"要不要再引导一次"
  const setupWritten = writeSetupState({
    state: report.status === 'completed' ? 'completed' : 'partial',
    reportPath: displayPath(reportPath),
    detail: {
      status: report.status,
      paused: Boolean(report.paused),
      missing: report.completeness.missing.map((item) => `${item.label}：${item.detail}`),
      partial: report.completeness.partial.map((item) => `${item.label}：${item.detail}`),
      timetable_known: report.completeness.timetable_known,
      check_plan: report.completeness.check_plan,
      profile_id: profileId,
      finished_at: report.finished_at,
      output_dir: displayPath(outputDir),
    },
  });
  report.setup_state = setupWritten.setup_state;
  report.setup_completed_at = setupWritten.setup_completed_at || null;

  const page = buildResultPage({ ...report, report_path: displayPath(reportPath) });
  report.result_page = page.lines;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  report.report_path = displayPath(reportPath);
  // 结果页单独落一份 markdown，方便直接展示给用户而不是让他去翻 JSON
  const summaryPath = path.join(outputDir, 'onboarding-summary.md');
  fs.writeFileSync(summaryPath, page.markdown, 'utf8');
  report.summary_path = displayPath(summaryPath);
  return report;
}

function printWizardSummary(report) {
  const page = buildResultPage(report);
  console.log(`\n${page.lines.join('\n')}`);
}

function todayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 首次初始化结果页。
 * 用户要的是"我现在什么状态、今天怎么安排"，不是一串文件路径，
 * 所以这里把登录/读取状态、课程数、待办来源、今天与本周可用时段、建议休息/作业时段、
 * 需确认项一次性摊开；文件路径放在最后一行，方便进一步查看。
 */
function buildResultPage(report) {
  const lines = [];
  const analysis = report.analysis_doc || null;
  const pool = analysis && analysis.task_pool ? analysis.task_pool : null;
  const completeness = report.completeness || {
    sources: [],
    missing: [],
    partial: [],
    timetable_known: Boolean(analysis && analysis.timetable_known),
    key_ok: 0,
    key_total: 0,
  };
  const timetableKnown = Boolean(completeness.timetable_known);
  const status = report.status || (report.paused ? 'paused' : 'partial');
  const statusLabel = STATUS_LABEL[status] || '部分完成';
  const estimateTag = timetableKnown ? '' : '（估算）';
  const missingLabels = (completeness.missing || []).map((item) => item.label).join('、');
  const partialLabels = (completeness.partial || []).map((item) => item.label).join('、');

  lines.push('=== 初始化结果 ===');
  const statusBits = [];
  if (completeness.key_total) statusBits.push(`关键来源 ${completeness.key_ok}/${completeness.key_total} 读全`);
  if (missingLabels) statusBits.push(`${missingLabels} 未读到`);
  if (partialLabels) statusBits.push(`${partialLabels} 只读到一部分`);
  lines.push(`状态：${statusLabel}${statusBits.length ? `（${statusBits.join('；')}）` : ''}`);
  lines.push(`账号槽位：${report.profile_id}（会话按平台隔离：门户+教务 / eCourse / 雨课堂 各一份）`);
  if (report.current_week) {
    const cw = report.current_week;
    lines.push(
      cw.week
        ? `当前教学周：第 ${cw.week} 周（${cw.source}${cw.saved ? '，已保存' : ''}）`
        : `当前教学周：未确认（${cw.how_to_save || 'node manage-items.js set-week --number N'} 指定一次；在此之前带周次范围的课按"可能发生"计入）`
    );
  }

  // ── 平台：登录 + 读取 ──
  const readLabel = READ_LABEL;
  // 固定展示顺序：门户 → 教务 → eCourse → 雨课堂，和初始化执行顺序一致
  const displayOrder = ['portal', 'jw', 'ecourse', 'rain'].filter((item) =>
    (report.platforms_authorized || []).includes(item)
  );
  lines.push('平台状态：');
  for (const platform of displayOrder) {
    const state = report.platform_state[platform] || {};
    const read = report.reads[readKeyOf(platform)] || {};
    const loginText =
      state.ready === true ? '已登录' : state.ready === false ? `未登录（${state.reason || '原因未知'}）` : '未检查';
    let readText;
    if (read.skipped) readText = `未读取：${read.reason || '未就绪'}`;
    else if (read.status) readText = readLabel[read.status] || read.status;
    else readText = read.ok ? '已读取' : '未读取';
    lines.push(`  · ${PLATFORM_LABEL[platform]}：${loginText}｜${readText}`);
  }

  // ── 会话目录迁移提示（不能静默：eCourse / 雨课堂 是空目录，需要各自登录一次）──
  // 渲染时以磁盘现状为准：本次已经登录成功的平台改成"已完成"的说法
  let notices = report.namespace_notices || [];
  if (report.profile_id) {
    try {
      const fresh = namespaceNotices(report.profile_id);
      if (fresh.length) notices = fresh;
    } catch {
      // 读不到就沿用报告里存的那份
    }
  }
  if (notices.length) {
    lines.push('会话目录：');
    for (const item of notices) lines.push(`  · ${item.notice}`);
  }

  // ── 课表未知的显著提示：必须放在数字之前，避免用户先看到"5540 分钟"就当成可用时间 ──
  if (!timetableKnown && status !== 'paused') {
    lines.push('');
    lines.push('!! 课表未知：本次没有读到教务课表（或读到了但没解析出课程）。');
    lines.push('   下面的"空闲时间/作业时段"只是按你的作息偏好做的估算，没有扣除上课时间，');
    lines.push('   不能当最终计划，也不代表本周真的没课。');
    lines.push('   补齐课表后重跑：node first-run.js --wizard --login');
  }

  // ── 课程与待办 ──
  if (analysis) {
    const classes = analysis.inputs ? analysis.inputs.timetable_classes : 0;
    if (timetableKnown) {
      const weekTag = report.current_week && report.current_week.week ? `第 ${report.current_week.week} 周` : '本周';
      const filterTag =
        analysis.week_filter && analysis.week_filter.applied
          ? `，已按周次排除 ${analysis.week_filter.sessions_skipped} 段不在本周上的课`
          : '';
      lines.push(`课程：${weekTag} ${classes} 段（来源教务个人课表${filterTag}）`);
    } else {
      lines.push('课程：未知（教务课表未读到，不能当成"本周 0 节课"）');
    }
    if (pool) {
      const by = pool.by_source || {};
      const missingTaskSources = (completeness.sources || [])
        .filter((item) => item.platform !== 'jw' && item.state === 'missing')
        .map((item) => item.label);
      const partialTaskSources = (completeness.sources || [])
        .filter((item) => item.platform !== 'jw' && item.state === 'partial')
        .map((item) => item.label);
      const caveat = missingTaskSources.length
        ? `｜${missingTaskSources.join('、')} 未读到，真实待办可能更多`
        : partialTaskSources.length
          ? `｜${partialTaskSources.join('、')} 只读到一部分，真实待办可能更多`
          : '';
      // 一条都没读到的时候，0 条不等于"没有作业"，必须说成"未知"
      const nothingRead = pool.complete === false && !pool.total && !pool.sources_read?.ecourse && !pool.sources_read?.rain;
      if (nothingRead) {
        lines.push(
          `待办：未知（eCourse 与雨课堂都没有读取，不能据此判断"没有作业"）｜${pool.incomplete_reason || '未读取'}`
        );
      } else {
        lines.push(
          `待办：${pool.total} 条（eCourse ${by.eCourse || 0} / 雨课堂 ${by['雨课堂'] || 0}；` +
            `已过期 ${pool.overdue}；待确认 ${pool.needs_confirmation}；已排入时段 ${pool.assigned}）${caveat}`
        );
      }
    } else {
      lines.push('待办：未知（任务清单未能合并，不能据此判断"没有作业"）');
    }

    // ── 今天 / 本周可用时段（今天只算"现在之后"）──
    const today = todayKey();
    const freeToday = (analysis.free_windows || []).find((day) => day.date === today);
    const restToday = (analysis.recommended_rest || []).find((day) => day.date === today);
    const studyToday = (analysis.recommended_study || []).find((day) => day.date === today);
    const nowText = analysis.now && analysis.now.clock ? `现在 ${analysis.now.clock}，` : '';
    if (freeToday) {
      const windows = (freeToday.windows || [])
        .map((item) => `${item.start}-${item.end}（${item.minutes} 分钟）`)
        .join('、');
      if (!windows) {
        lines.push(`今天 ${today.slice(5)} ${freeToday.day_name}：${nowText}今天剩下的时间没有整块空闲`);
      } else {
        const freeLabel = timetableKnown ? '可用' : '按偏好估算可用';
        lines.push(
          `今天 ${today.slice(5)} ${freeToday.day_name}：${nowText}${freeLabel} ${windows}｜合计 ${
            freeToday.total_minutes
          } 分钟${timetableKnown ? '（现在之后）' : '（未扣除上课时间，不能当最终计划）'}`
        );
      }
      if (restToday && restToday.target_minutes) {
        if ((restToday.slots || []).length) {
          const shortfall = restToday.shortfall_minutes ? `；还差 ${restToday.shortfall_minutes} 分钟排不下` : '';
          lines.push(
            `  建议休息：${restToday.slots.map((slot) => `${slot.start}-${slot.end}`).join('、')}` +
              `｜合计 ${restToday.planned_minutes}/${restToday.target_minutes} 分钟${shortfall}`
          );
        } else if (restToday.note) {
          lines.push(`  建议休息：${restToday.note}`);
        }
      }
      if (studyToday && (studyToday.slots || []).length) {
        const detail = studyToday.slots
          .map((slot) => `${slot.start}-${slot.end}${slot.task ? `（${slot.task.title}）` : ''}`)
          .join('、');
        lines.push(`  建议作业时段：${detail}${estimateTag ? '（估算）' : ''}`);
      }
    } else {
      lines.push(`今天 ${today.slice(5)}：不在本次分析的这一周内（分析周从 ${analysis.week_start} 开始）`);
    }
    // 本周只统计"现在之后"的空档，否则会把已经过去的周一整天算成可用
    const weekFree =
      analysis.free_minutes_forward !== undefined
        ? analysis.free_minutes_forward
        : (analysis.free_windows || [])
            .filter((day) => !day.past)
            .reduce((sum, day) => sum + (day.total_minutes || 0), 0);
    const weekStudy = (analysis.recommended_study || []).reduce(
      (sum, day) => sum + (day.planned_minutes || 0),
      0
    );
    lines.push(
      `本周${estimateTag}（现在之后）：可用 ${weekFree} 分钟，其中已排入作业/自习 ${weekStudy} 分钟` +
        (timetableKnown ? '' : '；不含上课占用，不能当最终计划')
    );

    // ── 需确认 ──
    const confirmLines = [];
    for (const item of analysis.pending || []) confirmLines.push(item);
    if (pool && Array.isArray(pool.items)) {
      for (const item of pool.items) {
        if (!item.needs_confirmation) continue;
        const reasons = (item.confirm_reasons || []).join('；');
        confirmLines.push(`${item.title}（${item.sources.join(' + ')}）${reasons ? `：${reasons}` : ''}`);
      }
    }
    if (pool && Array.isArray(pool.unschedulable)) {
      for (const item of pool.unschedulable) confirmLines.push(`${item.title}：${item.reason}`);
    }
    if (confirmLines.length) {
      lines.push(`需确认 ${confirmLines.length} 项：`);
      for (const item of confirmLines.slice(0, 8)) lines.push(`  - ${item}`);
      if (confirmLines.length > 8) lines.push(`  - ……另有 ${confirmLines.length - 8} 项，见明细文件`);
    } else {
      lines.push('需确认：无');
    }

    lines.push(
      `冲突 ${(analysis.conflicts || []).length} 条；已自动调整 ${(analysis.adjustments || []).length} 条；` +
        `硬约束校验 ${report.analysis && report.analysis.check_plan ? report.analysis.check_plan : '未执行'}` +
        (timetableKnown ? '' : '（只校验了估算计划内部不冲突，不代表真实课表不冲突）')
    );
  } else if (report.analysis && !report.analysis.ok) {
    lines.push(`日程分析未完成：${report.analysis.reason}`);
  }

  // ── 没到"已完成"就只给一条恢复路径，避免用户在跳转/重试里打转 ──
  if (status !== 'completed') {
    lines.push('');
    if (status === 'paused') {
      lines.push(`⚠ 已暂停在「${report.paused.label}」（${report.paused.status}）`);
      lines.push(`  原因：${report.paused.reason}`);
      lines.push(`  唯一恢复命令：${report.paused.resume_hint}`);
      lines.push('  完成认证后只重跑这一条即可，不要反复重试。');
    } else {
      lines.push('下一步（只做这一件事，不要反复重试）：');
      const todo = [];
      for (const item of completeness.missing) todo.push(`${item.label}：${item.detail}`);
      for (const item of completeness.partial) todo.push(`${item.label}：${item.detail}`);
      if (!timetableKnown && !completeness.missing.some((item) => item.platform === 'jw')) {
        todo.push('教务课表：读取完成但没解析出课程，补齐后才有"可用的最终计划"');
      }
      todo.forEach((item, index) => lines.push(`  ${index + 1}) 待补：${item}`));
      lines.push('  唯一恢复命令：node first-run.js --wizard --login');
      lines.push('  它会跳过已经读到的部分，只补缺的；不要连续重跑同一平台。');
    }
  }

  lines.push('');
  const planPathText = report.analysis ? report.analysis.plan_path : '未生成';
  lines.push(
    `明细：${report.analysis ? report.analysis.md_path : '未生成'}｜计划：${planPathText}${
      timetableKnown ? '' : '（估算，不可直接执行）'
    }`
  );
  lines.push(`报告：${report.report_path || `${report.output_dir}\\onboarding-report.json`}`);
  lines.push(`初始化状态：${statusLabel}（config.json setup_state = ${report.setup_state || 'partial'}）`);
  if (status === 'completed') {
    lines.push('后续调整直接用日常说法即可，例如「我晚上十点就睡」「周三别排运动」，不需要重新初始化。');
  }
  return { lines, markdown: toMarkdown(lines) };
}

// 结果页同时落一份 markdown，方便直接展示给用户
function toMarkdown(lines) {
  const out = [];
  for (const line of lines) {
    if (/^=== .* ===$/.test(line)) {
      out.push(`# ${line.replace(/^=== | ===$/g, '')}`, '');
      continue;
    }
    if (/^\s+·\s/.test(line)) {
      out.push(`- ${line.trim().replace(/^·\s*/, '')}`);
      continue;
    }
    if (/^\s+-\s/.test(line)) {
      out.push(`  - ${line.trim().replace(/^-\s*/, '')}`);
      continue;
    }
    if (/^\s{2}/.test(line)) {
      out.push(`- ${line.trim()}`);
      continue;
    }
    out.push(line);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function readKeyOf(platform) {
  if (platform === 'portal') return 'campus';
  if (platform === 'jw') return 'jw';
  if (platform === 'ecourse') return 'ecourse';
  return 'rain';
}

module.exports = {
  PLATFORMS,
  PLATFORM_LABEL,
  buildResultPage,
  collectPlatformState,
  printWizardSummary,
  runScript,
  runWizard,
  streamScript,
};
