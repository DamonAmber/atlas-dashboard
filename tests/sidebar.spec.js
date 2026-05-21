const { chromium } = require('playwright');

// 现在 sidebar 是 fixed + transform 实现，要看"在视口中的位置"而不是 width
function snap() {
  const sb = document.querySelector('.sidebar');
  const main = document.querySelector('.main');
  const rz = document.querySelector('.resizer');
  return {
    collapsed: document.body.classList.contains('sidebar-collapsed'),
    sidebarLeft: sb.getBoundingClientRect().left,    // 收起后应 ≤ -200
    sidebarW: sb.getBoundingClientRect().width,       // 始终 320（fixed width）
    mainLeft: main.getBoundingClientRect().left,      // 展开 = sidebar+resizer，收起 = 0
    resizerOpacity: parseFloat(getComputedStyle(rz).opacity),
    storage: localStorage.getItem('atlas:sidebarCollapsed'),
  };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.file');

  let r = await page.evaluate(snap);
  console.log('初始展开:', r);
  if (r.collapsed || r.sidebarLeft !== 0 || r.mainLeft < 200) {
    console.error('✗ 初始状态不对'); process.exit(1);
  }

  await page.locator('#btn-toggle-sidebar').click();
  await page.waitForTimeout(300);
  r = await page.evaluate(snap);
  console.log('点击后(收起):', r);
  if (!r.collapsed || r.sidebarLeft > -200 || r.mainLeft !== 0 || r.resizerOpacity > 0.01 || r.storage !== '1') {
    console.error('✗ 收起失败'); process.exit(1);
  }

  // Cmd+B 展开
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(300);
  r = await page.evaluate(snap);
  console.log('Cmd+B 展开:', r);
  if (r.collapsed || r.sidebarLeft !== 0 || r.mainLeft < 200 || r.storage !== '0') {
    console.error('✗ 展开失败'); process.exit(1);
  }

  // 收起后刷新 → 仍然是收起状态，且首次加载即是收起姿态（无动画）
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.file');
  r = await page.evaluate(snap);
  console.log('刷新后(应保持收起，首次即为收起姿态):', r);
  if (!r.collapsed || r.sidebarLeft > -200 || r.mainLeft !== 0) {
    console.error('✗ 持久化失败 - 应该刷新后立刻是收起姿态');
    process.exit(1);
  }

  // 恢复展开
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(300);

  // 验证：动画期间 iframe 没有被任何 inline 样式锁住（让用户随时能操作）
  await page.locator('.file').first().click();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    window.__inlineSamples = [];
    window.__obs = new MutationObserver(() => {
      window.__inlineSamples.push({
        w: ifr.style.width,
        mw: ifr.style.minWidth,
        flex: ifr.style.flex,
        pe: getComputedStyle(ifr).pointerEvents,
      });
    });
    window.__obs.observe(ifr, { attributes: true, attributeFilter: ['style'] });
  });
  await page.locator('#btn-toggle-sidebar').click();
  // 中间快速采样 pointer-events 状态
  const peDuring = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(40);
    peDuring.push(await page.evaluate(() => getComputedStyle(document.getElementById('preview')).pointerEvents));
  }
  await page.waitForTimeout(200);
  const samples = await page.evaluate(() => {
    window.__obs && window.__obs.disconnect();
    return window.__inlineSamples;
  });
  console.log('动画期间 iframe inline 样式变化次数:', samples.length, samples);
  console.log('动画期间 iframe pointer-events 采样:', peDuring);
  if (samples.length > 0) {
    console.error('✗ iframe 不应被任何 inline 样式锁定（避免与用户操作冲突）');
    process.exit(1);
  }
  if (peDuring.some(p => p === 'none')) {
    console.error('✗ iframe pointer-events 在动画期间不应为 none（用户应该能立即滚动）');
    process.exit(1);
  }
  // 恢复
  await page.locator('#btn-toggle-sidebar').click();
  await page.waitForTimeout(300);

  console.log('\n✓ 全部通过');
  await browser.close();
})();
