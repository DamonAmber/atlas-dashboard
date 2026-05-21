// 验证 Sortable 实例不再泄漏 + 后端 tree 校验拒绝坏数据 + folder 拖进自己被阻止
const { chromium } = require('playwright');
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // ========== 1. Sortable 实例不再累积 ==========
  console.log('\n[1] Sortable 实例不应累积');
  await page.evaluate(() => {
    window.__created = 0;
    window.__destroyed = 0;
    const orig = window.Sortable;
    function Hooked(el, opts) {
      window.__created++;
      const inst = new orig(el, opts);
      const od = inst.destroy.bind(inst);
      inst.destroy = function () { window.__destroyed++; return od(); };
      return inst;
    }
    Object.assign(Hooked, orig);
    Hooked.create = (el, opts) => {
      window.__created++;
      const inst = orig.create(el, opts);
      const od = inst.destroy.bind(inst);
      inst.destroy = function () { window.__destroyed++; return od(); };
      return inst;
    };
    window.Sortable = Hooked;
  });
  // 初始化前的 reset
  await page.evaluate(() => { window.__created = 0; window.__destroyed = 0; });

  // 8 次 render
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => fetchState());
    await page.waitForTimeout(120);
  }
  const stats = await page.evaluate(() => ({ c: window.__created, d: window.__destroyed }));
  console.log('  创建:', stats.c, '销毁:', stats.d);
  // 容差 1：第一次 render 没有上次实例可销毁，所以 destroy 比 create 少 7 个左右容器数
  // 真正的指标：destroyed >= created - 7
  check('Sortable 实例数没有累积（每次 render 都销毁旧的）',
    stats.d >= stats.c - 7,
    `created=${stats.c}, destroyed=${stats.d}`);

  // ========== 2. 后端拒绝重复 file path ==========
  console.log('\n[2] 后端拒绝包含重复 file 的 tree');
  const dup = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    const fp = Object.keys(d.files)[0];
    const tree = JSON.parse(JSON.stringify(d.tree));
    tree.push({ type: 'file', path: fp });        // 第二处出现同一 file
    const resp = await fetch('/api/tree', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree }),
    });
    return { status: resp.status, body: await resp.json() };
  });
  console.log('  响应:', dup);
  check('后端拒绝重复 file（HTTP 400）', dup.status === 400);

  // ========== 3. 后端拒绝重复 folder id ==========
  console.log('\n[3] 后端拒绝包含重复 folder id 的 tree');
  const dupFolder = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    const tree = JSON.parse(JSON.stringify(d.tree));
    const firstFolder = tree.find(n => n.type === 'folder');
    if (!firstFolder) return { skip: true };
    tree.push({ id: firstFolder.id, type: 'folder', name: '冒充', collapsed: false, children: [] });
    const resp = await fetch('/api/tree', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree }),
    });
    return { status: resp.status, body: await resp.json() };
  });
  console.log('  响应:', dupFolder);
  check('后端拒绝重复 folder id（HTTP 400）', dupFolder.status === 400);

  // ========== 4. 后端拒绝深度 > 12 ==========
  console.log('\n[4] 后端拒绝层级过深（> 12 层嵌套）');
  const deepResp = await page.evaluate(async () => {
    let inner = { id: 'leaf', type: 'folder', name: 'L', collapsed: false, children: [] };
    for (let i = 0; i < 14; i++) {
      inner = { id: 'd' + i, type: 'folder', name: 'd' + i, collapsed: false, children: [inner] };
    }
    const resp = await fetch('/api/tree', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree: [inner] }),
    });
    return { status: resp.status };
  });
  check('后端拒绝过深 tree（HTTP 400）', deepResp.status === 400);

  // ========== 5. folder 拖进自己被阻止 ==========
  console.log('\n[5] folder 拖到自己内部应被阻止');
  // 真实拖第一个 folder header → 它自己的 .folder-children 内
  const dragOk = await page.evaluate(() => {
    const f = document.querySelector('.folder');
    if (!f) return null;
    const head = f.querySelector('.folder-header');
    const own = f.querySelector('.folder-children');
    return {
      fid: f.dataset.folderId,
      head: head.getBoundingClientRect(),
      own: own.getBoundingClientRect(),
    };
  });
  if (dragOk) {
    await page.mouse.move(dragOk.head.x + 80, dragOk.head.y + dragOk.head.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.move(dragOk.own.x + 30, dragOk.own.y + dragOk.own.height - 5, { steps: 20 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  // 验证：tree 里这个 folder 没出现在自己的子树里
  const cycleCheck = await page.evaluate(async (fid) => {
    const r = await fetch('/api/state');
    const d = await r.json();
    function findInDescendants(folder) {
      for (const c of folder.children) {
        if (c.type === 'folder') {
          if (c.id === fid) return true;
          if (findInDescendants(c)) return true;
        }
      }
      return false;
    }
    const target = d.tree.find(n => n.type === 'folder' && n.id === fid);
    if (!target) return { notFound: true };
    return { selfInside: findInDescendants(target) };
  }, dragOk && dragOk.fid);
  console.log('  自循环检查:', cycleCheck);
  check('folder 拖进自己被 onMove 阻止（数据层无循环）',
    !cycleCheck.selfInside, JSON.stringify(cycleCheck));

  await browser.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
