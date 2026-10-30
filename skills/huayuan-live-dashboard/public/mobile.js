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

function toast(message) {
  let element = document.getElementById('mobileToast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'mobileToast';
    element.className = 'copy-toast';
    document.body.appendChild(element);
  }
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 1800);
}

function renderConnection(mobile) {
  const box = $('#mobileConnection');
  if (!mobile.running) {
    box.innerHTML = '<p class="empty">启动后，这里会出现手机可打开的局域网地址和 6 位配对码。</p>';
    return;
  }
  const urls = Array.isArray(mobile.urls) && mobile.urls.length ? mobile.urls : [];
  const rows = [];
  if (urls.length) {
    rows.push(`<div class="mobile-endpoint"><small>手机在同一 Wi‑Fi 时打开</small>${urls
      .map((url) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`)
      .join('')}<button type="button" data-copy-url="${esc(urls[0])}">复制首个地址</button></div>`);
  }
  if (mobile.public_url) {
    rows.push(`<div class="mobile-endpoint"><small>手机不在同一网络时打开</small><a href="${esc(
      mobile.public_url
    )}" target="_blank" rel="noopener noreferrer">${esc(mobile.public_url)}</a></div>`);
  }
  rows.push(
    `<div class="mobile-endpoint"><small>手机配对码</small><strong>${esc(
      mobile.pairing_code
    )}</strong><button type="button" data-copy-pair="${esc(mobile.pairing_code)}">复制配对码</button></div>`
  );
  if (mobile.discovery_port) {
    rows.push(
      `<div class="mobile-endpoint"><small>安卓 App 自动发现</small><strong>UDP ${esc(
        mobile.discovery_port
      )}</strong></div>`
    );
  }
  box.innerHTML = rows.join('');
  box.querySelectorAll('[data-copy-url]').forEach((button) => {
    button.addEventListener('click', async () => {
      const copied = await copyText(button.dataset.copyUrl);
      toast(copied ? '手机地址已复制' : '复制失败，请手动选中');
    });
  });
  box.querySelectorAll('[data-copy-pair]').forEach((button) => {
    button.addEventListener('click', async () => {
      const copied = await copyText(button.dataset.copyPair);
      toast(copied ? '配对码已复制' : '复制失败，请手动选中');
    });
  });
}

function render(mobile) {
  const status = $('#mobileStatus');
  status.classList.toggle('live', Boolean(mobile.running));
  status.innerHTML = `<i></i>${mobile.running ? '手机工作台运行中' : mobile.initialized ? '未启动' : '等待初始化'}`;
  $('#mobileHeadline').textContent = mobile.running
    ? '手机工作台已经可以连接'
    : mobile.initialized
      ? '需要时再把安排送到手机'
      : '先补齐初始化信息';
  $('#mobileMessage').textContent = mobile.running
    ? '手机连接同一个 Wi‑Fi，打开地址并输入 6 位配对码。'
    : mobile.initialized
      ? '点击启动后会生成本机地址和一次性配对码，服务只读。'
      : '回到“今日安排”，复制顶部第一条初始化指令到左侧对话。';
  $('#mobileRunningLabel').textContent = mobile.running ? '运行中' : '未启动';
  $('#mobileStart').disabled = !mobile.initialized || mobile.running;
  $('#mobileStop').disabled = !mobile.running;
  $('#mobileReset').disabled = !mobile.running;
  $('#mobileUpdated').textContent = mobile.started_at
    ? `启动于 ${new Date(mobile.started_at).toLocaleTimeString('zh-CN')}`
    : '';
  renderConnection(mobile);
  document.body.dataset.mobileRunning = mobile.running ? 'true' : 'false';
}

async function status() {
  const response = await fetch('/api/mobile/status', { cache: 'no-store' });
  if (!response.ok) throw new Error('mobile status failed');
  return response.json();
}

async function action(path, actionName, button, busyText) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'X-Huayuan-Action': actionName },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || '操作失败');
    render(payload);
  } catch (error) {
    toast(String(error.message || error));
    try {
      render(await status());
    } catch {
      // Keep the current page visible.
    }
  } finally {
    button.textContent = oldText;
  }
}

async function refresh() {
  try {
    render(await status());
  } catch {
    $('#mobileStatus').classList.remove('live');
    $('#mobileStatus').innerHTML = '<i></i>暂时断开';
  }
}

$('#mobileStart').addEventListener('click', (event) =>
  action('/api/mobile/start', 'start-mobile', event.currentTarget, '正在启动…')
);
$('#mobileStop').addEventListener('click', (event) =>
  action('/api/mobile/stop', 'stop-mobile', event.currentTarget, '正在停止…')
);
$('#mobileReset').addEventListener('click', (event) =>
  action('/api/mobile/reset-pairing', 'reset-mobile-pairing', event.currentTarget, '正在换码…')
);
$('#copyMobileInstallPrompt').addEventListener('click', async () => {
  const copied = await copyText(
    '请打开手机工作台：先让电脑和手机连接同一个 Wi-Fi，再启动手机工作台，把页面上的地址和 6 位配对码告诉我，并引导我安装到手机桌面。'
  );
  toast(copied ? '手机引导指令已复制' : '复制失败，请手动选中');
});

refresh();
setInterval(refresh, 3000);
