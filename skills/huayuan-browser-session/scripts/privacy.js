'use strict';

/**
 * 诊断脱敏：任何落盘产物都不得包含票据、Cookie、学号、姓名名单。
 * 只允许保留：标题、状态、计数、错误原因、截断摘录。
 */

const TICKET_PARAM = /\b(ticket|token|access_token|code|sessionid|jsessionid|csrftoken|auth)=[^&\s"']+/gi;
const LONG_DIGITS = /\d{9,}/g;
const ID_CARD = /\b\d{17}[\dXx]\b/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const MOBILE = /\b1[3-9]\d{9}\b/g;
const ROSTER_HINT =
  /student_?list|stu_?list|studentlist|member_?list|userlist|usergroup|roster|班级成员|学生名单|选课名单|成绩单|score_?list|grade_?list/i;
const ROSTER_TEXT = /(学号|姓名)[\s\S]{0,20}(学号|姓名)/;

function maskSecrets(text) {
  return String(text || '').replace(TICKET_PARAM, (match, name) => `${name}=***`);
}

function sanitizeUrl(url) {
  return maskSecrets(String(url || '')).replace(/#.*$/, '');
}

function sanitizeExcerpt(text, limit = 240) {
  let value = maskSecrets(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
  value = value
    .replace(ID_CARD, '[证件号已脱敏]')
    .replace(MOBILE, '[手机号已脱敏]')
    .replace(EMAIL, '[邮箱已脱敏]')
    .replace(LONG_DIGITS, '[长数字已脱敏]');
  if (value.length > limit) value = `${value.slice(0, limit)}…`;
  return value;
}

// 名单类页面整段跳过，避免把学生姓名/学号写进诊断
function looksLikeRoster(url, text) {
  if (ROSTER_HINT.test(String(url || ''))) return true;
  const compact = String(text || '').replace(/\s+/g, ' ').slice(0, 1200);
  return ROSTER_TEXT.test(compact);
}

function safeFrameExcerpt(url, text, limit = 240) {
  if (looksLikeRoster(url, text)) return '[已跳过：疑似名单/成绩页面]';
  return sanitizeExcerpt(text, limit);
}

function safeTitle(title) {
  return sanitizeExcerpt(title, 120);
}

module.exports = {
  looksLikeRoster,
  maskSecrets,
  safeFrameExcerpt,
  safeTitle,
  sanitizeExcerpt,
  sanitizeUrl,
};
