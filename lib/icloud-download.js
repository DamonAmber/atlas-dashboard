// iCloud 下载任务队列（design §5.2）
//
// 下载手段只有两种，都不需要新依赖：
//   · `brctl download <real>`（系统支持时；本机 macOS 26 的 brctl 没有这个子命令）
//   · 读取回退：把 dataless 文件完整读一遍，系统就会把它取回本地。数据直接丢掉，只计字节。
//     占位文件（.x.md.icloud）没有原路径可读，只能靠 brctl。
//
// 路径校验不在这里做：路由先调 icloud.resolveDownloadTarget，把 {abs, real} 原样传进来。
// abs 是身份（去重 key、SSE path、isDataless 的第一个参数），real 是 I/O 目标。
//
// 所有 I/O 都可注入（execFile / createReadStream / stat / lstat / probe），单测在 Linux 上跑。
'use strict';

const REASON_MESSAGES = {
  unsupported: '当前系统不支持由 Atlas 下载此文件，可在访达中下载',
  'brctl-failed': '系统下载命令失败',
  'io-error': '读取失败，可能处于离线状态，或 iCloud 无法下载此文件',
  offline: '网络不可用，iCloud 下载失败',
  timeout: '下载超时',
  gone: '文件已不存在',
  permission: '没有读取权限',
  'not-materialized': '已读取，但系统仍报告此文件未下载',
  cancelled: '服务已退出，下载已取消',
};

function reasonOfErrno(code) {
  switch (code) {
    case 'ETIMEDOUT': case 'ENETUNREACH': case 'EHOSTUNREACH': case 'ENOTCONN': return 'offline';
    case 'ENOENT': return 'gone';
    case 'EPERM': case 'EACCES': return 'permission';
    default: return 'io-error';   // EIO 以及其它读失败
  }
}

// min(30 分钟, 120 秒 + size / 512KB 每秒)；size 未知时按 120 秒
function defaultHardTimeout(size) {
  const base = 120_000;
  if (!Number.isFinite(size) || size <= 0) return base;
  return Math.min(30 * 60_000, base + Math.ceil((size / (512 * 1024)) * 1000));
}

/**
 * @param {object} o
 * @param {Function} o.execFile           child_process.execFile 签名
 * @param {Function} o.createReadStream   fs.createReadStream 签名
 * @param {Function} o.stat               (p) => Promise<Stats>
 * @param {Function} o.lstat              (p) => Promise<Stats>
 * @param {Function} o.isDataless         (abs, st) => boolean
 * @param {Function} o.placeholderPath    icloud.placeholderPathFor
 * @param {Function} o.probe              () => Promise<capability>（只看 capability.brctl.download）
 * @param {Function} o.onUpdate           (item) => void：{path, phase, cloud, busy, reason?, message?}
 * @param {Function} o.onDone             async (abs) => void：完成后服务端更新索引
 * @param {Function} [o.hardTimeout]      (size) => ms（N11：自管计时器，到时 SIGKILL / destroy）
 * @returns {{ request, has, nudge, shutdown, _debug }}
 */
function createDownloader({
  execFile, createReadStream, stat, lstat, isDataless, placeholderPath, probe,
  onUpdate = () => {}, onDone = async () => {},
  concurrency = 2, queueMax = 8, pollMs = 500, settleMs = 10_000,
  hardTimeout = defaultHardTimeout, now = Date.now, log = console,
} = {}) {
  const queue = [];               // 排队中的任务（先进先出）
  const queued = new Map();       // abs → task
  const running = new Map();      // abs → task
  let closed = false;

  const debug = (...a) => {
    if (!process.env.ATLAS_DEBUG) return;
    try { (log.log || console.log).apply(log, a); } catch {}
  };

  function has(abs) { return running.has(abs) || queued.has(abs); }

  function emit(t, fields) {
    try { onUpdate({ path: t.abs, ...fields }); } catch {}
  }

  function addTimer(t, fn, ms) {
    const h = setTimeout(() => { t.timers.delete(h); fn(); }, Math.max(0, ms));
    t.timers.add(h);
    return h;
  }
  function clearTimer(t, h) {
    if (!h) return;
    clearTimeout(h);
    t.timers.delete(h);
  }

  function finalize(t) {
    t.finished = true;
    for (const h of t.timers) clearTimeout(h);
    t.timers.clear();
    t.wake = null;
    running.delete(t.abs);
    queued.delete(t.abs);
  }

  function fail(t, reason, code) {
    if (t.finished) return;
    finalize(t);
    if (reason !== 'cancelled') {
      try { log.warn('  ! iCloud 下载失败:', t.abs, reason, code || ''); } catch {}
    }
    emit(t, { phase: 'error', reason, message: REASON_MESSAGES[reason] || reason, cloud: t.kind, busy: false });
    pump();
  }

  async function succeed(t) {
    try { await onDone(t.abs); } catch (e) {
      try { log.warn('  ! iCloud 下载完成后更新索引失败:', t.abs, e && e.message); } catch {}
    }
    if (t.finished) return;
    finalize(t);
    debug('  · iCloud 下载完成', t.abs);
    emit(t, { phase: 'done', cloud: null, busy: false });
    pump();
  }

  function runBrctl(t, ms) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const end = (r) => {
        if (done) return;
        done = true;
        clearTimer(t, timer);
        t.child = null;
        resolve(r);
      };
      let child = null;
      try {
        // 参数是数组、没有 shell：路径里有空格 / 引号 / $ 都不会被解释
        child = execFile('brctl', ['download', t.real], { timeout: ms, windowsHide: true }, (err) => {
          if (!err) return end({ ok: true });
          end({ ok: false, timeout: !!(err.killed && err.signal), code: err.code });
        });
      } catch (e) {
        end({ ok: false, code: e && e.code });
        return;
      }
      if (done) return;
      t.child = child || null;
      // N11：不依赖 execFile 自己的 timeout（它只发 SIGTERM，子进程可能不理），到时直接 SIGKILL
      timer = addTimer(t, () => {
        const c = t.child;
        end({ ok: false, timeout: true, code: 'ETIMEDOUT' });
        try { if (c) c.kill('SIGKILL'); } catch {}
      }, ms);
    });
  }

  function runRead(t, ms) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      let errored = false;
      let stream = null;
      const end = (r) => {
        if (done) return;
        done = true;
        clearTimer(t, timer);
        t.stream = null;
        resolve(r);
      };
      try {
        stream = createReadStream(t.real, { highWaterMark: 64 * 1024 });
      } catch (e) {
        end({ ok: false, reason: reasonOfErrno(e && e.code), code: e && e.code });
        return;
      }
      t.stream = stream;
      let bytes = 0;
      // 只计字节，数据直接丢掉
      stream.on('data', (c) => { bytes += c ? c.length : 0; });
      stream.on('error', (e) => {
        errored = true;
        end({ ok: false, reason: reasonOfErrno(e && e.code), code: e && e.code });
      });
      stream.on('close', () => { if (!errored) end({ ok: true, bytes }); });
      timer = addTimer(t, () => {
        end({ ok: false, reason: 'timeout' });
        try { stream.destroy(); } catch {}
      }, ms);
    });
  }

  // 完成判定（FR-5.4）：'done' | 'gone' | null（还没好）
  async function checkDone(t) {
    let st;
    try { st = await stat(t.real); } catch (e) {
      if (t.kind === 'dataless' && e && e.code === 'ENOENT') return 'gone';
      return null;   // 占位：原路径还没出现
    }
    if (!st || typeof st.isFile !== 'function' || !st.isFile()) return null;
    if (isDataless(t.abs, st)) return null;
    if (t.kind === 'placeholder') {
      try { await lstat(placeholderPath(t.real)); return null; } catch (e) {
        if (!e || e.code !== 'ENOENT') return null;
      }
    }
    return 'done';
  }

  function wait(t, ms) {
    return new Promise((resolve) => {
      if (t.nudged) { t.nudged = false; resolve(); return; }
      const h = addTimer(t, () => { t.wake = null; resolve(); }, ms);
      t.wake = () => { clearTimer(t, h); t.wake = null; resolve(); };
    });
  }

  async function settle(t, limit) {
    const start = now();
    for (;;) {
      if (t.finished) return;
      const r = await checkDone(t);
      if (t.finished) return;
      if (r === 'done') return succeed(t);
      if (r === 'gone') return fail(t, 'gone', 'ENOENT');
      const elapsed = now() - start;
      if (elapsed >= limit) return fail(t, 'not-materialized');
      await wait(t, Math.min(pollMs, Math.max(1, limit - elapsed)));
    }
  }

  async function run(t) {
    debug('  · iCloud 下载开始', t.abs, t.kind);
    emit(t, { phase: 'started', cloud: t.kind, busy: true });
    let cap = null;
    try { cap = probe ? await probe() : null; } catch {}
    if (t.finished) return;
    const ms = Math.max(1, Number(hardTimeout(t.size)) || 120_000);
    const brctlOk = !!(cap && cap.brctl && cap.brctl.download);
    if (brctlOk) {
      const r = await runBrctl(t, ms);
      if (t.finished) return;
      if (r.ok) return settle(t, ms);   // brctl 可能先返回、后台继续下：最长等 hardTimeout
      if (t.kind === 'placeholder') return fail(t, r.timeout ? 'timeout' : 'brctl-failed', r.code);
      // dataless：转读取回退
    } else if (t.kind === 'placeholder') {
      return fail(t, 'unsupported');
    }
    const rr = await runRead(t, ms);
    if (t.finished) return;
    if (!rr.ok) return fail(t, rr.reason, rr.code);
    return settle(t, settleMs);
  }

  function pump() {
    while (!closed && running.size < concurrency && queue.length) {
      const t = queue.shift();
      queued.delete(t.abs);
      running.set(t.abs, t);
      run(t).catch((e) => fail(t, 'io-error', e && e.code));
    }
  }

  /**
   * @param {{abs:string, real:string, kind:'dataless'|'placeholder', size?:number}} req
   * @returns {{status:'accepted'|'deduped'|'busy'}}
   */
  function request({ abs, real, kind, size } = {}) {
    if (kind !== 'dataless' && kind !== 'placeholder') {
      throw new TypeError(`downloader.request: kind 只接受 'dataless' | 'placeholder'，收到 ${JSON.stringify(kind)}`);
    }
    if (typeof abs !== 'string' || !abs || typeof real !== 'string' || !real) {
      throw new TypeError('downloader.request: abs / real 必须是非空字符串');
    }
    if (closed) return { status: 'busy' };
    if (has(abs)) return { status: 'deduped' };
    if (running.size >= concurrency && queue.length >= queueMax) return { status: 'busy' };
    const t = {
      abs, real, kind, size: Number.isFinite(size) ? size : null,
      child: null, stream: null, timers: new Set(), wake: null, nudged: false, finished: false,
    };
    queue.push(t);
    queued.set(abs, t);
    pump();
    return { status: 'accepted' };
  }

  // watcher 事件触发：让下一次完成判定马上执行
  function nudge(abs) {
    const t = running.get(abs);
    if (!t) return;
    if (t.wake) t.wake(); else t.nudged = true;
  }

  function shutdown() {
    if (closed) return;
    closed = true;
    const all = [...running.values(), ...queue];
    queue.length = 0;
    for (const t of all) {
      const s = t.stream;
      const c = t.child;
      t.stream = null;
      t.child = null;
      if (s) { try { s.destroy(); } catch {} }
      if (c) { try { c.kill('SIGKILL'); } catch {} }
      fail(t, 'cancelled');
    }
  }

  return {
    request,
    has,
    nudge,
    shutdown,
    _debug: {
      running: () => [...running.keys()],
      queued: () => queue.map((t) => t.abs),
    },
  };
}

module.exports = {
  createDownloader,
  defaultHardTimeout,
  reasonOfErrno,
  REASON_MESSAGES,
};
