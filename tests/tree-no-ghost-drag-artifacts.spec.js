// 幽灵残影根治 · 回归：拖拽被打断不再遗留浮在页面上的克隆节点
//
// 现象（用户报的 bug）：侧栏里出现浮在页面上、盖住其它内容的"幽灵分组名 / 文件名"——
// 叠在文件行上、折叠侧边栏后仍浮着、甚至跨到右侧文档「目录」面板上，反复操作越积越多。
//
// 根因：树的 Sortable 用 forceFallback + fallbackOnBody，拖拽时把被拖节点克隆一份挂到
// document.body（position:fixed、z-index:100000）跟着指针走，正常松手由 SortableJS 自己
// 移除。但 render() 会 innerHTML='' 清空整棵树并在末尾 initSortables() → destroySortables()
// 销毁实例：被拖元素与它的 Sortable 实例双双消失，松手时收尾逻辑再也跑不到，那个 fixed
// 克隆就永久孤立在 body 上（不在 .sidebar 里，所以折叠侧边栏也带不走）。SSE 文件事件与
// 60s 轮询都会 fetchState → render，AI 持续写文件时撞上一次几乎必然，于是越积越多。
//
// 本 spec 钉住的三件事：
//   ① 拖拽途中触发 render()（模拟 SSE / 轮询）→ 松手后 body 上不留任何克隆，且不累积；
//   ② 拖拽途中 destroySortables()（如切换视图）→ 同样不留克隆；
//   ③ 守卫不会锁死 —— 被打断后 isDragging 必须复位、render() 必须恢复工作（否则树冻住）。
// 另外验证正常拖拽仍然可用、树内不残留半透明拖拽态、全程无 JS 报错。
const { chromium } = require('playwright');
const { startAtlas, makeTreeFixtures } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, cond, extra) {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : (extra ? `  (${extra})` : '')}`);
}

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-ghost-drag-',
    files: makeTreeFixtures({ projects: 6, filesPerProject: 12 }),
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 430, height: 880 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(atlas.base, { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // 分组视图 + 全部展开（Sortable 只挂在分组视图）
  await page.evaluate(() => {
    state.viewMode = 'group';
    state.collapsed = new Set();
    saveCollapsed();
    render();
  });
  await page.waitForTimeout(350);

  // 统计浮在 body 上的拖拽克隆（幽灵残影本体）
  const ghostCount = () => page.evaluate(() => {
    const tree = document.querySelector('.tree');
    return [...document.querySelectorAll('.sortable-fallback, .sortable-drag')]
      .filter(el => !tree.contains(el)).length;
  });
  // 树内是否残留半透明拖拽视觉态
  const stuckDragState = () => page.evaluate(() =>
    document.querySelectorAll('.tree .dragging-ghost, .tree .sortable-chosen').length);

  // 起一次拖拽：按下 + 越过 5px 阈值
  const beginDrag = async () => {
    const box = await page.locator('.tree > .folder > .folder-header').first().boundingBox();
    if (!box) throw new Error('找不到可拖的分组头');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 34, { steps: 6 });
    await page.waitForTimeout(110);
  };

  check('初始状态 body 上没有拖拽克隆', await ghostCount() === 0);

  // ---------- ① 拖拽途中 render()（模拟 SSE / 轮询打断） ----------
  await beginDrag();
  const during = await ghostCount();
  check('拖拽中确实产生了 1 个 fallback 克隆（前提成立，用例有效）', during === 1, `实际=${during}`);

  await page.evaluate(() => { render(); });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(400);

  const afterOnce = await ghostCount();
  check('拖拽途中 render() + 松手后，body 上不留克隆', afterOnce === 0, `残留=${afterOnce}`);

  // 重复多轮，确认不累积（用户说的"越积越多"）
  for (let i = 0; i < 5; i++) {
    await beginDrag();
    await page.evaluate(() => { render(); });
    await page.waitForTimeout(90);
    await page.mouse.up();
    await page.waitForTimeout(260);
  }
  const accumulated = await ghostCount();
  check('反复被打断 5 轮后仍不累积克隆', accumulated === 0, `残留=${accumulated}`);

  // ---------- ③ 守卫没有锁死：isDragging 复位 + render 仍工作 ----------
  const dragFlag = await page.evaluate(() => isDragging);
  check('被打断后 isDragging 已复位（否则 render 被永久跳过、树冻住）', dragFlag === false, `isDragging=${dragFlag}`);

  const renderAlive = await page.evaluate(async () => {
    // 塞一个哨兵节点：render() 真的跑过就会被 innerHTML='' 清掉
    const s = document.createElement('div');
    s.id = '__sentinel__';
    document.querySelector('.tree').appendChild(s);
    render();
    await new Promise(r => setTimeout(r, 60));
    return !document.getElementById('__sentinel__');
  });
  check('被打断后 render() 恢复工作（树能继续更新）', renderAlive);

  // ---------- ② 拖拽途中 destroySortables()（模拟切换视图） ----------
  await beginDrag();
  await page.evaluate(() => { destroySortables(); });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(350);
  const afterDestroy = await ghostCount();
  check('拖拽途中 destroySortables() 后不留克隆', afterDestroy === 0, `残留=${afterDestroy}`);
  const flagAfterDestroy = await page.evaluate(() => isDragging);
  check('destroySortables 也会复位 isDragging', flagAfterDestroy === false, `isDragging=${flagAfterDestroy}`);

  // ---------- 正常拖拽仍然可用 ----------
  await page.evaluate(() => { initSortables(); });
  await page.waitForTimeout(120);
  const idsBefore = await page.evaluate(() =>
    [...document.querySelectorAll('.tree > .folder')].map(f => f.dataset.folderId));
  await beginDrag();
  await page.mouse.move(200, 420, { steps: 8 });   // 正常拖到别处
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(450);

  check('正常拖拽后 body 上没有克隆', await ghostCount() === 0);
  check('正常拖拽后树内没有卡住的半透明拖拽态', await stuckDragState() === 0);
  const idsAfter = await page.evaluate(() =>
    [...document.querySelectorAll('.tree .folder')].map(f => f.dataset.folderId));
  const dup = idsAfter.filter((id, i) => idsAfter.indexOf(id) !== i);
  check('分组没有被复制出重复节点', dup.length === 0, `重复=${JSON.stringify(dup)}`);
  check('分组一个没丢', idsBefore.every(id => idsAfter.includes(id)),
    `前=${idsBefore.length} 后=${idsAfter.length}`);

  // ---------- 折叠侧边栏后也不该有东西浮着 ----------
  await page.evaluate(() => { const b = document.querySelector('.toggle-sidebar'); if (b) b.click(); });
  await page.waitForTimeout(400);
  check('折叠侧边栏后 body 上没有浮着的克隆', await ghostCount() === 0);

  check('全程无 JS 报错', pageErrors.length === 0, pageErrors[0]);

  await browser.close();
  await atlas.stop();
  console.log(`\n========================`);
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
