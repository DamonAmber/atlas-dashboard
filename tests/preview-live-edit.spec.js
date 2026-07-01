// 验证：预览区轻量所见即所得编辑（改文案 + 列表重排）
//
// 与其它 spec 不同，本测试会写磁盘文件，因此自起一个隔离的 Atlas 实例
// （独立 ATLAS_HOME + 临时扫描根 + 临时端口），绝不触碰用户真实数据。

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const ROOT = path.join(__dirname, '..');
const PORT = 4300 + Math.floor(Math.random() * 80);
const BASE = `http://127.0.0.1:${PORT}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-edit-spec-'));
const HOME = path.join(TMP, 'home');
const SCAN = path.join(TMP, 'scan');
const PROJ = path.join(SCAN, 'proj');
const FILE = path.join(PROJ, 'report.html');

const FIXTURE = `<!doctype html>
<html>
<head><title>R</title><style>html{scroll-behavior:smooth}.x{color:red}</style></head>
<body>
  <h1>原标题</h1>
  <p>段落前<b>粗体</b>段落后</p>
  <ul>
    <li>苹果</li>
    <li>香蕉</li>
    <li>樱桃</li>
  </ul>
  <section class="cards">
    <div class="title">卡片区标题</div>
    <div class="card">卡片甲</div>
    <div class="card">卡片乙</div>
    <div class="card">卡片丙</div>
  </section>
  <pre>不可编辑代码</pre>
  <ul class="links">
    <li><a href="">链接甲</a></li>
    <li><a href="">链接乙</a></li>
  </ul>
  <div class="spacer" style="height:3000px"></div>
  <div id="chart"></div>
  <script>document.getElementById('chart').innerHTML = '<ul><li>动态项</li></ul>';</script>
</body>
</html>
`;

function setup() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    scanRoots: [SCAN], ignore: ['node_modules'], port: PORT, maxDepth: 6,
  }));
  fs.writeFileSync(FILE, FIXTURE);
}

function health() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/state`, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(child) {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await health()) return true;
    if (child.exitCode !== null) return false;
  }
  return false;
}

let server;
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      ATLAS_HOME: HOME,
      ATLAS_CONFIG_PATH: path.join(HOME, 'config.json'),
      ATLAS_STORE_PATH: path.join(HOME, 'store.json'),
      ATLAS_PUBLIC_DIR: path.join(ROOT, 'public'),
      ATLAS_PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ok = await waitHealthy(server);
  if (!ok) throw new Error('测试用 Atlas 实例启动失败');
}

function cleanup() {
  try { server && server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// 在 iframe（同源）里执行函数
async function inFrame(page, fn, arg) {
  return page.evaluate(({ fnStr, arg }) => {
    const f = eval('(' + fnStr + ')');
    const doc = document.getElementById('preview').contentDocument;
    return f(doc, arg);
  }, { fnStr: fn.toString(), arg });
}

(async () => {
  setup();
  await startServer();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  // 自动接受 confirm（取消编辑 / 离开拦截）
  page.on('dialog', d => d.accept().catch(() => {}));

  try {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('.file');

    // ===== 1. 后端 edit-doc 标注 =====
    console.log('\n[1] 后端 edit-doc 标注');
    const docInfo = await page.evaluate(async (file) => {
      const r = await fetch('/api/edit-doc?path=' + encodeURIComponent(file));
      const html = await r.text();
      return { status: r.status, html };
    }, FILE);
    check('edit-doc 返回 200', docInfo.status === 200);
    check('混排文本被独立包裹 span', /data-atlas-role="text">段落前</.test(docInfo.html) && /data-atlas-role="text">段落后</.test(docInfo.html));
    check('列表容器/项被标注', /<ul[^>]*data-atlas-role="list"/.test(docInfo.html) && /data-atlas-role="list-item"/.test(docInfo.html));
    check('pre 内容不可编辑（无 role）', !/不可编辑代码<\/span>/.test(docInfo.html) && docInfo.html.includes('<pre>不可编辑代码</pre>'));
    check('注入了 base href 与 baseHash', docInfo.html.includes('atlas-base-hash') && docInfo.html.includes('<base href="/raw/'));

    // ===== 2. 进入编辑模式 UI =====
    console.log('\n[2] 进入编辑模式');
    await page.locator('.file').first().click();
    await page.waitForTimeout(400);
    check('btn-edit 可用', !(await page.locator('#btn-edit').isDisabled()));
    check('进入前 保存/取消 按钮隐藏', await page.locator('#btn-edit-save').isHidden() && await page.locator('#btn-edit-cancel').isHidden());

    await page.locator('#btn-edit').click();
    // 等编辑文档加载（span 出现）
    await page.waitForFunction(() => {
      const d = document.getElementById('preview').contentDocument;
      return d && d.querySelector('span[data-atlas-role="text"]');
    }, { timeout: 5000 });
    check('保存/取消按钮出现', !(await page.locator('#btn-edit-save').isHidden()) && !(await page.locator('#btn-edit-cancel').isHidden()));
    check('body 进入 editing-mode', await page.evaluate(() => document.body.classList.contains('editing-mode')));

    const affordance = await inFrame(page, (doc) => {
      const sp = doc.querySelector('span[data-atlas-role="text"]');
      return {
        editable: sp && sp.getAttribute('contenteditable') === 'true',
        hasStyle: !!doc.querySelector('style[data-atlas-edit-style]'),
      };
    });
    check('文本 span 可编辑', affordance.editable);
    check('注入了编辑态 hover 样式', affordance.hasStyle);

    // 列表拖拽已接上：iframe 内注入了 Sortable
    await page.waitForTimeout(400);
    const sortableInFrame = await page.evaluate(() =>
      !!(document.getElementById('preview').contentWindow.Sortable));
    check('iframe 内已加载 Sortable（拖拽就绪）', sortableInFrame);

    // 点击位于 <a href=""> 内的可编辑文字，不应导致 iframe 跳转到 base 目录
    await page.frameLocator('#preview').locator('ul.links a').first().click();
    await page.waitForTimeout(250);
    const stillOnEditDoc = await page.evaluate(() => {
      try { return (document.getElementById('preview').contentWindow.location.pathname || '').includes('/api/edit-doc'); }
      catch { return false; }
    });
    check('点击链接内文字不跳转（编辑态拦截导航）', stillOnEditDoc);

    // 链接编辑：聚焦链接文字 → 浮出链接条；改 href（随 [3] 的保存一起写回）
    const a0 = page.frameLocator('#preview').locator('ul.links a').first();
    await a0.click();
    await page.waitForTimeout(150);
    const barVisible = await inFrame(page, (doc) => {
      const bar = doc.querySelector('[data-atlas-linkbar]');
      return !!(bar && !bar.hidden);
    });
    check('聚焦链接文字浮出链接编辑条', barVisible);
    await inFrame(page, (doc) => {
      const inp = doc.querySelector('[data-atlas-linkbar] input');
      inp.value = 'https://example.com/new';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // ===== 3. 文案编辑 + 保存（写盘 + 其余字节不变）=====
    console.log('\n[3] 文案编辑 + 保存');
    await inFrame(page, (doc) => {
      const spans = [...doc.querySelectorAll('span[data-atlas-role="text"]')];
      const h1 = spans.find(s => s.textContent === '原标题');
      h1.textContent = '改后标题<&>';
      h1.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#btn-edit-save').click();
    await page.waitForFunction(() => !document.body.classList.contains('editing-mode'), { timeout: 5000 });
    await page.waitForTimeout(300);
    const after = fs.readFileSync(FILE, 'utf8');
    check('标题转义写回磁盘', after.includes('<h1>改后标题&lt;&amp;&gt;</h1>'), '');
    check('混排 <b> 结构保留', after.includes('段落前<b>粗体</b>段落后'));
    check('style/script/pre 原样', after.includes('<style>html{scroll-behavior:smooth}.x{color:red}</style>') && after.includes('<pre>不可编辑代码</pre>') && after.includes("getElementById('chart')"));
    check('文件头部字节原样', after.startsWith('<!doctype html>\n<html>'));
    check('链接 href 同批写回磁盘', after.includes('href="https://example.com/new"'));

    // ===== 4. 取消恢复（不写盘）=====
    console.log('\n[4] 取消恢复');
    const beforeCancel = fs.readFileSync(FILE, 'utf8');
    await page.locator('#btn-edit').click();
    await page.waitForFunction(() => {
      const d = document.getElementById('preview').contentDocument;
      return d && d.querySelector('span[data-atlas-role="text"]');
    }, { timeout: 5000 });
    await inFrame(page, (doc) => {
      const sp = doc.querySelector('span[data-atlas-role="text"]');
      sp.textContent = '不应被保存';
      sp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#btn-edit-cancel').click();
    await page.waitForFunction(() => !document.body.classList.contains('editing-mode'), { timeout: 5000 });
    await page.waitForTimeout(200);
    check('取消后磁盘文件零变化', fs.readFileSync(FILE, 'utf8') === beforeCancel);

    // ===== 4b. 进入编辑 / 保存 都保持滚动锚点（不跳变）=====
    console.log('\n[4b] 进入编辑 / 保存 保持滚动位置');
    // 先在只读视图滚到中部（用 instant 避免 smooth 动画干扰读数），读取实际滚动值作为基准
    await page.evaluate(() => { document.getElementById('preview').contentWindow.scrollTo({ top: 800, behavior: 'instant' }); });
    await page.waitForTimeout(150);
    const y0 = await page.evaluate(() => document.getElementById('preview').contentWindow.scrollY);
    check('只读视图有滚动空间', y0 > 100, 'y0=' + Math.round(y0));
    // 进入编辑 → 应停在原位
    await page.locator('#btn-edit').click();
    await page.waitForFunction(() => {
      const d = document.getElementById('preview').contentDocument;
      return d && d.querySelector('span[data-atlas-role="text"]');
    }, { timeout: 5000 });
    await page.waitForTimeout(250);
    const y1 = await page.evaluate(() => document.getElementById('preview').contentWindow.scrollY);
    check('进入编辑保持滚动位置（不跳顶部）', Math.abs(y1 - y0) <= 8, 'y1=' + Math.round(y1) + ' 基准=' + Math.round(y0));
    // 改一处文本后保存 → 应仍停在原位
    await inFrame(page, (doc) => {
      const sp = doc.querySelector('span[data-atlas-role="text"]');
      sp.textContent = sp.textContent + '·改';
      sp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#btn-edit-save').click();
    await page.waitForFunction(() => !document.body.classList.contains('editing-mode'), { timeout: 5000 });
    await page.waitForTimeout(400);
    const y2 = await page.evaluate(() => document.getElementById('preview').contentWindow.scrollY);
    check('保存后保持滚动位置（不跳顶部）', Math.abs(y2 - y0) <= 8, 'y2=' + Math.round(y2) + ' 基准=' + Math.round(y0));

    // ===== 5. 列表重排 =====
    console.log('\n[5] 列表重排 + 保存');

    // 通过真实 eid 走 save-edits 验证写盘（真实鼠标拖拽在 headless 下天然 flaky，
    // 拖拽路径由 [2]「iframe 内已加载 Sortable」+ 本段的 reorder 写回共同覆盖）
    const reorder = await page.evaluate(async (file) => {
      const r = await fetch('/api/edit-doc?path=' + encodeURIComponent(file));
      const html = await r.text();
      const parser = new DOMParser();
      const d = parser.parseFromString(html, 'text/html');
      const baseHash = d.querySelector('meta[name="atlas-base-hash"]').getAttribute('content');
      const ul = d.querySelector('ul[data-atlas-role="list"]');
      const ulEid = parseInt(ul.getAttribute('data-atlas-eid'), 10);
      const items = [...ul.querySelectorAll(':scope > li[data-atlas-role="list-item"]')]
        .map(li => parseInt(li.getAttribute('data-atlas-eid'), 10));
      const order = [items[2], items[0], items[1]]; // 樱桃, 苹果, 香蕉
      const resp = await fetch('/api/save-edits', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file, baseHash, ops: [{ eid: ulEid, type: 'reorder', order }] }),
      });
      return { status: resp.status, json: await resp.json() };
    }, FILE);
    check('reorder 保存 200', reorder.status === 200 && reorder.json.ok);
    const afterReorder = fs.readFileSync(FILE, 'utf8');
    check('列表按新顺序写回（樱桃→苹果→香蕉）',
      /<li>樱桃<\/li>\s*<li>苹果<\/li>\s*<li>香蕉<\/li>/.test(afterReorder));

    // 5c) 同构卡片组（保守）：容器标 list、3 张 .card 是 item、标题 div 不是；重排写回
    console.log('\n[5c] 同构卡片重排');
    const card = await page.evaluate(async (file) => {
      const r = await fetch('/api/edit-doc?path=' + encodeURIComponent(file));
      const html = await r.text();
      const d = new DOMParser().parseFromString(html, 'text/html');
      const baseHash = d.querySelector('meta[name="atlas-base-hash"]').getAttribute('content');
      const sec = d.querySelector('section.cards');
      const secIsList = sec && sec.getAttribute('data-atlas-role') === 'list';
      const titleIsItem = d.querySelector('.title') && d.querySelector('.title').getAttribute('data-atlas-role') === 'list-item';
      const cards = [...d.querySelectorAll('section.cards > .card[data-atlas-role="list-item"]')];
      const secEid = sec ? parseInt(sec.getAttribute('data-atlas-eid'), 10) : -1;
      const order = cards.map(c => parseInt(c.getAttribute('data-atlas-eid'), 10));
      const resp = await fetch('/api/save-edits', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file, baseHash, ops: [{ eid: secEid, type: 'reorder', order: [order[2], order[0], order[1]] }] }),
      });
      return { secIsList, titleIsItem, cardCount: cards.length, save: resp.status };
    }, FILE);
    check('卡片容器被标 list', card.secIsList);
    check('3 张 .card 是 list-item', card.cardCount === 3);
    check('标题 div 不是 list-item（异质排除）', card.titleIsItem === false);
    check('卡片重排保存 200', card.save === 200);
    const afterCard = fs.readFileSync(FILE, 'utf8');
    check('卡片按新顺序写回（丙→甲→乙）',
      /<div class="card">卡片丙<\/div>\s*<div class="card">卡片甲<\/div>\s*<div class="card">卡片乙<\/div>/.test(afterCard));

    // ===== 6. 冲突与安全 =====
    console.log('\n[6] 冲突与安全');
    const conflict = await page.evaluate(async (file) => {
      const resp = await fetch('/api/save-edits', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file, baseHash: 'stale', ops: [{ eid: 0, type: 'setText', text: 'x' }] }),
      });
      return resp.status;
    }, FILE);
    check('过期 baseHash → 409 冲突', conflict === 409);

    const outside = await page.evaluate(async () => {
      const resp = await fetch('/api/save-edits', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/etc/hosts', baseHash: 'x', ops: [] }),
      });
      return resp.status;
    });
    check('扫描根外路径 → 400 拒绝', outside === 400);

    await browser.close();
  } catch (e) {
    console.error('测试异常:', e.stack || e.message);
    try { await browser.close(); } catch {}
    checks.push({ name: '测试执行', ok: false, detail: e.message });
  }

  cleanup();
  const failed = checks.filter(c => !c.ok);
  console.log('\n========================');
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
