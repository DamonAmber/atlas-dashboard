// 真实缩略图：用本机 Chromium 系浏览器 `--screenshot` 给文档截一张 640×400 的封面。
//
// 安全口径（AI 写的 HTML 必须碰不到 Atlas 接口）：
//   - 只用 file:// 打开源文件（或 Atlas 生成的临时渲染页），绝不走 http://127.0.0.1:PORT/raw/…
//   - OFFLINE_ARGS 断网（含 loopback 与 WebRTC UDP）
//   - 不加 --no-sandbox（仅 Linux root 下 Chrome 拒绝启动时才加）；不加 --allow-file-access-from-files
//   - 每次一个全新的临时 user-data-dir，结束即删；硬超时 15 秒 SIGKILL
//   - 引用 CDN 脚本 / 样式的 HTML 不截（remote-deps），前端保留生成式封面
//
// 缓存：<cacheDir>/index.json + <key>.png；key = sha1(RENDER_VER\0abs\0mtimeMs\0size\0normTheme).slice(0,16)
// 队列：内存、按 normTheme|path 去重、后进先出、上限 64、并发 1，经 chromium.runExclusive(low)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

// 截图参数或渲染器有变化时手动递增，整体失效旧缓存
// 2：截图视口从 1280×800@0.5 改成 800×500@0.8（同样产出 640×400，但内容放大 1.6 倍），旧缓存作废
// 3：MD 缩略图的渲染页不再带目录栏 / 宽度胶囊（800 宽下目录浮层盖住标题），旧的 MD 封面作废
const RENDER_VER = 3;

const MAX_ENTRIES = 3000;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const MAX_PNG_BYTES = 1.5 * 1024 * 1024;
const QUEUE_MAX = 64;
const INDEX_WRITE_DEBOUNCE_MS = 2000;
const SWEEP_EVERY_WRITES = 50;
const MAX_FAILS_PER_MTIME = 2;
const SPAWN_FAIL_TRIP = 5;
const CIRCUIT_OPEN_MS = 10 * 60 * 1000;
const BUSY_RETRY_MS = 5000;
const HARD_TIMEOUT_MS = 15_000;
const REMOTE_SCAN_BYTES = 256 * 1024;

function isHtmlPath(p) {
  const l = String(p).toLowerCase();
  return l.endsWith('.html') || l.endsWith('.htm');
}

// HTML 不随外壳主题变化，只截一份；其它类型的渲染页随主题变化，各存一份。
// '-' 只是服务端内部的缓存键，从不出现在接口上。
function normTheme(absPath, theme) {
  return isHtmlPath(absPath) ? '-' : theme;
}

function cacheKey(absPath, mtimeMs, size, nt) {
  return crypto.createHash('sha1')
    .update(`${RENDER_VER}\0${absPath}\0${mtimeMs}\0${size}\0${nt}`)
    .digest('hex')
    .slice(0, 16);
}

// 远程依赖：<script src="https://…"> / <script src=//cdn…> / <link rel=stylesheet href="https://…">
// （以及 href 写在 rel 前面的对称写法）。正文里的 https:// 文字、<a href>、相对路径脚本都不算。
const REMOTE_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i;
const REMOTE_LINK_RE = /<link\b[^>]*\brel\s*=\s*["']?stylesheet[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i;
const REMOTE_LINK_REV_RE = /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\/[^>]*\brel\s*=\s*["']?stylesheet/i;
function detectRemoteDeps(head) {
  const s = String(head || '');
  return REMOTE_SCRIPT_RE.test(s) || REMOTE_LINK_RE.test(s) || REMOTE_LINK_REV_RE.test(s);
}

function readHead(absPath, bytes = REMOTE_SCAN_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

// PNG 写完的判据：尾部出现 IEND 块
function readPngState(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size < 32) return { size: stat.size, complete: false };
    const len = Math.min(32, stat.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, stat.size - len);
    return { size: stat.size, complete: buf.includes('IEND') };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// 截图参数（§3b）。不加 --no-sandbox：缩略图要执行 AI 写的脚本，保留 Chrome 自身的进程沙箱。
// Linux 下以 root 运行时 Chrome 拒绝在沙箱里启动，只有这时才加。
function buildCaptureArgs({ profileDir, outPath, htmlUrl, offlineArgs }) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-dev-shm-usage',
    `--user-data-dir=${profileDir}`,
    ...offlineArgs,
    // 800×500 CSS 视口（"首屏上部"），0.8 倍缩放 → 640×400 PNG。以前按 1280 宽整页缩到 0.5，
    // 封面 212px 宽里 14px 正文只剩约 2px、居中定宽页两侧大片白边（client-fix §12）
    '--window-size=800,500',
    '--force-device-scale-factor=0.8',
    '--virtual-time-budget=3000',
    `--screenshot=${outPath}`,
  ];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  args.push(htmlUrl);
  return args;
}

function fileUrl(absPath) {
  let p = absPath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return 'file://' + encodeURI(p).replace(/#/g, '%23');
}

function createThumbnailer(opts = {}) {
  const {
    cacheDir,
    chromium,
    renderSource,
    log = console,
    onEvent = () => {},
    isBusy = () => false,
    isKnownPath = null,          // (abs) => true | false | null（null = 索引还没建好，不判断）
    disabled = false,
    stat = (p) => fs.statSync(p),
    now = () => Date.now(),
    maxEntries = MAX_ENTRIES,
    maxBytes = MAX_TOTAL_BYTES,
    queueMax = QUEUE_MAX,
    busyRetryMs = BUSY_RETRY_MS,
    hardTimeoutMs = HARD_TIMEOUT_MS,
    indexWriteDebounceMs = INDEX_WRITE_DEBOUNCE_MS,
    // async (abs) => null | 'cloud' | 'cloud-deps' | 'deps-unverified'：file:// 渲染之前的依赖检查
    // （iCloud：源文件或它引用的资源还在云端，截图会触发下载）。非 null 时直接以该状态结束
    checkSource = null,
  } = opts;
  const spawnFn = (chromium && chromium.spawn) || childProcess.spawn;
  const indexPath = path.join(cacheDir, 'index.json');

  // ---------- index ----------
  let index = { v: 1, entries: {} };
  let corruptWarned = false;
  function loadIndex() {
    try {
      const raw = fs.readFileSync(indexPath, 'utf8');
      const j = JSON.parse(raw);
      if (!j || j.v !== 1 || !j.entries || typeof j.entries !== 'object') throw new Error('bad shape');
      index = { v: 1, entries: j.entries };
    } catch (e) {
      index = { v: 1, entries: {} };
      if (e && e.code === 'ENOENT') return;
      if (!corruptWarned) {
        corruptWarned = true;
        try { log.warn('  ! 缩略图缓存 index.json 无法解析，按空缓存重新开始:', e && e.message); } catch {}
      }
    }
  }
  let writeTimer = null;
  function writeIndexNow() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = indexPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(index));
      fs.renameSync(tmp, indexPath);
    } catch (e) {
      try { log.warn('  ! 写缩略图缓存索引失败:', e && e.message); } catch {}
    }
  }
  function scheduleIndexWrite() {
    if (writeTimer) return;
    writeTimer = setTimeout(writeIndexNow, indexWriteDebounceMs);
    if (writeTimer.unref) writeTimer.unref();
  }
  const pngPath = (key) => path.join(cacheDir, key + '.png');
  function removePng(key) {
    if (!key) return;
    try { fs.unlinkSync(pngPath(key)); } catch {}
  }

  // ---------- 可用性 / 熔断 ----------
  let spawnFails = 0;
  let circuitUntil = 0;
  function status() {
    if (disabled) return { available: false, browser: null, reason: 'disabled' };
    if (circuitUntil && now() < circuitUntil) {
      const b = chromium.findChromium();
      return { available: false, browser: b ? b.name : null, reason: 'circuit-open' };
    }
    const b = chromium && chromium.findChromium();
    if (!b) return { available: false, browser: null, reason: 'no-chromium' };
    return { available: true, browser: b.name };
  }

  // ---------- 队列 ----------
  // 条目：{ id, abs, nt, requestedThemes:Set }；数组尾部 = 最新（LIFO 从尾部取）
  const queue = [];
  const queuedById = new Map();
  let running = null;          // 正在截的条目
  let busyTimer = null;

  function emitFor(item, status, k) {
    for (const theme of item.requestedThemes) {
      const e = { path: item.abs, theme, status };
      if (k) e.k = k;
      try { onEvent(e); } catch {}
    }
  }

  function enqueue(abs, nt, theme) {
    const id = `${nt}|${abs}`;
    if (running && running.id === id) { running.requestedThemes.add(theme); return; }
    let item = queuedById.get(id);
    if (item) {
      item.requestedThemes.add(theme);
      // 移到队尾（最近一次请求代表用户此刻正看着的东西）
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
      queue.push(item);
    } else {
      item = { id, abs, nt, requestedThemes: new Set([theme]), attempts: 0 };
      queuedById.set(id, item);
      queue.push(item);
      while (queue.length > queueMax) {
        const old = queue.shift();
        queuedById.delete(old.id);
        emitFor(old, 'dropped');
      }
    }
    pump();
  }

  function pump() {
    if (running || !queue.length) return;
    if (!status().available) {
      // 不可用：剩下的全部挤出，让前端回到"从未请求过"
      while (queue.length) {
        const it = queue.pop();
        queuedById.delete(it.id);
        emitFor(it, 'dropped');
      }
      return;
    }
    let busy = false;
    try { busy = !!isBusy(); } catch {}
    if (busy) {
      if (!busyTimer) {
        busyTimer = setTimeout(() => { busyTimer = null; pump(); }, busyRetryMs);
        if (busyTimer.unref) busyTimer.unref();
      }
      return;
    }
    const item = queue.pop();
    queuedById.delete(item.id);
    running = item;
    chromium.runExclusive((ctx) => captureItem(item, ctx), { priority: 'low' })
      .catch((e) => { try { log.warn('  ! 缩略图任务异常:', e && e.message); } catch {} })
      .then(() => {
        running = null;
        pump();
      });
  }

  // ---------- 单张截图 ----------
  let writesSinceSweep = 0;
  let activeCapture = null;    // { child, profileDir, cleanupSrc }：进程退出时据此收尾

  function recordFailure(item, st, failStatus, final) {
    const id = item.id;
    const e = index.entries[id] || { key: null, mtime: 0, size: 0, bytes: 0, at: 0, lastUsed: now(), status: 'none', fail: 0 };
    const sameMtime = e.failMtime === st.mtimeMs && e.failSize === st.size;
    e.fail = (sameMtime ? (e.fail || 0) : 0) + 1;
    e.failMtime = st.mtimeMs;
    e.failSize = st.size;
    if (final || e.fail >= MAX_FAILS_PER_MTIME) e.failStatus = failStatus;
    else delete e.failStatus;
    if (!e.key) e.status = failStatus;
    index.entries[id] = e;
    scheduleIndexWrite();
    return !!e.failStatus;
  }

  async function captureItem(item, ctx) {
    let st;
    try { st = stat(item.abs); } catch { return; }   // 源文件没了：静默放弃
    const theme = item.nt === '-' ? [...item.requestedThemes][0] : item.nt;

    if (typeof checkSource === 'function') {
      let cs = null;
      try { cs = await checkSource(item.abs); } catch (e) {
        // fail-closed：检查本身出错时按「无法确认」处理，绝不继续渲染
        cs = 'deps-unverified';
        try { log.warn('  ! 缩略图依赖检查失败，按无法确认处理:', item.abs, e && (e.code || e.message)); } catch {}
      }
      // 不 recordFailure、不重排：这不是渲染失败，下次请求时重新检查（文件可能已下载）
      if (cs) { emitFor(item, cs); return; }
    }

    let src;
    try {
      src = await renderSource(item.abs, theme);
    } catch (e) {
      src = { error: 'failed', message: e && e.message };
    }
    if (!src || src.error) {
      const reason = src && src.error === 'too-large' ? 'too-large' : 'failed';
      if (reason === 'failed') { try { log.warn('  ! 缩略图渲染失败:', item.abs, src && src.message || ''); } catch {} }
      const final = recordFailure(item, st, reason, reason === 'too-large');
      if (final) emitFor(item, reason);
      else requeueForRetry(item);
      return;
    }
    const cleanupSrc = () => { try { src.cleanup && src.cleanup(); } catch {} };

    if (isHtmlPath(item.abs) && detectRemoteDeps(readHead(item.abs))) {
      cleanupSrc();
      recordFailure(item, st, 'remote-deps', true);
      emitFor(item, 'remote-deps');
      return;
    }

    const browser = chromium.findChromium();
    if (!browser) { cleanupSrc(); emitFor(item, 'dropped'); return; }

    let profileDir;
    try { profileDir = chromium.makeProfileDir('atlas-thumb-'); } catch (e) {
      cleanupSrc();
      const final = recordFailure(item, st, 'failed', false);
      if (final) emitFor(item, 'failed'); else requeueForRetry(item);
      return;
    }
    const outPath = path.join(profileDir, 'thumb.png');
    const args = buildCaptureArgs({
      profileDir, outPath, htmlUrl: fileUrl(src.htmlPath), offlineArgs: chromium.OFFLINE_ARGS,
    });

    const result = await new Promise((resolve) => {
      let child;
      let settled = false;
      let spawned = false;
      try {
        child = spawnFn(browser.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) {
        return resolve({ spawnError: err });
      }
      ctx.track(child);
      activeCapture = { child, profileDir, cleanupSrc };
      if (child.stderr && child.stderr.on) child.stderr.on('data', () => { spawned = true; });
      if (child.on) child.on('spawn', () => { spawned = true; });
      let graceful = null;
      const watch = chromium.waitForStableFile(outPath, readPngState, { pollMs: 150, hardTimeoutMs });
      watch.then((r) => {
        if (r === 'stable') graceful = chromium.stopChild(child);
        else if (r === 'timeout') { try { child.kill('SIGKILL'); } catch {} }
      });
      const done = (r) => {
        if (settled) return;
        settled = true;
        watch.cancel();
        if (graceful) clearTimeout(graceful);
        resolve(r);
      };
      child.on('error', (err) => done({ spawnError: err, spawned }));
      child.on('exit', () => done({ exited: true }));
    });

    activeCapture = null;
    let buf = null;
    if (!result.spawnError) {
      try { buf = fs.readFileSync(outPath); } catch {}
    }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    cleanupSrc();

    if (ctx.preempted) return;    // 被 PDF 抢占：runExclusive 会把任务放回队首重跑

    if (result.spawnError && !result.spawned) {
      spawnFails++;
      if (spawnFails >= SPAWN_FAIL_TRIP) {
        circuitUntil = now() + CIRCUIT_OPEN_MS;
        spawnFails = 0;
        try { log.warn(`  ! 缩略图：连续 ${SPAWN_FAIL_TRIP} 次无法启动 ${browser.name}（${result.spawnError.message}），10 分钟内停用`); } catch {}
        emitFor(item, 'dropped');
        return;
      }
      requeueForRetry(item, true);
      return;
    }
    spawnFails = 0;

    const okPng = buf && buf.length > 0 && buf.subarray(Math.max(0, buf.length - 32)).includes('IEND');
    if (!okPng) {
      try { log.warn('  ! 缩略图截图失败（空产物或超时）:', item.abs); } catch {}
      const final = recordFailure(item, st, 'failed', false);
      if (final) emitFor(item, 'failed'); else requeueForRetry(item);
      return;
    }
    if (buf.length > MAX_PNG_BYTES) {
      recordFailure(item, st, 'too-large', true);
      emitFor(item, 'too-large');
      return;
    }

    const key = cacheKey(item.abs, st.mtimeMs, st.size, item.nt);
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = pngPath(key) + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, pngPath(key));
    } catch (e) {
      try { log.warn('  ! 写缩略图缓存失败:', e && e.message); } catch {}
      const final = recordFailure(item, st, 'failed', false);
      if (final) emitFor(item, 'failed'); else requeueForRetry(item);
      return;
    }
    const prev = index.entries[item.id];
    if (prev && prev.key && prev.key !== key) removePng(prev.key);
    const t = now();
    index.entries[item.id] = {
      key, mtime: st.mtimeMs, size: st.size, bytes: buf.length, at: t, lastUsed: t, status: 'ok', fail: 0,
    };
    enforceLimits();
    scheduleIndexWrite();
    if (++writesSinceSweep >= SWEEP_EVERY_WRITES) { writesSinceSweep = 0; sweep(); }
    emitFor(item, 'ready', key);
  }

  // 同 mtime 只重试 1 次：放到队首（最旧端），不抢用户正看着的新请求
  function requeueForRetry(item, keepAttempts) {
    if (!keepAttempts) item.attempts++;
    if (queuedById.has(item.id)) return;
    queuedById.set(item.id, item);
    queue.unshift(item);
    while (queue.length > queueMax) {
      const old = queue.shift();
      queuedById.delete(old.id);
      emitFor(old, 'dropped');
    }
  }

  function enforceLimits() {
    const ids = Object.keys(index.entries);
    let total = 0;
    for (const id of ids) total += index.entries[id].bytes || 0;
    if (ids.length <= maxEntries && total <= maxBytes) return;
    ids.sort((a, b) => (index.entries[a].lastUsed || 0) - (index.entries[b].lastUsed || 0));
    let count = ids.length;
    for (const id of ids) {
      if (count <= maxEntries && total <= maxBytes) break;
      const e = index.entries[id];
      removePng(e.key);
      total -= e.bytes || 0;
      delete index.entries[id];
      count--;
    }
  }

  // ---------- 清扫 ----------
  function sweep() {
    let changed = false;
    if (typeof isKnownPath === 'function') {
      for (const id of Object.keys(index.entries)) {
        const abs = id.slice(id.indexOf('|') + 1);
        let known = null;
        try { known = isKnownPath(abs); } catch {}
        if (known === false) {
          removePng(index.entries[id].key);
          delete index.entries[id];
          changed = true;
        }
      }
    }
    const keep = new Set();
    for (const e of Object.values(index.entries)) if (e.key) keep.add(e.key + '.png');
    let names = [];
    try { names = fs.readdirSync(cacheDir); } catch {}
    for (const n of names) {
      if (n === 'index.json') continue;
      if ((n.endsWith('.png') && !keep.has(n)) || n.endsWith('.png.tmp')) {
        try { fs.unlinkSync(path.join(cacheDir, n)); } catch {}
      }
    }
    if (changed) scheduleIndexWrite();
  }

  // ---------- 对外接口 ----------
  // 某路径在给定主题下的状态；needs=true 时顺手入队
  function statusOf(abs, theme, { enqueueIfNeeded = true } = {}) {
    if (!status().available) return { status: 'unavailable' };
    let st;
    try { st = stat(abs); } catch { return { status: 'invalid' }; }
    const nt = normTheme(abs, theme);
    const id = `${nt}|${abs}`;
    const e = index.entries[id];
    const curKey = cacheKey(abs, st.mtimeMs, st.size, nt);
    if (e && e.status === 'ok' && e.key === curKey) {
      e.lastUsed = now();
      scheduleIndexWrite();
      return { status: 'ready', k: e.key };
    }
    // 当前 mtime + size 下已有最终失败结论
    if (e && e.failStatus && e.failMtime === st.mtimeMs && e.failSize === st.size) {
      return { status: e.failStatus };
    }
    const hasOld = !!(e && e.key && e.status === 'ok');
    if (enqueueIfNeeded) enqueue(abs, nt, theme);
    if (hasOld) {
      e.lastUsed = now();
      return { status: 'stale', k: e.key };
    }
    return { status: 'queued' };
  }

  function request(paths, theme) {
    const available = status().available;
    const items = {};
    for (const p of paths) {
      if (!available) { items[p] = { status: 'unavailable' }; continue; }
      items[p] = statusOf(p, theme);
    }
    return { available, items };
  }

  // GET /api/thumb：k 与 index 中该条目一致才给文件路径
  function get(abs, theme, k) {
    const nt = normTheme(abs, theme);
    const e = index.entries[`${nt}|${abs}`];
    if (!e || e.status !== 'ok' || !e.key || e.key !== k) return null;
    const file = pngPath(e.key);
    if (!fs.existsSync(file)) return null;
    e.lastUsed = now();
    scheduleIndexWrite();
    return { file };
  }

  function invalidate(abs) {
    for (const nt of ['-', 'light', 'dark']) {
      const id = `${nt}|${abs}`;
      const e = index.entries[id];
      if (e) {
        removePng(e.key);
        delete index.entries[id];
        scheduleIndexWrite();
      }
      const q = queuedById.get(id);
      if (q) {
        queuedById.delete(id);
        const i = queue.indexOf(q);
        if (i >= 0) queue.splice(i, 1);
      }
    }
  }

  // 服务退出时调用：正在截的那张直接 SIGKILL（不收的话 Chrome 会变成孤儿进程一直挂着），
  // 同步删掉临时 profile 与渲染页，并把防抖中的 index 落盘
  function shutdown() {
    const a = activeCapture;
    activeCapture = null;
    if (a) {
      try { a.child.kill('SIGKILL'); } catch {}
      try { fs.rmSync(a.profileDir, { recursive: true, force: true }); } catch {}
      try { a.cleanupSrc(); } catch {}
    }
    if (writeTimer) writeIndexNow();
  }

  // 启动：读 index + 清扫一次孤儿
  if (!disabled) {
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
    loadIndex();
    sweep();
  }

  return {
    get,
    request,
    invalidate,
    sweep,
    status,
    flush: () => { if (writeTimer) writeIndexNow(); },
    shutdown,
    hasCheckSource: () => typeof checkSource === 'function',
    // 测试 / 排查用
    _debug: {
      queue: () => queue.map(q => ({ id: q.id, themes: [...q.requestedThemes] })),
      running: () => (running ? running.id : null),
      index: () => index,
    },
  };
}

module.exports = {
  createThumbnailer,
  normTheme,
  cacheKey,
  detectRemoteDeps,
  buildCaptureArgs,
  readPngState,
  pngSize,
  isHtmlPath,
  RENDER_VER,
  MAX_PNG_BYTES,
  QUEUE_MAX,
};
