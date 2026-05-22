// 验证：folder header 点击带抖动也能正常切换折叠/展开
const { chromium } = require('playwright');
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function clickWithJitter(page, locator, jitterPx) {
  const box = await locator.boundingBox();
  // 点击文字位置（不是 actions 区域）—— 取靠左 30% 处
  const cx = box.x + box.width * 0.3;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  if (jitterPx > 0) {
    await page.mouse.move(cx + jitterPx, cy + jitterPx, { steps: 2 });
    await page.mouse.move(cx, cy, { steps: 2 });
  }
  await page.mouse.up();
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.folder');

  // 拿第一个 folder
  const folderId = await page.evaluate(() => document.querySelector('.folder')?.dataset.folderId);
  console.log('测试 folder:', folderId);

  for (const jitter of [0, 1, 3, 5]) {
    // 重置：确保展开状态
    await page.evaluate((id) => {
      const f = document.querySelector(`.folder[data-folder-id="${id}"]`);
      if (f.classList.contains('collapsed')) {
        // 用 dispatchEvent + Pointer 强制展开（绕开测试本身用的方式，直接 toggle）
        if (typeof toggleFolder === 'function') toggleFolder(id);
      }
    }, folderId);
    await page.waitForTimeout(200);

    const initial = await page.evaluate((id) => {
      return document.querySelector(`.folder[data-folder-id="${id}"]`).classList.contains('collapsed');
    }, folderId);

    const headerLocator = page.locator(`.folder[data-folder-id="${folderId}"] > .folder-header`);
    await clickWithJitter(page, headerLocator, jitter);
    await page.waitForTimeout(200);

    const afterClick = await page.evaluate((id) => {
      return document.querySelector(`.folder[data-folder-id="${id}"]`).classList.contains('collapsed');
    }, folderId);

    check(`抖动 ${jitter}px 点击 folder header 触发折叠/展开`,
      initial !== afterClick,
      `before=${initial}, after=${afterClick}`);
  }

  await browser.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) process.exit(1);
})();
