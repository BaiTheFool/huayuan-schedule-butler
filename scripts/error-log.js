#!/usr/bin/env node
/*
 * 华园日程管家 · 运行时错误日志（追加式）
 * 用法：
 *   node scripts/error-log.js --code <CODE> --message <MSG> [--severity error|warn|info] [--context '{"k":"v"}'] [--file <相对路径>]
 *   node scripts/error-log.js --list [--n 20]     # 查看最近 N 条
 *   node scripts/error-log.js --stat              # 按 code / severity 统计
 * 输出：<项目根>/logs/errors.jsonl（一行一条 JSON，UTF-8，只追加不覆盖）
 * 注意：本脚本只记录脱敏诊断信息（状态/错误码/原因），禁止写入账号、密码、Cookie、Token、学号等敏感内容。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'errors.jsonl');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return def;
}
const hasFlag = (name) => process.argv.includes('--' + name);

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readLines() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
}

function main() {
  if (hasFlag('list')) {
    const n = parseInt(arg('n', '20'), 10);
    const lines = readLines();
    lines.slice(-n).forEach((l) => {
      try { console.log(JSON.stringify(JSON.parse(l))); } catch { console.log(l); }
    });
    console.log(`TOTAL:${lines.length}`);
    return;
  }
  if (hasFlag('stat')) {
    const lines = readLines();
    const byCode = {};
    const bySev = {};
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        byCode[e.code] = (byCode[e.code] || 0) + 1;
        bySev[e.severity] = (bySev[e.severity] || 0) + 1;
      } catch { /* 跳过坏行 */ }
    }
    console.log('BY_CODE ' + JSON.stringify(byCode));
    console.log('BY_SEVERITY ' + JSON.stringify(bySev));
    console.log(`TOTAL:${lines.length}`);
    return;
  }
  const code = arg('code', '');
  const message = arg('message', '');
  if (!code || !message) {
    console.error('用法：--code <CODE> --message <MSG> [--severity error|warn|info] [--context <JSON>] [--file <rel>] | --list | --stat');
    process.exit(2);
  }
  const severity = arg('severity', 'error');
  const ctxRaw = arg('context', '');
  let context = {};
  try { context = ctxRaw ? JSON.parse(ctxRaw) : {}; } catch { context = { raw: ctxRaw }; }
  const entry = {
    ts: new Date().toISOString(),
    severity,
    code,
    message,
    file: arg('file', '') || null,
    context,
  };
  ensureDir();
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  console.log('LOGGED:' + JSON.stringify(entry));
}

main();
