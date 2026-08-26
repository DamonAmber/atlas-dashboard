// 目录树监听器（lib/fs-watcher.js）
//
// 这个模块存在的唯一理由是 fd：chokidar 4+ 逐目录挂 fs.watch，macOS 上监听
// 3598 个目录会吃掉 10553 个 fd，越过 Node 的 10240 上限后**进程里所有 spawn
// 都报 EBADF** —— 导出 PDF 直接失败，「在访达中显示」和自升级时好时坏。
// 所以第一组断言就是 fd 与 spawn，那才是它要守住的东西。
//
// 其余各组钉的是"换掉 chokidar 之后语义没退化"：
//   · add / change / unlink 三种事件（macOS 上 fs.watch 的 eventType 几乎永远是
//     rename，连改内容都是，所以判定完全靠 stat —— 这组是它的正确性底线）
//   · 新建文件只报一次（父目录事件与文件事件必须合并，否则会推两条桌面通知）
//   · 写入稳定期：分段写入不能在写到一半时就报出去
//   · 整目录搬入的补偿（mv 只产生一个目录事件，里面的文件没有独立事件）
//   · 整目录删除要逐个报 unlink（否则索引里留一堆已经不存在的文档）
//   · depth 与 ignored 过滤，语义与 server.js 的 walk() 对齐
//   · close() 之后不再有事件、fd 归零
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const fsWatcher = require(path.join(ROOT, 'lib/fs-watcher'));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DOC_EXT = ['.html', '.htm', '.md', '.markdown'];
const isDocPath = (n) => DOC_EXT.some(e => String(n).toLowerCase().endsWith(e));
const IGNORE = new Set(['node_modules', '.git', 'dist']);
const ignored = (p) => {
  const b = path.basename(p);
  return b.startsWith('.') || IGNORE.has(b) || /\.(sock|lock|pid)$/.test(b);
};

function fdCount() {
  try { return fs.readdirSync('/dev/fd').length; } catch { return -1; }
}
function canSpawn() {
  try {
    const r = spawnSync('/bin/echo', ['x'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return !r.error;
  } catch { return false; }
}

// 起一个 watcher 并收集事件；返回 { events, drain(), close() }
async function start(root, opts = {}) {
  const events = [];
  const w = fsWatcher.createWatcher(root, {
    ignored, depth: 6, isDocPath,
    stabilityThreshold: 120, pollInterval: 60,   // 测试里调快，语义不变
    ...opts,
  });
  w.on('error', () => {});
  ['add', 'change', 'unlink'].forEach(kind => w.on(kind, p => events.push(`${kind}:${path.relative(root, p)}`)));
  // 等初始盘点结束（chokidar 分支没有 ready，用超时兜）
  await new Promise(res => {
    if (w.primed) return res();
    if (typeof w.once === 'function') w.once('ready', res);
    setTimeout(res, 2500);
  });
  return {
    events,
    // bulk/ 下那 600 个文件只是用来造 fd 压力的，它们的事件与本 spec 的语义无关。
    // 必须滤掉：文件是在挂监听之前刚创建的，而 FSEvents 会把那一小段时间里的
    // 事件也补送过来（机器越忙延迟越大），于是它们会在后面某一次 drain 里冒出来。
    // 产品行为本身是对的——收到事件、stat 发现是已知文件，报 change；
    // 落到真实使用上就是"启动后可能对启动前刚改过的文件补报一次 change"，无害。
    drain: () => events.splice(0, events.length)
      .filter(e => !e.includes(':bulk/'))
      .sort(),
    close: () => w.close(),
    raw: w,
  };
}

(async () => {
  console.log(`\n[后端] ${fsWatcher.backend}（内核级递归：${fsWatcher.SYSTEM_RECURSIVE}）`);
  // 只在 macOS / Windows 上断言"必须是 native"——那两个平台的递归由内核提供，
  // 是本次修复真正要拿下的场景。Linux 上 Node 是在 JS 层模拟递归（fd 照旧），
  // 用哪个后端都不影响 fd，所以不做断言。
  if (process.platform === 'darwin' || process.platform === 'win32') {
    check('macOS / Windows 上必须走原生递归（fd ≈ 0 的那条路）', fsWatcher.backend, 'native');
    check('并且递归是内核提供的', fsWatcher.SYSTEM_RECURSIVE, true);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fsw-spec-'));
  const root = path.join(tmp, 'scan');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj', 'existing.md'), 'old');

  // ---- ① fd 与 spawn：这个模块存在的理由 ----
  console.log('\n[fd 与 spawn]');
  // 造一棵有规模的目录树（chokidar 会为每个目录占 fd，原生后端不会）
  const bulk = path.join(root, 'bulk');
  for (let i = 0; i < 300; i++) {
    const d = path.join(bulk, `d${i}`, 'sub');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'doc.md'), '# x');
  }
  // 让刚才那批创建动作的文件系统事件先流干，再挂监听——否则它们会混进后面的断言
  await sleep(600);
  const fdBefore = fdCount();
  const w1 = await start(root);
  const fdAfter = fdCount();
  const grew = fdAfter - fdBefore;
  console.log(`    600+ 个目录：fd ${fdBefore} → ${fdAfter}（净增 ${grew}）`);
  if (fsWatcher.SYSTEM_RECURSIVE) {
    check('内核级递归监听整棵树不额外占 fd', grew <= 2, true);
  } else {
    console.log('    （这个平台的递归不是内核提供的，fd 增长是预期的，此项跳过）');
  }
  check('此时仍然能 spawn 子进程（导出 PDF / 访达 / 自升级都靠它）', canSpawn(), true);
  check('初始盘点收录了已有文档', w1.raw.known ? w1.raw.known.size >= 301 : true, true);
  check('盘点不 emit 任何事件（等价于 ignoreInitial）', w1.drain(), []);

  // ---- ② 三种事件 ----
  console.log('\n[add / change / unlink]');
  const f = path.join(root, 'proj', 'new.md');
  await fsp.writeFile(f, '# v1');
  await sleep(700);
  check('新建 → 只报一次 add（父目录事件与文件事件已合并）', w1.drain(), ['add:proj/new.md']);

  await fsp.writeFile(f, '# v2 内容变了');
  await sleep(700);
  check('改内容 → change（macOS 上 eventType 也是 rename，靠 stat 判定）',
    w1.drain(), ['change:proj/new.md']);

  await fsp.unlink(f);
  await sleep(700);
  check('删除 → unlink', w1.drain(), ['unlink:proj/new.md']);

  // 已存在的文件被改：必须是 change 而不是 add。
  // 报错成 add 会让上层不清 store.seen，未读红点就不亮了——这是最不能出错的一条
  await fsp.writeFile(path.join(root, 'proj', 'existing.md'), 'changed');
  await sleep(700);
  check('改动盘点期就存在的文件 → change（不是 add）',
    w1.drain(), ['change:proj/existing.md']);

  // ---- ③ 写入稳定期 ----
  console.log('\n[写入稳定期]');
  const streamFile = path.join(root, 'proj', 'stream.md');
  const fh = await fsp.open(streamFile, 'w');
  for (let i = 0; i < 6; i++) { await fh.write(`chunk ${i}\n`); await sleep(50); }
  await fh.close();
  await sleep(800);
  const streamEvents = w1.drain();
  check('分段写入只报一次（不会在写到一半时就报出去）', streamEvents, ['add:proj/stream.md']);
  check('报出来时内容已经是完整的',
    fs.readFileSync(streamFile, 'utf8').split('\n').filter(Boolean).length, 6);

  // ---- ④ 过滤：depth 与 ignored ----
  console.log('\n[过滤]');
  const deepOk = path.join(root, 'a', 'b', 'c', 'd', 'e', 'ok.md');       // 第 5 层，depth 6 之内
  const deepNo = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'no.md'); // 第 7 层，超了
  fs.mkdirSync(path.dirname(deepOk), { recursive: true });
  fs.mkdirSync(path.dirname(deepNo), { recursive: true });
  await sleep(300);
  w1.drain();
  await fsp.writeFile(deepOk, '# ok');
  await fsp.writeFile(deepNo, '# no');
  await sleep(900);
  const depthEvents = w1.drain();
  check('depth 之内的文件会报', depthEvents.includes('add:a/b/c/d/e/ok.md'), true);
  check('超过 depth 的文件不报（与 walk() 的口径一致）',
    depthEvents.some(e => e.includes('no.md')), false);

  const nm = path.join(root, 'proj', 'node_modules', 'pkg');
  fs.mkdirSync(nm, { recursive: true });
  const hidden = path.join(root, '.hidden');
  fs.mkdirSync(hidden, { recursive: true });
  await sleep(200);
  w1.drain();
  await fsp.writeFile(path.join(nm, 'readme.md'), '# dep');
  await fsp.writeFile(path.join(hidden, 'secret.md'), '# hidden');
  await fsp.writeFile(path.join(root, 'proj', 'notes.txt'), 'not a doc type here');
  await sleep(900);
  check('node_modules / 隐藏目录 / 非目标类型都不报', w1.drain(), []);

  // ---- ⑤ 整目录搬入与整目录删除 ----
  console.log('\n[整目录进出]');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(outside, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'x.md'), '# x');
  fs.writeFileSync(path.join(outside, 'inner', 'y.md'), '# y');
  w1.drain();
  // mv 一整个目录进来：只会产生一个目录事件，里面的文件没有独立事件，
  // 靠补偿扫描把它们找出来
  await fsp.rename(outside, path.join(root, 'moved'));
  await sleep(1200);
  check('mv 整个目录进扫描根 → 里面的文档都报了 add',
    w1.drain(), ['add:moved/inner/y.md', 'add:moved/x.md']);

  // 反向：整棵删掉，里面每个文档都要报 unlink，否则索引里留一堆幽灵
  await fsp.rm(path.join(root, 'moved'), { recursive: true, force: true });
  await sleep(1200);
  check('删掉整个目录 → 里面的文档都报了 unlink',
    w1.drain(), ['unlink:moved/inner/y.md', 'unlink:moved/x.md']);

  // ---- ⑥ close ----
  console.log('\n[close]');
  await w1.close();
  const fdAfterClose = fdCount();
  await fsp.writeFile(path.join(root, 'proj', 'after-close.md'), '# nope');
  await sleep(700);
  check('close 之后不再有事件', w1.drain(), []);
  if (fsWatcher.SYSTEM_RECURSIVE) {
    check('close 之后 fd 回到监听前的水平', Math.abs(fdAfterClose - fdBefore) <= 2, true);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n========================`);
  console.log(failures === 0 ? '总计 全部通过' : `总计 ${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
