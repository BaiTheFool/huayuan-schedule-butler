'use strict';

/**
 * 手机远程工作台 · 包级回归门禁。
 *
 * 覆盖：技能是否注册、Agent 是否知道入口、启动脚本自检、前端静态资源完整性、
 *       只读与鉴权约束、版本一致性、以及跑一遍 smoke.js 的真机无关冒烟。
 *
 * 用法：node golden-path/check-mobile.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'huayuan-mobile-remote');
const PUBLIC_DIR = path.join(SKILL_DIR, 'public');
const SERVER = path.join(SKILL_DIR, 'scripts', 'remote-server.js');
const LAUNCHER = path.join(SKILL_DIR, 'scripts', 'launch-remote.js');
const SMOKE = path.join(SKILL_DIR, 'test', 'smoke.js');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const plugin = JSON.parse(read(path.join(ROOT, '.codebuddy-plugin', 'plugin.json')));
const agent = read(path.join(ROOT, 'agents', 'huayuan-schedule-butler.md'));
const skillMd = read(path.join(SKILL_DIR, 'SKILL.md'));
const serverSource = read(SERVER);
const launcherSource = read(LAUNCHER);
const readme = read(path.join(ROOT, 'README.md'));
const versionLine = read(path.join(ROOT, 'VERSION.md')).split(/\r?\n/)[0];

// 1) 结构与注册
check('技能目录含 SKILL.md / scripts / public / test', ['SKILL.md', 'scripts', 'public', 'test'].every((name) => fs.existsSync(path.join(SKILL_DIR, name))));
check('SKILL.md frontmatter 名称与目录一致', /^---[\s\S]*?name:\s*huayuan-mobile-remote/m.test(skillMd));
check('plugin.json 已注册手机工作台技能', plugin.skills.includes('./skills/huayuan-mobile-remote'));
check('Agent frontmatter 技能列表已包含手机工作台', /skills:\s*\[[^\]]*huayuan-mobile-remote/.test(agent));
check('Agent 提示词有手机工作台入口段', /## 手机工作台/.test(agent) && /launch-remote\.js/.test(agent));
check('README 提到手机远程工作台', /手机工作台|手机远程/.test(readme));
check('版本号单一事实源与 plugin.json 一致', versionLine === `VERSION=${plugin.version}`, `${versionLine} / ${plugin.version}`);

// 2) 启动器自检与状态隔离
const selfCheck = spawnSync(process.execPath, [LAUNCHER, '--self-check'], { encoding: 'utf8', timeout: 15000 });
check('启动器 --self-check 通过', selfCheck.status === 0 && /MOBILE_REMOTE_SELF_CHECK_PASS/.test(selfCheck.stdout || ''));

// 3) 前端资源
for (const file of ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-180.png']) {
  check(`静态资源存在：${file}`, fs.existsSync(path.join(PUBLIC_DIR, file)));
}
const manifest = JSON.parse(read(path.join(PUBLIC_DIR, 'manifest.webmanifest')));
check('manifest 为 standalone 且从根路径启动', manifest.display === 'standalone' && manifest.start_url === '/');
check('manifest 提供 192/512 图标', manifest.icons.some((icon) => icon.sizes === '192x192') && manifest.icons.some((icon) => icon.sizes === '512x512'));
const png = fs.readFileSync(path.join(PUBLIC_DIR, 'icon-192.png'));
check('PNG 图标签名正确', png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
const html = read(path.join(PUBLIC_DIR, 'index.html'));
check('移动端视口与安全区', /viewport-fit=cover/.test(html) && /width=device-width/.test(html));
check('页面声明只读边界', /只读/.test(html));
check('前端不含内联脚本（CSP 兼容）', !/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/.test(html));
const appJs = read(path.join(PUBLIC_DIR, 'app.js'));
check('前端只用相对接口（不跨域）', !/https?:\/\//.test(appJs.replace(/https:\/\/example\.edu\.cn/g, '')));

// 4) 安全约束（源码级）
check('服务端只读：写方法统一 405', /READ_ONLY/.test(serverSource) && /'POST'/.test(serverSource));
check('服务端不写文件', !/writeFile|appendFile|createWriteStream/.test(serverSource));
check('令牌常量时间比较', /timingSafeEqual/.test(serverSource));
check('配对码有失败限速', /MAX_PAIR_FAILURES/.test(serverSource) && /PAIR_LOCKED/.test(serverSource));
check('默认绑定全部网卡但可改', /--host/.test(launcherSource) && /--host/.test(serverSource));
check('静态目录限制在 public 内', /publicDir \+ path\.sep/.test(serverSource));
check('响应带 CSP / nosniff / frame 保护', /Content-Security-Policy/.test(serverSource) && /nosniff/.test(serverSource) && /X-Frame-Options/.test(serverSource));
check('不硬编码令牌或配对码', !/[0-9a-f]{40,}/.test(serverSource) && !/code\s*=\s*'\d{6}'/.test(serverSource));
check('启动器支持公网隧道与停止', /--tunnel/.test(launcherSource) && /--stop/.test(launcherSource));
check('服务端提供局域网发现（UDP 广播）', /HUAYUAN_DISCOVER/.test(serverSource) && /require\('dgram'\)/.test(serverSource));
check('启动器打印发现端口', /MOBILE_REMOTE_DISCOVERY/.test(launcherSource));
check('服务端可直接下发 APK', /download\/app\.apk/.test(serverSource) && /application\/vnd\.android\.package-archive/.test(serverSource));
check('配对页提供「装到手机桌面」入口', /download-card/.test(html) && /\/download\/app\.apk/.test(html));
check('新手教程已入库', fs.existsSync(path.join(SKILL_DIR, 'references', '手机连接傻瓜教程.md')));
check('SKILL 指向新手教程', /references\/手机连接傻瓜教程\.md/.test(skillMd));
check('Agent 初始化后引导装到手机', /装到手机桌面/.test(agent) && /download\/app\.apk/.test(agent));
const apkPath = path.join(SKILL_DIR, 'apk', 'huayuan-workbench.apk');
check('随包 APK 存在且是 zip', fs.existsSync(apkPath) && fs.readFileSync(apkPath).subarray(0, 2).toString('ascii') === 'PK', fs.existsSync(apkPath) ? `${fs.statSync(apkPath).size} B` : 'missing');

// 5) 端到端冒烟
const smoke = spawnSync(process.execPath, [SMOKE], { encoding: 'utf8', timeout: 120000 });
check('冒烟测试全部通过', smoke.status === 0 && /MOBILE_REMOTE_SMOKE:PASS/.test(smoke.stdout || ''), String((smoke.stdout || '').split('\n').filter(Boolean).pop() || '').slice(0, 60));

const failed = checks.filter((item) => !item.ok);
console.log(`MOBILE:${failed.length ? 'FAIL' : 'PASS'} ${checks.length - failed.length}/${checks.length}`);
process.exitCode = failed.length ? 1 : 0;
