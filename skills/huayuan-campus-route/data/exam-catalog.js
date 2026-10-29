'use strict';

/**
 * 示例考试目录（虚构数据，不对应任何真实考试安排）
 *
 * 用途：在没有导入真实考试 JSON 时，展示“按专业筛选 + 自动拆复习任务”的效果。
 * 页面会明确标注“示例考试（虚构）”；不要把它当成教务发布的考试时间。
 *
 * 真实导入格式（exams.json / jw-exams.json）：
 * {
 *   "source": "教务考试安排",
 *   "exams": [
 *     { "id": "...", "title": "数据结构期中", "course": "数据结构",
 *       "date": "2026-11-06", "start": "09:00", "end": "11:00",
 *       "venue": "A3-201", "type": "midterm", "scope": "school",
 *       "majors": ["软件工程", "计算机科学与技术"], "credits": 4 }
 *   ]
 * }
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HuayuanExamCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEMO_EXAMS = {
    demo: true,
    source: '示例考试（虚构）',
    note: '仅用于演示“按专业筛选 + 自动拆复习任务”，不是教务真实考试安排。',
    exams: [
      {
        id: 'demo-ds-mid',
        title: '数据结构期中',
        course: '数据结构',
        date: '2026-11-06',
        start: '09:00',
        end: '11:00',
        venue: 'A3-201',
        type: 'midterm',
        scope: 'school',
        majors: ['软件工程', '计算机科学与技术', '网络工程'],
        credits: 4,
        demo: true,
      },
      {
        id: 'demo-math-mid',
        title: '高等数学（上）期中',
        course: '高等数学',
        date: '2026-11-12',
        start: '14:30',
        end: '16:30',
        venue: 'A1-101',
        type: 'midterm',
        scope: 'school',
        majors: ['软件工程', '计算机科学与技术', '网络工程', '建筑学'],
        credits: 5,
        demo: true,
      },
      {
        id: 'demo-os-mid',
        title: '操作系统期中',
        course: '操作系统',
        date: '2026-11-09',
        start: '09:00',
        end: '11:00',
        venue: 'A4-302',
        type: 'midterm',
        scope: 'school',
        majors: ['计算机科学与技术'],
        credits: 4,
        demo: true,
      },
      {
        id: 'demo-english-final',
        title: '大学英语（校级期末）',
        course: '大学英语',
        date: '2027-01-08',
        start: '09:00',
        end: '11:00',
        venue: 'A2-205',
        type: 'final',
        scope: 'school',
        majors: ['软件工程', '计算机科学与技术', '网络工程'],
        credits: 3,
        demo: true,
      },
    ],
  };

  return { DEMO_EXAMS };
});
