'use strict';

(function () {
  const navSelector = '.huayuan-page-nav, .page-nav';
  const pathToTab = (pathname) => {
    if (pathname.endsWith('/todo.html')) return 'todo';
    if (pathname.endsWith('/activities.html')) return 'activities';
    if (pathname.endsWith('/mobile.html')) return 'mobile';
    return 'today';
  };
  const tabLabel = { today: '今日安排', todo: '全部待办', activities: '可参与事项', mobile: '手机工作台' };

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Use the compatibility path below.
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

  function notify(message) {
    let toast = document.getElementById('huayuanAttentionToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'huayuanAttentionToast';
      toast.className = 'huayuan-copy-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  function addTabBadges(status) {
    document.querySelectorAll(navSelector).forEach((nav) => {
      nav.querySelectorAll('a[href]').forEach((anchor) => {
        const path = new URL(anchor.href, location.href).pathname;
        const tab = pathToTab(path);
        const count = Number((status.badges && status.badges[tab]) || 0);
        let badge = anchor.querySelector('.huayuan-tab-dot');
        if (!count) {
          if (badge) badge.remove();
          anchor.removeAttribute('aria-label');
          return;
        }
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'huayuan-tab-dot';
          anchor.appendChild(badge);
        }
        badge.title = `${count} 项未补齐`;
        anchor.setAttribute('aria-label', `${tabLabel[tab]}，${count} 项未补齐`);
      });
    });
  }

  function markTargets(status) {
    document.querySelectorAll('.huayuan-attention-target').forEach((element) => {
      element.classList.remove('huayuan-attention-target');
    });
    const missing = new Set((status.blockers || []).map((step) => step.key));
    const targets = [];
    if (missing.has('timetable')) targets.push('#timetableStatus');
    if (missing.has('preferences') || missing.has('week')) targets.push('#dashboardBriefPending');
    if (missing.has('portal') || missing.has('ecourse') || missing.has('rain') || missing.has('tasks')) {
      targets.push('#syncCard', '#pendingBadge');
    }
    if (missing.has('activities') || missing.has('college')) {
      targets.push('#refreshCard', '#warningCount');
    }
    if (Number((status.badges && status.badges.mobile) || 0)) targets.push('#mobileStatusCard');
    targets.forEach((selector) => document.querySelector(selector)?.classList.add('huayuan-attention-target'));
  }

  function removeCard() {
    document.querySelectorAll('.huayuan-attention-card').forEach((card) => card.remove());
  }

  function renderCard(status) {
    removeCard();
    const current = pathToTab(location.pathname);
    const blockers = Array.isArray(status.blockers)
      ? status.blockers.filter((step) => current === 'today' || step.tab === current)
      : [];
    if (!blockers.length) return;
    const nav = document.querySelector(navSelector);
    if (!nav) return;

    const card = document.createElement('section');
    card.className = 'huayuan-attention-card';
    card.id = 'huayuanAttentionCard';
    card.dataset.onboardingState = status.setup_state || 'uninitialized';

    const head = document.createElement('div');
    head.className = 'huayuan-attention-head';
    const titleBox = document.createElement('div');
    const kicker = document.createElement('div');
    kicker.className = 'huayuan-attention-kicker';
    kicker.textContent = status.initialized ? 'SETUP COMPLETE' : 'SETUP REQUIRED';
    const title = document.createElement('h2');
    title.textContent =
      current === 'today'
        ? status.headline || '还有资料需要补齐'
        : `${tabLabel[current]}还有 ${blockers.length} 项未准备好`;
    const hint = document.createElement('p');
    hint.textContent =
      current === 'today'
        ? '红点就是还没补齐的资料。复制对应指令到左侧对话，专家会带你逐项完成。'
        : '复制下方指令到左侧 WorkBuddy 对话，完成后本页会自动刷新。';
    titleBox.append(kicker, title, hint);
    const progress = document.createElement('span');
    progress.className = 'huayuan-attention-progress';
    progress.textContent = `${status.completed_steps || 0} / ${status.total_steps || 0} 已补齐`;
    head.append(titleBox, progress);

    const list = document.createElement('ul');
    list.className = 'huayuan-attention-list';
    blockers.forEach((step) => {
      const item = document.createElement('li');
      item.className = 'huayuan-attention-item';
      item.dataset.step = step.key;
      const itemHead = document.createElement('div');
      itemHead.className = 'huayuan-attention-item-head';
      const dot = document.createElement('span');
      dot.className = 'huayuan-dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('strong');
      label.textContent = step.label;
      itemHead.append(dot, label);
      const detail = document.createElement('small');
      detail.textContent = step.detail;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'huayuan-attention-copy';
      copy.textContent = '复制补全指令';
      copy.addEventListener('click', async () => {
        const copied = await copyText(step.prompt);
        if (!copied) {
          notify('复制失败，请手动选中指令');
          return;
        }
        copy.textContent = '已复制，请粘贴到左侧';
        notify('指令已复制，请到左侧 WorkBuddy 对话粘贴发送');
        setTimeout(() => {
          copy.textContent = '复制补全指令';
        }, 1600);
      });
      item.append(itemHead, detail, copy);
      list.appendChild(item);
    });

    card.append(head, list);
    if (current === 'today' && !status.initialized) {
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'huayuan-attention-main';
      main.textContent = '复制完整初始化指令';
      main.addEventListener('click', async () => {
        const copied = await copyText(status.prompt);
        if (!copied) {
          notify('复制失败，请手动选中初始化指令');
          return;
        }
        main.textContent = '已复制，请粘贴到左侧';
        notify('完整初始化指令已复制');
        setTimeout(() => {
          main.textContent = '复制完整初始化指令';
        }, 1600);
      });
      card.appendChild(main);
    }
    nav.insertAdjacentElement('afterend', card);
  }

  function render(status) {
    if (!status || !status.ok) return;
    document.body.dataset.onboardingState = status.setup_state || 'unknown';
    addTabBadges(status);
    renderCard(status);
    markTargets(status);
  }

  async function refresh() {
    fetch('/api/heartbeat', { method: 'POST', cache: 'no-store' }).catch(() => {});
    try {
      const response = await fetch('/api/onboarding', { cache: 'no-store' });
      if (!response.ok) throw new Error('offline');
      render(await response.json());
    } catch {
      // Main page modules report connection failures; keep this layer non-blocking.
    }
  }

  refresh();
  setInterval(refresh, 5000);
})();
