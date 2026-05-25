// 验证：浏览器内目录浏览器（替代手输绝对路径）
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // ===== 1. 后端 /api/browse =====
  console.log('\n[1] 后端 /api/browse');

  const home = await page.evaluate(async () => {
    const r = await fetch('/api/browse');
    return await r.json();
  });
  check('GET /api/browse 默认返回 home', typeof home.path === 'string' && home.path === home.home);
  check('返回 entries 数组', Array.isArray(home.entries));
  check('home 应有父目录', !!home.parent);

  // 显式 path
  const docsPath = path.join(os.homedir(), 'Documents');
  const docs = await page.evaluate(async (p) => {
    const r = await fetch('/api/browse?path=' + encodeURIComponent(p));
    return await r.json();
  }, docsPath);
  check('指定路径返回该目录', docs.path === docsPath);

  // ~ 展开
  const tilde = await page.evaluate(async () => {
    const r = await fetch('/api/browse?path=~');
    return await r.json();
  });
  check('~ 自动展开为 home', tilde.path === tilde.home);

  // 不存在的路径返回 400
  const bad = await page.evaluate(async () => {
    const r = await fetch('/api/browse?path=/this/does/not/exist/atlas-test');
    return { status: r.status, body: await r.json() };
  });
  check('不存在路径返回 400', bad.status === 400);

  // ===== 2. 前端 picker =====
  console.log('\n[2] 前端 picker');

  // 打开设置面板
  await page.locator('#btn-settings').click();
  await page.waitForTimeout(300);

  // 点击"浏览…"
  await page.locator('#root-browse-btn').click();
  await page.waitForTimeout(500);

  const pickerVisible = await page.evaluate(() =>
    !document.getElementById('dir-picker').classList.contains('hidden')
  );
  check('点"浏览..."后 picker 出现', pickerVisible);

  // 应该有目录条目
  const entryCount = await page.evaluate(() =>
    document.querySelectorAll('#dir-list .dir-item').length
  );
  check('home 目录列出了子目录', entryCount > 0, `count=${entryCount}`);

  // 当前路径应该是 home
  const curPath = await page.evaluate(() => document.getElementById('dir-current').value);
  check('当前路径是 home', curPath === os.homedir(), `cur=${curPath}`);

  // 点击第一个子目录进入
  const firstName = await page.evaluate(() =>
    document.querySelector('#dir-list .dir-item span:last-child')?.textContent
  );
  await page.locator('#dir-list .dir-item').first().click();
  await page.waitForTimeout(400);

  const enteredPath = await page.evaluate(() => document.getElementById('dir-current').value);
  check('点击子目录进入新路径',
    enteredPath !== os.homedir() && enteredPath.endsWith(firstName),
    `entered=${enteredPath}`);

  // 点 ↑ 上级
  await page.locator('#dir-up').click();
  await page.waitForTimeout(400);
  const afterUp = await page.evaluate(() => document.getElementById('dir-current').value);
  check('点 ↑ 回到 home', afterUp === os.homedir());

  // 选择此目录 → input 被填充 + picker 关闭
  await page.locator('#dir-select').click();
  await page.waitForTimeout(200);
  const final = await page.evaluate(() => ({
    inputValue: document.getElementById('root-input').value,
    pickerHidden: document.getElementById('dir-picker').classList.contains('hidden'),
  }));
  check('"选择此目录"填充 input', final.inputValue === os.homedir());
  check('选择后 picker 关闭', final.pickerHidden);

  // 取消按钮
  await page.locator('#root-browse-btn').click();
  await page.waitForTimeout(400);
  await page.locator('#dir-cancel').click();
  await page.waitForTimeout(150);
  const cancelHidden = await page.evaluate(() =>
    document.getElementById('dir-picker').classList.contains('hidden'));
  check('"取消"关闭 picker', cancelHidden);

  await browser.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
