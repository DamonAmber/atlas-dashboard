// 切主题时已打开的浮层全程可见（桌面实机验收第 2 轮 · 不过 2）
//
// 现象：设置窗开着时切浅 / 深色，设置窗整个消失一下再回来。
// 原因：侧栏 / 顶栏 / 标签栏 / 预览各有 view-transition-name，命名分组总是画在 root 快照之上；
//      设置窗、⌘K、悬停预览这类浮层在 root 快照里，于是过渡期间被这几块分组盖住。
// 修法：data-vt="theme" 时撤掉命名，整页只剩 root 一组，浮层按原层叠顺序一起淡入。
//
// 断言（设置窗 / ⌘K / 快速查看 / 对比面板 四种浮层各跑一遍，__atlasForceVT 打开真实 View Transition）：
//   - 过渡中只有 ::view-transition-group(root)，没有别的命名分组
//   - 把过渡动画定在 0%：浮层区域的像素与切换前一致（旧快照里浮层完整可见）
//   - 定在 50%：浮层区域 ≈ 切换前与切换后的平均（浮层在淡入，没有被别的东西盖住）
//   - 过渡结束后浮层仍然打开
// 截图：$THEME_OVERLAY_SHOTS（缺省系统临时目录/atlas-theme-overlay）/theme-overlay-<名称>-{before,0,50,after}.png
const fs = require('fs');
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
const ART = process.env.THEME_OVERLAY_SHOTS || path.join(require('os').tmpdir(), 'atlas-theme-overlay');
const FILES = {};
for (let i = 0; i < 6; i++) FILES[`proj/doc-${i}.html`] = `<h1>文档 ${i}</h1><p>${'正文 '.repeat(200)}</p>`;

// 用一个空白页的 canvas 解 PNG，返回 RGBA 数组（仓库里没有 PNG 解码依赖）
async function decoder(browser) {
  const p = await browser.newPage();
  return async (buf) => p.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(0, 0, c.width, c.height).data);
  }, buf.toString('base64'));
}
// 平均每通道绝对差（忽略 alpha）
function meanDiff(a, b) {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { s += Math.abs(a[i + k] - b[i + k]); n++; }
  return s / n;
}
function avg(a, b) { return a.map((v, i) => (v + b[i]) / 2); }

(async () => {
  fs.mkdirSync(ART, { recursive: true });
  const atlas = await startAtlas({ prefix: 'atlas-theme-overlay-', files: FILES });
  const browser = await chromium.launch();
  const decode = await decoder(browser);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(atlas.base, { waitUntil: 'load' });
  await page.waitForSelector('#tree .file');
  await page.click('#tree .file');
  await page.waitForTimeout(800);
  // 测的是层叠关系，不是缓动曲线：改成线性，50% 时间点就是 50% 混合
  await page.addStyleTag({ content: '::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation-timing-function:linear!important}' });
  await page.evaluate(() => { window.__atlasForceVT = true; switchTheme('light'); });
  await page.waitForTimeout(700);

  const overlays = [
    { name: 'settings', label: '设置窗', sel: '#settings-modal .settings-panel',
      open: async () => { await page.click('#btn-settings'); await page.click('.settings-nav-item[data-goto="appearance"]'); },
      close: async () => { await page.keyboard.press('Escape'); },
      isOpen: () => !document.getElementById('settings-modal').classList.contains('hidden') },
    { name: 'quickopen', label: '⌘K', sel: '#quickopen .quickopen-panel',
      open: async () => { await page.evaluate(() => openQuickOpen()); },
      close: async () => { await page.keyboard.press('Escape'); },
      isOpen: () => !document.getElementById('quickopen').classList.contains('hidden') },
    { name: 'peek', label: '快速查看', sel: '#peek',
      open: async () => { await page.evaluate(() => {
        const p = document.getElementById('peek');
        p.style.left = '620px'; p.style.top = '240px';
        document.getElementById('peek-title').textContent = 'doc-1.html';
        document.getElementById('peek-empty').classList.remove('hidden');
        p.classList.remove('hidden');
      }); },
      close: async () => { await page.evaluate(() => document.getElementById('peek').classList.add('hidden')); },
      isOpen: () => !document.getElementById('peek').classList.contains('hidden') },
    { name: 'diff', label: '对比面板', sel: '#diff-panel',
      open: async () => { await page.evaluate(() => document.getElementById('diff-panel').classList.remove('hidden')); },
      close: async () => { await page.evaluate(() => document.getElementById('diff-panel').classList.add('hidden')); },
      isOpen: () => !document.getElementById('diff-panel').classList.contains('hidden') },
  ];

  for (const o of overlays) {
    await o.open();
    await page.waitForTimeout(500);   // 入场动画走完，也避开 VT 150ms 连切保护
    const box = await page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      const x = Math.max(0, Math.round(r.left)), y = Math.max(0, Math.round(r.top));
      return { x, y, width: Math.min(innerWidth - x, Math.round(r.width)), height: Math.min(innerHeight - y, Math.round(r.height)) };
    }, o.sel);
    const shot = async (tag) => {
      const buf = await page.screenshot({ clip: box });
      fs.writeFileSync(path.join(ART, `theme-overlay-${o.name}-${tag}.png`), buf);
      return decode(buf);
    };
    const before = await shot('before');
    // 开始切深色，等快照拍完（ready），把所有过渡动画暂停在 0%
    const groups = await page.evaluate(async () => {
      switchTheme('dark');
      await vtActive.ready;
      const anims = document.getAnimations().filter(a => /view-transition/.test(a.effect && a.effect.pseudoElement || ''));
      anims.forEach(a => { a.pause(); a.currentTime = 0; });
      window.__vtAnims = anims;
      return [...new Set(anims.filter(a => a.effect.pseudoElement.startsWith('::view-transition-group('))
        .map(a => a.effect.pseudoElement))];
    });
    check(`${o.label}：过渡中只有 root 一个分组`, groups.filter(g => g !== '::view-transition-group(root)'), []);
    await page.waitForTimeout(50);
    const f0 = await shot('0');
    await page.evaluate(() => window.__vtAnims.forEach(a => { a.currentTime = a.effect.getComputedTiming().duration / 2; }));
    await page.waitForTimeout(50);
    const f50 = await shot('50');
    await page.evaluate(async () => { window.__vtAnims.forEach(a => a.finish()); await vtActive.finished.catch(() => {}); });
    await page.waitForTimeout(400);
    const after = await shot('after');
    const d0 = meanDiff(f0, before), d50 = meanDiff(f50, avg(before, after)), dTheme = meanDiff(before, after);
    console.log(`      ${o.label}：0% 与切换前差 ${d0.toFixed(2)}；50% 与前后平均差 ${d50.toFixed(2)}；前后主题差 ${dTheme.toFixed(1)}`);
    check(`${o.label}：前后两张确实换了主题（差 > 20）`, dTheme > 20, true);
    check(`${o.label}：0% 帧与切换前一致（差 < 2）`, d0 < 2, true);
    check(`${o.label}：50% 帧 ≈ 前后平均（差 < 4，没被别的分组盖住）`, d50 < 4, true);
    check(`${o.label}：过渡结束后仍打开`, await page.evaluate(o.isOpen), true);
    await page.evaluate(() => switchTheme('light'));
    await page.waitForTimeout(700);
    await o.close();
    await page.waitForTimeout(300);
  }

  check('没有页面错误', errors, []);
  await browser.close();
  await atlas.stop();
  console.log(`\n${total - fail}/${total} 通过`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
