'use strict';

/**
 * 华南理工大学大学城校区 · 官方地图底图与投影参数
 *
 * 底图：assets/campus-map-official.jpg（官方校园导览图，1280×1468）。
 * 页面不再自己画楼栋和道路，而是在官图上叠加「按经纬度计算的路线、序号、标记」，
 * 所以这里只需要一份准确的「经纬度 → 图片像素」投影，以及要在图上显示的地标白名单。
 *
 * 校准方法（可复现，见 CONTRIBUTING 或提交说明）：
 *   1. 在官图上检出 A1–A5、B1–B13、C1–C17、D1–D5、E1–E2 共 41 个楼栋标号点的像素中心；
 *   2. 用其中与现有数据一致的 27 个点做稳健仿射拟合（Tukey 迭代重加权，剔除 B/E 区旧坐标），
 *      内点中位残差约 6 px（≈ 7 m），据此反解出全部楼栋的真实坐标；
 *   3. 拟合参数即为下面的 PROJECTION：先把经纬度换算成局部米，再仿射到图片像素。
 *
 * 坐标口径：GCJ-02，与 data/campus-data.js 一致。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HuayuanCampusMap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const IMAGE = {
    src: 'assets/campus-map-official.jpg',
    width: 1280,
    height: 1468,
    label: '华南理工大学大学城校区校园地图',
    note: '底图为官方校园地图；路线、序号与标记按经纬度投影叠加，仅用于安排行程，不替代导航。',
    // 「学术大讲堂」附近有一小块取自学校《新生报到指引平面图》的同位置裁片：
    // 两图是同一份底图，按 27 个楼栋标号点配准（中位残差 1.2 px），用来去掉原扫描件上的手绘红圈。
    composed_from: ['校园地图（主底图）', '新生报到指引平面图（局部补块）'],
  };

  const PROJECTION = {
    lat0: 23.048,
    meters_per_deg_lat: 111320,
    // 像素 = A · (局部米) + t ；A 同时吃掉北向朝上、缩放与约 3.7° 的图面旋转
    a: 0.8721,
    b: 0.14276,
    c: 0.05636,
    d: -0.91751,
    tx: -10496500.6,
    ty: 1700050.8,
  };

  /**
   * 经纬度 → 官图像素（原图 1280×1468，左上角为原点）。
   * @param {number} lat 纬度（GCJ-02）
   * @param {number} lng 经度（GCJ-02）
   * @returns {{x:number,y:number}} 图片像素坐标
   */
  function toImagePixel(lat, lng) {
    const p = PROJECTION;
    const mx = lng * p.meters_per_deg_lat * Math.cos((p.lat0 * Math.PI) / 180);
    const my = lat * p.meters_per_deg_lat;
    return {
      x: p.a * mx + p.b * my + p.tx,
      y: p.c * mx + p.d * my + p.ty,
    };
  }

  // 官图上要额外叠标记的地标（楼栋编号图面已有，不重复画点）
  const PINS = [
    'library',
    'cafe',
    'canteen1',
    'canteen2',
    'gym',
    'field',
    'south-field',
    'swimming',
    'lake',
    'moon-lake',
    'academic-hall',
    'music-hall',
    'hospital',
    'eastgate',
    'c11study',
    'c1',
    'c11',
  ];

  // 带文字标签的地标（其余只用图标，避免和图上中文重名）
  // 官图上已有中文名，不再叠手标文字；需要时在这里加 id: '标签'
  const LABELS = {};

  return { IMAGE, PROJECTION, PINS, LABELS, toImagePixel };
});
