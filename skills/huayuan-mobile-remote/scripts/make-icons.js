'use strict';

/**
 * 生成手机工作台的 PWA 图标（纯 Node，无图像库）。
 *
 * 输出：public/icon-192.png、public/icon-512.png、public/icon-180.png（iOS 桌面图标）
 * 用法：node scripts/make-icons.js
 *
 * 说明：Android Chrome 的「添加到主屏幕」要求 manifest 里有 PNG 图标；
 * 这里用超采样 + 纯像素绘制，避免引入任何图形依赖。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'public');
const SS = 4; // 超采样倍数

const COLORS = {
  bg: [20, 63, 51],
  bgDeep: [16, 52, 42],
  page: [251, 247, 236],
  ink: [27, 42, 35],
  accent: [200, 96, 60],
  ring: [20, 63, 51],
};

// ── 画布（RGB float，便于超采样平均）────────────────────────────────
function createCanvas(size) {
  const data = new Float32Array(size * size * 3);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 3] = COLORS.bg[0];
    data[i * 3 + 1] = COLORS.bg[1];
    data[i * 3 + 2] = COLORS.bg[2];
  }
  return { size, data };
}

function blend(canvas, x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const index = (y * canvas.size + x) * 3;
  canvas.data[index] = canvas.data[index] * (1 - alpha) + rgb[0] * alpha;
  canvas.data[index + 1] = canvas.data[index + 1] * (1 - alpha) + rgb[1] * alpha;
  canvas.data[index + 2] = canvas.data[index + 2] * (1 - alpha) + rgb[2] * alpha;
}

function roundedRect(canvas, x0, y0, x1, y1, radius, rgb) {
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y += 1) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      const cx = Math.min(Math.max(px, x0 + r), x1 - r);
      const cy = Math.min(Math.max(py, y0 + r), y1 - r);
      const dist = Math.hypot(px - cx, py - cy);
      if (dist <= r) blend(canvas, x, y, rgb, 1);
    }
  }
}

function circle(canvas, cx, cy, radius, rgb) {
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y += 1) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x += 1) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) blend(canvas, x, y, rgb, 1);
    }
  }
}

function thickLine(canvas, x0, y0, x1, y1, width, rgb) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    circle(canvas, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, rgb);
  }
}

function draw(size) {
  const canvas = createCanvas(size * SS);
  const u = (value) => value * size * SS;

  // 底板：深绿圆角方块
  roundedRect(canvas, 0, 0, canvas.size, canvas.size, u(0.22), COLORS.bgDeep);
  // 内页：暖白日历卡
  roundedRect(canvas, u(0.16), u(0.24), u(0.84), u(0.8), u(0.07), COLORS.page);
  // 顶部条
  roundedRect(canvas, u(0.16), u(0.24), u(0.84), u(0.38), u(0.07), COLORS.bg);
  roundedRect(canvas, u(0.16), u(0.33), u(0.84), u(0.39), u(0.01), COLORS.bg);
  // 装订环
  roundedRect(canvas, u(0.28), u(0.175), u(0.345), u(0.3), u(0.03), COLORS.page);
  roundedRect(canvas, u(0.655), u(0.175), u(0.72), u(0.3), u(0.03), COLORS.page);
  // 网格点
  const dots = [
    [0.27, 0.5],
    [0.42, 0.5],
    [0.57, 0.5],
    [0.27, 0.625],
    [0.42, 0.625],
  ];
  dots.forEach(([x, y]) => circle(canvas, u(x), u(y), u(0.028), COLORS.ink));
  // 陶土红对勾
  thickLine(canvas, u(0.52), u(0.63), u(0.62), u(0.72), u(0.075), COLORS.accent);
  thickLine(canvas, u(0.62), u(0.72), u(0.78), u(0.53), u(0.075), COLORS.accent);

  return downsample(canvas, SS);
}

function downsample(canvas, factor) {
  const out = Math.round(canvas.size / factor);
  const data = Buffer.alloc(out * out * 4);
  const area = factor * factor;
  for (let y = 0; y < out; y += 1) {
    for (let x = 0; x < out; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const index = ((y * factor + dy) * canvas.size + (x * factor + dx)) * 3;
          r += canvas.data[index];
          g += canvas.data[index + 1];
          b += canvas.data[index + 2];
        }
      }
      const offset = (y * out + x) * 4;
      data[offset] = Math.round(r / area);
      data[offset + 1] = Math.round(g / area);
      data[offset + 2] = Math.round(b / area);
      data[offset + 3] = 255;
    }
  }
  return { size: out, data };
}

// ── PNG 编码 ───────────────────────────────────────────────────────
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(image) {
  const { size, data } = image;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  [192, 'icon-192.png'],
  [512, 'icon-512.png'],
  [180, 'icon-180.png'],
];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [size, name] of targets) {
  const image = draw(size);
  fs.writeFileSync(path.join(OUT_DIR, name), encodePng(image));
  console.log(`ICON_WRITTEN:${name}:${size}x${size}`);
}
