// 活动日志与时间河流的数据层（design §3d「可测性」第一、二、三条）。
//   node 段：lib/activity-log.js（合并 / 夹取 / 分文件 / 轮转 / 上限 / 坏行 / query / 预热 / 停用 / 追加失败）、
//            lib/self-writes.js（markSelfWrite 三种返回值与 10 秒过期）、classifyEvent 分类表；
//            public/river.js 纯函数（兜底合成、去重、classifySse、shouldMerge 对照、SSE 追加 == 重拉、区间与窗口滚动）
//   接口段：startAtlas() 隔离实例——/api/activity 形状与校验、SSE self / selfReason、自写 k:'s'、
//            重命名 k:'a'、归档项目不记、日志只落在 ATLAS_HOME/activity/、store.json 键集合不出现 activity 字段
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const actLib = require('../lib/activity-log');
const selfWritesLib = require('../lib/self-writes');
const R = require('../public/river.js');
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
let total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`
    + (ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const tmpDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-activity-'));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const quietLog = () => {
  const warns = [];
  return { warns, warn: (...a) => warns.push(a.join(' ')), log() {}, error() {} };
};
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}
// 今天中午附近的一个固定 now，避免测试跨过午夜时日期文件对不上
function noonToday() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}
async function mk(dir, extra = {}) {
  const log = actLib.createActivityLog({ dir, log: quietLog(), flushMs: 20, ...extra });
  await log.ready();
  return log;
}
async function settle(log) { await log.flush(); await sleep(5); }

(async () => {
  // ==================== node：lib/activity-log.js ====================
  console.log('\n[常量与分类表]');
  check('MERGE_WINDOW_MS === 60000', actLib.MERGE_WINDOW_MS, 60000);
  check('单日上限 2 万行、query 上限 5 万条、保留 8 个日期文件',
    [actLib.DAY_LINE_LIMIT, actLib.QUERY_MAX, actLib.KEEP_FILES], [20000, 50000, 8]);
  check('classifyEvent：add → a、change → c、unlink 不记',
    [actLib.classifyEvent('add', null), actLib.classifyEvent('change', null), actLib.classifyEvent('unlink', null)],
    ['a', 'c', null]);
  check('classifyEvent：自写保存（add / change）→ s',
    [actLib.classifyEvent('change', 'save'), actLib.classifyEvent('add', 'save')], ['s', 's']);
  // watcher 盘点未完成（primed === false）时 Atlas 的重命名到达的是 change + 'rename'，仍记 a
  check('classifyEvent：重命名无论 add 还是 change（盘点窗口内）都记 a',
    [actLib.classifyEvent('add', 'rename'), actLib.classifyEvent('change', 'rename')], ['a', 'a']);

  console.log('\n[markSelfWrite / isSelfWrite（lib/self-writes.js）]');
  {
    check('默认过期 10 秒、容差 2 秒', [selfWritesLib.TTL_MS, selfWritesLib.TOLERANCE_MS], [10000, 2000]);
    const sw = selfWritesLib.createSelfWrites();
    sw.mark('/a.md', 1000);
    sw.mark('/b.md', 5000, 'rename');
    check('reason 默认 save → 返回 \'save\'', sw.check('/a.md', 1500), 'save');
    check('命中即删：第二次返回 null', sw.check('/a.md', 1500), null);
    check('rename 登记 → 返回 \'rename\'', sw.check('/b.md', 5000), 'rename');
    check('没登记过 → null', sw.check('/c.md', 1), null);
    sw.mark('/d.md', 10_000);
    check('mtime 相差 ≥ 2 秒 → null（且条目保留）', [sw.check('/d.md', 12_500), sw.has('/d.md')], [null, true]);
    const short = selfWritesLib.createSelfWrites({ ttlMs: 60 });
    short.mark('/e.md', 1);
    await sleep(30);
    short.mark('/e.md', 2);   // 过期前重新登记：旧定时器不能删掉新条目
    await sleep(45);
    check('过期前重新登记的条目不被旧定时器删掉', short.has('/e.md'), true);
    await sleep(40);
    check('条目按 ttl 过期（未被消费也不会永久留着）', [short.has('/e.md'), short.size()], [false, 0]);
  }

  console.log('\n[合并：固定窗口]');
  {
    const dir = tmpDir();
    const now = noonToday();
    const log = await mk(dir, { now: () => now });
    const T = now - 2 * HOUR;
    // AI 每 30 秒写一次、连写 5 分钟（11 次）→ 固定窗口：T、T+60、…、T+300 落盘
    for (let s = 0; s <= 300; s += 30) log.record({ t: T + s * 1000, kind: 'c', path: '/w.md' });
    log.record({ t: T + 300_000, kind: 'c', path: '/w.md' });   // t === lastT
    await settle(log);
    const lines = readLines(path.join(dir, actLib.dateKey(T) + '.jsonl')).filter(l => l.p === '/w.md');
    check('每 30 秒连写 5 分钟 → 6 条（每条代表"这一分钟里有活"）', lines.map(l => (l.t - T) / 1000), [0, 60, 120, 180, 240, 300]);
    // mtime 回退（cp -p 覆盖成更早的版本）超过一个窗口 → 记；不足一个窗口 → 丢
    log.record({ t: T + 300_000 - 30_000, kind: 'c', path: '/w.md' });
    log.record({ t: T - 10 * MIN, kind: 'c', path: '/w.md' });
    // 计数类与 s 类互不合并：先 s，30 秒后 AI 的 c，两条都落盘
    log.record({ t: T, kind: 's', path: '/x.md' });
    log.record({ t: T + 30_000, kind: 'c', path: '/x.md' });
    log.record({ t: T + 40_000, kind: 's', path: '/x.md' });   // 与上一条 s 相隔 40 秒 → 合并
    await settle(log);
    const all = readLines(path.join(dir, actLib.dateKey(T) + '.jsonl'));
    check('mtime 回退不足一个窗口丢弃、超过一个窗口记录',
      all.filter(l => l.p === '/w.md').map(l => (l.t - T) / 1000), [0, 60, 120, 180, 240, 300, -600]);
    check('s 与随后 30 秒的 c 互不合并（两条都在）；s 自己在窗口内合并',
      all.filter(l => l.p === '/x.md').map(l => [l.k, (l.t - T) / 1000]), [['s', 0], ['c', 30]]);
    check('一行 {t,k,p} 三个字段', Object.keys(all[0]).sort(), ['k', 'p', 't']);
    log.close();
  }

  console.log('\n[夹取 / 按日分文件 / 8 天保留 / 单日上限]');
  {
    const dir = tmpDir();
    const now = noonToday();
    // 预先放 11 个日期文件（今天往前 0..10 天）
    for (let i = 0; i <= 10; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      fs.writeFileSync(path.join(dir, actLib.dateKey(d.getTime()) + '.jsonl'), JSON.stringify({ t: d.getTime(), k: 'c', p: '/old' + i }) + '\n');
    }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ createdAt: now - 30 * DAY }));
    const log = await mk(dir, { now: () => now, dayLimit: 5 });
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
    check('启动时删掉更早的文件，只留 8 个日期文件', files.length, 8);
    const oldest = new Date(now); oldest.setDate(oldest.getDate() - 7);
    check('最早保留的是 7 天前那天', files[0], actLib.dateKey(oldest.getTime()) + '.jsonl');

    log.record({ t: now - 9 * DAY, kind: 'a', path: '/ancient.md' });           // < now - 8d：不落盘
    log.record({ t: now + 10 * MIN, kind: 'c', path: '/future.md' });          // > now + 5min：夹到 now
    log.record({ t: now + 2 * MIN, kind: 'c', path: '/soon.md' });             // 5 分钟内：保持原值
    log.record({ t: 0, kind: 'c', path: '/zero.md' });                         // mtime 为 0：忽略
    log.record({ t: now - 2 * DAY, kind: 'c', path: '/two-days.md' });
    await settle(log);
    const nine = new Date(now - 9 * DAY);
    check('8 天前的事件不落盘（不生成对应日期文件）', fs.existsSync(path.join(dir, actLib.dateKey(nine.getTime()) + '.jsonl')), false);
    const today = readLines(path.join(dir, actLib.dateKey(now) + '.jsonl'));
    check('未来超过 5 分钟的时间戳夹到 now', today.find(l => l.p === '/future.md').t, now);
    check('5 分钟内的未来时间戳保持原值', today.find(l => l.p === '/soon.md').t, now + 2 * MIN);
    check('t === 0 被忽略', today.some(l => l.p === '/zero.md'), false);
    const two = readLines(path.join(dir, actLib.dateKey(now - 2 * DAY) + '.jsonl'));
    check('按事件时间的本地日期写进对应文件', two.some(l => l.p === '/two-days.md'), true);
    // 单日上限（这里注入 5）：今天已有 1 行预置 + 2 行，再写 5 条只收 2 条
    for (let i = 0; i < 5; i++) log.record({ t: now - i * 2 * MIN, kind: 'c', path: '/cap' + i });
    await settle(log);
    const capped = readLines(path.join(dir, actLib.dateKey(now) + '.jsonl'));
    check('单日上限：当天行数停在上限', capped.length, 5);
    check('超出的计入 dropped', log.stats().dropped, 3);
    log.close();
  }

  console.log('\n[query：范围裁剪、路径表、坏行、去重、截断]');
  {
    const dir = tmpDir();
    const now = noonToday();
    const log = await mk(dir, { now: () => now });
    const T = now - 5 * HOUR;
    log.record({ t: T, kind: 'a', path: '/q/a.md' });
    log.record({ t: T + HOUR, kind: 'c', path: '/q/b.md' });
    log.record({ t: T + 2 * HOUR, kind: 's', path: '/q/a.md' });
    log.record({ t: T + 3 * HOUR, kind: 'c', path: '/q/gone.md' });
    log.record({ t: now - 3 * DAY, kind: 'c', path: '/q/a.md' });
    // 缓冲还没冲刷时也能查到
    const pre = await log.query(T - 1, now, { inIndex: () => true });
    check('还没落盘的缓冲也并入结果', pre.events.length, 4);
    await settle(log);
    fs.appendFileSync(path.join(dir, actLib.dateKey(now) + '.jsonl'), 'not json\n{"t":"x","k":"c","p":"/q"}\n{"t":1,"k":"z","p":"/q"}\n');
    const r = await log.query(T - 1, now, { inIndex: (p) => p !== '/q/gone.md' });
    check('只返回范围内、且 inIndex 为真的事件', r.events.length, 3);
    check('paths 表只含被引用的路径，下标对齐', r.events.map(e => r.paths[e[2]]), ['/q/a.md', '/q/b.md', '/q/a.md']);
    check('kind 编码：a → 0、c → 1、s → 2', r.events.map(e => e[1]), [0, 1, 2]);
    check('坏行计入 skipped', r.skipped, 3);
    check('logStart = max(createdAt, 保留范围起点)', typeof r.logStart === 'number' && r.logStart <= now, true);
    const r2 = await log.query(now - 4 * DAY, now - 2 * DAY, { inIndex: () => true });
    check('范围裁剪：只拿到 3 天前那条', r2.events.map(e => [e[0], r2.paths[e[2]]]), [[now - 3 * DAY, '/q/a.md']]);
    log.close();

    // 5 万条截断：三天各 1.8 万行（直接写文件），query 保留最新 5 万条
    const dir2 = tmpDir();
    const days = [2, 1, 0].map(i => { const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(1, 0, 0, 0); return d.getTime(); });
    for (const base of days) {
      let buf = '';
      for (let i = 0; i < 18_000; i++) buf += JSON.stringify({ t: base + i * 1000, k: 'c', p: '/big/' + (i % 500) }) + '\n';
      // 同一行重复写一次：去重在截断之前，重复行不占上限
      buf += JSON.stringify({ t: base, k: 'c', p: '/big/0' }) + '\n';
      fs.writeFileSync(path.join(dir2, actLib.dateKey(base) + '.jsonl'), buf);
    }
    const big = await mk(dir2, { now: () => now });
    const rb = await big.query(now - 7 * DAY, now, { inIndex: () => true });
    check('超过 5 万条：截断到 50000 并置 truncated', [rb.events.length, rb.truncated], [50000, true]);
    check('截断保留最新的', rb.events[rb.events.length - 1][0], days[2] + 17_999 * 1000);
    check('最旧被丢掉的是最早那天的前 4000 条（重复行没占名额）', rb.events[0][0], days[0] + 4000 * 1000);
    big.close();
  }

  console.log('\n[重启预热]');
  {
    const dir = tmpDir();
    const now = noonToday();
    const log1 = await mk(dir, { now: () => now });
    const tToday = now - HOUR;
    const t3d = now - 3 * DAY;
    log1.record({ t: tToday, kind: 'c', path: '/r/a.md' });
    log1.record({ t: t3d, kind: 'c', path: '/r/b.md' });
    log1.close();
    const todayFile = path.join(dir, actLib.dateKey(tToday) + '.jsonl');
    const oldFile = path.join(dir, actLib.dateKey(t3d) + '.jsonl');
    const log2 = await mk(dir, { now: () => now });
    log2.record({ t: tToday, kind: 'c', path: '/r/a.md' });   // FSEvents 重启后补发：mtime 在今天
    log2.record({ t: t3d, kind: 'c', path: '/r/b.md' });      // mtime 在 3 天前：预热不覆盖
    await settle(log2);
    check('今天的同一路径同一 mtime：日期文件行数不变', readLines(todayFile).length, 1);
    check('3 天前的同一操作：日期文件里出现两行', readLines(oldFile).length, 2);
    const q = await log2.query(now - 7 * DAY, now, { inIndex: () => true });
    check('…但 query() 按 (path, t, kind) 去重只返回一条', q.events.filter(e => q.paths[e[2]] === '/r/b.md').length, 1);
    log2.close();

    // 预热期间到达的事件先进 pending，预热结束后按到达顺序走合并规则
    const log3 = actLib.createActivityLog({ dir, log: quietLog(), flushMs: 20, now: () => now });
    log3.record({ t: tToday, kind: 'c', path: '/r/a.md' });            // 预热后知道今天已有 → 丢
    log3.record({ t: now - 30 * MIN, kind: 'c', path: '/r/p1.md' });
    log3.record({ t: now - 20 * MIN, kind: 'a', path: '/r/p2.md' });
    log3.record({ t: now - 30 * MIN + 10_000, kind: 'c', path: '/r/p1.md' });  // 与 p1 上一条相隔 10 秒 → 合并
    log3.record({ t: now - 10 * MIN, kind: 'c', path: '/r/p1.md' });
    check('预热期间事件进 pending', log3.stats().pending, 5);
    await log3.ready();
    await settle(log3);
    check('预热完成后按到达顺序处理（并应用预热得到的 lastT）',
      readLines(todayFile).slice(1).map(l => [l.p.slice(3), l.t - now]),
      [['p1.md', -30 * MIN], ['p2.md', -20 * MIN], ['p1.md', -10 * MIN]]);
    log3.close();
  }

  console.log('\n[停用与追加失败]');
  {
    const base = tmpDir();
    const blocker = path.join(base, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const ql = quietLog();
    const off = actLib.createActivityLog({ dir: path.join(blocker, 'activity'), log: ql });
    off.record({ t: Date.now(), kind: 'c', path: '/x.md' });
    const r = await off.query(Date.now() - DAY, Date.now(), {});
    check('目录建不出来：记录停用', off.isEnabled(), false);
    check('查询返回 {logStart:null, events:[]}', [r.logStart, r.events], [null, []]);
    check('启动时 warn 一次', ql.warns.length, 1);

    const dir = tmpDir();
    const now = noonToday();
    const ql2 = quietLog();
    const log = actLib.createActivityLog({ dir, log: ql2, flushMs: 10, now: () => now });
    await log.ready();
    fs.mkdirSync(path.join(dir, actLib.dateKey(now) + '.jsonl'));   // 让 appendFile 失败（EISDIR）
    log.record({ t: now - 5 * MIN, kind: 'c', path: '/f1.md' });
    await settle(log);
    log.record({ t: now - 3 * MIN, kind: 'c', path: '/f2.md' });
    await settle(log);
    check('追加失败：丢弃本批、10 分钟内只 warn 一次', ql2.warns.length, 1);
    const q = await log.query(now - DAY, now, {});
    check('失败的批次不再出现在查询里（已丢弃）', q.events.length, 0);
    log.close();
  }

  // ==================== node：public/river.js ====================
  console.log('\n[river.js：shouldMerge 与 lib 判定逐例一致]');
  {
    const W = 60_000;
    const cases = [[null, 5], [undefined, 5], [0, 0], [1000, 1000], [1000, 60_999], [1000, 61_000], [1000, 61_001],
      [61_000, 1000], [61_000, 1001], [5, -59_994], [5, -59_995], [100, 100 + W - 1], [100, 100 + W]];
    check('同一组输入结果相同', cases.map(([a, b]) => R.shouldMerge(a, b, W)), cases.map(([a, b]) => actLib.shouldMergeExpr(a, b, W)));
    check('固定窗口语义：差 < 60 秒合并、= 60 秒不合并、含 t === lastT', [R.shouldMerge(0, 59_999, W), R.shouldMerge(0, 60_000, W), R.shouldMerge(7, 7, W)], [true, false, true]);
    const n = noonToday();
    const ts = [0, -5, NaN, n, n + 4 * MIN, n + 6 * MIN, n - 7 * DAY, n - 8 * DAY + 1, n - 8 * DAY - 1];
    check('clampTime 与 lib 逐例一致', ts.map(t => R.clampTime(t, n)), ts.map(t => actLib.clampTime(t, n)));
  }

  console.log('\n[river.js：classifySse 表]');
  check('save → 2、rename（add / change）→ 0、null → add 0 / change 1、unlink → null', [
    R.classifySse({ kind: 'change', selfReason: 'save' }),
    R.classifySse({ kind: 'add', selfReason: 'save' }),
    R.classifySse({ kind: 'add', selfReason: 'rename' }),
    R.classifySse({ kind: 'change', selfReason: 'rename' }),
    R.classifySse({ kind: 'add', selfReason: null }),
    R.classifySse({ kind: 'change', selfReason: null }),
    R.classifySse({ kind: 'unlink', selfReason: null }),
  ], [2, 2, 0, 0, 0, 1, null]);

  console.log('\n[river.js：mtime 兜底]');
  {
    const now = noonToday() + 30 * MIN;
    const T = now - 3 * HOUR;
    const logStart = now - 2 * DAY;
    const mkLog = (events) => ({ logStart, mergeWindowMs: 60_000, events });
    const counted = (evs) => evs.filter(e => e.kind === 0 || e.kind === 1);
    // AI 在 T、T+5s、T+20s 连写三次：日志只记 T，文件 mtime = T+20s
    let m = R.mergeWithFallback(mkLog([{ t: T, kind: 1, path: '/a' }]), [{ path: '/a', mtime: T + 20_000 }], now);
    check('60 秒内连写三次 → 只计 1 次、不补合成事件', [counted(m).length, m.some(e => e.src === 'mtime')], [1, false]);
    m = R.mergeWithFallback(mkLog([{ t: T, kind: 2, path: '/a' }]), [{ path: '/a', mtime: T }], now);
    check('日志里只有一条 kind 2（t = mtime）→ 计数 0、不补', [counted(m).length, m.length], [0, 1]);
    m = R.mergeWithFallback(mkLog([]), [{ path: '/a', mtime: logStart - HOUR }], now);
    check('mtime 早于 logStart → 补 1 个合成事件', m.map(e => [e.kind, e.src]), [[1, 'mtime']]);
    m = R.mergeWithFallback({ logStart: null, mergeWindowMs: 60_000, events: [] },
      [{ path: '/a', mtime: T }, { path: '/b', mtime: T - DAY }, { path: '/c', mtime: now - 8 * DAY }], now);
    check('logStart === null → 窗口内的全部用合成事件（窗口外的不补）', m.map(e => e.path), ['/b', '/a']);
    check('日志不可用（null）同样全部合成', R.mergeWithFallback(null, [{ path: '/a', mtime: T }], now).length, 1);
    m = R.mergeWithFallback(mkLog([{ t: T, kind: 1, path: '/a' }, { t: T, kind: 0, path: '/a' }, { t: T, kind: 2, path: '/a' }]),
      [{ path: '/a', mtime: T }], now);
    check('(path, t) 完全相同的两条计数事件只计 1 次（覆盖标记另算）', [counted(m).length, m.length], [1, 2]);
    m = R.mergeWithFallback(mkLog([{ t: T, kind: 1, path: '/gone' }]), [{ path: '/a', mtime: logStart + HOUR }], now);
    check('只保留当前 files 里的路径；mtime 附近没有日志事件时补合成', m.map(e => e.path), ['/a']);
    const b = R.bucketize([{ t: now - 10 * MIN, kind: 1, path: '/a' }, { t: now - 5 * MIN, kind: 0, path: '/b' },
      { t: now - 26 * HOUR, kind: 1, path: '/a' }, { t: now, kind: 2, path: '/a' }, { t: now - 8 * DAY, kind: 1, path: '/a' }], now);
    const tot = R.riverTotals(b);
    check('bucketize：168 桶，只计 kind 0 / 1、窗口外不计', [b.counts.length, tot.total], [168, 3]);
    check('最后一根柱 = 当前小时：2 次改动 · 2 篇', [b.counts[167], b.docs[167]], [2, 2]);
    check('riverTotals：最忙的柱（并列取最早）', [tot.busiest, tot.busiestCount], [167, 2]);
  }

  console.log('\n[river.js：SSE 追加副本 == 服务端重拉]');
  {
    const dir = tmpDir();
    const now = noonToday();
    const log = await mk(dir, { now: () => now });
    const local = R.decodeLog(await log.query(now - 7 * DAY, now, { inIndex: () => true }));
    const seq = [
      { kind: 'add', path: '/s/a.md', mtime: now - 50 * MIN, selfReason: null },
      { kind: 'change', path: '/s/a.md', mtime: now - 50 * MIN + 5000, selfReason: null },
      { kind: 'change', path: '/s/a.md', mtime: now - 40 * MIN, selfReason: null },
      { kind: 'change', path: '/s/a.md', mtime: now - 40 * MIN + 1000, selfReason: 'save' },
      { kind: 'change', path: '/s/a.md', mtime: now - 39 * MIN + 30_000, selfReason: 'save' },
      { kind: 'change', path: '/s/b.md', mtime: now - 30 * MIN, selfReason: 'rename' },
      { kind: 'add', path: '/s/c.md', mtime: now + 20 * MIN, selfReason: null },
      { kind: 'change', path: '/s/c.md', mtime: now - 9 * DAY, selfReason: null },
      { kind: 'change', path: '/s/d.md', mtime: 0, selfReason: null },
    ];
    for (const d of seq) {
      R.appendSseEvent(local, d, local.mergeWindowMs, now);
      const k = actLib.classifyEvent(d.kind, d.selfReason);
      log.record({ t: d.mtime, kind: k, path: d.path });
    }
    await settle(log);
    const pulled = R.decodeLog(await log.query(now - 7 * DAY, now, { inIndex: () => true }));
    const norm = (evs) => evs.map(e => [e.t, e.kind, e.path]).sort((x, y) => x[0] - y[0] || x[2].localeCompare(y[2]));
    check('按 data.mtime 追加后的本地副本与重拉结果逐条相等', norm(local.events), norm(pulled.events));
    check('mergeWindowMs 随响应带回、两边一致', [local.mergeWindowMs, pulled.mergeWindowMs], [60000, 60000]);
    log.close();
  }

  console.log('\n[river.js：时间段与窗口滚动]');
  {
    const now = noonToday();
    const ws = R.windowStart(now);
    check('窗口起点 = 当前整点 + 1h - 168h', ws, R.floorHour(now) + HOUR - 168 * HOUR);
    const local = { logStart: now - 7 * DAY, mergeWindowMs: 60_000, events: [{ t: now - 2 * HOUR, kind: 1, path: '/a' }] };
    const open = R.presetRange(24, now);
    const fixed = { from: R.floorHour(now) - 23 * HOUR, to: R.floorHour(now) - HOUR };
    check('「24 小时」预设 = 当前整点 - 23h、开放到现在', open, { from: R.floorHour(now) - 23 * HOUR, to: null });
    R.appendSseEvent(local, { kind: 'add', path: '/new', mtime: now - 60_000, selfReason: null }, 60_000, now);
    check('to === null 包含此后追加的事件', [...R.timeRangePaths(local.events, open)].sort(), ['/a', '/new']);
    check('to 为数字时不包含（区间之后的事件）', [...R.timeRangePaths(local.events, fixed)], ['/a']);
    check('kind 2 不进命中', R.timeRangePaths([{ t: now - HOUR, kind: 2, path: '/s' }], open).size, 0);
    check('from ≤ t（含端点）且 t < to（不含端点）', [
      R.timeRangePaths([{ t: fixed.from, kind: 1, path: '/x' }], fixed).size,
      R.timeRangePaths([{ t: fixed.to, kind: 1, path: '/x' }], fixed).size,
    ], [1, 0]);
    // 窗口滚动：起点后移 10 小时
    const ws2 = ws + 10 * HOUR;
    check('from 早于新窗口起点 → 夹到起点', R.clampRange({ from: ws + 2 * HOUR, to: ws + 20 * HOUR }, ws2),
      { range: { from: ws2, to: ws + 20 * HOUR }, cleared: false, changed: true });
    check('整段滑出（to 不晚于起点）→ 已清除', R.clampRange({ from: ws, to: ws + 5 * HOUR }, ws2).cleared, true);
    check('窗口内的区间不变', R.clampRange(fixed, ws), { range: fixed, cleared: false, changed: false });
    check('手柄 0 与 168 等价 null；右手柄 168 = 开放到现在',
      [R.rangeFromHandles(0, 168, ws), R.rangeFromHandles(144, 168, ws)], [null, { from: ws + 144 * HOUR, to: null }]);
    check('handlesFromRange 与 rangeFromHandles 互逆', R.handlesFromRange(R.rangeFromHandles(10, 30, ws), ws), [10, 30]);
    check('手柄 aria-valuetext 形如「10月3日 周四 14:00」', /^\d{1,2}月\d{1,2}日 周[日一二三四五六] \d{2}:00$/.test(R.fmtValueText(now)), true);
  }

  // ==================== 接口：startAtlas 隔离实例 ====================
  console.log('\n[接口：/api/activity 与写入点]');
  const atlas = await startAtlas({
    prefix: 'atlas-activity-log-',
    files: {
      'p/a.md': '# A\n',
      'p/b.md': '# B\n',
      'p/c.md': '# C\n',
      'arch/x.md': '# X\n',
    },
  });
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get(atlas.base + p, { headers }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    }).on('error', reject);
  });
  const post = (p, body) => fetch(atlas.base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
  // SSE：收 fs 负载
  const sse = [];
  const sseReq = http.get(atlas.base + '/api/events', (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) { try { const o = JSON.parse(line.slice(6)); if (o.channel === 'fs') sse.push(o); } catch {} }
      }
    });
  });
  const waitFor = async (fn, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const decode = (j) => (j && j.events ? j.events.map(e => ({ t: e[0], kind: e[1], path: j.paths[e[2]] })) : []);
  let storeKeysBefore = [];

  try {
    await get('/api/state');
    storeKeysBefore = Object.keys(atlas.readStore() || {}).sort();
    // 归档 arch 项目
    await post('/api/archive', { name: 'arch' });
    await sleep(800);   // 等 watcher 盘点完成

    let r = await get('/api/activity');
    check('GET /api/activity 200 + Cache-Control: no-store', [r.status, r.headers['cache-control']], [200, 'no-store']);
    check('响应形状', Object.keys(r.json).sort(), ['events', 'logStart', 'mergeWindowMs', 'paths', 'skipped', 'truncated']);
    check('mergeWindowMs === MERGE_WINDOW_MS === 60000', [r.json.mergeWindowMs, actLib.MERGE_WINDOW_MS], [60000, 60000]);
    check('logStart 是数字（日志已建立）', typeof r.json.logStart, 'number');

    // 外部写：SSE self === false，日志 k:'c'
    const aPath = atlas.filePath('p/a.md');
    fs.writeFileSync(aPath, '# A\n\n外部改动\n');
    const ev = await waitFor(() => sse.find(e => e.path === aPath && e.kind === 'change'));
    check('外部写 fixture：SSE fs 负载 self === false、selfReason === null', ev && [ev.self, ev.selfReason], [false, null]);
    r = await get('/api/activity');
    const evA = decode(r.json).filter(e => e.path === aPath);
    check('/api/activity 出现对应事件（kind 1，t = mtime）', evA.map(e => [e.kind, e.t]), [[1, ev.mtime]]);

    // /api/save-md 自写：k:'s' / kind 2 / SSE self === true
    const bPath = atlas.filePath('p/b.md');
    const save = await post('/api/save-md', { path: bPath, content: '# B\n\n用户在 Atlas 里保存\n' });
    check('/api/save-md 成功', save.status, 200);
    const evB = await waitFor(() => sse.find(e => e.path === bPath));
    check('自写：SSE self === true、selfReason === \'save\'', evB && [evB.self, evB.selfReason], [true, 'save']);
    r = await get('/api/activity');
    check('自写在 /api/activity 里是 kind 2', decode(r.json).filter(e => e.path === bPath).map(e => e.kind), [2]);

    // /api/rename：新路径 selfReason 'rename'，日志 k:'a'
    const cPath = atlas.filePath('p/c.md');
    const cNew = atlas.filePath('p/c-renamed.md');
    const ren = await post('/api/rename', { path: cPath, name: 'c-renamed.md' });
    check('/api/rename 成功', ren.status, 200);
    const evC = await waitFor(() => sse.find(e => e.path === cNew && e.kind !== 'unlink'));
    check('重命名新路径：self === true、selfReason === \'rename\'', evC && [evC.self, evC.selfReason], [true, 'rename']);
    r = await get('/api/activity');
    check('重命名新路径在 /api/activity 里是 kind 0（计数事件 a）', decode(r.json).filter(e => e.path === cNew).map(e => e.kind), [0]);
    check('旧路径已不在索引：它的事件被过滤', decode(r.json).some(e => e.path === cPath), false);

    // 归档项目不记
    const xPath = atlas.filePath('arch/x.md');
    fs.writeFileSync(xPath, '# X\n\n改了\n');
    await sleep(1200);
    r = await get('/api/activity');
    check('归档项目的文件改动不出现在日志里', decode(r.json).some(e => e.path === xPath), false);

    // 冲刷到磁盘后核对日志文件本身
    await sleep(2500);
    const actDir = path.join(atlas.homeDir, 'activity');
    const lines = fs.readdirSync(actDir).filter(f => f.endsWith('.jsonl')).flatMap(f => readLines(path.join(actDir, f)));
    check('日志落在 ATLAS_HOME/activity/（含 meta.json）', fs.existsSync(path.join(actDir, 'meta.json')) && lines.length > 0, true);
    check('日志文件：外部写 c、自写 s、重命名 a', [
      lines.filter(l => l.p === aPath).map(l => l.k),
      lines.filter(l => l.p === bPath).map(l => l.k),
      lines.filter(l => l.p === cNew).map(l => l.k),
    ], [['c'], ['s'], ['a']]);

    // 参数校验
    const now = Date.now();
    const bad = await Promise.all([
      get('/api/activity?since=abc'),
      get('/api/activity?since=1.5'),
      get('/api/activity?until=x'),
      get(`/api/activity?since=${now}&until=${now - 1000}`),
      get(`/api/activity?since=${now}&until=${now}`),
    ]);
    check('非法 since / until → 400 {error:\'bad-request\'}', bad.map(b => [b.status, b.json && b.json.error]),
      Array(5).fill([400, 'bad-request']));
    const ok = await get(`/api/activity?since=${now - 30 * DAY}&until=${now}`);
    check('since 早于 now - 8d 时夹取（不报错）', ok.status, 200);
    const narrow = await get(`/api/activity?since=${now - 1}&until=${now}`);
    check('范围裁剪：极窄区间没有事件', [narrow.status, narrow.json.events.length], [200, 0]);
    const cross = await get('/api/activity', { 'Sec-Fetch-Site': 'cross-site' });
    check('跨站请求 → 403', cross.status, 403);

    // store.json：键集合不出现 activity 相关字段，内容里也没有
    const store = atlas.readStore() || {};
    const keysAfter = Object.keys(store).sort();
    check('store.json 键集合不出现 activity 字段', keysAfter.filter(k => /activ/i.test(k)), []);
    check('store.json 没有新增任何顶层键（只被原有逻辑修改）', keysAfter.filter(k => !storeKeysBefore.includes(k)), []);
    // （路径里带临时目录前缀 atlas-activity-log-，所以只看日志特有的结构，不搜 activity 字样）
    check('store.json 里没有日志事件结构（{t,k,p} / logStart / mergeWindowMs）',
      /"k":"[acs]"|logStart|mergeWindowMs/.test(JSON.stringify(store)), false);
  } finally {
    try { sseReq.destroy(); } catch {}
    await atlas.stop();
  }

  console.log('\n========================');
  console.log(`总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('spec 自身出错:', e);
  process.exit(1);
});
