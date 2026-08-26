// 目录树监听器：优先用系统的递归通知，回退到 chokidar
//
// ## 为什么不直接用 chokidar
//
// chokidar 4 起移除了 fsevents 依赖，改成**逐目录**调 `fs.watch`。在 macOS 上
// 每一个 watch 都要占一个 kqueue fd，于是 fd 用量正比于目录数量：
//
//   实测监听 ~/Documents/AIProjects（3598 个目录）→ 进程 fd 净增 10553 个
//
// 而 Node 进程的 RLIMIT_NOFILE 是 10240。一旦越过这条线，**进程里所有 spawn
// 都会失败并报 EBADF**——不是文件读写失败，是连子进程都起不来：
//   · 导出 PDF（spawn chromium）直接报错
//   · 「在访达中显示」、自升级（spawn open / npm）时好时坏
//     （取决于那一刻能不能拿到低号 fd，所以症状是概率性的、极难排查）
//
// 用探针精确量过这条线：持有 10200 个 fd 时 spawn 正常，10240 起必定 EBADF。
// 提高 shell 的 `ulimit -n` 没用（试过 1048575，同样在 10240 断），因为限制来自
// Node 自己为进程设定的 RLIMIT_NOFILE。
//
// ## 现在的做法
//
// `fs.watch(root, { recursive: true })` 把递归交给操作系统（macOS 走 FSEvents、
// Windows 走 ReadDirectoryChangesW），**整棵树只占 0 个额外 fd**（实测净增 0，
// 且此时 spawn 正常）。
//
// ## 平台差异（重要，别误以为哪里都省 fd）
//
//   · macOS / Windows：系统原生就支持递归通知，fd ≈ 0。**这是本次修复的主战场**。
//   · Linux：libuv 的 inotify 不支持递归，Node 是在 JS 层自己递归建 watch 的
//     （v20.13+），所以 **fd 占用仍然正比于目录数**，和 chokidar 没有区别。
//     好在 Linux 那边这个问题本来就不尖锐：`ulimit -n` 真的能调大，
//     而 spawn 也没有 macOS 上那条 10240 的硬线。
//   · Linux + Node < 20 / 其它平台：没有 recursive，回退 chokidar，
//     行为与 0.18.x 完全一致——属于"和以前一样"而不是"更糟"。
//
// ## 原生后端要自己补齐的四件事
//
// chokidar 提供的这些语义，`fs.watch` 没有，都在这里实现：
//
//   1. **add / change / unlink 的区分**。macOS 上几乎所有事件的 eventType 都是
//      `rename`（连改内容也是），所以 eventType 完全不可信，一律靠 stat 判定。
//   2. **写入稳定期**（chokidar 的 awaitWriteFinish）。AI 流式写文件会连着触发
//      多次事件，直接 emit 会让上层读到半截内容。这里按路径去抖 + 两次 stat
//      采样一致才认为写完。
//   3. **ignored / depth 过滤**。原生递归监听没有这两个概念，且它会把
//      node_modules 之类的事件也送过来，所以过滤必须**在 stat 之前**、
//      只用字符串判断（npm install 时那是几万个事件）。
//   4. **整目录搬入的补偿**。`mv 一个已有目录进扫描根` 只会产生一个目录事件，
//      里面的文件没有单独事件（实测确认）。所以收到目录事件时要扫一遍它，
//      把没见过的文件补报出来。反过来删除整个目录时 FSEvents 会逐个报文件，
//      不需要特殊处理。
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// 能不能用原生递归监听。用实测而不是判断平台 + Node 版本号：
// 版本矩阵会变，而这个探针永远说的是这台机器上的真话。
function detectRecursiveSupport() {
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-watch-probe-'));
    const w = fs.watch(dir, { recursive: true });
    w.close();
    return true;
  } catch {
    return false;
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}

const RECURSIVE_SUPPORTED = detectRecursiveSupport();

// 递归是由系统内核提供的（fd ≈ 0），还是 Node 在 JS 层逐目录模拟的（fd 照旧）。
// 这个区分决定了"省 fd"这个收益在当前平台上到底成不成立——
// 测试里的 fd 断言、以及排查时的预期，都要看它而不是看 RECURSIVE_SUPPORTED。
const SYSTEM_RECURSIVE = RECURSIVE_SUPPORTED
  && (process.platform === 'darwin' || process.platform === 'win32');

const DEFAULT_STABILITY_MS = 300;
const DEFAULT_POLL_MS = 100;

class NativeTreeWatcher extends EventEmitter {
  /**
   * @param {string} root 监听根目录（绝对路径）
   * @param {object} opts
   * @param {(absPath: string) => boolean} opts.ignored 返回 true 即跳过
   * @param {number} opts.depth 最大子目录层数，语义与 server.js 的 walk() 一致
   * @param {(name: string) => boolean} opts.isDocPath 只关心的文件名判据（省下大量 stat）
   * @param {number} opts.stabilityThreshold 判定"写完了"的静默时长
   * @param {number} opts.pollInterval 静默后再确认一次的间隔
   */
  constructor(root, opts = {}) {
    super();
    this.root = path.resolve(root);
    this.ignored = typeof opts.ignored === 'function' ? opts.ignored : () => false;
    this.maxDepth = Number.isFinite(opts.depth) ? opts.depth : Infinity;
    this.isDocPath = typeof opts.isDocPath === 'function' ? opts.isDocPath : () => true;
    this.stabilityThreshold = opts.stabilityThreshold != null ? opts.stabilityThreshold : DEFAULT_STABILITY_MS;
    this.pollInterval = opts.pollInterval != null ? opts.pollInterval : DEFAULT_POLL_MS;

    this.known = new Map();     // absPath → { size, mtimeMs }：已知的文档文件
    this.timers = new Map();    // absPath → Timeout（去抖）
    this.samples = new Map();   // absPath → 上一次 stat 采样（稳定性比对）
    this.primed = false;        // 初始盘点是否完成
    this.closed = false;
    this.watcher = null;

    this._begin();
  }

  _begin() {
    // 先挂监听再盘点：反过来会漏掉盘点期间发生的变更
    try {
      this.watcher = fs.watch(this.root, { recursive: true, persistent: true });
      this.watcher.on('change', (eventType, filename) => this._onRaw(filename));
      this.watcher.on('error', (err) => this.emit('error', err));
    } catch (err) {
      // 构造函数里调用方还没 on('error')，延到下一个 tick
      setImmediate(() => this.emit('error', err));
    }
    this._prime();
  }

  // 初始盘点：把现有文件记进 known，但**不 emit**（等价于 chokidar 的 ignoreInitial）。
  // 它决定了后续能不能正确区分 add 与 change，见 _settle 里的说明。
  async _prime() {
    try {
      await this._walk(this.root, 0, (abs, stat) => {
        this.known.set(abs, { size: stat.size, mtimeMs: stat.mtimeMs });
      });
    } catch {}
    this.primed = true;
    this.emit('ready');
  }

  // rel 相对 root 的层数是否在 depth 之内。
  // 对齐 server.js 的 walk()：root 下的直属文件算第 0 层，
  // 所以 'a/b.md' 是第 1 层 —— 段数减一。
  _withinDepth(rel) {
    if (this.maxDepth === Infinity) return true;
    const segs = rel.split(/[\\/]+/).filter(Boolean);
    return (segs.length - 1) <= this.maxDepth;
  }

  // 逐段套用 ignored：原生递归监听送来的是整条相对路径，
  // 中间任意一段命中黑名单（node_modules / .git / 隐藏目录）都要整条丢掉
  _isIgnoredRel(rel) {
    const segs = rel.split(/[\\/]+/).filter(Boolean);
    let cur = this.root;
    for (const seg of segs) {
      cur = path.join(cur, seg);
      if (this.ignored(cur)) return true;
    }
    return false;
  }

  _onRaw(filename) {
    if (this.closed || !filename) return;
    const rel = String(filename);
    // macOS 偶尔会把 root 自己报上来
    if (!rel || rel === path.basename(this.root)) return;
    if (!this._withinDepth(rel)) return;
    if (this._isIgnoredRel(rel)) return;

    // 到这里为止只做了字符串判断，一次 stat 都没发。这很重要：
    // 一次 npm install 会在 node_modules 里产生几万个事件，
    // 虽然上面 ignored 已经拦掉了绝大部分，剩下的也不该逐个去打盘。
    const base = path.basename(rel);
    // 名字带扩展名但不是我们关心的类型 → 几乎必然是个无关文件，直接丢。
    // 不带点的当作"可能是目录"放过去（目录事件要用来做搬入补偿）。
    // 代价：名字里带点的目录（v1.2 这种）搬进来时不补偿，
    // 由 /api/state 那次全量重建兜住。
    if (base.includes('.') && !this.isDocPath(base)) return;

    this._schedule(path.resolve(this.root, rel), this.stabilityThreshold);
  }

  _schedule(abs, delay) {
    const prev = this.timers.get(abs);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(abs);
      this._settle(abs).catch(() => {});
    }, delay);
    if (t.unref) t.unref();
    this.timers.set(abs, t);
  }

  async _settle(abs) {
    if (this.closed) return;
    let st = null;
    try { st = await fsp.stat(abs); } catch {}

    if (!st) {
      this.samples.delete(abs);
      if (this.known.has(abs)) {
        this.known.delete(abs);
        this.emit('unlink', abs);
      }
      return;
    }

    if (st.isDirectory()) {
      this.samples.delete(abs);
      await this._scanDir(abs);
      return;
    }
    if (!st.isFile()) return;
    if (!this.isDocPath(path.basename(abs))) return;

    // 写入稳定期：两次采样一致才认为写完了。AI 流式写文件时前几拍的
    // size 一直在变，这时候 emit 出去，上层读到的是半截文档。
    const sample = { size: st.size, mtimeMs: st.mtimeMs };
    const prev = this.samples.get(abs);
    if (!prev || prev.size !== sample.size || prev.mtimeMs !== sample.mtimeMs) {
      this.samples.set(abs, sample);
      this._schedule(abs, this.pollInterval);
      return;
    }
    this.samples.delete(abs);

    const had = this.known.has(abs);
    this.known.set(abs, sample);
    // 盘点还没做完时一律报 change，不报 add。
    // 这个偏向是刻意的：上层只在 change 时清 store.seen（点亮未读红点），
    // 把 change 误报成 add 会让"AI 改过这篇"的红点不亮——那是功能失效；
    // 反过来把 add 报成 change 只是桌面通知的文案从"新文档"变成"文档已更新"，
    // 而清一个本来就不存在的 seen 记录是无害的空操作。
    this.emit(had || !this.primed ? 'change' : 'add', abs);
  }

  // 目录事件的补偿扫描：把这个目录里还没见过的文档塞进去抖队列。
  // 需要它的场景是「mv 一个已有目录进扫描根」——那只产生一个目录事件。
  //
  // 这里刻意**不直接 emit**，而是走 _schedule 让 _settle 去判定。原因：
  // 新建一个文件会同时产生「父目录事件」和「文件自己的事件」，如果这里直接
  // emit add、文件事件再走一遍 _settle，就会先报 add 再报 change ——
  // 上层会因此推两条 SSE，用户看到"新文档"和"文档已更新"两条桌面通知。
  // 统一进同一个 per-path 去抖队列之后，两条路径自然合并成一次判定。
  //
  // 已知文件直接跳过，连 stat 都不发：普通的新建文件也会触发本函数，
  // 而那个目录下可能有几百篇文档，逐个 stat 是白花的开销。
  async _scanDir(dir) {
    const rel = path.relative(this.root, dir);
    const depth = rel ? rel.split(/[\\/]+/).filter(Boolean).length : 0;
    await this._walk(dir, depth, (abs) => {
      if (this.known.has(abs)) return;
      this._schedule(abs, this.stabilityThreshold);
    }, false);
  }

  // 只读遍历。用 readdir 而不是给每个目录挂监听——这正是省下那一万个 fd 的地方。
  // needStat=false 时只列路径（补偿扫描用不到 stat）。
  async _walk(dir, depth, onFile, needStat = true) {
    if (this.closed) return;
    if (depth > this.maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (this.closed) return;
      const full = path.join(dir, entry.name);
      if (this.ignored(full)) continue;
      if (entry.isDirectory()) {
        await this._walk(full, depth + 1, onFile, needStat);
      } else if (entry.isFile() && this.isDocPath(entry.name)) {
        if (!needStat) { onFile(full, null); continue; }
        try {
          onFile(full, await fsp.stat(full));
        } catch {}
      }
    }
  }

  /** 与 chokidar 的 close() 对齐：返回 Promise */
  close() {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.samples.clear();
    this.known.clear();
    try { if (this.watcher) this.watcher.close(); } catch {}
    this.watcher = null;
    this.removeAllListeners();
    return Promise.resolve();
  }
}

// 回退实现：Linux + Node 18/19 走这条。行为与 0.18.x 完全一致，
// 包括它那个 fd 开销——在那些平台上 fs.watch 没有 recursive，没有更好的选择。
function createChokidarWatcher(root, opts = {}) {
  let chokidar;
  try {
    chokidar = require('chokidar');
  } catch (err) {
    // 这条路只有"没有 recursive 的平台"会走到，而那时它是必需依赖。
    // 报清楚原因，别让用户对着一个 MODULE_NOT_FOUND 猜。
    throw new Error(
      '这个平台不支持 fs.watch 的 recursive 选项（需要 macOS / Windows，或 Linux + Node 20+），'
      + '需要 chokidar 作为回退实现，但它没有安装：' + err.message,
    );
  }
  return chokidar.watch(root, {
    ignored: opts.ignored,
    ignoreInitial: true,
    depth: opts.depth,
    awaitWriteFinish: {
      stabilityThreshold: opts.stabilityThreshold != null ? opts.stabilityThreshold : DEFAULT_STABILITY_MS,
      pollInterval: opts.pollInterval != null ? opts.pollInterval : DEFAULT_POLL_MS,
    },
    persistent: true,
  });
}

/**
 * 建一个目录树监听器。事件与 chokidar 对齐：'add' | 'change' | 'unlink' | 'error'，
 * 回调参数都是绝对路径；close() 返回 Promise。
 */
function createWatcher(root, opts = {}) {
  if (RECURSIVE_SUPPORTED) return new NativeTreeWatcher(root, opts);
  return createChokidarWatcher(root, opts);
}

module.exports = {
  createWatcher,
  NativeTreeWatcher,
  /** 'native'（fs.watch recursive）| 'chokidar'（回退） */
  backend: RECURSIVE_SUPPORTED ? 'native' : 'chokidar',
  RECURSIVE_SUPPORTED,
  /** 递归是否由内核提供 —— 只有这时候才真的省 fd（macOS / Windows） */
  SYSTEM_RECURSIVE,
};
