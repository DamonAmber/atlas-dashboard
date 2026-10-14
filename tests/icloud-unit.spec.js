// iCloud 云盘支持的 lib 层单测（lib/icloud.js、lib/icloud-download.js、
// 以及 link-index / thumbnail 的新注入点）。纯 node，Linux CI 上可跑。
//
// 所有文件系统操作都在 os.tmpdir() 下的临时目录里，结束时删掉；
// 不碰真实 iCloud 目录、不碰 ~/.atlas。
//
// 覆盖：design §11.1 全部条目，并按 plan.md 修订：
//   · M1 测试钩子按 realpath 记账：符号链接根、钩子 + 下载器联调、readBehavior 用 link 写法登记
//   · M2 依赖检查的本地文本资源队列（js / iframe / object / meta refresh 子文档、层数、环、按文档目录解析）
//   · M3 抛错兜底：thumbnailer checkSource 抛错、readText 抛错 → 'deps-unverified'
//   · N6 钩子文件写坏：状态不变、不注入、warn 一次
//   · N11 brctl 不返回：hardTimeout 到时 SIGKILL，dataless 转读取回退，占位以 timeout 结束
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const icloud = require(path.join(ROOT, 'lib/icloud'));
const { createDownloader, defaultHardTimeout } = require(path.join(ROOT, 'lib/icloud-download'));
const userPaths = require(path.join(ROOT, 'lib/paths'));
const { createLinkIndex } = require(path.join(ROOT, 'lib/link-index'));
const thumbnail = require(path.join(ROOT, 'lib/thumbnail'));

let failures = 0;
let total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 3000, stepMs = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}
const silentLog = () => {
  const warns = [];
  const logs = [];
  return { warns, logs, warn: (...a) => warns.push(a.join(' ')), log: (...a) => logs.push(a.join(' ')) };
};
function fdCount() {
  try { return fs.readdirSync('/dev/fd').length; } catch { return -1; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-icloud-unit-'));
const tmpDirs = [TMP];
function mk(rel) { const d = path.join(TMP, rel); fs.mkdirSync(d, { recursive: true }); return d; }
function put(p, content = 'x') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; }

// ---------------------------------------------------------------------------
function pureFunctions() {
  console.log('\n[纯函数] placeholderOriginalName / placeholderPathFor');
  const P = icloud.placeholderOriginalName;
  check('.报告.md.icloud → 报告.md', P('.报告.md.icloud'), '报告.md');
  check('.a b 2.html.icloud → a b 2.html', P('.a b 2.html.icloud'), 'a b 2.html');
  check('foo.icloud → null（不以 . 开头）', P('foo.icloud'), null);
  check('.icloud → null', P('.icloud'), null);
  check('..icloud → null', P('..icloud'), null);
  check('.md.icloud → md（是不是文档由调用方判断）', P('.md.icloud'), 'md');
  check('..x.md.icloud → null（隐藏文件的占位）', P('..x.md.icloud'), null);
  check('名字里含 / → null', P('.a/b.md.icloud'), null);
  check('名字里含 \\ → null', P('.a\\b.md.icloud'), null);
  check('.x.md.icloud.bak → null（不以 .icloud 结尾）', P('.x.md.icloud.bak'), null);
  check('placeholderPathFor', icloud.placeholderPathFor('/a/b/报告 1.md'), '/a/b/.报告 1.md.icloud');

  console.log('\n[纯函数] isDatalessStat');
  const file = (size, blocks) => ({ isFile: () => true, size, blocks });
  check('darwin + size>0 + blocks 0 → true', icloud.isDatalessStat(file(10, 0), 'darwin'), true);
  check('非 darwin → false', icloud.isDatalessStat(file(10, 0), 'linux'), false);
  check('size 0 → false', icloud.isDatalessStat(file(0, 0), 'darwin'), false);
  check('blocks undefined → false', icloud.isDatalessStat(file(10, undefined), 'darwin'), false);
  check('blocks NaN → false', icloud.isDatalessStat(file(10, NaN), 'darwin'), false);
  check('目录 → false', icloud.isDatalessStat({ isFile: () => false, size: 10, blocks: 0 }, 'darwin'), false);
  check('blocks>0 → false', icloud.isDatalessStat(file(10, 8), 'darwin'), false);
  check('st 为空 → false', icloud.isDatalessStat(null, 'darwin'), false);

  console.log('\n[纯函数] classifyTransition 真值表');
  const C = icloud.classifyTransition;
  const r = (cloud, size, mtime) => ({ cloud, size, mtime });
  check('本地 → dataless，size/mtime 不变 → state', C(r(null, 10, 1), r('dataless', 10, 1)), 'state');
  check('dataless → 本地，size/mtime 不变 → state', C(r('dataless', 10, 1), r(null, 10, 1)), 'state');
  check('本地 → 占位（size 变 null）→ state', C(r(null, 10, 1), r('placeholder', null, 1)), 'state');
  check('占位 → 本地（size/mtime 都变）→ state', C(r('placeholder', null, 1), r(null, 12, 5)), 'state');
  check('本地 → dataless 且 size 变了 → content', C(r(null, 10, 1), r('dataless', 12, 1)), 'content');
  check('三项全同 → none', C(r(null, 10, 1), r(null, 10, 1)), 'none');
  check('只有 mtime 变 → content', C(r(null, 10, 1), r(null, 10, 2)), 'content');
  check('dataless 内 size 变 → content', C(r('dataless', 10, 1), r('dataless', 11, 1)), 'content');

  console.log('\n[纯函数] isWithin / isWithinOrEqual');
  check('/r 与 /r/..foo/x.md → true（N1）', icloud.isWithin('/r', '/r/..foo/x.md'), true);
  check('/r 与 /r → false（根本身不是下载目标）', icloud.isWithin('/r', '/r'), false);
  check('/r 与 /r-evil/x → false（前缀碰撞）', icloud.isWithin('/r', '/r-evil/x'), false);
  check('/r 与 /x → false', icloud.isWithin('/r', '/x'), false);
  check('/r 与 /r/a/../../x → false', icloud.isWithin('/r', path.resolve('/r/a/../../x')), false);
  check('isWithinOrEqual(/r, /r) → true', icloud.isWithinOrEqual('/r', '/r'), true);
  check('isWithinOrEqual(/r, /r/a) → true', icloud.isWithinOrEqual('/r', '/r/a'), true);
  check('isWithinOrEqual(/r, /r2) → false', icloud.isWithinOrEqual('/r', '/r2'), false);

  console.log('\n[纯函数] parseBrctlHelp');
  // 本机 macOS 26.5.1 `brctl` 不带参数的输出形态（行首是命令名，没有 download）
  const realHelp = [
    'Usage: brctl <command> [command-options and arguments]',
    '',
    '    -h,--help            show this help',
    '',
    'COMMANDS',
    '',
    'accounts [options]',
    'diagnose [options] [--doc|-d <document-path>] [<diagnosis-output-path>]',
    'dump [options] [<container>]',
    'log [options] [<command>]',
    'monitor [options] [<container> ...]',
    '    monitor activity, e.g. evictions and downloads',
    'quota [options]',
    'redirect [options]',
    'restrict [options]',
    'status [<containerID>]    show the download status',
    'wait [options]',
  ].join('\n');
  check('本机帮助文本（只有说明文字里出现 download）→ download:false', icloud.parseBrctlHelp(realHelp), { download: false });
  check('伪造的带 download 子命令 → true', icloud.parseBrctlHelp(realHelp + '\ndownload <path>\n'), { download: true });
  check('行首 download 后直接换行也算', icloud.parseBrctlHelp('x\ndownload\ny'), { download: true });
  check('downloads（不是命令名）→ false', icloud.parseBrctlHelp('downloads [x]'), { download: false });
  check('空输入 → false', icloud.parseBrctlHelp(undefined), { download: false });

  console.log('\n[纯函数] iCloudLabelFor');
  check('Mobile Documents 下 → 在 iCloud 中', icloud.iCloudLabelFor('/h/Library/Mobile Documents/com~apple~CloudDocs/a.md', '/h'), '在 iCloud 中');
  check('CloudStorage 下 → 仅在云端', icloud.iCloudLabelFor('/h/Library/CloudStorage/Dropbox/a.md', '/h'), '仅在云端');
  check('CloudStorageX（前缀碰撞）→ 在 iCloud 中', icloud.iCloudLabelFor('/h/Library/CloudStorageX/a.md', '/h'), '在 iCloud 中');

  console.log('\n[纯函数] paths.expand（AC4 的 CLI 部分）');
  check('开头的 ~/ 展开，段内的 ~ 保留',
    userPaths.expand('~/Library/Mobile Documents/com~apple~CloudDocs'),
    path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
}

// ---------------------------------------------------------------------------
function extractRefs() {
  console.log('\n[extractLocalResourceRefs]');
  const X = (t, k = 'html', o) => icloud.extractLocalResourceRefs(t, k, o);
  const has = (t, ref, k) => X(t, k).refs.includes(ref);
  check('<img src="a.png">', has('<img src="a.png">', 'a.png'), true);
  check('不带引号 <img src=img/pic.png>（M3）', has('<img src=img/pic.png>', 'img/pic.png'), true);
  check("<img src='b.png'>", has("<img src='b.png'>", 'b.png'), true);
  check('自闭合不带引号 <img src=c.png/> 也提取 c.png', has('<img src=c.png/>', 'c.png'), true);
  check('<link rel=stylesheet href=s.css>（M3）', has('<link rel=stylesheet href=s.css>', 's.css'), true);
  check('srcset 两项都提取', ['a.png', 'b.png'].every((r) => has('<img srcset="a.png 1x, b.png 2x">', r)), true);
  check('不带引号的 srcset=a.png', has('<img srcset=a.png>', 'a.png'), true);
  check('imagesrcset', has('<link rel=preload imagesrcset="p1.png 1x, p2.png 2x">', 'p2.png'), true);
  check('属性值里含 > 仍能提取后面的 src', has('<img alt="a>b" src="c.png">', 'c.png'), true);
  check('<a href> 不计', X('<a href="doc.md">x</a>').refs, []);
  check('<area href> 不计', X('<area href="x.html">').refs, []);
  const b = X('<base href="sub/"><img src="a.png">');
  check('<base href> 作为 base 返回且不计入 refs', [b.base, b.refs], ['sub/', ['a.png']]);
  check('<script src> / <iframe src> / <object data> / <video poster>',
    ['j.js', 'f.html', 'o.svg', 'p.jpg'].every((r) => has('<script src=j.js></script><iframe src="f.html"></iframe><object data=o.svg></object><video poster="p.jpg"></video>', r)), true);
  check('SVG <image href> / <use xlink:href>', ['r.png', 's.svg'].every((r) => has('<svg><image href="r.png"/><use xlink:href="s.svg#i"/></svg>', r, 'svg')), true);
  check('<style> 里的 url()', has('<style>body{background:url(bg.png)}</style>', 'bg.png'), true);
  check('style="" 里的 url()', has('<div style="background:url(\'s.png\')"></div>', 's.png'), true);
  check('@import "x.css"', has('@import "x.css";', 'x.css', 'css'), true);
  check('@import url(y.css)', has('@import url(y.css);', 'y.css', 'css'), true);
  check("全文字面量 './data.json'", has("<script>fetch('./data.json')</script>", './data.json'), true);
  check('CSS image-set("a.png" 1x)', has('.x{background:image-set("a.png" 1x)}', 'a.png', 'css'), true);
  check('MD 图片', has('# t\n\n![图](img/a.png)\n', 'img/a.png', 'md'), true);
  check('MD 引用定义', has('[logo]: <img/logo.png>\n', 'img/logo.png', 'md'), true);
  check('MD 内联 HTML', has('段落 <img src=i/x.png> 结束', 'i/x.png', 'md'), true);
  check('http: / https: / // / data: / # / about: / blob: / mailto: / javascript: 被丢弃',
    X('<img src="http://a/x.png"><img src="https://a/y.png"><img src="//cdn/z.png"><img src="data:image/png;base64,AA"><img src="#k"><iframe src="about:blank"></iframe><img src="blob:x"><link href="mailto:a@b"><script src="javascript:void(0)"></script>').refs, []);
  check('?query 与 #hash 去掉', X('<img src="a.png?v=2#x">').refs, ['a.png']);
  check('decodeURIComponent', X('<img src="a%20b.png">').refs, ['a b.png']);
  check('decode 失败按原文保留', X('<img src="a%zz.png">').refs, ['a%zz.png']);
  check('file: URL 保留', X('<img src="file:///abs/f.png">').refs, ['file:///abs/f.png']);
  check('meta refresh 提取 url（N10）', has('<meta http-equiv="refresh" content="0;url=x.html">', 'x.html'), true);
  check('meta refresh 不带引号也行', has('<meta http-equiv=Refresh content="5; URL=\'y.html\'">', 'y.html'), true);
  check('<meta name=x content=y.png> 不提取（N10）', X('<meta name=x content=y.png>').refs, []);
  check('srcdoc 实体解码后递归提取（N10）', has('<iframe srcdoc="&lt;img src=&quot;i.png&quot;&gt;"></iframe>', 'i.png'), true);
  check('srcdoc 数字实体 &#34; / &#x22;', has('<iframe srcdoc="&#60;img src=&#x22;n.png&#34;&#62;"></iframe>', 'n.png'), true);
  check('JS：import / export from / 动态 import',
    ['./m.js', './e.js', './d.js'].every((r) => has("import x from './m.js';\nexport { y } from \"./e.js\";\nconst z = import('./d.js');", r, 'js')), true);
  check('JS：字面量带扩展名的字符串', has("img.src = 'p.png';", 'p.png', 'js'), true);
  check('JS kind 不跑标签规则（不在字符串里的 <img src=x.png> 不算）', X('// <img src=x.png>', 'js').refs, []);
  const mkImgs = (n) => Array.from({ length: n }, (_, i) => `<img src="m/i${i}.png">`).join('');
  check('去重后 2000 条 → overflow false（M4）', X(mkImgs(2000)).overflow, false);
  check('去重后 2001 条 → overflow true（M4）', X(mkImgs(2001)).overflow, true);
  check('重复引用去重', X('<img src="a.png"><img src="a.png">').refs, ['a.png']);
}

// ---------------------------------------------------------------------------
// checkRenderDeps：I/O 全部用桩（虚拟文件表），不碰真实文件系统
function vfsDeps(files) {
  const reads = [];
  const stats = [];
  const o = {
    cloudKindNow: (p) => (files[p] && files[p].cloud) || null,
    stat: async (p) => {
      stats.push(p);
      const f = files[p];
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (f.statErr) throw Object.assign(new Error(f.statErr), { code: f.statErr });
      return { isFile: () => !f.dir, size: f.size || 1, dataless: !!f.dataless };
    },
    isDataless: (p, st) => !!(st && st.dataless),
    readText: async (p, max) => {
      reads.push(p);
      const f = files[p];
      if (f && f.readThrows) throw Object.assign(new Error('boom'), { code: 'EIO' });
      const text = (f && f.text) || '';
      return { text, truncated: !!(f && f.truncated) };
    },
  };
  return { o, reads, stats };
}
async function deps(files, abs, kind = 'html', extra = {}) {
  const v = vfsDeps(files);
  const log = silentLog();
  const res = await icloud.checkRenderDeps({ abs, kind, ...v.o, log, ...extra });
  return { res, reads: v.reads, stats: v.stats, warns: log.warns };
}

async function renderDeps() {
  console.log('\n[checkRenderDeps] 基本');
  const D = '/d';
  const doc = (text) => ({ text });
  let r;
  r = await deps({ '/d/a.html': { cloud: 'dataless' } }, '/d/a.html');
  check('源文件本身在云端 → cloud', r.res, 'cloud');
  check('源文件在云端时一次都不读', r.reads, []);
  r = await deps({ '/d/a.csv': doc('x') }, '/d/a.csv', 'csv');
  check('csv → null', r.res, null);
  r = await deps({ '/d/a.html': doc('<img src="img/pic.png">'), '/d/img/pic.png': { dataless: true } }, '/d/a.html');
  check('img 引用 dataless → cloud-deps', r.res, 'cloud-deps');
  r = await deps({ '/d/a.html': doc('<img src=img/pic.png>'), '/d/img/pic.png': { dataless: true } }, '/d/a.html');
  check('不带引号的 <img src=img/pic.png> 引用 dataless → cloud-deps（M3）', r.res, 'cloud-deps');
  r = await deps({ '/d/a.html': doc('<img srcset="a.png 1x, b.png 2x">'), '/d/a.png': {}, '/d/b.png': { dataless: true } }, '/d/a.html');
  check('srcset 第二项 dataless → cloud-deps', r.res, 'cloud-deps');
  r = await deps({ '/d/a.html': doc('<style>body{background:url(bg.png)}</style>'), '/d/bg.png': { dataless: true } }, '/d/a.html');
  check('<style>url(bg.png) dataless → cloud-deps', r.res, 'cloud-deps');
  r = await deps({
    '/d/a.html': doc('<link rel=stylesheet href=s.css>'),
    '/d/s.css': doc('.x{background:url(img/pic.png)}'),
    '/d/img/pic.png': { dataless: true },
  }, '/d/a.html');
  check('外链 s.css 里的 url(img/pic.png) dataless → cloud-deps', r.res, 'cloud-deps');
  check('readText 只读了 HTML 与 s.css', r.reads, ['/d/a.html', '/d/s.css']);
  r = await deps({ '/d/a.html': doc('<link rel=stylesheet href=s.css>'), '/d/s.css': { dataless: true } }, '/d/a.html');
  check('s.css 本身 dataless → cloud-deps', r.res, 'cloud-deps');
  check('dataless 的 s.css 没有被读', r.reads, ['/d/a.html']);
  r = await deps({ '/d/r.md': doc('![](img/pic.png)'), '/d/img/pic.png': { dataless: true } }, '/d/r.md', 'md');
  check('MD 图片 dataless → cloud-deps', r.res, 'cloud-deps');
  r = await deps({ '/d/x.svg': doc('<svg><image href="r.png"/></svg>'), '/d/r.png': { dataless: true } }, '/d/x.svg', 'svg');
  check('svg 文档 <image href> dataless → cloud-deps', r.res, 'cloud-deps');
  r = await deps({ '/d/a.html': doc('<img src="file:///abs/f.png">'), '/abs/f.png': { dataless: true } }, '/d/a.html');
  check('file: URL 引用按 fileURLToPath 解析', r.res, 'cloud-deps');
  r = await deps({ '/d/a.html': doc('<img src="/abs/g.png">'), '/abs/g.png': { dataless: true } }, '/d/a.html');
  check('以 / 开头按文件系统绝对路径（file:// 语义）', r.res, 'cloud-deps');

  console.log('\n[checkRenderDeps] 预算（M4）');
  const many = {};
  let html = '';
  for (let i = 1; i <= 65; i++) { const n = `m/i${String(i).padStart(3, '0')}.png`; many[path.join(D, n)] = {}; html += `<img src="${n}">`; }
  many['/d/many.html'] = doc(html);
  r = await deps(many, '/d/many.html');
  check('65 条引用全部本地 → null', r.res, null);
  html = '';
  for (let i = 0; i < 2001; i++) html += `<img src="m/j${i}.png">`;
  r = await deps({ '/d/big.html': doc(html) }, '/d/big.html');
  check('2001 条引用 → deps-unverified', r.res, 'deps-unverified');
  r = await deps({ '/d/a.html': doc('<img src="a.png"><img src="b.png"><img src="c.png">'), '/d/a.png': {}, '/d/b.png': {}, '/d/c.png': {} }, '/d/a.html', 'html', { maxRefs: 2 });
  check('去重后的 stat 总数超过 maxRefs → deps-unverified', r.res, 'deps-unverified');
  r = await deps({
    '/d/a.html': doc('<link rel=stylesheet href=s.css>'),
    '/d/s.css': doc('@import "t.css";'), '/d/t.css': doc('@import "u.css";'), '/d/u.css': doc('a{}'),
  }, '/d/a.html');
  check('两级 @import（s → t → u）全部本地 → null', r.res, null);
  r = await deps({
    '/d/a.html': doc('<link rel=stylesheet href=s.css>'),
    '/d/s.css': doc('@import "t.css";'), '/d/t.css': doc('@import "u.css";'), '/d/u.css': doc('@import "v.css";'), '/d/v.css': doc('a{}'),
  }, '/d/a.html');
  check('四级 @import → deps-unverified', r.res, 'deps-unverified');
  r = await deps({
    '/d/a.html': doc('<link rel=stylesheet href=s.css>'),
    '/d/s.css': doc('@import "t.css";'), '/d/t.css': doc('@import "s.css";'),
  }, '/d/a.html');
  check('s.css ↔ t.css 互相 @import（环）全部本地 → null', r.res, null);
  check('环里每个 CSS 只读一次', r.reads, ['/d/a.html', '/d/s.css', '/d/t.css']);
  r = await deps({ '/d/a.html': { text: '<p>x</p>', truncated: true } }, '/d/a.html');
  check('truncated:true → deps-unverified', r.res, 'deps-unverified');
  r = await deps({
    '/d/a.html': doc('<link rel=stylesheet href=s.css>'),
    '/d/s.css': doc('a{}'.repeat(100)),
  }, '/d/a.html', 'html', { maxTotalBytes: 100 });
  check('CSS 合计读取超过 maxTotalBytes → deps-unverified', r.res, 'deps-unverified');
  r = await deps({
    '/d/a.html': doc('<img src="dl.png"><link rel=stylesheet href=big.css>'),
    '/d/dl.png': { dataless: true },
    '/d/big.css': doc('a{}'.repeat(1000)),
  }, '/d/a.html', 'html', { maxTotalBytes: 100 });
  check('同时有 dataless 引用和超预算：dataless 先被 stat 到 → cloud-deps', r.res, 'cloud-deps');
  r = await deps({
    '/d/a.html': doc('<link rel=stylesheet href=s.css>'),
    '/d/s.css': doc('@import "t.css";'), '/d/t.css': doc('@import "u.css";'), '/d/u.css': doc('@import "v.css"; .x{background:url(dl.png)}'),
    '/d/v.css': doc('a{}'), '/d/dl.png': { dataless: true },
  }, '/d/a.html');
  check('层数超了但同一批里还有 dataless 引用 → cloud-deps', r.res, 'cloud-deps');
  r = await deps({
    '/d/a.html': doc('<img src="no.png"><img src="perm.png"><img src="ok.png"><img src="nd/x.png">'),
    '/d/perm.png': { statErr: 'EPERM' }, '/d/ok.png': {}, '/d/nd/x.png': { statErr: 'ENOTDIR' },
  }, '/d/a.html');
  check('引用 ENOENT / EPERM / ENOTDIR → 跳过，其余本地 → null', r.res, null);
  r = await deps({ '/d/a.html': doc('<base href="sub/"><img src="a.png">'), '/d/sub/a.png': { dataless: true }, '/d/a.png': {} }, '/d/a.html');
  check('<base href="sub/"> 下的相对引用按 sub/ 解析', r.res, 'cloud-deps');
  r = await deps({ '/d/a.html': doc('<base href="https://x.test/"><img src="a.png">'), '/d/a.png': { dataless: true } }, '/d/a.html');
  check('远程 <base> 下的相对引用不是本地文件 → null', r.res, null);

  console.log('\n[checkRenderDeps] M3 抛错兜底');
  r = await deps({ '/d/a.html': { readThrows: true } }, '/d/a.html');
  check('readText 抛错 → deps-unverified（直接对 checkRenderDeps 断言）', r.res, 'deps-unverified');
  check('并 warn 一行', r.warns.length === 1 && r.warns[0].includes('依赖检查失败'), true);
  r = await deps({ '/d/a.html': doc('<img src="x.png">'), '/d/x.png': { statErr: 'EIO' } }, '/d/a.html');
  check('stat 的非常规错误（EIO）→ deps-unverified', r.res, 'deps-unverified');
  {
    const log = silentLog();
    const res = await icloud.checkRenderDeps({ abs: '/d/a.html', kind: 'html', cloudKindNow: () => { throw new Error('x'); }, log });
    check('cloudKindNow 抛错也不抛给调用方 → deps-unverified', res, 'deps-unverified');
  }

  console.log('\n[checkRenderDeps] M2 本地文本资源队列');
  r = await deps({
    '/d/a.html': doc('<script src=app.js></script>'),
    '/d/app.js': doc("const img = new Image(); img.src = 'p.png';"),
    '/d/p.png': { dataless: true },
  }, '/d/a.html');
  check('<script src=app.js>，app.js 里 p.png dataless → cloud-deps', r.res, 'cloud-deps');
  r = await deps({
    '/d/a.html': doc('<iframe src=sub.html></iframe>'),
    '/d/sub.html': doc('<img src=q.png>'),
    '/d/q.png': { dataless: true },
  }, '/d/a.html');
  check('<iframe src=sub.html>，sub.html 里 q.png dataless → cloud-deps', r.res, 'cloud-deps');
  r = await deps({ '/d/a.html': doc('<script src=app.js></script>'), '/d/app.js': { dataless: true } }, '/d/a.html');
  check('app.js 本身 dataless → cloud-deps', r.res, 'cloud-deps');
  check('readText 从未以 app.js 调用', r.reads.includes('/d/app.js'), false);
  r = await deps({
    '/d/a.html': doc('<script type=module src=app.js></script>'),
    '/d/app.js': doc("import { f } from './m.js';"),
    '/d/m.js': { dataless: true },
  }, '/d/a.html');
  check("app.js 里 import './m.js'，m.js dataless → cloud-deps", r.res, 'cloud-deps');
  r = await deps({
    '/d/a.html': doc('<object data=x.svg></object>'),
    '/d/x.svg': doc('<svg><image href="r.png"/></svg>'),
    '/d/r.png': { dataless: true },
  }, '/d/a.html');
  check('<object data=x.svg>，x.svg 里 <image href=r.png> dataless → cloud-deps', r.res, 'cloud-deps');
  r = await deps({
    '/d/a.html': doc('<meta http-equiv=refresh content="0;url=t.html">'),
    '/d/t.html': doc('<img src="w.png">'),
    '/d/w.png': { dataless: true },
  }, '/d/a.html');
  check('meta refresh 到 t.html，t.html 的引用 dataless → cloud-deps', r.res, 'cloud-deps');
  r = await deps({
    '/d/a.html': doc('<script src=a.js></script>'),
    '/d/a.js': doc("import './b.js';"), '/d/b.js': doc("import './c.js';"), '/d/c.js': doc("import './d.js';"), '/d/d.js': doc('1'),
  }, '/d/a.html');
  check('a.js → b.js → c.js → d.js（第 4 层）全部本地 → deps-unverified', r.res, 'deps-unverified');
  r = await deps({
    '/d/a.html': doc('<script src=a.js></script>'),
    '/d/a.js': doc("import './b.js';"), '/d/b.js': doc("import './a.js';"),
  }, '/d/a.html');
  check('a.js ↔ b.js 互相 import（环）全部本地 → null', r.res, null);
  check('环里每个 js 只读一次', r.reads, ['/d/a.html', '/d/a.js', '/d/b.js']);
  r = await deps({
    '/d/a.html': doc('<script src="js/app.js"></script>'),
    '/d/js/app.js': doc("el.style.backgroundImage = 'url(' + 'img/z.png' + ')'; const u = 'img/z.png';"),
    '/d/img/z.png': { dataless: true },
  }, '/d/a.html');
  check('js 里的相对路径按文档目录解析才能找到的 dataless 图片 → cloud-deps', r.res, 'cloud-deps');
  r = await deps({
    '/d/a.html': doc('<iframe src="sub/inner.html"></iframe>'),
    '/d/sub/inner.html': doc('<img src="k.png">'),
    '/d/sub/k.png': { dataless: true }, '/d/k.png': {},
  }, '/d/a.html');
  check('html 子文档按它自己的目录解析', r.res, 'cloud-deps');
}

// ---------------------------------------------------------------------------
function iCloudConfig() {
  console.log('\n[resolveICloudConfig]');
  const def = '/h/Library/Mobile Documents/com~apple~CloudDocs';
  let c = icloud.resolveICloudConfig({ env: {}, platform: 'darwin', homedir: '/h', existsDir: (p) => p === def });
  check('默认路径', [c.root, c.source, c.enabled, c.rootExists, c.available, c.platform], [def, 'default', true, true, true, 'darwin']);
  c = icloud.resolveICloudConfig({ env: {}, platform: 'darwin', homedir: '/h', existsDir: () => false });
  check('默认根不存在 → available false', [c.rootExists, c.available], [false, false]);
  const d = mk('cfg/Mobile Documents/com~apple~CloudDocs');
  c = icloud.resolveICloudConfig({ env: { ATLAS_ICLOUD_ROOT: d }, platform: 'darwin', homedir: '/h' });
  check('ATLAS_ICLOUD_ROOT 指向临时目录', [c.root, c.source, c.available], [path.resolve(d), 'env', true]);
  c = icloud.resolveICloudConfig({ env: { ATLAS_ICLOUD_ROOT: path.join(TMP, 'nope') }, platform: 'darwin', homedir: '/h' });
  check('ATLAS_ICLOUD_ROOT 不存在 → rootExists false', [c.source, c.rootExists, c.available], ['env', false, false]);
  c = icloud.resolveICloudConfig({ env: { ATLAS_ICLOUD_ROOT: 'off' }, platform: 'darwin', homedir: '/h', existsDir: () => true });
  check('ATLAS_ICLOUD_ROOT=off', [c.root, c.source, c.available, c.enabled], [null, 'off', false, true]);
  c = icloud.resolveICloudConfig({ env: { ATLAS_ICLOUD_PLATFORM: 'linux' }, platform: 'darwin', homedir: '/h', existsDir: () => true });
  check('ATLAS_ICLOUD_PLATFORM=linux → 整套关闭', [c.platform, c.enabled, c.available], ['linux', false, false]);
  c = icloud.resolveICloudConfig({ env: { ATLAS_ICLOUD_PLATFORM: 'darwin' }, platform: 'linux', homedir: '/h', existsDir: () => true });
  check('ATLAS_ICLOUD_PLATFORM=darwin 在 Linux 上打开', [c.platform, c.enabled, c.available], ['darwin', true, true]);
  c = icloud.resolveICloudConfig({ env: { ATLAS_ICLOUD_PLATFORM: 'beos' }, platform: 'linux', homedir: '/h', existsDir: () => true });
  check('ATLAS_ICLOUD_PLATFORM 非法值忽略', c.platform, 'linux');
  c = icloud.resolveICloudConfig({ env: { ATLAS_ICLOUD_ROOT: '~/Library/Mobile Documents/com~apple~CloudDocs' }, platform: 'darwin', homedir: '/h', existsDir: () => true });
  check('ATLAS_ICLOUD_ROOT 开头的 ~/ 展开、段内 ~ 保留', c.root, path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  check('statDetection 默认 true', icloud.resolveICloudConfig({ env: {}, platform: 'darwin', homedir: '/h', existsDir: () => true }).statDetection, true);
  check('ATLAS_CLOUD_DETECT=off → statDetection false', icloud.resolveICloudConfig({ env: { ATLAS_CLOUD_DETECT: 'off' }, platform: 'darwin', homedir: '/h', existsDir: () => true }).statDetection, false);
}

// ---------------------------------------------------------------------------
async function downloadTarget() {
  console.log('\n[resolveDownloadTarget]（临时目录里真实构造；macOS 上 /var → /private/var 正好覆盖根路径别名）');
  const base = mk('dt');
  const root = mk('dt/root');
  const rootReal = fs.realpathSync(root);
  put(path.join(root, 'a.md'), '# a');
  put(path.join(base, 'outside', 'secret.md'), 'secret');
  put(path.join(base, 'root-evil', 'x.md'), 'x');
  fs.symlinkSync(path.join(base, 'outside', 'secret.md'), path.join(root, 'link.md'));
  fs.symlinkSync(path.join(base, 'outside', 'missing.md'), path.join(root, 'dang.md'));
  put(path.join(root, '.dang.md.icloud'), 'plist');
  put(path.join(root, '.ph.md.icloud'), 'plist');
  fs.symlinkSync(root, path.join(base, 'linkroot'));
  const R = (p, roots = [root]) => icloud.resolveDownloadTarget(p, { roots });
  const code = async (p, roots) => { const r = await R(p, roots); return r.ok ? 'ok' : `${r.code} ${r.error}`; };

  check('../ 穿越 → 403', await code(path.join(root, '..', 'outside', 'secret.md')), '403 outside-roots');
  check('指向根外的 symlink → 403', await code(path.join(root, 'link.md')), '403 outside-roots');
  check('root-evil 前缀碰撞 → 403', await code(path.join(base, 'root-evil', 'x.md')), '403 outside-roots');
  check('根本身 → 403', await code(root), '403 outside-roots');
  check('根外不存在的路径 → 403（不是 404，M5）', await code(path.join(base, 'outside', 'nope.md')), '403 outside-roots');
  check('根外、父目录也不存在 → 403', await code(path.join(base, 'nodir', 'nope.md')), '403 outside-roots');
  check('根内悬空符号链接 + 同目录占位 → 403 dangling-symlink（M5）', await code(path.join(root, 'dang.md')), '403 dangling-symlink');
  check('根内不存在、也没有占位 → 404', await code(path.join(root, 'none.md')), '404 not-found');
  check('根内、父目录也不存在 → 404（N1）', await code(path.join(root, 'nodir', 'x.md')), '404 not-found');
  let r = await R(path.join(root, 'ph.md'));
  check('占位文件原路径 → targetKind placeholder，real = 真实父目录 + 原名',
    [r.ok, r.targetKind, r.real, r.abs, 'kind' in r], [true, 'placeholder', path.join(rootReal, 'ph.md'), path.join(root, 'ph.md'), false]);
  r = await R(path.join(root, 'a.md'));
  check('根内本地文件 → targetKind file，real 是 realpath', [r.ok, r.targetKind, r.real], [true, 'file', path.join(rootReal, 'a.md')]);
  r = await R(path.join(base, 'linkroot', 'a.md'), [path.join(base, 'linkroot')]);
  check('根本身是符号链接时，根内文件通过；abs 保持传入写法', [r.ok, r.targetKind, r.abs, r.real],
    [true, 'file', path.join(base, 'linkroot', 'a.md'), path.join(rootReal, 'a.md')]);
  check('非字符串 → 400', await code(42), '400 bad-request');
  check('空串 → 400', await code(''), '400 bad-request');
  check('超长 → 400', await code('/' + 'a'.repeat(5000)), '400 bad-request');
  check('含 \\0 → 400', await code(path.join(root, 'a\0.md')), '400 bad-request');

  console.log('\n[realpathOfNearestAncestor / canonPathSync]（N1、M1）');
  const want = path.join(rootReal, 'nodir', 'sub', 'x.md');
  check('异步：<root>/nodir/sub/x.md → realpath(root)/nodir/sub/x.md', await icloud.realpathOfNearestAncestor(path.join(root, 'nodir', 'sub', 'x.md')), want);
  check('同步孪生结果一致', icloud.realpathOfNearestAncestorSync(path.join(root, 'nodir', 'sub', 'x.md')), want);
  check('canonPathSync：存在的路径 = realpathSync', icloud.canonPathSync(path.join(root, 'a.md')), path.join(rootReal, 'a.md'));
  check('canonPathSync：不存在的路径走最近祖先', icloud.canonPathSync(path.join(root, 'nodir', 'sub', 'x.md')), want);
  check('canonPathSync：经过符号链接根', icloud.canonPathSync(path.join(base, 'linkroot', 'zz.md')), path.join(rootReal, 'zz.md'));
}

// ---------------------------------------------------------------------------
// 下载器桩
function fakeStream({ delay = 5, chunks = [3], error = null, never = false } = {}) {
  const s = new EventEmitter();
  s.destroyed = false;
  s.destroyCalls = 0;
  let t = null;
  s.destroy = () => {
    s.destroyCalls++;
    if (s.destroyed) return s;
    s.destroyed = true;
    if (t) clearTimeout(t);
    setImmediate(() => s.emit('close'));
    return s;
  };
  if (!never) {
    t = setTimeout(() => {
      if (s.destroyed) return;
      if (error) {
        s.destroyed = true;
        s.emit('error', Object.assign(new Error(error), { code: error }));
        setImmediate(() => s.emit('close'));
        return;
      }
      for (const n of chunks) s.emit('data', Buffer.alloc(n));
      s.destroyed = true;
      s.emit('end');
      setImmediate(() => s.emit('close'));
    }, delay);
  }
  return s;
}
function makeDl(over = {}) {
  const events = [];
  const calls = { exec: [], read: [], isDataless: [], kills: [], done: [] };
  const dl = new Set(over.dataless || []);   // real 路径：仍是 dataless
  const phs = new Set(over.placeholders || []);   // 占位文件路径
  // dataless 文件本身是存在的（stat 得到），只是内容在云端
  const existing = new Set([...(over.existing || []), ...(over.dataless || [])]);
  const opts = {
    execFile: (file, args, o, cb) => {
      calls.exec.push({ file, args, opts: o });
      const child = new EventEmitter();
      child.kill = (sig) => { calls.kills.push(sig); return true; };
      const mode = typeof over.brctl === 'function' ? over.brctl(args) : (over.brctl || 'ok');
      if (mode === 'hang') return child;
      setTimeout(() => {
        if (mode === 'fail') return cb(Object.assign(new Error('exit 1'), { code: 1 }));
        if (mode === 'enoent') return cb(Object.assign(new Error('spawn brctl ENOENT'), { code: 'ENOENT' }));
        const real = args[1];
        dl.delete(real);
        const ph = icloud.placeholderPathFor(real);
        if (phs.has(ph)) { phs.delete(ph); existing.add(real); }
        cb(null, '', '');
      }, 5);
      return child;
    },
    createReadStream: (p, o) => {
      calls.read.push({ path: p, opts: o });
      const s = over.stream ? over.stream(p, o) : fakeStream();
      if (!over.keepDataless) s.on('close', () => dl.delete(p));
      return s;
    },
    stat: async (p) => {
      if (over.statGone && over.statGone(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (!existing.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true, size: 10, __p: p };
    },
    lstat: async (p) => {
      if (phs.has(p)) return { isFile: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    isDataless: (...a) => {
      calls.isDataless.push(a);
      if (over.alwaysDataless) return true;
      return dl.has(a[1] && a[1].__p);
    },
    placeholderPath: icloud.placeholderPathFor,
    probe: async () => over.cap || { brctl: { present: true, download: false } },
    onUpdate: (e) => events.push(e),
    onDone: async (abs) => { calls.done.push(abs); },
    pollMs: 10,
    settleMs: 200,
    log: silentLog(),
    ...over.opts,
  };
  const d = createDownloader(opts);
  const final = (abs) => events.find((e) => e.path === abs && (e.phase === 'done' || e.phase === 'error'));
  const waitFinal = (abs, ms = 3000) => waitFor(() => final(abs), ms);
  return { d, events, calls, dl, phs, existing, waitFinal, opts };
}

async function downloader() {
  console.log('\n[createDownloader] brctl 与读取回退');
  {
    const real = '/real/a b/x.md';
    const t = makeDl({ cap: { brctl: { present: true, download: true } }, dataless: [real] });
    const res = t.d.request({ abs: '/abs/a b/x.md', real, kind: 'dataless', size: 10 });
    check('request → accepted', res, { status: 'accepted' });
    const f = await t.waitFinal('/abs/a b/x.md');
    check('brctl 成功 → done', f && f.phase, 'done');
    const c = t.calls.exec[0];
    check('brctl 参数严格等于 [download, real]（AC23）', [c.file, c.args], ['brctl', ['download', real]]);
    check('execFile options 没有 shell，有 windowsHide 与数字 timeout', ['shell' in c.opts, c.opts.windowsHide, typeof c.opts.timeout], [false, true, 'number']);
    check('started 事件先于 done，busy 先 true 后 false',
      t.events.filter((e) => e.path === '/abs/a b/x.md').map((e) => [e.phase, e.busy]), [['started', true], ['done', false]]);
    check('done 事件 cloud:null', f.cloud, null);
    check('onDone 以 abs 调用', t.calls.done, ['/abs/a b/x.md']);
    check('isDataless 收到 (abs, st) 两个参数', t.calls.isDataless.every((a) => a.length === 2 && a[0] === '/abs/a b/x.md' && a[1] && typeof a[1].isFile === 'function'), true);
    check('完成后 has(abs) 为 false', t.d.has('/abs/a b/x.md'), false);
  }
  {
    const t = makeDl({ cap: { brctl: { present: true, download: true } }, brctl: 'fail', dataless: ['/r/y.md'] });
    t.d.request({ abs: '/a/y.md', real: '/r/y.md', kind: 'dataless' });
    const f = await t.waitFinal('/a/y.md');
    check('brctl 失败时 dataless 转读取回退并 done', [f && f.phase, t.calls.exec.length, t.calls.read.length], ['done', 1, 1]);
    check('createReadStream 收到的是 real 不是 abs，highWaterMark 64KB', [t.calls.read[0].path, t.calls.read[0].opts], ['/r/y.md', { highWaterMark: 64 * 1024 }]);
  }
  {
    const t = makeDl({ cap: { brctl: { present: true, download: true } }, brctl: 'fail', placeholders: ['/r/.p.md.icloud'] });
    t.d.request({ abs: '/a/p.md', real: '/r/p.md', kind: 'placeholder' });
    const f = await t.waitFinal('/a/p.md');
    check('brctl 失败时占位以 brctl-failed 结束、不读', [f && f.reason, f && f.message, t.calls.read.length], ['brctl-failed', '系统下载命令失败', 0]);
  }
  {
    const t = makeDl({ placeholders: ['/r/.p.md.icloud'] });
    t.d.request({ abs: '/a/p.md', real: '/r/p.md', kind: 'placeholder' });
    const f = await t.waitFinal('/a/p.md');
    check('没有 brctl download 时占位 → unsupported', [f && f.reason, f && f.cloud, t.calls.exec.length], ['unsupported', 'placeholder', 0]);
  }
  {
    const t = makeDl({ cap: { brctl: { present: true, download: true } }, placeholders: ['/r/.q.md.icloud'] });
    t.d.request({ abs: '/a/q.md', real: '/r/q.md', kind: 'placeholder' });
    const f = await t.waitFinal('/a/q.md');
    check('占位文件对原路径调用 brctl，原路径出现且占位消失 → done', [t.calls.exec[0].args, f && f.phase], [['download', '/r/q.md'], 'done']);
  }
  {
    // 占位完成判定要求占位文件消失：原路径出现了但占位还在 → not-materialized
    const t2 = makeDl({ cap: { brctl: { present: true, download: true } }, existing: ['/r/s.md'],
      opts: { lstat: async () => ({ isFile: () => true }), hardTimeout: () => 100 } });
    t2.d.request({ abs: '/a/s.md', real: '/r/s.md', kind: 'placeholder' });
    const f = await t2.waitFinal('/a/s.md');
    check('占位：原路径已是本地但占位文件仍在 → not-materialized', f && f.reason, 'not-materialized');
  }
  {
    const t = makeDl({ dataless: ['/r/z.md'] });
    check('同一路径连续请求两次只有一个任务（AC24）', [
      t.d.request({ abs: '/a/z.md', real: '/r/z.md', kind: 'dataless' }).status,
      t.d.request({ abs: '/a/z.md', real: '/r/z.md', kind: 'dataless' }).status,
    ], ['accepted', 'deduped']);
    await t.waitFinal('/a/z.md');
    check('只读了一次', t.calls.read.length, 1);
  }
  {
    const t = makeDl({ stream: () => fakeStream({ never: true }), opts: { hardTimeout: () => 60_000 } });
    const st = [];
    for (let i = 0; i < 11; i++) st.push(t.d.request({ abs: `/a/c${i}.md`, real: `/r/c${i}.md`, kind: 'dataless' }).status);
    check('并发 2 + 排队 8，第 11 个返回 busy', st, [...Array(10).fill('accepted'), 'busy']);
    check('运行 2 个、排队 8 个', [t.d._debug.running().length, t.d._debug.queued().length], [2, 8]);
    check('排队中的也算 has()', t.d.has('/a/c9.md'), true);
    t.d.shutdown();
    const cancelled = t.events.filter((e) => e.phase === 'error' && e.reason === 'cancelled').map((e) => e.path).sort();
    check('shutdown：在途与排队的任务都推 cancelled', cancelled.length, 10);
    check('shutdown 后 request 返回 busy', t.d.request({ abs: '/a/n.md', real: '/r/n.md', kind: 'dataless' }).status, 'busy');
  }
  {
    let s;
    const t = makeDl({ stream: () => (s = fakeStream({ never: true })), opts: { hardTimeout: () => 40 } });
    t.d.request({ abs: '/a/h.md', real: '/r/h.md', kind: 'dataless' });
    const f = await t.waitFinal('/a/h.md');
    check('读取超过 hardTimeout → 流被 destroy、以 timeout 结束', [f && f.reason, s && s.destroyCalls >= 1], ['timeout', true]);
  }
  {
    const t = makeDl({ dataless: ['/r/m.md'], alwaysDataless: true, opts: { settleMs: 80 } });
    t.d.request({ abs: '/a/m.md', real: '/r/m.md', kind: 'dataless' });
    const f = await t.waitFinal('/a/m.md');
    check('isDataless 一直为 true → not-materialized（M6）', [f && f.reason, f && f.message], ['not-materialized', '已读取，但系统仍报告此文件未下载']);
  }
  {
    const t = makeDl({ dataless: ['/r/g.md'], statGone: (p) => p === '/r/g.md' });
    t.d.request({ abs: '/a/g.md', real: '/r/g.md', kind: 'dataless' });
    const f = await t.waitFinal('/a/g.md');
    check('读完之后 stat ENOENT → gone', f && f.reason, 'gone');
  }
  for (const [code, reason] of [['EIO', 'io-error'], ['ETIMEDOUT', 'offline'], ['ENETUNREACH', 'offline'], ['EACCES', 'permission'], ['EPERM', 'permission'], ['ENOENT', 'gone']]) {
    const t = makeDl({ stream: () => fakeStream({ error: code }) });
    t.d.request({ abs: '/a/e.md', real: '/r/e.md', kind: 'dataless' });
    const f = await t.waitFinal('/a/e.md');
    check(`errno 分类：${code} → ${reason}`, f && f.reason, reason);
  }
  {
    const t = makeDl({ dataless: ['/r/n.md'], stream: () => fakeStream({ delay: 5 }), keepDataless: true, opts: { pollMs: 5000, settleMs: 10_000 } });
    t.d.request({ abs: '/a/n.md', real: '/r/n.md', kind: 'dataless' });
    await sleep(60);
    t.dl.delete('/r/n.md');
    const t0 = Date.now();
    t.d.nudge('/a/n.md');
    const f = await t.waitFinal('/a/n.md', 1000);
    check('nudge 让下一次完成判定马上执行（不等 pollMs）', [f && f.phase, Date.now() - t0 < 500], ['done', true]);
  }
  {
    const t = makeDl();
    let threw = false;
    try { t.d.request({ abs: '/a/x.md', real: '/r/x.md', kind: 'file' }); } catch (e) { threw = e instanceof TypeError; }
    check("kind 只接受 'dataless' | 'placeholder'（N8）", threw, true);
  }
  check('defaultHardTimeout：size 未知 120s；256MB = 120s + 512s；上限 30 分钟',
    [defaultHardTimeout(null), defaultHardTimeout(256 * 1024 * 1024), defaultHardTimeout(1e13)], [120_000, 120_000 + 512_000, 1_800_000]);

  console.log('\n[createDownloader] N11 brctl 不返回');
  {
    const t = makeDl({ cap: { brctl: { present: true, download: true } }, brctl: 'hang', dataless: ['/r/k.md'],
      stream: () => fakeStream({ delay: 5 }), opts: { hardTimeout: () => 50 } });
    t.d.request({ abs: '/a/k.md', real: '/r/k.md', kind: 'dataless' });
    const f = await t.waitFinal('/a/k.md');
    check('dataless：50ms 后 SIGKILL，转读取回退并最终 done', [f && f.phase, t.calls.kills, t.calls.read.length], ['done', ['SIGKILL'], 1]);
  }
  {
    const t = makeDl({ cap: { brctl: { present: true, download: true } }, brctl: 'hang', placeholders: ['/r/.k.md.icloud'], opts: { hardTimeout: () => 50 } });
    t.d.request({ abs: '/a/k.md', real: '/r/k.md', kind: 'placeholder' });
    const f = await t.waitFinal('/a/k.md');
    check('占位：phase error、reason timeout、kill 一次', [f && f.phase, f && f.reason, t.calls.kills], ['error', 'timeout', ['SIGKILL']]);
  }

  console.log('\n[createDownloader] 真实的流式读取（1MB 临时文件）');
  {
    const big = put(path.join(TMP, 'stream', 'big.bin'), Buffer.alloc(1024 * 1024, 7));
    const chunks = [];
    let readDone = false;
    const fdBefore = fdCount();
    const d = createDownloader({
      execFile: () => { throw new Error('不应调用 brctl'); },
      createReadStream: (p, o) => {
        const s = fs.createReadStream(p, o);
        s.on('data', (c) => chunks.push(c.length));
        s.on('close', () => { readDone = true; });
        return s;
      },
      stat: fsp.stat, lstat: fsp.lstat,
      isDataless: () => !readDone,
      placeholderPath: icloud.placeholderPathFor,
      probe: async () => ({ brctl: { present: true, download: false } }),
      onUpdate: (e) => { if (e.phase === 'done' || e.phase === 'error') d.__final = e; },
      pollMs: 10, settleMs: 500, log: silentLog(),
    });
    d.request({ abs: big, real: big, kind: 'dataless', size: 1024 * 1024 });
    await waitFor(() => d.__final, 3000);
    await sleep(50);
    check('读完 1MB 并 done', [d.__final && d.__final.phase, chunks.reduce((a, b) => a + b, 0)], ['done', 1024 * 1024]);
    check('每块 ≤ 64KB', chunks.every((n) => n <= 64 * 1024), true);
    if (fdBefore >= 0) check('句柄关闭：fd 计数回到原值', fdCount(), fdBefore);
  }
}

// ---------------------------------------------------------------------------
function makeHookHome(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-icloud-hook-${name}-`));
  tmpDirs.push(home);
  const file = path.join(home, 'cloud-hook.json');
  return { home, file, env: { ATLAS_HOME: home, ATLAS_TEST_CLOUD: file } };
}
function writeJson(file, obj) {
  // N6：先写临时文件再 rename，轮询不会读到半截
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
  fs.renameSync(file + '.tmp', file);
}
function startHook(h, extra = {}) {
  const injected = [];
  const log = silentLog();
  const hook = icloud.loadTestHook({ env: h.env, configDir: () => h.home, log, inject: (l) => injected.push(l), ...extra });
  return { hook, injected, log };
}
function streamEnd(s) {
  return new Promise((res) => {
    const out = { data: 0, error: null };
    s.on('data', (c) => { out.data += c.length; });
    s.on('error', (e) => { out.error = e.code; });
    s.on('close', () => res(out));
  });
}

async function testHook() {
  console.log('\n[loadTestHook] 启用条件');
  {
    const h = makeHookHome('cond');
    writeJson(h.file, { dataless: [] });
    check('没设 ATLAS_TEST_CLOUD → null（不 warn）', (() => { const l = silentLog(); return [icloud.loadTestHook({ env: { ATLAS_HOME: h.home }, configDir: () => h.home, log: l }), l.warns.length]; })(), [null, 0]);
    check('没设 ATLAS_HOME → null', startHook({ ...h, env: { ATLAS_TEST_CLOUD: h.file } }).hook, null);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-icloud-hookout-'));
    tmpDirs.push(out);
    writeJson(path.join(out, 'cloud-hook.json'), {});
    const s1 = startHook({ ...h, env: { ATLAS_HOME: h.home, ATLAS_TEST_CLOUD: path.join(out, 'cloud-hook.json') } });
    check('钩子文件不在 ATLAS_HOME 之内 → null 并 warn 一行', [s1.hook, s1.log.warns.length], [null, 1]);
    fs.symlinkSync(path.join(out, 'cloud-hook.json'), path.join(h.home, 'linked-hook.json'));
    check('钩子文件是指向 ATLAS_HOME 之外的符号链接 → null（按 realpath 判）',
      startHook({ ...h, env: { ATLAS_HOME: h.home, ATLAS_TEST_CLOUD: path.join(h.home, 'linked-hook.json') } }).hook, null);
    fs.writeFileSync(path.join(h.home, 'bad.json'), '{oops');
    check('启动时 JSON 解析失败 → null', startHook({ ...h, env: { ATLAS_HOME: h.home, ATLAS_TEST_CLOUD: path.join(h.home, 'bad.json') } }).hook, null);
    const s2 = startHook(h);
    check('条件都满足 → 启用并打印 [test] 行', [!!s2.hook, s2.log.logs.some((l) => l.includes('[test] iCloud 测试钩子已启用：') && l.includes(h.file))], [true, true]);
    check('statDetection 默认 false、settleMs 默认 null、brctlMode 默认 null', [s2.hook.statDetection, s2.hook.settleMs, s2.hook.brctlMode], [false, null, null]);
    s2.hook.close();
  }

  console.log('\n[loadTestHook] 集合语义（M6）');
  {
    const h = makeHookHome('sem');
    const root = path.join(h.home, 'r');
    fs.mkdirSync(root);
    const a = path.join(root, 'a.md');
    const b = path.join(root, 'b.md');
    const c = path.join(root, 'c.md');
    const y = path.join(root, 'y.md');
    for (const p of [a, b, c, y]) put(p, '#');
    const cfg = { dataless: [a, b, c], stickyDataless: [y], silent: [c], sizes: { [b]: 209715200 }, settleMs: 500, brctl: 'supported', statDetection: true, other: 1 };
    writeJson(h.file, cfg);
    const { hook, injected } = startHook(h);
    check('初始：a / b / c / y 都是 dataless，启动不注入', [hook.isDataless(a), hook.isDataless(b), hook.isDataless(c), hook.isDataless(y), injected.length], [true, true, true, true, 0]);
    check('sizeOf / settleMs / brctlMode / statDetection', [hook.sizeOf(b), hook.sizeOf(a), hook.settleMs, hook.brctlMode, hook.statDetection], [209715200, undefined, 500, 'supported', true]);
    let r = await streamEnd(hook.readStub(a));
    check('读取回退桩：默认 delay:300 后 close，桩不真读文件（只给 1 字节）', [r.error, r.data], [null, 1]);
    check('materialize a → isDataless(a) false，且没有注入事件', [hook.isDataless(a), injected.length], [false, 0]);
    writeJson(h.file, { ...cfg, other: 2 });
    hook.reloadNow();
    check('读-改-写（只改无关字段）→ a 仍是本地、没有注入', [hook.isDataless(a), injected.length], [false, 0]);
    writeJson(h.file, { ...cfg, dataless: [b, c] });
    hook.reloadNow();
    check('文件里删掉 a → 仍是本地、没有事件', [hook.isDataless(a), injected.length], [false, 0]);
    writeJson(h.file, { ...cfg, dataless: [a, b, c] });
    hook.reloadNow();
    check('再加回 a → isDataless(a) true、注入一次 a', [hook.isDataless(a), injected], [true, [[a]]]);
    injected.length = 0;
    writeJson(h.file, { ...cfg, dataless: [a, b] });
    hook.reloadNow();
    check('silent 里的 c 变化不注入，但集合照样变', [hook.isDataless(c), injected], [false, []]);
    writeJson(h.file, { ...cfg, dataless: [a] });
    hook.reloadNow();
    check('b 移出 → 注入 b', injected, [[b]]);
    injected.length = 0;
    r = await streamEnd(hook.readStub(y));
    check('stickyDataless 被 materialize 之后仍是 dataless', hook.isDataless(y), true);
    writeJson(h.file, { ...cfg, dataless: [a], touchMeta: { [a]: 1 } });
    hook.reloadNow();
    writeJson(h.file, { ...cfg, dataless: [a], touchMeta: { [a]: 2 } });
    hook.reloadNow();
    check('touchMeta 计数变化也注入（新增一次、变化一次）', injected, [[a], [a]]);
    check('debug() 给出 materialized / mem（原始写法）', hook.debug().mem.sort(), [a, y].sort());
    check('auditSet 含 dataless / sticky 的 resolve 与 canon 两种写法',
      [hook.auditSet.has(a), hook.auditSet.has(fs.realpathSync(a)), hook.auditSet.has(y)], [true, true, true]);
    injected.length = 0;

    console.log('\n[loadTestHook] readBehavior / brctlStub');
    writeJson(h.file, { dataless: [a, b], readBehavior: { [a]: 'fail:EIO', [b]: 'delay:30' }, brctl: 'supported' });
    hook.reloadNow();
    r = await streamEnd(hook.readStub(a));
    check('fail:EIO → 流以 EIO 失败，不改集合', [r.error, hook.isDataless(a)], ['EIO', true]);
    const t0 = Date.now();
    r = await streamEnd(hook.readStub(b));
    check('delay:30 → 约 30ms 后完成并 materialize', [r.error, Date.now() - t0 < 250, hook.isDataless(b)], [null, true, false]);
    const ph = put(path.join(root, '.p.md.icloud'), 'plist');
    const p = path.join(root, 'p.md');
    writeJson(h.file, { dataless: [a], brctl: 'supported', brctlBehavior: 'materialize', materializeContent: '# hi\n' });
    hook.reloadNow();
    let cbArgs = await new Promise((res) => hook.brctlStub('brctl', ['download', p], { timeout: 1000, windowsHide: true }, (...x) => res(x)));
    check('brctl materialize 占位：写出原文件、删掉占位', [cbArgs[0], fs.readFileSync(p, 'utf8'), fs.existsSync(ph)], [null, '# hi\n', false]);
    cbArgs = await new Promise((res) => hook.brctlStub('brctl', ['download', a], { timeout: 1000, windowsHide: true }, (...x) => res(x)));
    check('brctl materialize dataless：移出集合', [cbArgs[0], hook.isDataless(a)], [null, false]);
    const lines = fs.readFileSync(path.join(h.home, 'test-brctl-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bl = lines.filter((l) => l.fn === 'brctl');
    check('brctl 调用记录 {fn, file, argv, opts}，opts 原样（没有 shell）',
      [bl.length, bl[0].file, bl[0].argv, bl[0].opts], [2, 'brctl', ['download', p], { timeout: 1000, windowsHide: true }]);
    check('readStub 调用记为 fn:read', lines.filter((l) => l.fn === 'read').length >= 4, true);
    writeJson(h.file, { dataless: [a], brctlBehavior: 'fail' });
    hook.reloadNow();
    cbArgs = await new Promise((res) => hook.brctlStub('brctl', ['download', a], {}, (...x) => res(x)));
    check('brctlBehavior fail → 回调 error code 1', cbArgs[0] && cbArgs[0].code, 1);
    writeJson(h.file, { dataless: [a], brctlBehavior: 'hang' });
    hook.reloadNow();
    let called = false;
    const child = hook.brctlStub('brctl', ['download', a], {}, () => { called = true; });
    await sleep(80);
    check('brctlBehavior hang → 不回调', called, false);
    check('假子进程 kill() 返回 true 并回调 killed', [child.kill('SIGKILL'), await waitFor(() => called, 500), child.killed], [true, true, true]);

    console.log('\n[loadTestHook] N6 写坏 JSON');
    writeJson(h.file, { dataless: [a, c] });
    hook.reloadNow();
    injected.length = 0;
    const before = [hook.isDataless(a), hook.isDataless(c)];
    fs.writeFileSync(h.file, '{"dataless": [');
    await sleep(350);   // 等 100ms 轮询看到
    check('解析失败：状态不变', [hook.isDataless(a), hook.isDataless(c)], before);
    check('解析失败：inject 未被调用', injected.length, 0);
    hook.close();
  }
  {
    // N6 的 warn 计数单独起一个钩子，避免和上面的日志混在一起
    const h = makeHookHome('n6');
    const a = put(path.join(h.home, 'r', 'a.md'), '#');
    writeJson(h.file, { dataless: [a] });
    const { hook, injected, log } = startHook(h);
    fs.writeFileSync(h.file, '{"dataless": [ broken');
    await sleep(350);
    check('N6：写坏 JSON → isDataless 不变、spy 未调用、warn 1 次', [hook.isDataless(a), injected.length, log.warns.length], [true, 0, 1]);
    writeJson(h.file, { dataless: [] });
    await sleep(350);
    check('之后写回合法内容 → 轮询重新生效并注入', [hook.isDataless(a), injected], [false, [[a]]]);
    hook.close();
  }

  console.log('\n[loadTestHook] M1 按 realpath 记账');
  {
    const h = makeHookHome('m1');
    // 钩子临时目录本身在 macOS 上就是 /var → /private/var；再额外造一层符号链接根
    const realRoot = path.join(h.home, 'real-root');
    const linkRoot = path.join(h.home, 'link-root');
    put(path.join(realRoot, 'a.md'), '# a');
    put(path.join(realRoot, 'b.md'), '# b');
    fs.symlinkSync(realRoot, linkRoot);
    const la = path.join(linkRoot, 'a.md');
    const ra = path.join(realRoot, 'a.md');
    const lb = path.join(linkRoot, 'b.md');
    writeJson(h.file, { dataless: [la], settleMs: 1500 });
    const { hook, injected } = startHook(h);
    check('符号链接根：link 写法登记 → isDataless(link 写法) true', hook.isDataless(la), true);
    check('同一文件的 real 写法也是 true', hook.isDataless(ra), true);
    await streamEnd(hook.readStub(fs.realpathSync(ra)));
    check('读取回退桩收到 realpath 写法 → link 与 real 写法都变成本地',
      [hook.isDataless(la), hook.isDataless(ra)], [false, false]);
    writeJson(h.file, { dataless: [], settleMs: 1500 });
    hook.reloadNow();
    writeJson(h.file, { dataless: [la], settleMs: 1500 });
    hook.reloadNow();
    check('删掉再加回 → 注入 spy 收到的是原写法（link-root）', injected, [[la]]);

    // 钩子 + 下载器联调：abs 用 link 写法、real 用 realpath 写法，最终 done（不是 not-materialized）
    const events = [];
    const mkDl = () => createDownloader({
      execFile: () => { throw new Error('不应调用 brctl'); },
      createReadStream: hook.readStub,
      stat: fsp.stat, lstat: fsp.lstat,
      isDataless: (abs) => hook.isDataless(abs),
      placeholderPath: icloud.placeholderPathFor,
      probe: async () => ({ brctl: { present: true, download: false } }),
      onUpdate: (e) => events.push(e),
      pollMs: 50, settleMs: hook.settleMs, log: silentLog(),
    });
    const d = mkDl();
    d.request({ abs: la, real: fs.realpathSync(la), kind: 'dataless', size: 3 });
    const f = await waitFor(() => events.find((e) => e.path === la && (e.phase === 'done' || e.phase === 'error')), 4000);
    check('钩子 + 下载器联调：link 写法的 abs + realpath 的 real → done', f && f.phase, 'done');

    writeJson(h.file, { dataless: [la, lb], readBehavior: { [lb]: 'fail:EIO' }, settleMs: 1500 });
    hook.reloadNow();
    d.request({ abs: lb, real: fs.realpathSync(lb), kind: 'dataless', size: 3 });
    const f2 = await waitFor(() => events.find((e) => e.path === lb && (e.phase === 'done' || e.phase === 'error')), 4000);
    check('readBehavior 用 link 写法登记 fail:EIO，桩收到 realpath 写法 → io-error', f2 && f2.reason, 'io-error');
    hook.close();
  }

  console.log('\n[installReadAudit]');
  {
    const h = makeHookHome('audit');
    const dir = path.join(h.home, 'r');
    const a = put(path.join(dir, 'aud.md'), '# a');
    const o = put(path.join(dir, 'other.md'), '# o');
    const extra = path.join(h.home, 'outside', 'secret.md');
    put(extra, 's');
    writeJson(h.file, { dataless: [a], auditExtra: [extra], audit: true });
    const { hook } = startHook(h);
    const auditFile = path.join(h.home, 'cloud-read-audit.jsonl');
    const uninstall = icloud.installReadAudit(hook, auditFile);
    fs.readFileSync(a);
    fs.readFileSync(o);
    await fs.promises.readFile(fs.realpathSync(a));
    fs.readFileSync(pathToFileURL(extra));
    fs.readFileSync(Buffer.from(extra));
    await new Promise((res) => { const s = fs.createReadStream(a); s.on('close', res); s.resume(); });
    const fd = fs.openSync(a, 'r'); fs.closeSync(fd);
    fs.copyFileSync(a, path.join(dir, 'copy.md'));
    await sleep(20);
    const readRows = () => fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const rows = readRows();
    uninstall();
    fs.readFileSync(a);
    const fns = rows.map((r) => r.fn);
    check('命中审计集合的读取都记了下来（resolve / canon / URL / Buffer 写法）',
      [fns.filter((f) => f === 'readFileSync').length, ['promises.readFile', 'createReadStream', 'openSync', 'copyFileSync'].every((f) => fns.includes(f))], [3, true]);
    check('同步嵌套只记最外层（readFileSync 内部的 openSync 不重复记）', fns.filter((f) => f === 'openSync').length, 1);
    check('不在集合里的文件不记', rows.some((r) => r.path.endsWith('other.md')), false);
    check('卸载之后不再记录', readRows().length, rows.length);
    check('卸载后 fs 函数恢复原样', fs.readFileSync.name, 'readFileSync');
    hook.close();
  }
}

// ---------------------------------------------------------------------------
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}
function batcher() {
  console.log('\n[createBatcher]（假时钟）');
  {
    const clk = fakeClock();
    const out = [];
    const b = icloud.createBatcher({ debounceMs: 250, maxWaitMs: 1000, flush: (items) => out.push({ at: clk.now(), items }), ...clk });
    for (let i = 0; i < 5; i++) { b.push({ path: `/p${i}`, phase: 'state', cloud: 'dataless' }); clk.advance(200); }
    clk.advance(2000);
    check('5 次推送间隔 200ms → 只刷 1 批（maxWait 1000ms）', out.map((o) => [o.at, o.items.length]), [[1000, 5]]);
  }
  {
    const clk = fakeClock();
    const out = [];
    const b = icloud.createBatcher({ flush: (items) => out.push(items), ...clk });
    b.push({ path: '/a', phase: 'state', cloud: 'dataless', busy: true });
    clk.advance(50);
    check('尾部去抖：250ms 内不刷', out.length, 0);
    clk.advance(250);
    check('静默 250ms 后刷出', out.length, 1);
  }
  {
    const clk = fakeClock();
    const out = [];
    const b = icloud.createBatcher({ flush: (items) => out.push(items), ...clk });
    b.push({ path: '/a', phase: 'started', cloud: 'dataless', busy: true });
    b.push({ path: '/a', phase: 'done', cloud: null, busy: false });
    b.push({ path: '/a', phase: 'state', cloud: null, busy: false, mtime: 5, size: 9 });
    b.push({ path: '/b', phase: 'done', cloud: null, busy: false });
    b.push({ path: '/b', phase: 'error', reason: 'io-error', message: 'm', cloud: 'dataless', busy: false });
    b.push({ path: '/b', phase: 'state', cloud: 'placeholder', busy: false });
    clk.advance(300);
    const [items] = out;
    const A = items.find((x) => x.path === '/a');
    const B = items.find((x) => x.path === '/b');
    check('同一路径 done 后接 state → phase done、cloud / mtime / size 取最后一条（N12）', [A.phase, A.cloud, A.mtime, A.size], ['done', null, 5, 9]);
    check('error 优先于 done，reason / message 跟随 error，cloud 取最后一条', [B.phase, B.reason, B.message, B.cloud], ['error', 'io-error', 'm', 'placeholder']);
    check('一批里每个路径一条', items.length, 2);
    b.push({ path: '/c', phase: 'state' });
    b.close();
    clk.advance(2000);
    check('close() 清掉待发的批次', out.length, 1);
  }
}

// ---------------------------------------------------------------------------
async function linkIndexSkip() {
  console.log('\n[link-index] skip(abs, st)');
  const dir = mk('li');
  const root = path.join(dir, 'root');
  const a = put(path.join(root, 'a.md'), '[b](b.md)');
  const b = put(path.join(root, 'b.md'), '[a](a.md)');
  const origOpen = fsp.open;
  const opens = [];
  fsp.open = function (p, ...rest) { opens.push(String(p)); return origOpen.call(this, p, ...rest); };
  try {
    const idx = createLinkIndex({ cacheDir: path.join(dir, 'c1'), getRoots: () => [root], isIndexed: () => true, skip: (p) => p === a, log: silentLog() });
    idx.sync([a, b]);
    await idx.whenIdle();
    check('sync 时 skip(p, null) 为 true → 不解析（没有 open）', opens.includes(a), false);
    check('其他文件照常解析', opens.includes(b), true);
    check('被 skip 的文件没有出边', idx.snapshot().edges.map(([s, t]) => [idx.snapshot().paths[s], idx.snapshot().paths[t]]), [[b, a]]);
    opens.length = 0;
    idx.update(a, false);
    await idx.whenIdle();
    check('update 时 skip(p, null) 为 true → 直接 return', opens.includes(a), false);
    idx.flush();

    opens.length = 0;
    const seen = [];
    const idx2 = createLinkIndex({ cacheDir: path.join(dir, 'c2'), getRoots: () => [root], isIndexed: () => true, log: silentLog(),
      skip: (p, st) => { seen.push([p, st ? 'st' : null]); return p === a && !!st; } });
    idx2.sync([a, b]);
    await idx2.whenIdle();
    check('parseFile 用刚拿到的 stat 再判一次 → readHead 前拦下（fs.promises.open 计数为 0）', opens.filter((p) => p === a).length, 0);
    check('skip 先以 null、再以 stat 调用', seen.filter(([p]) => p === a).map(([, s]) => s), [null, 'st']);
    check('被拦下的文件没有出边', idx2.snapshot().edges.length, 1);
    idx2.flush();

    opens.length = 0;
    const idx3 = createLinkIndex({ cacheDir: path.join(dir, 'c3'), getRoots: () => [root], isIndexed: () => true, log: silentLog() });
    idx3.sync([a, b]);
    await idx3.whenIdle();
    check('不传 skip 时行为不变', [opens.includes(a), opens.includes(b), idx3.snapshot().edges.length], [true, true, 2]);
    idx3.flush();
  } finally {
    fsp.open = origOpen;
  }
}

// ---------------------------------------------------------------------------
async function thumbnailerCheckSource() {
  console.log('\n[thumbnail] checkSource');
  const dir = mk('th');
  const doc = put(path.join(dir, 'docs', 'a.html'), '<p>x</p>');
  const run = async (checkSource) => {
    const events = [];
    const spawns = [];
    const renders = [];
    const log = silentLog();
    const t = thumbnail.createThumbnailer({
      cacheDir: path.join(dir, 'cache-' + Math.random().toString(36).slice(2)),
      chromium: {
        findChromium: () => ({ name: 'Fake', path: '/fake/chrome' }),
        runExclusive: (job) => Promise.resolve().then(() => job({ preempted: false, track() {} })),
        spawn: (...a) => { spawns.push(a); throw new Error('不应 spawn'); },
      },
      renderSource: async (...a) => { renders.push(a); return { error: 'failed' }; },
      onEvent: (e) => events.push(e),
      log,
      indexWriteDebounceMs: 10,
      checkSource,
    });
    t.request([doc], 'light');
    await waitFor(() => events.length, 2000);
    const r = { events, spawns, renders, warns: log.warns, entries: t._debug.index().entries, has: t.hasCheckSource() };
    t.shutdown();
    return r;
  };
  let r = await run(async () => 'cloud-deps');
  check('checkSource → cloud-deps：事件 status 为 cloud-deps', r.events.map((e) => e.status), ['cloud-deps']);
  check('renderSource 与 spawn 都没被调用', [r.renders.length, r.spawns.length], [0, 0]);
  check('index 里没有失败计数', Object.keys(r.entries).length, 0);
  check('hasCheckSource() → true', r.has, true);
  r = await run(async () => { throw new Error('boom'); });
  check('checkSource 抛错（M3）→ 事件 status 为 deps-unverified', r.events.map((e) => e.status), ['deps-unverified']);
  check('抛错时 renderSource 与 spawn 也都没被调用', [r.renders.length, r.spawns.length], [0, 0]);
  check('抛错时 warn 一行', r.warns.filter((w) => w.includes('依赖检查失败')).length, 1);
  r = await run(async () => 'cloud');
  check('checkSource → cloud', r.events.map((e) => e.status), ['cloud']);
  r = await run(undefined);
  check('不传 checkSource：hasCheckSource() false，照常进入 renderSource', [r.has, r.renders.length >= 1], [false, true]);
}

// ---------------------------------------------------------------------------
(async () => {
  pureFunctions();
  extractRefs();
  await renderDeps();
  iCloudConfig();
  await downloadTarget();
  await downloader();
  await testHook();
  batcher();
  await linkIndexSkip();
  await thumbnailerCheckSource();
  await sleep(100);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log('\n========================');
  console.log(`总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(1);
});
