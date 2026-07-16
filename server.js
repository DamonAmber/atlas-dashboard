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
const pdfExport = require('./lib/pdf-export');
const share = require('./lib/share');
const editable = require('./lib/editable');
const editApply = require('./lib/edit-apply');
const editBackup = require('./lib/edit-backup');
const markdown = require('./public/vendor/markdown.js');
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

// 文档类型：HTML 与 Markdown 可共存。config.docTypes 是启用类型的数组，
// 例如 ['html','md']（默认两者都扫）。决定扫描哪些文件、如何预览/编辑。
const DOC_EXTENSIONS = {
  html: ['.html', '.htm'],
  md: ['.md', '.markdown'],
};
const ALL_DOC_TYPES = ['html', 'md'];
// 返回当前启用的类型数组（含旧配置兼容：单选 docType → 数组）
function getEnabledDocTypes() {
  if (Array.isArray(config.docTypes)) {
    const list = config.docTypes.filter(t => ALL_DOC_TYPES.includes(t));
    return list.length ? list : ['html'];
  }
  // 旧版单选字段兼容
  if (config.docType === 'md') return ['md'];
  if (config.docType === 'html') return ['html'];
  // 全新默认：两种都扫（共存）
  return ['html', 'md'];
}
// 当前启用类型对应的所有扩展名
function currentExtensions() {
  const types = getEnabledDocTypes();
  return types.reduce((acc, t) => acc.concat(DOC_EXTENSIONS[t] || []), []);
}
// 判断某个文件名是否属于当前启用的类型（大小写不敏感）
function matchesDocType(name) {
  const lower = name.toLowerCase();
  return currentExtensions().some(ext => lower.endsWith(ext));
}
// 单个文件的文档类型（按扩展名判断，与启用配置无关）——用于逐文件标注
function docTypeOfPath(p) {
  const lower = String(p).toLowerCase();
  if (DOC_EXTENSIONS.md.some(ext => lower.endsWith(ext))) return 'md';
  return 'html';
}

function emptyStore() {
  return { tree: [], seen: {}, aliases: {}, recent: [], archivedProjects: [], shares: {} };
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return migrateStore(raw);
  } catch (e) {
    console.error('store.json 损坏，使用空 store:', e.message);
    return emptyStore();
  }
}

function migrateStore(raw) {
  if (Array.isArray(raw.tree)) {
    raw.seen = raw.seen || {};
    raw.aliases = raw.aliases || {};
    raw.recent = Array.isArray(raw.recent) ? raw.recent : [];
    raw.archivedProjects = Array.isArray(raw.archivedProjects) ? raw.archivedProjects : [];
    raw.shares = (raw.shares && typeof raw.shares === 'object') ? raw.shares : {};
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
    return { tree, seen: raw.seen || {}, aliases: raw.aliases || {}, recent: [], archivedProjects: [] };
  }
  return emptyStore();
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

async function scanDocFiles() {
  const results = [];
  const ignore = getIgnoreSet();
  const maxDepth = getMaxDepth();
  for (const root of getScanRoots()) {
    if (!fs.existsSync(root)) continue;
    await walk(root, root, 0, results, ignore, maxDepth);
  }
  return results;
}
// 兼容旧调用名
const scanHtmlFiles = scanDocFiles;

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
    } else if (entry.isFile() && matchesDocType(entry.name)) {
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
          docType: docTypeOfPath(entry.name),
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

  // 归档：projectName 在 store.archivedProjects 里的 file 跳过——
  // 既不进 scannedSet（也就不会被 prune 留下来），也不会被 reconcile 重建出 folder
  const archivedSet = new Set(store.archivedProjects || []);
  const visibleScanned = archivedSet.size === 0
    ? scanned
    : scanned.filter(f => !archivedSet.has(f.projectName));

  const scannedSet = new Set(visibleScanned.map(f => f.path));
  store.tree = pruneMissing(store.tree, scannedSet);

  const existing = new Set();
  collectFilePaths(store.tree, existing);

  const newFiles = visibleScanned.filter(f => !existing.has(f.path));
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

// 统计每个 projectName 在磁盘上有多少个 HTML——给"已归档"列表显示用
function countByProject(scanned) {
  const map = new Map();
  for (const f of scanned) {
    map.set(f.projectName, (map.get(f.projectName) || 0) + 1);
  }
  return map;
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

// 自我写入抑制：/api/save-edits 写盘后登记 path→mtime，chokidar change 命中则
// 不把文件标未读（避免用户刚保存就看到自己的红点）。10s 后自动过期。
const selfWrites = new Map();
function markSelfWrite(filePath, mtimeMs) {
  selfWrites.set(filePath, mtimeMs);
  setTimeout(() => {
    if (selfWrites.get(filePath) === mtimeMs) selfWrites.delete(filePath);
  }, 10_000).unref();
}
function isSelfWrite(filePath, mtimeMs) {
  const v = selfWrites.get(filePath);
  if (v === undefined) return false;
  if (Math.abs((mtimeMs || 0) - v) < 2000) {
    selfWrites.delete(filePath);
    return true;
  }
  return false;
}

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
      if (!matchesDocType(path.basename(filePath))) return;
      let mtime = 0;
      try { mtime = (await fsp.stat(filePath)).mtimeMs; } catch {}
      const rel = path.relative(root, filePath);
      const segments = rel.split(path.sep);
      const projectName = segments.length > 1 ? segments[0] : path.basename(root);

      const store = loadStore();
      if (kind === 'change') {
        // 自我写入（编辑保存触发）不标未读
        if (!isSelfWrite(filePath, mtime)) {
          delete store.seen[filePath];
          saveStore(store);
        }
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

// 安全：Dashboard 仅在本机可用，LAN/外部访问只允许 /share/<token>/* 路径
// （Node.js app.listen(PORT) 默认 dual-stack，LAN 内可访问；这里通过中间件兜底）
const LOCAL_ADDRS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);
app.use((req, res, next) => {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  if (LOCAL_ADDRS.has(addr)) return next();
  // 非本机：只放行 /share/<token>/* 这一系列分享路径
  if (req.path.startsWith('/share/')) return next();
  res.status(403).type('html').send(
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Atlas</title>' +
    '<style>body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;color:#444;background:#f6f7f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:2rem;text-align:center;line-height:1.6}main{max-width:520px}h1{font-size:18px;margin:0 0 12px}p{font-size:14px;color:#666}code{background:#fff;padding:2px 6px;border-radius:4px;border:1px solid #e3e6ec}</style>' +
    '</head><body><main><h1>Atlas Dashboard 仅在本机可用</h1>' +
    '<p>这是文档作者本机的 Atlas 实例。如果他给你分享了 HTML 文档，链接里会带 <code>/share/&lt;token&gt;/...</code> 路径段。</p>' +
    '</main></body></html>'
  );
});

// Dashboard 会在运行中自升级；禁止浏览器保留旧 shell/脚本，避免重启窗口命中空文档或旧资源。
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res) {
    res.set('Cache-Control', 'no-store');
  },
}));

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
    let text;
    if (docTypeOfPath(filePath) === 'md') {
      // Markdown 基本就是纯文本，直接归一化空白即可
      text = raw.replace(/\s+/g, ' ').toLowerCase();
    } else {
      text = raw
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .toLowerCase();
    }
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
        docType: f.docType || docTypeOfPath(f.path),
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

    // 归档列表：给每个归档的 projectName 附带磁盘上的实际文件数（让用户决定要不要恢复）
    const projCounts = countByProject(scanned);
    const archivedProjects = (store.archivedProjects || []).map(name => ({
      name,
      count: projCounts.get(name) || 0,
    }));

    res.json({
      tree: store.tree,
      files: fileMap,
      recent: store.recent || [],
      scanRoots: getScanRoots(),
      scannedCount: scanned.length,
      docTypes: getEnabledDocTypes(),
      archivedProjects,
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

// ---------- 分享：把单个 HTML 暂时发布到局域网 ----------
// 给每个被分享文件生成一个不可猜的 token；外部访问 /share/:token/<原名>
// 持久化到 store.shares = { [token]: { path, sharedAt } }
// 重启 atlas token 仍有效（用户可以"一键停止全部"主动撤销）

function buildShareUrls(token, htmlPath) {
  const fileName = encodeURIComponent(path.basename(htmlPath));
  const lanIps = share.getLanIPs();
  return {
    localhost: `http://localhost:${PORT}/share/${token}/${fileName}`,
    lan: lanIps.map(ip => `http://${ip}:${PORT}/share/${token}/${fileName}`),
  };
}

function shareEntryPublic(token, entry) {
  return {
    token,
    path: entry.path,
    name: path.basename(entry.path),
    sharedAt: entry.sharedAt,
    urls: buildShareUrls(token, entry.path),
  };
}

// 启动分享：返回该文件已有 token 或新建一个
app.post('/api/share/start', (req, res) => {
  const filePath = req.body && req.body.path;
  if (!filePath || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const store = loadStore();
  // 同一个文件如果已经在分享，复用旧 token（避免每次按按钮都换 URL）
  const existing = Object.entries(store.shares || {}).find(([, v]) => v && v.path === filePath);
  let token;
  if (existing) {
    token = existing[0];
  } else {
    token = share.genToken();
    store.shares[token] = { path: filePath, sharedAt: Date.now() };
    saveStore(store);
  }
  res.json(shareEntryPublic(token, store.shares[token]));
});

app.post('/api/share/stop', (req, res) => {
  const token = req.body && req.body.token;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token 必填' });
  }
  const store = loadStore();
  if (!store.shares || !store.shares[token]) {
    return res.json({ ok: true, alreadyStopped: true });
  }
  delete store.shares[token];
  saveStore(store);
  res.json({ ok: true });
});

// 一键停止全部分享——给"评审完了赶紧关掉"的安全开关
app.post('/api/share/stop-all', (_req, res) => {
  const store = loadStore();
  const count = Object.keys(store.shares || {}).length;
  store.shares = {};
  saveStore(store);
  res.json({ ok: true, count });
});

app.get('/api/shares', (_req, res) => {
  const store = loadStore();
  const list = Object.entries(store.shares || {})
    .filter(([, v]) => v && v.path && fs.existsSync(v.path))
    .sort((a, b) => (b[1].sharedAt || 0) - (a[1].sharedAt || 0))
    .map(([token, v]) => shareEntryPublic(token, v));
  res.json({ shares: list, lanIps: share.getLanIPs(), port: PORT });
});

// 公开访问入口：/share/:token → 重定向到 /share/:token/<原文件名>
// 这样 HTML 里的相对资源（./style.css）浏览器会自动拼成 /share/:token/style.css，命中下面的资源 handler
app.get('/share/:token', (req, res) => {
  const store = loadStore();
  const entry = store.shares && store.shares[req.params.token];
  if (!entry) return res.status(404).type('html').send('<h1>404 — 链接已失效</h1><p>这个分享链接已被作者停止。</p>');
  if (!fs.existsSync(entry.path)) return res.status(404).type('html').send('<h1>404 — 文件已不存在</h1>');
  return res.redirect(302, `/share/${req.params.token}/${encodeURIComponent(path.basename(entry.path))}`);
});

// 资源服务：/share/:token/<相对路径> → 服务 HTML 同目录子树
// 严格防 path traversal——只能访问 baseDir 及其子目录
app.get('/share/:token/*', async (req, res) => {
  const token = req.params.token;
  const store = loadStore();
  const entry = store.shares && store.shares[token];
  if (!entry) return res.status(404).type('html').send('<h1>404 — 链接已失效</h1>');
  if (!fs.existsSync(entry.path)) return res.status(404).type('html').send('<h1>404 — 文件已不存在</h1>');

  const baseDir = path.dirname(entry.path);
  let relPath;
  try {
    relPath = decodeURIComponent(req.params[0] || '');
  } catch {
    return res.status(400).send('Bad path encoding');
  }

  const resolved = share.resolveSharedPath(baseDir, relPath);
  if (!resolved.ok) {
    return res.status(403).type('html').send('<h1>403 — 路径越界</h1>');
  }
  if (!fs.existsSync(resolved.abs)) {
    return res.status(404).type('html').send('<h1>404 — 资源不存在</h1>');
  }
  // 不允许访问目录本身（必须是文件）
  try {
    if (fs.statSync(resolved.abs).isDirectory()) {
      return res.status(403).type('html').send('<h1>403 — 禁止列目录</h1>');
    }
  } catch {}
  // Markdown 文件：渲染成完整 HTML 页面再返回，让局域网访客看到预览样式而不是 md 原文
  if (isMarkdownPath(resolved.abs)) {
    try {
      const raw = await fsp.readFile(resolved.abs, 'utf8');
      const html = markdown.renderPage(raw, { title: path.basename(resolved.abs) });
      res.set('Cache-Control', 'no-store');
      return res.type('html').send(html);
    } catch (e) {
      console.error('share render-md 失败:', e);
      return res.status(500).type('html').send('<h1>500 — 渲染失败</h1>');
    }
  }
  // 其余资源（图片 / CSS / HTML 等）：用 sendFile 让 express 自己设 Content-Type / 范围请求
  res.sendFile(resolved.abs, { headers: { 'Cache-Control': 'no-store' } });
});

// 归档一个 projectName——下次扫描时会跳过同名分组（不会再被自动重建出来）
// 也立即从 store.tree 里把同名顶层分组拿掉
app.post('/api/archive', (req, res) => {
  const name = req.body && req.body.name;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name 必填' });
  }
  const store = loadStore();
  store.archivedProjects = Array.from(new Set([...(store.archivedProjects || []), name]));
  // 同步把 store.tree 里的同名顶层 folder 立即拿掉，UI 不用等下次扫描
  store.tree = (store.tree || []).filter(n => !(n.type === 'folder' && n.name === name));
  saveStore(store);
  res.json({ ok: true, archivedProjects: store.archivedProjects });
});

// 取消归档——把 name 从列表移除，下次 /api/state 时 reconcile 会把对应分组重新建出来
app.post('/api/archive/restore', (req, res) => {
  const name = req.body && req.body.name;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name 必填' });
  }
  const store = loadStore();
  store.archivedProjects = (store.archivedProjects || []).filter(n => n !== name);
  saveStore(store);
  res.json({ ok: true, archivedProjects: store.archivedProjects });
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

// 把 HTML 文件导出为 PDF——用本机 Chromium 系浏览器（Chrome / Edge / Brave / Arc / Chromium）
// headless 模式渲染，保存到 ~/Downloads/。找不到 chromium 时返回 reason='no-chromium'，前端降级走 window.print()
// SSE 流式：launching → rendering → writing → done | error
app.post('/api/export-pdf', async (req, res) => {
  const filePath = req.body && req.body.path;
  const fileName = req.body && req.body.fileName;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const send = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} };

  if (!filePath || !isPathInScanRoots(filePath)) {
    send({ phase: 'error', reason: 'invalid-path', message: '路径非法' });
    return res.end();
  }
  if (!filePath.toLowerCase().endsWith('.html') && !filePath.toLowerCase().endsWith('.htm')) {
    send({ phase: 'error', reason: 'unsupported', message: '只支持 HTML 文件' });
    return res.end();
  }
  try {
    const result = await pdfExport.exportPdf(
      { htmlPath: filePath, fileName },
      (phaseEvent) => send(phaseEvent),  // 把每个阶段事件转发为 SSE
    );
    if (result.ok) {
      send({ phase: 'done', ...result });
    } else {
      send({ phase: 'error', ...result });
    }
    res.end();
  } catch (err) {
    send({ phase: 'error', reason: 'unexpected', message: err.message });
    res.end();
  }
});

// ---------- 预览区轻量编辑：编辑文档注入 + 保存 ----------
// GET /api/edit-doc?path=<abs>：返回带锚点标注（data-atlas-eid/role + 包裹 span）的
// 编辑专用文档。该文档只用于 iframe 编辑显示，绝不写盘。
app.get('/api/edit-doc', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string' || !isPathInScanRoots(filePath)) {
    return res.status(400).type('text/plain').send('路径非法');
  }
  const lower = filePath.toLowerCase();
  if (!lower.endsWith('.html') && !lower.endsWith('.htm')) {
    return res.status(400).type('text/plain').send('只支持 HTML 文件');
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).type('text/plain').send('文件不存在');
  }
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    // base href：让相对资源仍按 /raw/<idx>/<dir>/ 解析
    const fileUrl = buildFileUrl(filePath);
    const baseHref = fileUrl ? fileUrl.slice(0, fileUrl.lastIndexOf('/') + 1) : null;
    const { html } = await editable.buildAnnotatedDoc(raw, { baseHref });
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (e) {
    console.error('edit-doc 失败:', e);
    res.status(500).type('text/plain').send('解析失败: ' + (e && e.message || e));
  }
});

// POST /api/save-edits：把编辑操作写回磁盘原文件（精确区间替换 / 子树重写）
// 写前 baseHash 冲突检测 + 备份；标记自我写入避免误标未读。
app.post('/api/save-edits', async (req, res) => {
  const body = req.body || {};
  const filePath = body.path;
  if (!filePath || typeof filePath !== 'string' || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  const lower = filePath.toLowerCase();
  if (!lower.endsWith('.html') && !lower.endsWith('.htm')) {
    return res.status(400).json({ error: '只支持 HTML 文件' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const ops = body.ops;
  if (!Array.isArray(ops)) return res.status(400).json({ error: 'ops 必须是数组' });
  if (ops.length > 5000) return res.status(400).json({ error: 'ops 过多' });
  for (const op of ops) {
    if (op && op.type === 'setText' && typeof op.text === 'string' && op.text.length > 100_000) {
      return res.status(400).json({ error: '单条文本过长' });
    }
    if (op && op.type === 'setAttr' && typeof op.value === 'string' && op.value.length > 8192) {
      return res.status(400).json({ error: '链接地址过长' });
    }
  }

  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const currentHash = editable.sha1(raw);
    if (body.baseHash && body.baseHash !== currentHash) {
      return res.status(409).json({ error: 'conflict', message: '文件已被外部修改，请刷新后重试' });
    }
    if (ops.length === 0) {
      return res.json({ ok: true, unchanged: true });
    }

    const p = await editable.loadParse5();
    const doc = p.parse(raw, { sourceCodeLocationInfo: true });
    const analysis = editable.analyzeDocument(doc);

    let next;
    try {
      next = editApply.applyOps(raw, doc, analysis, ops, p);
    } catch (e) {
      if (e.code === 'INVALID_OPS') return res.status(400).json({ error: e.message });
      throw e;
    }

    if (next === raw) {
      return res.json({ ok: true, unchanged: true });
    }

    // 备份（失败不阻断保存，仅告警）
    try { editBackup.backup(filePath); } catch (e) {
      console.warn('  ! 编辑备份失败（继续保存）:', e && e.message);
    }

    // 原子写回
    const tmp = filePath + '.atlas-tmp';
    await fsp.writeFile(tmp, next, 'utf8');
    await fsp.rename(tmp, filePath);
    const stat = await fsp.stat(filePath);
    markSelfWrite(filePath, stat.mtimeMs);

    // 标记已读，避免自我写入被标未读
    const store = loadStore();
    store.seen[filePath] = Date.now();
    saveStore(store);

    res.json({ ok: true, mtime: stat.mtimeMs });
  } catch (e) {
    console.error('save-edits 失败:', e);
    res.status(500).json({ error: e && e.message || String(e) });
  }
});

// ---------- Markdown 预览 / 编辑 ----------
function isMarkdownPath(p) {
  return DOC_EXTENSIONS.md.some(ext => String(p).toLowerCase().endsWith(ext));
}

// GET /api/render-md?path=<abs>：把 .md 渲染成完整 HTML 页面，用于 iframe 只读预览
app.get('/api/render-md', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string' || !isPathInScanRoots(filePath)) {
    return res.status(400).type('text/plain').send('路径非法');
  }
  if (!isMarkdownPath(filePath)) {
    return res.status(400).type('text/plain').send('只支持 Markdown 文件');
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).type('text/plain').send('文件不存在');
  }
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const html = markdown.renderPage(raw, { title: path.basename(filePath) });
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (e) {
    console.error('render-md 失败:', e);
    res.status(500).type('text/plain').send('渲染失败: ' + (e && e.message || e));
  }
});

// GET /api/md-source?path=<abs>：返回原始 Markdown 文本 + 内容哈希（供编辑器加载与冲突检测）
app.get('/api/md-source', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string' || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  if (!isMarkdownPath(filePath)) {
    return res.status(400).json({ error: '只支持 Markdown 文件' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    res.set('Cache-Control', 'no-store');
    res.json({ content: raw, hash: editable.sha1(raw) });
  } catch (e) {
    console.error('md-source 失败:', e);
    res.status(500).json({ error: e && e.message || String(e) });
  }
});

// POST /api/save-md：把编辑后的 Markdown 全文写回磁盘。
// baseHash 冲突检测 + 备份 + 自我写入标记（避免误标未读）。
app.post('/api/save-md', async (req, res) => {
  const body = req.body || {};
  const filePath = body.path;
  if (!filePath || typeof filePath !== 'string' || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  if (!isMarkdownPath(filePath)) {
    return res.status(400).json({ error: '只支持 Markdown 文件' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  if (typeof body.content !== 'string') {
    return res.status(400).json({ error: 'content 必须是字符串' });
  }
  if (body.content.length > 5_000_000) {
    return res.status(400).json({ error: '内容过大' });
  }
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const currentHash = editable.sha1(raw);
    if (body.baseHash && body.baseHash !== currentHash) {
      return res.status(409).json({ error: 'conflict', message: '文件已被外部修改，请刷新后重试' });
    }
    const next = body.content;
    if (next === raw) {
      return res.json({ ok: true, unchanged: true, hash: currentHash });
    }

    // 备份（失败不阻断保存，仅告警）
    try { editBackup.backup(filePath); } catch (e) {
      console.warn('  ! Markdown 备份失败（继续保存）:', e && e.message);
    }

    // 原子写回
    const tmp = filePath + '.atlas-tmp';
    await fsp.writeFile(tmp, next, 'utf8');
    await fsp.rename(tmp, filePath);
    const stat = await fsp.stat(filePath);
    markSelfWrite(filePath, stat.mtimeMs);

    // 标记已读，避免自我写入被标未读
    const store = loadStore();
    store.seen[filePath] = Date.now();
    saveStore(store);

    res.json({ ok: true, mtime: stat.mtimeMs, hash: editable.sha1(next) });
  } catch (e) {
    console.error('save-md 失败:', e);
    res.status(500).json({ error: e && e.message || String(e) });
  }
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

// 一键自升级：spawn npm install -g atlas-dashboard@latest，stdout/stderr 实时
// 通过 SSE 推送给 frontend；安装成功后 spawn detached helper 重启 server，自杀。
// 失败：保持 server 存活，emit error 事件，frontend 可以重试。
let _upgradeInFlight = false;
app.post('/api/self-upgrade', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
  };

  if (_upgradeInFlight) {
    send({ phase: 'error', message: '已经有升级在进行中，请稍候' });
    return res.end();
  }
  _upgradeInFlight = true;

  send({ phase: 'start', message: '开始下载新版本…', current: pkg.version });

  // npm install 命令——shell:true 让 PATH 解析 npm
  const npm = spawn('npm', ['install', '-g', 'atlas-dashboard@latest'], {
    env: process.env,
    shell: false,
  });

  const onChunk = (stream) => (chunk) => {
    const text = chunk.toString();
    text.split(/\r?\n/).filter(Boolean).forEach(line => {
      send({ phase: 'log', stream, text: line });
    });
  };
  npm.stdout.on('data', onChunk('stdout'));
  npm.stderr.on('data', onChunk('stderr'));

  npm.on('error', (err) => {
    _upgradeInFlight = false;
    send({ phase: 'error', message: 'spawn npm 失败：' + err.message });
    res.end();
  });

  npm.on('exit', (code) => {
    if (code !== 0) {
      _upgradeInFlight = false;
      send({ phase: 'error', message: `npm install 失败，退出码 ${code}` });
      res.end();
      return;
    }

    send({ phase: 'installed', message: '下载完成，正在重启 Atlas…' });

    // 写一份 helper 脚本到 ~/.atlas/restart-helper-{ts}.js
    // 用 template 文件复制——这样升级覆盖 lib/ 的瞬间，已经写好的 helper 文件不受影响
    let helperPath;
    try {
      const tmpl = fs.readFileSync(path.join(ROOT_DIR, 'lib', 'restart-helper-template.js'), 'utf8');
      helperPath = path.join(userPaths.configDir(), `restart-helper-${Date.now()}.js`);
      fs.writeFileSync(helperPath, tmpl);
    } catch (err) {
      _upgradeInFlight = false;
      send({ phase: 'error', message: '写入 helper 脚本失败：' + err.message });
      res.end();
      return;
    }

    const atlasBin = path.join(ROOT_DIR, 'bin', 'atlas.js');
    const logFile = userPaths.logPath();

    try {
      const helper = spawn(process.execPath, [helperPath, String(process.pid), atlasBin, logFile], {
        detached: true,
        stdio: 'ignore',
      });
      helper.unref();
    } catch (err) {
      _upgradeInFlight = false;
      send({ phase: 'error', message: 'spawn helper 失败：' + err.message });
      res.end();
      return;
    }

    send({ phase: 'restarting', message: 'server 即将关闭，前端会自动重连…' });
    res.end();

    // 给 SSE 流和 PID 文件清理留 1s，再退出，让 helper 接管
    setTimeout(() => {
      try { fs.unlinkSync(userPaths.pidPath()); } catch {}
      process.exit(0);
    }, 1000);
  });

  // 客户端断开（用户关 tab）→ 不取消正在跑的 npm，但停止推送
  req.on('close', () => {
    // 不重置 _upgradeInFlight——npm 还在跑
  });
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
    docTypes: getEnabledDocTypes(),
  });
});

app.put('/api/config', (req, res) => {
  const body = req.body || {};
  const next = { ...config };
  let rootsChanged = false;
  let watchDepsChanged = false; // scanRoots / ignore / maxDepth 变化才需要重启 watcher
  if (Array.isArray(body.scanRoots)) {
    const cleaned = [...new Set(body.scanRoots.map(p => path.resolve(String(p).trim())).filter(Boolean))];
    for (const p of cleaned) {
      if (!fs.existsSync(p)) return res.status(400).json({ error: `路径不存在：${p}` });
      const stat = fs.statSync(p);
      if (!stat.isDirectory()) return res.status(400).json({ error: `不是目录：${p}` });
    }
    if (JSON.stringify(cleaned) !== JSON.stringify(config.scanRoots || [])) {
      rootsChanged = true;
      watchDepsChanged = true;
    }
    next.scanRoots = cleaned;
  }
  if (Array.isArray(body.ignore)) {
    next.ignore = body.ignore.map(String);
    if (JSON.stringify(next.ignore) !== JSON.stringify(config.ignore || [])) watchDepsChanged = true;
  }
  if (typeof body.maxDepth === 'number') {
    next.maxDepth = Math.min(20, Math.max(1, body.maxDepth));
    if (next.maxDepth !== config.maxDepth) watchDepsChanged = true;
  }
  if (Array.isArray(body.docTypes)) {
    const cleaned = [...new Set(body.docTypes.filter(t => ALL_DOC_TYPES.includes(t)))];
    if (cleaned.length === 0) {
      return res.status(400).json({ error: '至少启用一种文档类型' });
    }
    next.docTypes = cleaned;
    delete next.docType; // 清掉旧单选字段，避免歧义
    // docTypes 变化无需重启 watcher：事件回调按 matchesDocType 实时过滤
  }
  saveConfig(next);
  // 仅在真正影响到的时候才做重活，避免切换文档类型时无谓地重挂路由 / 重启 watcher（卡顿源头）
  if (rootsChanged) mountRawRoutes();
  if (watchDepsChanged) startWatchers();
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
  const onFs = (e) => send({ channel: 'fs', ...e });
  const onUpdate = (e) => send({ channel: 'update', ...e });
  events.on('fs', onFs);
  events.on('update', onUpdate);

  // 新连接进来时，若已知有可用更新，立即推一次（避免依赖 frontend 主动 fetch）
  const cached = updateCheck.getCachedResult(pkg.version);
  if (cached) send({ channel: 'update', current: pkg.version, latest: cached.latest });

  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    events.off('fs', onFs);
    events.off('update', onUpdate);
    clearInterval(ping);
  });
});

// 不指定 host → Node 绑定 :: 双栈（同时接受 IPv6 ::1 与 IPv4 127.0.0.1 及 LAN）。
// 之前显式传 '0.0.0.0' 只绑 IPv4，导致 localhost 优先解析到 ::1 的机器上打不开。
const httpServer = app.listen(PORT, () => {
  console.log(`\n  Atlas dashboard 运行中`);
  console.log(`  → http://localhost:${PORT}`);
  // 列出 LAN IP，方便用户知道分享链接里会用什么地址
  const lanIps = (() => {
    const ifs = os.networkInterfaces();
    const out = [];
    for (const name of Object.keys(ifs)) {
      for (const i of ifs[name] || []) {
        if (i.family === 'IPv4' && !i.internal) out.push(i.address);
      }
    }
    return out;
  })();
  if (lanIps.length > 0) {
    console.log(`  局域网: ${lanIps.map(ip => `http://${ip}:${PORT}`).join(', ')}`);
  }
  console.log(`  配置: ${CONFIG_PATH}`);
  console.log(`  扫描根: ${getScanRoots().join(', ')}\n`);
  startWatchers();
  // 升级检查：启动立即查一次 + 每 1h 重复，发现新版本时 SSE 推到所有 tab
  const checkUpdate = async () => {
    try {
      const r = await updateCheck.refreshAndCheck(pkg.name, pkg.version);
      if (r.changed) {
        events.emit('update', { current: pkg.version, latest: r.latest });
      }
    } catch {}
  };
  checkUpdate();
  setInterval(checkUpdate, updateCheck.CHECK_INTERVAL_MS);
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
