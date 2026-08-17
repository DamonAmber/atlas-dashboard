// 局域网分享的安全边界
//
// 原来 /share/:token/* 服务的是「被分享文件所在目录的整棵子树」——
// resolveSharedPath 只防住 ../ 越界，没防住同目录的其它文件。分享
// ~/Documents/report.html 等于把整个 ~/Documents/ 开放给拿到 token 的人。
// 而且 token 永不过期、跨重启保留，与 README 说的"暂时发布"不符。
//
// 本 spec 检查：
//   ① 默认范围只放行文档真正引用到的资源（图片 / CSS / CSS 里的 url() / md 图片）
//   ② 同目录下未被引用的敏感文件返回 403
//   ③ 显式切到 scope=dir 后同目录全开（给动态拼路径的页面留的逃生口）
//   ④ 路径穿越仍然被拦
//   ⑤ 有效期：到期后链接失效（410），/api/shares 会清理过期条目
//   ⑥ 编辑文档新增引用后，白名单按 mtime 失效并放行新资源
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');
const shareLib = require(path.join(ROOT, 'lib/share.js'));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const REPORT_HTML = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<link rel="stylesheet" href="assets/style.css">',
  '</head><body>',
  '<h1>报告</h1>',
  '<img src="assets/logo.png" alt="logo">',
  '<script src="assets/app.js"></script>',
  '</body></html>',
].join('\n');

(async () => {
  // ---- 先单测白名单构造（纯函数，不需要起服务）----
  console.log('\n[白名单抽取]');
  const htmlRefs = [...shareLib.extractHtmlRefs(REPORT_HTML)].sort();
  check('抽出 html 里的 link/img/script 引用', htmlRefs,
    ['assets/app.js', 'assets/logo.png', 'assets/style.css']);
  check('绝对 URL 不进白名单',
    [...shareLib.extractHtmlRefs('<img src="https://x.com/a.png"><img src="/abs.png">')], []);
  check('data URL 不进白名单',
    [...shareLib.extractHtmlRefs('<img src="data:image/png;base64,AAA">')], []);
  check('抽出 css 里的 url()',
    [...shareLib.extractCssRefs('body{background:url("img/bg.jpg")}')], ['img/bg.jpg']);
  check('抽出 srcset',
    [...shareLib.extractHtmlRefs('<img srcset="a.png 1x, b.png 2x">')].sort(), ['a.png', 'b.png']);
  check('抽出 md 图片引用',
    [...shareLib.extractMarkdownRefs('![x](pics/a.png) 和 [y](docs/b.md)')].sort(),
    ['docs/b.md', 'pics/a.png']);
  check('越界引用被丢掉',
    [...shareLib.extractHtmlRefs('<img src="../../etc/passwd">')], []);
  check('过期判定：无 expiresAt 视为不过期', shareLib.isExpired({ expiresAt: null }), false);
  check('过期判定：已到时间', shareLib.isExpired({ expiresAt: Date.now() - 1000 }), true);

  // ---- 起隔离实例做端到端 ----
  const atlas = await startAtlas({
    prefix: 'atlas-sharesec-',
    files: {
      'proj/report.html': REPORT_HTML,
      'proj/assets/style.css': 'body{background:url("bg.png")}',
      'proj/assets/bg.png': PNG,
      'proj/assets/logo.png': PNG,
      'proj/assets/app.js': 'console.log(1);',
      // 同目录下没有被引用的东西——这就是原来会被顺带暴露的部分
      'proj/private-notes.html': '<!doctype html><html><body>内部备注：薪资表</body></html>',
      'proj/secrets/creds.html': '<!doctype html><html><body>token=abc</body></html>',
      'proj/pic-note.md': '# 图\n\n![图](assets/logo.png)\n',
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
  // 分享链接要以"外部访客"身份访问：不带 cookie 也不经过 dashboard 页面
  const fetchShare = (url) => page.evaluate(async (u) => {
    const r = await fetch(u, { redirect: 'follow' });
    return { status: r.status, len: (await r.text()).length };
  }, url);

  const startShare = (relPath, opts = {}) => api('/api/share/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: atlas.filePath(relPath), ...opts }),
  });

  // ---- ① 默认范围：只放行引用到的资源 ----
  console.log('\n[默认范围 = 仅引用到的资源]');
  const s = await startShare('proj/report.html');
  check('创建分享成功', s.status, 200);
  const token = s.body.token;
  check('默认 scope 是 refs', s.body.scope, 'refs');
  check('默认带有效期', typeof s.body.expiresAt, 'number');

  check('入口文档可访问', (await fetchShare(`/share/${token}/report.html`)).status, 200);
  check('被引用的 CSS 可访问', (await fetchShare(`/share/${token}/assets/style.css`)).status, 200);
  check('被引用的图片可访问', (await fetchShare(`/share/${token}/assets/logo.png`)).status, 200);
  check('被引用的脚本可访问', (await fetchShare(`/share/${token}/assets/app.js`)).status, 200);
  check('CSS 里 url() 引用的图片也可访问（跟一层）',
    (await fetchShare(`/share/${token}/assets/bg.png`)).status, 200);

  // ---- ② 未被引用的同目录文件被拒 ----
  console.log('\n[同目录未引用的文件被拒]');
  check('同目录未引用的 html → 403',
    (await fetchShare(`/share/${token}/private-notes.html`)).status, 403);
  check('子目录未引用的 html → 403',
    (await fetchShare(`/share/${token}/secrets/creds.html`)).status, 403);
  check('同目录未引用的 md → 403',
    (await fetchShare(`/share/${token}/pic-note.md`)).status, 403);

  // ---- ③ 路径穿越仍被拦 ----
  console.log('\n[路径穿越]');
  const traversal = await page.evaluate(async (t) => {
    // 绕过 fetch 的 URL 规范化，直接打编码过的 ../
    const r = await fetch(`/share/${t}/..%2F..%2Fhome%2Fconfig.json`);
    return r.status;
  }, token);
  check('编码后的 ../ 越界被拒', traversal >= 400, true);

  // ---- ④ 显式切到 scope=dir ----
  console.log('\n[显式切到同目录全开]');
  const sDir = await startShare('proj/report.html', { scope: 'dir' });
  check('复用同一个 token（URL 不变）', sDir.body.token, token);
  check('scope 已更新', sDir.body.scope, 'dir');
  check('切到 dir 后未引用的文件可访问',
    (await fetchShare(`/share/${token}/private-notes.html`)).status, 200);
  // 切回来
  await startShare('proj/report.html', { scope: 'refs' });
  check('切回 refs 后重新被拒',
    (await fetchShare(`/share/${token}/private-notes.html`)).status, 403);

  // ---- ⑤ md 分享的白名单 ----
  console.log('\n[Markdown 分享]');
  const sMd = await startShare('proj/pic-note.md');
  const mdToken = sMd.body.token;
  check('md 入口可访问', (await fetchShare(`/share/${mdToken}/pic-note.md`)).status, 200);
  check('md 里引用的图片可访问',
    (await fetchShare(`/share/${mdToken}/assets/logo.png`)).status, 200);
  check('md 没引用的文件被拒',
    (await fetchShare(`/share/${mdToken}/private-notes.html`)).status, 403);

  // ---- ⑥ 白名单按 mtime 失效 ----
  console.log('\n[编辑后白名单刷新]');
  check('新图片一开始不在白名单',
    (await fetchShare(`/share/${token}/assets/extra.png`)).status, 403);
  fs.writeFileSync(atlas.filePath('proj/assets/extra.png'), PNG);
  await new Promise(r => setTimeout(r, 1100));   // 确保 mtime 变化可辨
  fs.writeFileSync(atlas.filePath('proj/report.html'),
    REPORT_HTML.replace('</body>', '<img src="assets/extra.png"></body>'));
  await new Promise(r => setTimeout(r, 600));
  check('文档新增引用后，新图片被放行',
    (await fetchShare(`/share/${token}/assets/extra.png`)).status, 200);

  // ---- ⑦ 有效期 ----
  console.log('\n[有效期]');
  const never = await startShare('proj/report.html', { ttlMinutes: 0 });
  check('可以选择不过期', never.body.expiresAt, null);
  check('不过期的链接可访问', (await fetchShare(`/share/${token}/report.html`)).status, 200);

  // 直接改 store 把它设成已过期，验证服务端拒绝
  const storePath = atlas.storePath;
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  store.shares[token].expiresAt = Date.now() - 60_000;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  check('过期后入口返回 410', (await fetchShare(`/share/${token}/report.html`)).status, 410);
  check('过期后 /share/:token 也返回 410', (await fetchShare(`/share/${token}`)).status, 410);
  check('过期后资源同样不可访问',
    (await fetchShare(`/share/${token}/assets/logo.png`)).status, 410);

  const shares = await api('/api/shares');
  const tokens = (shares.body.shares || []).map(x => x.token);
  check('/api/shares 不再列出过期条目', tokens.includes(token), false);
  const storeAfter = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  check('过期条目已从 store.json 清理', Object.keys(storeAfter.shares).includes(token), false);
  check('/api/shares 返回可选有效期档位', shares.body.ttlChoices, [0, 30, 120, 1440]);

  // ---- ⑧ 不存在的 token ----
  check('伪造 token 返回 410', (await fetchShare('/share/deadbeefdeadbeef/report.html')).status, 410);

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
