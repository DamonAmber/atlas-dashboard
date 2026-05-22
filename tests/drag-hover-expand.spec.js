// 验证：拖文件悬停在折叠 folder 头上 600ms 自动展开
const { chromium } = require('playwright');

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

  // 备份初始 tree（结束后恢复）
  const backup = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return d.tree;
  });

  // 选倒数第二个 folder 作为折叠目标（避开第一个，因为拖动源在那里）
  const targetInfo = await page.evaluate(() => {
    const folders = [...document.querySelectorAll('.folder')];
    const target = folders[folders.length - 2] || folders[1];
    if (!target) return null;
    return {
      id: target.dataset.folderId,
      name: target.querySelector('.folder-name').textContent,
      collapsed: target.classList.contains('collapsed'),
    };
  });
  console.log('\n目标 folder:', targetInfo);
  if (!targetInfo) { console.error('找不到第二个 folder'); process.exit(1); }

  // 确保它是折叠状态（如果展开就先折叠）
  // folder-header 现在用 pointer events 监听点击，所以必须用 Playwright 真实点击
  if (!targetInfo.collapsed) {
    await page.locator(`.folder[data-folder-id="${targetInfo.id}"] > .folder-header`).first().click();
    await page.waitForTimeout(200);
  }

  const beforeDrag = await page.evaluate((id) => {
    const f = document.querySelector(`.folder[data-folder-id="${id}"]`);
    const ls = JSON.parse(localStorage.getItem('atlas:collapsed') || '[]');
    return {
      hasCollapsedClass: f.classList.contains('collapsed'),
      inLocalStorage: ls.includes(id),
    };
  }, targetInfo.id);
  console.log('拖前:', beforeDrag);
  check('目标 folder 已折叠（前置条件）',
    beforeDrag.hasCollapsedClass && beforeDrag.inLocalStorage);

  // ----- 开始拖拽 -----
  // 找一个不在该 folder 内的 file 当拖动源
  const sourceBox = await page.evaluate((targetId) => {
    const files = [...document.querySelectorAll('.file')];
    for (const f of files) {
      if (!f.closest(`.folder[data-folder-id="${targetId}"]`)) {
        const r = f.getBoundingClientRect();
        return { x: r.x + 30, y: r.y + r.height / 2, path: f.dataset.path };
      }
    }
    return null;
  }, targetInfo.id);
  console.log('拖动源:', sourceBox?.path);

  const headerBox = await page.evaluate((id) => {
    const head = document.querySelector(`.folder[data-folder-id="${id}"] > .folder-header`);
    const r = head.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, targetInfo.id);

  // pointerdown + 移到 header 上 + 保持悬停
  await page.mouse.move(sourceBox.x, sourceBox.y);
  await page.mouse.down();
  await page.waitForTimeout(100);
  // 慢速移到目标 header
  await page.mouse.move(sourceBox.x + 20, sourceBox.y + 5, { steps: 5 });
  await page.waitForTimeout(50);
  await page.mouse.move(headerBox.x, headerBox.y, { steps: 25 });

  // 立即检查 drag-hover class 出现
  await page.waitForTimeout(100);
  const duringHover = await page.evaluate((id) => {
    const head = document.querySelector(`.folder[data-folder-id="${id}"] > .folder-header`);
    return {
      hasDragHover: head.classList.contains('drag-hover'),
    };
  }, targetInfo.id);
  console.log('hover 100ms:', duringHover);
  check('100ms 时 folder header 已加 drag-hover class',
    duringHover.hasDragHover);

  // 继续悬停 600+ms 让自动展开触发
  await page.waitForTimeout(750);
  const afterAutoExpand = await page.evaluate((id) => {
    const f = document.querySelector(`.folder[data-folder-id="${id}"]`);
    const head = f.querySelector('.folder-header');
    const ls = JSON.parse(localStorage.getItem('atlas:collapsed') || '[]');
    return {
      hasCollapsedClass: f.classList.contains('collapsed'),
      inLocalStorage: ls.includes(id),
      stillHasDragHover: head.classList.contains('drag-hover'),
    };
  }, targetInfo.id);
  console.log('悬停 850ms 后:', afterAutoExpand);
  check('折叠 class 已移除（folder 自动展开）',
    !afterAutoExpand.hasCollapsedClass);
  check('localStorage 中也已移除（持久化同步）',
    !afterAutoExpand.inLocalStorage);
  check('drag-hover 视觉态已清除',
    !afterAutoExpand.stillHasDragHover);

  // 释放鼠标取消拖拽
  await page.mouse.up();
  await page.waitForTimeout(300);

  // ----- 反向测试：移开 header 再回去时不应自动展开（timer 应被清掉）-----
  // 重新折叠该 folder（pointer events，必须用真实 click）
  const stillExpanded = await page.evaluate((id) =>
    !document.querySelector(`.folder[data-folder-id="${id}"]`).classList.contains('collapsed'),
    targetInfo.id);
  if (stillExpanded) {
    await page.locator(`.folder[data-folder-id="${targetInfo.id}"] > .folder-header`).first().click();
  }
  await page.waitForTimeout(200);

  // 拖到 header 上停 200ms（< 600ms 不该展开），然后离开
  await page.mouse.move(sourceBox.x, sourceBox.y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.move(headerBox.x, headerBox.y, { steps: 15 });
  await page.waitForTimeout(200);  // < 600ms
  // 离开 header（移到屏幕中央安全区）
  await page.mouse.move(800, 400, { steps: 5 });
  await page.waitForTimeout(500);

  const afterCancel = await page.evaluate((id) => {
    const f = document.querySelector(`.folder[data-folder-id="${id}"]`);
    return f.classList.contains('collapsed');
  }, targetInfo.id);
  check('短暂悬停（<600ms）后离开，folder 不会被错误展开',
    afterCancel);

  await page.mouse.up();
  await page.waitForTimeout(200);

  // ----- 还原 -----
  await page.evaluate(async (tree) => {
    await fetch('/api/tree', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree }),
    });
  }, backup);

  await browser.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
