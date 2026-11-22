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
// 不能只测 reduced-motion 下的最终顺序：逐帧验证正常动效中的让位与快速反转。
async function testAnimatedDrag(browser, atlas) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(atlas.base); await page.waitForSelector('#tree .file');
  await page.evaluate(() => {
    for (const name of ['alpha.html', 'bravo.html', 'charlie.html', 'delta.md', 'extra-0.html']) {
      openInTab(Object.keys(state.files).find(p => p.endsWith('/' + name)));
    }
    // 不等宽标签同样要稳定，不能假设所有标签的跨度相同。
    const widths = [110, 170, 140, 210, 130];
    [...els.tabBar.querySelectorAll('.tab')].forEach((el, i) => { el.style.flex = `0 0 ${widths[i]}px`; });
    window.__animationNodes = [...els.tabBar.querySelectorAll('.tab')];
    window.__animationFrames = state.tabs.map(t => t.frame);
    window.__animationStyles = __animationNodes.map(n => n.getAttribute('style'));
    window.__dragMutations = 0;
    window.__dragObserver = new MutationObserver(records => { __dragMutations += records.length; });
    __dragObserver.observe(els.tabBar, { childList: true });
  });
  const boxes = await page.locator('#tab-bar .tab').evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  const a = boxes[0], x = a.x + a.width / 2, y = a.y + a.height / 2;
  const center = i => boxes[i].x + boxes[i].width / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(center(1) - 8, y);
  check('未越过相邻标签中心时不提前换位', await page.evaluate(() => tabDrag.target), 0);
  check('被拖真实标签没有浮动副本', await page.locator('.tab-sort-fallback, .sortable-fallback').count(), 0);
  const surfaces = await page.evaluate(() => {
    const source = tabDrag.el, root = document.documentElement;
    const theme = root.getAttribute('data-theme'), wasActive = source.classList.contains('active');
    const results = [];
    for (const active of [false, true]) {
      source.classList.toggle('active', active);
      for (const theme of ['light', 'dark']) {
        root.setAttribute('data-theme', theme);
        const color = getComputedStyle(source).backgroundColor;
        // Canvas 读取实际 RGBA，不依赖 rgb()/color() 的浏览器序列化形式。
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
        results.push({ theme, active, alpha: ctx.getImageData(0, 0, 1, 1).data[3], hover: source.matches(':hover') });
      }
    }
    source.classList.toggle('active', wasActive);
    if (theme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    return results;
  });
  for (const surface of surfaces) {
    check(`${surface.theme} ${surface.active ? '活动' : '后台'}标签拖动悬停时底色完全不透明`, surface.hover && surface.alpha === 255);
  }
  const delta = center(1) + 8 - x;
  // 先安装逐帧采样再越过中心，包含动画刚开始与中间阶段。
  await page.evaluate(() => {
    window.__shiftSamples = [];
    window.__sampleShift = () => {
      __shiftSamples.push(__animationNodes[1].getBoundingClientRect().x);
      if (__shiftSamples.length < 14) requestAnimationFrame(__sampleShift);
    };
    requestAnimationFrame(__sampleShift);
  });
  await page.mouse.move(x + delta, y + 11);
  check('越过中心后仅目标插槽更新', await page.evaluate(() => tabDrag.target), 1);
  const dragBox = await page.locator('#tab-bar .tab-drag-source').boundingBox();
  check('被拖标签水平跟手无滞后', Math.abs(dragBox.x - (a.x + delta)) < 1);
  check('被拖标签不随鼠标上下漂移', Math.abs(dragBox.y - a.y) < 1);
  await page.waitForTimeout(260);
  const samples = await page.evaluate(() => __shiftSamples);
  const targetX = boxes[0].x;
  check('邻居让位包含中间帧而非瞬间跳位', samples.some(v => v < boxes[1].x - 1 && v > targetX + 1));
  check('邻居让位单调且不越过目标插槽', samples.every((v, i) => v >= targetX - .6 && v <= boxes[1].x + .6 && (!i || v <= samples[i - 1] + .6)));
  // 动画未结束就跨多个标签，再立即反向；命中只依赖稳定插槽，不能依赖过渡 rect。
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(center(3) + 12, y);
    check(`快速跨多个插槽第 ${i + 1} 次落点正确`, await page.evaluate(() => tabDrag.target), 3);
    await page.mouse.move(center(1) - 12, y);
    check(`动画中反转第 ${i + 1} 次不会乱序`, await page.evaluate(() => tabDrag.target), 0);
  }
  await page.waitForTimeout(260);
  check('停住鼠标后落点不自发反复变化', await page.evaluate(() => tabDrag.target), 0);
  check('回到原插槽后所有邻居回原位', await page.evaluate(() => __animationNodes.every(n => Math.abs(new DOMMatrix(getComputedStyle(n).transform).m41) < .6 || n === tabDrag.el)));
  check('拖动过程没有重排任何真实 DOM 节点', await page.evaluate(() => __dragMutations + __dragObserver.takeRecords().length), 0);
  await page.mouse.move(center(4) + 15, y);
  await page.mouse.up();
  check('正常动效松手后进入吸附而非直接跳位', await page.evaluate(() => state.tabsDragging && tabDrag.settling));
  await page.waitForFunction(() => !state.tabsDragging);
  const indicatorSamples = await page.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 16; i++) {
      await new Promise(requestAnimationFrame);
      const active = els.tabBar.querySelector('.tab.active').getBoundingClientRect();
      const indicator = els.tabIndicator.getBoundingClientRect();
      samples.push({ gap: Math.abs(indicator.x - active.x), widthGap: Math.abs(indicator.width - active.width),
        visible: getComputedStyle(els.tabIndicator).visibility === 'visible' });
    }
    return samples;
  });
  check('落位后活动底色始终贴住标签，不从旧位置左右闪动', indicatorSamples.every(s => s.visible && s.gap < .6 && s.widthGap < 1));
  const settledSamples = await page.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 12; i++) {
      await new Promise(requestAnimationFrame);
      samples.push(__animationNodes.map(n => ({ x: n.getBoundingClientRect().x,
        expectedX: els.tabBar.getBoundingClientRect().x + n.offsetLeft - els.tabBar.scrollLeft })));
    }
    return samples;
  });
  check('吸附完成后所有标签停在新插槽，不再二次滑动或越位', settledSamples.every(frame => frame.every((r, i) => Math.abs(r.x - settledSamples[0][i].x) < .6 && Math.abs(r.x - r.expectedX) < .6)));
  check('不等宽标签松手后正确提交顺序', await page.locator('#tab-bar .tab-name').allTextContents(), ['bravo.html', 'charlie.html', 'delta.md', 'extra-0.html', 'alpha.html']);
  check('落位不销毁标签或重载正文帧', await page.evaluate(() => __animationNodes.every(n => n.isConnected) && __animationFrames.every(f => f.isConnected)));
  check('落位后清除拖动态且保留原始样式', await page.evaluate(() => __animationNodes.every((n, i) => n.getAttribute('style') === __animationStyles[i]) && !document.querySelector('.tab-drag-source')));
  await page.evaluate(() => __dragObserver.disconnect());
  // 直接拖活动标签也要验证交接：实底消失的第一帧，指示层就在其新位置。
  const selectedBox = await page.locator('#tab-bar .tab.active').boundingBox();
  await page.mouse.move(selectedBox.x + 35, y); await page.mouse.down();
  await page.mouse.move(boxes[0].x + 15, y, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => !state.tabsDragging);
  const activeBackgroundAligned = await page.evaluate(async () => {
    for (let i = 0; i < 16; i++) {
      await new Promise(requestAnimationFrame);
      const active = els.tabBar.querySelector('.tab.active').getBoundingClientRect();
      const bg = els.tabIndicator.getBoundingClientRect();
      if (Math.abs(bg.x - active.x) > .6 || Math.abs(bg.width - active.width) > 1) return false;
    }
    return true;
  });
  check('直接拖动活动标签后，选中底色原位交接不闪动', activeBackgroundAligned);
  const savedOrder = await page.evaluate(() => state.tabs.map(t => t.id));
  const savedActive = await page.evaluate(() => state.activeTabId);
  const beforeCancel = await page.locator('#tab-bar .tab').first().boundingBox();
  await page.mouse.move(beforeCancel.x + 35, y); await page.mouse.down();
  await page.mouse.move(center(3), y);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForFunction(() => !state.tabsDragging);
  check('Esc 只取消拖动，不回首页或切换文档', await page.evaluate(() => state.activeTabId), savedActive);
  check('Esc 取消恢复原始顺序', await page.evaluate(() => state.tabs.map(t => t.id)), savedOrder);
  check('取消后没有残留位移或拖动状态', await page.evaluate(() => !tabDrag && !document.body.classList.contains('tabs-dragging') && __animationNodes.every((n, i) => n.getAttribute('style') === __animationStyles[i])));
  // pointercancel（触摸被系统接管等）和窗口失焦都必须完整回滚。
  for (const reason of ['pointercancel', 'blur']) {
    await page.mouse.move(beforeCancel.x + 35, y); await page.mouse.down();
    await page.mouse.move(center(2), y);
    await page.evaluate(reason => {
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: tabDrag.pointerId }));
    }, reason);
    await page.mouse.up(); await page.waitForFunction(() => !state.tabsDragging);
    check(`${reason} 中断后完整恢复`, await page.evaluate(() => !tabDrag && state.tabs.map(t => t.id)), savedOrder);
  }
  check('正常动效无未捕获异常', errors, []);
  await page.close();
}
// 自查矩阵：不是只验证某一次反馈，而是每种环境走完整的拖动生命周期。
async function testDragMatrix(browser, atlas) {
  for (const config of [
    { name: '浅色正常动效', theme: 'light', width: 1440, motion: 'no-preference' },
    { name: '深色正常动效', theme: 'dark', width: 1440, motion: 'no-preference' },
    { name: '窄窗口正常动效', theme: 'light', width: 820, motion: 'no-preference' },
    { name: '窄窗口减少动效', theme: 'dark', width: 820, motion: 'reduce' },
  ]) {
    const page = await browser.newPage({ viewport: { width: config.width, height: 900 }, reducedMotion: config.motion });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(atlas.base); await page.waitForSelector('#tree .file');
      await page.evaluate(theme => {
        document.documentElement.setAttribute('data-theme', theme);
        for (const name of ['alpha.html', 'bravo.html', 'charlie.html', 'delta.md']) {
          openInTab(Object.keys(state.files).find(p => p.endsWith('/' + name)));
        }
        els.tabBar.scrollLeft = 0;
      }, config.theme);
      await page.waitForTimeout(350);
      // 从按下前到松手后一段时间都取帧，避免漏掉交接的第一帧。
      await page.evaluate(() => {
        window.__auditRunning = true; window.__auditViolations = []; window.__auditFrames = 0;
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        const sample = () => {
          if (!__auditRunning) return;
          const d = tabDrag;
          if (d?.started) {
            __auditFrames++;
            const style = getComputedStyle(d.el);
            ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = style.backgroundColor; ctx.fillRect(0, 0, 1, 1);
            if (ctx.getImageData(0, 0, 1, 1).data[3] !== 255) __auditViolations.push('拖动态透字');
            if (d.slots.some(s => Math.abs(s.el.getBoundingClientRect().width - s.width) > .6)) __auditViolations.push('拖动中标签宽度变化');
            if (getComputedStyle(els.tabIndicator).visibility !== 'hidden') __auditViolations.push('拖动中双背景');
          } else if (!state.tabsDragging && els.tabBar.querySelector('.tab.active')) {
            const r = els.tabBar.querySelector('.tab.active').getBoundingClientRect();
            const b = els.tabIndicator.getBoundingClientRect();
            if (Math.abs(r.x - b.x) > .6 || Math.abs(r.width - b.width) > 1) __auditViolations.push('交接后底色错位');
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const start = async index => {
        const r = await page.locator('#tab-bar .tab').nth(index).boundingBox();
        await page.mouse.move(r.x + r.width * .35, r.y + r.height / 2); await page.mouse.down();
        await page.mouse.move(r.x + r.width * .35 + 12, r.y + r.height / 2);
        return r;
      };
      const finish = async () => { await page.mouse.up(); await page.waitForFunction(() => !state.tabsDragging); await page.waitForTimeout(260); };
      const original = await page.evaluate(() => state.tabs.map(t => t.id));
      const active = await page.evaluate(() => state.activeTabId);
      const last = await page.locator('#tab-bar .tab').last().boundingBox();
      const r = await start(0);
      await page.mouse.move(last.x + last.width * .9, r.y + r.height / 2, { steps: 14 });
      await page.waitForTimeout(200);
      if (config.motion === 'no-preference') await page.locator('#tab-bar').screenshot({ path: `/tmp/atlas-tab-audit-${config.theme}-${config.width}.png` });
      await finish();
      check(`${config.name}：后台标签右拖不切换文档`, await page.evaluate(() => state.activeTabId), active);
      check(`${config.name}：右拖后身份顺序正确`, await page.evaluate(() => state.tabs.map(t => t.id)), [...original.slice(1), original[0]]);
      const back = await start(3);
      await page.mouse.move(r.x + 5, back.y + back.height / 2, { steps: 12 }); await finish();
      check(`${config.name}：左拖返回原顺序`, await page.evaluate(() => state.tabs.map(t => t.id)), original);
      // 栏外松手也必须通过捕获完整收尾，不留实底/计时器/全局拖动态。
      const outside = await start(0);
      await page.mouse.move(last.x, outside.y + 130, { steps: 10 }); await finish();
      check(`${config.name}：栏外松手无残留`, await page.evaluate(() => !tabDrag && !tabScrollRaf && !document.body.classList.contains('tabs-dragging') && !document.querySelector('.tab-drag-source')));
      // 下一次正常点击必须能激活，且原有的点击切换动画不能被永久关掉。
      await page.evaluate(() => { __auditRunning = false; });
      await page.locator('#tab-bar .tab').first().click();
      await page.waitForFunction(() => state.activeTabId === els.tabBar.querySelector('.tab').dataset.tabId);
      check(`${config.name}：拖完可立即正常点击标签`, await page.evaluate(() => state.activeTabId === els.tabBar.querySelector('.tab').dataset.tabId));
      check(`${config.name}：逐帧无透明底、宽度跳变或背景闪动`, await page.evaluate(() => [...new Set(__auditViolations)]), []);
      check(`${config.name}：确实采样了拖动过程`, await page.evaluate(() => __auditFrames > 0));
      // 后台更新与几何变化不能导致丢标签或让拖动卡住。
      await start(0);
      await page.evaluate(() => {
        const newPath = Object.keys(state.files).find(p => p.endsWith('/extra-0.html'));
        openInTab(newPath);
        state.files[state.tabs[1].path].alias = '拖动中更新名称';
        removeTab(2); render(); renderTabs();
      });
      await finish();
      check(`${config.name}：拖动中开关标签/刷新后模型与 DOM 一致`, await page.evaluate(() => state.tabs.map(t => t.id).join('|') === [...els.tabBar.querySelectorAll('.tab')].map(n => n.dataset.tabId).join('|') && state.tabs.length === 4));
      const beforeResize = await page.evaluate(() => state.tabs.map(t => t.id));
      await start(0); await page.setViewportSize({ width: config.width + 80, height: 900 }); await finish();
      check(`${config.name}：窗口变化取消拖动且恢复顺序`, await page.evaluate(() => state.tabs.map(t => t.id)), beforeResize);
      await start(0);
      await page.evaluate(() => toggleSidebar());
      await page.waitForTimeout(600);
      check(`${config.name}：侧栏改变标签栏几何时取消拖动，避免沿旧插槽落位`, await page.evaluate(() => !tabDrag && !state.tabsDragging));
      await page.mouse.up();
      await page.evaluate(() => toggleSidebar(false));
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        for (const p of Object.keys(state.files).filter(p => p.includes('/extra-'))) openInTab(p);
        els.tabBar.scrollLeft = 0;
      });
      const barBox = await page.locator('#tab-bar').boundingBox();
      const edge = await start(0), edgeY = edge.y + edge.height / 2;
      await page.mouse.move(barBox.x + barBox.width - 8, edgeY, { steps: 10 });
      const initialSlot = await page.evaluate(() => tabDrag.target);
      await page.waitForTimeout(600);
      check(`${config.name}：右边缘停住鼠标仍滚动并推进插槽`, await page.evaluate(initial => els.tabBar.scrollLeft > 0 && tabDrag.target > initial, initialSlot));
      const rightScroll = await page.evaluate(() => els.tabBar.scrollLeft);
      await page.mouse.move(barBox.x + 8, edgeY, { steps: 10 }); await page.waitForTimeout(700);
      check(`${config.name}：反向到左边缘能滚回，不继续向右`, await page.evaluate(right => els.tabBar.scrollLeft < right, rightScroll));
      await finish();
      const endScroll = await page.evaluate(() => els.tabBar.scrollLeft);
      await page.waitForTimeout(120);
      check(`${config.name}：双向滚动松手后停止且底色对齐`, await page.evaluate(scroll => {
        const active = els.tabBar.querySelector('.tab.active').getBoundingClientRect();
        return !tabDrag && !tabScrollRaf && els.tabBar.scrollLeft === scroll && Math.abs(els.tabIndicator.getBoundingClientRect().x - active.x) < .6;
      }, endScroll));
      await page.evaluate(() => { els.tabBar.scrollLeft = 0; });
      const beforeCapture = await page.evaluate(() => state.tabs.map(t => t.id));
      await start(0);
      await page.evaluate(() => tabDrag.el.releasePointerCapture(tabDrag.pointerId));
      await finish();
      check(`${config.name}：意外丢失指针捕获能恢复且不卡住`, await page.evaluate(() => !tabDrag && state.tabs.map(t => t.id)), beforeCapture);
      check(`${config.name}：无未捕获异常`, errors, []);
    } finally { await page.close(); }
  }
}
async function testTouchDrag(browser, atlas) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true, reducedMotion: 'no-preference' });
  try {
    await page.goto(atlas.base); await page.waitForSelector('#tree .file');
    await page.evaluate(() => {
      for (const name of ['alpha.html', 'bravo.html', 'charlie.html']) openInTab(Object.keys(state.files).find(p => p.endsWith('/' + name)));
    });
    await page.waitForTimeout(350);
    const original = await page.evaluate(() => state.tabs.map(t => t.id));
    const active = await page.evaluate(() => state.activeTabId);
    const a = await page.locator('#tab-bar .tab').first().boundingBox();
    const b = await page.locator('#tab-bar .tab').last().boundingBox();
    const session = await page.context().newCDPSession(page);
    const touch = (type, x, y) => session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const x = a.x + a.width * .35, y = a.y + a.height / 2;
    await touch('touchStart', x, y); await touch('touchEnd');
    await page.waitForFunction(() => !state.tabsDragging);
    await page.waitForTimeout(350);
    check('触摸轻点只激活、不排序、无残留', await page.evaluate(() => !tabDrag && state.tabs.map(t => t.id)), original);
    check('触摸轻点能正常激活标签', await page.evaluate(() => state.activeTabId), original[0]);
    await touch('touchStart', x, y); await touch('touchMove', x + 20, y); await touch('touchEnd');
    await page.waitForFunction(() => !state.tabsDragging);
    check('长按阈值前滑动不会误启动排序', await page.evaluate(() => !tabDrag && state.tabs.map(t => t.id)), original);
    await touch('touchStart', x, y); await page.waitForTimeout(200);
    await touch('touchMove', x + 20, y);
    await page.waitForFunction(() => tabDrag?.started);
    await touch('touchMove', b.x + b.width * .9, y);
    await page.waitForFunction(() => tabDrag?.target === 2);
    check('真实触摸长按后可拖到目标插槽', await page.evaluate(() => tabDrag.target), 2);
    await touch('touchEnd'); await page.waitForFunction(() => !state.tabsDragging);
    check('触摸拖动提交正确顺序且不误切文档', await page.evaluate(() => [state.tabs.map(t => t.id), state.activeTabId]), [[original[1], active, original[0]], original[0]]);
    await session.detach();
  } finally { await page.close(); }
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
    await testAnimatedDrag(browser, atlas);
    await testDragMatrix(browser, atlas);
    await testTouchDrag(browser, atlas);
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
      window.__tabDragBar = els.tabBar;
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
      check('目录刷新不移除正在拖动的真实标签', await page.locator('#tab-bar .tab-drag-source').count(), 1);
    });
    check('向左拖动后顺序恢复', await names(), ['alpha.html', 'bravo.html', 'charlie.html']);
    check('拖拽后无残留克隆/状态', await page.evaluate(() => !document.body.classList.contains('tabs-dragging') && !document.querySelector('.tab-sort-fallback')));
    check('标签拖动不再使用通用 Sortable', await page.evaluate(() => !Sortable.get(els.tabBar) && els.tabBar === __tabDragBar));
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
    check('减少动效时拖动已即时收尾', await page.evaluate(() => tabDrag === null));
    check('无未捕获脚本异常', errors, []);
    console.log(`\n通过 ${total} 项，失败 0 项。`);
  } finally { await browser.close(); await atlas.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
