// 活动日志（design §3d）：时间河流要回答"这周 AI 在什么时候干了活"，只靠 mtime 时
// 一篇周一写、周三改、周五又改的文档只会在周五出现一次。这里把 watcher 报来的
// add / change 记成轻量事件，前端再用 mtime 兜底日志覆盖不到的时段。
//
// 存储：ATLAS_HOME/activity/YYYY-MM-DD.jsonl（按事件时间的本地日期分文件）+ meta.json {createdAt}。
//   一行一个事件 {"t":<mtime ms>,"k":"a"|"c"|"s","p":"<abs path>"}
//   a = 新增、c = 修改（计数事件）；s = Atlas 自写（保存 / 还原）的覆盖标记，不计数，
//   只供前端兜底判断"这个 mtime 已经有记录"。
//   **绝不写 store.json**：saveStore 是整文件重写、loadStore 每请求同步读，高频事件会放大 IO。
//
// 写入：
//   · 夹取：t > now + 5min → now；t < now - 8d 直接丢弃（不落盘）；t 为 0 / 非法时忽略
//   · 合并：计数类（a / c）一个 Map<path, lastT>，覆盖标记（s）另一个；lastT 是该类别
//     上一条**已落盘**事件的 t。Math.abs(t - lastT) < MERGE_WINDOW_MS → 丢弃（固定窗口）
//   · 启动预热：异步流式读今天与昨天两个文件（≤ 4 万行）填 lastT，预热完成前到达的事件
//     进 pending，结束后按到达顺序处理；预热失败 → 空 map 继续，warn 一次
//   · 缓冲：事件处理路径上没有同步 IO。每 2 秒每个日期文件一次 fs.promises.appendFile；
//     进程退出时 flushSync() 用 appendFileSync 尽力冲刷
//   · 上限：单日 2 万行，超出的丢弃并计数；保留 8 个日期文件（今天 + 前 7 天），
//     启动时与跨日后第一次写入时删除更早的
// 读：query(since, until, { inIndex }) 只打开覆盖到的日期文件，readline 流式解析，坏行计入
//   skipped；已结束的日期按「文件名 + mtime」缓存解析结果；只保留 inIndex(path) 为真的路径；
//   截断前按 (path, t, kind) 去重；最多 5 万条（保留最新的，置 truncated）。
//   还没落盘的缓冲（含正在追加的那一批）也并入结果，所以刚发生的事件立即可查。
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const MERGE_WINDOW_MS = 60_000;
const DAY_MS = 86_400_000;
const FUTURE_SLACK_MS = 5 * 60_000;
const RETAIN_MS = 8 * DAY_MS;          // 早于 now - 8d 的事件不落盘
const KEEP_FILES = 8;                  // 保留的日期文件数：今天 + 前 7 天
const DAY_LINE_LIMIT = 20_000;
const QUERY_MAX = 50_000;
const WARM_MAX_LINES = 40_000;
const FLUSH_MS = 2000;
const MAP_PRUNE_AT = 10_000;
const WARN_INTERVAL_MS = 10 * 60_000;
const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const KIND_CODE = { a: 0, c: 1, s: 2 };

// 合并判定：与 public/river.js 的 shouldMerge 是同一个表达式（activity-log.spec 逐例对照）
function shouldMergeExpr(lastT, t, windowMs) {
  return lastT != null && Math.abs(t - lastT) < windowMs;
}

// watcher 事件 → 日志类别。分类依据是写入方登记的原因（selfReason），不是 watcher 报的 kind：
// 初始盘点完成前 watcher 一律报 change，所以 Atlas 的重命名可能以 change + 'rename' 到达，
// 照样记 a（旧路径已不在索引里，新路径需要一个计数事件接替）。unlink 不记。
function classifyEvent(kind, selfReason) {
  if (kind === 'unlink') return null;
  if (selfReason === 'save') return 's';
  if (kind === 'add' || selfReason === 'rename') return 'a';
  return 'c';
}

// 写入前的时间夹取：返回夹取后的 t，或 null（丢弃）
function clampTime(t, now) {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return null;
  if (t > now + FUTURE_SLACK_MS) return now;
  if (t < now - RETAIN_MS) return null;
  return t;
}

function pad2(n) { return String(n).padStart(2, '0'); }
// 本地日期键 YYYY-MM-DD
function dateKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// 本地日期键 → 当天 0 点的时间戳
function keyStart(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}
// 从 now 往前数第 n 个本地日期的键（按日历日，跨夏令时也正确）
function dayKeyBack(now, n) {
  const d = new Date(now);
  return dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime());
}
// 最早仍保留的日期键（今天往前 KEEP_FILES - 1 天）
function cutoffKey(now) { return dayKeyBack(now, KEEP_FILES - 1); }

function createActivityLog(opts = {}) {
  const {
    dir,
    now = Date.now,
    log = console,
    flushMs = FLUSH_MS,
    dayLimit = DAY_LINE_LIMIT,
    queryMax = QUERY_MAX,
    warmMaxLines = WARM_MAX_LINES,
  } = opts;

  let enabled = true;
  let createdAt = null;
  const lastCount = new Map();   // 计数类（a / c）：path → lastT
  const lastSelf = new Map();    // 覆盖标记（s）：path → lastT
  const dayCounts = new Map();   // 日期键 → 已写（或已排队）的行数（本次运行所知）
  let dropped = 0;               // 因单日上限丢弃的条数
  let buffer = new Map();        // 日期键 → [{t, k, p}]，等待下一次追加
  const inflight = new Set();    // 正在 appendFile 的批次 { key, items }
  const parsedCache = new Map(); // 文件名 → { mtimeMs, items, skipped }（只缓存已结束的日期）
  let pending = [];              // 预热期间到达的事件（已夹取）
  let warming = true;
  let lastDayKey = null;
  let lastAppendWarn = 0;
  let flushTimer = null;
  let closed = false;

  // ---- 目录与 meta ----
  try {
    fs.mkdirSync(dir, { recursive: true });
    const metaPath = path.join(dir, 'meta.json');
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && Number.isFinite(meta.createdAt)) createdAt = meta.createdAt;
    } catch {}
    if (createdAt == null) {
      createdAt = now();
      fs.writeFileSync(metaPath, JSON.stringify({ createdAt }));
    }
  } catch (e) {
    enabled = false;
    warming = false;
    try { log.warn('  ! 活动日志不可用（目录建不出来），时间河流只用修改时间:', e && (e.code || e.message)); } catch {}
  }

  function fileOf(key) { return path.join(dir, key + '.jsonl'); }

  // 删掉早于保留范围的日期文件（异步，失败忽略）
  async function rotate() {
    if (!enabled) return;
    const cut = cutoffKey(now());
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const key = name.slice(0, 10);
      if (key < cut) {
        parsedCache.delete(name);
        dayCounts.delete(key);
        try { await fsp.unlink(path.join(dir, name)); } catch {}
      }
    }
  }

  // 流式解析一个日期文件。onItem 返回 false 时提前停止
  function parseFile(file, onItem) {
    return new Promise((resolve, reject) => {
      let skipped = 0;
      let lines = 0;
      let stopped = false;
      const stream = fs.createReadStream(file, { encoding: 'utf8' });
      const onError = (e) => {
        if (e && e.code === 'ENOENT') resolve({ lines: 0, skipped: 0, missing: true });
        else reject(e);
      };
      stream.on('error', onError);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('error', onError);   // readline 会把输入流的错误再抛一次
      rl.on('line', (line) => {
        if (stopped || !line) return;
        lines++;
        let o = null;
        try { o = JSON.parse(line); } catch {}
        if (!o || typeof o.t !== 'number' || !Number.isFinite(o.t) || typeof o.p !== 'string'
            || !Object.prototype.hasOwnProperty.call(KIND_CODE, o.k)) {
          skipped++;
          return;
        }
        if (onItem(o) === false) {
          stopped = true;
          rl.close();
          stream.destroy();
        }
      });
      rl.on('close', () => resolve({ lines, skipped }));
    });
  }

  // ---- 预热：今天与昨天，按类别取每个路径最后一条事件的 t ----
  const warmPromise = (async () => {
    if (!enabled) return;
    await rotate();
    const t0 = now();
    let budget = warmMaxLines;
    for (const key of [dayKeyBack(t0, 1), dateKey(t0)]) {
      if (budget <= 0) break;
      try {
        const r = await parseFile(fileOf(key), (o) => {
          (o.k === 's' ? lastSelf : lastCount).set(o.p, o.t);
          return --budget > 0;
        });
        dayCounts.set(key, (dayCounts.get(key) || 0) + r.lines);
      } catch (e) {
        lastCount.clear();
        lastSelf.clear();
        try { log.warn('  ! 活动日志预热失败，按空记录继续:', e && (e.code || e.message)); } catch {}
        break;
      }
    }
  })().catch(() => {}).then(() => {
    warming = false;
    const queued = pending;
    pending = [];
    for (const it of queued) accept(it);
  });

  function pruneMap(map, t) {
    if (map.size <= MAP_PRUNE_AT) return;
    for (const [p, lt] of map) if (lt < t - MERGE_WINDOW_MS) map.delete(p);
  }

  // 合并规则 + 单日上限 → 进缓冲
  function accept(it) {
    const map = it.k === 's' ? lastSelf : lastCount;
    const lastT = map.get(it.p);
    if (shouldMergeExpr(lastT, it.t, MERGE_WINDOW_MS)) return;
    const key = dateKey(it.t);
    const n = dayCounts.get(key) || 0;
    if (n >= dayLimit) { dropped++; return; }
    dayCounts.set(key, n + 1);
    map.set(it.p, it.t);
    pruneMap(map, it.t);
    let arr = buffer.get(key);
    if (!arr) { arr = []; buffer.set(key, arr); }
    arr.push({ t: it.t, k: it.k, p: it.p });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer || closed) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, flushMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  function warnAppend(e) {
    const t = Date.now();
    if (t - lastAppendWarn < WARN_INTERVAL_MS) return;
    lastAppendWarn = t;
    try { log.warn('  ! 活动日志追加失败，本批丢弃:', e && (e.code || e.message)); } catch {}
  }

  function linesOf(items) {
    return items.map(o => JSON.stringify({ t: o.t, k: o.k, p: o.p })).join('\n') + '\n';
  }

  // 每个日期文件一次 appendFile。失败丢弃本批（下批照常重试），10 分钟内最多 warn 一次
  async function flush() {
    if (!enabled || !buffer.size) return;
    const batches = [...buffer].map(([key, items]) => ({ key, items, done: false }));
    buffer = new Map();
    await Promise.all(batches.map(async (b) => {
      inflight.add(b);
      try {
        await fsp.appendFile(fileOf(b.key), linesOf(b.items));
      } catch (e) {
        dayCounts.set(b.key, Math.max(0, (dayCounts.get(b.key) || 0) - b.items.length));
        warnAppend(e);
      } finally {
        b.done = true;
        inflight.delete(b);
      }
    }));
  }

  // 退出时尽力冲刷：缓冲 + 还没确认写完的那一批（可能重复，query 去重吸收）
  function flushSync() {
    if (!enabled) return;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const groups = new Map();
    for (const b of inflight) if (!b.done) groups.set(b.key, (groups.get(b.key) || []).concat(b.items));
    for (const [key, items] of buffer) groups.set(key, (groups.get(key) || []).concat(items));
    buffer = new Map();
    for (const [key, items] of groups) {
      try { fs.appendFileSync(fileOf(key), linesOf(items)); } catch {}
    }
  }

  function record({ t, kind, path: p } = {}) {
    if (!enabled || closed || !p || !Object.prototype.hasOwnProperty.call(KIND_CODE, kind)) return;
    const n = now();
    const ct = clampTime(t, n);
    if (ct == null) return;
    // 跨日后的第一次写入：顺手轮转
    const today = dateKey(n);
    if (lastDayKey !== today) {
      if (lastDayKey !== null) rotate().catch(() => {});
      lastDayKey = today;
    }
    const it = { t: ct, k: kind, p };
    if (warming) { pending.push(it); return; }
    accept(it);
  }

  // 读一个日期文件（已结束的日期按 文件名 + mtime 缓存）
  async function readDay(key, todayKey) {
    const name = key + '.jsonl';
    const file = path.join(dir, name);
    let st;
    try { st = await fsp.stat(file); } catch { return { items: [], skipped: 0 }; }
    if (key < todayKey) {
      const c = parsedCache.get(name);
      if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
    }
    const items = [];
    let r;
    try { r = await parseFile(file, (o) => { items.push(o); }); } catch { return { items: [], skipped: 0 }; }
    const out = { mtimeMs: st.mtimeMs, size: st.size, items, skipped: r.skipped };
    if (key < todayKey) parsedCache.set(name, out);
    return out;
  }

  // 日志最早可信时间：meta.createdAt 与保留范围起点中较晚者
  function logStart() {
    if (!enabled) return null;
    return Math.max(createdAt, keyStart(cutoffKey(now())));
  }

  async function query(since, until, { inIndex } = {}) {
    if (!enabled) return { logStart: null, paths: [], events: [], truncated: false, skipped: 0 };
    await warmPromise;
    const n = now();
    const todayKey = dateKey(n);
    const keys = [];
    const firstKey = dateKey(since);
    const lastKey = dateKey(until);
    for (let i = 0; i < KEEP_FILES + 2; i++) {
      const k = dayKeyBack(n, i);
      if (k < firstKey) break;
      if (k <= lastKey) keys.push(k);
    }
    let skipped = 0;
    const all = [];
    for (const k of keys) {
      const r = await readDay(k, todayKey);
      skipped += r.skipped || 0;
      for (const o of r.items) all.push(o);
    }
    for (const b of inflight) for (const o of b.items) all.push(o);
    for (const items of buffer.values()) for (const o of items) all.push(o);

    const seen = new Set();
    const kept = [];
    for (const o of all) {
      if (o.t < since || o.t > until) continue;
      if (inIndex && !inIndex(o.p)) continue;
      const code = KIND_CODE[o.k];
      const key = o.t + '|' + code + '|' + o.p;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push({ t: o.t, kind: code, p: o.p });
    }
    kept.sort((a, b) => a.t - b.t);
    let truncated = false;
    let list = kept;
    if (list.length > queryMax) { list = list.slice(list.length - queryMax); truncated = true; }
    const paths = [];
    const idx = new Map();
    const events = list.map((e) => {
      let i = idx.get(e.p);
      if (i === undefined) { i = paths.length; idx.set(e.p, i); paths.push(e.p); }
      return [e.t, e.kind, i];
    });
    return { logStart: logStart(), paths, events, truncated, skipped };
  }

  function close() {
    flushSync();
    closed = true;
  }

  return {
    record,
    query,
    flush,
    flushSync,
    close,
    ready: () => warmPromise,
    isEnabled: () => enabled,
    stats: () => ({ dropped, pending: pending.length, warming, countMapSize: lastCount.size, selfMapSize: lastSelf.size }),
  };
}

module.exports = {
  createActivityLog,
  classifyEvent,
  clampTime,
  shouldMergeExpr,
  dateKey,
  MERGE_WINDOW_MS,
  DAY_LINE_LIMIT,
  QUERY_MAX,
  KEEP_FILES,
};
