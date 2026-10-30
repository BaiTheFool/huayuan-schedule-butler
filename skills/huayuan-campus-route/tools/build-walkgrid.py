#!/usr/bin/env python3
"""由官方校园地图生成步行代价网格（data/campus-walkgrid.js）。

用法（需要 Pillow + numpy）：

    python tools/build-walkgrid.py                    # 用默认底图
    python tools/build-walkgrid.py --image <路径>      # 换一张同尺寸底图

规则：按 CELL=4 px 一格取颜色均值，分成三类代价——
    1 = 路面 / 广场 / 硬化地（可走，便宜）
    6 = 草地、绿化带（可走，偏贵，尽量不穿）
    9 = 水体、楼体轮廓与阴影（几乎不走）
结果用「运行长度编码」压实成一行字符串，页面端解码后跑 A*。
底图尺寸变化时必须同步更新 data/campus-map.js 的 IMAGE 与 PROJECTION。
"""

import argparse
import os

import numpy as np
from PIL import Image

CELL = 4
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_IMAGE = os.path.join(ROOT, 'public', 'assets', 'campus-map-official.jpg')
DEFAULT_OUT = os.path.join(ROOT, 'data', 'campus-walkgrid.js')

HEADER = """'use strict';

/**
 * 华工大学城校区 · 步行代价网格（供路线沿路寻路用）
 *
 * 由官方校园地图按 4 px 一格采样得到：每格颜色均值分为三类——
 *   1 = 路面 / 广场 / 硬化地（可走，代价低）
 *   6 = 草地、绿化带（可走，代价高，尽量不穿）
 *   9 = 水体、楼体轮廓与阴影（几乎不走）
 * 页面用 A* 在网格上寻路，把「停留点之间直连」换成贴地图上的路走，
 * 再把折线用 Chaikin 切角平滑成曲线。
 *
 * 本文件由 tools/build-walkgrid.py 生成，勿手改。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HuayuanWalkGrid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CELL = %d;
  const WIDTH = %d;
  const HEIGHT = %d;
  const RLE = '%s';

  let cache = null;

  /** 解码成 Uint8Array（宽 × 高，行优先） */
  function decode() {
    if (cache) return cache;
    const out = new Uint8Array(WIDTH * HEIGHT);
    let i = 0;
    for (const token of RLE.split('.')) {
      if (!token) continue;
      const v = Number(token[token.length - 1]);
      let run = 0;
      for (let j = 0; j < token.length - 1; j += 1) run = run * 36 + parseInt(token[j], 36);
      for (let k = 0; k < run && i < out.length; k += 1) out[i++] = v;
    }
    cache = out;
    return cache;
  }

  return { CELL, WIDTH, HEIGHT, decode };
});
"""


def b36(n):
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    if n == 0:
        return '0'
    out = ''
    while n:
        out = digits[n % 36] + out
        n //= 36
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default=DEFAULT_IMAGE)
    ap.add_argument('--out', default=DEFAULT_OUT)
    args = ap.parse_args()

    im = Image.open(args.image).convert('RGB')
    w, h = im.size
    a = np.asarray(im).astype(np.float32)
    gw, gh = w // CELL, h // CELL
    blocks = a[:gh * CELL, :gw * CELL].reshape(gh, CELL, gw, CELL, 3).mean(axis=(1, 3))

    R, G, B = blocks[..., 0], blocks[..., 1], blocks[..., 2]
    V = blocks.max(axis=2)
    greenish = (G > R + 5) & (G > B + 5)
    water = (B > R + 12) & (B > G + 2)
    dark = V < 96

    cost = np.full((gh, gw), 1, np.uint8)
    cost[greenish] = 6
    cost[dark] = 9
    cost[water] = 9

    flat = cost.reshape(-1)
    runs = []
    prev = int(flat[0])
    count = 1
    for v in flat[1:].tolist():
        if v == prev:
            count += 1
        else:
            runs.append((prev, count))
            prev = v
            count = 1
    runs.append((prev, count))

    rle = '.'.join('%s%d' % (b36(c), v) for v, c in runs)
    body = HEADER % (CELL, gw, gh, rle)
    with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)

    share = {int(v): int((cost == v).sum()) for v in np.unique(cost)}
    print('grid %dx%d  cells %d  runs %d' % (gw, gh, gw * gh, len(runs)))
    print('cost share:', share)
    print('written', args.out, len(body), 'bytes')


if __name__ == '__main__':
    main()
