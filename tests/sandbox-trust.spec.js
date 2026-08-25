// HTML 预览沙箱与信任分级
//
// 要解决的问题：预览用的是同源 iframe，而里面那份 HTML 是 AI 写的。同源意味着
// 它的脚本能 fetch("/api/save-md")、能开局域网分享链接、能读扫描根配置——
// 一篇文档因此可以改写磁盘上别的文档。
//
// 现在默认沙箱（保留 allow-scripts，图表照样画，但不给 allow-same-origin），
// 用户显式信任某一篇之后才切回同源，把注入类能力（预览内编辑、正文高亮、
// 快捷键转发）交还给它。
//
// 本 spec 钉住的点：
//   ① HTML 默认带 sandbox 且不含 allow-same-origin
//   ② 沙箱里的文档确实拿不到 Atlas 的数据（读父页面、读接口、写接口都失败）
//   ③ allow-scripts 仍在：文档自己的脚本要能跑，否则一屏图表全空
//   ④ 点信任 → 切同源、持久化到 store、刷新后仍然有效
//   ⑤ Atlas 自己渲染的预览页（md / csv / json / txt / svg）不该被沙箱化——
//      那些内容已经全部转义过，沙箱只会白白砍掉滚动恢复和正文高亮
//   ⑥ 写类接口的 Origin 校验：沙箱文档的 Origin 是字面量 null，必须挡住。
//      这是沙箱之外的第二道锁，将来哪条路径漏了 sandbox 属性也不至于能写盘
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas, autoAcceptDialogs } = require('./helpers/isolated-atlas');

// 一进来就试着调 Atlas 接口的文档，把结果写进 DOM 供断言读取
const PROBE_HTML = `<!doctype html><html><head><title>probe</title></head><body>
<h1>报告</h1><p>正文关键词 needle 在这里。</p>
<pre id="out">pending</pre>
<script>
  window.__scriptsRan = true;
  (async () => {
    const r = { parentDom: null, apiRead: null, apiWrite: null };
    try { r.parentDom = !!window.parent.document; } catch (e) { r.parentDom = 'blocked'; }
    try {
      const res = await fetch('/api/state');
      const j = await res.json();
      r.apiRead = 'ok:' + Object.keys(j.files || {}).length;
    } catch (e) { r.apiRead = 'blocked'; }
    try {
      const res = await fetch('/api/trust', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'whatever', trusted: true }),
      });
      r.apiWrite = 'status:' + res.status;
    } catch (e) { r.apiWrite = 'blocked'; }
    document.getElementById('out').textContent = JSON.stringify(r);
  })();
</script>
</body></html>`;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

// 沙箱下宿主读不到 contentDocument，只能从 frame 侧读
async function readProbe(page) {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      try {
        const t = await f.$eval('#out', el => el.textContent);
        if (t && t !== 'pending') return JSON.parse(t);
      } catch {}
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-sandbox-',
    files: {
      'proj/probe.html': PROBE_HTML,
      'proj/note.md': '# 笔记\n\n正文。\n',
      'proj/data.csv': 'a,b\n1,2\n',
    },
    config: { docTypes: ['html', 'md', 'csv'] },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await autoAcceptDialogs(page);
  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  // ---- ① 默认沙箱 ----
  console.log('\n[默认沙箱]');
  await page.click('.file[data-path$="probe.html"] .file-name');
  await page.waitForTimeout(1200);
  const s = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    const sb = ifr.getAttribute('sandbox') || '';
    return {
      hasSandbox: !!sb,
      allowsScripts: sb.includes('allow-scripts'),
      allowsSameOrigin: sb.includes('allow-same-origin'),
      hostCanReadDoc: (() => { try { return !!ifr.contentDocument; } catch { return 'throw'; } })(),
      trustBtnVisible: !document.getElementById('btn-trust').classList.contains('hidden'),
      trustPressed: document.getElementById('btn-trust').getAttribute('aria-pressed'),
    };
  });
  check('HTML 预览带 sandbox', s.hasSandbox, true);
  check('保留 allow-scripts（图表还得能画）', s.allowsScripts, true);
  check('不给 allow-same-origin（否则文档能自己摘掉沙箱）', s.allowsSameOrigin, false);
  check('宿主也读不到 contentDocument（这就是能力降级的代价）', s.hostCanReadDoc, false);
  check('顶栏出现信任开关', s.trustBtnVisible, true);
  check('开关处于未信任态', s.trustPressed, 'false');

  const probe = await readProbe(page);
  check('文档自己的脚本照常执行', !!probe, true);
  check('读不到父页面 DOM', probe && probe.parentDom, 'blocked');
  check('读不到 Atlas 接口', probe && probe.apiRead, 'blocked');
  check('写不了 Atlas 接口', probe && probe.apiWrite, 'blocked');

  // ---- ② Atlas 自己渲染的预览页不沙箱化 ----
  console.log('\n[自渲染页面不沙箱]');
  for (const [sel, label] of [['note.md', 'Markdown'], ['data.csv', 'CSV']]) {
    await page.click(`.file[data-path$="${sel}"] .file-name`);
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => ({
      sandbox: document.getElementById('preview').getAttribute('sandbox'),
      canRead: (() => { try { return !!document.getElementById('preview').contentDocument; } catch { return false; } })(),
      trustHidden: document.getElementById('btn-trust').classList.contains('hidden'),
    }));
    check(`${label} 预览页不加沙箱`, r.sandbox, null);
    check(`${label} 预览页仍可注入增强（滚动恢复 / 正文高亮）`, r.canRead, true);
    check(`${label} 不显示信任开关（没有这回事）`, r.trustHidden, true);
  }

  // ---- ③ 点信任 → 切同源 ----
  console.log('\n[信任之后]');
  await page.click('.file[data-path$="probe.html"] .file-name');
  await page.waitForTimeout(900);
  await page.click('#btn-trust');
  await page.waitForTimeout(2000);
  const t = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    return {
      sandbox: ifr.getAttribute('sandbox'),
      canRead: (() => { try { return !!ifr.contentDocument; } catch { return false; } })(),
      pressed: document.getElementById('btn-trust').getAttribute('aria-pressed'),
      editEnabled: !document.getElementById('btn-edit').disabled,
    };
  });
  check('sandbox 属性被移除', t.sandbox, null);
  check('宿主恢复对文档的访问（编辑 / 高亮 / 快捷键桥靠它）', t.canRead, true);
  check('开关变成已信任态', t.pressed, 'true');
  check('编辑按钮可用', t.editEnabled, true);
  const probe2 = await readProbe(page);
  check('同源后文档确实能读到接口（这正是「信任」的含义）',
    !!(probe2 && String(probe2.apiRead).startsWith('ok:')), true);

  const store = atlas.readStore();
  check('信任记录落盘',
    Object.keys(store.trusted || {}).map(p => path.basename(p)), ['probe.html']);

  // ---- ④ 刷新后仍然有效 ----
  console.log('\n[刷新后]');
  await page.reload();
  await page.waitForSelector('.file');
  await page.click('.file[data-path$="probe.html"] .file-name');
  await page.waitForTimeout(1200);
  check('重新加载 dashboard 后依然是信任态',
    await page.evaluate(() => document.getElementById('preview').getAttribute('sandbox')), null);

  // ---- ⑤ 收回信任 ----
  console.log('\n[收回信任]');
  await page.click('#btn-trust');
  await page.waitForTimeout(1500);
  check('又回到沙箱',
    await page.evaluate(() => !!document.getElementById('preview').getAttribute('sandbox')), true);
  check('store 里的记录也清了',
    Object.keys(atlas.readStore().trusted || {}).length, 0);

  // ---- ⑥ Origin 校验（沙箱之外的第二道锁）----
  console.log('\n[Origin 校验]');
  const target = atlas.filePath('proj/note.md');
  const post = (origin) => fetch(atlas.base + '/api/favorite', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, origin ? { Origin: origin } : {}),
    body: JSON.stringify({ path: target, favorite: true }),
  });
  check('Origin 为 null（沙箱文档发出的）被拒', (await post('null')).status, 403);
  check('别的站点被拒', (await post('https://evil.example')).status, 403);
  check('本机另一个端口的页面也被拒', (await post('http://localhost:1')).status, 403);
  check('dashboard 自己的 Origin 放行', (await post(atlas.base)).status, 200);
  // CLI / 测试脚本 / curl 不带 Origin：放行，否则命令行工具全废
  check('不带 Origin 的请求放行（curl 与 CLI 走这条）', (await post(null)).status, 200);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(failures === 0 ? '总计 全部通过' : `总计 ${failures} 项未通过`);
  if (failures > 0) process.exit(1);
})();
