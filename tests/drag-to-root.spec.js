// 复现：把 file 拖到 tree 根（与所有 folder 同级）后是否卡死
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });

  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // ---- 准备：构造一个 file 在根的 tree（直接通过 API 设置，绕开拖拽，先验证渲染层是否能处理）----
  const sampleFilePath = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return Object.keys(d.files)[0];
  });
  console.log('sample file:', sampleFilePath);

  // 备份当前 tree 以便测试后还原
  const backupTree = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return d.tree;
  });

  console.log('\n[场景 A] 通过 API 直接构造一个 file 在根的 tree');
  await page.evaluate(async (fp) => {
    // 构造 tree：顶层 [{folder1, file直接放根}]
    const r = await fetch('/api/state');
    const d = await r.json();
    // 从某个 folder 移除该 file，放到根
    const newTree = JSON.parse(JSON.stringify(d.tree));
    function remove(nodes) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.type === 'file' && n.path === fp) { nodes.splice(i, 1); return true; }
        if (n.type === 'folder' && remove(n.children)) return true;
      }
      return false;
    }
    remove(newTree);
    newTree.push({ type: 'file', path: fp });
    await fetch('/api/tree', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree: newTree }),
    });
  }, sampleFilePath);

  // 触发 fetchState，看渲染是否正常
  console.log('  PUT 后调用 fetchState');
  const t0 = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, 4000);
  try {
    await page.evaluate(() => fetchState());
  } finally { clearTimeout(timer); }
  const t1 = Date.now();
  console.log('  fetchState 耗时:', (t1 - t0), 'ms', timedOut ? '(超时!)' : '');

  // 检查页面是否仍响应（200ms 内能 setInterval 完成 5 次 = 主线程没卡）
  const responsive = await Promise.race([
    page.evaluate(() => new Promise(res => {
      let n = 0;
      const id = setInterval(() => { if (++n > 5) { clearInterval(id); res(true); } }, 30);
    })),
    new Promise(res => setTimeout(() => res(false), 3000)),
  ]);
  console.log('  主线程响应:', responsive);

  // 看 tree 状态
  const treeNow = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return {
      topLevel: d.tree.map(n => n.type === 'folder' ? `F:${n.name}(${n.children.length})` : `f:${n.path.split('/').pop()}`),
      count: d.tree.length,
    };
  });
  console.log('  tree top-level:', treeNow);

  // ---- 场景 B：尝试真实拖拽到根（如果 A 没卡死再做这步）----
  console.log('\n[场景 B] 真实拖拽某文件到根容器底部');
  // 还原 tree
  await page.evaluate(async (tree) => {
    await fetch('/api/tree', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree }),
    });
    await fetchState();
  }, backupTree);
  await page.waitForTimeout(300);

  // 找到一个 file 在某个 folder 内
  const dragTarget = await page.evaluate(() => {
    const f = document.querySelector('.file');
    return f && {
      path: f.dataset.path,
      box: f.getBoundingClientRect(),
    };
  });
  const treeBox = await page.evaluate(() => {
    const t = document.getElementById('tree');
    const r = t.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, scrollHeight: t.scrollHeight };
  });
  console.log('  drag from:', dragTarget && dragTarget.box, '→ tree底:', treeBox);

  if (dragTarget) {
    // 慢速拖拽以确保 SortableJS 接受
    await page.mouse.move(dragTarget.box.x + 30, dragTarget.box.y + dragTarget.box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(80);
    // 拖到 tree 底部、左边一点（避免落到任何 folder-children）
    await page.mouse.move(treeBox.x + 20, treeBox.y + treeBox.h - 8, { steps: 25 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(800);
  }

  const responsive2 = await Promise.race([
    page.evaluate(() => new Promise(res => {
      let n = 0;
      const id = setInterval(() => { if (++n > 5) { clearInterval(id); res(true); } }, 30);
    })),
    new Promise(res => setTimeout(() => res(false), 3000)),
  ]);
  console.log('  拖拽后主线程响应:', responsive2);

  const treeAfterDrag = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return {
      topLevel: d.tree.map(n => n.type === 'folder' ? `F:${n.name}(${n.children.length})` : `f:${n.path.split('/').pop()}`),
      count: d.tree.length,
    };
  });
  console.log('  拖拽后 tree:', treeAfterDrag);

  // ---- 场景 C：连续多次拖到不同位置（探索 timing） ----
  console.log('\n[场景 C] 连续 5 次随机拖拽 file 到根');
  for (let i = 0; i < 5; i++) {
    const t = await page.evaluate(() => {
      const fs = [...document.querySelectorAll('.file')];
      const f = fs[Math.floor(Math.random() * fs.length)];
      const r = f.getBoundingClientRect();
      const tr = document.getElementById('tree').getBoundingClientRect();
      return { fx: r.x + 30, fy: r.y + r.height / 2, tx: tr.x + 20, ty: tr.y + tr.height - 8 };
    });
    if (!t) break;
    await page.mouse.move(t.fx, t.fy);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.move(t.tx, t.ty, { steps: 15 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  const responsive3 = await Promise.race([
    page.evaluate(() => new Promise(res => {
      let n = 0;
      const id = setInterval(() => { if (++n > 5) { clearInterval(id); res(true); } }, 30);
    })),
    new Promise(res => setTimeout(() => res(false), 3000)),
  ]);
  console.log('  C 响应:', responsive3);

  // ---- 场景 D：构造 tree 循环引用（folder.children 含自己） ----
  console.log('\n[场景 D] PUT 一个 folder 含自身的 tree（循环引用）');
  // 服务端会校验，但前端 state.tree 是先收到再渲染——直接污染 state
  const dResp = await Promise.race([
    page.evaluate(() => {
      const cyc = { id: 'cycle-1', type: 'folder', name: 'CYCLE', collapsed: false, children: [] };
      cyc.children.push(cyc);  // 自己包含自己
      // 直接污染 state，绕过 API
      window.state = window.state || {};
      // 这里 state 是 const，无法替换；只能想办法触发 render 用 cyc
      // 直接调用 render 不可行，因为 state.tree 是引用。我们走 PUT 看后端能否拒绝
      try {
        return fetch('/api/tree', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tree: [cyc] }),
        }).then(r => r.json()).catch(e => ({ err: e.message }));
      } catch (e) {
        return { err: e.message };
      }
    }),
    new Promise(res => setTimeout(() => res({ timeout: true }), 3000)),
  ]);
  console.log('  D 响应:', dResp);

  // ---- 场景 E：构造一个真正的循环（A.children 含 B，B.children 含 A） ----
  console.log('\n[场景 E] PUT 一个 A→B→A 的循环 tree');
  const eResp = await Promise.race([
    page.evaluate(() => {
      const A = { id: 'A', type: 'folder', name: 'A', collapsed: false, children: [] };
      const B = { id: 'B', type: 'folder', name: 'B', collapsed: false, children: [] };
      A.children.push(B);
      B.children.push(A);
      try {
        return fetch('/api/tree', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tree: [A] }),
        }).then(r => ({ status: r.status })).catch(e => ({ err: e.message }));
      } catch (e) {
        return { err: e.message };
      }
    }),
    new Promise(res => setTimeout(() => res({ timeout: true }), 3000)),
  ]);
  console.log('  E 响应:', eResp);

  // 还原
  await page.evaluate(async (tree) => {
    await fetch('/api/tree', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree }),
    });
  }, backupTree);

  console.log('\n收集到的 errors:');
  errors.forEach(e => console.log('  ' + e));
  console.log('\n总结：A 响应=' + responsive + ', B 响应=' + responsive2 + ', errors=' + errors.length);

  await browser.close();
  if (!responsive || !responsive2 || errors.length > 0) {
    process.exit(1);
  }
})();
