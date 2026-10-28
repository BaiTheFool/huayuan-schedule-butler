'use strict';

// 华南理工大学官网“机构设置-学院书院”目录（核验日期 2026-10-28）。
// 学院官网是稳定抓取入口；公众号账号名称以各学院官网二维码/品牌页为准，
// 不把猜测出来的公众号 ID 当成已验证数据。
const COLLEGES = [
  ['材料科学与工程学院', 'https://www2.scut.edu.cn/materials/'],
  ['电力学院', 'https://www.scut.edu.cn/ep/'],
  ['电子与信息学院', 'https://www2.scut.edu.cn/ee/'],
  ['法学院', 'https://www.scut.edu.cn/law/index.htm'],
  ['工商管理学院', 'https://www.scut.edu.cn/sba/'],
  ['公共管理学院', 'https://www2.scut.edu.cn/spa/'],
  ['国际教育学院', 'https://www.scut.edu.cn/sie/'],
  ['国家卓越工程师学院', 'https://www2.scut.edu.cn/engineers/'],
  ['海洋科学与工程学院', 'https://www2.scut.edu.cn/marine/'],
  ['化学与化工学院', 'https://www2.scut.edu.cn/ce/'],
  ['环境与能源学院', 'https://www.scut.edu.cn/environment/'],
  ['机械与汽车工程学院', 'https://www.scut.edu.cn/smae/'],
  ['计算机科学与工程学院', 'https://www2.scut.edu.cn/cs/'],
  ['建筑学院', 'https://www.scut.edu.cn/architecture/'],
  ['经济与金融学院', 'https://www2.scut.edu.cn/economy/'],
  ['峻德书院', 'https://www2.scut.edu.cn/jdsy/main.htm'],
  ['马克思主义学院', 'https://www.scut.edu.cn/politics/'],
  ['铭诚书院', 'https://www2.scut.edu.cn/mcsy/'],
  ['能源学院', 'https://www2.scut.edu.cn/energy/'],
  ['前沿软物质学院', 'https://www2.scut.edu.cn/SESM/'],
  ['轻工科学与工程学院', 'https://www2.scut.edu.cn/qgkxygc/'],
  ['软件学院', 'https://www2.scut.edu.cn/sse/'],
  ['设计学院', 'https://www2.scut.edu.cn/design/'],
  ['生物科学与工程学院', 'https://www.scut.edu.cn/biology/index.html'],
  ['生物医学科学与工程学院', 'https://www2.scut.edu.cn/bmse/'],
  ['食品科学与工程学院', 'https://www2.scut.edu.cn/sp/'],
  ['数学学院', 'https://www2.scut.edu.cn/math/'],
  ['体育学院', 'https://www.scut.edu.cn/sport/'],
  ['土木与交通学院', 'https://www2.scut.edu.cn/jtxy/'],
  ['外国语学院', 'https://www.scut.edu.cn/sfl/'],
  ['微电子学院/集成电路学院', 'https://www2.scut.edu.cn/microelectronics/'],
  ['未来技术学院', 'https://www2.scut.edu.cn/ft/'],
  ['吴贤铭智能工程学院', 'https://www2.scut.edu.cn/wusie/'],
  ['物理与光电学院', 'https://www2.scut.edu.cn/physics/'],
  ['先进材料国际化示范学院', 'https://www2.scut.edu.cn/advancedmaterials/'],
  ['新闻与传播学院', 'https://www.scut.edu.cn/communication/'],
  ['医学院', 'https://www.scut.edu.cn/med/'],
  ['艺术学院', 'https://www.scut.edu.cn/arts/index.htm'],
  ['知识产权学院', 'https://www.scut.edu.cn/law/index.htm'],
  ['自动化科学与工程学院', 'https://www2.scut.edu.cn/automation/'],
  ['创业教育学院', 'https://www2.scut.edu.cn/scutsee/'],
  ['继续教育学院', 'https://sce.scut.edu.cn/'],
].map(([name, url], index) => ({
  id: `college-${String(index + 1).padStart(2, '0')}`,
  name,
  url,
  aliases: [name.replace(/(?:大学)?学院$/, ''), name.replace(/科学与工程学院$/, '')],
  wechat_hint: `${name} 官方微信 / 团委 / 学生会`,
}));

function collegeByInput(input) {
  const value = String(input || '').replace(/\s+/g, '').toLowerCase();
  if (!value) return null;
  return (
    COLLEGES.find((college) => {
      const names = [college.name, ...college.aliases].map((name) => String(name).replace(/\s+/g, '').toLowerCase());
      return names.includes(value);
    }) ||
    COLLEGES.find((college) => {
      const names = [college.name, ...college.aliases].map((name) => String(name).replace(/\s+/g, '').toLowerCase());
      return names.some((name) => name.includes(value) || value.includes(name));
    }) ||
    null
  );
}

module.exports = { COLLEGES, collegeByInput };
