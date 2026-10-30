'use strict';

/* 华园日程管家 · 手机工作台
 * 只读前端：令牌 + /api/dashboard，不写任何数据。
 * 设计取舍：单文件、无构建、无第三方库，方便 WorkBuddy 直接起服务给手机用。
 */

(function () {
  const TOKEN_KEY = 'huayuan.mobile.token';
  const CACHE_KEY = 'huayuan.mobile.cache';
  const TAB_KEY = 'huayuan.mobile.tab';
  const REFRESH_MS = 30000;

  const VIEW_TITLE = {
    today: '今日安排',
    todo: '全部待办',
    activities: '可参与事项',
    week: '本周计划',
    settings: '设置',
  };

  const ACTIVITY_TYPE_LABEL = {
    competition: '竞赛',
    lecture: '讲座',
    volunteer: '志愿',
    culture: '文体',
    career: '就业',
    training: '培训',
    exam: '考试',
    other: '其他',
  };

  const state = {
    token: '',
    data: null,
    view: 'today',
    scope: 'all',
    type: 'all',
    loading: false,
    online: false,
    lastLoadedAt: 0,
    lastError: '',
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const pad = (n) => String(n).padStart(2, '0');

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function weekdayOf(iso) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const date = new Date(`${iso}T00:00:00`);
    return Number.isNaN(date.getTime()) ? '' : names[date.getDay()];
  }

  function shortDate(iso) {
    if (!iso) return '';
    const parts = String(iso).split('-');
    if (parts.length !== 3) return iso;
    return `${Number(parts[1])} 月 ${Number(parts[2])} 日`;
  }

  function daysUntil(iso) {
    if (!iso) return null;
    const target = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    const today = new Date(`${todayIso()}T00:00:00`);
    return Math.round((target - today) / 86400000);
  }

  function deadlineBadge(iso) {
    const days = daysUntil(iso);
    if (days == null) return { text: '', cls: '' };
    if (days < 0) return { text: '已过截止', cls: 'warn' };
    if (days === 0) return { text: '今天截止', cls: 'accent' };
    if (days === 1) return { text: '明天截止', cls: 'accent' };
    if (days <= 3) return { text: `${days} 天后截止`, cls: 'amber' };
    return { text: `${days} 天后截止`, cls: '' };
  }

  function kindMeta(row) {
    const kind = row.kind || '';
    if (kind === 'rest' || kind === 'break') return { label: '休息', cls: 'kind-rest' };
    if (kind === 'fixed' || kind === 'class' || kind === 'course') return { label: '固定', cls: 'kind-fixed' };
    if (kind === 'personal') return { label: '个人', cls: 'kind-personal' };
    if (kind === 'task' || kind === 'study') {
      return { label: /雨课堂|eCourse|教务/i.test(row.source || '') ? row.source : '任务', cls: 'kind-task' };
    }
    if (/雨课堂|eCourse/i.test(row.source || '')) return { label: row.source, cls: 'kind-task' };
    return { label: '安排', cls: 'kind-fixed' };
  }

  function toast(message) {
    const node = $('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 1900);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制，去电脑上的 WorkBuddy 对话里发送');
      return;
    } catch {
      // 兼容不支持剪贴板 API 的 WebView
    }
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand('copy');
      toast('已复制，去电脑上的 WorkBuddy 对话里发送');
    } catch {
      toast('复制失败，请长按文字手动复制');
    }
    helper.remove();
  }

  function setStatus(text, mode) {
    const pill = $('statusPill');
    const label = $('statusText');
    if (!pill || !label) return;
    label.textContent = text;
    pill.classList.toggle('live', mode === 'live');
    pill.classList.toggle('warn', mode === 'warn');
  }

  // ── 数据 ──────────────────────────────────────────────────────────
  async function api(path, options) {
    const headers = Object.assign({}, (options && options.headers) || {});
    if (state.token) headers['X-Huayuan-Token'] = state.token;
    const response = await fetch(path, Object.assign({ cache: 'no-store' }, options, { headers }));
    return response;
  }

  async function load({ silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    const refreshBtn = $('refreshBtn');
    if (refreshBtn) refreshBtn.classList.add('spinning');
    if (!silent) state.lastError = '';
    try {
      const response = await api('/api/dashboard');
      if (response.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        state.token = '';
        showPair('这台手机还没有配对，输入电脑上的 6 位配对码。');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !data.ok) throw new Error((data && data.error) || 'BAD_PAYLOAD');
      state.data = data;
      state.online = true;
      state.lastError = '';
      state.lastLoadedAt = Date.now();
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
      } catch {
        // 缓存写不下就算了，不影响在线使用
      }
      renderAll();
      setStatus(pendingCount() ? '部分数据' : '已同步', pendingCount() ? 'warn' : 'live');
    } catch (error) {
      state.online = false;
      state.lastError = String((error && error.message) || error);
      const cached = readCache();
      if (cached && cached.data) {
        state.data = cached.data;
        state.lastLoadedAt = cached.at;
        renderAll();
        setStatus('离线·缓存', 'warn');
      } else {
        setStatus('未连接', 'warn');
        renderDisconnected();
      }
    } finally {
      state.loading = false;
      if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.data) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function pendingCount() {
    const pending = (state.data && state.data.now && state.data.now.data_status && state.data.now.data_status.pending) || [];
    return pending.length;
  }

  const ROUTE_KIND = {
    class: { label: '课程', cls: 'kind-task' },
    walk: { label: '步行', cls: '' },
    meal: { label: '用餐', cls: 'kind-personal' },
    study: { label: '自习', cls: 'kind-task' },
    sport: { label: '运动', cls: 'kind-personal' },
    play: { label: '放松', cls: 'kind-rest' },
    rest: { label: '缓冲', cls: 'kind-rest' },
    free: { label: '自由', cls: '' },
    shower: { label: '洗澡', cls: '' },
    sleep: { label: '睡觉', cls: '' },
  };

  function clockMinutes(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function liveClock() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  function renderRouteMap(route) {
    const bounds = route && route.campus && route.campus.bounds;
    if (!bounds) return '';
    const width = 1000;
    const height = 1000;
    const pad = 72;
    const x = (lng) =>
      pad + ((Number(lng) - Number(bounds.west)) / (Number(bounds.east) - Number(bounds.west))) * (width - pad * 2);
    const y = (lat) =>
      height - pad - ((Number(lat) - Number(bounds.south)) / (Number(bounds.north) - Number(bounds.south))) * (height - pad * 2);
    const points = (route.route && route.route.points) || [];
    const path = points
      .filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)))
      .map((point, index) => `${index ? 'L' : 'M'} ${x(point.lng).toFixed(1)} ${y(point.lat).toFixed(1)}`)
      .join(' ');
    const poiById = new Map((route.pois || []).map((poi) => [poi.id, poi]));
    const markers = (route.stops || [])
      .map((stop, index) => {
        const poi = poiById.get(stop.poiId);
        if (!poi || index >= 12) return '';
        const px = x(poi.lng);
        const py = y(poi.lat);
        return `<g>
          <circle class="route-map-point" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="34"/>
          <text class="route-map-number" x="${px.toFixed(1)}" y="${(py + 9).toFixed(1)}">${index + 1}</text>
          <text class="route-map-label" x="${px.toFixed(1)}" y="${(py - 47).toFixed(1)}">${esc(String(poi.short || poi.name || '').slice(0, 8))}</text>
        </g>`;
      })
      .join('');
    return `
      <rect class="route-map-bg" x="0" y="0" width="1000" height="1000"/>
      <path class="route-map-road" d="M 70 330 C 280 240, 430 330, 620 210 S 900 180, 940 350 M 160 760 C 330 620, 560 820, 900 700"/>
      <path class="route-map-road-line" d="M 70 330 C 280 240, 430 330, 620 210 S 900 180, 940 350 M 160 760 C 330 620, 560 820, 900 700"/>
      ${path ? `<path class="route-map-path" d="${path}"/>` : ''}
      ${markers}`;
  }

  function renderRouteOverview(data) {
    const route = data.route || {};
    const overview = $('routeOverview');
    if (!route.ok || !route.available) {
      overview.hidden = true;
      return false;
    }
    overview.hidden = false;
    const weather = (route.meta && route.meta.weather) || {};
    $('routeWeather').textContent = `${weather.icon || '☁️'} ${weather.label || '天气未知'} ${weather.temperature != null ? `${weather.temperature}°C` : ''}`;
    $('routeMap').innerHTML = renderRouteMap(route);
    const summary = route.summary || {};
    $('routeSummary').innerHTML =
      `<b>${summary.stops || 0} 个地点</b> · ${summary.visits || 0} 段停留 · 步行 ${((summary.walk_meters || 0) / 1000).toFixed(1)} km / ${summary.walk_minutes || 0} 分钟`;
    const weights = (route.meta && route.meta.weights) || { study: 0.46, play: 0.22, sport: 0.32 };
    $('routeWeights').innerHTML = [
      ['study', '自习', weights.study],
      ['play', '放松', weights.play],
      ['sport', '运动', weights.sport],
    ]
      .map(
        ([key, label, raw]) => {
          const value = Math.round(Number(raw || 0) * 100);
          return `<div class="route-weight ${key}">
            <div class="route-weight-head"><span>${label}</span><b>${value}%</b></div>
            <div class="route-weight-bar"><i style="width:${Math.max(0, Math.min(100, value))}%"></i></div>
          </div>`;
        }
      )
      .join('');
    $('routeStats').innerHTML = [
      ['自习', `${summary.study_minutes || 0} 分钟`],
      ['运动', `${summary.sport_minutes || 0} 分钟`],
      ['放松', `${summary.play_minutes || 0} 分钟`],
      ['任务', `${summary.task_minutes || 0} 分钟`],
    ]
      .map(([label, value]) => `<div class="route-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
      .join('');
    return true;
  }

  // ── 渲染：今日 ────────────────────────────────────────────────────
  function renderToday() {
    const data = state.data || {};
    const now = data.now || {};
    const first = now.first_action || {};
    const clock = liveClock();
    const weekday = weekdayOf(todayIso());
    const week = now.week || {};


    $('heroTitle').textContent = first.headline || '当前没有明确的第一动作';
    $('heroDetail').textContent = first.detail || first.next_hint || '打开电脑上的 WorkBuddy，问一句“我现在该干什么”。';

    const meta = [];
    if (first.starts_at && first.ends_at) meta.push(`${first.starts_at}–${first.ends_at}`);
    const windowDoc = now.window || {};
    if (windowDoc.minutes) meta.push(`${windowDoc.minutes} 分钟可用`);
    if (now.readiness && now.readiness.estimate_only) meta.push('估算');
    $('heroMeta').innerHTML = meta.map((item) => `<span>${esc(item)}</span>`).join('');

    const current = now.current || {};
    const firstType = String(first.type || '');
    const currentMinutes = clockMinutes(clock);
    const routeToday =
      data.route &&
      data.route.ok &&
      data.route.meta &&
      data.route.meta.date === todayIso();
    const currentBlock =
      routeToday && currentMinutes != null
        ? (data.route.blocks || []).find(
            (block) => Number(block.start_min) <= currentMinutes && Number(block.end_min) > currentMinutes
          )
        : null;
    const currentValue = currentBlock
      ? currentBlock.type === 'class'
        ? '要上课'
        : currentBlock.type === 'walk'
          ? '在路上'
          : currentBlock.type === 'meal'
            ? '用餐'
            : currentBlock.type === 'study'
              ? '自习'
              : currentBlock.type === 'sport'
                ? '运动'
                : currentBlock.type === 'play'
                  ? '放松'
                  : '有安排'
      : /class/.test(firstType)
        ? '要上课'
        : current.status === 'in_class'
          ? '在上课'
          : current.status === 'busy'
            ? '有安排'
            : '空闲';
    const hasRoute = renderRouteOverview(data);
    const facts = [
      { label: '此刻', value: currentValue },
      { label: '可用窗口', value: windowDoc.minutes ? `${windowDoc.minutes} 分钟` : '—' },
      { label: '数据', value: pendingCount() ? '待确认' : '已同步' },
    ];
    $('facts').innerHTML = facts
      .map((item) => `<div class="fact"><b>${esc(item.value)}</b><span>${esc(item.label)}</span></div>`)
      .join('');

    const routeBlocks = hasRoute ? data.route.blocks || [] : [];
    const rows = routeBlocks.length
      ? routeBlocks
          .filter((block) => currentMinutes == null || Number(block.end_min) >= currentMinutes - 1)
          .slice(0, 12)
      : (now.sequence || []).slice(0, 8);
    $('timeline').innerHTML = rows.length
      ? rows
          .map((row) => {
            const metaRow = routeBlocks.length
              ? ROUTE_KIND[row.type] || { label: '安排', cls: '' }
              : kindMeta(row);
            const sub = routeBlocks.length
              ? [row.subtitle, row.task && row.task.title, row.reason].filter(Boolean).join(' · ')
              : row.course || row.reason || (row.minutes ? `${row.minutes} 分钟` : '');
            return `<li>
              <time>${esc(row.start)}<br />${esc(row.end)}</time>
              <span class="dot ${metaRow.cls}"></span>
              <div class="body">
                <strong>${esc(row.title)}</strong>
                ${sub ? `<small>${esc(sub)}</small>` : ''}
                <span class="tag">${esc(metaRow.label)}</span>
              </div>
            </li>`;
          })
          .join('')
      : '<li class="empty">接下来没有已排入的时段；有明确任务时，电脑端的专家会重新排。</li>';

    const pending = (now.data_status && now.data_status.pending) || [];
    $('pendingSection').hidden = pending.length === 0;
    $('pendingCount').textContent = `${pending.length} 条`;
    $('pendingList').innerHTML = pending
      .slice(0, 4)
      .map((item) => `<div class="card" style="margin-top:8px"><p class="small" style="margin:0;line-height:1.7">${esc(item)}</p></div>`)
      .join('');

    const prompts = data.prompts || [];
    $('prompts').innerHTML = prompts
      .map((prompt) => `<button class="prompt" type="button" data-prompt="${esc(prompt)}"><span>${esc(prompt)}</span><b>复制</b></button>`)
      .join('');
    document.querySelectorAll('[data-prompt]').forEach((button) => {
      button.addEventListener('click', () => copyText(button.dataset.prompt));
    });

    const sync = data.sync || {};
    const notice = $('syncNotice');
    if (sync.due) {
      notice.hidden = false;
      notice.innerHTML = `<span class="ico">⏳</span><span><b>该刷新平台数据了。</b>${esc(sync.message || '')}复制上方的“刷新我的校园待办”发到电脑。</span>`;
    } else if (!state.online) {
      notice.hidden = false;
      notice.innerHTML = `<span class="ico">⚠️</span><span><b>暂时连不上电脑。</b>现在显示的是 ${state.lastLoadedAt ? new Date(state.lastLoadedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '上次'} 的缓存，电脑上重新打开工作台后会恢复。</span>`;
    } else {
      notice.hidden = true;
    }
  }

  // ── 渲染：待办 ────────────────────────────────────────────────────
  function taskCard(task, priority) {
    const chips = [];
    if (task.course) chips.push(task.course);
    if (task.deadline_display || task.deadline) chips.push(task.deadline_display || task.deadline);
    if (task.estimated_minutes) chips.push(`${task.estimated_minutes} 分钟`);
    const sources = Array.isArray(task.sources) ? task.sources.filter(Boolean) : [];
    if (sources.length) chips.push(sources.join(' · '));
    const confirm = Array.isArray(task.confirm_reasons) ? task.confirm_reasons.filter(Boolean) : [];
    return `<article class="task-card ${priority}">
      <h4>${esc(task.title || '（未命名事项）')}</h4>
      <div class="meta">${chips.map((chip) => `<span class="tag">${esc(chip)}</span>`).join('')}</div>
      ${confirm.length ? `<p class="confirm">需确认：${esc(confirm.join('；'))}</p>` : ''}
    </article>`;
  }

  function renderTodo() {
    const data = state.data || {};
    const todo = data.todo || { groups: [], total: 0, overdue: [] };
    const now = data.now || {};
    const counts = {};
    (todo.groups || []).forEach((group) => {
      counts[group.key] = (group.items || []).length;
    });

    $('todoStats').innerHTML = [
      { key: 'p0', label: 'P0 必须优先', value: counts.p0 || 0 },
      { key: 'p1', label: 'P1 本周推进', value: counts.p1 || 0 },
      { key: 'p2', label: 'P2 时间充裕', value: counts.p2 || 0 },
      { key: 'p3', label: 'P3 不急', value: counts.p3 || 0 },
    ]
      .map((item) => `<div class="stat ${item.key}"><b>${item.value}</b><span>${esc(item.label)}</span></div>`)
      .join('');

    const groups = (todo.groups || []).filter((group) => (group.items || []).length);
    $('todoGroups').innerHTML = groups.length
      ? groups
          .map(
            (group) => `<section class="task-group">
              <div class="task-group-head">
                <h3>${esc(group.label)}</h3>
                <span class="hint">${esc(group.hint || '')}</span>
                <span class="count">${group.items.length}</span>
              </div>
              ${group.items.map((task) => taskCard(task, group.key)).join('')}
            </section>`
          )
          .join('')
      : `<div class="card" style="margin-top:10px"><div class="empty" style="padding:6px 2px">当前没有待办。没读到 ≠ 没有：电脑上发一句“刷新我的校园待办”可以再核对一次。</div></div>`;

    const overdue = todo.overdue || [];
    $('overdueSection').hidden = overdue.length === 0;
    $('overdueCount').textContent = `${overdue.length} 条`;
    $('overdueList').innerHTML = overdue
      .map(
        (item) => `<article class="task-card" style="border-left-color: var(--amber)">
          <h4>${esc(item.title || '')}</h4>
          <div class="meta">
            ${item.course ? `<span class="tag">${esc(item.course)}</span>` : ''}
            ${item.deadline ? `<span class="tag amber">截止 ${esc(item.deadline)}</span>` : ''}
          </div>
          ${item.note ? `<p class="confirm">${esc(item.note)}</p>` : ''}
        </article>`
      )
      .join('');

    const completed = (now.completed_local || []).length;
    const deferred = (now.deferred || []).length;
    const sync = data.sync || {};
    $('todoFooter').innerHTML = `<div class="notice" style="display:block">
      <b>本地状态：</b>已完成 ${completed} 条，已延后 ${deferred} 条（只记在电脑上，不改学校系统）。<br />
      ${esc(sync.message || '建议每 7 天刷新一次平台数据。')}
    </div>`;
  }

  // ── 渲染：活动 ────────────────────────────────────────────────────
  function activityTypes(items) {
    const seen = new Set();
    return items
      .map((item) => item.type)
      .filter((type) => type && !seen.has(type) && seen.add(type));
  }

  function renderActivities() {
    const data = state.data || {};
    const activities = data.activities || {};
    const items = (activities.items || []).filter((item) => item.status !== 'closed' && item.eligible !== false);
    const college = activities.college || '';
    const scopes = [{ key: 'all', label: '全部' }, { key: '校级', label: '校级' }];
    if (college) scopes.push({ key: '学院', label: college });

    const matchesScope = (item) => {
      if (state.scope === 'all') return true;
      if (state.scope === '学院') return item.scope && item.scope !== '校级';
      return item.scope === state.scope;
    };
    const types = activityTypes(items);
    const matchesType = (item) => state.type === 'all' || item.type === state.type;
    const visible = items.filter((item) => matchesScope(item) && matchesType(item));

    $('scopeFilters').innerHTML = scopes
      .map(
        (scope) =>
          `<button class="chip ${state.scope === scope.key ? 'active' : ''}" type="button" data-scope="${esc(scope.key)}" role="tab" aria-selected="${state.scope === scope.key}">${esc(scope.label)}</button>`
      )
      .join('');
    $('typeFilters').innerHTML = [{ key: 'all', label: '全部类型' }]
      .concat(types.map((type) => ({ key: type, label: ACTIVITY_TYPE_LABEL[type] || type })))
      .map(
        (type) =>
          `<button class="chip ${state.type === type.key ? 'active' : ''}" type="button" data-type="${esc(type.key)}" role="tab" aria-selected="${state.type === type.key}">${esc(type.label)}</button>`
      )
      .join('');

    const filterButtons = document.querySelectorAll('[data-scope], [data-type]');
    filterButtons.forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.scope) state.scope = button.dataset.scope;
        if (button.dataset.type) state.type = button.dataset.type;
        renderActivities();
      });
    });

    $('activityCount').textContent = `${visible.length} 条`;
    $('activityList').innerHTML = visible.length
      ? visible
          .map((item) => {
            const badge = deadlineBadge(item.deadline);
            const typeLabel = ACTIVITY_TYPE_LABEL[item.type] || item.type || '活动';
            return `<article class="activity ${esc(item.type || '')}">
              <div class="activity-top">
                <span class="tag accent">${esc(typeLabel)}</span>
                ${item.scope ? `<span class="tag green">${esc(item.scope)}</span>` : ''}
                ${badge.text ? `<span class="tag ${badge.cls}">${esc(badge.text)}</span>` : ''}
              </div>
              <h4>${esc(item.title || '')}</h4>
              ${item.summary ? `<p>${esc(item.summary)}</p>` : ''}
              <div class="activity-foot">
                <span class="deadline">${esc(item.deadline ? `截止 ${item.deadline}` : '截止时间未标注')}</span>
                <span class="src">${esc(item.source_label || '')}</span>
              </div>
              ${item.url ? `<a class="small" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">查看原文 ↗</a>` : ''}
            </article>`;
          })
          .join('')
      : `<div class="card"><div class="empty" style="padding:6px 2px">还没有可参与事项。电脑上发一句“刷新校园活动”，或换个筛选条件。</div></div>`;

    const warnings = activities.status === 'NOT_SYNCED' ? [] : activities.warnings || [];
    $('activityFoot').innerHTML = warnings.length
      ? `<div class="notice" style="display:block"><b>部分来源没读到：</b>${esc(warnings.slice(0, 3).join('；'))}</div>`
      : activities.status === 'NOT_SYNCED'
        ? `<div class="notice"><span class="ico">ⓘ</span><span>还没有活动数据：电脑上发“刷新校园活动”，这里会自动更新。</span></div>`
        : '';
  }

  // ── 渲染：本周 ────────────────────────────────────────────────────
  function renderWeek() {
    const data = state.data || {};
    const plan = data.plan;

    if (!plan || !plan.days || !plan.days.length) {
      $('weekNotice').innerHTML = `<div class="notice"><span class="ico">ⓘ</span><span>还没有本周计划文件（plan.json）。在电脑上问一句“我现在该干什么”或完成一次初始化，就会生成。</span></div>`;
      $('weekList').innerHTML = '';
      return;
    }
    $('weekNotice').innerHTML = plan.available === false
      ? `<div class="notice"><span class="ico">⚠️</span><span>${esc(plan.plan_note || '计划还不完整，先按“今日安排”里的第一动作走。')}</span></div>`
      : '';

    const today = todayIso();
    $('weekList').innerHTML = plan.days
      .map((day) => {
        const date = day.date || '';
        const blocks = day.blocks || [];
        const label = date === today ? '今天' : weekdayOf(date);
        return `<section class="day">
          <div class="day-head">
            <h3>${esc(label)} · ${esc(shortDate(date))}</h3>
            <span>${blocks.length} 段安排</span>
          </div>
          <div class="blocks">
            ${blocks.length
              ? blocks
                  .map(
                    (block) => `<div class="block">
                      <time>${esc(block.start)}<br />${esc(block.end)}</time>
                      <div>
                        <strong>${esc(block.title || '')}</strong>
                        ${block.course ? `<small>${esc(block.course)}</small>` : ''}
                        ${!block.course && block.reason ? `<small>${esc(block.reason)}</small>` : ''}
                      </div>
                    </div>`
                  )
                  .join('')
              : '<div class="empty">这天没有排入安排。</div>'}
          </div>
        </section>`;
      })
      .join('');
  }

  // ── 渲染：设置 ────────────────────────────────────────────────────
  function renderSettings() {
    const data = state.data || {};
    const sync = data.sync || {};
    const host = location.host || '';
    const publicMode = /trycloudflare\.com|ngrok\.io|\.loca\.lt/i.test(host);
    const updated = data.updated_at ? new Date(data.updated_at) : null;
    const now = data.now || {};
    const week = now.week || {};

    $('settingsKv').innerHTML = [
      ['连接方式', publicMode ? '公网隧道（https）' : '局域网 / 虚拟组网'],
      ['访问地址', host],
      ['数据更新时间', updated ? updated.toLocaleString('zh-CN') : '未知'],
      ['教学周', week.number != null ? `第 ${week.number} 周${week.reliable === false ? '（待确认）' : ''}` : '未确认'],
      ['平台数据', sync.age_days === 0 ? '今天刷新过' : `约 ${sync.age_days != null ? sync.age_days : '?'} 天前`],
      ['配对设备', '这台手机'],
      ['安卓 App', '可下载安装（见下方按钮）'],
    ]
      .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`)
      .join('');

    $('settingsActions').innerHTML = [
      { action: 'refresh', label: '刷新数据', cls: '' },
      { action: 'download-apk', label: '下载安卓 App（可选，免记地址）', cls: '' },
      { action: 'copy-tasks', label: '复制「刷新我的校园待办」', cls: '' },
      { action: 'copy-activities', label: '复制「刷新校园活动」', cls: '' },
      { action: 'unpair', label: '解除这台手机的配对', cls: 'danger' },
    ]
      .map((item) => `<button class="btn ${item.cls}" type="button" data-action="${item.action}">${esc(item.label)}</button>`)
      .join('');

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'refresh') load({ silent: false });
        if (action === 'download-apk') window.location.href = '/download/app.apk';
        if (action === 'copy-tasks') copyText('刷新我的校园待办：请重新读取教务、eCourse、雨课堂和校园门户，更新待办与日程，并告诉我新增、临近截止、已过期和发生变化的事项。');
        if (action === 'copy-activities') copyText('刷新校园活动：请重新拉取校团委、学生工作处、本科生院、研究生院、软件学院和就业在线的公开活动公告，筛出仍可报名的活动，并按截止时间排好。');
        if (action === 'unpair') {
          localStorage.removeItem(TOKEN_KEY);
          state.token = '';
          toast('已解除配对，刷新页面后重新输入配对码');
          setTimeout(() => showPair('这台手机已解除配对，输入电脑上新的 6 位配对码。'), 600);
        }
      });
    });

    $('about').innerHTML = `本页只读：不提供提交作业、报名、缴费、删除或修改学校业务数据的按钮。<br />
      数据来自你自己电脑上的 <code>now.json</code> / <code>plan.json</code> / <code>activity-feed.json</code>，不经过任何第三方服务器；公网隧道只做转发。<br />
      手机工作台 v1 · 与华园日程管家 0.12.0 同步`;
  }

  function renderAll() {
    if (!state.data) return;
    renderToday();
    renderTodo();
    renderActivities();
    renderWeek();
    renderSettings();
    applyTab(state.view);
  }

  function renderDisconnected() {
    if (!state.data) {
      $('heroTitle').textContent = '连不上电脑上的工作台';
      $('heroDetail').textContent = '确认电脑上仍在运行手机工作台，并且手机用的是同一地址。';
      $('timeline').innerHTML = '<li class="empty">重新打开电脑上的手机工作台后，这里会自动恢复。</li>';
    }
  }

  // ── 视图切换 ──────────────────────────────────────────────────────
  function headerSubtitle(view) {
    const data = state.data || {};
    const now = data.now || {};
    if (view === 'today') {
      const clock = liveClock();
      const week = (now.week && now.week.number != null) ? `第 ${now.week.number} 周` : '教学周未确认';
      return `${weekdayOf(todayIso())} · ${week} · ${clock}`;
    }
    if (view === 'todo') return `共 ${(data.todo && data.todo.total) || 0} 条待办`;
    if (view === 'activities') {
      const activities = data.activities || {};
      return activities.college ? `学院：${activities.college}` : '校级公开来源';
    }
    if (view === 'week') {
      const plan = data.plan;
      return plan && plan.generated_at
        ? `${new Date(plan.generated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric' })} 更新`
        : '暂无本周计划';
    }
    return location.host || '';
  }

  function applyTab(view) {
    if (!VIEW_TITLE[view]) view = 'today';
    state.view = view;
    document.querySelectorAll('.view').forEach((section) => {
      section.hidden = section.dataset.view !== view;
    });
    document.querySelectorAll('.tab').forEach((tab) => {
      const active = tab.dataset.tab === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    $('pageTitle').firstChild.nodeValue = VIEW_TITLE[view];
    $('pageSub').textContent = headerSubtitle(view);
    const content = $('content');
    if (content) content.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const hash = view === 'today' ? '' : `#${view}`;
    if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${hash}`);
    try {
      localStorage.setItem(TAB_KEY, view);
    } catch {
      // ignore
    }
  }

  function showPair(message) {
    $('pairView').hidden = false;
    $('mainView').hidden = true;
    if (message) $('pairError').textContent = message;
    const input = $('pairCode');
    if (input) setTimeout(() => input.focus(), 120);
  }

  function showMain() {
    $('pairView').hidden = true;
    $('mainView').hidden = false;
  }

  // ── 配对 ─────────────────────────────────────────────────────────
  async function submitPair(event) {
    event.preventDefault();
    const input = $('pairCode');
    const button = $('pairSubmit');
    const errorNode = $('pairError');
    const code = String(input.value || '').replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) {
      errorNode.textContent = '配对码是 6 位数字，看一下电脑上的显示。';
      return;
    }
    errorNode.textContent = '';
    button.disabled = true;
    button.textContent = '正在连接…';
    try {
      const response = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 429) {
        errorNode.textContent = `尝试次数太多，请等 ${data.retry_after || 60} 秒后再试。`;
        return;
      }
      if (!response.ok || !data.token) {
        const left = data.attempts_left;
        errorNode.textContent = left != null && left <= 3 ? `配对码不对，还剩 ${left} 次机会。` : '配对码不对，确认电脑上显示的数字。';
        return;
      }
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      input.value = '';
      showMain();
      renderSkeleton();
      await load();
      if (navigator.vibrate) navigator.vibrate(12);
      toast('已连接电脑工作台');
    } catch {
      errorNode.textContent = '连不上电脑：确认两台设备在同一网络，或电脑已开公网隧道。';
    } finally {
      button.disabled = false;
      button.textContent = '连接电脑';
    }
  }

  function renderSkeleton() {
    $('heroTitle').textContent = '正在读取电脑上的安排…';
    $('heroDetail').textContent = '';
    $('heroMeta').innerHTML = '';
    $('facts').innerHTML = '';
    $('timeline').innerHTML = '<li class="empty">读取中…</li>';
    $('pendingSection').hidden = true;
    $('prompts').innerHTML = '';
    $('syncNotice').hidden = true;
    setStatus('读取中', '');
  }

  // ── 启动 ─────────────────────────────────────────────────────────
  function consumeUrlToken() {
    const url = new URL(location.href);
    const token = url.searchParams.get('k') || url.searchParams.get('t');
    if (!token) return '';
    url.searchParams.delete('k');
    url.searchParams.delete('t');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return token;
  }

  function initTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        applyTab(tab.dataset.tab);
        if (navigator.vibrate) navigator.vibrate(6);
      });
    });
  }

  function initRefresh() {
    $('refreshBtn').addEventListener('click', () => load());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - state.lastLoadedAt > REFRESH_MS) load({ silent: true });
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') load({ silent: true });
    }, REFRESH_MS);
    setInterval(() => {
      if (document.visibilityState === 'visible' && state.view === 'today' && state.data) renderToday();
    }, 30000);

    const topbar = $('topbar');
    $('content').addEventListener(
      'scroll',
      () => {
        topbar.classList.toggle('scrolled', $('content').scrollTop > 2);
      },
      { passive: true }
    );
    window.addEventListener(
      'scroll',
      () => topbar.classList.toggle('scrolled', window.scrollY > 2),
      { passive: true }
    );

    // 轻量下拉刷新：只在页面顶部、单指下拉时触发
    let startY = null;
    let pulling = false;
    document.addEventListener(
      'touchstart',
      (event) => {
        if (state.view !== 'today') return;
        if ($('content').scrollTop > 0 || window.scrollY > 0 || event.touches.length !== 1) return;
        startY = event.touches[0].clientY;
        pulling = false;
      },
      { passive: true }
    );
    document.addEventListener(
      'touchmove',
      (event) => {
        if (startY == null || event.touches.length !== 1) return;
        const delta = event.touches[0].clientY - startY;
        if (delta > 84 && !pulling) {
          pulling = true;
          if (navigator.vibrate) navigator.vibrate(8);
          load();
        }
      },
      { passive: true }
    );
    document.addEventListener('touchend', () => {
      startY = null;
      pulling = false;
    });
  }

  function boot() {
    initTabs();
    initRefresh();
    $('pairForm').addEventListener('submit', submitPair);
    $('pairCode').addEventListener('input', (event) => {
      event.target.value = String(event.target.value || '').replace(/\D/g, '').slice(0, 6);
      if ($('pairError').textContent) $('pairError').textContent = '';
    });

    const fromUrl = consumeUrlToken();
    const stored = localStorage.getItem(TOKEN_KEY) || '';
    state.token = stored || fromUrl || '';
    if (fromUrl) {
      try {
        localStorage.setItem(TOKEN_KEY, fromUrl);
      } catch {
        // ignore
      }
    }

    const wantedTab = (location.hash || '').replace('#', '');
    if (VIEW_TITLE[wantedTab]) state.view = wantedTab;

    if (!state.token) {
      showPair('');
      return;
    }
    showMain();
    renderSkeleton();
    applyTab(state.view);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
