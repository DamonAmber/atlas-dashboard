// 量化侧边栏切换的帧率：连续录 1 秒 rAF 时间戳，看 sidebar 切换期间最大帧间隔
// 60fps = 每帧 16.7ms。如果有帧间隔 > 50ms 说明掉帧严重；> 100ms 说明卡顿明显
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // 选个文件让 iframe 加载（更接近真实使用场景）
  await page.locator('.file').first().click();
  await page.waitForTimeout(1200);

  async function measure(label, action) {
    await page.evaluate(() => {
      window.__frames = [];
      let prev = performance.now();
      window.__rafLoop = (t) => {
        window.__frames.push(t - prev);
        prev = t;
        if (window.__rafActive) requestAnimationFrame(window.__rafLoop);
      };
      window.__rafActive = true;
      requestAnimationFrame(window.__rafLoop);
    });
    await action();
    await page.waitForTimeout(450);
    const frames = await page.evaluate(() => {
      window.__rafActive = false;
      return window.__frames;
    });
    if (frames.length === 0) return { label, count: 0 };
    const sorted = [...frames].sort((a, b) => a - b);
    const max = Math.max(...frames);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const avg = frames.reduce((s, x) => s + x, 0) / frames.length;
    return { label, count: frames.length, avg: avg.toFixed(1), p95: p95.toFixed(1), max: max.toFixed(1) };
  }

  // warm up
  await page.locator('#btn-toggle-sidebar').click();
  await page.waitForTimeout(400);
  await page.locator('#btn-toggle-sidebar').click();
  await page.waitForTimeout(400);

  const r1 = await measure('收起动画', async () => {
    await page.locator('#btn-toggle-sidebar').click();
  });
  console.log(`${r1.label}: ${r1.count} 帧, avg ${r1.avg}ms, p95 ${r1.p95}ms, max ${r1.max}ms`);

  await page.waitForTimeout(300);
  const r2 = await measure('展开动画', async () => {
    await page.locator('#btn-toggle-sidebar').click();
  });
  console.log(`${r2.label}: ${r2.count} 帧, avg ${r2.avg}ms, p95 ${r2.p95}ms, max ${r2.max}ms`);

  // 评估：60fps 理想 16.7ms，p95 < 25ms 算流畅，max < 50ms 算无明显卡顿
  let bad = 0;
  for (const r of [r1, r2]) {
    if (parseFloat(r.p95) > 25) { console.warn(`⚠ ${r.label} p95 = ${r.p95}ms（>25ms 偏卡）`); bad++; }
    if (parseFloat(r.max) > 50) { console.warn(`⚠ ${r.label} max = ${r.max}ms（>50ms 明显卡顿）`); bad++; }
  }
  await browser.close();
  if (bad > 0) {
    console.log(`\n✗ 有 ${bad} 处帧率不达标`);
    process.exit(1);
  } else {
    console.log('\n✓ 帧率达标（p95 ≤ 25ms, max ≤ 50ms）');
  }
})();
