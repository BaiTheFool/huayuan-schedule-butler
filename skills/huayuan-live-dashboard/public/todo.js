'use strict';

const $ = (selector) => document.querySelector(selector);

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Use the local textarea fallback below.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

function showCopyToast(message, ok = true) {
  let toast = document.getElementById('copyToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'copyToast';
    toast.className = 'copy-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.dataset.ok = ok ? '1' : '0';
  toast.classList.add('show');
  clearTimeout(showCopyToast.timer);
  showCopyToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function sourceText(item) {
  return (item.sources || [])
    .filter(Boolean)
    .map((source) => (source === 'user' ? '手工' : source))
    .join(' + ');
}

function itemHtml(item, index) {
  const meta = [
    item.course ? `课程 ${item.course}` : null,
    sourceText(item) ? `来源 ${sourceText(item)}` : null,
    item.deadline_display ? `截止 ${item.deadline_display}` : null,
    item.estimated_minutes ? `预计 ${item.estimated_minutes} 分钟` : null,
    item.deferred_until ? `延后至 ${item.deferred_until}，仍保留在待办` : null,
  ].filter(Boolean);
  const reasons = Array.isArray(item.confirm_reasons) ? item.confirm_reasons : [];
  return `<li class="todo-item">
    <span class="todo-index">${String(index + 1).padStart(2, '0')}</span>
    <div>
      <strong>${esc(item.title || '待确认任务')}</strong>
      <div class="chips">${meta.map((text) => `<span>${esc(text)}</span>`).join('')}</div>
      ${reasons.length ? `<p class="needs-check">待确认：${esc(reasons.join('；'))}</p>` : ''}
    </div>
    <em>${esc(item.priority || '')}</em>
  </li>`;
}

function render(data) {
  const now = data.now || {};
  const hasNow = Boolean(data.now);
  const todo = data.todo || {};
  const sync = data.sync || {};
  const status = now.data_status || {};
  const pending = Array.isArray(status.pending) ? status.pending : [];
  const groups = Array.isArray(todo.groups) ? todo.groups : [];

  $('#status').classList.add('live');
  $('#status').innerHTML = `<i></i>${!hasNow ? '等待初始化' : pending.length ? '部分数据' : '已同步'}`;
  $('#syncCard').classList.toggle('due', Boolean(sync.due));
  $('#syncTitle').textContent = sync.due ? '该刷新一次各平台任务了' : `建议每 ${sync.interval_days || 7} 天刷新一次`;
  $('#syncMessage').textContent = sync.message || '向左侧发送刷新指令即可重读各平台。';
  const syncButton = $('#copySyncPrompt');
  syncButton.onclick = async () => {
    try {
      const copied = await copyText(sync.prompt || '刷新我的校园待办。');
      if (!copied) throw new Error('copy failed');
      syncButton.textContent = '已复制';
      showCopyToast('刷新指令已复制，请到左侧对话粘贴发送');
    } catch {
      syncButton.textContent = '复制失败';
      showCopyToast('复制失败，请手动选中指令复制', false);
    } finally {
      setTimeout(() => {
        syncButton.textContent = '复制刷新指令';
      }, 1400);
    }
  };

  const byKey = Object.fromEntries(groups.map((group) => [group.key, group.items || []]));
  $('#countP0').textContent = String((byKey.p0 || []).length);
  $('#countP1').textContent = String((byKey.p1 || []).length);
  $('#countP2').textContent = String((byKey.p2 || []).length);
  $('#countOverdue').textContent = String((todo.overdue || []).length);
  $('#overdueBadge').textContent = `${(todo.overdue || []).length} 条`;
  $('#pendingBadge').textContent = `${pending.length} 条`;
  $('#todoUpdated').textContent = data.updated_at
    ? `更新于 ${new Date(data.updated_at).toLocaleTimeString('zh-CN')}`
    : '初始化后更新';
  $('#source').textContent = `${now.now?.date || ''} ${now.now?.weekday || ''}`;

  $('#todoGroups').innerHTML = !hasNow
    ? '<p class="empty">还没有初始化。请先按上方红点复制初始化指令，完成后这里会列出全部未完成任务。</p>'
    : groups
      .map((group) => {
      const items = group.items || [];
      return `<section class="todo-group ${esc(group.key)}">
        <div class="todo-group-head">
          <div><h4>${esc(group.label)}</h4><p>${esc(group.hint)}</p></div>
          <b>${items.length}</b>
        </div>
        ${
          items.length
            ? `<ul>${items.map(itemHtml).join('')}</ul>`
            : '<p class="empty">这一类暂时没有任务。</p>'
        }
      </section>`;
      })
      .join('');

  const overdue = todo.overdue || [];
  $('#overdue').innerHTML = overdue.length
    ? overdue.map((item) => `<li><strong>${esc(item.title)}</strong><br>${esc(item.course || '')} · 截止 ${esc(item.deadline || '待确认')}</li>`).join('')
    : '<li class="empty">没有已过期未完成项。</li>';

  $('#pending').innerHTML = !hasNow
    ? '<li class="empty">尚未读取平台数据。</li>'
    : pending.length
    ? pending.slice(0, 8).map((item) => `<li>${esc(item)}</li>`).join('')
    : '<li class="empty">没有需要人工确认的数据。</li>';

  const prompts = Array.isArray(data.prompts) ? data.prompts : [];
  $('#prompts').innerHTML = prompts
    .map(
      (prompt, index) =>
        `<button class="prompt" type="button" data-prompt-index="${index}"><span>${esc(prompt)}</span><b>复制</b></button>`
    )
    .join('');
  document.querySelectorAll('[data-prompt-index]').forEach((button) => {
    const prompt = prompts[Number(button.dataset.promptIndex)];
    button.addEventListener('click', async () => {
      try {
        const copied = await copyText(prompt);
        if (!copied) throw new Error('copy failed');
        const badge = button.querySelector('b');
        badge.textContent = '已复制';
        showCopyToast('已复制，请到左侧 WorkBuddy 对话粘贴发送');
        setTimeout(() => {
          badge.textContent = '复制';
        }, 1400);
      } catch {
        showCopyToast('复制失败，请手动选中文字复制', false);
      }
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
setInterval(refresh, 3000);
