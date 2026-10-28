'use strict';

/**
 * 首次运行向导（只记录匿名配置，不记录任何身份信息）。
 *
 * 本专家只服务华南理工大学**本科生**：学生类型不是可选项，配置里固定为本科生；
 * 旧版本留下的研究生配置会在读取时自动迁移，迁移痕迹写进 config.json。
 *
 * 作用：
 * 1. 固定本科生口径（含旧配置自动迁移）
 * 2. 选择授权平台——只读取用户勾选的平台，未勾选的一律不打开
 * 3. 指定匿名 profile-id——同一台电脑切换不同学校账号时必须换槽位，禁止串数据
 *
 * 用法：
 *   node first-run.js                     # 交互向导
 *   node first-run.js --show              # 查看当前配置
 *   node first-run.js --reset             # 清除配置（不删除浏览器 Profile 数据）
 *   node first-run.js --platforms ecourse,rain --profile-id acc-a --yes
 */

const fs = require('fs');
const readline = require('readline');
const {
  STUDENT_TYPE,
  STUDENT_TYPE_LABEL,
  configPath,
  displayPath,
  ensureProfileMeta,
  listNamespaces,
  listProfiles,
  migrateConfig,
  normalizeProfileId,
  readConfig,
  readSetupState,
  resolveProfileDir,
  writeConfig,
} = require('./huayuan-paths');
const { HOSTS } = require('./endpoints');
const { printWizardSummary, runWizard } = require('./onboarding');

// 固定本科生：类型与口径都不再是用户可选项
const STUDENT_SCOPE_HINT = '课表按本科教学计划，考试周与小学期口径按本科执行';

// 旧版曾支持研究生，现已删除该选项：命中旧值时按本科生迁移，并在输出里说明
const LEGACY_GRADUATE_VALUES = ['2', '研究生', 'graduate', 'pg', 'yanjiusheng', '硕士', '博士'];
const UNDERGRADUATE_VALUES = ['1', '本科生', 'undergraduate', 'ug', 'benke', '本科', ''];

const PLATFORMS = {
  portal: { label: '校园门户', host: HOSTS.portal, note: '统一认证锚点，签到/待办/校历' },
  ecourse: { label: 'eCourse', host: HOSTS.ecourse, note: '课程、作业、测试、问卷、讨论' },
  jw: { label: '教务系统', host: HOSTS.jw, note: '个人课表、考试安排（只读课表与考试）' },
  rain: { label: '雨课堂', host: HOSTS.rain, note: '课件、随堂练习、待办' },
};

// 默认就绪四个平台：缺任何一个都会让日程缺一块
const DEFAULT_PLATFORMS = ['portal', 'ecourse', 'jw', 'rain'];

// 建议执行顺序：登录锚点 → 课表骨架 → 课程任务 → 课件待办
// 每一步都要等上一步结束（浏览器已关闭）再启动下一步，避免多个平台抢前台
const RUN_ORDER = [
  { step: 1, script: 'campus-sync.js', label: '门户 + 教务（共用 CAS，建立统一认证会话）' },
  { step: 2, script: 'jw-timetable.js', label: '教务个人课表' },
  { step: 3, script: 'ecourse-pull.js', label: 'eCourse（课程、作业、测试、问卷、讨论）' },
  { step: 4, script: 'rain-fast.js', label: '雨课堂（课件与随堂待办）' },
];

function argValue(argv, name, fallback = null) {
  const list = Array.isArray(argv) ? argv : process.argv;
  const index = list.indexOf(name);
  if (index >= 0) {
    const next = list[index + 1];
    if (next && !next.startsWith('--')) return next;
    return '';
  }
  return fallback;
}

function flag(argv, name) {
  const list = Array.isArray(argv) ? argv : process.argv;
  return list.includes(name);
}

/**
 * 学生类型：固定本科生。
 * - 旧值（研究生/graduate）不再报错，而是迁移为本科生并返回 migratedFrom，便于输出说明
 * - 未知值直接报错，避免把乱写的参数当成合法输入
 */
function parseStudentType(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (UNDERGRADUATE_VALUES.includes(value)) return { student_type: STUDENT_TYPE, migratedFrom: null };
  if (LEGACY_GRADUATE_VALUES.includes(value)) {
    return { student_type: STUDENT_TYPE, migratedFrom: String(raw).trim() };
  }
  throw new Error(
    `INVALID_STUDENT_TYPE: ${raw} —— 本专家只服务华南理工大学本科生，学生类型固定为 undergraduate`
  );
}

function parsePlatforms(raw, fallback = DEFAULT_PLATFORMS) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return [...fallback];
  const digits = { 1: 'portal', 2: 'ecourse', 3: 'jw', 4: 'rain' };
  const out = [];
  for (const tokenRaw of String(raw).split(/[,，\s]+/)) {
    const token = tokenRaw.trim().toLowerCase();
    if (!token) continue;
    const key = digits[token] || token;
    if (!PLATFORMS[key]) throw new Error(`INVALID_PLATFORM: ${tokenRaw}（可选 portal/ecourse/jw/rain）`);
    if (!out.includes(key)) out.push(key);
  }
  if (!out.length) throw new Error('INVALID_PLATFORM: 至少选择一个平台');
  return out;
}

function platformMenu() {
  const lines = ['可选平台：'];
  Object.entries(PLATFORMS).forEach(([key, item], index) => {
    lines.push(`  ${index + 1}) ${item.label}（${item.host || '未配置域名'}）— ${item.note}`);
  });
  lines.push(`多个平台用逗号分隔，例如 1,2,3,4；直接回车使用默认（四平台全选）：${DEFAULT_PLATFORMS.join(',')}`);
  return lines.join('\n');
}

function runOrderLines() {
  return RUN_ORDER.map((item) => `  ${item.step}) node ${item.script}    # ${item.label}`);
}

// 展示会话命名空间状态：三个平台各一份，已经建过的标"已就绪"
function describeNamespaces(profileId) {
  const list = listNamespaces(profileId);
  if (!list.length) return '尚未建立（首次读取时按平台自动创建）';
  return list.map((item) => `${item.namespace}${item.exists ? '' : '(未建)'}`).join(' / ');
}

function summary(config, profileDir) {
  const setup = readSetupState();
  const platforms = (config.authorized_platforms || [])
    .map((key) => `${PLATFORMS[key] ? PLATFORMS[key].label : key}(${key})`)
    .join('、');
  const lines = [
    '',
    '=== 当前配置 ===',
    `配置文件: ${displayPath(configPath())}`,
    `学生类型: ${STUDENT_TYPE_LABEL}（${STUDENT_TYPE}，固定口径）— ${STUDENT_SCOPE_HINT}`,
    `初始化状态: ${setup.label}（setup_state = ${setup.state}）`,
  ];
  if (setup.state === 'completed' && setup.completed_at) {
    lines.push(`首次完成时间: ${setup.completed_at}`);
  } else {
    const unread = [...(setup.missing || []), ...(setup.partial || [])].filter(Boolean);
    if (unread.length) lines.push(`还没读全: ${unread.slice(0, 4).join('；')}`);
  }
  if (setup.last_report) lines.push(`最近报告: ${setup.last_report}`);
  lines.push(
    `授权平台: ${platforms || '（未选择）'}`,
    `账号槽位: ${config.profile_id}`,
    `槽位目录: ${displayPath(profileDir)}`,
    `会话隔离: ${describeNamespaces(config.profile_id)}`,
    `更新时间: ${config.updated_at || config.created_at || '未知'}`
  );
  if (config.student_type_migrated_from) {
    lines.push(
      `迁移记录: ${config.student_type_migrated_from} → ${STUDENT_TYPE}（${config.student_type_migrated_at || '时间未知'}，研究生类型已下线）`
    );
  }
  lines.push(
    '',
    '提示：同一台电脑切换另一个学校账号时，必须使用不同的 --profile-id，',
    '     例如 --profile-id acc-b；共用同一槽位会导致两个账号的会话互相覆盖。'
  );
  return lines.join('\n');
}

async function interactive(existing) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(String(answer || '').trim()));
    });
  try {
    console.log('华园日程管家 · 首次运行向导（本科生）');
    console.log(
      '本向导只保存匿名配置（授权平台 / 账号槽位），不保存姓名、学号、密码或票据。学生类型固定本科生。\n'
    );

    console.log(`1) 允许读取哪些平台？（未勾选的平台不会被打开）\n${platformMenu()}`);
    const platformAnswer = await ask(
      `请输入编号，直接回车用默认（四平台）${DEFAULT_PLATFORMS.join(',')}：`
    );
    const platforms = parsePlatforms(platformAnswer || DEFAULT_PLATFORMS.join(','));

    const knownProfiles = listProfiles().map((item) => item.profile_id);
    const idDefault = existing.profile_id || 'default';
    console.log(
      '\n2) 匿名账号槽位（profile-id）。同一台电脑切换不同账号必须用不同槽位，避免会话串号。'
    );
    if (knownProfiles.length) console.log(`   现有槽位：${knownProfiles.join('、')}`);
    const idAnswer = await ask(`请输入槽位名（字母/数字/下划线/短横线）[默认 ${idDefault}]：`);
    const profileId = normalizeProfileId(idAnswer || idDefault);

    return { student_type: STUDENT_TYPE, authorized_platforms: platforms, profile_id: profileId };
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv;

  if (flag(argv, '--help') || flag(argv, '-h')) {
    console.log(
      [
        '首次运行向导（华南理工大学本科生）',
        '',
        '一条命令完成本科初始化（推荐）：',
        '  node first-run.js --wizard --login',
        '  交互录入作息与偏好 → 逐平台登录 → 读课表与任务 → 生成日程分析',
        '',
        '其他用法：',
        '  node first-run.js                       交互向导（只写配置）',
        '  node first-run.js --show                查看当前配置',
        '  node first-run.js --reset               清除配置（不删除浏览器 Profile）',
        '  node first-run.js --platforms ecourse,rain --profile-id acc-a --yes',
        '',
        '参数：',
        '  --wizard        进入初始化向导（偏好 / 登录 / 读取 / 分析）',
        '  --login         本次允许打开浏览器登录；窗口会等本人操作，不会绕过二次认证',
        '  --login-timeout-seconds  每个平台的登录等待上限，默认 600 秒',
        '  --platforms     portal,ecourse,jw,rain（也接受 1,2,3,4），默认四平台全选',
        '  --profile-id    匿名账号槽位，默认 default',
        '  --student-type  仅接受 undergraduate（本科生）；旧值 graduate 会自动迁移为本科生',
        '  --college       学院/书院名称（如 软件学院），用于活动推送',
        '  --prefs <json>  用文件提供偏好（非交互，WorkBuddy 里就用这个）',
        '  --yes           自动化用：不交互，且不会覆盖已保存的偏好',
        '  --force         覆盖已有配置',
        '',
        '非 TTY（WorkBuddy / 脚本）固定写法：',
        '  node first-run.js --wizard --yes --prefs ./prefs.json --login-timeout-seconds 600',
        '',
        '学生类型固定本科生，不再提供研究生选项。',
      ].join('\n')
    );
    return;
  }

  // 任何入口都先做一次幂等迁移：旧版研究生配置会被归一到本科生口径
  const migration = migrateConfig();
  const existing = readConfig() || {};

  if (flag(argv, '--show')) {
    if (migration.migrated) {
      console.log(`配置已自动迁移：${migration.changes.join('；')}`);
    }
    if (!existing.profile_id) {
      console.log('尚未初始化。运行 node first-run.js --wizard --login 完成首次配置。');
      console.log(`配置将写到: ${displayPath(configPath())}`);
      const profiles = listProfiles();
      if (profiles.length) console.log(`已有账号槽位: ${profiles.map((p) => p.profile_id).join('、')}`);
      return;
    }
    console.log(summary(existing, resolveProfileDir(existing.profile_id)));
    return;
  }

  if (flag(argv, '--reset')) {
    if (!fs.existsSync(configPath())) {
      console.log('当前没有配置文件，无需清除。');
      return;
    }
    if (!flag(argv, '--yes')) {
      console.log('为避免误删，请加 --yes 确认：node first-run.js --reset --yes');
      console.log('说明：只删除 config.json，不删除已登录的浏览器 Profile。');
      return;
    }
    fs.unlinkSync(configPath());
    console.log(`已删除配置文件: ${displayPath(configPath())}`);
    console.log('浏览器 Profile 未删除；如需彻底重置，请手动删除对应槽位目录。');
    return;
  }

  const hasFlags =
    argValue(argv, '--student-type', null) !== null ||
    argValue(argv, '--platforms', null) !== null ||
    argValue(argv, '--profile-id', null) !== null;

  // 显式再跑向导：已有配置也允许，用于补采偏好或重新检查登录
  if (flag(argv, '--wizard')) {
    if (!existing.profile_id) {
      writeConfig({
        version: '0.3.2',
        student_type: STUDENT_TYPE,
        student_type_locked: true,
        authorized_platforms: parsePlatforms(argValue(argv, '--platforms', null), DEFAULT_PLATFORMS),
        profile_id: normalizeProfileId(argValue(argv, '--profile-id', 'default')),
        privacy: '仅保存匿名配置；不含姓名、学号、Cookie、Token、票据',
      });
    }
    const report = await runWizard({
      argv,
      existingConfig: readConfig(),
      interactive: Boolean(process.stdin.isTTY) && !flag(argv, '--yes'),
    });
    printWizardSummary(report);
    return;
  }

  if (existing.profile_id && !flag(argv, '--force') && !hasFlags) {
    const setup = readSetupState();
    console.log(summary(existing, resolveProfileDir(existing.profile_id)));
    if (setup.state === 'completed') {
      // 老用户：已经初始化完成，不要每次重新走一遍向导
      console.log('\n已经完成初始化，日常调整不需要重新初始化。');
      console.log('  - 改作息/运动/休息：直接跟专家说，例如「我晚上十点就睡」「周三别排运动」');
      console.log('  - 想刷新数据（新学期、换了课）：node first-run.js --wizard');
      console.log('  - 只在登录失效时才需要：node first-run.js --wizard --login');
      return;
    }
    if (setup.state === 'partial') {
      console.log('\n上次初始化没有全部读到，继续补齐即可（不会重走已完成的步骤）：');
      const unread = [...(setup.missing || []), ...(setup.partial || [])].filter(Boolean);
      if (unread.length) console.log(`  还差：${unread.slice(0, 5).join('；')}`);
      console.log('  node first-run.js --wizard --login');
      return;
    }
    console.log('\n尚未完成初始化。一条命令完成（偏好 + 逐平台登录 + 读取 + 分析）：');
    console.log('  node first-run.js --wizard --login');
    console.log('\n其他：');
    console.log('  node first-run.js --wizard      # 已有登录态时只补读与重新分析');
    console.log('  node first-run.js --force       # 重新填写平台与槽位');
    return;
  }

  let answers;
  if (flag(argv, '--yes') || hasFlags) {
    const parsedType = parseStudentType(
      argValue(argv, '--student-type', existing.student_type || STUDENT_TYPE)
    );
    if (parsedType.migratedFrom) {
      console.log(
        `提示：学生类型 ${parsedType.migratedFrom} 已不再支持（本专家只服务本科生），已按本科生处理。`
      );
    }
    answers = {
      student_type: parsedType.student_type,
      authorized_platforms: parsePlatforms(
        argValue(argv, '--platforms', (existing.authorized_platforms || DEFAULT_PLATFORMS).join(','))
      ),
      profile_id: normalizeProfileId(argValue(argv, '--profile-id', existing.profile_id || 'default')),
    };
  } else if (process.stdin.isTTY) {
    answers = await interactive(existing);
  } else {
    console.log('当前不是交互终端（WorkBuddy 等非 TTY 环境按这一条执行，不要等交互输入）：');
    console.log(
      '  node first-run.js --wizard --yes --prefs ./prefs.json --login-timeout-seconds 600'
    );
    console.log('  需要本人登录时再加 --login；--prefs 里放作息/用餐/运动/休息等偏好即可。');
    console.log(`配置将写到: ${displayPath(configPath())}`);
    process.exitCode = 2;
    return;
  }

  const config = writeConfig({
    version: '0.3.2',
    student_type: answers.student_type,
    student_type_locked: true,
    authorized_platforms: answers.authorized_platforms,
    profile_id: answers.profile_id,
    privacy: '仅保存匿名配置；不含姓名、学号、Cookie、Token、票据',
  });

  const profileDir = resolveProfileDir(config.profile_id);
  ensureProfileMeta(profileDir, config.profile_id);

  console.log(summary(config, profileDir));

  // 交互式首次运行：配置写好后直接进入本科初始化向导（偏好录入 → 登录检查 → 读取 → 分析）
  if (process.stdin.isTTY && !flag(argv, '--yes') && !flag(argv, '--no-wizard')) {
    const report = await runWizard({ argv, existingConfig: config, interactive: true });
    printWizardSummary(report);
    return;
  }

  console.log('\n下一步（按这个顺序执行，先建会话再补数据）：');
  console.log(runOrderLines().join('\n'));
  console.log('\n想先确认登录态而不打开窗口：');
  console.log('  node session-probe.js --platform all');
  console.log('\n只想读课表：');
  console.log('  node jw-timetable.js');
  console.log('\n想一次完成偏好录入 + 检查 + 分析：');
  console.log('  node first-run.js --wizard');
}

main().catch((error) => {
  console.error(`FIRST_RUN_FAILED:${String(error.message || error).split('\n')[0]}`);
  process.exit(1);
});
