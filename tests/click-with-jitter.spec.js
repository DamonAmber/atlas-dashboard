// 复现 + 验证：鼠标点击文件时如果有 1-3px 抖动，SortableJS 不应吞掉 click 事件
const { chromium } = require('playwright');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function clickWithJitter(page, locator, jitterPx) {
  const box = await locator.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  if (jitterPx > 0) {
    // 模拟手抖：按下后偏移几像素
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
  await page.waitForSelector('.file');

  // 拿两个不同的 file path 用于切换测试
  const paths = await page.evaluate(() => {
    const files = [...document.querySelectorAll('.file')]
      .filter(el => !el.closest('.folder.collapsed'))
      .slice(0, 2);
    return files.map(f => f.dataset.path);
  });
  if (paths.length < 2) { console.error('需要至少 2 个可见 file'); process.exit(1); }
  console.log('测试文件:', paths.map(p => p.split('/').pop()));

  // 先点击文件 1（无抖动）作为基线
  await page.locator(`.file[data-path="${paths[0].replace(/(["\\])/g, '\\$1')}"]`).first().click();
  await page.waitForTimeout(300);
  let active = await page.evaluate(() => document.querySelector('.file.active')?.dataset.path);
  check('基线：普通点击能打开文件', active === paths[0]);

  // ===== 用 1px / 3px / 5px 抖动点击文件 2 =====
  for (const jitter of [0, 1, 2, 3]) {
    // 先切回文件 1（保证后面的点击是"切换"操作）
    await page.locator(`.file[data-path="${paths[0].replace(/(["\\])/g, '\\$1')}"]`).first().click();
    await page.waitForTimeout(200);

    const target = page.locator(`.file[data-path="${paths[1].replace(/(["\\])/g, '\\$1')}"]`).first();
    await clickWithJitter(page, target, jitter);
    await page.waitForTimeout(300);

    active = await page.evaluate(() => document.querySelector('.file.active')?.dataset.path);
    check(`鼠标抖动 ${jitter}px 点击仍能打开文件`, active === paths[1],
      `expected ${paths[1].split('/').pop()}, got ${active?.split('/').pop()}`);
  }

  await browser.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
