// 验证 toast 通知：添加扫描根 / 移除扫描根 / 失败场景 / 重复添加都有反馈
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// 等到至少一个匹配的 toast 出现并返回它的内容；超时则返回 null
async function waitToast(page, kind, { timeout = 4000 } = {}) {
  try {
    await page.waitForSelector(`.toast.${kind}:not(.fading)`, { timeout });
    return await page.evaluate((k) => {
      const t = document.querySelector('.toast.' + k + ':not(.fading)');
      if (!t) return null;
      const msgEl = t.querySelector('.toast-msg');
      // 主消息是 msgEl 的第一个 text node
      const main = [...(msgEl?.childNodes || [])].find(n => n.nodeType === 3)?.nodeValue || '';
      const secondary = t.querySelector('.toast-secondary')?.textContent || '';
      return { main, secondary };
    }, kind);
  } catch {
    return null;
  }
}

async function clearAllToasts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.toast .toast-close').forEach(b => b.click());
  });
  // 等到 DOM 里的 toast 真的被移除
  await page.waitForFunction(
    () => document.querySelectorAll('.toast').length === 0,
    { timeout: 2000 }
  ).catch(() => {});
}

(async () => {
  // 用一个独占的空临时子目录作为 testRoot，避免把整个 /tmp 加进 scanRoot
  // （/tmp 下有成百上千个系统临时目录，chokidar 处理时会刷大量 EPERM/UNKNOWN
  //  把 server 拖慢，导致后续 fetch 全部 timeout）
  const testRoot = fs.mkdtempSync(require('path').join(os.tmpdir(), 'atlas-toast-'));
  console.log('testRoot:', testRoot);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:4321', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.file');

  // 把 server 的 scanRoots 清成"不含 testRoot"
  const rawRoots = await page.evaluate(async () => {
    const r = await fetch('/api/config');
    return (await r.json()).scanRoots;
  });
  const originalRoots = rawRoots.filter(r => r !== testRoot);
  await page.evaluate(async (rs) => {
    await fetch('/api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanRoots: rs }),
    });
  }, originalRoots);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.file');

  await page.locator('#btn-settings').click();
  await page.waitForTimeout(200);

  // ===== 1. 添加 → success toast =====
  console.log('\n[1] 添加扫描根成功');
  await page.fill('#root-input', testRoot);
  await page.locator('#root-add-btn').click();
  let toast = await waitToast(page, 'success');
  check('添加成功后出现 success toast', !!toast);
  check('主消息含"已添加"', toast && /已添加/.test(toast.main));
  check('副消息含路径', toast && toast.secondary.includes(testRoot));
  await clearAllToasts(page);

  // ===== 2. 重复添加 → info toast =====
  console.log('\n[2] 重复添加同一路径');
  await page.fill('#root-input', testRoot);
  await page.locator('#root-add-btn').click();
  toast = await waitToast(page, 'info');
  check('重复路径触发 info toast', !!toast);
  check('提示已经在列表里', toast && /已经在/.test(toast.main));
  await clearAllToasts(page);

  // ===== 3. 移除 → success toast =====
  console.log('\n[3] 移除扫描根');
  // 真实点击 [data-remove]：用 evaluateHandle 拿元素，Playwright 真实 click → dialog 自动 accept
  const removeHandle = await page.evaluateHandle((p) => {
    const item = [...document.querySelectorAll('.root-list li')].find(li =>
      li.querySelector('.root-path')?.textContent === p);
    return item?.querySelector('[data-remove]') || null;
  }, testRoot);
  const elem = removeHandle.asElement();
  if (!elem) {
    check('能找到 testRoot 对应的 [data-remove] 按钮', false, 'element handle null');
  } else {
    await elem.click();
  }
  toast = await waitToast(page, 'success');
  check('移除成功 toast 出现', !!toast);
  check('主消息含"已移除"', toast && /已移除/.test(toast.main));
  await clearAllToasts(page);

  // ===== 4. 添加不存在路径 → error toast =====
  console.log('\n[4] 添加不存在的路径');
  await page.fill('#root-input', '/this/does/not/exist/atlas-test-' + Date.now());
  await page.locator('#root-add-btn').click();
  toast = await waitToast(page, 'error');
  check('无效路径触发 error toast', !!toast);
  check('error 主消息含"保存失败"', toast && /保存失败/.test(toast.main));
  await clearAllToasts(page);

  // ===== 5. toast 自动消失 =====
  console.log('\n[5] toast 自动消失（duration ~2.8s）');
  await page.fill('#root-input', testRoot);
  await page.locator('#root-add-btn').click();
  await page.waitForSelector('.toast', { timeout: 4000 });
  const visibleCount = await page.evaluate(() => document.querySelectorAll('.toast:not(.fading)').length);
  check('toast 出现可见', visibleCount > 0, `count=${visibleCount}`);
  // 等 4 秒后应自动消失
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => document.querySelectorAll('.toast').length);
  check('~4s 后 toast 自动移除', after === 0);

  // 还原
  await page.evaluate(async (rs) => {
    await fetch('/api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanRoots: rs }),
    });
  }, originalRoots);

  await browser.close();
  // 清理临时目录
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch {}
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
