// 杂项加固
//
// ① 编辑备份的扩展名跟随源文件（原来硬编码 .html，.md 会被备份成 .html，
//    而且 pruneOld 只筛 .html 后缀，导致 .md 的备份永远淘汰不掉）
// ② 请求体上限：body parser 的上限必须高于路由自己的内容上限，否则路由里
//    那句"内容过大"永远走不到，用户只会看到一个含义不清的 413
// ③ /raw 路由不再依赖 app._router.stack：扫描根运行时增删后仍然正常，
//    Express 5 移除 app._router 也不会静默失效
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-misc-',
    scanRootCount: 2,
    files: {
      'proj/note.md': '# 标题\n\n正文。\n',
      'proj/page.html': '<!doctype html><html><body><h1>x</h1></body></html>',
      'proj/asset.png': 'not-a-real-png-but-served-as-bytes',
    },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  const api = (p, init) => page.evaluate(async ({ p, init }) => {
    const r = await fetch(p, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { p, init });
  const rawStatus = (p) => page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, text: (await r.text()).slice(0, 40) };
  }, p);

  // ---- ① 备份扩展名 ----
  console.log('\n[编辑备份扩展名跟随源文件]');
  const mdPath = atlas.filePath('proj/note.md');
  const src = await api('/api/md-source?path=' + encodeURIComponent(mdPath));
  const save = await api('/api/save-md', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: mdPath, baseHash: src.body.hash, content: '# 标题\n\n正文改了。\n' }),
  });
  check('保存 md 成功', save.body.ok, true);
  const backupsDir = path.join(atlas.homeDir, 'backups');
  const backups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
  check('产生了一份备份', backups.length, 1);
  check('备份用 .md 扩展名而不是 .html', backups[0].endsWith('.md'), true);
  check('备份内容是保存前的原文',
    fs.readFileSync(path.join(backupsDir, backups[0]), 'utf8'), '# 标题\n\n正文。\n');

  // HTML 编辑保存 → 备份仍然是 .html。
  // 从编辑文档里取一个真实存在的可编辑 eid，保证这次保存确实会落盘 + 备份
  const htmlPath = atlas.filePath('proj/page.html');
  const editInfo = await page.evaluate(async (p) => {
    const r = await fetch('/api/edit-doc?path=' + encodeURIComponent(p));
    const html = await r.text();
    const hash = (html.match(/name="atlas-base-hash" content="([a-f0-9]+)"/) || [])[1] || null;
    const eid = (html.match(/data-atlas-eid="(\d+)" data-atlas-role="text"/) || [])[1] || null;
    return { hash, eid: eid == null ? null : Number(eid) };
  }, htmlPath);
  check('编辑文档里取到了可编辑锚点', editInfo.eid != null, true);
  const saveHtml = await api('/api/save-edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: htmlPath, baseHash: editInfo.hash,
      ops: [{ eid: editInfo.eid, type: 'setText', text: '改过的标题' }],
    }),
  });
  check('HTML 保存成功', saveHtml.body && saveHtml.body.ok, true);
  check('改动确实写进了磁盘',
    /改过的标题/.test(fs.readFileSync(htmlPath, 'utf8')), true);
  const htmlBackups = fs.readdirSync(backupsDir).filter(f => f.startsWith('page-'));
  check('HTML 产生了备份', htmlBackups.length, 1);
  check('HTML 的备份仍用 .html', htmlBackups[0].endsWith('.html'), true);

  // ---- ② 请求体上限 ----
  console.log('\n[请求体上限]');
  // 5MB 出头：应该被路由的"内容过大"拦住，而不是 body parser 的裸 413
  const tooBig = await page.evaluate(async (p) => {
    const r = await fetch('/api/save-md', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, content: 'x'.repeat(5_200_000) }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, mdPath);
  check('超过 5MB 的内容被拒', tooBig.status, 400);
  check('给出的是可读的中文提示', tooBig.body && tooBig.body.error, '内容过大');

  // 超过 body parser 上限（8MB）时也要是 JSON 而不是 HTML 错误页
  const wayTooBig = await page.evaluate(async (p) => {
    const r = await fetch('/api/save-md', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, content: 'x'.repeat(9_000_000) }),
    });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, isJson: ct.includes('json'), body: await r.json().catch(() => null) };
  }, mdPath);
  check('超过 body 上限返回 413', wayTooBig.status, 413);
  check('413 也是 JSON 响应', wayTooBig.isJson, true);
  check('413 带可读说明', /8MB/.test((wayTooBig.body && wayTooBig.body.error) || ''), true);

  // 非法 JSON
  const badJson = await page.evaluate(async () => {
    const r = await fetch('/api/save-md', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, isJson: ct.includes('json') };
  });
  check('非法 JSON 返回 400', badJson.status, 400);
  check('非法 JSON 也是 JSON 响应', badJson.isJson, true);

  // ---- ③ /raw 路由 ----
  console.log('\n[/raw 路由不依赖 Express 内部结构]');
  check('root 0 的 html 可取', (await rawStatus('/raw/0/proj/page.html')).status, 200);
  check('root 0 的二进制资源可取', (await rawStatus('/raw/0/proj/asset.png')).status, 200);
  check('不存在的序号不会 500', (await rawStatus('/raw/99/proj/page.html')).status, 404);
  check('缺序号不会 500', (await rawStatus('/raw/')).status, 404);
  check('非数字序号不会 500', (await rawStatus('/raw/abc/x.html')).status, 404);

  // 第二个扫描根
  fs.writeFileSync(path.join(atlas.scanDirs[1], 'second.html'),
    '<!doctype html><html><body><h1>第二个根</h1></body></html>');
  await page.evaluate(() => fetch('/api/state'));
  check('root 1 的文件可取', (await rawStatus('/raw/1/second.html')).status, 200);

  // 运行时增删扫描根后仍然正常（这是原来 splice app._router.stack 想解决的场景）
  const extra = atlas.makeDir('extra-root');
  fs.writeFileSync(path.join(extra, 'extra.html'),
    '<!doctype html><html><body><h1>额外</h1></body></html>');
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanRoots: [...atlas.scanDirs, extra] }),
  });
  await new Promise(r => setTimeout(r, 400));
  check('新增扫描根后 /raw/2 可用', (await rawStatus('/raw/2/extra.html')).status, 200);
  check('原有扫描根仍然可用', (await rawStatus('/raw/0/proj/page.html')).status, 200);

  // 移除中间那个扫描根，序号重排后仍然一致
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanRoots: [atlas.scanDirs[0], extra] }),
  });
  await new Promise(r => setTimeout(r, 400));
  check('移除扫描根后 /raw/1 指向新的第二个根',
    (await rawStatus('/raw/1/extra.html')).status, 200);
  check('被移除的根不再可访问',
    (await rawStatus('/raw/2/second.html')).status, 404);

  // 路径穿越
  const escape = await page.evaluate(async () => {
    const r = await fetch('/raw/0/..%2F..%2Fhome%2Fstore.json');
    return r.status;
  });
  check('/raw 下的路径穿越被拒', escape >= 400, true);

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
