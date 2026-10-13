// 目录树展开/折叠的成本护栏 · 回归
//
// 用户反馈「目录树展开收起卡顿得厉害」。实测（400 子项的分组，隔离实例）定位到两处：
//   ① 每个文件行都把行尾那排 hover 才可见的操作按钮图标一起建出来 —— 每行 30 个节点里
//      有 10 个就是那 5 个 <svg><use/>。改为首次 hover / 聚焦时才注入，每行降到 20 节点，
//      400 行的 innerHTML 解析 11.1ms → 7.5ms。
//   ② animateFolderChildren 为了判断「要不要走高度动画」先读一次 scrollHeight，而读它会
//      强制同步布局整棵子树（几百行约 22ms）；偏偏大分组判断完走的就是「即时展开、不做
//      动画」那条分支，这次布局纯属白付。改为先用「直接子项数 × 行高」免费估算挡住大分组，
//      只有估算没超阈值时才真去量高度。实测 400 子项分组首次展开同步阻塞 40.5ms → 19~21ms。
//
// 本 spec 钉住机制（不钉绝对耗时——CI 机器帧率波动大，耗时只作观测打印）：
//   · 每行节点数不得回升（有人把图标塞回渲染路径就会触发）
//   · 渲染后行尾按钮无图标、data-ico 待注入；hover / 聚焦后图标注入且按钮照旧可用
//   · 大分组（子项 × 28px 超阈值）即时展开：不留 .animating、内容立刻可见
//   · 小分组仍走高度动画（别把动画一起优化掉了）
const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, cond, extra) {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : (extra ? `  (${extra})` : '')}`);
}

// 每行节点数上限：当前实测 20，留一点余量
const MAX_NODES_PER_ROW = 22;

(async () => {
  const files = {};
  for (let i = 1; i <= 120; i++) {                 // 大分组：120 × 28 = 3360px > 1200 阈值
    files[`大分组/doc-${String(i).padStart(3, '0')}.html`] =
      `<!doctype html><html><head><title>d${i}</title></head><body><h1>${i}</h1></body></html>`;
  }
  for (let i = 1; i <= 8; i++) {                   // 小分组：8 × 28 = 224px，走高度动画
    files[`小分组/note-${String(i).padStart(2, '0')}.md`] = `# 笔记 ${i}\n\n正文。\n`;
  }

  const atlas = await startAtlas({ prefix: 'atlas-toggle-perf-', files });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(atlas.base, { waitUntil: 'load' });
  await page.waitForSelector('.file');

  await page.evaluate(() => { state.collapsed = new Set(); saveCollapsed(); render(); });
  await page.waitForTimeout(400);

  // ---------- ① 行减重 ----------
  const rowInfo = await page.evaluate(() => {
    const row = document.querySelector('.tree .file');
    return {
      nodes: row.querySelectorAll('*').length + 1,
      svg: row.querySelectorAll('svg').length,
      pendingAttr: row.dataset.icoPending === '1',
      actionBtns: row.querySelectorAll('.file-actions button').length,
      actionSvg: row.querySelectorAll('.file-actions svg').length,
      withIcoAttr: row.querySelectorAll('.file-actions button[data-ico]').length,
      hasDataAct: row.querySelectorAll('.file-actions button[data-act]').length,
      favFirst: !!row.querySelector('.file-actions > .fav-btn:first-child'),
    };
  });
  check(`每行节点数 ≤ ${MAX_NODES_PER_ROW}（防止图标被塞回渲染路径）`,
    rowInfo.nodes <= MAX_NODES_PER_ROW, `实际=${rowInfo.nodes}`);
  // 0.31 起星标 .fav-btn 也挪进行尾操作组排第一（design §12.2），图标同样延迟注入：
  // 操作组共 6 个按钮 = 星标 + 原来 5 个带 data-act 的
  check('行尾 6 个操作按钮都在（星标 + 5 个 data-act 未变，事件绑定与外部查询不受影响）',
    rowInfo.actionBtns === 6 && rowInfo.hasDataAct === 5 && rowInfo.favFirst,
    `btn=${rowInfo.actionBtns} data-act=${rowInfo.hasDataAct}`);
  check('渲染时行尾按钮里还没有图标 SVG', rowInfo.actionSvg === 0, `svg=${rowInfo.actionSvg}`);
  check('按钮带 data-ico 待注入标记', rowInfo.withIcoAttr === 6, `带标记=${rowInfo.withIcoAttr}`);
  check('行上有 data-ico-pending 标记', rowInfo.pendingAttr);

  // hover 后图标注入
  await page.locator('.tree .file').first().hover();
  await page.waitForTimeout(150);
  const afterHover = await page.evaluate(() => {
    const row = document.querySelector('.tree .file');
    return {
      actionSvg: row.querySelectorAll('.file-actions svg').length,
      leftoverAttr: row.querySelectorAll('.file-actions button[data-ico]').length,
      pendingAttr: row.dataset.icoPending === '1',
      btns: row.querySelectorAll('.file-actions button[data-act]').length,
    };
  });
  check('hover 后 6 个图标注入完成', afterHover.actionSvg === 6, `svg=${afterHover.actionSvg}`);
  check('注入后清掉 data-ico（不重复注入）', afterHover.leftoverAttr === 0);
  check('注入后清掉行上的 pending 标记', !afterHover.pendingAttr);
  check('注入后按钮仍然齐全可用', afterHover.btns === 5);

  // 键盘聚焦也要能注入（只靠 hover 会漏掉键盘用户）
  const focusInjected = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('.tree .file')];
    const target = rows.find(r => r.dataset.icoPending === '1');
    if (!target) return 'no-pending-row';
    target.focus();
    await new Promise(r => setTimeout(r, 120));
    return target.querySelectorAll('.file-actions svg').length;
  });
  check('键盘聚焦某行也会注入图标', focusInjected === 6, `结果=${focusInjected}`);

  // ---------- ② 大分组即时展开 / 小分组仍有动画 ----------
  const bigId = await page.evaluate(() => {
    for (const f of document.querySelectorAll('.tree > .folder')) {
      if (f.querySelector('.folder-name')?.textContent.includes('大分组')) return f.dataset.folderId;
    }
    return null;
  });
  const smallId = await page.evaluate(() => {
    for (const f of document.querySelectorAll('.tree > .folder')) {
      if (f.querySelector('.folder-name')?.textContent.includes('小分组')) return f.dataset.folderId;
    }
    return null;
  });
  check('找到大/小分组', !!bigId && !!smallId);

  // 先全折叠，再分别展开并观察是否用了动画
  const observe = async (id) => page.evaluate(async (id) => {
    document.querySelectorAll('.tree > .folder').forEach(f => state.collapsed.add(f.dataset.folderId));
    saveCollapsed(); render();
    await new Promise(r => setTimeout(r, 300));
    const el = document.querySelector(`.folder[data-folder-id="${id}"]`);
    const childrenEl = el.querySelector(':scope > .folder-children');
    let sawAnimating = false;
    const obs = new MutationObserver(() => {
      if (childrenEl.classList.contains('animating')) sawAnimating = true;
    });
    obs.observe(childrenEl, { attributes: true, attributeFilter: ['class'] });
    const t = performance.now();
    toggleFolder(id);
    const sync = +(performance.now() - t).toFixed(1);
    const animatingRightAfter = childrenEl.classList.contains('animating');
    await new Promise(r => setTimeout(r, 600));
    obs.disconnect();
    return {
      sync, sawAnimating, animatingRightAfter,
      stillAnimating: childrenEl.classList.contains('animating'),
      leftoverHeight: !!childrenEl.style.height,
      visibleRows: [...childrenEl.children].filter(c => c.getBoundingClientRect().height > 0).length,
      childCount: childrenEl.children.length,
    };
  }, id);

  const big = await observe(bigId);
  check('大分组：即时展开，不挂 .animating（跳过为判断而做的强制布局）',
    !big.animatingRightAfter && !big.sawAnimating,
    `rightAfter=${big.animatingRightAfter} saw=${big.sawAnimating}`);
  check('大分组：展开后内容立刻可见', big.visibleRows > 0, `可见行=${big.visibleRows}`);
  check('大分组：没有残留 .animating', !big.stillAnimating);
  check('大分组：没有残留内联 height', !big.leftoverHeight);
  console.log(`    · 大分组 ${big.childCount} 子项，首次展开同步阻塞 ${big.sync}ms（仅观测，不作断言）`);

  const small = await observe(smallId);
  check('小分组：仍走高度动画（没把动画一起优化掉）', small.sawAnimating, `saw=${small.sawAnimating}`);
  check('小分组：动画收尾干净，无残留 .animating', !small.stillAnimating);
  check('小分组：动画收尾清掉内联 height', !small.leftoverHeight);
  check('小分组：展开后内容可见', small.visibleRows > 0, `可见行=${small.visibleRows}`);
  console.log(`    · 小分组 ${small.childCount} 子项，首次展开同步阻塞 ${small.sync}ms（仅观测）`);

  check('全程无 JS 报错', pageErrors.length === 0, pageErrors[0]);

  await browser.close();
  await atlas.stop();
  console.log(`\n========================`);
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
