// 验证 landing page demo 真的可交互
const { chromium } = require('playwright');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '..', 'docs', 'index.html');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('[console.error]', m.text()); });

  await page.goto(FILE, { waitUntil: 'load' });
  // 等 demo 渲染
  await page.waitForSelector('#demo-tree .folder', { timeout: 5000 });

  // 工具：可见 file（排除折叠 folder 内的）
  const countVisibleFiles = async () => page.evaluate(() => {
    return [...document.querySelectorAll('#demo-tree .file')]
      .filter(el => !el.closest('.folder.collapsed')).length;
  });

  // ===== 1. 渲染了正确数量的节点 =====
  console.log('\n[1] 初始渲染');
  const initial = await page.evaluate(() => ({
    folders: document.querySelectorAll('#demo-tree .folder').length,
    totalFilesInDom: document.querySelectorAll('#demo-tree .file').length,
    stats: document.getElementById('demo-stats').textContent,
    previewHasContent: document.getElementById('demo-preview').textContent.length > 50,
  }));
  const visibleInit = await countVisibleFiles();
  console.log('  ', { ...initial, visible: visibleInit });
  check('渲染 3 个 folder', initial.folders === 3);
  check('默认两个 folder 展开（5 个 file 可见）', visibleInit === 5);
  check('DOM 中含全部 8 个 file（折叠的也在 DOM 里）', initial.totalFilesInDom === 8);
  check('stats 显示正确（8 个文档 · 3 未读）', /8\s*个/.test(initial.stats) && /3\s*未读/.test(initial.stats));
  check('preview 默认有内容（首屏不空）', initial.previewHasContent);

  // ===== 2. 点击文件切换 preview + 消除未读 =====
  console.log('\n[2] 点击 q3-okr-review');
  await page.locator('#demo-tree .file[data-file-id="f2"]').click();
  await page.waitForTimeout(300);
  const afterClick = await page.evaluate(() => {
    const f2 = document.querySelector('#demo-tree .file[data-file-id="f2"]');
    return {
      isActive: f2 && f2.classList.contains('active'),
      stillUnread: f2 && f2.classList.contains('unread'),
      previewText: document.getElementById('demo-preview').textContent.slice(0, 60),
      stats: document.getElementById('demo-stats').textContent,
    };
  });
  console.log('  ', afterClick);
  check('该文件被标记为 active', afterClick.isActive);
  check('未读状态被清除', !afterClick.stillUnread);
  check('preview 切换到 OKR Review', /OKR Review/.test(afterClick.previewText));
  check('stats 未读数从 3 → 2', /2\s*未读/.test(afterClick.stats));

  // ===== 3. 折叠 folder =====
  console.log('\n[3] 点击 reports 折叠');
  await page.locator('#demo-tree .folder[data-folder-id="reports"] .folder-head').click();
  await page.waitForTimeout(200);
  const afterCollapse = await page.evaluate(() => {
    const folder = document.querySelector('#demo-tree .folder[data-folder-id="reports"]');
    return {
      collapsed: folder.classList.contains('collapsed'),
      visibleFiles: document.querySelectorAll('#demo-tree .file:not([style*="display: none"])').length,
    };
  });
  check('reports 折叠', afterCollapse.collapsed);
  console.log('  visibleFiles:', afterCollapse.visibleFiles);

  // 展开回来
  await page.locator('#demo-tree .folder[data-folder-id="reports"] .folder-head').click();
  await page.waitForTimeout(150);

  // ===== 4. 搜索过滤 =====
  console.log('\n[4] 搜索 "落地页"');
  await page.fill('#demo-search', '落地页');
  await page.waitForTimeout(150);
  const afterSearch = await page.evaluate(() => ({
    folders: document.querySelectorAll('#demo-tree .folder').length,
    files: document.querySelectorAll('#demo-tree .file').length,
    visibleFileNames: [...document.querySelectorAll('#demo-tree .file .file-name')].map(e => e.textContent),
  }));
  console.log('  ', afterSearch);
  check('搜索后只剩匹配的 folder', afterSearch.folders === 1);
  check('搜索后只剩 1 个 file（落地页 v2）',
    afterSearch.files === 1 && afterSearch.visibleFileNames.some(n => /落地页/.test(n)));

  // 清空搜索
  await page.fill('#demo-search', '');
  await page.waitForTimeout(150);
  const afterClearVisible = await countVisibleFiles();
  check('清空搜索后所有 5 个可见文件回归', afterClearVisible === 5);

  // ===== 5. 拖拽文件到另一个 folder =====
  console.log('\n[5] 拖 weekly-summary 到 prototypes folder');
  // 等 SortableJS 完全 attach 到搜索清空后重建的 DOM
  await page.waitForTimeout(400);
  const sourceBox = await page.locator('#demo-tree .file[data-file-id="f1"]').boundingBox();
  const targetBox = await page.locator('#demo-tree .folder[data-folder-id="prototypes"] .folder-children').boundingBox();
  // 慢速、多步移动让 SortableJS 有时间识别
  await page.mouse.move(sourceBox.x + 30, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.move(sourceBox.x + 50, sourceBox.y + sourceBox.height / 2 + 10, { steps: 5 });
  await page.waitForTimeout(80);
  await page.mouse.move(targetBox.x + 40, targetBox.y + targetBox.height / 2, { steps: 20 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(400);

  const afterDrag = await page.evaluate(() => {
    const reportsFiles = [...document.querySelectorAll('#demo-tree .folder[data-folder-id="reports"] .file')].map(e => e.dataset.fileId);
    const protoFiles = [...document.querySelectorAll('#demo-tree .folder[data-folder-id="prototypes"] .file')].map(e => e.dataset.fileId);
    return { reportsFiles, protoFiles };
  });
  console.log('  reports:', afterDrag.reportsFiles, '| prototypes:', afterDrag.protoFiles);
  check('f1 已不在 reports 内', !afterDrag.reportsFiles.includes('f1'));
  check('f1 已在 prototypes 内', afterDrag.protoFiles.includes('f1'));

  // ===== 6. 拖拽后 search 仍工作（确认状态没乱）=====
  console.log('\n[6] 拖拽后再搜索 "weekly"');
  await page.fill('#demo-search', 'weekly');
  await page.waitForTimeout(150);
  const afterDragSearch = await page.evaluate(() => {
    const folders = [...document.querySelectorAll('#demo-tree .folder')].map(f => f.dataset.folderId);
    const files = [...document.querySelectorAll('#demo-tree .file')].map(f => f.dataset.fileId);
    return { folders, files };
  });
  console.log('  ', afterDragSearch);
  check('搜索 weekly：f1 现在在 prototypes 下被找到',
    afterDragSearch.files.includes('f1') && afterDragSearch.folders.includes('prototypes'));

  // ===== 总结 =====
  await browser.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
