// 本机 Chromium 系浏览器（Chrome / Edge / Brave / Arc / Chromium）的共用设施：
//   - 探测：chromiumCandidates() / findChromium()（结果缓存 60 秒）
//   - 临时 profile：makeProfileDir(prefix)
//   - 产物收尾：waitForStableFile() —— Chrome 写完产物不会自己退出，要我们轮询判断
//   - 收进程：stopChild() —— 先 SIGTERM，再 SIGKILL
//   - 全进程共享的单浏览器队列：runExclusive(job, { priority })
//     PDF 导出用 'high'，缩略图用 'low'。高优到达时若正在跑的是低优任务，
//     就 stopChild 掉它并把它放回队首——导出 PDF 最多等一个 SIGTERM 的时间。
//   - OFFLINE_ARGS：把全部 http(s)（含 loopback）导向不存在的代理 + 禁止 WebRTC 直连 UDP

const fs = require('fs');
const path = require('path');
const os = require('os');

// 候选路径——按用户体感优先级（Chrome 用得最多）
function chromiumCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      ['Google Chrome',    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Microsoft Edge',   '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave',            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Arc',              '/Applications/Arc.app/Contents/MacOS/Arc'],
      ['Chromium',         '/Applications/Chromium.app/Contents/MacOS/Chromium'],
      ['Vivaldi',          '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
    ];
  }
  if (process.platform === 'linux') {
    return [
      ['Google Chrome',    '/usr/bin/google-chrome'],
      ['Google Chrome',    '/usr/bin/google-chrome-stable'],
      ['Chromium',         '/usr/bin/chromium'],
      ['Chromium',         '/usr/bin/chromium-browser'],
      ['Microsoft Edge',   '/usr/bin/microsoft-edge'],
      ['Brave',            '/usr/bin/brave-browser'],
    ];
  }
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return [
      ['Google Chrome',  path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['Google Chrome',  path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['Google Chrome',  path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['Microsoft Edge', path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
      ['Microsoft Edge', path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
      ['Brave',          path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
    ];
  }
  return [];
}

// 结果缓存 60 秒：缩略图每次请求都要问"有没有浏览器"，不该每次 accessSync 一串路径。
// 找不到也缓存——用户装好浏览器后最多 60 秒被重新探测到。
const FIND_CACHE_MS = 60_000;
let _findCache = null;   // { at, value }
function findChromium() {
  const now = Date.now();
  if (_findCache && now - _findCache.at < FIND_CACHE_MS) return _findCache.value;
  let value = null;
  for (const [name, p] of chromiumCandidates()) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      value = { name, path: p };
      break;
    } catch {}
  }
  _findCache = { at: now, value };
  return value;
}

// 独立 user-data-dir：避免和用户当前正在跑的 Chrome 冲突
// （Chrome 单实例机制对 user-data-dir 加锁；不加 --user-data-dir 时 headless
// 会因检测到已有 Chrome 实例报 "Trying to load the allocator multiple times"）
function makeProfileDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 轮询产物，直到 readState(filePath) 报告 complete 且大小连续两拍不变。
// readState → { size, complete } | null（null = 还没创建 / 读不到）
// 返回 Promise<'stable' | 'timeout' | 'cancelled'>，附带 .cancel()。
// onAppear：产物第一次能读到时回调一次（PDF 用它发"正在写入"阶段）。
function waitForStableFile(filePath, readState, { pollMs = 150, hardTimeoutMs = 0, onAppear } = {}) {
  let lastSize = -1;
  let appeared = false;
  let settled = false;
  let poll = null;
  let hard = null;
  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  const finish = (r) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    clearTimeout(hard);
    resolveFn(r);
  };
  poll = setInterval(() => {
    const st = readState(filePath);
    if (!st) return;
    if (!appeared) {
      appeared = true;
      try { onAppear && onAppear(st); } catch {}
    }
    if (st.complete && st.size > 0 && st.size === lastSize) return finish('stable');
    lastSize = st.size;
  }, pollMs);
  if (hardTimeoutMs > 0) hard = setTimeout(() => finish('timeout'), hardTimeoutMs);
  promise.cancel = () => finish('cancelled');
  return promise;
}

// 先 SIGTERM 给它一个收尾的机会，没走就 SIGKILL。
// 走 SIGTERM 是为了让 Chrome 自己释放 user-data-dir 里的锁——虽然那是每次新建的临时
// 目录、我们随后就整个删掉，但强杀留下的半个 profile 偶尔会拖慢下一次启动。
const GRACEFUL_KILL_WAIT_MS = 1200;
function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return null;
  try { child.kill('SIGTERM'); } catch {}
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, GRACEFUL_KILL_WAIT_MS);
  if (t.unref) t.unref();
  return t;
}

// ---------- 全进程共享的单浏览器队列 ----------
// 快速连续 spawn 多个 chromium 会因为内部状态冲突全部失败；同时只允许一个跑。
// job(ctx) 返回 Promise。ctx.track(child) 登记正在跑的子进程（被抢占时据此收掉它）；
// ctx.preempted 为 true 表示被高优任务抢占——此时 job 的结果被丢弃，任务放回队首重跑。
const _queue = [];       // [{ job, priority, resolve, reject }]
let _running = null;     // { entry, ctx }

function _insertHigh(entry) {
  const idx = _queue.findIndex(e => e.priority !== 'high');
  if (idx < 0) _queue.push(entry); else _queue.splice(idx, 0, entry);
}

function runExclusive(job, { priority = 'high' } = {}) {
  const prio = priority === 'low' ? 'low' : 'high';
  return new Promise((resolve, reject) => {
    const entry = { job, priority: prio, resolve, reject };
    if (prio === 'high') {
      _insertHigh(entry);
      if (_running && _running.entry.priority === 'low' && !_running.ctx.preempted) {
        _running.ctx.preempted = true;
        if (_running.ctx.child) stopChild(_running.ctx.child);
      }
    } else {
      _queue.push(entry);
    }
    _pump();
  });
}

function _pump() {
  if (_running || !_queue.length) return;
  const entry = _queue.shift();
  const ctx = {
    preempted: false,
    child: null,
    track(child) {
      ctx.child = child;
      if (ctx.preempted) stopChild(child);   // 登记前就被抢占了：直接收掉
    },
  };
  _running = { entry, ctx };
  Promise.resolve()
    .then(() => entry.job(ctx))
    .then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    .then((r) => {
      _running = null;
      if (ctx.preempted) {
        // 放回低优任务的最前面（高优的都在它前面）
        const idx = _queue.findIndex(e => e.priority !== 'high');
        if (idx < 0) _queue.push(entry); else _queue.splice(idx, 0, entry);
      } else if (r.ok) {
        entry.resolve(r.value);
      } else {
        entry.reject(r.error);
      }
      _pump();
    });
}

// 断网参数：所有 http(s)（含 loopback，<-loopback> 取消默认的 loopback 直连）都走
// 一个不存在的代理；--proxy-server 不约束 WebRTC 的 UDP，再禁止非代理 UDP。
const OFFLINE_ARGS = Object.freeze([
  '--proxy-server=127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
]);

module.exports = {
  chromiumCandidates,
  findChromium,
  makeProfileDir,
  waitForStableFile,
  stopChild,
  runExclusive,
  OFFLINE_ARGS,
  GRACEFUL_KILL_WAIT_MS,
};
