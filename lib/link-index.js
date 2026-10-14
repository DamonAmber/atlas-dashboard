// 引用关系索引（design §10.9）：星图里的连线 = 文档之间真实的链接。
//
// 只解析 .md 与 .html / .htm，每个文件读前 512KB：
//   · MD：内联链接 [..](href) 与引用式定义 [id]: href，跳过围栏代码块与行内代码
//   · HTML：正则匹配 <a … href="…">（不引入 DOM 解析库）
// href 规整：丢掉 http(s) / mailto / data / javascript 等带协议的地址与纯锚点，去 ?query 与 #hash，
// decodeURIComponent 失败就跳过这条；相对路径按源文件目录解析，file:// 转本地路径；
// realpath 后必须落在某个扫描根内（再映射回索引用的路径写法，扫描根本身是软链也能对上）。
// 指向目录时依次尝试 index.html / README.md。自引用丢弃，同一对 A→B 去重，每个文件最多 200 条。
//
// 缓存：ATLAS_HOME/links/index.json，按源文件存 { mtime, size, targets }（不写 store.json）。
// 启动时 mtime 与 size 都没变的条目直接复用；写盘 2 秒防抖，先写临时文件再 rename；
// 缓存文件损坏时 warn 一次并全量重建。目标文件后来被删不改缓存——查询时按当前索引过滤。
//
// 解析在后台进行（并发 4），不阻塞扫描与 SSE。边集合每次变化 version +1，
// 通过 onVersion 回调（防抖 300ms）通知调用方，server.js 据此推 SSE 'links'。
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fileURLToPath } = require('url');

const READ_LIMIT = 512 * 1024;
const PER_FILE_MAX = 200;
const GLOBAL_MAX = 200_000;
const CONCURRENCY = 4;
const SAVE_DEBOUNCE_MS = 2000;
const EMIT_DEBOUNCE_MS = 300;
const CACHE_VERSION = 1;

function isParsable(p) {
  return /\.(md|markdown|html?)$/i.test(p);
}
function kindOf(p) {
  return /\.(md|markdown)$/i.test(p) ? 'md' : 'html';
}

// ---------- 纯函数：从文本里抽出原始 href ----------

// 去掉围栏代码块（``` / ~~~，允许缩进 ≤3）与行内代码（`…` / ``…``）。
// 被去掉的部分换成空格而不是删除，避免把两侧的文字拼成一条假链接。
function stripMdCode(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let fence = null;   // 当前围栏的开头字符串（如 ``` 或 ~~~~）
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      out.push('');
      continue;
    }
    if (m) { fence = m[1]; out.push(''); continue; }
    out.push(line);
  }
  // 行内代码：反引号串长度要配对
  return out.join('\n').replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (s) => ' '.repeat(s.length));
}

function extractMdHrefs(text) {
  const src = stripMdCode(text);
  const hrefs = [];
  // 内联：[text](href "title")；href 可以是 <带空格的路径>。图片 ![..](..) 不算引用
  const inline = /(!?)\[(?:[^\]\\\n]|\\.)*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  let m;
  while ((m = inline.exec(src)) !== null) {
    if (m[1] === '!') continue;
    hrefs.push(m[2]);
  }
  // 引用式定义：行首 [id]: href
  const ref = /^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:\s*(<[^>\n]*>|\S+)/gm;
  while ((m = ref.exec(src)) !== null) hrefs.push(m[1]);
  return hrefs.map(h => (h.startsWith('<') && h.endsWith('>') ? h.slice(1, -1) : h));
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'",
  }[e]));
}

function extractHtmlHrefs(text) {
  const hrefs = [];
  // 注释里的链接不算
  const src = String(text).replace(/<!--[\s\S]*?-->/g, ' ');
  const re = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const v = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    hrefs.push(decodeEntities(v));
  }
  return hrefs;
}

function extractHrefs(text, kind) {
  return kind === 'md' ? extractMdHrefs(text) : extractHtmlHrefs(text);
}

// href → 解析用的本地路径（未 realpath）。丢弃的返回 null。
function hrefToPath(href, srcPath) {
  let h = String(href || '').trim();
  if (!h || h.startsWith('#')) return null;
  let isFileUrl = false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h);
  if (scheme) {
    // 一个字母的"协议"其实是 Windows 盘符（C:\…），按本地路径处理
    if (scheme[1].length === 1) {
      // fallthrough
    } else if (scheme[1].toLowerCase() === 'file') {
      isFileUrl = true;
    } else {
      return null;   // http / https / mailto / data / javascript / ftp …
    }
  }
  if (h.startsWith('//')) return null;   // 协议相对地址 = 外链
  // 去 ?query 与 #hash
  const cut = h.search(/[?#]/);
  if (cut >= 0) h = h.slice(0, cut);
  if (!h) return null;
  if (isFileUrl) {
    try { return fileURLToPath(h); } catch { return null; }
  }
  let decoded;
  try { decoded = decodeURIComponent(h); } catch { return null; }
  if (!decoded) return null;
  return path.resolve(path.dirname(srcPath), decoded);
}

// ---------- 索引 ----------

/**
 * @param {object} opts
 * @param {string} opts.cacheDir   缓存目录（ATLAS_HOME/links）
 * @param {() => string[]} opts.getRoots  当前扫描根（索引用的路径写法）
 * @param {(abs: string) => boolean} opts.isIndexed  该路径是否在当前文件索引里
 * @param {(version: number) => void} [opts.onVersion]
 * @param {object} [opts.log]
 * @param {(abs: string, st: import('fs').Stats|null) => boolean} [opts.skip]
 *   返回 true 的文件不解析（iCloud 云端文件：读它会触发下载）。sync / update 时 st 为 null（按索引记录判），
 *   parseFile 里在 readHead 之前用刚拿到的 stat 再判一次（索引记录可能过期）
 */
function createLinkIndex(opts) {
  const { cacheDir, getRoots, isIndexed } = opts;
  const skip = typeof opts.skip === 'function' ? opts.skip : null;
  const onVersion = opts.onVersion || (() => {});
  const perFileMax = opts.perFileMax || PER_FILE_MAX;
  const globalMax = opts.globalMax || GLOBAL_MAX;
  const log = opts.log || console;
  const startDelayMs = opts.startDelayMs || 0;
  let startTimer = null;
  const cacheFile = path.join(cacheDir, 'index.json');

  const entries = new Map();   // src → { mtime, size, targets: string[], truncated }
  let version = 0;
  let ready = false;
  let warnedCorrupt = false;
  let saveTimer = null;
  let emitTimer = null;
  let dirty = false;
  const queue = [];
  const queued = new Set();
  let running = 0;
  let syncWaiters = [];
  let pendingSync = false;   // 首轮 sync 还没解析完

  // 启动时读缓存
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.v !== CACHE_VERSION || typeof data.entries !== 'object') throw new Error('bad shape');
    for (const [k, e] of Object.entries(data.entries)) {
      if (e && Array.isArray(e.targets)) {
        entries.set(k, { mtime: +e.mtime || 0, size: +e.size || 0, targets: e.targets.filter(t => typeof t === 'string'), truncated: !!e.truncated });
      }
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT' && !warnedCorrupt) {
      warnedCorrupt = true;
      log.warn('  ! 引用索引缓存已损坏，将全量重建:', e.message);
    }
    entries.clear();
  }

  function bump() {
    version++;
    if (emitTimer) return;
    emitTimer = setTimeout(() => { emitTimer = null; try { onVersion(version); } catch {} }, EMIT_DEBOUNCE_MS);
    if (emitTimer.unref) emitTimer.unref();
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, SAVE_DEBOUNCE_MS);
    if (saveTimer.unref) saveTimer.unref();
  }
  function saveNow() {
    if (!dirty) return;
    dirty = false;
    const out = { v: CACHE_VERSION, entries: {} };
    for (const [k, e] of entries) out.entries[k] = e;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = cacheFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, cacheFile);
    } catch (e) {
      log.warn('  ! 引用索引缓存写入失败:', e && e.message);
    }
  }

  // 根的 realpath 映射：[{ root, real }]，每轮解析开始时刷新一次
  let rootMap = [];
  function refreshRoots() {
    rootMap = (getRoots() || []).map((root) => {
      let real = root;
      try { real = fs.realpathSync(root); } catch {}
      return { root, real };
    });
  }
  function within(rel) { return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }
  // 真实路径 → 索引用的写法（扫描根内）；根外返回 null
  function toIndexPath(real) {
    for (const { root, real: rr } of rootMap) {
      const rel = path.relative(rr, real);
      if (within(rel)) return path.join(root, rel);
    }
    return null;
  }

  async function realOrNull(p) {
    try { return await fsp.realpath(p); } catch { return null; }
  }

  // 一个候选路径 → 索引写法的目标；目录尝试 index.html / README.md
  async function resolveCandidate(p) {
    const real = await realOrNull(p);
    if (!real) {
      // 不存在：先按字面映射（之后这个文件出现时，查询期过滤会自动接上）
      for (const { root } of rootMap) {
        if (within(path.relative(root, p))) return p;
      }
      return null;
    }
    let st;
    try { st = await fsp.stat(real); } catch { return null; }
    if (st.isDirectory()) {
      for (const name of ['index.html', 'README.md']) {
        const r2 = await realOrNull(path.join(real, name));
        if (r2) return toIndexPath(r2);
      }
      return null;
    }
    return toIndexPath(real);
  }

  async function readHead(p) {
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(READ_LIMIT);
      const { bytesRead } = await fh.read(buf, 0, READ_LIMIT, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  }

  async function parseFile(src) {
    const st = await fsp.stat(src);
    if (skip && skip(src, st)) {
      if (entries.delete(src)) scheduleSave();
      return false;
    }
    const prev = entries.get(src);
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) return false;
    const text = await readHead(src);
    const hrefs = extractHrefs(text, kindOf(src));
    const seen = new Set();
    const targets = [];
    let truncated = false;
    for (const h of hrefs) {
      const cand = hrefToPath(h, src);
      if (!cand) continue;
      const t = await resolveCandidate(cand);
      if (!t || t === src || seen.has(t)) continue;
      if (targets.length >= perFileMax) { truncated = true; break; }
      seen.add(t);
      targets.push(t);
    }
    const changed = !prev || prev.truncated !== truncated
      || prev.targets.length !== targets.length || prev.targets.some((t, i) => t !== targets[i]);
    entries.set(src, { mtime: st.mtimeMs, size: st.size, targets, truncated });
    scheduleSave();
    return changed;
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const src = queue.shift();
      queued.delete(src);
      running++;
      // setImmediate：给扫描 / SSE 让出事件循环
      setImmediate(async () => {
        try {
          const changed = await parseFile(src);
          if (changed) bump();
        } catch (e) {
          // 单个文件读失败（被删 / 无权限）：跳过，不影响其他文件
          if (entries.delete(src)) { scheduleSave(); bump(); }
          if (process.env.ATLAS_DEBUG) log.warn('  · 引用解析跳过', src, e && e.message);
        } finally {
          running--;
          pump();
          if (!running && !queue.length) drained();
        }
      });
    }
  }
  function drained() {
    if (pendingSync) {
      pendingSync = false;
      if (!ready) { ready = true; bump(); }
    }
    const w = syncWaiters; syncWaiters = [];
    for (const fn of w) fn();
  }
  function enqueue(src) {
    if (queued.has(src)) return;
    queued.add(src);
    queue.push(src);
  }

  // 扫描完成后调用：传入当前索引里的全部文档路径
  function sync(paths) {
    refreshRoots();
    const live = new Set();
    for (const p of paths) if (isParsable(p) && !(skip && skip(p, null))) live.add(p);
    let removed = false;
    for (const k of [...entries.keys()]) {
      if (!live.has(k)) { entries.delete(k); removed = true; }
    }
    if (removed) { scheduleSave(); bump(); }
    for (const p of live) enqueue(p);
    pendingSync = true;
    if (!queue.length && !running) { drained(); return; }
    // 启动静默期（opts.startDelayMs，数字或返回数字的函数）：首轮解析往后推，别和窗口启动抢 CPU / I/O
    const delay = typeof startDelayMs === 'function' ? +startDelayMs() : +startDelayMs;
    if (delay > 0 && !startTimer) {
      startTimer = setTimeout(() => { startTimer = null; pump(); }, delay);
      if (startTimer.unref) startTimer.unref();
      return;
    }
    if (!startTimer) pump();
  }

  // watcher add / change：只重解析这一个文件（内容没变的不算变化）。
  // isNew：这个路径刚进索引——它可能让别人指向它的边生效，算一次变化
  function update(p, isNew) {
    if (!rootMap.length) refreshRoots();
    if (isNew) bump();
    if (!isParsable(p)) return;
    if (skip && skip(p, null)) return;
    enqueue(p);
    if (!startTimer) pump();   // 静默期内只排队，到点和首轮一起处理
  }
  function remove(p) {
    if (entries.delete(p)) scheduleSave();
    bump();
  }

  // 查询：按当前索引过滤；下标对齐 paths（只含参与连线的端点）
  function snapshot() {
    const idx = new Map();
    const paths = [];
    const edges = [];
    let truncated = false;
    const id = (p) => {
      let i = idx.get(p);
      if (i === undefined) { i = paths.length; idx.set(p, i); paths.push(p); }
      return i;
    };
    outer:
    for (const [src, e] of entries) {
      if (e.truncated) truncated = true;
      if (!e.targets.length || !isIndexed(src)) continue;
      for (const t of e.targets) {
        if (!isIndexed(t)) continue;
        if (edges.length >= globalMax) { truncated = true; break outer; }
        edges.push([id(src), id(t)]);
      }
    }
    return { version, truncated, edges, paths };
  }

  // 测试用：等当前排队的解析全部完成
  function whenIdle() {
    if (!queue.length && !running) return Promise.resolve();
    return new Promise((r) => syncWaiters.push(r));
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
  }

  return {
    sync, update, remove, snapshot, whenIdle, flush,
    isReady: () => ready,
    get version() { return version; },
  };
}

module.exports = {
  createLinkIndex,
  extractHrefs,
  extractMdHrefs,
  extractHtmlHrefs,
  stripMdCode,
  hrefToPath,
  PER_FILE_MAX,
  GLOBAL_MAX,
};
