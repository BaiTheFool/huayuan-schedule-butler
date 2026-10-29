'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

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
      // Fall through to the local textarea fallback.
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

  function notify(message, ok = true) {
    let toast = document.getElementById('huayuanCopyToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'huayuanCopyToast';
      toast.className = 'huayuan-copy-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.ok = ok ? '1' : '0';
    toast.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  function render(data) {
    const now = data.now || {};
    const first = now.first_action || {};
    const pending = Array.isArray(now.data_status && now.data_status.pending) ? now.data_status.pending : [];
    const sync = data.sync || {};
    const status = $('dashboardBriefStatus');
    status.classList.add('live');
    status.innerHTML = `<i></i>${pending.length ? '部分数据 · 已更新' : '数据已同步'}`;
    $('dashboardBriefAction').textContent = first.headline || '当前没有明确的第一动作';
    $('dashboardBriefHint').textContent = first.next_hint || first.detail || '继续在左侧向专家提问。';
    $('dashboardBriefSync').innerHTML = `${esc(sync.message || '建议定期刷新各平台待办。')} <a href="/todo.html">查看全部待办 →</a>`;
    const pendingBox = $('dashboardBriefPending');
    pendingBox.hidden = pending.length === 0;
    const pendingItems = pending.slice(0, 2).map((item) => {
      const text = String(item || '').replace(/\s+/g, ' ').trim();
      return text.length > 72 ? `${text.slice(0, 72)}…` : text;
    });
    pendingBox.textContent = pending.length
      ? `待确认：${pendingItems.join('；')}${pending.length > 2 ? `；另有 ${pending.length - 2} 项` : ''}`
      : '';
    $('dashboardBriefUpdated').textContent = data.updated_at
      ? new Date(data.updated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : '';

    const prompts = Array.isArray(data.prompts) ? data.prompts.slice(0, 3) : [];
    const promptBox = $('dashboardBriefPrompts');
    promptBox.hidden = prompts.length === 0;
    promptBox.innerHTML = prompts
      .map((prompt) => `<button type="button" data-huayuan-prompt="${esc(prompt)}">复制：${esc(prompt)}</button>`)
      .join('');
    promptBox.querySelectorAll('[data-huayuan-prompt]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const copied = await copyText(button.getAttribute('data-huayuan-prompt'));
          if (!copied) throw new Error('copy failed');
          const old = button.textContent;
          button.textContent = '已复制，请粘贴到左侧对话';
          notify('已复制，请到左侧 WorkBuddy 对话粘贴发送');
          setTimeout(() => {
            button.textContent = old;
          }, 1400);
        } catch {
          notify('复制失败，请手动选中文字复制', false);
        }
      });
    });
    document.body.dataset.dashboardConnected = 'true';
  }

  async function refresh() {
    try {
      const response = await fetch('/api/dashboard', { cache: 'no-store' });
      if (!response.ok) throw new Error('offline');
      render(await response.json());
    } catch {
      const status = $('dashboardBriefStatus');
      status.classList.remove('live');
      status.innerHTML = '<i></i>驾驶舱暂时断开';
      document.body.dataset.dashboardConnected = 'false';
    }
  }

  refresh();
  setInterval(refresh, 2000);
})();
