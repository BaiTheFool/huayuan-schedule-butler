'use strict';

(function () {
  const DATA = window.HuayuanCampusData;
  const R = window.HuayuanRoute;
  const TBL = window.HuayuanTimetable;
  const TASK = window.HuayuanTasks;
  const EXAM_CATALOG = window.HuayuanExamCatalog;
  if (!DATA || !R) {
    document.body.innerHTML = '<p style="padding:24px">路线数据加载失败：请确认 data/campus-data.js 与 scripts/route-engine.js 与页面在同一目录结构下。</p>';
    return;
  }

  const { CAMPUS, POIS, WALK_NODES, WALK_EDGES, PRESETS } = DATA;
  const POI = new Map(POIS.map((p) => [p.id, p]));
  const NODE = new Map([...POIS, ...WALK_NODES].map((n) => [n.id, n]));

  const TYPE_LABEL = {
    class: '课程',
    study: '自习',
    sport: '运动',
    play: '放松',
    meal: '用餐',
    walk: '通勤',
    rest: '休息',
    free: '自由',
    shower: '生活',
    wake: '起居',
    sleep: '睡眠',
    place: '定位',
  };

  const CATEGORY_LABEL = {
    study: '自习空间',
    meal: '食堂',
    sport: '运动场地',
    play: '放松去处',
    class: '教学楼',
    dorm: '宿舍',
    service: '校园服务',
    gate: '校门',
  };

  const BUILDINGS = [
    { id: 'a1', w: 38, h: 48 },
    { id: 'a2', w: 38, h: 48 },
    { id: 'a3', w: 38, h: 48 },
    { id: 'a4', w: 38, h: 48 },
    { id: 'a5', w: 38, h: 48 },
    { id: 'library', w: 72, h: 52 },
    { id: 'canteen1', w: 50, h: 36 },
    { id: 'canteen2', w: 56, h: 40 },
    { id: 'c1', w: 54, h: 38 },
    { id: 'c11', w: 54, h: 38 },
    { id: 'gym', w: 56, h: 40 },
  ];

  const state = {
    date: '2026-10-29',
    preset: 'balanced',
    weights: { study: 46, play: 22, sport: 32 },
    weather: { condition: 'cloudy', temperature: 26, source: 'manual' },
    major: '',
    timetable: null,
    timetableInfo: null,
    timetableSource: 'demo',
    exams: null,
    examPlan: null,
    manualTasks: [],
    doneTaskIds: [],
    tasks: [],
    reminders: false,
    reminded: new Set(),
    avoidCrowd: false,
    mode: 'walk',
    gps: null,
    plan: null,
    selected: null,
  };

  const $ = (id) => document.getElementById(id);
  const svg = $('map');
  const view = { x: 0, y: 0, w: 1000, h: 1000 };

  // ---------- 坐标 ----------

  const W = 1000;
  const H = 1000;
  const PAD = 48;
  const B = CAMPUS.bounds;

  function x(lng) {
    return PAD + ((lng - B.west) / (B.east - B.west)) * (W - 2 * PAD);
  }

  function y(lat) {
    return PAD + ((B.north - lat) / (B.north - B.south)) * (H - 2 * PAD);
  }

  function xy(poi) {
    return [x(poi.lng), y(poi.lat)];
  }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function localNowIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(
      d.getHours()
    ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function colorOf(type) {
    return R.categories[type] || R.categories.rest;
  }

  // ---------- 地图底图 ----------

  function buildMap() {
    const parts = [];
    parts.push(`<defs>
      <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.4" flood-color="#5b503a" flood-opacity="0.16"/>
      </filter>
    </defs>`);

    parts.push(`<rect class="map-bg" x="0" y="0" width="1000" height="1000"/>`);

    // 校园边界
    const boundary = [
      [23.0437, 113.3995], [23.0436, 113.4058], [23.0446, 113.4073],
      [23.0469, 113.4082], [23.0514, 113.4082], [23.0531, 113.4066],
      [23.0532, 113.4005], [23.0518, 113.3992], [23.0491, 113.3988],
      [23.0461, 113.3989],
    ];
    const boundaryPoints = boundary.map(([lat, lng]) => `${x(lng).toFixed(1)},${y(lat).toFixed(1)}`).join(' ');
    parts.push(`<polygon class="campus-ground" points="${boundaryPoints}"/>`);
    parts.push(`<polygon class="campus-boundary" points="${boundaryPoints}"/>`);

    // 外围道路
    const eastX = x(113.40845);
    const northY = y(23.05335);
    parts.push(`<path class="outer-road-edge" d="M ${eastX} ${y(23.0433)} L ${eastX} ${y(23.0535)}"/>`);
    parts.push(`<path class="outer-road" d="M ${eastX} ${y(23.0433)} L ${eastX} ${y(23.0535)}"/>`);
    parts.push(`<path class="outer-road-line" d="M ${eastX} ${y(23.0433)} L ${eastX} ${y(23.0535)}"/>`);
    parts.push(`<path class="outer-road-edge" d="M ${x(113.3990)} ${northY} L ${x(113.4088)} ${northY}"/>`);
    parts.push(`<path class="outer-road" d="M ${x(113.3990)} ${northY} L ${x(113.4088)} ${northY}"/>`);
    parts.push(`<path class="outer-road-line" d="M ${x(113.3990)} ${northY} L ${x(113.4088)} ${northY}"/>`);

    // 绿色地块
    parts.push(`<ellipse cx="${x(113.4022)}" cy="${y(23.0518)}" rx="86" ry="56" fill="#dfe6d1" opacity=".75"/>`);
    parts.push(`<ellipse cx="${x(113.4068)}" cy="${y(23.0458)}" rx="72" ry="50" fill="#e1e8d3" opacity=".7"/>`);

    // 琴湖
    const lx = x(113.4071);
    const ly = y(23.0478);
    const lakePath = `M ${lx - 66} ${ly - 6}
      C ${lx - 58} ${ly - 48}, ${lx + 18} ${ly - 60}, ${lx + 56} ${ly - 26}
      C ${lx + 82} ${ly + 2}, ${lx + 44} ${ly + 44}, ${lx + 2} ${ly + 40}
      C ${lx - 40} ${ly + 36}, ${lx - 80} ${ly + 18}, ${lx - 66} ${ly - 6} Z`;
    parts.push(`<path class="lake" d="${lakePath}"/>`);
    parts.push(`<path class="lake-shine" d="M ${lx - 38} ${ly - 22} C ${lx - 10} ${ly - 36}, ${lx + 22} ${ly - 32}, ${lx + 40} ${ly - 20}"/>`);
    parts.push(`<text class="area-label" x="${lx}" y="${ly + 34}" text-anchor="middle">琴 湖</text>`);

    // 田径场
    const fx = x(113.40334);
    const fy = y(23.04506);
    parts.push(`<g transform="rotate(-8 ${fx} ${fy})">
      <ellipse class="track-outer" cx="${fx}" cy="${fy}" rx="76" ry="46"/>
      <ellipse class="track-inner" cx="${fx}" cy="${fy}" rx="54" ry="27"/>
      <ellipse class="track-line" cx="${fx}" cy="${fy}" rx="66" ry="38"/>
      <ellipse class="track-line" cx="${fx}" cy="${fy}" rx="60" ry="34"/>
    </g>`);

    // 道路：路口之间的主路 + 楼栋支路
    for (const [a, b] of WALK_EDGES) {
      const na = NODE.get(a);
      const nb = NODE.get(b);
      if (!na || !nb) continue;
      const bothJunction = a.startsWith('j_') && b.startsWith('j_');
      const d = `M ${x(na.lng).toFixed(1)} ${y(na.lat).toFixed(1)} L ${x(nb.lng).toFixed(1)} ${y(nb.lat).toFixed(1)}`;
      if (bothJunction) {
        parts.push(`<path class="road-casing" d="${d}"/>`);
        parts.push(`<path class="road" d="${d}"/>`);
        parts.push(`<path class="road-center" d="${d}"/>`);
      } else {
        parts.push(`<path class="footpath" d="${d}"/>`);
      }
    }

    // 树
    let seed = 19;
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const trees = [];
    for (let i = 0; i < 90; i += 1) {
      const lat = B.south + 0.0012 + rnd() * (B.north - B.south - 0.0024);
      const lng = B.west + 0.0008 + rnd() * (B.east - B.west - 0.0016);
      const px = x(lng);
      const py = y(lat);
      const tooClose = BUILDINGS.some((bdef) => {
        const p = POI.get(bdef.id);
        if (!p) return false;
        const [bx, by] = xy(p);
        return Math.abs(bx - px) < bdef.w * 0.72 + 12 && Math.abs(by - py) < bdef.h * 0.72 + 12;
      });
      if (tooClose) continue;
      if (Math.hypot(px - lx, py - ly) < 95) continue;
      if (Math.hypot(px - fx, py - fy) < 95) continue;
      trees.push({ px, py, r: 4 + rnd() * 4, dark: rnd() > 0.55 });
    }
    for (const t of trees) {
      parts.push(`<circle class="${t.dark ? 'tree-dark' : 'tree'}" cx="${t.px.toFixed(1)}" cy="${t.py.toFixed(1)}" r="${t.r.toFixed(1)}"/>`);
    }

    // 建筑
    const buildingLabel = {
      library: '图书馆',
      canteen1: '一饭',
      canteen2: '二饭',
      gym: '体育馆',
      c1: 'C1',
      c11: 'C11',
    };
    for (const def of BUILDINGS) {
      const p = POI.get(def.id);
      if (!p) continue;
      const [bx, by] = xy(p);
      const accent = def.id.startsWith('a') ? '' : def.id === 'gym' ? ' sport' : def.id.startsWith('c') ? ' dorm' : '';
      parts.push(`<rect class="building${accent}" data-poi="${def.id}" x="${(bx - def.w / 2).toFixed(1)}" y="${(by - def.h / 2).toFixed(1)}" width="${def.w}" height="${def.h}" rx="3.5"/>`);
      if (def.id.startsWith('a')) {
        parts.push(`<text class="building-label" x="${bx}" y="${by + 3}" pointer-events="none">${def.id.toUpperCase()}</text>`);
      } else if (buildingLabel[def.id]) {
        if (def.id === 'library') {
          parts.push(`<text class="building-label small left" x="${(bx - def.w / 2 + 5).toFixed(1)}" y="${by + 3}" pointer-events="none">${buildingLabel[def.id]}</text>`);
        } else {
          parts.push(`<text class="building-label small" x="${bx}" y="${(by + def.h / 2 - 5).toFixed(1)}" pointer-events="none">${buildingLabel[def.id]}</text>`);
        }
      }
    }

    // 道路文字
    parts.push(`<text class="map-road-label" x="${eastX + 11}" y="${y(23.049)}" transform="rotate(90 ${eastX + 11} ${y(23.049)})">外环东路</text>`);
    parts.push(`<text class="map-road-label" x="${x(113.402)}" y="${northY - 10}">中环东路</text>`);

    // 路线层放在建筑与标记之下，避免压住地点图标
    parts.push(`<g id="routeLayer"></g>`);

    // POI 标记
    const noLabel = new Set(['library', 'canteen1', 'canteen2', 'gym', 'c1', 'c11', 'field', 'lake', 'cafe', 'hospital']);
    for (const p of POIS) {
      if (p.category === 'class' || p.id === 'c11study' || p.id === 'cafe') continue;
      const [px, py] = xy(p);
      const showLabel = !noLabel.has(p.id);
      const labelDy = p.category === 'gate' ? -14 : 20;
      const mx = p.id === 'cafe' ? px + 17 : px;
      const my = p.id === 'cafe' ? py + 9 : py;
      parts.push(`<g class="poi" data-poi="${p.id}" style="--c:${colorOf(p.category)}" transform="translate(${mx.toFixed(1)} ${my.toFixed(1)})">
        <circle class="poi-halo-ring" r="11"/>
        <circle class="poi-halo" r="9.5"/>
        <text class="poi-icon" y="0.6">${p.icon}</text>
        ${showLabel ? `<text class="poi-label" y="${labelDy}">${esc(p.short)}</text>` : ''}
      </g>`);
    }

    // 动态层
    parts.push(`<g id="badgeLayer"></g>`);
    parts.push(`<g id="gpsLayer"></g>`);

    svg.innerHTML = parts.join('');
    applyView();
  }

  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  // ---------- 规划 ----------

  function currentWeights() {
    return {
      study: state.weights.study / 100,
      play: state.weights.play / 100,
      sport: state.weights.sport / 100,
    };
  }

  function refreshTasks() {
    if (!TASK) {
      state.tasks = [];
      state.examPlan = null;
      return;
    }
    const now = localNowIso();
    const today = now.slice(0, 10);
    const nowForTasks = state.date === today ? now : state.date;
    const plan = state.exams
      ? TASK.planExamTasks(state.exams.exams, { major: state.major, now: nowForTasks })
      : { tasks: [], exams: [], warnings: [] };
    const manual = TASK.normalizeManualTasks(state.manualTasks);
    const done = new Set(state.doneTaskIds);
    state.tasks = TASK.mergeTasks(plan.tasks, manual).map((task) => ({
      ...task,
      done: Boolean(task.done) || done.has(task.id),
    }));
    state.examPlan = plan;
  }

  function tasksForRoute() {
    const limit = new Date(`${state.date}T23:59:59`);
    limit.setDate(limit.getDate() + 21);
    return state.tasks.filter((task) => {
      if (task.done) return false;
      if (!task.due) return true;
      const due = new Date(task.due);
      return Number.isNaN(due.getTime()) || due <= limit;
    });
  }

  function replan(showToast) {
    refreshTasks();
    const plan = R.planDay({
      date: state.date,
      preset: state.preset,
      weights: currentWeights(),
      mode: state.mode,
      weather: state.weather,
      avoidCrowd: state.avoidCrowd,
      gps: state.gps,
      timetable: state.timetable || undefined,
      weekNumber: state.timetableInfo ? state.timetableInfo.week_number : null,
      major: state.major || undefined,
      tasks: tasksForRoute(),
    });

    if (!plan.ok) {
      state.plan = null;
      toast(plan.message || '没有生成路线');
      return;
    }

    state.plan = plan;
    const uniqueStops = new Set(plan.stops.map((s) => s.poiId)).size;
    renderTimeline(plan);
    renderRoute(plan);
    renderStats(plan);
    renderWarnings(plan);
    renderWeather(plan);
    renderProfile();
    renderTasks();
    $('topDate').textContent = plan.meta.day_name.replace('星期', '周');
    $('dayMeta').textContent = `${plan.meta.major ? `${plan.meta.major} · ` : ''}${plan.meta.preset_name} · ${countClasses(plan)} 节课 · ${uniqueStops} 个地点 · ${plan.summary.tasks_scheduled || 0} 项任务`;
    $('mapSummary').innerHTML = `<b>${uniqueStops} 个地点</b> · ${plan.stops.length} 段停留 · 步行 ${(plan.summary.walk_meters / 1000).toFixed(1)} km / ${plan.summary.walk_minutes} 分钟 · 自习 ${fmtShort(plan.summary.study_minutes)} · 运动 ${plan.summary.sport_minutes} 分钟${plan.summary.task_minutes ? ` · 任务 ${plan.summary.task_minutes} 分钟` : ''}`;
    $('gpsState').textContent = state.gps
      ? state.gps.simulated
        ? '起点：模拟定位'
        : `已使用手机定位（本地${state.gps.accuracy ? `，约 ±${state.gps.accuracy} m` : ''}）`
      : '未使用定位';

    if (state.selected && !POI.has(state.selected)) state.selected = null;
    if (state.selected) showPoi(state.selected);
    if (showToast) toast(`已生成 ${plan.meta.date} 的路线：${plan.summary.stops} 站，步行约 ${plan.summary.walk_minutes} 分钟`);
  }

  function countClasses(plan) {
    return plan.blocks.filter((b) => b.type === 'class').length;
  }

  function fmtShort(minutes) {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h}h${String(rest).padStart(2, '0')}` : `${h}h`;
  }

  // ---------- 渲染：时间轴 ----------

  function renderTimeline(plan) {
    const host = $('timeline');
    const rows = [];
    for (const b of plan.blocks) {
      const isWalk = b.type === 'walk';
      const color = colorOf(b.type);
      const meta = isWalk
        ? `${b.reason || ''}`
        : `${b.start}–${b.end} · ${fmtShort(b.duration_min)}${b.poi_name ? ` · ${b.poi_name}` : ''}`;
      const reason = isWalk ? '' : b.reason || '';
      rows.push(`<div class="tl-item ${isWalk ? 'walk' : ''} ${b.type === 'sleep' ? 'sleep' : ''}" data-poi="${b.poi_id || ''}" data-type="${b.type}" style="--c:${color}">
        <div class="tl-time"><b>${isWalk ? b.start : b.start}</b><span>${b.end}</span></div>
        <div class="tl-axis"><i class="tl-dot"></i></div>
        <div class="tl-body">
          <div class="tl-title">${esc(b.title)}${isWalk ? '' : `<span class="tag">${TYPE_LABEL[b.type] || ''}</span>`}</div>
          <div class="tl-meta">${esc(meta)}</div>
          ${b.task ? `<div class="tl-task">任务：${esc(b.task.title)} · ${b.task.minutes} 分钟</div>` : ''}
          ${reason ? `<div class="tl-reason">${esc(reason)}</div>` : ''}
        </div>
      </div>`);
    }
    host.innerHTML = rows.join('');

    host.querySelectorAll('.tl-item').forEach((row) => {
      row.addEventListener('click', () => {
        const poiId = row.getAttribute('data-poi');
        if (poiId) selectPoi(poiId, true);
      });
    });
  }

  function renderWarnings(plan) {
    const items = [...(plan.warnings || []), ...((plan.validation && plan.validation.issues) || [])];
    const box = $('warnings');
    if (!items.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = `<b>需要留意</b><ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
  }

  function renderWeather(plan) {
    const w = plan.meta.weather;
    if (!w) return;
    $('weatherBadge').textContent = `${w.icon} ${w.label} ${w.temperature}°C${w.source === 'open-meteo' ? ' · 实时' : ''}`;
    $('weatherBadge').title = w.source === 'open-meteo' ? '天气来源：Open-Meteo（出发前请复核）' : '手动天气（出发前请复核）';
    const alert = $('weatherAlert');
    const bad = w.is_wet || w.is_hot || w.is_cold || w.is_polluted || w.is_severe;
    if (!bad || !(plan.meta.weather_advice || []).length) {
      alert.hidden = true;
      alert.innerHTML = '';
      return;
    }
    const cls = w.is_wet ? 'wet' : w.is_hot ? 'hot' : w.is_polluted ? 'polluted' : '';
    alert.className = `weather-alert ${cls}`;
    alert.hidden = false;
    alert.innerHTML = `<b>${esc(w.icon)} ${esc(w.label)} ${w.temperature}°C · 步行 ×${w.travel_factor}</b><br>${esc((plan.meta.weather_advice || []).slice(0, 2).join('；'))}`;
  }

  function renderStats(plan) {
    $('statWalk').textContent = `${(plan.summary.walk_meters / 1000).toFixed(1)} km`;
    $('statWalkMin').textContent = `${plan.summary.walk_minutes} 分钟步行`;
    $('statStudy').textContent = fmtShort(plan.summary.study_minutes);
    $('statSport').textContent = `${plan.summary.sport_minutes} 分钟`;
    $('statPlay').textContent = `${plan.summary.play_minutes} 分钟`;
  }

  // ---------- 渲染：路线 ----------

  function pathFromPoints(points) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.lng).toFixed(1)} ${y(p.lat).toFixed(1)}`).join(' ');
  }

  function renderRoute(plan) {
    const routeLayer = $('routeLayer');
    const badgeLayer = $('badgeLayer');
    const gpsLayer = $('gpsLayer');
    const points = (plan.route && plan.route.points) || [];
    const arrows = [];
    for (const block of plan.blocks) {
      if (block.type !== 'walk' || !block.leg || !block.leg.points || block.leg.points.length < 2) continue;
      const pts = block.leg.points;
      const mid = Math.max(1, Math.floor(pts.length / 2));
      const a = pts[mid - 1];
      const b = pts[mid];
      if (!a || !b) continue;
      const ax = x(a.lng);
      const ay = y(a.lat);
      const bx = x(b.lng);
      const by = y(b.lat);
      const angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
      arrows.push(`<path class="route-arrow" d="M -3.6 -3.2 L 4.2 0 L -3.6 3.2 Z" transform="translate(${((ax + bx) / 2).toFixed(1)} ${((ay + by) / 2).toFixed(1)}) rotate(${angle.toFixed(1)})"/>`);
    }
    if (points.length > 1) {
      const d = pathFromPoints(points);
      routeLayer.innerHTML = `<path class="route-halo" d="${d}"/><path class="route-line" d="${d}"/><path class="route-dash" d="${d}"/>${arrows.join('')}`;
    } else {
      routeLayer.innerHTML = '';
    }

    const grouped = new Map();
    plan.stops.forEach((stop, index) => {
      const p = POI.get(stop.poiId);
      if (!p) return;
      if (!grouped.has(p.id)) grouped.set(p.id, { poi: p, first: index + 1, count: 0 });
      grouped.get(p.id).count += 1;
    });
    const badgeOffset = {
      library: [-12, -31],
      cafe: [20, 4],
      canteen1: [-16, -26],
      canteen2: [14, -27],
      c11: [0, -27],
      c1: [0, -25],
      field: [0, -12],
      gym: [0, -25],
      a1: [0, -33],
      a2: [0, -33],
      a3: [0, -33],
      a4: [0, -33],
      a5: [0, -33],
    };
    const badges = [];
    for (const item of grouped.values()) {
      const [px, py] = xy(item.poi);
      const offset = badgeOffset[item.poi.id] || [0, -22];
      badges.push(`<g class="stop-badge" transform="translate(${(px + offset[0]).toFixed(1)} ${(py + offset[1]).toFixed(1)})">
        <circle r="7.2"/><text>${item.first}</text>
        ${item.count > 1 ? `<text class="badge-count" x="9" y="-7">×${item.count}</text>` : ''}
      </g>`);
    }
    badgeLayer.innerHTML = badges.join('');

    if (plan.gps && plan.gps.in_campus) {
      const gx = x(plan.gps.lng);
      const gy = y(plan.gps.lat);
      gpsLayer.innerHTML = `<g transform="translate(${gx.toFixed(1)} ${gy.toFixed(1)})">
        <circle class="gps-pulse" r="13"/>
        <circle class="gps-dot" r="6"/>
      </g>`;
    } else {
      gpsLayer.innerHTML = '';
    }

    document.querySelectorAll('[data-poi]').forEach((el) => {
      el.classList.toggle('active', state.selected === el.getAttribute('data-poi'));
    });
  }

  // ---------- 地点卡片 ----------

  function selectPoi(poiId, fromTimeline) {
    const poi = POI.get(poiId);
    if (!poi) return;
    state.selected = poiId;
    showPoi(poiId);
    document.querySelectorAll('[data-poi]').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-poi') === poiId);
    });
    if (fromTimeline) {
      const el = document.querySelector(`.poi[data-poi="${poiId}"]`);
      if (el && el.scrollIntoView) {
        // SVG 元素没有可滚动容器，这里只做高亮；保持时间轴滚动位置不变。
      }
    }
  }

  function showPoi(poiId) {
    const poi = POI.get(poiId);
    if (!poi) return;
    const card = $('poiCard');
    card.hidden = false;
    $('poiKicker').textContent = CATEGORY_LABEL[poi.category] || '校园地点';
    $('poiName').textContent = poi.name;
    const confidence = poi.hours_confidence === 'approx' ? ' · 以现场为准' : '';
    $('poiHours').textContent = `${poi.hours_label || '全天'}${confidence}`;
    $('poiDesc').textContent = poi.desc || '';
    $('poiTags').innerHTML = (poi.tags || []).map((tag) => `<span>${esc(tag)}</span>`).join('');
    $('poiNav').href = `https://uri.amap.com/marker?position=${poi.lng},${poi.lat}&name=${encodeURIComponent(poi.name)}&coordinate=gaode&callnative=1`;
    $('poiStart').onclick = () => {
      state.gps = { lat: poi.lat, lng: poi.lng, coord: 'gcj02', accuracy: 0, simulated: true };
      $('clearGpsBtn').hidden = false;
      replan(true);
    };
  }

  // ---------- 交互 ----------

  function setPreset(id) {
    const preset = PRESETS.find((item) => item.id === id);
    if (!preset) return;
    state.preset = id;
    state.weights = {
      study: Math.round(preset.weights.study * 100),
      play: Math.round(preset.weights.play * 100),
      sport: Math.round(preset.weights.sport * 100),
    };
    document.querySelectorAll('#presets button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === id);
    });
    syncSliders();
    replan(true);
  }

  function syncSliders() {
    for (const [key, value] of Object.entries(state.weights)) {
      const cap = key.charAt(0).toUpperCase() + key.slice(1);
      const input = $(`sl${cap}`);
      const label = $(`w${cap}`);
      if (input) {
        input.value = value;
        input.style.setProperty('--p', `${value}%`);
      }
      if (label) label.textContent = `${value}%`;
    }
  }

  function markCustom() {
    state.preset = 'custom';
    document.querySelectorAll('#presets button').forEach((btn) => btn.classList.remove('active'));
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 3600);
  }

  function requestGps() {
    if (!navigator.geolocation) {
      toast('这个浏览器不支持定位。可以用「模拟在图书馆」体验路线。');
      return;
    }
    toast('正在读取定位…如果浏览器询问，请允许一次');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.gps = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy || 0),
          coord: 'wgs84',
        };
        $('clearGpsBtn').hidden = false;
        replan(true);
      },
      (error) => {
        const text = error.code === 1 ? '你拒绝了定位授权' : error.code === 3 ? '定位超时' : '定位失败';
        toast(`${text}。可以点「模拟在图书馆」看效果，定位不会上传。`);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  function syncWeatherControls() {
    const w = state.weather || {};
    const condition = w.condition || 'cloudy';
    if ($('weatherSelect').value !== condition) $('weatherSelect').value = condition;
    const temp = Number.isFinite(Number(w.temperature)) ? Number(w.temperature) : 26;
    if (document.activeElement !== $('tempInput')) $('tempInput').value = temp;
  }

  function applyWeather(condition, temperature, extra) {
    state.weather = {
      condition,
      temperature: Number(temperature),
      source: (extra && extra.source) || 'manual',
      ...(extra || {}),
    };
    syncWeatherControls();
    replan(false);
  }

  async function fetchLiveWeather() {
    const btn = $('weatherLive');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const url =
        'https://api.open-meteo.com/v1/forecast?latitude=23.0486&longitude=113.4041' +
        '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
        '&daily=temperature_2m_max,precipitation_sum,precipitation_probability_max,weather_code' +
        '&timezone=Asia%2FShanghai&forecast_days=1';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const current = data.current || {};
      const daily = data.daily || {};
      const code = Number(current.weather_code);
      const dayCode = Number((daily.weather_code || [])[0] ?? code);
      const dayWeatherCode = Number.isFinite(dayCode) ? dayCode : code;
      const temp = Number(current.temperature_2m);
      const tmax = Number((daily.temperature_2m_max || [])[0] ?? temp);
      const precip = Number((daily.precipitation_sum || [])[0] ?? current.precipitation ?? 0);
      const prob = Number((daily.precipitation_probability_max || [])[0] ?? 0);
      let condition = 'cloudy';
      if (dayWeatherCode >= 95) condition = 'storm';
      else if (dayWeatherCode >= 51 || precip >= 0.5) condition = 'rain';
      else if (tmax >= 33) condition = 'heat';
      else if (temp <= 8) condition = 'cold';
      else if (dayWeatherCode <= 1) condition = 'clear';
      state.weather = {
        condition,
        temperature: condition === 'heat' ? Math.round(tmax) : Math.round(temp),
        temperature_max: Math.round(tmax),
        feels_like: Number.isFinite(Number(current.apparent_temperature)) ? Math.round(Number(current.apparent_temperature)) : null,
        precipitation: precip,
        precipitation_probability: prob,
        wind_speed_kmh: Number(current.wind_speed_10m) || 0,
        source: 'open-meteo',
        updated_at: new Date().toISOString(),
      };
      syncWeatherControls();
      replan(true);
      toast(`已获取实时天气：${state.weather.temperature}°C，降水概率 ${Math.round(prob)}%（Open-Meteo）`);
    } catch (error) {
      toast(`实时天气获取失败（${error.message}），保留当前手动天气`);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  function renderProfile() {
    const input = $('majorInput');
    if (input && document.activeElement !== input) input.value = state.major || '';
    $('brandSub').textContent = state.major ? `${state.major} · 大学城校区` : '大学城校区 · 校园路线';

    const status = $('timetableStatus');
    status.className = 'profile-status';
    status.title = '';
    if (state.timetableInfo) {
      const info = state.timetableInfo;
      const s = info.summary;
      const week = s.week_number ? ` · 第 ${s.week_number} 周` : ' · 周次未识别';
      status.textContent = `已导入 ${s.active}/${s.total} 门本周课程${week} · ${info.campus.label}`;
      if (info.warnings && info.warnings.length) {
        status.classList.add('warn');
        status.title = info.warnings.join('；');
      } else {
        status.classList.add('ok');
      }
    } else {
      status.textContent = '当前：示例课表（虚构）；导入教务课表后按真实课程排';
    }
  }

  function saveStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // 隐私模式/禁用 localStorage 时只保留在内存
    }
  }

  function openTaskSection() {
    const section = $('taskSection');
    if (section) section.open = true;
  }

  function renderTasks() {
    if (!TASK) return;
    const pending = state.tasks.filter((task) => !task.done).length;
    $('taskCount').textContent = `${pending} 项`;
    $('remindBtn').textContent = state.reminders ? '页面提醒已开' : '开启页面提醒';
    $('clearExamsBtn').hidden = !state.exams;

    const status = $('examStatus');
    if (!state.exams) {
      status.textContent = '尚未导入考试安排；载入示例可看效果';
    } else {
      const matched = (state.examPlan && state.examPlan.exams) || [];
      const source = state.exams.source || '导入的考试安排';
      const demo = state.exams.demo && !source.includes('虚构') ? '（虚构）' : '';
      const majorText = state.major ? `匹配「${state.major}」` : '未填专业，展示全部';
      status.textContent = `${source}${demo} · ${matched.length} 场 · ${majorText}`;
      if (state.examPlan && state.examPlan.warnings && state.examPlan.warnings.length) {
        status.textContent += ` · ${state.examPlan.warnings[0]}`;
      }
    }

    const exams = (state.examPlan && state.examPlan.exams) || [];
    $('examList').innerHTML = exams.length
      ? exams
          .map((exam) => {
            const when = `${exam.date.slice(5)} ${exam.start || ''}`.trim();
            const venue = exam.venue ? ` · ${esc(exam.venue)}` : '';
            return `<div class="exam-item"><b>${esc(exam.title)}</b><span>${esc(when)}${venue} · ${exam.days_left} 天后</span></div>`;
          })
          .join('')
      : state.exams
      ? '<div class="task-empty">没有匹配当前专业的考试；换个专业或导入考试安排</div>'
      : '';

    const now = new Date();
    $('taskList').innerHTML = state.tasks.length
      ? state.tasks
          .map((task) => {
            const st = TASK.taskStatus(task, now);
            const due = task.due ? task.due.replace('T', ' ') : '无截止';
            const source = task.source === 'exam' ? '考试' : '手动';
            return `<div class="task-item ${task.done ? 'done' : ''}" data-task-id="${esc(task.id)}">
              <input type="checkbox" data-task-check ${task.done ? 'checked' : ''} aria-label="完成 ${esc(task.title)}" />
              <div>
                <div class="task-title">${esc(task.title)}</div>
                <div class="task-meta">[${source}] ${due} · 预计 ${task.estimated_minutes} 分钟${task.course ? ` · ${esc(task.course)}` : ''}</div>
              </div>
              <div class="task-side">
                <span class="task-due ${st.key}">${esc(st.label)}</span>
                ${task.source === 'manual' ? '<button type="button" class="task-del" data-task-del aria-label="删除">×</button>' : ''}
              </div>
            </div>`;
          })
          .join('')
      : '<div class="task-empty">还没有待办。可以手动加一条，或导入考试后自动生成复习任务。</div>';

    $('taskList').querySelectorAll('[data-task-check]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const row = event.target.closest('[data-task-id]');
        if (row) toggleTask(row.getAttribute('data-task-id'), event.target.checked);
      });
    });
    $('taskList').querySelectorAll('[data-task-del]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = event.target.closest('[data-task-id]');
        if (row) deleteManualTask(row.getAttribute('data-task-id'));
      });
    });
  }

  function toggleTask(id, done) {
    const manual = state.manualTasks.find((task) => task.id === id);
    if (manual) {
      manual.done = done;
      saveStorage('huayuan.manualTasks', state.manualTasks);
    } else {
      const set = new Set(state.doneTaskIds);
      if (done) set.add(id);
      else set.delete(id);
      state.doneTaskIds = [...set];
      saveStorage('huayuan.doneTaskIds', state.doneTaskIds);
    }
    replan(false);
  }

  function deleteManualTask(id) {
    state.manualTasks = state.manualTasks.filter((task) => task.id !== id);
    saveStorage('huayuan.manualTasks', state.manualTasks);
    replan(false);
    toast('已删除待办');
  }

  function addManualTask() {
    if (!TASK) {
      toast('待办模块没加载，无法添加');
      return;
    }
    const title = String($('todoTitle').value || '').trim();
    if (!title) {
      toast('先写一条待办标题');
      $('todoTitle').focus();
      return;
    }
    const date = $('todoDate').value || state.date;
    const minutes = Math.max(10, Math.min(480, Number($('todoMinutes').value) || 60));
    const priority = $('todoPriority').value || 'P2';
    state.manualTasks.push({
      id: `manual-${Date.now()}`,
      title: title.slice(0, 100),
      due: `${date}T23:59`,
      due_date: date,
      priority,
      estimated_minutes: minutes,
      source: 'manual',
      done: false,
    });
    saveStorage('huayuan.manualTasks', state.manualTasks);
    $('todoTitle').value = '';
    openTaskSection();
    replan(true);
    toast(`已加入待办：${title}`);
  }

  function handleExamsFile(file) {
    if (!file || !TASK) return;
    const reader = new FileReader();
    reader.onload = () => {
      let raw;
      try {
        raw = JSON.parse(String(reader.result || '').replace(/^\uFEFF/, ''));
      } catch (error) {
        toast(`考试 JSON 解析失败：${error.message}`);
        return;
      }
      const list = Array.isArray(raw) ? raw : raw.exams || [];
      const exams = list.map((item) => TASK.normalizeExam(item)).filter(Boolean);
      if (!exams.length) {
        toast('没有解析出考试；需要 exams 数组，字段至少包含 title 和 date');
        return;
      }
      state.exams = {
        exams,
        source: (raw && raw.source) || '导入的考试安排',
        demo: false,
      };
      saveStorage('huayuan.exams', state.exams);
      openTaskSection();
      replan(true);
      toast(`已导入 ${exams.length} 场考试，已按专业生成复习任务`);
    };
    reader.onerror = () => toast('考试文件读取失败');
    reader.readAsText(file, 'utf-8');
  }

  function loadDemoExams() {
    if (!TASK || !EXAM_CATALOG) {
      toast('考试示例数据没加载');
      return;
    }
    state.exams = {
      exams: EXAM_CATALOG.DEMO_EXAMS.exams,
      source: EXAM_CATALOG.DEMO_EXAMS.source,
      demo: true,
    };
    saveStorage('huayuan.exams', state.exams);
    openTaskSection();
    replan(true);
    toast('已载入示例考试（虚构），不是教务真实安排');
  }

  function clearExams() {
    state.exams = null;
    try {
      localStorage.removeItem('huayuan.exams');
    } catch (error) {
      // ignore
    }
    replan(false);
    toast('已清空考试安排');
  }

  let reminderTimer = null;

  function checkDueReminders() {
    if (!state.reminders || !TASK) return;
    const now = new Date();
    for (const task of state.tasks) {
      if (task.done || state.reminded.has(task.id) || !task.due) continue;
      const due = TASK.parseDate(task.due);
      if (!due) continue;
      const diff = due.getTime() - now.getTime();
      if (diff > 60 * 60 * 1000 || diff < -5 * 60 * 1000) continue;
      state.reminded.add(task.id);
      const message = `${task.title}（${task.due.replace('T', ' ')}）`;
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification('华园一日 · 任务提醒', { body: message });
        } catch (error) {
          // 通知失败时仍有页内 toast
        }
      }
      toast(`任务提醒：${message}`);
    }
  }

  function enableReminders() {
    if (state.reminders) {
      state.reminders = false;
      if (reminderTimer) clearInterval(reminderTimer);
      reminderTimer = null;
      renderTasks();
      toast('已关闭页面提醒');
      return;
    }
    if (!('Notification' in window)) {
      toast('这个浏览器不支持通知；页面内仍会显示到期标签');
      return;
    }
    const start = () => {
      state.reminders = true;
      saveStorage('huayuan.reminders', true);
      if (reminderTimer) clearInterval(reminderTimer);
      reminderTimer = setInterval(checkDueReminders, 60000);
      checkDueReminders();
      renderTasks();
      toast('页面提醒已开启：页面开着时，截止前 1 小时提醒');
    };
    if (Notification.permission === 'granted') {
      start();
      return;
    }
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') start();
      else toast('没有拿到通知权限；可以继续看页面里的截止标签');
    });
  }

  function saveMajor() {
    const value = String($('majorInput').value || '').trim().slice(0, 40);
    state.major = value;
    try {
      if (value) localStorage.setItem('huayuan.major', value);
      else localStorage.removeItem('huayuan.major');
    } catch (error) {
      // 浏览器禁用 localStorage 时只保留在内存里
    }
    renderProfile();
    replan(false);
    toast(value ? `专业已保存：${value}` : '已清空专业');
  }

  function refreshWeekForDate() {
    if (!state.timetable || !TBL) return;
    const result = TBL.summarizeTimetable(state.timetable, { date: state.date });
    if (result.ok) state.timetableInfo = result;
  }

  function handleTimetableFile(file) {
    if (!file) return;
    if (!TBL) {
      toast('课表导入模块没加载，无法解析文件');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = TBL.parseTimetableText(reader.result, { date: state.date });
      if (!result.ok) {
        toast(result.message || '课表导入失败');
        const status = $('timetableStatus');
        status.className = 'profile-status err';
        status.textContent = `导入失败：${result.message || result.error}`;
        return;
      }
      state.timetable = result.timetable;
      state.timetableInfo = result;
      state.timetableSource = 'imported';
      renderProfile();
      replan(true);
      const s = result.summary;
      toast(`已导入 ${s.total} 门课程（本周 ${s.active} 门）${result.week_number ? `，第 ${result.week_number} 周` : ''}`);
    };
    reader.onerror = () => toast('文件读取失败，请换一个 jw-timetable.json');
    reader.readAsText(file, 'utf-8');
  }

  function resetTimetable() {
    state.timetable = null;
    state.timetableInfo = null;
    state.timetableSource = 'demo';
    renderProfile();
    replan(false);
    toast('已切回示例课表（虚构数据）');
  }

  function bind() {
    $('dateInput').addEventListener('change', (e) => {
      state.date = e.target.value || state.date;
      if (!$('todoDate').value) $('todoDate').value = state.date;
      refreshWeekForDate();
      replan(false);
    });

    $('saveMajorBtn').addEventListener('click', saveMajor);
    $('majorInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveMajor();
      }
    });
    $('importTimetableBtn').addEventListener('click', () => {
      if (!TBL) {
        toast('课表导入模块没加载，无法解析文件');
        return;
      }
      $('timetableFile').click();
    });
    $('timetableFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      handleTimetableFile(file);
      e.target.value = '';
    });
    $('demoTimetableBtn').addEventListener('click', resetTimetable);

    $('importExamsBtn').addEventListener('click', () => $('examsFile').click());
    $('examsFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      handleExamsFile(file);
      e.target.value = '';
    });
    $('demoExamsBtn').addEventListener('click', loadDemoExams);
    $('clearExamsBtn').addEventListener('click', clearExams);
    $('remindBtn').addEventListener('click', enableReminders);
    $('addTodoBtn').addEventListener('click', addManualTask);
    $('todoTitle').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addManualTask();
      }
    });

    document.querySelectorAll('#presets button').forEach((btn) => {
      btn.addEventListener('click', () => setPreset(btn.dataset.preset));
    });

    for (const [key, id] of [['study', 'slStudy'], ['play', 'slPlay'], ['sport', 'slSport']]) {
      $(id).addEventListener('input', (e) => {
        state.weights[key] = Number(e.target.value);
        e.target.style.setProperty('--p', `${e.target.value}%`);
        const cap = key.charAt(0).toUpperCase() + key.slice(1);
        $(`w${cap}`).textContent = `${e.target.value}%`;
        markCustom();
        replan(false);
      });
    }

    $('weatherSelect').addEventListener('change', (e) => {
      let temp = Number($('tempInput').value) || 26;
      if (e.target.value === 'heat' && temp < 33) temp = 35;
      if (e.target.value === 'cold' && temp > 12) temp = 8;
      applyWeather(e.target.value, temp);
    });
    $('tempInput').addEventListener('change', (e) => {
      const temp = Number(e.target.value);
      if (!Number.isFinite(temp)) return;
      applyWeather(state.weather.condition, temp);
    });
    $('weatherLive').addEventListener('click', fetchLiveWeather);
    $('crowdChip').addEventListener('click', () => {
      state.avoidCrowd = !state.avoidCrowd;
      $('crowdChip').classList.toggle('active', state.avoidCrowd);
      replan(false);
    });
    $('bikeChip').addEventListener('click', () => {
      state.mode = state.mode === 'bike' ? 'walk' : 'bike';
      $('bikeChip').classList.toggle('active', state.mode === 'bike');
      replan(false);
    });

    $('generateBtn').addEventListener('click', () => replan(true));
    $('gpsBtn').addEventListener('click', requestGps);
    $('simGpsBtn').addEventListener('click', () => {
      const poi = POI.get('library');
      state.gps = { lat: poi.lat, lng: poi.lng, coord: 'gcj02', accuracy: 0, simulated: true };
      $('clearGpsBtn').hidden = false;
      replan(true);
    });
    $('clearGpsBtn').addEventListener('click', () => {
      state.gps = null;
      $('clearGpsBtn').hidden = true;
      replan(false);
    });

    $('exportBtn').addEventListener('click', () => {
      if (!state.plan) return;
      const md = R.buildMarkdown(state.plan);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `华园一日-${state.plan.meta.date}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('已导出 Markdown，可直接放进笔记软件');
    });

    $('printBtn').addEventListener('click', () => window.print());

    $('poiClose').addEventListener('click', () => {
      $('poiCard').hidden = true;
      state.selected = null;
      document.querySelectorAll('[data-poi]').forEach((el) => el.classList.remove('active'));
    });

    svg.addEventListener('click', (e) => {
      const target = e.target.closest('[data-poi]');
      if (!target) return;
      const poiId = target.getAttribute('data-poi');
      if (poiId) selectPoi(poiId, false);
    });

    // 缩放
    $('zoomIn').addEventListener('click', () => zoom(0.78));
    $('zoomOut').addEventListener('click', () => zoom(1.28));
    $('zoomReset').addEventListener('click', () => {
      view.x = 0;
      view.y = 0;
      view.w = W;
      view.h = H;
      applyView();
    });

    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.12 : 0.89;
        zoom(factor, e.clientX, e.clientY);
      },
      { passive: false }
    );

    // 拖拽平移
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.poi') || e.target.closest('.stop-badge')) return;
      drag = { x: e.clientX, y: e.clientY, view: { ...view } };
      svg.setPointerCapture(e.pointerId);
      svg.style.cursor = 'grabbing';
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const rect = svg.getBoundingClientRect();
      const dx = ((e.clientX - drag.x) / rect.width) * drag.view.w;
      const dy = ((e.clientY - drag.y) / rect.height) * drag.view.h;
      view.x = clamp(drag.view.x - dx, 0, W - drag.view.w);
      view.y = clamp(drag.view.y - dy, 0, H - drag.view.h);
      view.w = drag.view.w;
      view.h = drag.view.h;
      applyView();
    });
    svg.addEventListener('pointerup', () => {
      drag = null;
      svg.style.cursor = 'grab';
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $('poiCard').hidden = true;
        state.selected = null;
        document.querySelectorAll('[data-poi]').forEach((el) => el.classList.remove('active'));
      }
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function zoom(factor, clientX, clientY) {
    const oldW = view.w;
    const oldH = view.h;
    const nextW = clamp(oldW * factor, 360, 1400);
    const nextH = nextW * (oldH / oldW);
    let cx = view.x + oldW / 2;
    let cy = view.y + oldH / 2;
    if (clientX != null) {
      const rect = svg.getBoundingClientRect();
      const rx = (clientX - rect.left) / rect.width;
      const ry = (clientY - rect.top) / rect.height;
      cx = view.x + rx * oldW;
      cy = view.y + ry * oldH;
    }
    view.x = clamp(cx - (nextW * (cx - view.x)) / oldW, 0, W - nextW);
    view.y = clamp(cy - (nextH * (cy - view.y)) / oldH, 0, H - nextH);
    view.w = nextW;
    view.h = nextH;
    applyView();
  }

  // ---------- 启动 ----------

  const params = new URLSearchParams(window.location.search);
  try {
    const savedMajor = localStorage.getItem('huayuan.major');
    if (savedMajor) state.major = savedMajor.slice(0, 40);
    const savedExams = JSON.parse(localStorage.getItem('huayuan.exams') || 'null');
    if (savedExams && Array.isArray(savedExams.exams) && savedExams.exams.length) state.exams = savedExams;
    const savedTasks = JSON.parse(localStorage.getItem('huayuan.manualTasks') || '[]');
    if (Array.isArray(savedTasks)) state.manualTasks = savedTasks;
    const savedDone = JSON.parse(localStorage.getItem('huayuan.doneTaskIds') || '[]');
    if (Array.isArray(savedDone)) state.doneTaskIds = savedDone;
    state.reminders = localStorage.getItem('huayuan.reminders') === 'true';
  } catch (error) {
    // 隐私模式下 localStorage 可能不可用
  }
  if (params.get('major')) state.major = String(params.get('major')).trim().slice(0, 40);
  if (params.get('date') && /^\d{4}-\d{2}-\d{2}$/.test(params.get('date'))) {
    state.date = params.get('date');
    $('dateInput').value = state.date;
  }
  $('todoDate').value = state.date;
  const presetParam = params.get('preset');
  const presetFromUrl = PRESETS.find((item) => item.id === presetParam);
  if (presetFromUrl) {
    state.preset = presetFromUrl.id;
    state.weights = {
      study: Math.round(presetFromUrl.weights.study * 100),
      play: Math.round(presetFromUrl.weights.play * 100),
      sport: Math.round(presetFromUrl.weights.sport * 100),
    };
  }
  if (params.get('gps') === 'library') {
    const lib = POI.get('library');
    state.gps = { lat: lib.lat, lng: lib.lng, coord: 'gcj02', accuracy: 0, simulated: true };
    $('clearGpsBtn').hidden = false;
  }
  const weatherParam = params.get('weather');
  if (weatherParam && R.weatherPresets.some((item) => item.id === weatherParam)) {
    state.weather.condition = weatherParam;
    const preset = R.weatherPresets.find((item) => item.id === weatherParam);
    state.weather.temperature = preset.temperature;
    const tempParam = Number(params.get('temp'));
    if (Number.isFinite(tempParam) && tempParam > -20 && tempParam < 50) state.weather.temperature = tempParam;
  }

  try {
    buildMap();
    syncSliders();
    syncWeatherControls();
    document.querySelectorAll('#presets button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === state.preset);
    });
    bind();
    replan(false);
    if (params.get('exams') === 'demo') loadDemoExams();
    if (params.get('openTasks') === '1') openTaskSection();
    if (state.reminders) {
      reminderTimer = setInterval(checkDueReminders, 60000);
      setTimeout(checkDueReminders, 1200);
    }
    if (params.get('live') === '1') setTimeout(fetchLiveWeather, 300);
    svg.style.cursor = 'grab';
  } catch (error) {
    const box = document.getElementById('jsError');
    if (box) {
      box.hidden = false;
      box.textContent = `页面脚本出错：${error.message} ${error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : ''}`;
    }
    console.error(error);
  }
})();
