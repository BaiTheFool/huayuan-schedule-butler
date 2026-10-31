'use strict';

/**
 * 华园一日路线引擎
 *
 * 输入：某一天的课表 + 个人权重（卷 / 玩 / 运动）+ 作息偏好 + 可选 GPS
 * 输出：带地点的分钟级日程、步行/骑行段、开放时间校验、冲突与依据
 *
 * 设计原则（沿用项目既有约束）：
 *   1. 固定课程不可移动；可移动的只有自习、运动、放松、用餐与缓冲；
 *   2. 每个地点都先查开放时间，闭馆不硬排；
 *   3. 走不过去就说走不过去，不把 3 分钟路程写成 1 分钟；
 *   4. GPS 只在浏览器本地换算，不上传、不落盘；
 *   5. 数据不够时写「待确认」，不编造。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../data/campus-data.js'));
  } else {
    root.HuayuanRoute = factory(root.HuayuanCampusData);
  }
})(typeof self !== 'undefined' ? self : this, function (DATA) {
  if (!DATA) throw new Error('缺少 campus-data.js');

  const { POIS, WALK_NODES, WALK_EDGES, CAMPUS, PRESETS, DEMO_TIMETABLE, HOT_WATER, CURFEW } = DATA;

  const POI_MAP = new Map(POIS.map((p) => [p.id, p]));
  const NODE_MAP = new Map();
  for (const poi of POIS) NODE_MAP.set(poi.id, poi);
  for (const node of WALK_NODES) NODE_MAP.set(node.id, node);

  const CATEGORY_COLOR = {
    study: '#2f6b4f',
    meal: '#d98324',
    sport: '#c94f4f',
    play: '#7c5cbf',
    dorm: '#4a6fa5',
    class: '#3f6ad8',
    service: '#8a6d3b',
    gate: '#7a7f87',
    walk: '#8a8275',
    rest: '#87948b',
    sleep: '#4a5568',
  };

  const CROWD_WINDOWS = [
    [625, 640], // 10:25-10:40
    [735, 750], // 12:15-12:30
    [830, 845], // 13:50-14:05
    [935, 950], // 15:35-15:50
    [1040, 1055], // 17:20-17:35
    [1080, 1095], // 18:00-18:15
  ];

  const WEATHER_PRESETS = [
    { id: 'clear', label: '晴', icon: '☀️', temperature: 28, precipitation: 0, aqi: 45 },
    { id: 'cloudy', label: '多云', icon: '☁️', temperature: 26, precipitation: 0, aqi: 55 },
    { id: 'rain', label: '小雨', icon: '🌧️', temperature: 23, precipitation: 2, aqi: 35 },
    { id: 'storm', label: '大雨', icon: '⛈️', temperature: 22, precipitation: 12, aqi: 30 },
    { id: 'heat', label: '高温', icon: '🌡️', temperature: 35, precipitation: 0, aqi: 60 },
    { id: 'cold', label: '寒冷', icon: '🥶', temperature: 8, precipitation: 0, aqi: 45 },
    { id: 'polluted', label: '空气污染', icon: '😷', temperature: 24, precipitation: 0, aqi: 180 },
  ];

  // 露天 POI：下雨/暴晒/污染时，运动和放松要换到室内
  const OUTDOOR_POIS = new Set(['field', 'lake', 'eastgate']);
  const INDOOR_FALLBACK = ['cafe', 'library', 'c11study', 'gym'];

  // ---------- 时间 ----------

  function parseTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h < 0 || h > 24 || m < 0 || m > 59) return null;
    return h * 60 + m;
  }

  function clock(minutes) {
    const total = Math.round(minutes);
    if (total >= 1440) return '24:00';
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function durationText(minutes) {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
  }

  function dateParts(date) {
    const d = typeof date === 'string' ? parseDate(date) : new Date(date.getTime());
    const weekday = d.getDay() === 0 ? 7 : d.getDay();
    return {
      date: d,
      weekday,
      day_name: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'][weekday - 1],
      iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      is_weekend: weekday >= 6,
    };
  }

  function parseDate(text) {
    const match = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return new Date();
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  // ---------- 几何 / 图 ----------

  function haversine(a, b) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  const GRAPH = new Map();
  for (const id of NODE_MAP.keys()) GRAPH.set(id, []);
  for (const [a, b] of WALK_EDGES) {
    const pa = NODE_MAP.get(a);
    const pb = NODE_MAP.get(b);
    if (!pa || !pb) continue;
    const d = haversine(pa, pb) * 1.12;
    GRAPH.get(a).push({ id: b, distance: d });
    GRAPH.get(b).push({ id: a, distance: d });
  }

  const pathCache = new Map();

  /** Dijkstra：节点少，直接用 O(n²)，不引依赖。 */
  function shortestPath(fromId, toId) {
    if (fromId === toId) {
      const p = NODE_MAP.get(fromId);
      return { nodes: [fromId], points: p ? [{ lat: p.lat, lng: p.lng }] : [], distance: 0 };
    }
    const key = `${fromId}->${toId}`;
    if (pathCache.has(key)) return pathCache.get(key);
    const dist = new Map();
    const prev = new Map();
    const visited = new Set();
    for (const id of GRAPH.keys()) dist.set(id, Infinity);
    dist.set(fromId, 0);
    while (true) {
      let current = null;
      let best = Infinity;
      for (const [id, d] of dist) {
        if (!visited.has(id) && d < best) {
          best = d;
          current = id;
        }
      }
      if (!current || best === Infinity) break;
      if (current === toId) break;
      visited.add(current);
      for (const edge of GRAPH.get(current) || []) {
        const next = best + edge.distance;
        if (next < (dist.get(edge.id) ?? Infinity)) {
          dist.set(edge.id, next);
          prev.set(edge.id, current);
        }
      }
    }
    if (!Number.isFinite(dist.get(toId) ?? Infinity)) {
      const fallback = { nodes: [fromId, toId], points: [], distance: Infinity, unreachable: true };
      pathCache.set(key, fallback);
      return fallback;
    }
    const chain = [];
    let cursor = toId;
    while (cursor) {
      chain.unshift(cursor);
      if (cursor === fromId) break;
      cursor = prev.get(cursor);
    }
    const points = chain.map((id) => {
      const node = NODE_MAP.get(id);
      return { lat: node.lat, lng: node.lng };
    });
    const result = { nodes: chain, points, distance: dist.get(toId) };
    pathCache.set(key, result);
    return result;
  }

  function pointDistance(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += haversine(points[i - 1], points[i]);
    return total;
  }

  // ---------- 开放时间 ----------

  function dayMatches(days, weekday) {
    return !Array.isArray(days) || days.includes(weekday);
  }

  function insideWindow(minutes, open, close) {
    const o = parseTime(open);
    const c = parseTime(close);
    if (o === null || c === null) return false;
    if (c === 1440) return minutes >= o;
    if (c < o) return minutes >= o || minutes < c;
    return minutes >= o && minutes < c;
  }

  function openState(poi, weekday, minutes) {
    if (!poi || !poi.hours) return { open: true, always: true, label: '全天' };
    for (const rule of poi.hours) {
      if (!dayMatches(rule.days, weekday)) continue;
      for (const [start, end] of rule.windows) {
        if (insideWindow(minutes, start, end)) {
          return { open: true, window: `${start}–${end}`, label: `${start}–${end}` };
        }
      }
    }
    return { open: false, label: poi.hours_label || '已关闭' };
  }

  function nextOpenLabel(poi, weekday, minutes) {
    if (!poi || !poi.hours) return null;
    for (const rule of poi.hours) {
      if (!dayMatches(rule.days, weekday)) continue;
      for (const [start] of rule.windows) {
        const s = parseTime(start);
        if (s !== null && s > minutes) return `${start} 开放`;
      }
    }
    return '今日已结束';
  }

  function poiHoursText(poi) {
    if (!poi) return '';
    return poi.hours_label || (poi.hours ? '见开放时间' : '全天');
  }

  // ---------- 天气 ----------

  /**
   * 天气不是装饰：它决定“露天还是室内、走多慢、要不要带伞/口罩”。
   * 输入可以是手动选的画像，也可以是 Open-Meteo 之类的实时天气；
   * source 不是 official 时，出发前仍要自己再看一眼预报。
   */
  function normalizeWeather(input, legacy) {
    const raw = input && typeof input === 'object' ? input : {};
    let condition = String(raw.condition || raw.weather || '').toLowerCase();
    if (!WEATHER_PRESETS.some((item) => item.id === condition)) {
      condition = legacy && legacy.rain ? 'rain' : 'cloudy';
    }
    const preset = WEATHER_PRESETS.find((item) => item.id === condition) || WEATHER_PRESETS[1];
    const num = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const temperature = num(raw.temperature ?? raw.temp, preset.temperature);
    const temperatureMax = num(raw.temperature_max ?? raw.temp_max, Math.max(temperature, preset.temperature));
    const precipitation = num(raw.precipitation ?? raw.precip_mm, preset.precipitation);
    const precipProbability = num(
      raw.precipitation_probability ?? raw.precip_probability,
      condition === 'rain' ? 80 : condition === 'storm' ? 95 : 0
    );
    const aqi = num(raw.aqi, preset.aqi);
    const wind = num(raw.wind_speed_kmh ?? raw.wind, 8);
    const isWet = ['rain', 'storm'].includes(condition) || precipitation >= 0.5 || precipProbability >= 60;
    const isHot = condition === 'heat' || temperatureMax >= 33 || temperature >= 33;
    const isCold = condition === 'cold' || temperature <= 8;
    const isPolluted = condition === 'polluted' || aqi >= 150;
    const isSevere = condition === 'storm' || precipitation >= 10 || wind >= 40;
    const sportIndoor = isWet || isHot || isCold || isPolluted || isSevere;
    const playIndoor = isWet || isPolluted || isSevere;

    let travelFactor = 1;
    if (isSevere) travelFactor = 1.4;
    else if (isWet) travelFactor = 1.16;
    else if (isHot) travelFactor = 1.08;
    else if (isCold) travelFactor = 1.05;
    else if (isPolluted) travelFactor = 1.02;
    if (isWet && precipProbability >= 80) travelFactor += 0.05;

    const advice = [];
    if (isWet) advice.push('带伞，尽量走有遮挡的主路，电脑和纸质材料装防水袋');
    if (isSevere) advice.push('大雨/雷雨：取消露天活动，避开树下、广告牌和积水路段');
    if (isHot) advice.push('高温：11:00–16:00 少在露天暴晒，运动改室内或日落后，随身带水');
    if (isCold) advice.push('寒冷：运动前多热身 5 分钟，注意防风');
    if (isPolluted) advice.push(`空气污染 AQI ${Math.round(aqi)}：取消户外跑步，改体育馆/室内，出门戴口罩`);
    if (!isWet && !isHot && !isCold && !isPolluted) advice.push('天气平稳，按正常步行速度安排');
    if (String(raw.source || '').toLowerCase() !== 'open-meteo') {
      advice.push('天气为手动选择或估算，出发前再看一眼实时预报');
    }

    return {
      condition,
      label: preset.label,
      icon: preset.icon,
      temperature: Math.round(temperature),
      temperature_max: Math.round(temperatureMax),
      feels_like: Number.isFinite(Number(raw.feels_like)) ? Math.round(Number(raw.feels_like)) : null,
      precipitation_mm: Math.round(precipitation * 10) / 10,
      precipitation_probability: Math.round(precipProbability),
      wind_speed_kmh: Math.round(wind),
      aqi: Math.round(aqi),
      source: raw.source || 'manual',
      updated_at: raw.updated_at || null,
      is_wet: isWet,
      is_hot: isHot,
      is_cold: isCold,
      is_polluted: isPolluted,
      is_severe: isSevere,
      sport_indoor: sportIndoor,
      play_indoor: playIndoor,
      travel_factor: Math.round(travelFactor * 100) / 100,
      advice,
    };
  }

  // ---------- 步行 / 骑行 ----------

  function crowdFactor(at) {
    if (at === null || at === undefined) return 1;
    for (const [start, end] of CROWD_WINDOWS) {
      if (at >= start && at < end) return 1.3;
    }
    return 1;
  }

  function travelFactor(at, opts) {
    let factor = 1;
    if (opts.traffic === 'peak') factor *= 1.22;
    else if (opts.traffic === 'clear') factor *= 0.92;
    else factor *= crowdFactor(at);
    if (opts.weather && opts.weather.travel_factor) factor *= opts.weather.travel_factor;
    else if (opts.rain) factor *= 1.12;
    if (opts.avoidCrowd) factor *= 0.96;
    return factor;
  }

  function travelSpeed(opts) {
    return opts.mode === 'bike' ? 190 : 78;
  }

  function travelTime(distance, at, opts) {
    if (!Number.isFinite(distance)) return { minutes: 15, distance: 0, uncertain: true };
    const speed = travelSpeed(opts);
    const minutes = Math.max(1, Math.ceil((distance * travelFactor(at, opts)) / speed));
    return { minutes, distance: Math.round(distance) };
  }

  function pathFor(fromId, toId, opts) {
    if (fromId === toId) return { points: [], distance: 0, minutes: 0 };
    const base = shortestPath(fromId, toId);
    if (base.unreachable) return { points: [], distance: 0, minutes: 15, uncertain: true };
    const t = travelTime(base.distance, opts.at, opts);
    return { points: base.points, distance: t.distance, minutes: Math.max(1, t.minutes), nodes: base.nodes };
  }

  function pointToPoiDistance(point) {
    let best = null;
    for (const poi of POIS) {
      if (poi.category === 'gate') continue;
      const d = haversine(point, poi);
      if (!best || d < best.distance) best = { poi, distance: d };
    }
    return best;
  }

  /** WGS-84 → GCJ-02（浏览器定位默认是 WGS-84，地图点用 GCJ-02）。 */
  function wgs84ToGcj02(lat, lng) {
    const a = 6378245.0;
    const ee = 0.00669342162296594323;
    const outOfChina = lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
    if (outOfChina) return { lat, lng };
    const transformLat = (x, y) => {
      let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
      ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
      ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
      ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
      return ret;
    };
    const transformLng = (x, y) => {
      let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
      ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
      ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
      ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
      return ret;
    };
    const radLat = (lat / 180.0) * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    const dLat = (transformLat(lng - 105.0, lat - 35.0) * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
    const dLng = (transformLng(lng - 105.0, lat - 35.0) * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
  }

  function resolveGps(gps) {
    if (!gps || !Number.isFinite(Number(gps.lat)) || !Number.isFinite(Number(gps.lng))) return null;
    let lat = Number(gps.lat);
    let lng = Number(gps.lng);
    if (gps.coord === 'wgs84' || gps.coord === 'WGS84') {
      const converted = wgs84ToGcj02(lat, lng);
      lat = converted.lat;
      lng = converted.lng;
    }
    const point = { lat, lng };
    const nearest = pointToPoiDistance(point);
    const campusCenter = CAMPUS.center;
    const distance = haversine(point, campusCenter);
    const inCampus = distance <= 2200 && nearest && nearest.distance <= 1600;
    return {
      lat,
      lng,
      coord: 'GCJ-02',
      accuracy: Number(gps.accuracy) || null,
      label: gps.label ? String(gps.label).slice(0, 80) : null,
      simulated: Boolean(gps.simulated),
      nearest_poi: nearest ? nearest.poi.id : null,
      nearest_distance: nearest ? Math.round(nearest.distance) : null,
      distance_to_center: Math.round(distance),
      in_campus: Boolean(inCampus),
    };
  }

  // ---------- 课表 ----------

  function buildingForRoom(room) {
    const text = String(room || '').trim();
    if (!text) return null;
    if (/田径场|操场|运动场/.test(text)) return 'field';
    if (/体育馆|羽毛球馆|篮球馆/.test(text)) return 'gym';
    const match = text.match(/^A\s*[-_]?\s*([1-5])(?=\d|\D|$)/i);
    if (match) return `a${match[1]}`;
    return null;
  }

  function normalizeClasses(timetable, weekday, weekNumber) {
    const courses = (timetable && timetable.courses) || [];
    const warnings = [];
    const list = [];
    for (const course of courses) {
      if (Number(course.weekday) !== weekday) continue;
      const courseCampus = String(course.campus || '').trim();
      if (/五山|广州国际|国际校区/.test(courseCampus)) {
        warnings.push(`课程「${course.course || '未命名'}」在${courseCampus}，不属于大学城路线，已跳过`);
        continue;
      }
      if (weekNumber && course.weeks) {
        const weeks = course.weeks.list || [];
        if (Array.isArray(weeks) && weeks.length && !weeks.includes(Number(weekNumber))) continue;
        const ranges = course.weeks.ranges || [];
        if ((!weeks || !weeks.length) && ranges.length) {
          const hit = ranges.some(([a, b]) => Number(weekNumber) >= a && Number(weekNumber) <= b);
          if (!hit) continue;
        }
      }
      const start = parseTime(course.start_time);
      const end = parseTime(course.end_time);
      if (start === null || end === null || end <= start) {
        warnings.push(`课程「${course.course || '未命名'}」缺少合法起止时间，未排入路线`);
        continue;
      }
      let poiId = buildingForRoom(course.classroom);
      if (!poiId) {
        poiId = 'a3';
        warnings.push(`教室「${course.classroom || '未填写'}」未识别到 A1–A5，按 A3 估算，请人工确认`);
      }
      list.push({
        type: 'class',
        title: course.course || '课程',
        subtitle: course.classroom || null,
        poiId,
        start,
        end,
        locked: true,
        source: '[课程]',
        reason: `教务课表固定课程${course.weeks && course.weeks.raw ? `（${course.weeks.raw}）` : ''}`,
      });
    }
    list.sort((a, b) => a.start - b.start);
    return { list, warnings };
  }

  // ---------- 任务标注 ----------

  function taskDueMs(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!match) return Infinity;
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] || 23),
      Number(match[5] || 59)
    ).getTime();
  }

  function normalizePlanningTasks(tasks) {
    const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return (Array.isArray(tasks) ? tasks : [])
      .filter((task) => task && String(task.title || '').trim() && !task.done)
      .map((task, index) => ({
        id: String(task.id || `task-${index}`),
        title: String(task.title).trim().slice(0, 100),
        due: task.due || null,
        priority: /^P[0-3]$/.test(String(task.priority || '').toUpperCase())
          ? String(task.priority).toUpperCase()
          : 'P2',
        estimated_minutes: Math.max(10, Number(task.estimated_minutes) || 60),
        source: task.source === 'exam' ? 'exam' : 'manual',
        course: task.course || null,
        exam_id: task.exam_id || null,
        remaining: Math.max(10, Number(task.estimated_minutes) || 60),
        scheduled_minutes: 0,
      }))
      .sort((a, b) => {
        const byDue = taskDueMs(a.due) - taskDueMs(b.due);
        if (byDue !== 0) return byDue;
        return (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
      });
  }

  function assignTasksToStudy(blocks, tasks) {
    const studyBlocks = blocks.filter((block) => block.type === 'study');
    for (const block of studyBlocks) {
      const task = tasks.find((item) => item.remaining > 0);
      if (!task) break;
      const minutes = Math.max(0, Math.round(block.end - block.start));
      if (!minutes) continue;
      const used = Math.min(minutes, task.remaining);
      task.remaining -= used;
      task.scheduled_minutes += used;
      block.task = {
        id: task.id,
        title: task.title,
        due: task.due,
        priority: task.priority,
        source: task.source,
        course: task.course,
        exam_id: task.exam_id,
        minutes: used,
      };
      block.reason = `${block.reason}；对应任务「${task.title}」${task.due ? `，截止 ${task.due.replace('T', ' ')}` : ''}`;
    }
    return tasks;
  }

  // ---------- 排程 ----------

  function normalizeWeights(weights) {
    const raw = weights || {};
    const values = {
      study: Math.max(0, Number(raw.study) || 0),
      play: Math.max(0, Number(raw.play) || 0),
      sport: Math.max(0, Number(raw.sport) || 0),
    };
    const sum = values.study + values.play + values.sport;
    if (!sum) return { study: 0.46, play: 0.22, sport: 0.32 };
    return { study: values.study / sum, play: values.play / sum, sport: values.sport / sum };
  }

  function normalizePrefs(input) {
    const p = input || {};
    const daily = p.daily || {};
    const study = p.study || {};
    const wake = parseTime(daily.wake || '07:00') ?? 420;
    const rawSleep = parseTime(daily.sleep);
    let sleep = rawSleep === null ? 1410 : rawSleep;
    // 一天路线只覆盖当天。用户把睡觉设为 00:00（或次日凌晨）时，
    // 它表示当天结束边界，不能当成当天 00:00 起床后又去睡觉。
    const sleepCrossDay = rawSleep !== null && rawSleep <= wake;
    if (sleepCrossDay) sleep = 1440;
    return {
      wake,
      sleep,
      sleep_cross_day: sleepCrossDay,
      study_limit: Number(study.weekday_daily_limit_min || study.daily_limit_min || 240),
      max_continuous: Number(study.max_continuous_minutes || 60),
      buffer: Number(study.buffer_min || 10),
    };
  }

  function occupiedFrom(blocks) {
    return blocks
      .filter((b) => b.locked || b.type === 'meal' || b.type === 'shower')
      .map((b) => ({ start: b.start, end: b.end }));
  }

  function findSlot(occupied, from, to, duration) {
    let cursor = Math.max(0, from);
    const sorted = occupied.slice().sort((a, b) => a.start - b.start);
    while (cursor + duration <= to) {
      const hit = sorted.find((item) => cursor < item.end && cursor + duration > item.start);
      if (!hit) return cursor;
      cursor = hit.end + 5;
    }
    return null;
  }

  function nearestPoi(ids, fromPoiId) {
    const from = POI_MAP.get(fromPoiId);
    if (!from) return POI_MAP.get(ids[0]);
    let best = null;
    for (const id of ids) {
      const poi = POI_MAP.get(id);
      if (!poi) continue;
      const d = haversine(from, poi);
      if (!best || d < best.distance) best = { poi, distance: d };
    }
    return best ? best.poi : null;
  }

  function lastClassEndingBefore(classes, minutes) {
    let best = null;
    for (const c of classes) {
      if (c.end <= minutes && (!best || c.end > best.end)) best = c;
    }
    return best;
  }

  function firstClassStartingAfter(classes, minutes) {
    let best = null;
    for (const c of classes) {
      if (c.start >= minutes && (!best || c.start < best.start)) best = c;
    }
    return best;
  }

  function resolveCampusScope(timetable) {
    const campus = timetable && timetable.campus;
    const campusObject = campus && typeof campus === 'object' ? campus : {};
    const campusString = typeof campus === 'string' ? campus : '';
    const key = String(campusObject.key || '').trim();
    const campusText = String(campusObject.campus_text || campusString || '').trim();
    const label = String(campusObject.label || '').trim();
    const courseCampuses = Array.from(
      new Set(
        ((timetable && timetable.courses) || [])
          .map((course) => String((course && course.campus) || '').trim())
          .filter(Boolean)
      )
    );

    const isUniversityTown = (value) => /大学城|university[_ -]?town/i.test(String(value || ''));
    const isOtherCampus = (value) => /五山|广州国际|国际校区/.test(String(value || ''));
    const explicitUniversityTown =
      isUniversityTown(key) || isUniversityTown(campusText) || courseCampuses.some(isUniversityTown);
    const explicitOther = [key, campusText, ...courseCampuses].filter(Boolean).some(isOtherCampus);

    if (explicitUniversityTown) {
      const warnings = [];
      if (explicitOther) {
        warnings.push('课表同时带有其他校区信息；本项目只处理大学城课程，其他校区课程会被跳过');
      }
      return { supported: true, ambiguous: false, label: '大学城校区', warnings };
    }
    if (explicitOther) {
      return { supported: false, ambiguous: false, label: campusText || label || '非大学城校区', warnings: [] };
    }
    if (isUniversityTown(label)) {
      return {
        supported: true,
        ambiguous: true,
        label: '大学城校区',
        warnings: ['课表标题含大学城校区，但没有明确校区字段；已按大学城处理，请确认课程教室'],
      };
    }
    if (isOtherCampus(label)) {
      return { supported: false, ambiguous: false, label, warnings: [] };
    }
    return {
      supported: true,
      ambiguous: true,
      label: campusText || label || '未识别校区',
      warnings: ['课表没有明确校区字段；本项目只按大学城校区处理，请确认课程教室'],
    };
  }

  function planDay(options) {
    const opts = options || {};
    const parts = dateParts(opts.date || new Date());
    const preset = PRESETS.find((item) => item.id === opts.preset) || PRESETS[1];
    const weights = normalizeWeights(opts.weights || preset.weights);
    const prefs = normalizePrefs(opts.preferences);
    if (parts.is_weekend && opts.preferences && opts.preferences.weekend) {
      const weekend = opts.preferences.weekend;
      const weekendWake = parseTime(weekend.wake);
      const weekendSleep = parseTime(weekend.sleep);
      if (weekendWake !== null) prefs.wake = weekendWake;
      if (weekendSleep !== null) prefs.sleep = weekendSleep;
    }
    const mode = opts.mode === 'bike' ? 'bike' : 'walk';
    const weather = normalizeWeather(opts.weather, { rain: opts.rain });
    const travelOpts = {
      mode,
      rain: weather.is_wet,
      avoidCrowd: Boolean(opts.avoidCrowd),
      traffic: opts.traffic || 'auto',
      weather,
    };
    const warnings = [];
    const gps = resolveGps(opts.gps);
    if (prefs.sleep_cross_day) {
      warnings.push('睡觉时间属于次日，本日路线按 24:00 封口，不会生成 00:00 出发或零点睡觉块');
    }

    const timetable = opts.timetable || DEMO_TIMETABLE;
    const campusScope = resolveCampusScope(timetable);
    warnings.push(...campusScope.warnings);
    if (!campusScope.supported) {
      return {
        ok: false,
        error: 'CAMPUS_UNSUPPORTED',
        message: `本项目只服务华南理工大学大学城校区；这份课表显示为「${campusScope.label}」，未生成路线，避免把其他校区教室硬套到大学城。`,
        meta: { date: parts.iso, day_name: parts.day_name, campus: CAMPUS },
        blocks: [],
        warnings: ['项目范围仅限大学城校区，不提供其他校区的路线数据'],
      };
    }

    const weekNumber = opts.weekNumber ? Number(opts.weekNumber) : null;
    const normalized = normalizeClasses(timetable, parts.weekday, weekNumber);
    warnings.push(...normalized.warnings);
    const classes = normalized.list;

    const dormPoiId = opts.dormPoiId && POI_MAP.has(opts.dormPoiId) ? opts.dormPoiId : 'c11';
    let startPoiId = dormPoiId;
    if (gps && gps.in_campus && gps.nearest_poi) startPoiId = gps.nearest_poi;
    if (gps && !gps.in_campus) {
      warnings.push(`定位不在大学城校区（距校区中心约 ${(gps.distance_to_center / 1000).toFixed(1)} km），已按 C11 出发；到校后重新定位即可重算`);
    }

    // 起床
    const blocks = [];
    const wake = prefs.wake;
    if (!gps || !gps.in_campus) {
      blocks.push({
        id: 'wake',
        type: 'wake',
        title: '起床 / 洗漱',
        subtitle: POI_MAP.get(dormPoiId).name,
        poiId: dormPoiId,
        start: wake,
        end: wake + 20,
        locked: true,
        source: '[偏好]',
        reason: `按你的起床时间 ${clock(wake)} 开始一天`,
      });
    } else {
      blocks.push({
        id: 'gps-start',
        type: 'place',
        title: gps.label ? `从${gps.label}出发` : '从当前位置出发',
        subtitle: gps.label
          ? `${gps.label} · 接入${POI_MAP.get(gps.nearest_poi).name}步行网络（约 ${gps.nearest_distance} m）`
          : `距${POI_MAP.get(gps.nearest_poi).name}约 ${gps.nearest_distance} m`,
        poiId: gps.nearest_poi,
        start: null,
        end: null,
        locked: false,
        source: '[定位]',
        reason: gps.simulated
          ? '起点由你在楼栋列表中选择，只在本地计算'
          : '起点来自设备定位，只在本地计算，不上传',
        gps: true,
      });
    }

    // 早餐：离第一节课最近的那个饭堂
    blocks.push(...classes);
    let breakfast = null;
    const firstClass = classes[0] || null;
    const morningLimit = firstClass ? Math.min(firstClass.start - 25, 9 * 60) : 10 * 60;
    const breakfastStart = findSlot(occupiedFrom(blocks), wake + 35, morningLimit, 30);    if (breakfastStart !== null) {
      const venue = nearestPoi(['canteen1', 'canteen2'], firstClass ? firstClass.poiId : startPoiId);
      breakfast = {
        id: 'breakfast',
        type: 'meal',
        meal: 'breakfast',
        title: `早餐 · ${venue ? venue.short : '饭堂'}`,
        subtitle: venue ? venue.name : null,
        poiId: venue ? venue.id : 'canteen1',
        start: breakfastStart,
        end: breakfastStart + 30,
        locked: false,
        source: '[偏好]',
        reason: firstClass ? `第一节课在 ${POI_MAP.get(firstClass.poiId).short}，顺路吃早餐` : '今天没有早课，吃完再安排',
      };
      blocks.push(breakfast);
    } else {
      warnings.push('早餐时间被课程挤掉，今天没有排早餐；可以在课间买个面包');
    }

    // 午餐：先给上一节课到饭堂留出真实通勤时间，避免饭后与步行块重叠。
    const lunchAnchor = lastClassEndingBefore(classes, 13 * 60 + 20);
    const lunchVenue = nearestPoi(['canteen1', 'canteen2'], lunchAnchor ? lunchAnchor.poiId : startPoiId);
    const lunchTravel = lunchAnchor && lunchVenue
      ? pathFor(lunchAnchor.poiId, lunchVenue.id, { ...travelOpts, at: lunchAnchor.end }).minutes + 3
      : 12;
    const lunchFrom = Math.max(11 * 60 + 30, (lunchAnchor ? lunchAnchor.end : 11 * 60 + 30) + lunchTravel);
    const lunchStart = findSlot(occupiedFrom(blocks), lunchFrom, 14 * 60 - 10, 40);
    let lunch = null;
    if (lunchStart !== null) {
      const morning = lastClassEndingBefore(classes, lunchStart) || { poiId: startPoiId };
      const venue = lunchVenue || nearestPoi(['canteen1', 'canteen2'], morning.poiId);
      lunch = {
        id: 'lunch',
        type: 'meal',
        meal: 'lunch',
        title: `午餐 · ${venue ? venue.short : '饭堂'}`,
        subtitle: venue ? venue.name : null,
        poiId: venue ? venue.id : 'canteen1',
        start: lunchStart,
        end: lunchStart + 40,
        locked: true,
        source: '[偏好]',
        reason: `上午最后一节在 ${POI_MAP.get(morning.poiId).short}，就近去${venue ? venue.short : '饭堂'}`,
      };
      blocks.push(lunch);
    } else {
      warnings.push('午餐没有找到 40 分钟空档，可能被课程或实验挤占，请人工确认');
    }

    // 晚餐：从最后一节课结束并走到饭堂之后再开始。
    const eveningClass = firstClassStartingAfter(classes, 18 * 60);
    const dinnerTo = eveningClass ? Math.min(19 * 60 + 10, eveningClass.start - 20) : 19 * 60 + 10;
    const dinnerAnchor = lastClassEndingBefore(classes, dinnerTo);
    const dinnerAnchorPoi = dinnerAnchor ? dinnerAnchor.poiId : startPoiId;
    const dinnerVenue = nearestPoi(['canteen1', 'canteen2'], dinnerAnchorPoi);
    const dinnerTravel = dinnerAnchor && dinnerVenue
      ? pathFor(dinnerAnchorPoi, dinnerVenue.id, { ...travelOpts, at: dinnerAnchor.end }).minutes + 3
      : 8;
    const dinnerFrom = Math.max(17 * 60 + 20, (dinnerAnchor ? dinnerAnchor.end : 17 * 60 + 20) + dinnerTravel);
    const dinnerStart = findSlot(occupiedFrom(blocks), dinnerFrom, dinnerTo, 40);
    let dinner = null;
    if (dinnerStart !== null) {
      const venue = dinnerVenue || nearestPoi(['canteen1', 'canteen2'], dinnerAnchorPoi);
      dinner = {
        id: 'dinner',
        type: 'meal',
        meal: 'dinner',
        title: `晚餐 · ${venue ? venue.short : '饭堂'}`,
        subtitle: venue ? venue.name : null,
        poiId: venue ? venue.id : 'canteen2',
        start: dinnerStart,
        end: dinnerStart + 40,
        locked: false,
        source: '[偏好]',
        reason: eveningClass ? `晚课在 ${POI_MAP.get(eveningClass.poiId).short}，先吃饭再过去` : '按作息固定晚餐，给晚上留出完整空档',
      };
      blocks.push(dinner);
    } else {
      warnings.push('晚餐没有找到 40 分钟空档，晚课前可能来不及吃饭');
    }

    // 洗澡：必须落在热水时段与门禁之前
    const lastClass = classes.reduce((acc, c) => (!acc || c.end > acc.end ? c : acc), null);
    let showerStart = 22 * 60 + 10;
    if (lastClass) {
      const walkBack = pathFor(lastClass.poiId, dormPoiId, { ...travelOpts, at: lastClass.end });
      showerStart = Math.max(showerStart, lastClass.end + walkBack.minutes + 15);
    }
    showerStart = Math.min(showerStart, 22 * 60 + 40);
    const curfew = parts.is_weekend ? parseTime(CURFEW.weekend) : parseTime(CURFEW.weekday);
    if (showerStart + 20 > curfew - 5) {
      warnings.push(`洗澡结束会接近门禁 ${clock(curfew)}，请把晚课后的安排再压缩`);
    }
    const showerPoi = POI_MAP.get(dormPoiId);
    const shower = {
      id: 'shower',
      type: 'shower',
      title: '回宿舍洗澡',
      subtitle: showerPoi.name,
      poiId: dormPoiId,
      start: showerStart,
      end: showerStart + 20,
      locked: true,
      source: '[开放时间]',
      reason: `热水 ${HOT_WATER.label}，门禁 ${CURFEW.label}`,
    };
    blocks.push(shower);

    // 睡前。睡觉时间正好是当天 24:00 时，不生成跨日空块；
    // 22:30–24:00 的晚间时间仍由下面的“洗漱后自由时间”完整覆盖。
    if (prefs.sleep < 1440) {
      blocks.push({
        id: 'sleep',
        type: 'sleep',
        title: '熄灯 / 睡觉',
        subtitle: showerPoi.name,
        poiId: dormPoiId,
        start: prefs.sleep,
        end: Math.min(Math.max(prefs.sleep + 30, prefs.sleep + 1), 1440),
        locked: true,
        source: '[偏好]',
        reason: `按你的睡觉时间 ${clock(prefs.sleep)}，保证第二天有精神`,
        detail: `次日 ${clock(wake)} 起床`,
      });
    }
    if (prefs.sleep - shower.end >= 15) {
      blocks.push({
        id: 'night-free',
        type: 'free',
        title: '洗漱后自由时间',
        subtitle: showerPoi.name,
        poiId: dormPoiId,
        start: shower.end,
        end: prefs.sleep,
        locked: false,
        source: '[规划]',
        reason: '收衣服、回消息、放松一下，23:30 前睡',
      });
    }

    // 固定块 = 课程 + 三餐 + 洗澡
    const fixed = blocks.filter((b) => b.type === 'class' || b.type === 'meal' || b.type === 'shower');
    const flexWindows = [];
    const dayEnd = showerStart;
    const boundaries = fixed
      .filter((b) => b.type !== 'shower')
      .slice()
      .sort((a, b) => a.start - b.start);
    let cursor = wake + 20;
    for (const b of boundaries) {
      if (b.start > cursor + 25) flexWindows.push({ start: cursor, end: b.start });
      cursor = Math.max(cursor, b.end);
    }
    if (dayEnd > cursor + 25) flexWindows.push({ start: cursor, end: dayEnd });

    // 可移动预算：按空档总时长 × 权重
    const usable = flexWindows.reduce((sum, w) => sum + Math.max(0, w.end - w.start - 24), 0);
    let budget = {
      study: Math.round(usable * weights.study),
      play: Math.round(usable * weights.play),
      sport: Math.round(usable * weights.sport),
    };
    budget.study = Math.min(budget.study, prefs.study_limit);
    budget.sport = Math.min(budget.sport, 100);
    budget.play = Math.min(budget.play, 120);

    const flexible = [];
    let studyScheduled = 0;

    // 把一个长空档按作息切成早/午/下午/傍晚/晚五段，避免“从 12:22 一口气算到 18:00”
    // 被午餐分支整段吃掉，导致下午没有自习和运动。
    const DAY_SEGMENTS = [
      [7 * 60, 11 * 60 + 30],
      [11 * 60 + 30, 14 * 60],
      [14 * 60, 17 * 60 + 30],
      [17 * 60 + 30, 18 * 60],
      [18 * 60, 22 * 60 + 30],
    ];
    const flexSegments = [];
    for (const win of flexWindows) {
      for (const [segStart, segEnd] of DAY_SEGMENTS) {
        const start = Math.max(win.start, segStart);
        const end = Math.min(win.end, segEnd);
        if (end - start >= 30) flexSegments.push({ start, end });
      }
    }

    function venueOpen(id, start, end) {
      const poi = POI_MAP.get(id);
      if (!poi) return false;
      const s = openState(poi, parts.weekday, start);
      const e = openState(poi, parts.weekday, Math.max(start, end - 1));
      return s.open && e.open;
    }

    function pickStudyVenue(start, end) {
      for (const id of ['library', 'c11study']) {
        if (venueOpen(id, start, end)) return id;
      }
      return null;
    }

    function pickSportVenue(start, end) {
      let order;
      if (weather.sport_indoor) {
        // 高温天日落后允许回田径场；其余坏天气只去室内
        order = weather.is_hot && !weather.is_wet && start >= 19 * 60 + 30 ? ['field', 'gym'] : ['gym'];
      } else {
        order = ['field', 'gym'];
      }
      for (const id of order) {
        if (venueOpen(id, start, end)) return id;
      }
      return null;
    }

    function pickPlayVenue(start, end) {
      const indoor = weather.play_indoor || (weather.is_hot && start < 18 * 60);
      const order = indoor
        ? ['cafe', 'c11study', 'library']
        : start >= 19 * 60
        ? ['cafe', 'lake']
        : ['lake', 'cafe'];
      for (const id of order) {
        if (venueOpen(id, start, end)) return id;
      }
      return null;
    }

    function pushBlock(type, venueId, start, end, reason) {
      const poi = POI_MAP.get(venueId);
      if (!poi || end - start < 5) return null;
      const block = {
        id: `${type}-${flexible.length + 1}`,
        type,
        title: type === 'study' ? '自习' : type === 'sport' ? '运动' : type === 'play' ? '放松' : '缓冲',
        subtitle: poi.name,
        poiId: venueId,
        start,
        end,
        locked: false,
        source: '[规划]',
        reason,
      };
      flexible.push(block);
      return block;
    }

    function addStudy(windowStart, limit, desire, label) {
      let left = Math.min(desire, budget.study);
      let at = windowStart;
      while (left >= 20 && at + 20 <= limit) {
        const venue = pickStudyVenue(at, Math.min(limit, at + Math.min(left, prefs.max_continuous)));
        if (!venue) {
          warnings.push(`${clock(at)} 附近图书馆与尚学空间都未开放，这一段没有排自习`);
          return;
        }
        let chunk = Math.min(left, prefs.max_continuous, limit - at);
        if (chunk < 20) break;
        if (chunk > 60 && at + chunk + 8 <= limit) {
          // 长块中间插 8 分钟休息；不是把任务切碎，只是给连续学习留恢复点
          const first = Math.floor(chunk * 0.6);
          pushBlock('study', venue, at, at + first, `${label}；按学习权重 ${Math.round(weights.study * 100)}% 安排 ${first} 分钟`);
          studyScheduled += first;
          budget.study -= first;
          left -= first;
          at += first;
          pushBlock('rest', venue, at, at + 8, '连续学习后短暂休息，避免效率下滑');
          at += 8;
          continue;
        }
        pushBlock('study', venue, at, at + chunk, `${label}；按学习权重 ${Math.round(weights.study * 100)}% 安排 ${chunk} 分钟`);
        studyScheduled += chunk;
        budget.study -= chunk;
        left -= chunk;
        at += chunk + 5;
        if (left >= 20 && at + 8 <= limit) {
          pushBlock('rest', venue, at, at + 8, '连续学习后短暂休息，避免效率下滑');
          at += 8;
        }
      }
    }

    function addSport(windowStart, limit, label) {
      if (budget.sport < 25) return null;
      const want = Math.min(budget.sport, 70, limit - windowStart, Math.round(30 + 45 * weights.sport));
      if (want < 25) return null;
      const venue = pickSportVenue(windowStart, windowStart + want);
      if (!venue) {
        warnings.push(`${label}因天气或体育馆闭馆取消，未硬排露天运动`);
        return null;
      }
      const weatherNote = weather.is_wet ? '，雨天改室内' : weather.is_hot ? '，高温改室内/避晒' : weather.is_polluted ? '，污染天改室内' : '';
      const block = pushBlock('sport', venue, windowStart, windowStart + want, `${label}；运动权重 ${Math.round(weights.sport * 100)}%，留 ${want} 分钟${weatherNote}`);
      if (block) budget.sport -= want;
      return block;
    }

    function addPlay(windowStart, limit, label) {
      if (budget.play < 25) return null;
      const want = Math.min(budget.play, 55, limit - windowStart);
      if (want < 25) return null;
      const venue = pickPlayVenue(windowStart, windowStart + want);
      if (!venue) {
        warnings.push(`${label}因天气没有合适的室内去处，这一段留空`);
        return null;
      }
      const weatherNote = weather.play_indoor ? '，坏天气改室内' : '';
      const block = pushBlock('play', venue, windowStart, windowStart + want, `${label}；放松权重 ${Math.round(weights.play * 100)}%，留 ${want} 分钟${weatherNote}`);
      if (block) budget.play -= want;
      return block;
    }

    for (const win of flexSegments) {
      const start = win.start + 18;
      const end = win.end - 18;
      if (end - start < 30) continue;
      const hour = start / 60;
      let at = start;

      if (hour < 11.5) {
        if (budget.study >= 25 && end - at >= 30) {
          addStudy(at, end, Math.min(60, end - at), '上午空档');
        }
        continue;
      }

      if (hour < 14.05) {
        if (end - at >= 25) {
          pushBlock('rest', lunch ? lunch.poiId : startPoiId, at, at + 20, '午饭后坐一会儿，给下午留缓冲');
          at += 25;
        }
        if (budget.study >= 25 && end - at >= 35) {
          addStudy(at, end, Math.min(40, end - at), '午间空档');
        }
        continue;
      }

      if (hour < 17.8) {
        const reserve = budget.sport >= 25 ? Math.round(22 + 28 * weights.sport) : 0;
        const studyWant = Math.min(60, Math.max(0, end - at - reserve - 8));
        if (budget.study >= 25 && studyWant >= 25) {
          addStudy(at, end, studyWant, '下午空档');
        }
        at = Math.max(at, flexible.length ? Math.max(...flexible.map((b) => b.end)) + 8 : at);
        if (budget.sport >= 25 && end - at >= 25) addSport(at, end, '傍晚运动');
        at = Math.max(at, flexible.length ? Math.max(...flexible.map((b) => b.end)) + 8 : at);
        if (budget.play >= 25 && weights.play >= 0.5 && end - at >= 35) addPlay(at, end, '傍晚放空');
        continue;
      }

      if (hour < 18.75 && end - at < 75) {
        if (budget.play >= 25 && end - at >= 40) addPlay(at, end, '饭后散步');
        continue;
      }

      if (hour < 22.3) {
        if (weights.play >= 0.45 && budget.play >= 25 && end - at >= 40) {
          const block = addPlay(at, end, '晚间放松');
          if (block) at = block.end + 8;
        }
        if (budget.study >= 25 && end - at >= 30) {
          addStudy(at, end, Math.min(80, end - at), '晚间空档');
          at = Math.max(at, flexible.length ? Math.max(...flexible.map((b) => b.end)) + 8 : at);
        }
        if (budget.play >= 25 && end - at >= 40) {
          const block = addPlay(at, end, '晚间放松');
          if (block) at = block.end + 8;
        }
        if (budget.sport >= 25 && weights.sport >= 0.55 && end - at >= 40) addSport(at, end, '夜间跑步');
        continue;
      }

      if (budget.play >= 20 && end - at >= 25) addPlay(at, end, '睡前散步');
    }

    // 合并所有块，补上 GPS 起点时间
    let all = blocks.concat(flexible);
    if (gps && gps.in_campus) {
      const firstReal = all
        .filter((b) => b.type !== 'place' && b.type !== 'sleep' && b.start >= prefs.wake)
        .sort((a, b) => a.start - b.start)[0];
      const startAt = Math.max(
        prefs.wake,
        Math.min(firstReal ? firstReal.start - 30 : 8 * 60, 23 * 60)
      );
      const gpsBlock = all.find((b) => b.id === 'gps-start');
      if (gpsBlock) {
        gpsBlock.start = startAt;
        gpsBlock.end = startAt;
      }
    }

    all = all.filter((b) => b.start !== null && Number.isFinite(b.start));
    all.sort((a, b) => a.start - b.start || (a.locked ? -1 : 1));

    // 把 ≥30 分钟、没有硬安排的缝隙标成「自由 / 缓冲」，避免时间轴看起来像瞬移。
    const withFree = [];
    let prevBlock = null;
    for (const block of all) {
      if (prevBlock && prevBlock.poiId && block.start - prevBlock.end >= 30) {
        const freeStart = prevBlock.end + 2;
        const freeEnd = block.start - 5;
        if (freeEnd - freeStart >= 20) {
          let freePoiId = prevBlock.poiId;
          if (weather.play_indoor && OUTDOOR_POIS.has(freePoiId)) {
            const indoor = INDOOR_FALLBACK.find((id) => venueOpen(id, freeStart, freeEnd));
            if (indoor) freePoiId = indoor;
          }
          withFree.push({
            id: `free-${withFree.length + 1}`,
            type: 'free',
            title: '自由 / 缓冲',
            subtitle: POI_MAP.get(freePoiId).name,
            poiId: freePoiId,
            start: freeStart,
            end: freeEnd,
            locked: false,
            source: '[规划]',
            reason: freePoiId !== prevBlock.poiId ? '天气不好，这段挪到室内等' : '这段没有硬安排，留给你机动或提前出发',
          });
        }
      }
      withFree.push(block);
      prevBlock = block;
    }
    all = withFree;

    // 插入通勤段
    const withTravel = [];
    let previous = null;
    for (const block of all) {
      if (previous && previous.poiId && block.poiId && previous.poiId !== block.poiId) {
        const leg =
          previous.gps && gps
            ? gpsToPoiLeg(gps, block.poiId, { ...travelOpts, at: block.start - 3 })
            : pathFor(previous.poiId, block.poiId, { ...travelOpts, at: block.start - 3 });
        if (leg && leg.minutes > 0) {
          let walkEnd = block.start - 3;
          let walkStart = walkEnd - leg.minutes;
          if (walkStart < previous.end) {
            const deficit = previous.end - walkStart;
            if (!previous.locked && previous.end - previous.start - deficit >= 5) {
              previous.end -= deficit;
              previous.duration = previous.end - previous.start;
              walkStart = walkEnd - leg.minutes;
            }
          }
          let tight = false;
          if (walkStart < previous.end) {
            walkStart = previous.end;
            walkEnd = walkStart + leg.minutes;
            tight = true;
            warnings.push(`${clock(block.start)} ${POI_MAP.get(block.poiId).short} 前的通勤时间不足，已压缩前一项并标记为紧凑`);
          }
          walkEnd = Math.min(walkEnd, block.start);
          if (walkEnd - walkStart >= 1) {
            withTravel.push({
              id: `walk-${withTravel.length + 1}`,
              type: 'walk',
              title: mode === 'bike' ? '骑行' : '步行',
              subtitle: `${POI_MAP.get(previous.poiId) ? POI_MAP.get(previous.poiId).short : '当前位置'} → ${POI_MAP.get(block.poiId).short}`,
              poiId: null,
              start: walkStart,
              end: walkEnd,
              locked: false,
              source: '[路线]',
              reason: `约 ${leg.distance} m，${mode === 'bike' ? '骑行' : '步行'} ${leg.minutes} 分钟${travelFactorText(opts)}`,
              leg: {
                from: previous.poiId,
                to: block.poiId,
                distance: leg.distance,
                minutes: leg.minutes,
                points: leg.points,
                tight,
              },
            });
          } else {
            warnings.push(`${clock(block.start)} ${POI_MAP.get(block.poiId).short} 前没有可用通勤时间，已省略无效步行块`);
          }
        }
      }
      withTravel.push(block);
      previous = block;
    }

    // 通勤后的最终排序与校验
    const finalBlocks = withTravel.sort((a, b) => a.start - b.start || (a.locked ? -1 : 1));
    const issues = [];
    for (let i = 1; i < finalBlocks.length; i += 1) {
      const prev = finalBlocks[i - 1];
      const cur = finalBlocks[i];
      if (prev.end > cur.start + 0.01) {
        issues.push(`${clock(cur.start)}「${cur.title}」与上一项「${prev.title}」重叠 ${Math.round(prev.end - cur.start)} 分钟`);
      }
    }
    for (const c of classes) {
      const hit = finalBlocks.find((b) => b.type === 'class' && b.start === c.start && b.title === c.title);
      if (!hit) issues.push(`课程「${c.title}」没有出现在最终日程里`);
    }
    const showerState = openState(POI_MAP.get(shower.poiId), parts.weekday, shower.start);
    if (!showerState.open && showerState.always !== true) issues.push('洗澡时间不在宿舍开放时段');

    // 任务标注：把今天最紧急的任务写进自习块；不改变课程与通勤时间
    const planningTasks = normalizePlanningTasks(opts.tasks);
    const assignedTasks = assignTasksToStudy(finalBlocks, planningTasks);
    const taskMinutes = assignedTasks.reduce((sum, task) => sum + task.scheduled_minutes, 0);
    const unscheduledTasks = assignedTasks.filter((task) => task.remaining > 0);
    const soonLimit = new Date(parts.date.getFullYear(), parts.date.getMonth(), parts.date.getDate() + 2, 23, 59, 59, 999).getTime();
    const urgentUnscheduled = unscheduledTasks.filter((task) => taskDueMs(task.due) <= soonLimit);
    if (urgentUnscheduled.length) {
      warnings.push(`还有 ${urgentUnscheduled.length} 项近两天任务今天没排完，去“考试与待办”里看剩余时间`);
    }

    // 统计
    const legs = finalBlocks.filter((b) => b.type === 'walk' && b.leg);
    const walkMeters = legs.reduce((sum, b) => sum + b.leg.distance, 0);
    const walkMinutes = legs.reduce((sum, b) => sum + b.leg.minutes, 0);
    const studyMinutes = finalBlocks.filter((b) => b.type === 'study').reduce((sum, b) => sum + b.end - b.start, 0);
    const sportMinutes = finalBlocks.filter((b) => b.type === 'sport').reduce((sum, b) => sum + b.end - b.start, 0);
    const playMinutes = finalBlocks.filter((b) => b.type === 'play').reduce((sum, b) => sum + b.end - b.start, 0);
    const classMinutes = finalBlocks.filter((b) => b.type === 'class').reduce((sum, b) => sum + b.end - b.start, 0);
    const outdoorMinutes = finalBlocks
      .filter((b) => b.poiId && OUTDOOR_POIS.has(b.poiId))
      .reduce((sum, b) => sum + b.end - b.start, 0);
    const exposureMinutes = outdoorMinutes + walkMinutes;

    // 路线折线：按时间顺序拼接
    const routePoints = [];
    for (const b of finalBlocks) {
      if (b.type === 'walk' && b.leg && b.leg.points && b.leg.points.length) {
        for (const p of b.leg.points) {
          const last = routePoints[routePoints.length - 1];
          if (!last || Math.abs(last.lat - p.lat) > 1e-7 || Math.abs(last.lng - p.lng) > 1e-7) routePoints.push(p);
        }
      }
    }

    const stops = [];
    for (const b of finalBlocks) {
      if (!b.poiId) continue;
      if (b.type === 'walk' || b.type === 'sleep' || b.type === 'free' || b.type === 'rest') continue;
      // 咖啡厅在图书馆楼内，地图上并到图书馆，避免同一栋楼出现两个编号
      const stopPoi = b.poiId === 'cafe' ? 'library' : b.poiId === 'c11study' ? 'c11' : b.poiId;
      if (!stops.length || stops[stops.length - 1].poiId !== stopPoi) {
        stops.push({ poiId: stopPoi, name: POI_MAP.get(stopPoi).name, time: clock(b.start), type: b.type });
      }
    }

    const summary = {
      stops: new Set(stops.map((s) => s.poiId)).size,
      visits: stops.length,
      walk_meters: Math.round(walkMeters),
      walk_minutes: walkMinutes,
      study_minutes: studyMinutes,
      sport_minutes: sportMinutes,
      play_minutes: playMinutes,
      class_minutes: classMinutes,
      outdoor_minutes: outdoorMinutes,
      exposure_minutes: exposureMinutes,
      task_minutes: taskMinutes,
      tasks_scheduled: assignedTasks.filter((task) => task.scheduled_minutes > 0).length,
      tasks_unscheduled: unscheduledTasks.length,
      flexible_minutes: studyMinutes + sportMinutes + playMinutes,
      conflicts: issues.length,
      warnings: warnings.length,
    };

    const poiStates = POIS.map((poi) => {
      const state = openState(poi, parts.weekday, 12 * 60);
      return {
        id: poi.id,
        name: poi.name,
        category: poi.category,
        open_now: state.open,
        hours: poi.hours_label,
        hours_confidence: poi.hours_confidence,
        coord_confidence: poi.coord_confidence,
      };
    });

    return {
      ok: true,
      meta: {
        date: parts.iso,
        day_name: parts.day_name,
        is_weekend: parts.is_weekend,
        campus: CAMPUS,
        preset: preset.id,
        preset_name: preset.name,
        major: opts.major ? String(opts.major).trim().slice(0, 40) : null,
        weights,
        mode,
        weather,
        weather_advice: weather.advice,
        tasks: assignedTasks.map((task) => ({
          id: task.id,
          title: task.title,
          due: task.due,
          priority: task.priority,
          source: task.source,
          estimated_minutes: task.estimated_minutes,
          scheduled_minutes: task.scheduled_minutes,
          remaining_minutes: task.remaining,
        })),
        rain: weather.is_wet,
        avoid_crowd: Boolean(opts.avoidCrowd),
        traffic: opts.traffic || 'auto',
        start_poi: startPoiId,
        week_number: weekNumber,
        generated_at: new Date().toISOString(),
        data_note: CAMPUS.map_note,
        sources: {
          library_hours: 'https://www.lib.scut.edu.cn/2023/0830/c8738a517122/page.htm',
          hot_water: '华南理工大学 2026 级大学城校区通关指南（党委学生工作部）',
          canteen: '饭堂窗口参考时段，以现场为准',
        },
      },
      preferences: prefs,
      summary,
      blocks: finalBlocks.map(publicBlock),
      legs: legs.map((b) => ({
        from: b.leg.from,
        to: b.leg.to,
        distance: b.leg.distance,
        minutes: b.leg.minutes,
        start: clock(b.start),
        end: clock(b.end),
        tight: b.leg.tight,
      })),
      stops,
      route: { points: routePoints, color: CATEGORY_COLOR.walk },
      gps,
      poi_states: poiStates,
      warnings: dedupe(warnings),
      validation: { ok: issues.length === 0, issues },
    };
  }

  function dedupe(list) {
    return Array.from(new Set(list));
  }

  function publicBlock(b) {
    return {
      id: b.id,
      type: b.type,
      title: b.title,
      subtitle: b.subtitle || null,
      poi_id: b.poiId || null,
      poi_name: b.poiId ? (POI_MAP.get(b.poiId) || {}).name || null : null,
      start: clock(b.start),
      end: clock(b.end),
      start_min: b.start,
      end_min: b.end,
      duration_min: Math.round(b.end - b.start),
      locked: Boolean(b.locked),
      source: b.source,
      reason: b.reason || null,
      detail: b.detail || null,
      task: b.task || null,
      leg: b.leg || null,
      color: CATEGORY_COLOR[b.type] || CATEGORY_COLOR.rest,
      icon: b.poiId && POI_MAP.get(b.poiId) ? POI_MAP.get(b.poiId).icon : b.type === 'walk' ? (b.title === '骑行' ? '🚲' : '🚶') : '•',
    };
  }

  function gpsToPoiLeg(gps, toId, opts) {
    const target = POI_MAP.get(toId);
    if (!target) return null;
    // 先吸附到最近的图节点，再走图；GPS 点到吸附点的距离也计入
    let nearest = null;
    let nearestDistance = Infinity;
    for (const [id, node] of NODE_MAP) {
      if (node.kind === 'poi' && node.category === 'gate') continue;
      const d = haversine(gps, node);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = id;
      }
    }
    if (!nearest) return null;
    const rest = shortestPath(nearest, toId);
    const total = nearestDistance + (Number.isFinite(rest.distance) ? rest.distance : 0);
    const t = travelTime(total, opts.at, opts);
    const startPoint = { lat: gps.lat, lng: gps.lng };
    const points = [startPoint, { lat: NODE_MAP.get(nearest).lat, lng: NODE_MAP.get(nearest).lng }]
      .concat(rest.points)
      .filter((p, i, arr) => i === 0 || Math.abs(p.lat - arr[i - 1].lat) > 1e-7 || Math.abs(p.lng - arr[i - 1].lng) > 1e-7);
    return { points, distance: Math.round(total), minutes: Math.max(1, t.minutes), via: nearest };
  }

  function travelFactorText(opts) {
    const parts = [];
    if (opts.traffic === 'peak') parts.push('高峰人流 ×1.22');
    else if (opts.traffic === 'clear') parts.push('空闲路况 ×0.92');
    else parts.push('课间人流自动修正');
    if (opts.weather && opts.weather.travel_factor > 1) {
      parts.push(`${opts.weather.label} ×${opts.weather.travel_factor}`);
    } else if (opts.rain) {
      parts.push('雨天 ×1.12');
    }
    return `，按${parts.join('、')}`;
  }

  // ---------- 导出 ----------

  function buildMarkdown(plan) {
    if (!plan || !plan.ok) return `# 未生成路线\n\n${(plan && plan.message) || '数据不足'}\n`;
    const m = plan.meta;
    const lines = [];
    lines.push(`# 华园一日路线 · ${m.date} ${m.day_name}`);
    lines.push('');
    lines.push(`> ${m.major ? `专业：${m.major} · ` : ''}${m.campus.name} · ${m.preset_name} · ${m.mode === 'bike' ? '骑行' : '步行'} · ${m.weather.icon} ${m.weather.label} ${m.weather.temperature}°C`);
    lines.push('');
    lines.push('## 时间轴');
    lines.push('');
    lines.push('| 时间 | 安排 | 地点 | 说明 |');
    lines.push('| --- | --- | --- | --- |');
    for (const b of plan.blocks) {
      if (b.type === 'sleep') continue;
      lines.push(`| ${b.start}–${b.end} | ${b.title} | ${b.poi_name || '路上'} | ${b.reason || ''} |`);
    }
    lines.push('');
    lines.push('## 路线');
    lines.push('');
    lines.push(
      plan.stops
        .map((s, i) => `${i + 1}. ${s.name}（${s.time}）`)
        .join(' → ')
    );
    lines.push('');
    lines.push(`总步行 ${plan.summary.walk_meters} m / 约 ${plan.summary.walk_minutes} 分钟；自习 ${plan.summary.study_minutes} 分钟，运动 ${plan.summary.sport_minutes} 分钟，放松 ${plan.summary.play_minutes} 分钟；其中任务 ${plan.summary.task_minutes || 0} 分钟。`);
    lines.push('');
    lines.push('## 天气');
    lines.push('');
    const w = m.weather;
    lines.push(`- ${w.icon} ${w.label}，当前 ${w.temperature}°C（最高 ${w.temperature_max}°C），降水 ${w.precipitation_mm} mm / 概率 ${w.precipitation_probability}%，AQI ${w.aqi}`);
    lines.push(`- 步行/骑行速度系数 ×${w.travel_factor}；${w.sport_indoor ? '运动已优先改室内' : '运动可用户外场地'}${w.play_indoor ? '，放松已优先改室内' : ''}`);
    for (const advice of m.weather_advice || []) lines.push(`- ${advice}`);
    lines.push(`- 天气来源：${w.source === 'open-meteo' ? 'Open-Meteo 实时预报（出发前复核）' : '手动选择/估算（出发前复核）'}`);
    lines.push('');
    if (plan.warnings.length) {
      lines.push('## 待确认');
      lines.push('');
      for (const w of plan.warnings) lines.push(`- ${w}`);
      lines.push('');
    }
    lines.push('## 依据');
    lines.push('');
    lines.push('- 图书馆 07:30–23:00：图书馆官网《开馆时间》');
    lines.push('- 热水 12:00–14:00、17:00–00:00；门禁周日至周四 23:00 / 周五周六 23:30：2026 级大学城校区通关指南');
    lines.push('- 步行时间为示意图上的路网距离 ÷ 步速，叠加课间人流/雨天系数，实际以现场为准');
    lines.push('- 坐标 GCJ-02；标 medium/low 的 POI 仅用于示意，不用于导航');
    return lines.join('\n');
  }

  return {
    version: '0.1.0',
    planDay,
    buildMarkdown,
    walkPath: pathFor,
    shortestPath,
    openState,
    nextOpenLabel,
    poiHoursText,
    parseTime,
    clock,
    durationText,
    resolveGps,
    wgs84ToGcj02,
    pointToPoiDistance,
    normalizeWeather,
    weatherPresets: WEATHER_PRESETS,
    categories: CATEGORY_COLOR,
    poi: (id) => POI_MAP.get(id) || null,
    pois: POIS,
    presets: PRESETS,
    campus: CAMPUS,
    hotWater: HOT_WATER,
    curfew: CURFEW,
  };
});
