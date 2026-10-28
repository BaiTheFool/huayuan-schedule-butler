'use strict';

const $ = (selector) => document.querySelector(selector);
const sourceLabel = (row) => {
  if (row.kind === 'rest' || row.kind === 'break') return ['休息', 'rest'];
  if (row.kind === 'fixed' || row.kind === 'class') return ['固定', 'fixed'];
  if (/雨课堂|eCourse/i.test(row.source || '')) return [row.source, 'platform'];
  if (row.kind === 'task' || row.kind === 'study') return ['任务', 'task'];
  if (row.kind === 'personal') return ['个人', 'personal'];
  return ['安排', 'fixed'];
};

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(data) {
  const now = data.now || {};
  const first = now.first_action || {};
  const status = now.data_status || {};
  const pending = Array.isArray(status.pending) ? status.pending : [];
  const sync = data.sync || {};
  $('#status').classList.add('live');
  $('#status').innerHTML = `<i></i>${pending.length ? '部分数据' : '已同步'}`;
  $('#firstAction').textContent = first.headline || '当前没有明确的第一动作';
  $('#firstHint').textContent = first.next_hint || first.detail || '请继续在左侧向专家提问。';
  $('#timestamp').textContent = `${now.now?.time || '--:--'} · ${now.now?.weekday || ''}`;
  $('#source').textContent = `更新于 ${new Date(data.updated_at).toLocaleTimeString('zh-CN')}`;
  const syncNudge = $('#syncNudge');
  syncNudge.classList.toggle('due', Boolean(sync.due));
  syncNudge.innerHTML = `<span>${esc(sync.message || '建议定期刷新各平台待办。')}</span><a href="/todo.html">查看清单与刷新指令 →</a>`;

  const rows = (now.sequence || []).slice(0, 8);
  $('#timeline').innerHTML = rows.length
    ? rows.map((row) => {
        const [label, className] = sourceLabel(row);
        return `<li><time>${esc(row.start)}–${esc(row.end)}</time><span class="dot ${className}"></span><div><strong>${esc(row.title)}</strong><small>${esc(row.course || `${row.minutes || ''} 分钟`)}</small></div><em>${esc(label)}</em></li>`;
      }).join('')
    : '<li class="empty">当前没有后续安排。</li>';

  $('#pendingBadge').textContent = `${pending.length} 条`;
  $('#pending').innerHTML = pending.length
    ? pending.slice(0, 5).map((item) => `<li>${esc(item)}</li>`).join('')
    : '<li class="empty">没有需要人工确认的数据。</li>';

  $('#prompts').innerHTML = (data.prompts || []).map((prompt) =>
    `<button class="prompt" data-prompt="${esc(prompt)}"><span>${esc(prompt)}</span><b>复制</b></button>`
  ).join('');
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.prompt);
      const badge = button.querySelector('b');
      badge.textContent = '已复制';
      setTimeout(() => { badge.textContent = '复制'; }, 1200);
    });
  });
}

async function refresh() {
  try {
    const response = await fetch('/api/dashboard', { cache: 'no-store' });
    if (!response.ok) throw new Error('offline');
    render(await response.json());
  } catch {
    $('#status').classList.remove('live');
    $('#status').innerHTML = '<i></i>暂时断开';
  }
}

refresh();
setInterval(refresh, 2000);
