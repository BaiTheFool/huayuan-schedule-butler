'use strict';

/**
 * 平台入口集中定义：只用学校通用域名，不绑定任何个人路径、课程 id 或学期码。
 *
 * 移植到其他学校时，只需用环境变量覆盖基址，无需改代码：
 *   HUAYUAN_SSO_BASE / HUAYUAN_PORTAL_BASE / HUAYUAN_ECOURSE_BASE
 *   HUAYUAN_RAIN_BASE / HUAYUAN_JW_BASE
 */

const DEFAULT_BASES = {
  sso: 'https://sso.scut.edu.cn',
  portal: 'https://my.scut.edu.cn',
  ecourse: 'https://ecourse.scut.edu.cn',
  rain: 'https://scut.yuketang.cn',
  jw: 'http://xsjw2018.jw.scut.edu.cn',
};

function base(name) {
  const envKey = `HUAYUAN_${name.toUpperCase()}_BASE`;
  const raw = (process.env[envKey] || DEFAULT_BASES[name] || '').trim();
  return raw.replace(/\/+$/, '');
}

function hostOf(name) {
  try {
    return new URL(base(name)).host;
  } catch {
    return '';
  }
}

function hostPattern(name) {
  const host = hostOf(name);
  if (!host) return /$^/;
  return new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

// eCourse 一律从根地址进入并跟随 302，由站点自己带 id；绝不拼接无参 index.html
const ECOURSE_ROOT = `${base('ecourse')}/`;

const PLATFORM_URLS = {
  rain: `${base('rain')}/pro/courselist`,
  portal: `${base('portal')}/`,
  ecourse: ECOURSE_ROOT,
  jw: `${base('jw')}/`,
};

const HOSTS = {
  sso: hostOf('sso'),
  portal: hostOf('portal'),
  ecourse: hostOf('ecourse'),
  rain: hostOf('rain'),
  jw: hostOf('jw'),
};

const HOST_PATTERNS = {
  sso: hostPattern('sso'),
  portal: hostPattern('portal'),
  ecourse: hostPattern('ecourse'),
  rain: hostPattern('rain'),
  jw: hostPattern('jw'),
};

const ENDPOINTS = {
  rain_courselist: PLATFORM_URLS.rain,
  rain_user_courses: `${base('rain')}/mooc-api/v1/lms/user/user-courses/`,
  rain_todo_list: (classroomId, skuId) =>
    `${base('rain')}/c27/online_courseware/course/classroom/${classroomId}/${skuId}/todo_list/?client_type=web&term=latest`,
};

module.exports = {
  DEFAULT_BASES,
  ECOURSE_ROOT,
  ENDPOINTS,
  HOSTS,
  HOST_PATTERNS,
  PLATFORM_URLS,
  base,
};
