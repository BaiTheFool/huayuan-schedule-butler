'use strict';

/**
 * 统一路径与运行参数解析（可移植）。
 *
 * 设计目标：同一个专家包在任何 Windows 用户机器上都能直接运行。
 * - 不写死任何用户名、盘符或工程目录
 * - Profile 根目录默认落在当前用户 USERPROFILE 下
 * - 输出目录默认落在当前工作区的 huayuan-output/<时间戳>
 * - 支持匿名账号槽位 --profile-id，同机切换不同学校账号必须用不同槽位
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR_NAME = 'huayuan-schedule-butler';
const DEFAULT_PROFILE_ID = 'default';
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const CONFIG_SCHEMA_VERSION = 2;

/**
 * 会话命名空间：同一个匿名账号槽位下，按平台分目录存放浏览器会话。
 *
 * 为什么必须分：
 *   门户/教务（CAS）、eCourse、雨课堂 如果共用一个 Chrome user data dir，
 *   任一平台的跳转或 Cookie 覆盖都会把另一个平台带偏（顶层被拐到教务、标签互抢），
 *   这是"eCourse 与教务反复互跳"的根因。一个平台一个目录后互不影响。
 *
 * 目录形态：profiles/<profile-id>/{cas,ecourse,rain}
 *   cas     → 校园门户 + 教务系统（共用统一认证 CAS，路径相同但数据仍独立）
 *   ecourse → 只允许主框架停留在 ecourse 与 sso
 *   rain    → 雨课堂
 */
const NAMESPACES = ['cas', 'ecourse', 'rain'];
const DEFAULT_NAMESPACE = 'cas';
const PLATFORM_NAMESPACE = {
  portal: 'cas',
  jw: 'cas',
  ecourse: 'ecourse',
  rain: 'rain',
};
const NAMESPACE_LABEL = {
  cas: '门户 + 教务（统一认证 CAS）',
  ecourse: 'eCourse',
  rain: '雨课堂',
};
// 继承旧单目录会话时要跳过的条目：命名空间目录自身 + 元数据 + 锁，避免递归复制
const LEGACY_COPY_SKIP = new Set([
  'profile.json',
  '.huayuan-session.lock',
  '.huayuan-namespaces.json',
  '.legacy-migrated.json',
  ...NAMESPACES,
]);
/**
 * 只有 cas 允许继承旧版共享会话。
 *
 * 原因：旧版三个平台共用一个 Chrome 目录，里面除了统一认证 Cookie，还留着
 * 教务与 eCourse 各自的跨站 Cookie / Service Worker / 本地存储。整份复制到
 * ecourse 目录后，eCourse 打开时仍可能被这些残留带走（顶层被拐到教务）。
 * 所以 ecourse 与 rain 一律从空目录开始，各自登录一次；这是一次性的，
 * 而且必须明确告诉用户，不能静默。
 */
const LEGACY_INHERIT_NAMESPACES = new Set(['cas']);
// 初始化状态：未初始化 / 部分完成 / 完成
const SETUP_STATES = ['uninitialized', 'partial', 'completed'];
const SETUP_LABEL = {
  uninitialized: '未初始化',
  partial: '部分完成',
  completed: '已完成',
};
// 本专家只服务华南理工大学本科生：学生类型不是可选项，而是固定口径
const STUDENT_TYPE = 'undergraduate';
const STUDENT_TYPE_LABEL = '本科生';
// 0.2.x → 0.3.x 出现过研究生专属字段，迁移时一并清除，避免旧配置继续影响排程口径
const GRADUATE_ONLY_KEYS = ['graduate_track', 'degree_stage', 'supervisor', 'thesis_milestones', 'research_group'];

function homeDir() {
  const fromEnv = process.env.USERPROFILE || process.env.HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return os.homedir();
}

// 允许整体重定向数据根目录（测试、便携部署、多机同步都用它），默认仍在用户目录下
function appDataRoot() {
  const override = process.env.HUAYUAN_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(homeDir(), '.workbuddy', APP_DIR_NAME);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeProfileId(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PROFILE_ID;
  const value = String(raw).trim();
  if (!PROFILE_ID_PATTERN.test(value)) {
    const error = new Error(
      `INVALID_PROFILE_ID: ${value} —— 只允许字母、数字、下划线和短横线，长度 1-40，且不能以符号开头`
    );
    error.code = 'INVALID_PROFILE_ID';
    throw error;
  }
  return value;
}

function profileRoot() {
  return path.join(appDataRoot(), 'profiles');
}

function resolveProfileDir(profileId) {
  return path.join(profileRoot(), normalizeProfileId(profileId));
}

function defaultProfileDir() {
  return resolveProfileDir(DEFAULT_PROFILE_ID);
}

function normalizeNamespace(raw) {
  const value = String(raw === undefined || raw === null ? DEFAULT_NAMESPACE : raw)
    .trim()
    .toLowerCase();
  if (!NAMESPACES.includes(value)) {
    const error = new Error(`INVALID_NAMESPACE: ${value} —— 只支持 ${NAMESPACES.join(' / ')}`);
    error.code = 'INVALID_NAMESPACE';
    throw error;
  }
  return value;
}

function platformNamespace(platform) {
  const key = String(platform || '').trim().toLowerCase();
  return PLATFORM_NAMESPACE[key] || null;
}

// 平台对应的浏览器会话目录：profiles/<id>/<namespace>
function resolvePlatformDir(profileId, platform) {
  const namespace = platformNamespace(platform);
  if (!namespace) {
    const error = new Error(`UNSUPPORTED_PLATFORM:${platform} —— 没有对应的会话命名空间`);
    error.code = 'UNSUPPORTED_PLATFORM';
    throw error;
  }
  return resolveNamespaceDir(profileId, namespace);
}

function resolveNamespaceDir(profileId, namespace) {
  return path.join(resolveProfileDir(profileId), normalizeNamespace(namespace));
}

function hasChromeData(dir) {
  return ['Default', 'Local State', 'First Run'].some((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * 首次为某个命名空间建目录时，把旧版单目录里的会话整份继承过来。
 *
 * 目的：升级到命名空间隔离不应该让用户重新登录三次。
 * 做法：复制（不是移动）旧 Chrome 数据——命名空间目录是旧目录的子目录，移动自己会丢数据；
 *       复制后各自独立，后续再也不会互相影响。
 * 只在目标目录为空且旧目录确实有 Chrome 数据时执行，重复调用安全。
 */
function inheritLegacySession(profileRootDir, targetDir) {
  if (!hasChromeData(profileRootDir)) return [];
  const copied = [];
  for (const entry of fs.readdirSync(profileRootDir, { withFileTypes: true })) {
    if (LEGACY_COPY_SKIP.has(entry.name)) continue;
    const from = path.join(profileRootDir, entry.name);
    const to = path.join(targetDir, entry.name);
    try {
      fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: true });
      copied.push(entry.name);
    } catch {
      // 单个条目复制失败不影响其他条目：Chrome 会自己重建缺失的缓存类文件
    }
  }
  return copied;
}

function namespaceManifestPath(profileId) {
  return path.join(resolveProfileDir(profileId), '.huayuan-namespaces.json');
}

/**
 * 确保某个命名空间的会话目录可用，并返回是否新建、是否继承了旧会话、是否需要单独登录。
 * 这里不做任何网络操作，纯文件系统。
 *
 * 继承规则（v0.3.2 起）：
 *   cas      → 首次建立时继承旧版共享会话，用户不必重新登录门户与教务
 *   ecourse  → 从空目录开始，不继承；需要用户为它单独登录一次
 *   rain     → 从空目录开始，不继承；需要用户为它单独登录一次
 * 需要单独登录时会写进 manifest 的 notice，由向导与首次对话明确提示，绝不静默。
 */
function ensureNamespaceDir(profileId, namespace) {
  const root = resolveProfileDir(profileId);
  const ns = normalizeNamespace(namespace);
  const target = resolveNamespaceDir(profileId, ns);
  ensureDir(root);

  const manifestPath = namespaceManifestPath(profileId);
  const manifest = readJson(manifestPath) || { profile_id: normalizeProfileId(profileId), namespaces: {} };
  manifest.namespaces = manifest.namespaces || {};
  const record = manifest.namespaces[ns] || {};

  /**
   * 一次性纠正 0.3.0/0.3.1 的旧行为：那两个版本把旧共享会话整份复制到了
   * ecourse 与 rain 目录，里面残留的跨站 Cookie 仍会把 eCourse 带偏。
   * 这里不改架构，只把被污染的目录**改名归档**（不删除），再以空目录重建，
   * 并在结果里明确告诉用户"需要各自登录一次"。
   */
  let rebuilt = null;
  const legacyCopyDetected =
    record &&
    record.created_at &&
    !Object.prototype.hasOwnProperty.call(record, 'inherited_from_legacy') &&
    !LEGACY_INHERIT_NAMESPACES.has(ns) &&
    fs.existsSync(target) &&
    hasChromeData(target);
  if (legacyCopyDetected) {
    const archived = `${target}.legacy-copy-${stamp()}`;
    try {
      fs.renameSync(target, archived);
      rebuilt = archived;
    } catch {
      rebuilt = null;
    }
  }

  // 目录已经有 Chrome 数据：直接复用，不再重复判断继承
  if (fs.existsSync(target) && hasChromeData(target)) {
    return {
      dir: target,
      namespace: ns,
      created: false,
      inherited: [],
      needs_login: Boolean(record.needs_login),
      notice: null,
    };
  }

  const reinitialized = fs.existsSync(target) && fs.readdirSync(target).length > 0;
  ensureDir(target);

  let inherited = [];
  let needsLogin = false;
  let notice = null;
  if (rebuilt) {
    needsLogin = true;
    notice = `「${NAMESPACE_LABEL[ns]}」旧版复制过来的共享会话已归档到独立目录，当前是空会话；需要为它单独登录一次（旧跨站 Cookie 会污染页面跳转）`;
  } else if (!reinitialized) {
    if (LEGACY_INHERIT_NAMESPACES.has(ns)) {
      inherited = inheritLegacySession(root, target);
      if (inherited.length) {
        notice = `「${NAMESPACE_LABEL[ns]}」已继承旧版共享会话（${inherited.length} 项），门户与教务不需要重新登录`;
      }
    } else if (hasChromeData(root)) {
      // 目录里确实有旧共享会话，但这一份不继承：必须让用户知道要单独登录一次
      needsLogin = true;
      notice = `「${NAMESPACE_LABEL[ns]}」的会话目录是新建的空目录，未继承旧共享登录态；需要为它单独登录一次（避免旧跨站 Cookie 把页面带偏）`;
    }
  }

  manifest.namespaces[ns] = {
    dir: ns,
    created_at: record.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    inherited_entries: inherited.length,
    inherited_from_legacy: inherited.length > 0,
    rebuilt_from_legacy_copy: Boolean(rebuilt),
    legacy_copy_archived_to: rebuilt ? path.basename(rebuilt) : record.legacy_copy_archived_to || null,
    needs_login: needsLogin || Boolean(record.needs_login),
    notice: notice || (record.notice && !rebuilt ? record.notice : null),
  };
  writeJson(manifestPath, manifest);
  return {
    dir: target,
    namespace: ns,
    created: true,
    inherited,
    needs_login: needsLogin || Boolean(record.needs_login),
    rebuilt_from_legacy_copy: Boolean(rebuilt),
    notice,
  };
}

// 读取命名空间提示（不落盘，只读 manifest + 目录现状），供向导结果页与首次对话展示。
// 已经重新登录过的平台要改成"已完成"的说法，否则用户会以为还要再登一次。
function namespaceNotices(profileId) {
  const manifest = readJson(namespaceManifestPath(profileId));
  if (!manifest || !manifest.namespaces) return [];
  const root = resolveProfileDir(profileId);
  return NAMESPACES.map((ns) => {
    const record = manifest.namespaces[ns] || null;
    if (!record || !record.notice) return null;
    const loggedIn = hasChromeData(path.join(root, ns));
    let notice = record.notice;
    if (record.rebuilt_from_legacy_copy) {
      notice = loggedIn
        ? `「${NAMESPACE_LABEL[ns]}」旧版复制的共享会话已归档，已用独立空会话重新登录，后续不再重复登录`
        : `「${NAMESPACE_LABEL[ns]}」旧版复制的共享会话已归档（原件保留在 ${record.legacy_copy_archived_to || '同目录'}），当前是空会话，需要单独登录一次`;
    }
    return {
      namespace: ns,
      label: NAMESPACE_LABEL[ns],
      notice,
      needs_login: Boolean(record.needs_login) && !loggedIn,
      resolved: loggedIn,
    };
  }).filter(Boolean);
}

// 列出槽位下已有的命名空间（只读，用于状态展示与诊断）
function listNamespaces(profileId) {
  const root = resolveProfileDir(profileId);
  if (!fs.existsSync(root)) return [];
  return NAMESPACES.map((ns) => ({
    namespace: ns,
    label: NAMESPACE_LABEL[ns],
    exists: hasChromeData(path.join(root, ns)),
    dir_hint: displayPath(path.join(root, ns)),
  }));
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

// 默认输出目录：当前工作区/huayuan-output/<时间戳>
function defaultOutputDir() {
  const override = process.env.HUAYUAN_OUTPUT_DIR;
  if (override && override.trim()) {
    return path.join(path.resolve(override.trim()), stamp());
  }
  return path.join(process.cwd(), 'huayuan-output', stamp());
}

// 诊断与日志里只写 ~ 开头的相对写法，避免把本机用户名写进产物
function displayPath(target) {
  const home = path.resolve(homeDir());
  const resolved = path.resolve(target);
  if (resolved.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${resolved.slice(home.length)}`;
  }
  return resolved;
}

function profileMetaPath(profileDir) {
  return path.join(profileDir, 'profile.json');
}

function ensureProfileMeta(profileDir, profileId) {
  ensureDir(profileDir);
  const metaPath = profileMetaPath(profileDir);
  if (fs.existsSync(metaPath)) return readJson(metaPath);
  const meta = {
    profile_id: normalizeProfileId(profileId),
    created_at: new Date().toISOString(),
    note: '仅存放浏览器会话，不含姓名、学号、密码或票据；切换学校账号请另建 profile-id',
  };
  writeJson(metaPath, meta);
  return meta;
}

function listProfiles() {
  const root = profileRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const meta = readJson(profileMetaPath(path.join(root, entry.name))) || {};
      return {
        profile_id: entry.name,
        created_at: meta.created_at || null,
        last_used_at: meta.last_used_at || null,
      };
    })
    .sort((a, b) => String(a.profile_id).localeCompare(String(b.profile_id)));
}

function configPath() {
  return path.join(appDataRoot(), 'config.json');
}

function readConfig() {
  return readJson(configPath());
}

/**
 * 旧配置自动迁移（幂等，只在确有变化时写盘）。
 *
 * 迁移规则：
 * 1. student_type 一律归一到 undergraduate（本专家只服务本科生）
 * 2. 研究生专属字段删除
 * 3. schema_version 升到当前版本
 *
 * 返回值会写进运行报告，让用户知道"配置被改过、为什么改"。
 */
function migrateConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return { migrated: false, reason: 'no_config' };
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') return { migrated: false, reason: 'unreadable_config' };

  const changes = [];
  const next = { ...raw };
  const previousType =
    raw.student_type === undefined || raw.student_type === null ? null : String(raw.student_type);

  if (previousType !== STUDENT_TYPE) {
    next.student_type = STUDENT_TYPE;
    next.student_type_migrated_from = previousType;
    next.student_type_migrated_at = new Date().toISOString();
    changes.push(`student_type: ${previousType || '未设置'} → ${STUDENT_TYPE}`);
  }
  if (next.student_type_locked !== true) {
    next.student_type_locked = true;
    changes.push('student_type_locked: → true（固定本科生，不可再切换）');
  }
  for (const key of GRADUATE_ONLY_KEYS) {
    if (key in next) {
      delete next[key];
      changes.push(`removed: ${key}（研究生专属字段）`);
    }
  }
  const currentSchema = Number(raw.schema_version || 0);
  if (currentSchema < CONFIG_SCHEMA_VERSION) {
    next.schema_version = CONFIG_SCHEMA_VERSION;
    changes.push(`schema_version: ${currentSchema} → ${CONFIG_SCHEMA_VERSION}`);
  }

  if (!changes.length) return { migrated: false, reason: 'already_current' };
  next.updated_at = new Date().toISOString();
  writeJson(file, next);
  return {
    migrated: true,
    changes,
    from_student_type: previousType,
    to_student_type: STUDENT_TYPE,
    from_schema_version: currentSchema,
    to_schema_version: CONFIG_SCHEMA_VERSION,
  };
}

function writeConfig(config) {
  const previous = readConfig() || {};
  const merged = {
    created_at: previous.created_at || new Date().toISOString(),
    ...previous,
    ...config,
    // 下面两个字段不接受外部覆盖：schema 版本与「固定本科生」口径
    schema_version: CONFIG_SCHEMA_VERSION,
    student_type: STUDENT_TYPE,
    updated_at: new Date().toISOString(),
  };
  writeJson(configPath(), merged);
  return merged;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 持久初始化标记（写进 config.json）。
 *
 * 为什么需要：专家每次新开会话都不知道用户到底初始化过没有，
 * 结果老用户每次都被重新引导一遍。这里落一份跨会话可读的状态：
 *   setup_state          uninitialized / partial / completed
 *   setup_completed_at   首次真正完成的时间（只在三源都读到且分析可用时写）
 *   last_onboarding_report 最近一次初始化报告路径
 *
 * 判定"完成"的权力在 onboarding.js，这里只负责读写，避免两处各自定义标准。
 */
function readSetupState() {
  const config = readConfig() || {};
  const state = SETUP_STATES.includes(config.setup_state) ? config.setup_state : 'uninitialized';
  return {
    state,
    label: SETUP_LABEL[state],
    initialized: state === 'completed',
    completed_at: config.setup_completed_at || null,
    last_completed_at: config.setup_last_completed_at || null,
    updated_at: config.setup_updated_at || null,
    last_report: config.last_onboarding_report || null,
    detail: config.setup_detail || null,
    missing: (config.setup_detail && config.setup_detail.missing) || [],
    partial: (config.setup_detail && config.setup_detail.partial) || [],
  };
}

/**
 * 写初始化状态。只允许三态，未知值直接报错，避免出现第四种"看起来完成"的状态。
 * completed 时才写 setup_completed_at；退回 partial 时把上次完成时间留在
 * setup_last_completed_at，作为历史记录而不是当前状态。
 */
function writeSetupState({ state, reportPath = null, detail = null } = {}) {
  if (!SETUP_STATES.includes(state)) {
    throw new Error(`INVALID_SETUP_STATE: ${state}`);
  }
  const previous = readConfig() || {};
  const now = new Date().toISOString();
  const patch = {
    setup_state: state,
    setup_updated_at: now,
  };
  if (reportPath) patch.last_onboarding_report = reportPath;
  if (detail) patch.setup_detail = detail;
  if (state === 'completed') {
    patch.setup_completed_at = now;
    patch.setup_last_completed_at = now;
  } else {
    // 只有 completed 才允许有 setup_completed_at：避免别的模块只读这一个字段就误判"已完成"
    patch.setup_completed_at = null;
    const history = previous.setup_completed_at || previous.setup_last_completed_at || null;
    if (history) patch.setup_last_completed_at = history;
  }
  return writeConfig(patch);
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function argValue(argv, name, fallback = null) {
  const list = Array.isArray(argv) ? argv : process.argv;
  const index = list.indexOf(name);
  if (index >= 0) {
    const next = list[index + 1];
    if (next && !next.startsWith('--')) return next;
    return fallback === null ? '' : fallback;
  }
  const inline = list.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  return fallback;
}

function flag(argv, name) {
  const list = Array.isArray(argv) ? argv : process.argv;
  return list.includes(name);
}

/**
 * 解析本次运行使用哪个匿名账号槽位。
 * 优先级：--profile-id > --profile-dir > 配置文件 > default
 * 显式传入与配置不一致时返回 override=true，由调用方提示"本次切到了另一个账号槽位"。
 *
 * 注意 profileDir 的语义：
 *   - 只有显式 --profile-dir 才会返回它（测试/便携场景的整体覆盖）
 *   - 其余情况返回 null，让 session-gateway 按平台选题自己的命名空间目录
 *     （profiles/<id>/cas | ecourse | rain），避免三个平台共用一份 Cookie
 *   - profileRootDir 永远指向 profiles/<id>，用于展示与元数据写入
 */
function readProfileSelection(argv = process.argv) {
  // 每次读取配置前先做一次幂等迁移：旧版（含研究生配置）会被静默归一到本科生口径
  const migration = migrateConfig();
  const explicitId = argValue(argv, '--profile-id', null);
  const explicitDir = argValue(argv, '--profile-dir', null);
  const config = readConfig() || {};
  const configId = config.profile_id ? normalizeProfileId(config.profile_id) : null;

  if (explicitDir) {
    return {
      profileId: normalizeProfileId(explicitId || configId || DEFAULT_PROFILE_ID),
      profileDir: path.resolve(explicitDir),
      profileRootDir: path.resolve(explicitDir),
      profile_dir_explicit: true,
      source: 'arg:profile-dir',
      override: Boolean(explicitId && configId && explicitId !== configId),
      configured_id: configId,
      config_migration: migration.migrated ? migration : null,
    };
  }
  if (explicitId) {
    const id = normalizeProfileId(explicitId);
    return {
      profileId: id,
      profileDir: null,
      profileRootDir: resolveProfileDir(id),
      profile_dir_explicit: false,
      source: 'arg:profile-id',
      override: Boolean(configId && id !== configId),
      configured_id: configId,
      config_migration: migration.migrated ? migration : null,
    };
  }
  if (configId) {
    return {
      profileId: configId,
      profileDir: null,
      profileRootDir: resolveProfileDir(configId),
      profile_dir_explicit: false,
      source: 'config',
      override: false,
      configured_id: configId,
      config_migration: migration.migrated ? migration : null,
    };
  }
  return {
    profileId: DEFAULT_PROFILE_ID,
    profileDir: null,
    profileRootDir: defaultProfileDir(),
    profile_dir_explicit: false,
    source: 'default',
    override: false,
    configured_id: null,
    config_migration: migration.migrated ? migration : null,
  };
}

/**
 * 授权校验：首次运行向导里没勾选的平台，脚本不应悄悄打开。
 * 未初始化配置时按"允许"处理，避免老用户机器上首次使用被卡住。
 */
function checkAuthorization(platform) {
  migrateConfig();
  const config = readConfig();
  const list = config && Array.isArray(config.authorized_platforms) ? config.authorized_platforms : null;
  if (!list || !list.length) {
    return { authorized: true, configured: false, reason: '未初始化配置，按默认允许' };
  }
  const authorized = list.includes(platform);
  return {
    authorized,
    configured: true,
    reason: authorized
      ? `${platform} 已在授权列表内`
      : `${platform} 不在授权列表（当前授权：${list.join(',')}），可用 first-run.js 重新选择`,
  };
}

// 0.2.x 用的是 <appDataRoot>/profile 单目录；0.3.0 改为 profiles/<id>。
// 升级时把旧的 default 槽位整体改名，避免用户重新登录一次。
function migrateLegacyProfile(profileId = DEFAULT_PROFILE_ID) {
  const id = normalizeProfileId(profileId);
  const target = resolveProfileDir(id);
  if (fs.existsSync(target)) return { migrated: false, reason: 'target_exists' };
  if (id !== DEFAULT_PROFILE_ID) return { migrated: false, reason: 'not_default_slot' };
  const legacy = path.join(appDataRoot(), 'profile');
  if (!fs.existsSync(legacy)) return { migrated: false, reason: 'no_legacy' };
  try {
    ensureDir(profileRoot());
    fs.renameSync(legacy, target);
    return { migrated: true, from: legacy, to: target };
  } catch (error) {
    return { migrated: false, reason: String(error.message || error).split('\n')[0] };
  }
}

module.exports = {
  APP_DIR_NAME,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_NAMESPACE,
  DEFAULT_PROFILE_ID,
  NAMESPACES,
  NAMESPACE_LABEL,
  PLATFORM_NAMESPACE,
  SETUP_LABEL,
  SETUP_STATES,
  STUDENT_TYPE,
  STUDENT_TYPE_LABEL,
  argValue,
  appDataRoot,
  checkAuthorization,
  configPath,
  defaultOutputDir,
  defaultProfileDir,
  displayPath,
  ensureDir,
  ensureNamespaceDir,
  ensureProfileMeta,
  flag,
  homeDir,
  listNamespaces,
  listProfiles,
  migrateConfig,
  migrateLegacyProfile,
  namespaceNotices,
  normalizeNamespace,
  normalizeProfileId,
  platformNamespace,
  profileRoot,
  readConfig,
  readJson,
  readProfileSelection,
  readSetupState,
  resolveNamespaceDir,
  resolvePlatformDir,
  resolveProfileDir,
  stamp,
  writeConfig,
  writeJson,
  writeSetupState,
};
