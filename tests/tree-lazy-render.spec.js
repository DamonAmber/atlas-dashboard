// 折叠分组懒渲染（阶段 1 目录树重构）
//
// 背景：过去 renderFolder 无论分组折叠与否都把子节点全量建进 DOM。扫 ~/Documents
// 这种上万文件的目录时，即使用户把分组都折叠着，每次整树重建仍会同步创建上万个
// 文件行 + 数万个监听器 —— 这是大树卡顿与高 DOM 内存的直接来源。
//
// 现在：折叠且非筛选态的分组只渲染 header + 一个空的 .folder-children（标 data-lazy），
// 展开时（toggleFolder / hover-to-expand）才真正填充子节点。
//
// 本 spec 钉住三件事：
//   ① 懒渲染：全部折叠时 DOM 里没有任何 .file（省内存），但 .folder 照常在
//   ② 展开兑现：点开一个懒分组，它的子节点被真正建出来
//   ③ 【红线】拖拽读回树时绝不丢数据：分组懒渲染（子节点不在 DOM）时执行
//      rebuildTreeFromDom（拖拽 onEnd 走的就是它），每个分组的子文件必须原样保留，
//      不能因为"没渲染"被读成空分组、一拖就写坏 store.json
const path = require('path');
const { chromium } = require('playwright');
const { startAtlas, makeTreeFixtures } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

// 深度统计一棵 tree（节点数组）里的文件数
function countFiles(nodes) {
  let n = 0;
  for (const x of nodes || []) {
    if (x.type === 'file') n++;
    else if (x.type === 'folder') n += countFiles(x.children);
  }
  return n;
}

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-lazy-render-',
    files: makeTreeFixtures({ projects: 6, filesPerProject: 8 }),
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(atlas.base, { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // 基线：磁盘上的文件总数（从 /api/state 拿），以及当前树里的深度文件数
  const baseline = await page.evaluate(async () => {
    const d = await (await fetch('/api/state')).json();
    return { totalFiles: Object.keys(d.files).length };
  });
  console.log('\n[基线] 文档总数:', baseline.totalFiles);

  // ---- ① 懒渲染：全部折叠 → DOM 里没有 .file ----
  console.log('\n[① 懒渲染]');
  await page.evaluate(() => {
    const ids = [...document.querySelectorAll('.tree .folder')].map(f => f.dataset.folderId);
    localStorage.setItem('atlas:collapsed', JSON.stringify(ids));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.tree .folder', { state: 'attached' });
  await page.waitForTimeout(300);

  const collapsedDom = await page.evaluate(() => ({
    files: document.querySelectorAll('.tree .file').length,
    folders: document.querySelectorAll('.tree .folder').length,
    lazyContainers: document.querySelectorAll('.tree .folder-children[data-lazy="1"]').length,
  }));
  console.log('  全部折叠后 DOM:', collapsedDom);
  check('全部折叠时 DOM 里没有任何 .file（省内存的核心效果）', collapsedDom.files, 0);
  check('分组本身照常渲染（.folder 仍在）', collapsedDom.folders > 0, true);
  check('折叠分组的子容器被标记为 data-lazy', collapsedDom.lazyContainers > 0, true);

  // ---- ② 展开兑现：点开一个懒分组，子节点被真正建出来 ----
  console.log('\n[② 展开兑现]');
  const firstFolderId = await page.evaluate(() =>
    document.querySelector('.tree .folder').dataset.folderId);
  await page.locator(`.folder[data-folder-id="${firstFolderId}"] > .folder-header`).first().click();
  await page.waitForTimeout(400);
  const afterExpand = await page.evaluate((id) => {
    const folderEl = document.querySelector(`.folder[data-folder-id="${id}"]`);
    const childrenEl = folderEl.querySelector(':scope > .folder-children');
    return {
      filesInThisFolder: childrenEl.querySelectorAll('.file').length,
      stillLazy: childrenEl.dataset.lazy === '1',
    };
  }, firstFolderId);
  console.log('  展开后该分组:', afterExpand);
  check('展开懒分组后子文件被真正渲染出来', afterExpand.filesInThisFolder > 0, true);
  check('展开后 data-lazy 标记已清除', afterExpand.stillLazy, false);

  // ---- ③ 【红线】懒渲染下 rebuildTreeFromDom 不丢数据 ----
  // 先重新全部折叠（回到"大部分分组懒渲染"的态），再模拟一次拖拽落定：
  // 把第一个顶层 .folder 挪到 #tree 末尾，然后调 rebuildTreeFromDom（= 拖拽 onEnd）。
  // 之后检查 state.tree：文件总数一个不少，且每个分组的子文件数原样保留。
  console.log('\n[③ 红线：懒渲染下拖拽读回树不丢数据]');
  await page.evaluate(() => {
    const ids = [...document.querySelectorAll('.tree .folder')].map(f => f.dataset.folderId);
    localStorage.setItem('atlas:collapsed', JSON.stringify(ids));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.tree .folder', { state: 'attached' });
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const tree = document.getElementById('tree');
    // 记录拖前每个顶层分组的 id 与顺序
    const beforeOrder = [...tree.querySelectorAll(':scope > .folder')].map(f => f.dataset.folderId);
    // 模拟拖拽落定：把第一个顶层分组移到末尾（DOM 顺序变化），再走 onEnd 的读回逻辑
    const first = tree.querySelector(':scope > .folder');
    tree.appendChild(first);
    const afterOrder = [...tree.querySelectorAll(':scope > .folder')].map(f => f.dataset.folderId);
    // rebuildTreeFromDom 是拖拽 onEnd 调用的同一个函数（读 DOM → state.tree → 存盘）
    rebuildTreeFromDom();
    // 直接读内存里的 state.tree（最直接地验证 readContainer 的产物）
    const countFiles = (nodes) => {
      let n = 0;
      for (const x of nodes || []) {
        if (x.type === 'file') n++;
        else if (x.type === 'folder') n += countFiles(x.children);
      }
      return n;
    };
    const perFolder = {};
    for (const node of state.tree) {
      if (node.type === 'folder') perFolder[node.id] = countFiles(node.children);
    }
    return {
      beforeOrder,
      afterOrder,
      treeFileCount: countFiles(state.tree),
      perFolder,
    };
  });
  console.log('  顶层顺序 拖前:', result.beforeOrder);
  console.log('  顶层顺序 拖后:', result.afterOrder);
  console.log('  各分组文件数:', result.perFolder);
  check('rebuildTreeFromDom 后文件总数一个不少（红线：懒分组子节点没被读丢）',
    result.treeFileCount, baseline.totalFiles);
  check('顶层顺序确实按 DOM 变了（第一个被挪到了末尾）',
    result.afterOrder[result.afterOrder.length - 1], result.beforeOrder[0]);
  check('每个懒渲染分组的子文件都完整保留（没有变空分组）',
    Object.values(result.perFolder).every(n => n > 0), true);

  // 落盘校验：等 scheduleSaveTree 的防抖 PUT 完成后，服务端 store 也应保住全部文件
  await page.waitForTimeout(1500);
  const persisted = await page.evaluate(async () => {
    const d = await (await fetch('/api/state')).json();
    return Object.keys(d.files).length;
  });
  check('落盘后服务端仍能看到全部文件（store.json 没被写坏）', persisted, baseline.totalFiles);

  check('全程无 JS 报错', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log(`\n========================`);
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
