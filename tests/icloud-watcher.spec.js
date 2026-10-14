// 目录树监听器的 iCloud 占位映射（lib/fs-watcher.js 的 placeholderName 选项，design §6.1 / §11.2）
//
// iCloud 「移除下载」后，原文件可能被换成同目录下的 `.<名>.icloud` 占位文件（旧系统），
// 或者原文件变成 dataless（新系统，文件名不变）。watcher 要做到：
//   · 占位文件一律以原路径出现（known / 去抖队列 / 事件），隐藏名不外泄
//   · 占位 ↔ 真实文件的切换只报一次 change（没有 unlink + add），两个方向都是
//   · 只删占位文件时等 1.5 秒宽限期再报 unlink（期间真实文件出现就是 change）
//   · 整目录搬入时补偿扫描把占位文件以原路径补报
//   · 不传 placeholderName 时行为和之前完全一样
//
// 纯 node，只用 os.tmpdir() 下的临时目录。没有原生递归监听（chokidar 回退）的平台 SKIP。
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fsWatcher = require(path.join(ROOT, 'lib/fs-watcher'));
const icloud = require(path.join(ROOT, 'lib/icloud'));

let failures = 0;
let total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}
function finish() {
  console.log('\n========================');
  console.log(`总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

if (fsWatcher.backend !== 'native') {
  console.log(`SKIP：当前后端是 ${fsWatcher.backend}，占位映射只在原生递归监听上实现（那些平台上 iCloud 逻辑本来就关着）`);
  finish();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOC_EXT = ['.html', '.htm', '.md', '.markdown'];
const isDocPath = (n) => DOC_EXT.some((e) => String(n).toLowerCase().endsWith(e));
// 与 fs-watcher.spec.js 相同的 ignored：所有 . 开头的名字都忽略（占位映射在 ignored 之前做）
const ignored = (p) => {
  const b = path.basename(p);
  return b.startsWith('.') || b === 'node_modules' || /\.(sock|lock|pid)$/.test(b);
};
const placeholderName = (n) => {
  const o = icloud.placeholderOriginalName(n);
  return o && isDocPath(o) ? o : null;
};
function fdCount() {
  try { return fs.readdirSync('/dev/fd').length; } catch { return -1; }
}

async function start(root, extra = {}) {
  const events = [];
  const w = new fsWatcher.NativeTreeWatcher(root, {
    ignored, depth: 6, isDocPath, stabilityThreshold: 120, pollInterval: 60, ...extra,
  });
  w.on('error', () => {});
  ['add', 'change', 'unlink'].forEach((k) => w.on(k, (p) => events.push(`${k}:${path.relative(root, p)}`)));
  await new Promise((res) => { if (w.primed) return res(); w.once('ready', res); setTimeout(res, 2500); });
  return { raw: w, drain: () => events.splice(0, events.length).sort(), close: () => w.close() };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-icloud-watch-'));
  try {
    const root = path.join(tmp, 'scan');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, '.p1.md.icloud'), 'plist');
    fs.writeFileSync(path.join(root, 'dup.md'), '# real');
    fs.writeFileSync(path.join(root, '.dup.md.icloud'), 'plist');
    fs.writeFileSync(path.join(root, 'b.md'), '# b');
    fs.writeFileSync(path.join(root, 'sub', '.s.html.icloud'), 'plist');
    await sleep(600);   // 让建 fixture 的事件流干，再挂监听

    console.log('\n[盘点]');
    const fdBefore = fdCount();
    const w = await start(root, { placeholderName });
    const fdAfter = fdCount();
    const k = (rel) => w.raw.known.get(path.join(root, rel));
    check('占位文件以原路径进入 known（ph:true）', [!!k('p1.md'), k('p1.md') && k('p1.md').ph], [true, true]);
    check('子目录里的占位也映射（sub/s.html）', !!(k('sub/s.html') && k('sub/s.html').ph), true);
    check('隐藏名不进 known', w.raw.known.has(path.join(root, '.p1.md.icloud')), false);
    check('同目录占位与真实并存时只有一条，以真实为准', [k('dup.md') && k('dup.md').ph, k('dup.md') && k('dup.md').size], [false, 6]);
    check('盘点不 emit 事件', w.drain(), []);
    if (fsWatcher.SYSTEM_RECURSIVE) {
      check('fd 净增 ≤ 2', fdAfter - fdBefore <= 2, true);
    } else {
      console.log(`    （递归不是内核提供的，fd 断言跳过；本次净增 ${fdAfter - fdBefore}）`);
    }

    console.log('\n[事件]');
    fs.writeFileSync(path.join(root, '.n.md.icloud'), 'plist');
    await sleep(700);
    check('新出现的占位文件 → add（原路径）', w.drain(), ['add:n.md']);

    fs.unlinkSync(path.join(root, '.p1.md.icloud'));
    fs.writeFileSync(path.join(root, 'p1.md'), '# downloaded');
    await sleep(800);
    check('占位删除 + 真实文件出现 → 只有一次 change（AC26）', w.drain(), ['change:p1.md']);
    check('known 里变成真实文件', k('p1.md') && k('p1.md').ph, false);

    fs.unlinkSync(path.join(root, 'b.md'));
    fs.writeFileSync(path.join(root, '.b.md.icloud'), 'plist');
    await sleep(800);
    check('反方向：真实 b.md 删除 + .b.md.icloud 出现 → 只有一次 change（M5）', w.drain(), ['change:b.md']);
    check('known 里变成占位', k('b.md') && k('b.md').ph, true);

    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, '.c.md.icloud'), 'plist');
    fs.writeFileSync(path.join(outside, 'd.md'), '# d');
    await sleep(300);
    w.drain();
    await fsp.rename(outside, path.join(root, 'moved'));
    await sleep(1200);
    check('整目录 mv 进根：占位以 <dir>/c.md 报 add，不是隐藏名（N3）', w.drain(), ['add:moved/c.md', 'add:moved/d.md']);

    fs.unlinkSync(path.join(root, '.n.md.icloud'));
    await sleep(800);
    check('只删占位：宽限期内不报 unlink', w.drain(), []);
    await sleep(1400);
    check('1.5 秒宽限期之后才报 unlink', w.drain(), ['unlink:n.md']);

    fs.unlinkSync(path.join(root, '.b.md.icloud'));
    await sleep(500);
    fs.writeFileSync(path.join(root, 'b.md'), '# back');
    await sleep(1600);
    check('宽限期内真实文件出现 → change，没有 unlink', w.drain(), ['change:b.md']);

    fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(root, '.hidden.md'), '# h');
    fs.writeFileSync(path.join(root, '..x.md.icloud'), 'plist');
    await sleep(800);
    check('.DS_Store / .hidden.md / ..x.md.icloud 没有事件', w.drain(), []);

    fs.writeFileSync(path.join(root, '报告 2.html'), '<p>冲突副本</p>');
    await sleep(700);
    check('冲突副本「报告 2.html」报 add（AC28）', w.drain(), ['add:报告 2.html']);

    fs.writeFileSync(path.join(root, 'p1.md'), '# 改了内容');
    await sleep(700);
    check('普通内容修改照常 change', w.drain(), ['change:p1.md']);
    fs.unlinkSync(path.join(root, 'p1.md'));
    await sleep(700);
    check('普通真实文件删除照常立即 unlink（不走宽限期）', w.drain(), ['unlink:p1.md']);
    await w.close();

    console.log('\n[不传 placeholderName]');
    const root2 = path.join(tmp, 'scan2');
    fs.mkdirSync(root2, { recursive: true });
    fs.writeFileSync(path.join(root2, '.q.md.icloud'), 'plist');
    fs.writeFileSync(path.join(root2, 'e.md'), '# e');
    await sleep(500);
    const w2 = await start(root2);
    check('盘点不认占位文件', [w2.raw.known.has(path.join(root2, 'q.md')), w2.raw.known.has(path.join(root2, '.q.md.icloud'))], [false, false]);
    check('known 条目形状不变（只有 size / mtimeMs）', Object.keys(w2.raw.known.get(path.join(root2, 'e.md'))).sort(), ['mtimeMs', 'size']);
    fs.writeFileSync(path.join(root2, '.r.md.icloud'), 'plist');
    fs.writeFileSync(path.join(root2, 'f.md'), '# f');
    await sleep(700);
    check('新占位文件没有事件，普通文件照常 add', w2.drain(), ['add:f.md']);
    fs.unlinkSync(path.join(root2, 'e.md'));
    await sleep(700);
    check('删除照常立即 unlink', w2.drain(), ['unlink:e.md']);
    await w2.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
