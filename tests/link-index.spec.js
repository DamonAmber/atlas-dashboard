// 引用关系索引（lib/link-index.js，design §10.9）+ GET /api/links
//
// node 段：相对路径、../、编码路径、根外路径、外链、锚点 / query、代码块与行内代码里的假链接、
//   引用式定义、HTML <a href>、file://、目录 index（index.html / README.md）、自引用、去重、
//   每文件 200 条与全局上限截断、目标不存在时查询期过滤、mtime 变化触发重解析、
//   unlink 删除条目、缓存写盘与复用、缓存损坏 warn 一次并重建
// 接口段（startAtlas）：GET /api/links 形状、no-store、跨站 403、改文件后 version 递增
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const L = require('../lib/link-index');
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
function listDocs(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(md|html?|csv)$/i.test(e.name)) out.push(f);
    }
  };
  walk(dir);
  return out;
}
// 快照 → { 源相对路径: [目标相对路径…] }
function edgesOf(snap, root) {
  const out = {};
  for (const [s, d] of snap.edges) {
    const a = path.relative(root, snap.paths[s]), b = path.relative(root, snap.paths[d]);
    (out[a] = out[a] || []).push(b);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

async function nodeSection() {
  console.log('\n[纯函数] href 抽取');
  const md = [
    '[a](a.md) [b](<with space.md> "标题") ![图](pic.png)',
    '`[假](inline.md)` 和 ``[也假](inline2.md)``',
    '```',
    '[围栏里的假链接](fence.md)',
    '```',
    '~~~js',
    '[波浪围栏](tilde.md)',
    '~~~',
    '[ref]: ref.md',
    '   [ref2]: <ref two.md>',
  ].join('\n');
  check('MD：内联 + 尖括号 + 引用式，跳过图片 / 行内代码 / 围栏代码块',
    L.extractMdHrefs(md), ['a.md', 'with space.md', 'ref.md', 'ref two.md']);
  check('HTML：<a href> 三种引号写法，跳过注释、解码 &amp;',
    L.extractHtmlHrefs('<a href="x.html">x</a><A class=k HREF=\'y.md\'>y</A><a href=z.htm>z</a><!-- <a href="c.md"> --><a href="q.md?a=1&amp;b=2">'),
    ['x.html', 'y.md', 'z.htm', 'q.md?a=1&b=2']);

  console.log('\n[纯函数] href 规整');
  const src = '/root/proj/doc.md';
  check('相对路径按源文件目录解析', L.hrefToPath('b.md', src), '/root/proj/b.md');
  check('../ 上一级', L.hrefToPath('../other/c.md', src), '/root/other/c.md');
  check('编码路径 decodeURIComponent', L.hrefToPath('%E4%B8%AD%E6%96%87%20a.md', src), '/root/proj/中文 a.md');
  check('decodeURIComponent 失败跳过', L.hrefToPath('%E4%B8.md', src), null);
  check('去 #hash 与 ?query', [L.hrefToPath('b.md#sec', src), L.hrefToPath('b.md?x=1#y', src)], ['/root/proj/b.md', '/root/proj/b.md']);
  check('纯锚点丢弃', L.hrefToPath('#top', src), null);
  check('外链 / mailto / data / javascript / 协议相对 丢弃',
    ['http://a.com/x.md', 'https://a.com', 'mailto:a@b.c', 'data:text/html,hi', 'javascript:alert(1)', '//cdn.x/y.md', 'ftp://a/b.md']
      .map(h => L.hrefToPath(h, src)), [null, null, null, null, null, null, null]);
  check('file:// 转本地路径', L.hrefToPath('file:///root/x/y.md', src), '/root/x/y.md');

  console.log('\n[索引] 解析范围与上限');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-linkidx-'));
  const root = path.join(tmp, 'scan');
  const outside = path.join(tmp, 'outside');
  write(outside, 'out.md', '# 根外\n');
  write(root, 'p/a.md', [
    '[b](b.md) [b again](./b.md) [b#sec](b.md#sec)',          // 去重
    '[c](../q/c.md) [编码](%E4%B8%AD%E6%96%87.md)',
    '[根外](../../outside/out.md) [外链](https://example.com/b.md) [锚点](#x)',
    '[自己](a.md) [目录](sub/) [目录2](docs)',
    '[不存在](ghost.md) [file](file://' + encodeURI(path.join(root, 'q', 'c.md')) + ')',
    '```\n[代码块](fence.md)\n```',
    '`[行内](inline.md)`',
  ].join('\n'));
  write(root, 'p/b.md', '# B\n[回 a](a.md)\n');
  write(root, 'p/中文.md', '# 中文\n');
  write(root, 'p/fence.md', '# fence\n');
  write(root, 'p/inline.md', '# inline\n');
  write(root, 'p/sub/index.html', '<h1>sub</h1>');
  write(root, 'p/docs/README.md', '# docs\n');
  write(root, 'q/c.md', '# C\n');
  write(root, 'q/page.html', '<a href="../p/a.md">a</a><a href="c.md">c</a><a href="mailto:x@y">m</a>');
  // 每文件 200 条上限：205 个不同的有效目标
  const many = [];
  for (let i = 0; i < 205; i++) { write(root, `m/t${i}.md`, `# ${i}\n`); many.push(`[t${i}](t${i}.md)`); }
  write(root, 'm/hub.md', many.join('\n'));

  let indexed = new Set(listDocs(root));
  const warns = [];
  const versions = [];
  const mk = (extra = {}) => L.createLinkIndex({
    cacheDir: path.join(tmp, 'home', 'links'),
    getRoots: () => [root],
    isIndexed: (p) => indexed.has(p),
    onVersion: (v) => versions.push(v),
    log: { warn: (...a) => warns.push(a.join(' ')) },
    ...extra,
  });
  let idx = mk();
  check('首轮解析前未就绪', idx.isReady(), false);
  idx.sync([...indexed]);
  await idx.whenIdle();
  check('首轮解析后就绪', idx.isReady(), true);
  let snap = idx.snapshot();
  let e = edgesOf(snap, root);
  check('a.md 的出链：b、c、编码路径、目录 index.html / README.md、file://（去重、去自引用、去根外 / 外链 / 锚点 / 代码块 / 不存在）',
    e['p/a.md'], ['p/b.md', 'p/docs/README.md', 'p/sub/index.html', 'p/中文.md', 'q/c.md'].sort());
  check('HTML 的 <a href>：../ 与同目录', e['q/page.html'], ['p/a.md', 'q/c.md']);
  check('b.md → a.md', e['p/b.md'], ['p/a.md']);
  check('每文件最多 200 条', (e['m/hub.md'] || []).length, 200);
  check('有文件被截断 → truncated', snap.truncated, true);
  check('paths 只含参与连线的端点', snap.paths.every(p => snap.edges.some(([s, d]) => snap.paths[s] === p || snap.paths[d] === p)), true);
  check('形状：version 为数字、edges 为下标对', [typeof snap.version, snap.edges.every(x => Array.isArray(x) && x.length === 2)], ['number', true]);
  await sleep(400);
  check('版本变化经 onVersion 通知（防抖后至少一次）', versions.length >= 1, true);

  console.log('\n[索引] 目标后来出现 → 查询期过滤自动接上；全局上限');
  write(root, 'p/ghost.md', '# 现在有了\n');
  indexed.add(path.join(root, 'p/ghost.md'));
  idx.update(path.join(root, 'p/ghost.md'), true);
  await idx.whenIdle();
  check('不存在的目标出现后，a.md → ghost.md 生效', edgesOf(idx.snapshot(), root)['p/a.md'].includes('p/ghost.md'), true);
  const capped = mk({ globalMax: 3, cacheDir: path.join(tmp, 'home2', 'links') });
  capped.sync([...indexed]);
  await capped.whenIdle();
  const cs = capped.snapshot();
  check('全局上限：只给出 globalMax 条边并标 truncated', [cs.edges.length, cs.truncated], [3, true]);

  console.log('\n[索引] mtime 变化触发重解析 / unlink');
  const v0 = idx.version;
  // 内容不变的 change：不算变化
  idx.update(path.join(root, 'p/b.md'), false);
  await idx.whenIdle();
  check('内容没变的 change 不递增 version', idx.version, v0);
  const bPath = write(root, 'p/b.md', '# B\n[回 a](a.md) [去 c](../q/c.md)\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(bPath, later, later);
  idx.update(bPath, false);
  await idx.whenIdle();
  check('改内容后只重解析该文件：b.md 多了一条出链', edgesOf(idx.snapshot(), root)['p/b.md'], ['p/a.md', 'q/c.md']);
  check('version 递增', idx.version > v0, true);
  const v1 = idx.version;
  fs.unlinkSync(path.join(root, 'q/c.md'));
  indexed.delete(path.join(root, 'q/c.md'));
  idx.remove(path.join(root, 'q/c.md'));
  const after = edgesOf(idx.snapshot(), root);
  check('unlink 后指向它的边按当前索引过滤掉', [after['p/a.md'].includes('q/c.md'), after['p/b.md']], [false, ['p/a.md']]);
  check('unlink 递增 version', idx.version > v1, true);

  console.log('\n[缓存] 写盘 / 复用 / 损坏重建');
  idx.flush();
  const cacheFile = path.join(tmp, 'home', 'links', 'index.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  check('缓存文件按源存 { mtime, size, targets }', ['mtime', 'size', 'targets'].every(k => k in cache.entries[path.join(root, 'p/a.md')]), true);
  check('没有遗留临时文件', fs.readdirSync(path.join(tmp, 'home', 'links')).filter(f => f.endsWith('.tmp')), []);
  const idx2 = mk();
  // 不调 sync 也能从缓存读出边（mtime / size 未变的条目直接复用）
  check('重启后从缓存直接复用', edgesOf(idx2.snapshot(), root)['p/b.md'], ['p/a.md']);
  fs.writeFileSync(cacheFile, '{ 这不是 JSON');
  warns.length = 0;
  const idx3 = mk();
  check('缓存损坏：warn 一次', warns.filter(w => w.includes('损坏')).length, 1);
  idx3.sync([...indexed]);
  await idx3.whenIdle();
  check('并全量重建', edgesOf(idx3.snapshot(), root)['p/a.md'].length > 0, true);
  idx3.flush();
  fs.rmSync(tmp, { recursive: true, force: true });
}

function get(base, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + p, { headers }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
  });
}

async function apiSection() {
  console.log('\n[接口] GET /api/links');
  const atlas = await startAtlas({
    prefix: 'atlas-links-api-',
    files: {
      'p/a.md': '# A\n[b](b.md)\n',
      'p/b.md': '# B\n',
      'q/c.html': '<a href="../p/a.md">a</a>',
    },
  });
  try {
    let r;
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      r = await get(atlas.base, '/api/links');
      seen.add(r.status);
      if (r.status === 202 && JSON.parse(r.body).ready !== false) seen.add('202-without-ready-false');
      if (r.status === 200) break;
      await sleep(150);
    }
    check('200', r.status, 200);
    // 未就绪是正常状态：回 202 { ready:false } 而不是 503，浏览器不会记成控制台报错
    check('就绪前后只出现 200 / 202 { ready:false }', [...seen].every(s => s === 200 || s === 202), true);
    check('Cache-Control: no-store', r.headers['cache-control'], 'no-store');
    const j = JSON.parse(r.body);
    check('形状 { version, truncated, edges, paths }', Object.keys(j).sort(), ['edges', 'paths', 'truncated', 'version']);
    const named = j.edges.map(([s, d]) => [path.basename(j.paths[s]), path.basename(j.paths[d])]).sort();
    check('边：a→b、c→a', named, [['a.md', 'b.md'], ['c.html', 'a.md']]);
    const x = await get(atlas.base, '/api/links', { 'Sec-Fetch-Site': 'cross-site' });
    check('跨站请求 403', x.status, 403);
    // 改文件：watcher change → 只重解析这一篇 → version 递增
    fs.writeFileSync(atlas.filePath('p/b.md'), '# B\n[c](../q/c.html)\n');
    let j2 = j;
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      j2 = JSON.parse((await get(atlas.base, '/api/links')).body);
      if (j2.version > j.version && j2.edges.length === 3) break;
    }
    check('改文件后 version 递增', j2.version > j.version, true);
    check('新边 b→c 出现', j2.edges.length, 3);
    // 缓存落在 ATLAS_HOME/links/
    await sleep(2500);
    check('缓存写在 ATLAS_HOME/links/index.json', fs.existsSync(path.join(atlas.homeDir, 'links', 'index.json')), true);
  } finally {
    await atlas.stop();
  }
}

(async () => {
  console.log('==== link-index.spec ====');
  await nodeSection();
  await apiSection();
  console.log('\n========================');
  console.log(`总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('spec 自身出错:', e); process.exit(1); });
