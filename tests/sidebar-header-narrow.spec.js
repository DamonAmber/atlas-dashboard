// 侧栏拖窄后侧栏头不重叠（桌面实机验收第 2 轮 · 不过 1）
//
// 现象：把侧栏拖窄，左上角品牌图标与右侧四个操作按钮（刷新 / 新建 / 全部已读 / 设置）叠在一起。
// 桌面版左侧还有 90px 红绿灯内边距，220px 时图标直接压在按钮上。
// 修法：侧栏头内容区不够时容器查询收起「Atlas」字样只留图标；最窄宽度按实际内边距现算
//      （app.js sidebarMinWidth：浏览器 / 全屏 220，桌面 inset 90 约 268），拖不到更窄。
//
// 三种外壳（浏览器版 / 桌面版红绿灯 inset 90 / 桌面全屏）各从最窄扫到 800（真实拖动 #resizer），每档断言：
//   - 品牌区（图标与可见字样）与操作组包围盒不相交，且之间留 ≥ 4px
//   - 品牌图标完整（28×28）、四个按钮都在侧栏内、不出侧栏右缘
//   - 字样要么完整显示（没被 overflow 裁掉），要么整段隐藏
//   - 桌面版：图标左缘 ≥ 红绿灯内边距（不压红绿灯）
// 另外：桌面版存过 220 的偏好宽度 → 启动后生效宽度被撑到最窄宽度；退出全屏同样重新兜底。
// 截图：$SIDEBAR_HEADER_SHOTS（缺省系统临时目录/atlas-sidebar-header）/<外壳>-<宽度>.png
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');
let fail = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`✗ ${name}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`); }
  else console.log(`✓ ${name}`);
}
const SHOTS = process.env.SIDEBAR_HEADER_SHOTS || path.join(os.tmpdir(), 'atlas-sidebar-header');

function fakeBridge() {
  window.__ws = null;
  window.atlasDesktop = {
    isDesktop: true, platform: 'darwin', electronVersion: '0.0.0-test', titlebarInset: 90,
    exportPdf: async () => ({ ok: false }), onMenuCommand: () => () => {}, closeWindow: () => {},
    onOpenPath: () => () => {}, takePendingOpen: async () => null, appVersion: async () => null,
    setTheme: () => {}, setChromeState: () => {},
    onWindowState: (cb) => { window.__ws = cb; return () => { window.__ws = null; }; },
    updates: { getState: async () => ({ state: 'idle' }), check: async () => ({ state: 'unsupported' }), quitAndInstall: async () => ({ ok: false }), onStatus: () => () => {} },
  };
}

function measure() {
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const sb = document.querySelector('.sidebar');
  const mark = document.querySelector('.brand-mark');
  const text = document.querySelector('.brand-text');
  const title = document.querySelector('.brand-title');
  const actions = document.querySelector('.sidebar-header .actions');
  const textShown = getComputedStyle(text).display !== 'none';
  return {
    sidebarW: Math.round(box(sb).w),
    sidebarR: box(sb).r,
    padLeft: parseFloat(getComputedStyle(document.querySelector('.sidebar-header')).paddingLeft),
    mark: box(mark),
    textShown,
    text: textShown ? box(text) : null,
    textClipped: textShown ? title.scrollWidth > text.clientWidth + 0.5 : false,
    actions: box(actions),
    buttons: [...actions.querySelectorAll('button')].map(box),
  };
}

async function dragTo(page, x) {
  const r = await page.locator('#resizer').boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, r.y + r.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(60);
}

async function sweep(page, shell, { desktop }) {
  // 先拖到最左，拿到实际最窄宽度
  await dragTo(page, 0);
  const minW = (await page.evaluate(measure)).sidebarW;
  console.log(`      ${shell}：最窄宽度 ${minW}px`);
  const widths = [...new Set([minW, minW + 10, 260, 280, 300, 320, 360, 500, 800].filter(w => w >= minW))].sort((a, b) => a - b);
  const bad = [];
  for (const w of widths) {
    await dragTo(page, w);
    const m = await page.evaluate(measure);
    if (m.sidebarW !== w) bad.push({ w, why: 'width', got: m.sidebarW });
    const brandR = m.textShown ? Math.max(m.mark.r, m.text.r) : m.mark.r;
    if (m.actions.l - brandR < 4) bad.push({ w, why: 'overlap', brandR, actionsL: m.actions.l });
    if (Math.round(m.mark.w) !== 28 || Math.round(m.mark.h) !== 28) bad.push({ w, why: 'mark-size', mark: m.mark });
    if (m.buttons.length !== 4 || m.buttons.some(b => b.r > m.sidebarR + 0.5 || b.w < 27)) bad.push({ w, why: 'buttons', buttons: m.buttons });
    if (m.textClipped) bad.push({ w, why: 'text-clipped' });
    if (desktop && m.mark.l < m.padLeft) bad.push({ w, why: 'traffic-lights', markL: m.mark.l, pad: m.padLeft });
    if ([minW, 280, 320].includes(w)) {
      fs.writeFileSync(path.join(SHOTS, `${shell}-${w}.png`), await page.screenshot({ clip: { x: 0, y: 0, width: Math.max(w, 340), height: 60 } }));
    }
  }
  check(`${shell}：${widths.join(' / ')} 各档品牌区与操作组不相交、不裁切`, bad, []);
  return minW;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const atlas = await startAtlas({ prefix: 'atlas-sb-header-', files: { 'proj/a.md': '# a\n', 'proj/b.html': '<h1>b</h1>' } });
  const browser = await chromium.launch();
  const errors = [];

  // ---- 浏览器版 ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(atlas.base);
    await page.waitForSelector('#tree .file');
    const minW = await sweep(page, 'web', { desktop: false });
    check('浏览器版最窄仍是 220', minW, 220);
    await ctx.close();
  }

  // ---- 桌面版（红绿灯 inset 90）+ 全屏 ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(fakeBridge);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(atlas.base);
    await page.waitForSelector('#tree .file');
    check('桌面版红绿灯内边距 90px', await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar-header')).paddingLeft), '90px');
    const minDesk = await sweep(page, 'desktop', { desktop: true });
    check('桌面版最窄宽度被撑大（> 220，≤ 280）', minDesk > 220 && minDesk <= 280, true);
    check('默认宽度 320 下桌面版品牌字样完整显示', await (async () => { await dragTo(page, 320); const m = await page.evaluate(measure); return m.textShown && !m.textClipped; })(), true);

    await page.evaluate(() => window.__ws({ fullscreen: true }));
    await page.waitForTimeout(80);
    const minFs = await sweep(page, 'desktop-fullscreen', { desktop: false });
    check('全屏（无红绿灯）最窄回到 220', minFs, 220);
    // 全屏下拖到 220 存了偏好 → 退出全屏后生效宽度撑回最窄宽度，不重叠
    await dragTo(page, 0);
    await page.evaluate(() => window.__ws({ fullscreen: false }));
    await page.waitForTimeout(80);
    const back = await page.evaluate(measure);
    check('退出全屏：生效宽度撑回桌面最窄宽度', back.sidebarW, minDesk);
    check('退出全屏：品牌图标与操作组不相交', back.actions.l - back.mark.r >= 4, true);
    check('偏好宽度仍是用户拖的 220（只兜底生效宽度）', await page.evaluate(() => localStorage.getItem('atlas:sidebarWidth')), '220');

    // 重新加载：存的 220 在桌面版启动即被兜底
    await page.reload();
    await page.waitForSelector('#tree .file');
    const boot = await page.evaluate(measure);
    check('桌面版启动时存的 220 被兜底到最窄宽度', boot.sidebarW, minDesk);
    check('启动首屏品牌图标与操作组不相交', boot.actions.l - boot.mark.r >= 4, true);
    await ctx.close();
  }

  check('没有页面错误', errors, []);
  await browser.close();
  await atlas.stop();
  console.log(`\n截图：${SHOTS}\n${total - fail}/${total} 通过`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
