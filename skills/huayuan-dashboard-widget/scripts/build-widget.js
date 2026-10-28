'use strict';

const fs = require('fs');
const path = require('path');

const MAX_WIDGET_BYTES = 30 * 1024;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clip(value, limit = 64) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sourceLabel(row) {
  const kind = String(row.kind || '');
  const source = String(row.source || '');
  if (kind === 'rest' || kind === 'break') return '休息';
  if (kind === 'fixed' || kind === 'class') return '固定';
  if (/eCourse|雨课堂/i.test(source)) return source;
  if (kind === 'task' || kind === 'study') return '任务';
  if (kind === 'personal') return '个人';
  return '安排';
}

function sourceClass(row) {
  const label = sourceLabel(row);
  if (label === '休息') return 'rest';
  if (label === '固定') return 'fixed';
  if (label === '个人') return 'personal';
  if (label === '任务') return 'task';
  return 'platform';
}

function sanitizeRows(nowDoc) {
  const sequence = Array.isArray(nowDoc.sequence) ? nowDoc.sequence : [];
  return sequence
    .filter((row) => row && row.start && row.end && row.title)
    .slice(0, 3)
    .map((row) => ({
      start: String(row.start).slice(0, 5),
      end: String(row.end).slice(0, 5),
      title: clip(row.title, 42),
      source: sourceLabel(row),
      sourceClass: sourceClass(row),
      detail:
        row.kind === 'task'
          ? `${Number(row.minutes) || 0} 分钟${row.priority ? ` · ${escapeHtml(row.priority)}` : ''}`
          : row.kind === 'rest'
            ? `${Number(row.minutes) || 0} 分钟`
            : row.course
              ? clip(row.course, 28)
              : '',
    }));
}

function renderFallback(reason) {
  return `<div class="hyw" role="region" aria-label="华园日程驾驶舱">
<style>
.hyw{--ink:#15231e;--soft:#617069;--paper:#fffaf0;--line:#e8dfd0;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif;color:var(--ink);background:transparent;max-width:680px;margin:4px auto}
.hyw-card{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:18px}.hyw small{color:var(--soft);font-size:11px}.hyw h3{font-size:20px;margin:6px 0 10px}.hyw p{font-size:13px;line-height:1.7;margin:0;color:var(--soft)}
@media(prefers-color-scheme:dark){.hyw{--ink:#edf5f0;--soft:#aab8b0;--paper:#17221d;--line:#35463e}.hyw-card{background:var(--paper);border-color:var(--line)}}
</style>
<div class="hyw-card"><small>华园日程管家</small><h3>暂时没有可展示的最新安排</h3><p>${escapeHtml(reason || '请先完成初始化或重新计算当前安排。')}</p></div>
</div>`;
}

/**
 * show_widget 失败时的降级文案：只给"第一动作 + 下一步"，一条话说完。
 * 不生成 HTML 文件、不启动本地服务器。
 */
function buildTextFallback(nowDoc, reason) {
  if (!nowDoc || !nowDoc.now || !nowDoc.first_action) {
    const extra = reason && reason !== 'NOW_DATA_MISSING' ? `原因：${clip(reason, 40)}。` : '';
    return `暂时没有可展示的最新安排。${extra}下一步：先完成初始化，或重新生成 now.json。`;
  }
  const status = nowDoc.data_status || {};
  const pending = Array.isArray(status.pending) ? status.pending.length : 0;
  const partial = Boolean(status.estimate_only || pending);
  const first = nowDoc.first_action || {};
  const head = partial ? '（数据未确认，以下为估算）' : '';
  const action = clip(first.headline, 80) || '当前没有明确的第一动作';
  const next = clip(first.next_hint || first.detail, 60) || '按上面的第一动作执行';
  return `${head}${action}。下一步：${next}。`;
}

function buildWidget(nowDoc) {
  if (!nowDoc || !nowDoc.now || !nowDoc.first_action) {
    return {
      title: '华园日程驾驶舱',
      loading_messages: ['正在读取最新安排…'],
      widget_code: renderFallback('请先完成初始化或重新计算当前安排。'),
      text_fallback: buildTextFallback(nowDoc, 'NOW_DATA_MISSING'),
      meta: { ok: false, reason: 'NOW_DATA_MISSING' },
    };
  }

  const clock = nowDoc.now || {};
  const first = nowDoc.first_action || {};
  const dataStatus = nowDoc.data_status || {};
  const pending = Array.isArray(dataStatus.pending) ? dataStatus.pending.length : 0;
  const partial = Boolean(dataStatus.estimate_only || pending);
  const rows = sanitizeRows(nowDoc);
  const sequenceHtml = rows.length
    ? rows
        .map(
          (row) => `<li class="hyw-row">
<time>${escapeHtml(row.start)}–${escapeHtml(row.end)}</time>
<span class="hyw-dot ${row.sourceClass}"></span>
<div><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.detail || row.source)}</small></div>
<em>${escapeHtml(row.source)}</em>
</li>`
        )
        .join('')
    : '<li class="hyw-empty">当前没有可展示的后续安排。</li>';

  const widgetCode = `<div class="hyw" role="region" aria-label="华园日程驾驶舱">
<style>
.hyw{--ink:#15231e;--soft:#62706a;--paper:#fffaf0;--line:#e7ddcc;--accent:#b84f32;--green:#1e7358;--yellow:#9d7100;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif;color:var(--ink);background:transparent;max-width:720px;margin:4px auto}
.hyw *{box-sizing:border-box}.hyw-card{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:18px}.hyw-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}.hyw-kicker{font-size:11px;font-weight:800;letter-spacing:.14em;color:var(--accent)}.hyw h3{font-size:24px;line-height:1.25;margin:5px 0 0;font-family:"Songti SC","STSong",serif}.hyw-time{text-align:right;font-size:13px;color:var(--soft);white-space:nowrap}.hyw-time b{display:block;font-size:19px;color:var(--ink);margin-bottom:3px}.hyw-action{padding:17px 18px;border-radius:12px;color:#f7fffa;background:#1e5d49}.hyw-label{font-size:11px;letter-spacing:.12em;color:rgba(247,255,250,.78)}.hyw-action h4{font-size:20px;line-height:1.4;margin:7px 0 8px}.hyw-action p{font-size:13px;line-height:1.65;margin:0;color:rgba(247,255,250,.82)}.hyw-alert{margin:10px 0 0;padding:9px 11px;border-radius:10px;background:#f6ebce;color:#6d5217;font-size:12px;line-height:1.55}.hyw-list{list-style:none;padding:0;margin:14px 0 0}.hyw-row{display:grid;grid-template-columns:80px 10px minmax(0,1fr) auto;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--line)}.hyw-row:last-child{border-bottom:0}.hyw-row time{font:600 12px/1.3 Georgia,serif;color:var(--soft)}.hyw-dot{width:8px;height:8px;border-radius:50%;background:var(--green)}.hyw-dot.rest{background:var(--yellow)}.hyw-dot.task{background:var(--accent)}.hyw-dot.personal{background:#7d638e}.hyw-row strong{display:block;font-size:13px;line-height:1.45}.hyw-row small{display:block;color:var(--soft);font-size:11px;margin-top:3px}.hyw-row em{font-style:normal;font-size:11px;padding:4px 7px;border-radius:999px;background:rgba(21,35,30,.06);color:var(--soft);white-space:nowrap}.hyw-foot{display:flex;justify-content:space-between;gap:10px;margin-top:13px;padding-top:12px;border-top:1px solid var(--line);font-size:11px;color:var(--soft)}.hyw-foot b{color:var(--ink)}.hyw-empty{font-size:12px;color:var(--soft);padding:12px 0}.hyw-pill{display:inline-flex;align-items:center;gap:5px;margin-top:8px;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:700}.hyw-pill.partial{background:#f6ebce;color:#6d5217}.hyw-pill.ready{background:#dcecdf;color:#245440}.hyw-pill:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}@media(prefers-color-scheme:dark){.hyw{--ink:#edf5f0;--soft:#aab8b0;--paper:#17221d;--line:#35463e;--accent:#f09272;--green:#77c5a4;--yellow:#e3b94f}.hyw-card{background:var(--paper);border-color:var(--line)}.hyw-action{background:#245b49}.hyw-alert{background:#3b321d;color:#f1dc9d}.hyw-row em{background:rgba(255,255,255,.07)}.hyw-pill.partial{background:#3b321d;color:#f1dc9d}.hyw-pill.ready{background:#1f3a2f;color:#9cd4b3}}@media(max-width:520px){.hyw-card{padding:14px}.hyw-action h4{font-size:18px}.hyw-row{grid-template-columns:68px 8px minmax(0,1fr)}.hyw-row em{display:none}.hyw-foot{display:block}.hyw-foot span{display:block;margin-top:5px}}
</style>
<div class="hyw-card">
<div class="hyw-head">
  <div><div class="hyw-kicker">HUAYUAN / NOW</div><h3>今天怎么走</h3><div class="hyw-pill ${partial ? 'partial' : 'ready'}">${partial ? '部分数据，先看第一动作' : '数据已整理'}</div></div>
  <div class="hyw-time"><b>${escapeHtml(clock.time || '--:--')}</b>${escapeHtml(clock.weekday || '')} ${escapeHtml(clock.date || '')}</div>
</div>
<div class="hyw-action">
  <div class="hyw-label">唯一第一动作</div>
  <h4>${escapeHtml(clip(first.headline, 72))}</h4>
  <p>${escapeHtml(clip(first.next_hint || first.detail, 110))}</p>
</div>
${partial ? `<div class="hyw-alert">${pending ? `${pending} 条数据待确认。` : ''}当前结果用于先行动，不作最终精确排程。</div>` : ''}
<ul class="hyw-list">${sequenceHtml}</ul>
<div class="hyw-foot"><span><b>修改方式</b>：完成X / 延后到… / 临时新增…</span><span>更多细节继续问阿序</span></div>
</div>
</div>`;

  if (Buffer.byteLength(widgetCode, 'utf8') > MAX_WIDGET_BYTES) {
    return {
      title: '华园日程驾驶舱',
      loading_messages: ['正在压缩驾驶舱…'],
      widget_code: renderFallback('安排内容过多，已切换为精简模式。'),
      text_fallback: buildTextFallback(nowDoc, 'WIDGET_TOO_LARGE'),
      meta: { ok: false, reason: 'WIDGET_TOO_LARGE' },
    };
  }

  return {
    title: '华园日程驾驶舱',
    loading_messages: ['正在读取最新安排…', '正在整理你的第一动作…'],
    widget_code: widgetCode,
    text_fallback: buildTextFallback(nowDoc, null),
    meta: {
      ok: true,
      clock: clock.display || null,
      first_action_type: first.type || null,
      sequence_rows: rows.length,
      pending_count: pending,
      partial,
      bytes: Buffer.byteLength(widgetCode, 'utf8'),
    },
  };
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function selfCheck() {
  const sample = {
    now: { date: '2026-11-04', time: '14:20', weekday: '周三', display: '2026-11-04 14:20' },
    first_action: {
      type: 'go_to_class',
      headline: '先去上课：生产运作管理（样例）（14:30-16:10）',
      next_hint: '下课后做「第 6 章作业（样例）」（16:30-18:00）',
    },
    data_status: { estimate_only: false, pending: [] },
    sequence: [
      { start: '16:30', end: '18:00', minutes: 90, kind: 'task', title: '第 6 章作业（样例）', source: 'eCourse', priority: 'P0' },
      { start: '21:10', end: '22:10', minutes: 60, kind: 'rest', title: '休息' },
    ],
  };
  const result = buildWidget(sample);
  const empty = buildWidget(null);
  const partialDoc = {
    ...sample,
    data_status: { estimate_only: true, pending: ['教学周未确认'] },
  };
  const partial = buildWidget(partialDoc);
  const checks = [
    ['contains first action', /先去上课/.test(result.widget_code)],
    ['contains next task', /第 6 章作业/.test(result.widget_code)],
    ['contains source label', /eCourse/.test(result.widget_code)],
    ['under 30KB', result.meta.bytes < MAX_WIDGET_BYTES],
    ['no form tag', !/<form/i.test(result.widget_code)],
    ['no external script', !/<script/i.test(result.widget_code)],
    ['text fallback has action and next step', /先去上课/.test(result.text_fallback) && /下一步/.test(result.text_fallback)],
    ['empty now.json degrades instead of faking', empty.meta.ok === false && empty.meta.reason === 'NOW_DATA_MISSING'],
    ['partial data is labelled as estimate', partial.meta.partial === true && /待确认/.test(partial.widget_code)],
    ['at most 3 sequence rows', result.meta.sequence_rows <= 3],
    ['flat style without gradient or shadow', !/(linear-gradient|radial-gradient|box-shadow)/i.test(result.widget_code)],
    ['minimum widget font size is 11px', !/font-size\s*:\s*(?:[0-9]|10)px/i.test(result.widget_code)],
    ['dark theme is supported', /prefers-color-scheme\s*:\s*dark/i.test(result.widget_code)],
    ['outer container is transparent with inner card', /\.hyw\{[^}]*background:transparent/i.test(result.widget_code) && /class="hyw-card"/.test(result.widget_code)],
  ];
  const failed = checks.filter((item) => !item[1]);
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  console.log(`SELF_CHECK:${failed.length ? 'FAIL' : 'PASS'} ${checks.length - failed.length}/${checks.length}`);
  return failed.length === 0;
}

function main() {
  if (process.argv.includes('--self-check')) {
    process.exitCode = selfCheck() ? 0 : 1;
    return;
  }
  const nowPath = argValue('--now');
  if (!nowPath) throw new Error('MISSING_ARG:--now');
  const nowDoc = readJson(path.resolve(nowPath));
  const result = buildWidget(nowDoc);
  // --plan 只作可选补充：now.json 已带派生结果，plan 仅用于标记来源文件存在
  const planPath = argValue('--plan');
  if (planPath) result.meta.plan_provided = Boolean(readJson(path.resolve(planPath)));
  if (process.argv.includes('--text')) {
    process.stdout.write(`${result.text_fallback}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`BUILD_WIDGET_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exitCode = 1;
  }
}

module.exports = { buildWidget, buildTextFallback, renderFallback, MAX_WIDGET_BYTES };
