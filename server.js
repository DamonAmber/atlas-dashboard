const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const chokidar = require('chokidar');
const { EventEmitter } = require('events');
const userPaths = require('./lib/paths');
const updateCheck = require('./lib/update-check');
const pkg = require('./package.json');

// 路径注入：CLI（bin/atlas.js）通过环境变量传，开发模式落到默认 ~/.atlas/
const ROOT_DIR = __dirname;
const CONFIG_PATH = process.env.ATLAS_CONFIG_PATH || userPaths.configPath();
const STORE_PATH = process.env.ATLAS_STORE_PATH || userPaths.storePath();
const PUBLIC_DIR = process.env.ATLAS_PUBLIC_DIR || path.join(ROOT_DIR, 'public');
const DATA_DIR = path.dirname(STORE_PATH);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`\n  ✗ 找不到配置文件 ${CONFIG_PATH}`);
  console.error(`    请先运行 'atlas init' 完成首次配置。\n`);
  process.exit(1);
}

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
// 端口优先级：CLI 环境变量 > config 文件 > 4321
const PORT = parseInt(process.env.ATLAS_PORT, 10) || config.port || 4321;

function loadConfig() {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return config;
}
function saveConfig(next) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  config = next;
}
function getScanRoots() {
  return (config.scanRoots || []).map(p => path.resolve(p));
}
function getIgnoreSet() {
  return new Set(config.ignore || []);
}
function getMaxDepth() {
  return config.maxDepth || 6;
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return { tree: [], seen: {}, aliases: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return migrateStore(raw);
  } catch (e) {
    console.error('store.json 损坏，使用空 store:', e.message);
    return { tree: [], seen: {}, aliases: {} };
  }
}

function migrateStore(raw) {
  if (Array.isArray(raw.tree)) {
    raw.seen = raw.seen || {};
    raw.aliases = raw.aliases || {};
    raw.recent = Array.isArray(raw.recent) ? raw.recent : [];
    return raw;
  }
  // 旧版 {folders: [{id,name,files:[]}], seen}
  if (Array.isArray(raw.folders)) {
    const tree = raw.folders.map(f => ({
      id: f.id,
      type: 'folder',
      name: f.name,
      collapsed: false,
      children: (f.files || []).map(p => ({ type: 'file', path: p })),
    }));
    return { tree, seen: raw.seen || {}, aliases: raw.aliases || {}, recent: [] };
  }
  return { tree: [], seen: {}, aliases: {}, recent: [] };
}

const RECENT_MAX = 10;
function pushRecent(store, filePath) {
  const list = (store.recent || []).filter(p => p !== filePath);
  list.unshift(filePath);
  store.recent = list.slice(0, RECENT_MAX);
}

function saveStore(store) {
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH);
}

async function scanHtmlFiles() {
  const results = [];
  const ignore = getIgnoreSet();
  const maxDepth = getMaxDepth();
  for (const root of getScanRoots()) {
    if (!fs.existsSync(root)) continue;
    await walk(root, root, 0, results, ignore, maxDepth);
  }
  return results;
}

async function walk(currentDir, scanRoot, depth, results, ignore, maxDepth) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await fsp.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (ignore.has(entry.name)) continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, scanRoot, depth + 1, results, ignore, maxDepth);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      try {
        const stat = await fsp.stat(full);
        const rel = path.relative(scanRoot, full);
        const segments = rel.split(path.sep);
        const projectName = segments.length > 1 ? segments[0] : path.basename(scanRoot);
        results.push({
          path: full,
          relPath: rel,
          rootIndex: getScanRoots().indexOf(scanRoot),
          name: entry.name,
          projectName,
          mtime: stat.mtimeMs,
          size: stat.size,
        });
      } catch {}
    }
  }
}

function genId(prefix = 'f') {
  return prefix + '-' + crypto.randomBytes(4).toString('hex');
}

function collectFilePaths(nodes, set) {
  for (const node of nodes) {
    if (node.type === 'file') set.add(node.path);
    else if (node.type === 'folder' && Array.isArray(node.children)) {
      collectFilePaths(node.children, set);
    }
  }
}

// 修剪：移除磁盘上已不存在的 file，并顺手做去重（防御历史坏数据中重复的 file/folder）
function pruneMissing(nodes, scannedSet, seenPaths = new Set(), seenFolderIds = new Set()) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      if (!scannedSet.has(node.path)) continue;
      if (seenPaths.has(node.path)) continue;        // 去重
      seenPaths.add(node.path);
      out.push(node);
    } else if (node.type === 'folder') {
      if (typeof node.id === 'string' && seenFolderIds.has(node.id)) continue; // 去重
      if (typeof node.id === 'string') seenFolderIds.add(node.id);
      node.children = pruneMissing(node.children || [], scannedSet, seenPaths, seenFolderIds);
      out.push(node);
    }
  }
  return out;
}

// 0.4.1 迁移：旧版本中扫描根下散落的 HTML 会被归到一个叫 `_root` 的兜底分组；
// 改成用 path.basename(scanRoot) 之后，已存在的 `_root` 文件夹按其第一个孩子推断 scanRoot 改名
function migrateLegacyRootFolders(tree) {
  const roots = getScanRoots();
  const findScanRoot = (filePath) => roots.find(r => filePath === r || filePath.startsWith(r + path.sep)) || null;
  const visit = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'folder' && n.name === '_root') {
        const firstFile = (n.children || []).find(c => c.type === 'file');
        const scanRoot = firstFile && firstFile.path ? findScanRoot(firstFile.path) : null;
        if (scanRoot) n.name = path.basename(scanRoot);
      }
      if (n.children) visit(n.children);
    }
  };
  visit(tree);
}

// 自底向上递归丢弃 0 个 file 后代的虚拟文件夹——空壳没有展示价值
function pruneEmptyFolders(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'folder') {
      n.children = pruneEmptyFolders(n.children || []);
      if (n.children.length === 0) continue;
    }
    out.push(n);
  }
  return out;
}

function reconcile(store, scanned) {
  migrateLegacyRootFolders(store.tree);
  const scannedSet = new Set(scanned.map(f => f.path));
  store.tree = pruneMissing(store.tree, scannedSet);

  const existing = new Set();
  collectFilePaths(store.tree, existing);

  const newFiles = scanned.filter(f => !existing.has(f.path));
  newFiles.sort((a, b) => b.mtime - a.mtime);

  for (const file of newFiles) {
    const folderName = file.projectName;
    let folder = store.tree.find(n => n.type === 'folder' && n.name === folderName);
    if (!folder) {
      folder = { id: genId(), type: 'folder', name: folderName, collapsed: false, children: [] };
      store.tree.push(folder);
    }
    folder.children.unshift({ type: 'file', path: file.path });
  }

  store.tree = pruneEmptyFolders(store.tree);

  store.tree.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '', 'zh');
  });
}

function isPathInScanRoots(p) {
  const abs = path.resolve(p);
  return getScanRoots().some(root => {
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

function buildFileUrl(filePath) {
  const roots = getScanRoots();
  const idx = roots.findIndex(root => {
    const rel = path.relative(root, filePath);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (idx < 0) return null;
  const rel = path.relative(roots[idx], filePath);
  return `/raw/${idx}/` + rel.split(path.sep).map(encodeURIComponent).join('/');
}

// 校验 tree 结构 + 防御性检查：深度上限、id 唯一、path 唯一
const MAX_TREE_DEPTH = 12;
function validateTree(rootNodes) {
  const seenFolderIds = new Set();
  const seenFilePaths = new Set();
  function walk(nodes, depth) {
    if (depth > MAX_TREE_DEPTH) return false;
    if (!Array.isArray(nodes)) return false;
    for (const n of nodes) {
      if (!n || typeof n !== 'object') return false;
      if (n.type === 'file') {
        if (typeof n.path !== 'string') return false;
        if (seenFilePaths.has(n.path)) return false; // 不允许同一文件出现两次
        seenFilePaths.add(n.path);
      } else if (n.type === 'folder') {
        if (typeof n.id !== 'string' || typeof n.name !== 'string') return false;
        if (seenFolderIds.has(n.id)) return false;   // 不允许同一 folder 出现两次（含循环）
        seenFolderIds.add(n.id);
        if (!Array.isArray(n.children)) return false;
        if (!walk(n.children, depth + 1)) return false;
      } else return false;
    }
    return true;
  }
  return walk(rootNodes, 0);
}

const events = new EventEmitter();
events.setMaxListeners(50);

let watchers = [];
function startWatchers() {
  for (const w of watchers) w.close().catch(() => {});
  watchers = [];

  const ignore = getIgnoreSet();
  const ignoredFn = (p) => {
    const base = path.basename(p);
    if (base.startsWith('.')) return true;
    if (ignore.has(base)) return true;
    // 跳过明显不是 HTML 也不可能含 HTML 的特殊文件，避免 chokidar 试图监视它们时频繁 EUNKNOWN
    if (base.endsWith('.sock') || base.endsWith('.lock') || base.endsWith('.pid')) return true;
    return false;
  };

  for (const root of getScanRoots()) {
    if (!fs.existsSync(root)) continue;
    const watcher = chokidar.watch(root, {
      ignored: ignoredFn,
      ignoreInitial: true,
      depth: getMaxDepth(),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      persistent: true,
    });

    const onEvent = (kind) => async (filePath) => {
      if (!filePath.toLowerCase().endsWith('.html')) return;
      let mtime = 0;
      try { mtime = (await fsp.stat(filePath)).mtimeMs; } catch {}
      const rel = path.relative(root, filePath);
      const segments = rel.split(path.sep);
      const projectName = segments.length > 1 ? segments[0] : path.basename(root);

      const store = loadStore();
      if (kind === 'change') {
        delete store.seen[filePath];
        saveStore(store);
      }

      events.emit('fs', {
        kind,
        path: filePath,
        name: path.basename(filePath),
        relPath: rel,
        projectName,
        mtime,
      });
    };

    watcher.on('add', onEvent('add'));
    watcher.on('change', onEvent('change'));
    watcher.on('unlink', onEvent('unlink'));
    // 必须监听 error 事件——否则 chokidar 遇到不可监视的文件（socket、deleted symlink 等）
    // 会 emit 未处理的 error，Node 默认 crash 整个 server 进程
    watcher.on('error', (err) => {
      console.warn('  ! chokidar 忽略错误:', err && (err.code || err.message), err && err.path ? '@ ' + err.path : '');
    });
    watchers.push(watcher);
  }
}

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(PUBLIC_DIR));

let rawMounts = [];
function mountRawRoutes() {
  for (const m of rawMounts) {
    const idx = app._router.stack.indexOf(m);
    if (idx >= 0) app._router.stack.splice(idx, 1);
  }
  rawMounts = [];
  getScanRoots().forEach((root, idx) => {
    const handler = express.static(root, {
      setHeaders(res) { res.setHeader('Cache-Control', 'no-store'); },
    });
    app.use(`/raw/${idx}`, handler);
    rawMounts.push(app._router.stack[app._router.stack.length - 1]);
  });
}
mountRawRoutes();

// 全文搜索：HTML 内容缓存（按 mtime 失效）+ 简单 contains 匹配
const contentCache = new Map();   // path → { mtime, text }
async function getFileText(filePath, mtime) {
  const cached = contentCache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.text;
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const text = raw
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    contentCache.set(filePath, { mtime, text });
    return text;
  } catch {
    return '';
  }
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (q.length === 0) return res.json({ matches: [] });
  // ASCII 单字符（'a'/'e' 等）匹配面太广，要求 ≥ 2；
  // 非 ASCII（中文/日文/韩文）单字符通常是有意义的词，允许搜
  const isAscii = /^[\x00-\x7F]+$/.test(q);
  if (isAscii && q.length < 2) return res.json({ matches: [] });
  try {
    const scanned = await scanHtmlFiles();
    const matches = [];
    for (const f of scanned) {
      const text = await getFileText(f.path, f.mtime);
      const idx = text.indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 35);
        const end = Math.min(text.length, idx + q.length + 35);
        const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
        matches.push({ path: f.path, snippet });
      }
    }
    // GC：缓存大于 500 个文件时清掉一半
    if (contentCache.size > 500) {
      const all = [...contentCache.entries()].sort((a, b) => a[1].mtime - b[1].mtime);
      for (let i = 0; i < all.length / 2; i++) contentCache.delete(all[i][0]);
    }
    res.json({ matches });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/state', async (_req, res) => {
  try {
    const scanned = await scanHtmlFiles();
    const store = loadStore();
    reconcile(store, scanned);
    saveStore(store);

    const fileMap = {};
    for (const f of scanned) {
      fileMap[f.path] = {
        path: f.path,
        relPath: f.relPath,
        rootIndex: f.rootIndex,
        name: f.name,
        projectName: f.projectName,
        mtime: f.mtime,
        url: buildFileUrl(f.path),
        seenAt: store.seen[f.path] || 0,
        unread: (store.seen[f.path] || 0) < f.mtime,
        alias: store.aliases[f.path] || null,
      };
    }

    // 清理 recent 中已不存在的文件
    const allPaths = new Set(scanned.map(f => f.path));
    if (Array.isArray(store.recent)) {
      const cleaned = store.recent.filter(p => allPaths.has(p));
      if (cleaned.length !== store.recent.length) {
        store.recent = cleaned;
        saveStore(store);
      }
    }

    res.json({
      tree: store.tree,
      files: fileMap,
      recent: store.recent || [],
      scanRoots: getScanRoots(),
      scannedCount: scanned.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/tree', (req, res) => {
  const body = req.body;
  if (!body || !validateTree(body.tree)) {
    return res.status(400).json({ error: 'tree 结构错误（可能有重复节点、循环引用或层级过深）' });
  }
  const store = loadStore();
  store.tree = body.tree;
  saveStore(store);
  res.json({ ok: true });
});

app.post('/api/folders/new', (req, res) => {
  const name = (req.body && req.body.name || '新分组').toString().slice(0, 60);
  const parentId = req.body && req.body.parentId;
  const store = loadStore();
  const newFolder = { id: genId(), type: 'folder', name, collapsed: false, children: [] };

  if (!parentId) {
    store.tree.push(newFolder);
  } else {
    const ok = insertIntoFolder(store.tree, parentId, newFolder);
    if (!ok) return res.status(404).json({ error: 'parentId 未找到' });
  }
  saveStore(store);
  res.json(newFolder);
});

function insertIntoFolder(nodes, folderId, child) {
  for (const n of nodes) {
    if (n.type === 'folder' && n.id === folderId) {
      n.children.push(child);
      return true;
    }
    if (n.type === 'folder' && insertIntoFolder(n.children, folderId, child)) return true;
  }
  return false;
}

app.post('/api/seen', (req, res) => {
  const filePath = req.body && req.body.path;
  if (!filePath || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  const store = loadStore();
  store.seen[filePath] = Date.now();
  pushRecent(store, filePath);   // 同时更新 recent
  saveStore(store);
  res.json({ ok: true, seenAt: store.seen[filePath] });
});

app.post('/api/seen/all', (_req, res) => {
  const store = loadStore();
  const now = Date.now();
  const all = new Set();
  collectFilePaths(store.tree, all);
  for (const p of all) store.seen[p] = now;
  saveStore(store);
  res.json({ ok: true });
});

app.post('/api/unseen', (req, res) => {
  const filePath = req.body && req.body.path;
  if (!filePath) return res.status(400).json({ error: '缺少 path' });
  const store = loadStore();
  delete store.seen[filePath];
  saveStore(store);
  res.json({ ok: true });
});

app.post('/api/alias', (req, res) => {
  const { path: filePath, alias } = req.body || {};
  if (!filePath || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  const store = loadStore();
  const trimmed = (alias || '').toString().trim().slice(0, 200);
  if (trimmed) store.aliases[filePath] = trimmed;
  else delete store.aliases[filePath];
  saveStore(store);
  res.json({ ok: true, alias: store.aliases[filePath] || null });
});

// 跨平台「在文件管理器中显示」
function revealInFileManager(filePath, cb) {
  if (process.platform === 'darwin') {
    // macOS: open -R 高亮文件
    spawn('open', ['-R', filePath], { detached: true, stdio: 'ignore' }).unref();
    return cb(null);
  }
  if (process.platform === 'win32') {
    // Windows: explorer /select,"path"
    spawn('explorer.exe', [`/select,${filePath}`], { detached: true, stdio: 'ignore' }).unref();
    return cb(null);
  }
  // Linux: 没有统一的"高亮"协议，打开父目录
  spawn('xdg-open', [path.dirname(filePath)], { detached: true, stdio: 'ignore' }).unref();
  cb(null);
}

app.post('/api/reveal', (req, res) => {
  const filePath = req.body && req.body.path;
  if (!filePath || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  revealInFileManager(filePath, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// 升级信息：基于缓存返回，server 启动时已经在后台刷新缓存
app.get('/api/update-info', (_req, res) => {
  const result = updateCheck.getCachedResult(pkg.version);
  if (result) {
    res.json({ current: pkg.version, latest: result.latest, hasUpdate: true });
  } else {
    res.json({ current: pkg.version, latest: null, hasUpdate: false });
  }
});

// 目录浏览：让用户在 Dashboard 里图形化选择扫描根，不用手输绝对路径。
// 服务跑在用户本机（localhost only），文件系统访问由 OS 权限控制。
app.get('/api/browse', async (req, res) => {
  try {
    const requested = req.query.path;
    let target;
    if (!requested || typeof requested !== 'string' || !requested.trim()) {
      target = os.homedir();
    } else {
      target = userPaths.expand(requested);
    }
    target = path.resolve(target);
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: '不是目录: ' + target });
    }
    const showHidden = req.query.hidden === '1';
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && (showHidden || !e.name.startsWith('.')))
      .map(e => ({ name: e.name, path: path.join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const parent = path.dirname(target);
    res.json({
      path: target,
      parent: parent === target ? null : parent,
      home: os.homedir(),
      entries: dirs,
      separator: path.sep,
    });
  } catch (e) {
    res.status(400).json({ error: e.code === 'ENOENT' ? '路径不存在' : (e.code || e.message) });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    scanRoots: config.scanRoots || [],
    ignore: config.ignore || [],
    port: config.port,
    maxDepth: config.maxDepth,
  });
});

app.put('/api/config', (req, res) => {
  const body = req.body || {};
  const next = { ...config };
  if (Array.isArray(body.scanRoots)) {
    const cleaned = [...new Set(body.scanRoots.map(p => path.resolve(String(p).trim())).filter(Boolean))];
    for (const p of cleaned) {
      if (!fs.existsSync(p)) return res.status(400).json({ error: `路径不存在：${p}` });
      const stat = fs.statSync(p);
      if (!stat.isDirectory()) return res.status(400).json({ error: `不是目录：${p}` });
    }
    next.scanRoots = cleaned;
  }
  if (Array.isArray(body.ignore)) next.ignore = body.ignore.map(String);
  if (typeof body.maxDepth === 'number') next.maxDepth = Math.min(20, Math.max(1, body.maxDepth));
  saveConfig(next);
  mountRawRoutes();
  startWatchers();
  res.json({ ok: true, config: next });
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const onFs = (e) => send(e);
  events.on('fs', onFs);

  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    events.off('fs', onFs);
    clearInterval(ping);
  });
});

const httpServer = app.listen(PORT, () => {
  console.log(`\n  Atlas dashboard 运行中`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  配置: ${CONFIG_PATH}`);
  console.log(`  扫描根: ${getScanRoots().join(', ')}\n`);
  startWatchers();
  // 后台异步刷新升级检查缓存
  updateCheck.refreshInBackground(pkg.name);
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ 端口 ${PORT} 被占用`);
    console.error(`    请用 'atlas --port <其他端口>' 启动，或修改 ${CONFIG_PATH} 中的 port。\n`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

// 优雅退出
function shutdown() {
  console.log('\n  收到退出信号，关闭中…');
  for (const w of watchers) {
    try { w.close().catch(() => {}); } catch {}
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
