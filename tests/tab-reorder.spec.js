// Tab 拖拽及标签 DOM 复用：真实鼠标、帧不重载、顺序持久化、编辑保护和横向滚动。
const assert = require('assert');
const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');
let total = 0;
function check(name, value, expected = true) { assert.deepStrictEqual(value, expected, name); total++; console.log(`✓ ${name}`); }
async function beginDrag(page, from, to, during, beforeMove) {
  const a = await page.locator(`#tab-bar .tab[data-path$="${from}"]`).boundingBox();
  const b = await page.locator(`#tab-bar .tab[data-path$="${to}"]`).boundingBox();
  const x = a.x + a.width * .35, y = a.y + a.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  if (beforeMove) await beforeMove();
  await page.mouse.move(x + 12, y, { steps: 3 });
  await page.waitForFunction(() => state.tabsDragging === true);
  if (during) await during();
  await page.mouse.move(b.x + b.width * (b.x > a.x ? .85 : .15), y, { steps: 15 });
  await page.waitForTimeout(250); await page.mouse.up();
  await page.waitForFunction(() => !state.tabsDragging);
  await page.waitForTimeout(100);
}
(async () => {
  const extras = {};
  for (let i = 0; i < 12; i++) extras[`p/extra-${i}.html`] = `<h1>Extra ${i}</h1>`;
  const atlas = await startAtlas({ prefix: 'atlas-tab-reorder-', config: { trustAllHtml: true }, files: {
    'p/alpha.html': '<h1>Alpha</h1>' + '<p>长正文</p>'.repeat(150),
    'p/bravo.html': '<h1>Bravo</h1>', 'p/charlie.html': '<h1>Charlie</h1>',
    'p/delta.md': '# Delta\n\n编辑内容。',
    ...extras,
  } });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(atlas.base); await page.waitForSelector('#tree .file');
    for (const name of ['alpha.html', 'bravo.html', 'charlie.html']) {
      await page.locator(`#tree .file[data-path$="${name}"] .file-name`).click();
      await page.waitForFunction(() => !document.querySelector('#preview')?.classList.contains('loading'));
    }
    const names = () => page.locator('#tab-bar .tab-name').allTextContents();
    const active = () => page.locator('#tab-bar .tab.active .tab-name').textContent();
    await page.evaluate(() => {
      window.__tabNodes = [...els.tabBar.querySelectorAll('.tab')];
      window.__frames = state.tabs.map(t => t.frame);
      window.__tabSorter = Sortable.get(els.tabBar);
    });
    await beginDrag(page, 'alpha.html', 'charlie.html', async () => {
      const middle = await page.locator('#tab-bar .tab[data-path$="bravo.html"]').boundingBox();
      await page.mouse.move(middle.x + middle.width / 2, middle.y + middle.height / 2, { steps: 8 });
      await page.waitForTimeout(800);
      check('长拖动期间快速查看不重新弹出', await page.locator('#peek').isVisible(), false);
    }, async () => {
      check('按下 Tab 尚未移动也已进入刷新保护', await page.evaluate(() => state.tabsDragging));
      await page.evaluate(() => render());
    });
    check('向右拖动后顺序更新', await names(), ['bravo.html', 'charlie.html', 'alpha.html']);
    check('拖后台 Tab 不激活它', await active(), 'charlie.html');
    check('拖动不重建标签与帧', await page.evaluate(() => __tabNodes.every(n => n.isConnected) && __frames.every(f => f.isConnected)));
    check('数据顺序与 DOM 一致', await page.evaluate(() => state.tabs.map(t => t.path).join('|') === [...els.tabBar.querySelectorAll('.tab')].map(el => el.dataset.path).join('|')));
    check('顺序已持久化', await page.evaluate(() => JSON.parse(localStorage.getItem('atlas:openTabs')).paths.map(p => p.split('/').pop())), ['bravo.html', 'charlie.html', 'alpha.html']);
    await beginDrag(page, 'alpha.html', 'bravo.html', async () => {
      await page.evaluate(() => { render(); renderTabs(); });
      check('目录刷新不销毁 Tab 拖拽克隆', await page.locator('.tab-sort-fallback').count(), 1);
    });
    check('向左拖动后顺序恢复', await names(), ['alpha.html', 'bravo.html', 'charlie.html']);
    check('拖拽后无残留克隆/状态', await page.evaluate(() => !document.body.classList.contains('tabs-dragging') && !document.querySelector('.tab-sort-fallback')));
    check('标签排序实例不会被渲染重建', await page.evaluate(() => Sortable.get(els.tabBar) === __tabSorter));
    await page.locator('#tab-bar .tab[data-path$="alpha.html"] .tab-name').click();
    await page.evaluate(() => document.getElementById('preview').contentWindow.scrollTo(0, 500));
    const scroll = await page.evaluate(() => document.getElementById('preview').contentWindow.scrollY);
    await beginDrag(page, 'alpha.html', 'charlie.html');
    check('拖活动 Tab 不切走', await active(), 'alpha.html');
    check('拖动保留正文滚动位置', await page.evaluate(() => document.getElementById('preview').contentWindow.scrollY), scroll);
    await page.keyboard.press('Meta+1');
    check('⌘数字按拖拽后的顺序跳转', await active(), 'bravo.html');
    await page.keyboard.press('Control+Tab');
    check('Ctrl+Tab 按新顺序切换', await active(), 'charlie.html');
    const mutations = await page.evaluate(() => {
      const obs = new MutationObserver(() => {}); obs.observe(els.tabBar, { childList: true, subtree: true });
      for (let i = 0; i < 100; i++) renderTabs();
      const rs = obs.takeRecords(); obs.disconnect();
      return rs.reduce((n, r) => n + r.addedNodes.length + r.removedNodes.length, 0);
    });
    check('100 次不变渲染不新增/删除标签节点', mutations, 0);
    await page.reload(); await page.waitForSelector('#tab-bar .tab');
    check('刷新恢复排序', await names(), ['bravo.html', 'charlie.html', 'alpha.html']);
    check('刷新恢复活动文档', await active(), 'charlie.html');
    // 关闭按钮不会启动拖动，关活动 Tab 后切到视觉上的相邻项。
    await page.locator('#tab-bar .tab.active .tab-close').click();
    check('关闭活动项选择新顺序中的邻居', await active(), 'alpha.html');
    check('关闭按钮没有启动排序', await page.evaluate(() => state.tabsDragging), false);
    await page.locator('#tree .file[data-path$="delta.md"] .file-name').click();
    await page.waitForFunction(() => !document.querySelector('#preview')?.classList.contains('loading'));
    await page.locator('#btn-edit').click(); await page.waitForSelector('#md-source:visible');
    await page.locator('#md-source').fill('# Delta\n\n尚未保存的改动');
    const draft = await page.locator('#md-source').inputValue();
    await beginDrag(page, 'delta.md', 'bravo.html');
    check('拖动编辑中的 Tab 不退出编辑', await page.locator('#md-source').isVisible());
    check('拖动保留未保存的文本', await page.locator('#md-source').inputValue(), draft);
    check('拖动不弹丢弃确认框', await page.locator('.atlas-dialog').count(), 0);
    await page.evaluate(() => {
      // 纯前端同步状态模拟：拖动时文件列表更新，落下时仍须保留最新名称。
      const p = state.tabs[0].path; state.files[p].alias = '更新后的别名'; renderTabs();
    });
    check('复用节点仍会更新备注名', await page.locator('#tab-bar .tab-name').first().textContent(), '更新后的别名');
    await page.evaluate(() => exitEditMode({ restore: true }));
    // 几像素抖动仍应是点击，不应抢占标签激活。
    const clickTarget = await page.locator('#tab-bar .tab[data-path$="bravo.html"]').boundingBox();
    await page.mouse.move(clickTarget.x + 35, clickTarget.y + 15); await page.mouse.down();
    await page.mouse.move(clickTarget.x + 37, clickTarget.y + 16); await page.mouse.up();
    check('小幅鼠标抖动仍能点击激活', await active(), 'bravo.html');
    check('小幅抖动不启动排序', await page.evaluate(() => state.tabsDragging), false);
    await page.evaluate(() => {
      for (const p of Object.keys(state.files).filter(p => p.includes('/extra-'))) openInTab(p);
      els.tabBar.scrollLeft = 0;
    });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => els.tabBar.scrollWidth > els.tabBar.clientWidth);
    check('大量标签形成横向滚动条', overflow);
    const first = await page.locator('#tab-bar .tab').first().boundingBox();
    const bar = await page.locator('#tab-bar').boundingBox();
    await page.mouse.move(first.x + 35, first.y + 15); await page.mouse.down();
    await page.mouse.move(first.x + 48, first.y + 15); await page.waitForFunction(() => state.tabsDragging);
    await page.mouse.move(bar.x + bar.width - 8, first.y + 15, { steps: 20 });
    await page.waitForTimeout(700);
    check('拖到右边缘自动横向滚动', await page.evaluate(() => els.tabBar.scrollLeft > 0));
    await page.mouse.up(); await page.waitForFunction(() => !state.tabsDragging);
    check('溢出拖动后标签数量不变', await page.locator('#tab-bar .tab').count(), 15);
    const stoppedAt = await page.evaluate(() => els.tabBar.scrollLeft);
    await page.waitForTimeout(100);
    check('松手后边缘滚动停止', await page.evaluate(() => els.tabBar.scrollLeft), stoppedAt);
    check('溢出拖动后数据和 DOM 顺序一致', await page.evaluate(() => state.tabs.map(t => t.id).join('|') === [...els.tabBar.querySelectorAll('.tab')].map(el => el.dataset.tabId).join('|')));
    check('减少动效时标签排序动画关闭', await page.evaluate(() => Sortable.get(els.tabBar).option('animation')), 0);
    check('无未捕获脚本异常', errors, []);
    console.log(`\n通过 ${total} 项，失败 0 项。`);
  } finally { await browser.close(); await atlas.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
