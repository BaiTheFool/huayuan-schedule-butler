'use strict';

const $ = (selector) => document.querySelector(selector);
let currentItems = [];
let currentFilter = 'all';
let currentScope = 'all';

const TYPE_LABEL = {
  competition: '竞赛',
  volunteer: '志愿',
  career: '就业',
  lecture: '讲座',
  training: '培训',
  wellbeing: '身心',
  culture: '文化',
  activity: '活动',
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function daysLeft(deadline) {
  if (!deadline) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(`${deadline}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function deadlineText(deadline) {
  const days = daysLeft(deadline);
  if (days === null) return '截止待确认';
  if (days === 0) return '今天截止';
  if (days > 0) return `${days} 天后截止`;
  return `已截止 ${Math.abs(days)} 天`;
}

function itemHtml(item) {
  const type = TYPE_LABEL[item.type] || '活动';
  const title = item.url
    ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`
    : `<span>${esc(item.title)}</span>`;
  return `<article class="activity-item ${esc(item.type || 'activity')}">
    <div class="activity-meta">
      <span class="type-chip">${esc(type)}</span>
      <span class="scope-chip">${esc(item.scope || '校级')}</span>
      <span>${esc(item.source_label || '待确认来源')}</span>
      <span>${esc(item.published_at ? `发布 ${item.published_at}` : '发布时间待确认')}</span>
    </div>
    <h4>${title}</h4>
    <p>${esc(item.summary || '请打开原通知查看参与要求。')}</p>
    <div class="activity-foot">
      <b>${esc(
        item.deadline
          ? `${item.deadline} · ${deadlineText(item.deadline)}`
          : item.event_at
            ? `活动日期 ${item.event_at}`
            : '截止待确认'
      )}</b>
      <span>${esc(item.verification || '报名前请核实')}</span>
    </div>
  </article>`;
}

function renderScopeFilters(items) {
  const scopes = [...new Set(items.map((item) => item.scope || '校级'))];
  const filters = [['all', '全部来源'], ...scopes.map((scope) => [scope, scope])];
  $('#scopeFilters').innerHTML = filters
    .map(
      ([key, label]) =>
        `<button type="button" class="${currentScope === key ? 'active' : ''}" data-scope="${esc(key)}">${esc(label)}</button>`
    )
    .join('');
  document.querySelectorAll('[data-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      currentScope = button.dataset.scope;
      renderScopeFilters(currentItems);
      renderItems(currentItems);
    });
  });
}

function renderFilters(items) {
  const types = [...new Set(items.map((item) => item.type || 'activity'))];
  const filters = [['all', '全部'], ...types.map((type) => [type, TYPE_LABEL[type] || type])];
  $('#filters').innerHTML = filters
    .map(
      ([key, label]) =>
        `<button type="button" class="${currentFilter === key ? 'active' : ''}" data-filter="${esc(key)}">${esc(label)}</button>`
    )
    .join('');
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      currentFilter = button.dataset.filter;
      renderFilters(currentItems);
      renderItems(currentItems);
    });
  });
}

function renderItems(items) {
  const typeFiltered =
    currentFilter === 'all' ? items : items.filter((item) => (item.type || 'activity') === currentFilter);
  const filtered =
    currentScope === 'all' ? typeFiltered : typeFiltered.filter((item) => (item.scope || '校级') === currentScope);
  $('#activityItems').innerHTML = filtered.length
    ? filtered.map(itemHtml).join('')
    : '<p class="empty">当前分类没有筛到仍在开放的事项。</p>';
}

function render(data) {
  const activity = data.activities || {};
  const items = Array.isArray(activity.items) ? activity.items : [];
  const sources = Array.isArray(activity.sources) ? activity.sources : [];
  const warnings = Array.isArray(activity.warnings) ? activity.warnings : [];
  currentItems = items;

  $('#status').classList.add('live');
  $('#status').innerHTML = `<i></i>${activity.ok ? '已同步' : activity.status === 'NOT_SYNCED' ? '待刷新' : '读取异常'}`;
  $('#refreshTitle').textContent = activity.ok
    ? `已找到 ${items.length} 项可参与事项`
    : '还没有最新活动数据';
  $('#refreshMessage').textContent = activity.ok
    ? activity.generated_at
      ? `更新于 ${new Date(activity.generated_at).toLocaleString('zh-CN')}。${activity.college ? `已追加「${activity.college.name}」内容。` : '尚未选择学院，只展示校级来源。'}`
      : '公众号与班级群消息不会自动读取。'
    : '在左侧发送“刷新校园活动”，抓取完成后再回来查看。';
  $('#countAll').textContent = String(items.length);
  $('#countDeadline').textContent = String(items.filter((item) => item.deadline).length);
  $('#countSources').textContent = String(sources.filter((item) => item.status !== 'READ_FAILED').length);
  $('#countFailed').textContent = String(sources.filter((item) => item.status === 'READ_FAILED').length);
  $('#activityUpdated').textContent = activity.generated_at
    ? `更新于 ${new Date(activity.generated_at).toLocaleTimeString('zh-CN')}`
    : '尚未刷新';
  $('#sourceUpdated').textContent = activity.date || '';
  $('#warningCount').textContent = `${warnings.length} 条`;

  const button = $('#copyActivityPrompt');
  const prompt = activity.prompt || '刷新校园活动。';
  button.onclick = async () => {
    await navigator.clipboard.writeText(prompt);
    button.textContent = '已复制';
    setTimeout(() => {
      button.textContent = '复制刷新指令';
    }, 1200);
  };
  const refreshButton = $('#refreshActivities');
  refreshButton.disabled = false;
  refreshButton.onclick = async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = '正在刷新…';
    try {
      const response = await fetch('/api/activities/refresh', {
        method: 'POST',
        headers: { 'X-Huayuan-Action': 'refresh-activities' },
      });
      if (!response.ok) throw new Error('refresh failed');
      refreshButton.textContent = '刷新完成';
      await refresh();
    } catch {
      refreshButton.textContent = '刷新失败';
    } finally {
      setTimeout(() => {
        refreshButton.disabled = false;
        refreshButton.textContent = '立即刷新';
      }, 1200);
    }
  };

  renderFilters(items);
  renderScopeFilters(items);
  renderItems(items);

  $('#sourceList').innerHTML = sources.length
    ? sources
        .map(
          (source) =>
            `<li><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.label)}</a><span class="${source.status === 'READ_FAILED' ? 'bad' : 'good'}">${esc(source.status)} · ${esc(source.items_seen)} 条</span></li>`
        )
        .join('')
    : '<li class="empty">尚未读取来源。</li>';

  $('#activityWarnings').innerHTML = warnings.length
    ? warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')
    : '<li class="empty">没有读取警告。</li>';
}

async function refresh() {
  try {
    const response = await fetch('/api/activities', { cache: 'no-store' });
    if (!response.ok) throw new Error('offline');
    const payload = await response.json();
    render({ activities: payload.activities });
  } catch {
    $('#status').classList.remove('live');
    $('#status').innerHTML = '<i></i>暂时断开';
  }
}

refresh();
setInterval(refresh, 5000);
