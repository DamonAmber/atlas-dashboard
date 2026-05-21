// 压力测试：file 在根之后的各种连续操作
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });

  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.file');

  const backupTree = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return d.tree;
  });

  async function checkResponsive(label) {
    const r = await Promise.race([
      page.evaluate(() => new Promise(res => {
        let n = 0;
        const id = setInterval(() => { if (++n > 5) { clearInterval(id); res(true); } }, 30);
      })),
      new Promise(res => setTimeout(() => res(false), 3000)),
    ]);
    console.log(`  ${label}: ${r ? '✓ responsive' : '✗ STUCK'}`);
    return r;
  }

  // 准备：把第一个 file 放到根
  const fpath = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return Object.keys(d.files)[0];
  });
  await page.evaluate(async (fp) => {
    const r = await fetch('/api/state');
    const d = await r.json();
    function rm(nodes) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.type === 'file' && n.path === fp) { nodes.splice(i, 1); return true; }
        if (n.type === 'folder' && rm(n.children)) return true;
      }
      return false;
    }
    rm(d.tree);
    d.tree.push({ type: 'file', path: fp });
    await fetch('/api/tree', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree: d.tree }),
    });
    await fetchState();
  }, fpath);
  await page.waitForTimeout(300);

  console.log('\n[step 1] 根级 file 已就位');
  await checkResponsive('就位后');

  // 1. 把根级 file 拖回到某个 folder 内
  console.log('\n[step 2] 把根级 file 拖到第一个 folder 内');
  const t = await page.evaluate(() => {
    const f = [...document.querySelectorAll('#tree > .file')][0];
    const fr = f && f.getBoundingClientRect();
    const fol = document.querySelector('.folder-children');
    const fr2 = fol && fol.getBoundingClientRect();
    return f && fol ? { fx: fr.x + 30, fy: fr.y + fr.height / 2, tx: fr2.x + 30, ty: fr2.y + 10 } : null;
  });
  if (t) {
    await page.mouse.move(t.fx, t.fy);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.move(t.tx, t.ty, { steps: 15 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
  await checkResponsive('拖回 folder 后');

  // 2. 连续拖 10 次（随机 file/folder 间）
  console.log('\n[step 3] 连续 10 次随机拖拽（含拖到根、拖回 folder）');
  for (let i = 0; i < 10; i++) {
    const t = await page.evaluate(() => {
      const fs = [...document.querySelectorAll('.file')];
      const f = fs[Math.floor(Math.random() * fs.length)];
      if (!f) return null;
      const fr = f.getBoundingClientRect();
      const dropToRoot = Math.random() < 0.5;
      let target;
      if (dropToRoot) {
        const tr = document.getElementById('tree').getBoundingClientRect();
        target = { x: tr.x + 20, y: tr.y + tr.height - 8 };
      } else {
        const fcs = [...document.querySelectorAll('.folder-children')];
        const fc = fcs[Math.floor(Math.random() * fcs.length)];
        const tr = fc.getBoundingClientRect();
        target = { x: tr.x + 30, y: tr.y + 10 };
      }
      return { fx: fr.x + 30, fy: fr.y + fr.height / 2, tx: target.x, ty: target.y };
    });
    if (!t) break;
    await page.mouse.move(t.fx, t.fy);
    await page.mouse.down();
    await page.waitForTimeout(40);
    await page.mouse.move(t.tx, t.ty, { steps: 12 });
    await page.waitForTimeout(60);
    await page.mouse.up();
    await page.waitForTimeout(220);
  }
  await checkResponsive('10 次拖拽后');

  // 3. 拖根级 file 到自己上方再下方（同位置反复挪）
  console.log('\n[step 4] 把同一个根级 file 在根内来回挪 5 次');
  for (let i = 0; i < 5; i++) {
    const t = await page.evaluate(() => {
      const fs = [...document.querySelectorAll('#tree > .file')];
      if (!fs.length) return null;
      const f = fs[0];
      const fr = f.getBoundingClientRect();
      const tr = document.getElementById('tree').getBoundingClientRect();
      return { fx: fr.x + 30, fy: fr.y + fr.height / 2, tx: tr.x + 20, ty: tr.y + 10 };
    });
    if (!t) break;
    await page.mouse.move(t.fx, t.fy);
    await page.mouse.down();
    await page.waitForTimeout(40);
    await page.mouse.move(t.tx, t.ty, { steps: 10 });
    await page.waitForTimeout(50);
    await page.mouse.up();
    await page.waitForTimeout(180);
  }
  await checkResponsive('反复挪后');

  // 4. 拖 folder 进 folder（嵌套）
  console.log('\n[step 5] 拖一个 folder 进另一个 folder（嵌套）');
  const fres = await page.evaluate(() => {
    const fs = [...document.querySelectorAll('.folder')];
    if (fs.length < 2) return null;
    const a = fs[0].querySelector('.folder-header');
    const b = fs[1].querySelector('.folder-children') || fs[1].querySelector('.folder-header');
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return { fx: ar.x + 80, fy: ar.y + ar.height / 2, tx: br.x + 30, ty: br.y + 10 };
  });
  if (fres) {
    await page.mouse.move(fres.fx, fres.fy);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.move(fres.tx, fres.ty, { steps: 15 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await checkResponsive('嵌套 folder 后');

  // 5. 拖 folder 进自己内部（最危险的循环情况）
  console.log('\n[step 6] 拖 folder A 到 A 自己内部（自我嵌套）');
  const ses = await page.evaluate(() => {
    const f = document.querySelector('.folder');
    if (!f) return null;
    const head = f.querySelector('.folder-header');
    const own = f.querySelector('.folder-children');
    const hr = head.getBoundingClientRect();
    const or = own.getBoundingClientRect();
    return { fx: hr.x + 80, fy: hr.y + hr.height / 2, tx: or.x + 30, ty: or.y + or.height - 5 };
  });
  if (ses) {
    await page.mouse.move(ses.fx, ses.fy);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.move(ses.tx, ses.ty, { steps: 20 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
  await checkResponsive('自我嵌套尝试后');

  // 还原
  await page.evaluate(async (tree) => {
    await fetch('/api/tree', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree }),
    });
  }, backupTree);

  console.log('\nerrors:');
  errors.forEach(e => console.log('  ' + e));

  await browser.close();
  if (errors.length > 0) process.exit(1);
})();
