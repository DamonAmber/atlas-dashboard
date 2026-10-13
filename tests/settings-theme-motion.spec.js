// 设置弹窗固定高度 / 主题切换过渡 / 侧栏收起展开逐帧连续（桌面实机验收 client-fix §2 §6 §7）
//
// §7 设置弹窗：5 个分区（以及扫描分区里目录选择器展开时）面板的 top 与高度完全相同 = min(640, 视口 − 96)，
//    内容区内部滚动；诊断清单里的全部选项 id 都还在；鼠标打开时自动聚焦的关闭按钮不画焦点环；
//    面板实底（不再是 94% 玻璃）。
// §6 主题切换：__atlasForceVT 下点「深色」→ 同步出现 data-vt="theme" 与 html.theme-switching，
//    过渡结束后两者都撤掉、data-theme 落定；切换期间所有元素的 transition 被关掉（不会二次跳变）；
//    迷你星图只重画一次；reduced-motion 下不走 View Transition、同步硬切；样式表里没有 transition: all。
// §2 侧栏：收起 / 展开期间主区内容逐帧连续——居中内容单调走完 W/2、没有单帧跳完，右对齐按钮全程不动、
//    不出窗口（client-fix review #1：只排一次 + transform 平移会在首尾帧横跳）；首页迷你星图在一次
//    收起 + 展开里最多重画 2 次（动画期间不画），画布 object-fit: cover；reduced-motion 下硬切。
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
const FILES = {};
for (let p = 0; p < 6; p++) for (let i = 0; i < 8; i++) FILES[`proj-${p}/doc-${i}.md`] = `# 文档 ${p}-${i}\n\n正文\n`;

// 诊断 §7 的现有选项清单：重做样式后一项都不能少
const OPTION_IDS = ['root-list', 'root-input', 'root-browse-btn', 'root-add-btn', 'dir-picker', 'dir-up', 'dir-home',
  'dir-current', 'dir-list', 'dir-cancel', 'dir-select', 'ignore-input', 'ignore-save-btn', 'thumbs-status', 'peek-net-note',
  'notify-toggle', 'notify-hint', 'trust-all-toggle', 'trust-all-hint', 'trust-clear-btn', 'share-list', 'share-stop-all-btn',
  'archive-list', 'settings-version', 'settings-changelog-btn', 'settings-update', 'settings-update-btn', 'settings-update-status'];

(async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  check('样式表里没有 transition: all / transition-property: all', /transition(-property)?\s*:\s*all\b/.test(css), false);

  const atlas = await startAtlas({ prefix: 'atlas-settings-theme-', files: FILES });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(atlas.base, { waitUntil: 'load' });
  await page.waitForSelector('#tree .file');
  await page.waitForFunction(() => window.__atlasMinimapRenders >= 1, null, { timeout: 5000 }).catch(() => {});

  // ---------- §7 设置弹窗 ----------
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal:not(.hidden)');
  await page.waitForTimeout(200);
  const geo = () => page.evaluate(() => {
    const r = document.querySelector('.settings-panel').getBoundingClientRect();
    return [Math.round(r.top), Math.round(r.height)];
  });
  const panes = await page.evaluate(() => [...document.querySelectorAll('.settings-nav-item')].map(b => b.dataset.goto));
  const geos = {};
  for (const p of panes) {
    await page.click(`.settings-nav-item[data-goto="${p}"]`);
    await page.waitForTimeout(80);
    geos[p] = await geo();
  }
  // 扫描分区里展开目录选择器（只切 class，不真去浏览本机目录）：内容变高，面板不变
  await page.click('.settings-nav-item[data-goto="scan"]');
  await page.evaluate(() => document.getElementById('dir-picker').classList.remove('hidden'));
  await page.waitForTimeout(80);
  geos['scan+目录选择器'] = await geo();
  const scroll = await page.evaluate(() => { const c = document.getElementById('settings-content'); return c.scrollHeight > c.clientHeight && getComputedStyle(c).overflowY === 'auto'; });
  await page.evaluate(() => document.getElementById('dir-picker').classList.add('hidden'));
  const vals = Object.values(geos).map(g => g.join(','));
  console.log('      ' + JSON.stringify(geos));
  check(`切换 ${Object.keys(geos).length} 种内容，面板 top 与高度完全相同`, new Set(vals).size, 1);
  check('面板高度 = min(640, 视口 860 − 96)', geos.scan[1], Math.min(640, 860 - 96));
  check('内容超出时在内容区内部滚动', scroll, true);
  const missing = await page.evaluate((ids) => ids.filter(id => !document.getElementById(id)), OPTION_IDS);
  check('选项 id 一个不少（' + OPTION_IDS.length + ' 个）', missing, []);
  const groups = await page.evaluate(() => ({
    theme: document.querySelectorAll('[data-theme-pick]').length, skin: document.querySelectorAll('[data-skin-pick]').length,
    motion: document.querySelectorAll('[data-motion-pick]').length, peek: document.querySelectorAll('[data-peek-pick]').length,
    doctype: document.querySelectorAll('input[name="doctype"]').length,
  }));
  check('主题 3 / 色调 2 / 动效 2 / 悬停预览 2 / 文档类型 6', groups, { theme: 3, skin: 2, motion: 2, peek: 2, doctype: 6 });
  const look = await page.evaluate(() => {
    const p = document.querySelector('.settings-panel'); const c = p.querySelector('.modal-close');
    return { bg: getComputedStyle(p).backgroundColor, closeShadow: getComputedStyle(c).boxShadow, closeFocused: document.activeElement === c };
  });
  check('面板实底（alpha = 1）', !/\/\s*0?\.\d+\)$|,\s*0?\.\d+\)$/.test(look.bg), true);
  check('鼠标打开时关闭按钮即使获得焦点也不画焦点环', look.closeShadow === 'none' || !look.closeFocused, true);
  check('浏览器版不显示「侧栏透明度」（桌面专属）', await page.evaluate(() => getComputedStyle(document.getElementById('transparency-section')).display), 'none');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ---------- §6 主题切换 ----------
  await page.evaluate(() => { window.__atlasForceVT = true; });
  await page.click('#btn-settings');
  await page.click('.settings-nav-item[data-goto="appearance"]');
  await page.waitForTimeout(400);   // 避开 View Transition 的 150ms 连切保护
  const before = await page.evaluate(() => window.__atlasMinimapRenders);
  const t0 = await page.evaluate(() => {
    const root = document.documentElement;
    const seen = { vt: new Set(), switching: false, tx: null };
    new MutationObserver(() => {
      if (root.dataset.vt) seen.vt.add(root.dataset.vt);
      if (root.classList.contains('theme-switching')) {
        seen.switching = true;
        if (seen.tx === null) seen.tx = getComputedStyle(document.querySelector('.file')).transitionDuration;
      }
    }).observe(root, { attributes: true });
    window.__seen = seen;
    document.querySelector('[data-theme-pick="dark"]').click();
    return { vt: root.dataset.vt || null, switching: root.classList.contains('theme-switching') };
  });
  check('点「深色」：同步出现 data-vt="theme" 与 html.theme-switching', t0, { vt: 'theme', switching: true });
  await page.waitForTimeout(700);
  const t1 = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme, vt: document.documentElement.dataset.vt || null,
    switching: document.documentElement.classList.contains('theme-switching'),
    tx: window.__seen.tx,
    aria: document.querySelector('[data-theme-pick="dark"]').getAttribute('aria-checked'),
  }));
  check('过渡结束：data-theme=dark、data-vt 与 theme-switching 都撤掉、按钮选中', [t1.theme, t1.vt, t1.switching, t1.aria], ['dark', null, false, 'true']);
  check('切换期间文件行的 transition 被关掉（0s）', t1.tx, '0s');
  const after = await page.evaluate(() => window.__atlasMinimapRenders);
  console.log(`      （迷你星图重画 ${after - before} 次）`);
  check('切一次主题迷你星图只重画 ≤ 1 次', after - before <= 1, true);
  // 冷 / 暖色调同样走交叉淡入
  await page.waitForTimeout(300);
  const sk = await page.evaluate(() => { document.querySelector('[data-skin-pick="warm"]').click(); return document.documentElement.dataset.vt || null; });
  check('切「暖灰」同样走 data-vt="theme" 交叉淡入', sk, 'theme');
  await page.waitForTimeout(700);
  check('暖灰落定', await page.evaluate(() => document.documentElement.dataset.skin), 'warm');
  // reduced-motion：不走 View Transition，同步硬切
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  const rm = await page.evaluate(async () => {
    window.__seen.vt.clear();
    document.querySelector('[data-theme-pick="light"]').click();
    const sync = document.documentElement.dataset.theme;
    await new Promise(r => setTimeout(r, 400));
    return { sync, vts: [...window.__seen.vt], switching: document.documentElement.classList.contains('theme-switching') };
  });
  check('reduced-motion：点击后同步就是 light、从未出现 data-vt、theme-switching 已撤', rm, { sync: 'light', vts: [], switching: false });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { document.querySelector('[data-theme-pick="system"]').click(); document.querySelector('[data-skin-pick="cool"]').click(); });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  // ---------- §2 侧栏收起 / 展开 ----------
  // 逐帧记三个锚点的屏幕 x：L = 顶栏左侧第一项左缘，C = 首页河流卡片中心（居中内容），
  // R = .main-actions 右缘（右对齐）。"横跳"的特征是某一帧的位移接近整段位移（只排一次 + 平移的方案里
  // C 在收起首帧 / 展开末帧一步跳满 W/2，R 先滑出窗口再弹回，client-fix review #1）。
  const sample = () => page.evaluate(async () => {
    const main = document.querySelector('.main');
    const pick = () => {
      const x = (s, f) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return f(b); };
      return { L: x('.main-header > *', b => b.left), C: x('#home-river-card', b => b.left + b.width / 2), R: x('.main-actions', b => b.right),
        tf: getComputedStyle(main).transform, ml: getComputedStyle(main).marginLeft };
    };
    const one = async () => {
      const seq = [pick()]; let on = true;
      const tick = () => { if (!on) return; seq.push(pick()); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      document.getElementById('btn-toggle-sidebar').click();
      await new Promise(r => setTimeout(r, 450));
      on = false; seq.push(pick());
      const res = { frames: seq.length, ml: [...new Set(seq.map(s => s.ml))].length, tf: seq.some(s => s.tf !== 'none'),
        rOut: seq.filter(s => s.R > innerWidth + 1).length };
      for (const k of ['L', 'C', 'R']) {
        const v = seq.map(s => s[k]); const total = v[v.length - 1] - v[0]; const dir = Math.sign(Math.round(total));
        let maxStep = 0, rev = 0, maxDev = 0;
        for (let i = 1; i < v.length; i++) {
          const d = v[i] - v[i - 1]; maxStep = Math.max(maxStep, Math.abs(d));
          if (Math.abs(d) > 0.5 && (dir === 0 || Math.sign(d) === -dir)) rev++;
          maxDev = Math.max(maxDev, Math.abs(v[i] - v[0]));
        }
        res[k] = { total: Math.round(total), maxStep: Math.round(maxStep), rev, maxDev: Math.round(maxDev) };
      }
      return res;
    };
    const renders0 = window.__atlasMinimapRenders;
    const collapse = await one();
    await new Promise(r => setTimeout(r, 300));
    const expand = await one();
    await new Promise(r => setTimeout(r, 400));
    return { collapse, expand, renders: window.__atlasMinimapRenders - renders0, W: document.querySelector('.sidebar').offsetWidth,
      endTf: getComputedStyle(main).transform, collapsed: document.body.classList.contains('sidebar-collapsed') };
  });
  const m = await sample();
  console.log('      ' + JSON.stringify(m));
  for (const dir of ['collapse', 'expand']) {
    const d = m[dir], zh = dir === 'collapse' ? '收起' : '展开';
    check(`${zh}：居中内容走满 ±W/2、单调（没有方向反转）`, [Math.abs(Math.abs(d.C.total) - m.W / 2) < 8, d.C.rev], [true, 0]);
    check(`${zh}：居中内容没有一步跳完（单帧位移 < 整段的 60%）`, d.C.maxStep < Math.abs(d.C.total) * 0.6, true);
    check(`${zh}：左对齐内容单调`, d.L.rev, 0);
    check(`${zh}：右对齐按钮全程不动、不出窗口`, [d.R.maxDev <= 1, d.rOut], [true, 0]);
    check(`${zh}：主区不靠 transform 平移、margin-left 逐帧过渡（出现多个中间值）`, [d.tf, d.ml > 3], [false, true]);
  }
  check('动画结束后 transform 为 none、回到展开态', [m.endTf, m.collapsed], ['none', false]);
  check('一次收起 + 展开，迷你星图最多重画 2 次（尺寸稳定后各一次，动画期间不画）', m.renders <= 2, true);
  const canvasFit = await page.evaluate(() => { const c = document.querySelector('.home-minimap canvas'); return c ? getComputedStyle(c).objectFit : null; });
  check('迷你星图画布 object-fit: cover（重画被推迟时等比缩放、不拉伸）', canvasFit, 'cover');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const r2 = await sample();
  check('reduced-motion：硬切（margin-left 只有首尾两种取值、不平移）',
    [r2.collapse.ml <= 2, r2.expand.ml <= 2, r2.collapse.tf, r2.expand.tf], [true, true, false, false]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  check('全程无页面错误', errors, []);
  await browser.close();
  await atlas.stop();
  console.log(`\n总计 ${total} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
