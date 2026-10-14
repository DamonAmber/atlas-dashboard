// 真实缩略图（design §3b）
//
// 四段：
//   ① 纯 node 单测：注入假 chromium（假 spawn 写出一张 PNG）/ 假 renderSource，不需要浏览器——
//      key / normTheme / HTML 双主题只截一次 / 过期 / LRU / index 损坏恢复 / 去重 + LIFO /
//      第 65 个挤掉最旧 / 熔断 / runExclusive 高优抢占 / OFFLINE_ARGS / 截图参数 / 远程依赖检测
//   ② 接口：startAtlas（ATLAS_THUMBS 默认 off）——GET 非法 theme 400、跨站 403、k 不匹配 404、POST 超 48 项 400
//   ③ 前端：webdriver 闸门、__atlasForceThumbs、主题、dropped 后只重请求那一条、ready 换图
//   ④ 集成（本机没有 Chromium 系浏览器时 SKIP）：真截一张，页面脚本一次都打不到 Atlas 端口
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const ROOT = path.join(__dirname, '..');
const { chromium: pw } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');
const chromiumLib = require(path.join(ROOT, 'lib/chromium.js'));
const thumbnail = require(path.join(ROOT, 'lib/thumbnail.js'));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 5000, stepMs = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

// 真 PNG（1×1）：给前端路由用，<img> 要能解码
function realPng() {
  const crc32 = (buf) => {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
      c = (crc ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.from([0, 120, 120, 200, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// 假截图产物：只要文件头宽高与尾部 IEND（thumbnail.js 不解码）
function fakePng(w = 640, h = 400) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  const body = crypto.randomBytes(200);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, body, iend]);
}

// 假 spawn。mode：'exit'（写完立即退出）/ 'linger'（写完不退，等 stopChild）/ 'empty'（不写就退）/ 'enoent'
function makeFakeSpawn(state) {
  return (bin, args) => {
    state.calls.push(args);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kills = [];
    const exit = (code, sig) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (sig) child.signalCode = sig; else child.exitCode = code;
      setImmediate(() => child.emit('exit', code, sig || null));
    };
    child.kill = (sig) => { child.kills.push(sig); exit(null, sig || 'SIGTERM'); return true; };
    state.children.push(child);
    const mode = typeof state.mode === 'function' ? state.mode(args) : state.mode;
    if (mode === 'enoent') {
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    }
    setImmediate(() => child.emit('spawn'));
    const out = args.find(a => a.startsWith('--screenshot=')).slice('--screenshot='.length);
    setTimeout(() => {
      if (mode !== 'empty') fs.writeFileSync(out, fakePng());
      if (mode === 'exit' || mode === 'empty') exit(0);
    }, 5);
    return child;
  };
}
// 测试专用的串行队列（真正的 runExclusive 是进程级共享的，单独测）
function serialQueue() {
  let q = Promise.resolve();
  return (job) => {
    const ctx = { preempted: false, child: null, track(c) { ctx.child = c; } };
    const next = q.then(() => job(ctx));
    q = next.catch(() => {});
    return next;
  };
}
function fakeChromium(spawnState, { available = true } = {}) {
  return {
    findChromium: () => (available ? { name: 'FakeChrome', path: '/fake/chrome' } : null),
    runExclusive: serialQueue(),
    makeProfileDir: chromiumLib.makeProfileDir,
    waitForStableFile: chromiumLib.waitForStableFile,
    stopChild: chromiumLib.stopChild,
    OFFLINE_ARGS: chromiumLib.OFFLINE_ARGS,
    spawn: makeFakeSpawn(spawnState),
  };
}
function makeEnv(name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-thumbspec-' + name + '-'));
  const docs = path.join(dir, 'docs');
  const cacheDir = path.join(dir, 'thumbnails');
  fs.mkdirSync(docs, { recursive: true });
  const spawnState = { calls: [], children: [], mode: opts.mode || 'exit' };
  const events = [];
  const warns = [];
  const renderCalls = [];
  const log = { warn: (...a) => warns.push(a.join(' ')), log() {} };
  const made = [];
  const make = (extra = {}) => { const t = thumbnail.createThumbnailer({
    cacheDir,
    chromium: fakeChromium(spawnState, opts),
    log,
    onEvent: (e) => events.push(e),
    async renderSource(abs, theme) {
      renderCalls.push([abs, theme]);
      if (thumbnail.isHtmlPath(abs)) return { htmlPath: abs, cleanup: null };
      const tmp = path.join(dir, 'rendered-' + path.basename(abs) + '-' + theme + '.html');
      fs.writeFileSync(tmp, '<p>rendered</p>');
      return { htmlPath: tmp, cleanup: () => fs.rmSync(tmp, { force: true }) };
    },
    indexWriteDebounceMs: 20,
    ...opts.thumbOpts,
    ...extra,
  }); made.push(t); return t; };
  const write = (rel, content = '<!doctype html><p>x</p>') => {
    const p = path.join(docs, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  return { dir, docs, cacheDir, spawnState, events, warns, renderCalls, make, write,
    // 先等后台任务收尾（防抖写 index 会 mkdir 缓存目录），再删整个临时目录
    cleanup: async () => {
      await sleep(80);
      for (const t of made) t.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    } };
}

async function unitTests() {
  console.log('\n[单测] 纯函数');
  check('normTheme：HTML → -', thumbnail.normTheme('/a/b.html', 'dark'), '-');
  check('normTheme：.HTM 也算 HTML', thumbnail.normTheme('/a/B.HTM', 'light'), '-');
  check('normTheme：MD 原样', thumbnail.normTheme('/a/b.md', 'dark'), 'dark');
  check('normTheme：CSV 原样', thumbnail.normTheme('/a/b.csv', 'light'), 'light');
  const k = thumbnail.cacheKey('/a/b.md', 1234.5, 99, 'dark');
  const manual = crypto.createHash('sha1')
    .update(`${thumbnail.RENDER_VER}\0/a/b.md\0${1234.5}\0${99}\0dark`).digest('hex').slice(0, 16);
  check('key = sha1(RENDER_VER\\0abs\\0mtime\\0size\\0normTheme) 前 16 位', k, manual);
  check('key 是 16 位十六进制', /^[0-9a-f]{16}$/.test(k), true);
  check('mtime 变 → key 变', thumbnail.cacheKey('/a/b.md', 1235, 99, 'dark') !== k, true);
  check('size 变 → key 变', thumbnail.cacheKey('/a/b.md', 1234.5, 98, 'dark') !== k, true);
  check('主题变 → key 变', thumbnail.cacheKey('/a/b.md', 1234.5, 99, 'light') !== k, true);

  check('OFFLINE_ARGS 三项断网参数', [...chromiumLib.OFFLINE_ARGS], [
    '--proxy-server=127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ]);
  const args = thumbnail.buildCaptureArgs({
    profileDir: '/tmp/p', outPath: '/tmp/p/o.png', htmlUrl: 'file:///x/y.html', offlineArgs: chromiumLib.OFFLINE_ARGS,
  });
  check('截图参数：--headless=new', args.includes('--headless=new'), true);
  check('截图参数：800×500 视口 + 0.8 倍缩放（640×400 PNG，首屏上部）', args.includes('--window-size=800,500') && args.includes('--force-device-scale-factor=0.8'), true);
  check('截图参数：--virtual-time-budget=3000', args.includes('--virtual-time-budget=3000'), true);
  check('截图参数：带全部 OFFLINE_ARGS', chromiumLib.OFFLINE_ARGS.every(a => args.includes(a)), true);
  if (!(typeof process.getuid === 'function' && process.getuid() === 0)) {
    check('截图参数：非 root 不加 --no-sandbox', args.includes('--no-sandbox'), false);
  }
  check('截图参数：不加 --allow-file-access-from-files', args.some(a => a.includes('allow-file-access')), false);
  check('截图参数：只用 file:// 打开（最后一项）', args[args.length - 1], 'file:///x/y.html');

  // MD 缩略图渲染页（client-fix review #2）：800 宽下目录栏是浮层、会盖住标题，缩略图版不带目录 / 宽度胶囊
  {
    const md = require('../public/vendor/markdown');
    const src = '# 需求说明\n\n正文\n\n## 背景\n\n一\n\n## 方案\n\n二\n';
    const thumbPage = md.renderPage(src, { title: 'a.md', forThumb: true });
    const readPage = md.renderPage(src, { title: 'a.md' });
    check('MD 缩略图渲染页：没有目录栏 / 目录开关 / 宽度胶囊，body 是 md-no-toc',
      [/id="mdToc"/.test(thumbPage), /id="mdTocToggle"/.test(thumbPage), /class="md-width-switch/.test(thumbPage), /<body class="md-no-toc">/.test(thumbPage)],
      [false, false, false, true]);
    check('MD 缩略图渲染页：标题与正文都在', [/需求说明/.test(thumbPage), /md-inner/.test(thumbPage)], [true, true]);
    check('普通预览页不受影响：仍有目录栏与宽度胶囊', [/id="mdToc"/.test(readPage), /class="md-width-switch/.test(readPage)], [true, true]);
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('server 缩略图 renderSource 以 forThumb: true 渲染 MD', /renderForCapture\(absPath, theme, \{ forPrint: false, forThumb: true \}\)/.test(serverSrc), true);
    check('RENDER_VER ≥ 3（旧的带目录 MD 封面作废）', thumbnail.RENDER_VER >= 3, true);
  }
  check('截图参数：没有 http(s) 地址', args.some(a => /^https?:/.test(a)), false);

  console.log('\n[单测] 远程依赖检测');
  const yes = [
    '<script src="https://cdn.tailwindcss.com"></script>',
    '<script src=//cdn.jsdelivr.net/npm/chart.js></script>',
    "<script type=\"module\" src='http://x.test/a.js'></script>",
    '<link rel="stylesheet" href="https://x.test/a.css">',
    '<link rel=stylesheet href=//x.test/a.css>',
    '<link href="https://x.test/a.css" rel="stylesheet">',
  ];
  const no = [
    '<script src="./chart.js"></script>',
    '<script src="vendor/echarts.min.js"></script>',
    '<a href="https://example.com">链接</a>',
    '<p>参考 https://example.com 的文档</p>',
    '<link rel="icon" href="https://x.test/favicon.ico">',
    '<script>const u = "https://api.test/x";</script>',
  ];
  for (const h of yes) check('判 remote-deps：' + h, thumbnail.detectRemoteDeps(h), true);
  for (const h of no) check('不判：' + h, thumbnail.detectRemoteDeps(h), false);

  console.log('\n[单测] runExclusive：高优抢占低优');
  {
    const order = [];
    const mkChild = () => {
      const c = new EventEmitter();
      c.exitCode = null; c.signalCode = null; c.kills = [];
      c.kill = (sig) => { c.kills.push(sig); c.signalCode = sig; setImmediate(() => c.emit('exit', null, sig)); };
      return c;
    };
    let lowRuns = 0;
    const firstChild = mkChild();
    const low = chromiumLib.runExclusive((ctx) => new Promise((resolve) => {
      lowRuns++;
      order.push('low-start-' + lowRuns);
      const child = lowRuns === 1 ? firstChild : mkChild();
      ctx.track(child);
      child.on('exit', () => resolve('low-result-' + lowRuns));
      if (lowRuns > 1) setTimeout(() => { child.exitCode = 0; child.emit('exit', 0); }, 10);
    }), { priority: 'low' });
    await sleep(20);
    const high = chromiumLib.runExclusive(async () => { order.push('high'); return 'high-result'; }, { priority: 'high' });
    const [lr, hr] = await Promise.all([low, high]);
    check('低优子进程收到 SIGTERM', firstChild.kills[0], 'SIGTERM');
    check('执行顺序：低优 → 高优 → 低优重跑', order, ['low-start-1', 'high', 'low-start-2']);
    check('高优拿到自己的结果', hr, 'high-result');
    check('被抢占的低优以重跑结果返回', lr, 'low-result-2');
  }

  console.log('\n[单测] HTML：light / dark 只入队一次、只截一次，两条 ready 同一个 k');
  {
    const env = makeEnv('html', { mode: 'linger' });
    const t = env.make();
    const p = env.write('a/report.html');
    const r1 = t.request([p], 'light');
    const r2 = t.request([p], 'dark');
    check('首次请求 queued', r1.items[p].status, 'queued');
    check('第二个主题也 queued', r2.items[p].status, 'queued');
    const done = await waitFor(() => env.events.filter(e => e.status === 'ready').length >= 2, 5000);
    check('收到两条 ready', !!done, true);
    const ready = env.events.filter(e => e.status === 'ready');
    check('ready 的主题分别是 light / dark（不会是 -）', ready.map(e => e.theme).sort(), ['dark', 'light']);
    check('两条 ready 的 k 相同', ready[0].k === ready[1].k && /^[0-9a-f]{16}$/.test(ready[0].k), true);
    check('只 spawn 了一次', env.spawnState.calls.length, 1);
    check('写完不退出的 Chrome 被 stopChild 收掉（SIGTERM）', env.spawnState.children[0].kills[0], 'SIGTERM');
    check('HTML 用原文件 file:// 打开', env.spawnState.calls[0][env.spawnState.calls[0].length - 1].startsWith('file://' + env.docs), true);
    const k1 = ready[0].k;
    check('再请求 light → ready + k', t.request([p], 'light').items[p], { status: 'ready', k: k1 });
    check('再请求 dark → ready + 同一 k', t.request([p], 'dark').items[p], { status: 'ready', k: k1 });
    check('get：k 对得上 → 给文件', !!t.get(p, 'dark', k1), true);
    check('get：k 不对 → null', t.get(p, 'dark', '0000000000000000'), null);
    check('PNG 落到缓存目录', fs.existsSync(path.join(env.cacheDir, k1 + '.png')), true);
    t.flush();
    const idx = JSON.parse(fs.readFileSync(path.join(env.cacheDir, 'index.json'), 'utf8'));
    check('index.json：v=1、键是 -|<abs>', idx.v === 1 && !!idx.entries['-|' + p] && !idx.entries['light|' + p], true);

    console.log('\n[单测] 过期判定：mtime 变了 → stale（先给旧图）→ 新图');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(p, future, future);
    const rs = t.request([p], 'light').items[p];
    check('stale 且带旧 k', rs, { status: 'stale', k: k1 });
    await waitFor(() => env.events.filter(e => e.status === 'ready').length >= 3, 5000);
    const k2 = env.events.filter(e => e.status === 'ready').pop().k;
    check('新图 k 不同', k2 !== k1, true);
    check('旧 PNG 已删除', fs.existsSync(path.join(env.cacheDir, k1 + '.png')), false);
    check('旧 k 再取 → null', t.get(p, 'light', k1), null);

    console.log('\n[单测] invalidate（源文件被删）');
    t.invalidate(p);
    check('条目与 PNG 一并删除', fs.existsSync(path.join(env.cacheDir, k2 + '.png')) || !!t.get(p, 'light', k2), false);
    await env.cleanup();
  }

  console.log('\n[单测] MD：按主题各截一份');
  {
    const env = makeEnv('md');
    const t = env.make();
    const p = env.write('a/note.md', '# hi');
    t.request([p], 'light');
    t.request([p], 'dark');
    await waitFor(() => env.events.filter(e => e.status === 'ready').length >= 2, 5000);
    check('spawn 两次', env.spawnState.calls.length, 2);
    check('renderSource 收到各自的主题', env.renderCalls.map(c => c[1]).sort(), ['dark', 'light']);
    const ks = env.events.filter(e => e.status === 'ready').map(e => e.k);
    check('两个主题 k 不同', ks[0] !== ks[1], true);
    check('临时渲染页已清理', fs.readdirSync(env.dir).filter(n => n.startsWith('rendered-')), []);
    await env.cleanup();
  }

  console.log('\n[单测] remote-deps：不截图，按 mtime 缓存结论');
  {
    const env = makeEnv('remote');
    const t = env.make();
    const p = env.write('cdn.html', '<!doctype html><script src="https://cdn.tailwindcss.com"></script><p>x</p>');
    t.request([p], 'light');
    await waitFor(() => env.events.length >= 1, 3000);
    check('事件 remote-deps', env.events.map(e => e.status), ['remote-deps']);
    check('没有 spawn 浏览器', env.spawnState.calls.length, 0);
    check('再问 → remote-deps', t.request([p], 'dark').items[p].status, 'remote-deps');
    await env.cleanup();
  }

  console.log('\n[单测] 同一 mtime 失败 2 次 → failed');
  {
    const env = makeEnv('fail', { mode: 'empty' });
    const t = env.make();
    const p = env.write('bad.html');
    t.request([p], 'light');
    await waitFor(() => env.events.some(e => e.status === 'failed'), 5000);
    check('最终 failed', env.events.map(e => e.status), ['failed']);
    check('恰好尝试 2 次', env.spawnState.calls.length, 2);
    check('再问 → failed，不再重试', t.request([p], 'light').items[p].status, 'failed');
    await sleep(50);
    check('没有第 3 次 spawn', env.spawnState.calls.length, 2);
    await env.cleanup();
  }

  console.log('\n[单测] LRU：超过条目上限淘汰最久没用的');
  {
    const env = makeEnv('lru', { thumbOpts: { maxEntries: 2 } });
    const t = env.make();
    const ps = ['1.html', '2.html', '3.html'].map(n => env.write(n));
    for (const [i, p] of ps.entries()) {
      t.request([p], 'light');
      await waitFor(() => env.events.filter(e => e.status === 'ready').length >= i + 1, 3000);
      await sleep(5);
    }
    const ks = env.events.filter(e => e.status === 'ready').map(e => e.k);
    check('最旧的 PNG 被淘汰', fs.existsSync(path.join(env.cacheDir, ks[0] + '.png')), false);
    check('较新的两张保留', ks.slice(1).every(k => fs.existsSync(path.join(env.cacheDir, k + '.png'))), true);
    check('被淘汰的回到 queued（重新请求）', t.request([ps[0]], 'light').items[ps[0]].status, 'queued');
    await env.cleanup();
  }

  console.log('\n[单测] index.json 损坏 → 空缓存 + 清扫孤儿 + warn 一次');
  {
    const env = makeEnv('corrupt');
    fs.mkdirSync(env.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(env.cacheDir, 'index.json'), '{not json');
    fs.writeFileSync(path.join(env.cacheDir, 'deadbeefdeadbeef.png'), fakePng());
    const t = env.make();
    check('warn 一次', env.warns.filter(w => w.includes('index.json')).length, 1);
    check('孤儿 PNG 被删', fs.existsSync(path.join(env.cacheDir, 'deadbeefdeadbeef.png')), false);
    const p = env.write('ok.html');
    check('照常可用', t.request([p], 'light').items[p].status, 'queued');
    await waitFor(() => env.events.some(e => e.status === 'ready'), 3000);
    t.flush();
    check('index 重新写成合法 JSON', JSON.parse(fs.readFileSync(path.join(env.cacheDir, 'index.json'), 'utf8')).v, 1);
    await env.cleanup();
  }

  console.log('\n[单测] 队列：去重、LIFO、上限 64（第 65 个挤掉最旧并发 dropped）');
  {
    let busy = true;
    const env = makeEnv('queue', { thumbOpts: { isBusy: () => busy, busyRetryMs: 30 } });
    const t = env.make();
    const ps = [];
    for (let i = 0; i < 65; i++) ps.push(env.write(`q/${String(i).padStart(2, '0')}.html`));
    t.request([ps[0]], 'light');
    t.request([ps[1]], 'light');
    t.request([ps[0]], 'dark');          // 去重：同一 HTML 只一条，移到队尾，主题并进集合
    let q = t._debug.queue();
    check('同一篇 HTML 去重为一条', q.length, 2);
    check('再次请求移到队尾', q[q.length - 1].id, '-|' + ps[0]);
    check('requestedThemes 合并', q[q.length - 1].themes.sort(), ['dark', 'light']);
    for (let i = 2; i < 65; i++) t.request([ps[i]], 'light');
    q = t._debug.queue();
    check('队列上限 64', q.length, 64);
    const dropped = env.events.filter(e => e.status === 'dropped');
    check('最旧的被挤出并发 dropped', dropped.map(e => e.path), [ps[1]]);
    check('忙时（索引构建 / 批量写入）不出队', env.spawnState.calls.length, 0);
    busy = false;
    await waitFor(() => env.spawnState.calls.length >= 1, 2000);
    const first = env.spawnState.calls[0];
    check('LIFO：最后请求的最先截', first[first.length - 1].endsWith('/q/64.html'), true);
    await waitFor(() => env.events.filter(e => e.status === 'ready').length >= 64 + 1, 10000);
    const readyFor0 = env.events.filter(e => e.status === 'ready' && e.path === ps[0]).map(e => e.theme).sort();
    check('合并主题的条目对两个主题都发 ready', readyFor0, ['dark', 'light']);
    await env.cleanup();
  }

  console.log('\n[单测] 熔断：连续 5 次 spawn 失败 → 10 分钟不可用');
  {
    const env = makeEnv('circuit', { mode: 'enoent' });
    const t = env.make();
    const p = env.write('x.html');
    check('初始可用', t.status().available, true);
    t.request([p], 'light');
    await waitFor(() => !t.status().available, 3000);
    check('5 次 spawn 失败后不可用', t.status().available, false);
    check('恰好 5 次', env.spawnState.calls.length, 5);
    check('warn 一次带原因', env.warns.filter(w => w.includes('ENOENT')).length, 1);
    const r = t.request([p], 'light');
    check('之后请求直接 unavailable', [r.available, r.items[p].status], [false, 'unavailable']);
    check('队列里的条目发 dropped', env.events.some(e => e.status === 'dropped' && e.path === p), true);
    await env.cleanup();
  }

  console.log('\n[单测] disabled（ATLAS_THUMBS=off）恒不可用、不 spawn');
  {
    const env = makeEnv('off', { thumbOpts: { disabled: true } });
    const t = env.make();
    const p = env.write('x.html');
    const r = t.request([p], 'light');
    check('available=false + unavailable', [r.available, r.items[p].status], [false, 'unavailable']);
    await sleep(30);
    check('从不 spawn', env.spawnState.calls.length, 0);
    check('不建缓存目录', fs.existsSync(env.cacheDir), false);
    await env.cleanup();
  }
}

// 不带 Origin、可自定义头的请求（node fetch 不一定放行 Sec-Fetch-Site）
function rawRequest(base, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function interfaceAndFrontend() {
  console.log('\n[接口] startAtlas（ATLAS_THUMBS 默认 off）');
  const files = {};
  for (let i = 1; i <= 4; i++) files[`proj/doc-${i}.html`] = `<!doctype html><h1>文档 ${i}</h1>`;
  files['proj/note.md'] = '# 笔记\n';
  const atlas = await startAtlas({ prefix: 'atlas-thumbs-', files });
  try {
    const p = atlas.filePath('proj/doc-1.html');
    const enc = encodeURIComponent(p);
    let r = await rawRequest(atlas.base, 'GET', `/api/thumb?path=${enc}&theme=sepia&k=0123456789abcdef`);
    check('GET 非法 theme → 400', r.status, 400);
    r = await rawRequest(atlas.base, 'GET', `/api/thumb?path=${enc}&theme=light&k=0123456789abcdef`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    check('GET Sec-Fetch-Site: cross-site → 403', r.status, 403);
    r = await rawRequest(atlas.base, 'GET', `/api/thumb?path=${enc}&theme=light&k=0123456789abcdef`, {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    check('GET k 与索引不一致 → 404', r.status, 404);
    r = await rawRequest(atlas.base, 'GET', `/api/thumb?path=${enc}&theme=light&k=xyz`);
    check('GET k 不是 16 位十六进制 → 404', r.status, 404);
    r = await rawRequest(atlas.base, 'GET', `/api/thumb?path=${encodeURIComponent('/etc/passwd')}&theme=light&k=0123456789abcdef`);
    check('GET 扫描根外路径 → 400', r.status, 400);
    r = await rawRequest(atlas.base, 'POST', '/api/thumbs', { body: { paths: new Array(49).fill(p) } });
    check('POST 超过 48 项 → 400', r.status, 400);
    r = await rawRequest(atlas.base, 'POST', '/api/thumbs', { body: { paths: [] } });
    check('POST 空数组 → 400', r.status, 400);
    r = await rawRequest(atlas.base, 'POST', '/api/thumbs', { body: { paths: 'x' } });
    check('POST 不是数组 → 400', r.status, 400);
    r = await rawRequest(atlas.base, 'POST', '/api/thumbs', { body: { paths: [p, '/etc/passwd'], theme: 'weird' } });
    check('POST off 时 available=false、合法项 unavailable、非法项 invalid', [r.status, r.json.available,
      r.json.items[p].status, r.json.items['/etc/passwd'].status], [200, false, 'unavailable', 'invalid']);
    r = await rawRequest(atlas.base, 'POST', '/api/thumbs', {
      body: { paths: [p] }, headers: { Origin: 'null' },
    });
    check('POST 经 Origin 中间件：Origin null → 403', r.status, 403);
    const st = (await rawRequest(atlas.base, 'GET', '/api/state')).json;
    check('/api/state.thumbs = {available:false, browser:null, reason:"disabled"}', st.thumbs, { available: false, browser: null, reason: 'disabled' });
    check('ATLAS_THUMBS=off 不建 thumbnails 目录', fs.existsSync(path.join(atlas.homeDir, 'thumbnails')), false);

    console.log('\n[前端] 自动化闸门 / 主题 / dropped / ready');
    const browser = await pw.launch();
    const PNG = realPng();
    const setup = async ({ force, scheme }) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme || 'light' });
      const page = await ctx.newPage();
      const posts = [];
      if (force) await page.addInitScript(() => { window.__atlasForceThumbs = true; });
      await page.route('**/api/thumbs', async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        posts.push(body);
        const items = {};
        for (const q of body.paths) items[q] = { status: 'queued' };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, items }) });
      });
      await page.route(u => u.pathname === '/api/thumb', route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
      // 隔离实例是 ATLAS_THUMBS=off：把 /api/state 的能力字段改成可用，前端才会走请求流程
      await page.route(u => u.pathname === '/api/state', async (route) => {
        const resp = await route.fetch();
        const json = await resp.json();
        json.thumbs = { available: true, browser: 'FakeChrome', reason: null };
        await route.fulfill({ response: resp, json });
      });
      await page.goto(atlas.base);
      await page.waitForSelector('.cover-card[data-path]');
      return { ctx, page, posts };
    };

    {
      const { ctx, page, posts } = await setup({ force: false });
      await page.waitForTimeout(900);
      check('webdriver 下默认不发 POST /api/thumbs', posts.length, 0);
      await ctx.close();
    }
    {
      const { ctx, page, posts } = await setup({ force: true, scheme: 'dark' });
      await waitFor(() => posts.length >= 1, 3000);
      check('__atlasForceThumbs 后发出请求', posts.length >= 1, true);
      check('跟随系统 + 深色 → theme=dark', posts[0] && posts[0].theme, 'dark');
      const cards = await page.evaluate(() => [...document.querySelectorAll('.cover-card[data-path]')].map(e => e.dataset.path));
      check('请求的是可见封面', posts[0] && posts[0].paths.slice().sort(), cards.slice().sort());
      await page.waitForTimeout(500);
      check('签名不变不重复发', posts.length, 1);
      await page.emulateMedia({ colorScheme: 'light' });
      await waitFor(() => posts.length >= 2, 3000);
      check('切到浅色 → 对可见封面重新请求 theme=light', posts[1] && [posts[1].theme, posts[1].paths.length], ['light', cards.length]);

      // 模拟 dropped：该条目删除，下次 renderHome 只请求这一条
      const target = cards[0];
      // 等浅色那次的响应落进 state（否则 dropped 先到、响应后到又把条目写回去）
      await page.waitForFunction((p) => state.thumbs.items.has('light|' + p), target, { timeout: 3000 });
      const n = posts.length;
      await page.evaluate((p) => { onThumbReady({ path: p, theme: 'light', status: 'dropped' }); renderHome(); }, target);
      await waitFor(() => posts.length > n, 3000);
      check('dropped 后重新请求只含该路径', posts[n] && posts[n].paths, [target]);
      // 同上：等这次重请求的响应（status: queued）落进 state 再注入 ready。posts 只说明请求发出了，
      // 慢 runner 上响应可能晚到，把下面注入的 ready 覆盖回 queued、<img> 被移除（CI 79559d5 那次失败）
      await page.waitForFunction((p) => state.thumbs.items.has('light|' + p), target, { timeout: 3000 });

      // 模拟 HTML 两个主题收到同一个 k 的 ready：<img> 的 theme 跟随当前主题
      const k = 'abcdef0123456789';
      await page.evaluate(({ p, k }) => {
        onThumbReady({ path: p, theme: 'light', status: 'ready', k });
        onThumbReady({ path: p, theme: 'dark', status: 'ready', k });
      }, { p: target, k });
      const src = await page.evaluate((p) => {
        const img = document.querySelector(`.cover-card[data-path="${CSS.escape(p)}"] img.cover-thumb`);
        return img && img.getAttribute('src');
      }, target);
      check('ready → 卡片插入 .cover-thumb，theme=light、k 一致', !!src && src.includes('theme=light') && src.includes('k=' + k), true);
      await page.waitForFunction((p) => {
        const img = document.querySelector(`.cover-card[data-path="${CSS.escape(p)}"] img.cover-thumb`);
        return img && img.classList.contains('loaded');
      }, target, { timeout: 3000 }).catch(() => {});
      check('图加载后加 .loaded', await page.evaluate((p) =>
        !!document.querySelector(`.cover-card[data-path="${CSS.escape(p)}"] img.cover-thumb.loaded`), target), true);
      check('.cover-thumb 在 .cover-art 最底层（第一个子元素）', await page.evaluate((p) =>
        document.querySelector(`.cover-card[data-path="${CSS.escape(p)}"] .cover-art`).firstElementChild.className, target), 'cover-thumb loaded');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(100);
      const srcDark = await page.evaluate((p) => {
        const img = document.querySelector(`.cover-card[data-path="${CSS.escape(p)}"] img.cover-thumb`);
        return img && img.getAttribute('src');
      }, target);
      check('切到深色 → 同一个 k、theme=dark', !!srcDark && srcDark.includes('theme=dark') && srcDark.includes('k=' + k), true);
      check('有截图与没截图时封面数量一致', await page.evaluate(() => document.querySelectorAll('.cover-card[data-path]').length), cards.length);
      // SSE onopen 清理 queued
      const queuedBefore = await page.evaluate(() => [...state.thumbs.items.values()].filter(i => i.status === 'queued').length);
      await page.evaluate(() => { evtSrc && evtSrc.onopen && evtSrc.onopen(); });
      const queuedAfter = await page.evaluate(() => [...state.thumbs.items.values()].filter(i => i.status === 'queued').length);
      check('SSE onopen 删掉所有 queued 条目', [queuedBefore > 0, queuedAfter], [true, 0]);
      // 收到 thumb 事件不触发 fetchState
      const stateCalls = [];
      page.on('request', (req) => { if (req.url().includes('/api/state')) stateCalls.push(req.url()); });
      await page.evaluate((p) => {
        evtSrc.onmessage({ data: JSON.stringify({ channel: 'thumb', path: p, theme: 'dark', status: 'ready', k: 'abcdef0123456789' }) });
      }, target);
      await page.waitForTimeout(700);
      check('SSE thumb 事件不触发 /api/state 重拉', stateCalls.length, 0);
      // 点击打开行为不变
      await page.click(`.cover-card[data-path="${target.replace(/"/g, '\\"')}"]`);
      await page.waitForTimeout(600);
      check('点封面照常打开文档', await page.evaluate(() => state.activeFilePath), target);
      await ctx.close();
    }
    {
      // 服务端 available=false 后本会话不再请求
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const posts = [];
      await page.addInitScript(() => { window.__atlasForceThumbs = true; });
      page.on('request', (req) => { if (req.url().endsWith('/api/thumbs')) posts.push(req.url()); });
      await page.goto(atlas.base);
      await page.waitForSelector('.cover-card[data-path]');
      await page.waitForTimeout(900);
      check('/api/state 报不可用 → 不发请求', posts.length, 0);
      await page.click('#btn-settings');
      await page.waitForTimeout(400);
      check('设置 → 外观「封面」说明（ATLAS_THUMBS=off）', await page.textContent('#thumbs-status'), '已用 ATLAS_THUMBS=off 关闭真实缩略图，使用生成式封面');
      check('设置里写明在线资源页面用生成式封面', await page.evaluate(() =>
        document.querySelector('[data-pane="appearance"] #thumbs-status').parentElement.textContent.includes('依赖在线资源')), true);
      await ctx.close();
    }
    await browser.close();
  } finally {
    await atlas.stop();
  }
}

async function integration() {
  console.log('\n[集成] 真实 Chromium 截图');
  const found = chromiumLib.findChromium();
  if (!found) { console.log('  - SKIP：本机没有 Chromium 系浏览器'); return; }
  // 蜜罐：页面里的外网 / 第三方请求都打这里，一次都不应该到
  const honey = { hits: 0 };
  const hp = http.createServer((req, res) => { honey.hits++; res.end('x'); });
  await new Promise(r => hp.listen(0, '127.0.0.1', r));
  const honeyPort = hp.address().port;
  const atlas = await startAtlas({
    prefix: 'atlas-thumbs-int-',
    files: { 'proj/placeholder.md': '# 占位\n' },
    env: { ATLAS_THUMBS: 'on', ATLAS_LOG_REQUESTS: '1' },
  });
  try {
    const probe = atlas.filePath('proj/probe.html');
    fs.writeFileSync(probe, `<!doctype html><html><body style="background:#223;color:#fff">
<h1>探针</h1>
<img src="http://127.0.0.1:${honeyPort}/pixel.png">
<script>
  fetch('http://127.0.0.1:${atlas.port}/api/state').catch(() => {});
  fetch('/api/config').catch(() => {});
  fetch('http://127.0.0.1:${honeyPort}/beacon').catch(() => {});
  new Image().src = 'http://127.0.0.1:${atlas.port}/api/state?img=1';
</script></body></html>`);
    // 等 watcher 把它收进索引（POST 不再回 invalid）
    const post = (theme = 'light') => rawRequest(atlas.base, 'POST', '/api/thumbs', { body: { paths: [probe], theme } });
    const logStart = atlas.serverLogs().length;
    await waitFor(async () => (await post()).json.items[probe].status !== 'invalid', 10000, 200);
    const t0 = Date.now();
    const ready = await waitFor(async () => {
      const r = await post();
      const it = r.json.items[probe];
      return it.status === 'ready' ? it : (['failed', 'remote-deps', 'too-large', 'unavailable'].includes(it.status) ? it : null);
    }, 30000, 300);
    console.log(`    截图耗时约 ${Date.now() - t0}ms（${found.name}）`);
    check('截图完成 ready', ready && ready.status, 'ready');
    if (!ready || ready.status !== 'ready') return;
    const img = await rawRequest(atlas.base, 'GET',
      `/api/thumb?path=${encodeURIComponent(probe)}&theme=dark&k=${ready.k}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    check('GET → 200 image/png', [img.status, img.headers['content-type']], [200, 'image/png']);
    check('Cache-Control: private, max-age=31536000, immutable', img.headers['cache-control'], 'private, max-age=31536000, immutable');
    check('nosniff + CSP default-src none', [img.headers['x-content-type-options'], img.headers['content-security-policy']], ['nosniff', "default-src 'none'"]);
    const dims = thumbnail.pngSize(img.buf);
    console.log(`    产物尺寸 ${dims && dims.width}×${dims && dims.height}，${img.buf.length} 字节`);
    check('PNG 尺寸 640×400 或 1280×800', !!dims && ((dims.width === 640 && dims.height === 400) || (dims.width === 1280 && dims.height === 800)), true);
    const cross = await rawRequest(atlas.base, 'GET',
      `/api/thumb?path=${encodeURIComponent(probe)}&theme=light&k=${ready.k}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    check('同一张图跨站取 → 403', cross.status, 403);
    const logs = atlas.serverLogs().slice(logStart);
    const stateHits = logs.split('\n').filter(l => /^\[req\] GET \/api\/(state|config)/.test(l));
    check('截图期间页面脚本一次都没打到 Atlas 端口（/api/state、/api/config）', stateHits, []);
    check('第三方地址（蜜罐）零请求', honey.hits, 0);
    // 改 mtime → stale（带旧 k），随后新图就绪
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(probe, future, future);
    await sleep(800);
    const st = (await post()).json.items[probe];
    check('改 mtime 后 POST → stale 且带旧 k', [st.status, st.k], ['stale', ready.k]);
    await waitFor(async () => (await post()).json.items[probe].status === 'ready', 30000, 300);
    const thumbDir = path.join(atlas.homeDir, 'thumbnails');
    check('缓存写在 ATLAS_HOME/thumbnails/', fs.existsSync(thumbDir) && fs.readdirSync(thumbDir).some(n => n.endsWith('.png')), true);
    check('临时 profile 已清理', fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('atlas-thumb-')).length, 0);
  } finally {
    await atlas.stop();
    hp.close();
  }
}

(async () => {
  await unitTests();
  await interfaceAndFrontend();
  await integration();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
