'use strict';

/**
 * 教务课表导入校验（jw-timetable.json → 路线引擎可用的数据）
 *
 * 只做三件事：
 *   1. 判断这份课表是不是大学城校区，别把五山教室硬套过来；
 *   2. 数清课程、缺时间字段、当前教学周；
 *   3. 给出 warnings，页面/CLI 据此提示“哪些要人工确认”。
 *
 * 不访问网络、不登录、不写学校系统。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HuayuanTimetable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function parseTime(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 24 || m > 59) return null;
    return h * 60 + m;
  }

  function parseDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime());
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function mondayOf(date) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  }

  function campusTextOf(raw) {
    const campus = raw && raw.campus;
    const courses = (raw && raw.courses) || [];
    const parts = [
      typeof campus === 'string' ? campus : campus && campus.label,
      campus && campus.key,
      ...courses.map((course) => course && course.campus),
    ].filter(Boolean);
    return Array.from(new Set(parts.map(String))).join(' ');
  }

  function resolveCampus(raw) {
    const text = campusTextOf(raw);
    if (/五山|广州国际|国际校区/.test(text)) {
      return { key: 'unsupported', label: text.trim(), supported: false, text };
    }
    if (/大学城|university[_ ]?town/i.test(text)) {
      return { key: 'university_town', label: '大学城校区', supported: true, text };
    }
    return { key: 'unknown', label: text.trim() || '未识别校区', supported: true, text };
  }

  function weekNumberForDate(raw, date) {
    const startText =
      (raw && raw.semester && raw.semester.first_week_start) ||
      (raw && raw.first_week_start) ||
      (raw && raw.semester && raw.semester.start_date) ||
      null;
    const start = parseDate(startText);
    const target = parseDate(date);
    if (!start || !target) return null;
    const startMonday = mondayOf(start);
    const targetMonday = mondayOf(target);
    const diff = Math.round((targetMonday.getTime() - startMonday.getTime()) / 86400000);
    const week = Math.floor(diff / 7) + 1;
    return week >= 1 && week <= 30 ? week : null;
  }

  function courseMatchesWeek(course, week) {
    if (!week) return true;
    const weeks = course && course.weeks;
    if (!weeks) return true;
    const list = Array.isArray(weeks.list) ? weeks.list : [];
    if (list.length) return list.includes(Number(week));
    const ranges = Array.isArray(weeks.ranges) ? weeks.ranges : [];
    if (ranges.length) {
      return ranges.some(([a, b]) => Number(week) >= Number(a) && Number(week) <= Number(b));
    }
    return true;
  }

  function summarizeTimetable(raw, options) {
    const opts = options || {};
    const warnings = [];
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'INVALID_JSON', message: '文件不是合法的课表 JSON', warnings };
    }
    const courses = Array.isArray(raw) ? raw : Array.isArray(raw.courses) ? raw.courses : null;
    if (!courses) {
      return { ok: false, error: 'NO_COURSES', message: '没找到 courses 数组；请确认选择的是 jw-timetable.json', warnings };
    }
    if (!courses.length) {
      return { ok: false, error: 'NO_COURSES', message: '课表里 0 门课程，不能当作已导入', warnings };
    }

    const campus = resolveCampus(Array.isArray(raw) ? { courses: raw } : raw);
    if (!campus.supported) {
      return {
        ok: false,
        error: 'CAMPUS_UNSUPPORTED',
        message: `这份课表是 ${campus.label}，当前路线只覆盖大学城校区，未导入。`,
        campus,
        warnings: ['五山/广州国际校区需要另一套 POI 与步行图'],
      };
    }
    if (campus.key === 'unknown') {
      warnings.push('课表没写校区；教室名按 A1–A5 匹配，请确认这份课表确实是大学城校区');
    }

    const week = weekNumberForDate(Array.isArray(raw) ? {} : raw, opts.date);
    let missingTime = 0;
    let usable = 0;
    for (const course of courses) {
      const hasTime = parseTime(course && course.start_time) !== null && parseTime(course && course.end_time) !== null;
      if (!hasTime) missingTime += 1;
      else usable += 1;
    }
    if (missingTime) warnings.push(`${missingTime} 门课程缺少合法起止时间，排路线时会跳过`);
    if (week === null) {
      warnings.push('没识别出当前教学周；有周次范围的课程会按“可能发生”全部计入，请人工确认');
    }
    if (raw.status && raw.status !== 'READ_OK') {
      warnings.push(`教务读取状态是 ${raw.status}，可能有课程没读全`);
    }

    const active = week ? courses.filter((course) => courseMatchesWeek(course, week)).length : courses.length;
    return {
      ok: true,
      error: null,
      timetable: Array.isArray(raw) ? { courses } : raw,
      campus,
      week_number: week,
      summary: {
        total: courses.length,
        usable,
        missing_time: missingTime,
        active,
        week_number: week,
      },
      warnings,
    };
  }

  function parseTimetableText(text, options) {
    let raw;
    try {
      raw = JSON.parse(String(text || ''));
    } catch (error) {
      return { ok: false, error: 'INVALID_JSON', message: `JSON 解析失败：${error.message}`, warnings: [] };
    }
    return summarizeTimetable(raw, options);
  }

  return {
    parseTime,
    parseDate,
    weekNumberForDate,
    summarizeTimetable,
    parseTimetableText,
    resolveCampus,
  };
});
