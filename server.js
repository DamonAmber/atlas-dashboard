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
const versionStore = require('./lib/version-store');
const diffLib = require('./lib/diff');
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
  return {
    tree: [], seen: {}, aliases: {}, recent: [],
    archivedProjects: [], shares: {},
    // path → { file, hash, at }：用户上次看过的那一版内容的底本，供 diff 用
    seenVersions: {},
    // path → epochMs（收藏时间）。存时间而不是 true，收藏夹才能按"最近收藏"排序
    favorites: {},
    // path → string[]（标签，已去重、保持用户输入顺序）
    tags: {},
  };
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
    raw.seenVersions = (raw.seenVersions && typeof raw.seenVersions === 'object') ? raw.seenVersions : {};
    raw.favorites = (raw.favorites && typeof raw.favorites === 'object') ? raw.favorites : {};
    raw.tags = (raw.tags && typeof raw.tags === 'object') ? raw.tags : {};
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
    // 递归一次让上面那个分支把其余字段补齐（shares / seenVersions / favorites / tags）。
    // 原来这里返回手写字面量，缺的字段全靠各处 `store.x && store.x[p]` 防御式访问兜着
    return migrateStore({ tree, seen: raw.seen || {}, aliases: raw.aliases || {}, recent: [], archivedProjects: [] });
  }
  return emptyStore();
}

// ---------- 标签规范化 ----------
// 标签是纯用户输入，前端传的是"逗号分隔的一行字"拆出来的数组。这里做唯一一次
// 规范化，之后 store 里的值就可以当作干净数据用（前端筛选直接按字符串比较）。
//
// 大小写：统一按小写去重但保留用户第一次输入的写法——用户输入 "AI" 就显示 "AI"，
// 之后再输 "ai" 不会多出一个看起来重复的标签。
const TAG_MAX_LEN = 24;
const TAGS_MAX_COUNT = 12;
function normalizeTags(input) {
  const list = Array.isArray(input)
    ? input
    : String(input == null ? '' : input).split(/[,，]/);   // 中英文逗号都认
  const out = [];
  const seenLower = new Set();
  for (const raw of list) {
    // 内部空白压成单空格：标签是用来点的，不该出现看不见的差异
    const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, TAG_MAX_LEN);
    if (!t) continue;
    const lower = t.toLowerCase();
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    out.push(t);
    if (out.length >= TAGS_MAX_COUNT) break;   // 超限截断而不报错（对齐 alias 的 slice 风格）
  }
  return out;
}

// 全量标签表：{ name, count }，按用量倒序、同用量按名称。供筛选条渲染用。
// 只统计当前磁盘上还在的文件，否则删掉文件后标签条上会留下点不出东西的死标签。
function collectTagCounts(store, livePaths) {
  const counts = new Map();
  for (const [p, tags] of Object.entries(store.tags || {})) {
    if (!livePaths.has(p) || !Array.isArray(tags)) continue;
    for (const t of tags) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'zh'));
}

// "标为已读"该写哪个时间戳。
// 未读判定是 seen < mtime，所以这个值必须不小于文件自身的 mtime。直接写
// Date.now() 在 mtime 落在未来时（时钟漂移、网络盘、被 touch 到未来）清不掉
// 红点——点完"全部标为已读"它还是未读。
function markSeenAt(mtime) {
  const m = Number(mtime);
  return Math.max(Date.now(), Number.isFinite(m) ? m : 0);
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

// ---------- 文件索引（内存常驻，由 chokidar 增量维护）----------
//
// 为什么要有它：/api/state 与 /api/search 原来每次请求都做一遍全盘递归 walk。
// 而 /api/state 被调用得非常频繁——每 60s 定时、每次标签页切回前台、每个文件
// 系统事件（400ms 防抖）、打开设置面板时还会再拉一次。扫 ~/Documents 这种量级
// 的目录时，这就是持续的磁盘与事件循环压力，而 chokidar 本来就已经在监听所有
// 扫描根了，重复遍历没有任何新信息。
//
// 现在：首次访问时构建一次，之后由 watcher 的 add/change/unlink 事件增量更新。
// 索引里存所有文档类型（html + md），按当前启用的 docTypes 在读取时过滤——
// 这样在设置里勾选 / 取消文档类型不需要重新扫盘。
const ALL_DOC_EXTENSIONS = ALL_DOC_TYPES.reduce(
  (acc, t) => acc.concat(DOC_EXTENSIONS[t] || []), [],
);
function isAnyDocPath(name) {
  const lower = String(name).toLowerCase();
  return ALL_DOC_EXTENSIONS.some(ext => lower.endsWith(ext));
}

const fileIndex = new Map();     // absPath → 文件记录
let indexSignature = null;       // 影响扫描结果的配置快照
let indexBuilding = null;        // 构建中的 Promise（并发请求共用一次扫描）

// 只有这些配置会改变"磁盘上哪些文件属于索引"。docTypes 不在其中：它只影响读取过滤
function currentIndexSignature() {
  return JSON.stringify([getScanRoots(), [...getIgnoreSet()].sort(), getMaxDepth()]);
}

function makeRecord(absPath, scanRoot, rootIndex, stat) {
  const rel = path.relative(scanRoot, absPath);
  const segments = rel.split(path.sep);
  return {
    path: absPath,
    relPath: rel,
    rootIndex,
    name: path.basename(absPath),
    projectName: segments.length > 1 ? segments[0] : path.basename(scanRoot),
    mtime: stat.mtimeMs,
    size: stat.size,
    docType: docTypeOfPath(absPath),
  };
}

// 找到某个绝对路径属于哪个扫描根
function ownerRoot(absPath) {
  const roots = getScanRoots();
  for (let i = 0; i < roots.length; i++) {
    const rel = path.relative(roots[i], absPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { root: roots[i], rootIndex: i };
  }
  return null;
}

// 单个文件进 / 出索引（watcher 事件与重命名都走这里）
async function indexUpsert(absPath) {
  if (!isAnyDocPath(absPath)) return null;
  const owner = ownerRoot(absPath);
  if (!owner) return null;
  try {
    const stat = await fsp.stat(absPath);
    const rec = makeRecord(absPath, owner.root, owner.rootIndex, stat);
    fileIndex.set(absPath, rec);
    return rec;
  } catch {
    fileIndex.delete(absPath);
    return null;
  }
}
function indexRemove(absPath) {
  fileIndex.delete(absPath);
  contentCache.delete(absPath);
}

async function buildIndex() {
  const ignore = getIgnoreSet();
  const maxDepth = getMaxDepth();
  const roots = getScanRoots();
  const next = new Map();
  for (let i = 0; i < roots.length; i++) {
    if (!fs.existsSync(roots[i])) continue;
    await walk(roots[i], roots[i], i, 0, next, ignore, maxDepth);
  }
  fileIndex.clear();
  for (const [k, v] of next) fileIndex.set(k, v);
  indexSignature = currentIndexSignature();
}

// 拿当前启用文档类型下的文件列表。索引不存在 / 配置已变时才真正扫盘
async function getScannedFiles() {
  if (indexSignature !== currentIndexSignature()) {
    // 配置变了：丢掉旧索引，重建（并发调用共用同一次构建）
    indexSignature = null;
  }
  if (indexSignature === null) {
    if (!indexBuilding) {
      indexBuilding = buildIndex().finally(() => { indexBuilding = null; });
    }
    await indexBuilding;
  }
  const out = [];
  for (const rec of fileIndex.values()) {
    if (matchesDocType(rec.name)) out.push(rec);
  }
  return out;
}

// 让索引失效（配置变更 / 结构性改动后调用），下次读取时重建
function invalidateFileIndex() {
  indexSignature = null;
}

async function walk(currentDir, scanRoot, rootIndex, depth, out, ignore, maxDepth) {
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
      await walk(full, scanRoot, rootIndex, depth + 1, out, ignore, maxDepth);
    } else if (entry.isFile() && isAnyDocPath(entry.name)) {
      try {
        out.set(full, makeRecord(full, scanRoot, rootIndex, await fsp.stat(full)));
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

// 顶层分组的稳定身份。
//
// 自动生成的顶层分组对应扫描根下的一个一级目录（file.projectName）。过去它和
// projectName 之间唯一的联系就是"名字恰好相同"——于是用户一旦把分组重命名，
// reconcile 就再也认不出它：新文件进来时按名字找不到 → 又 push 一个自动名的
// 新分组；分组一旦临时变空还会被 pruneEmptyFolders 删掉，下一轮用自动名重建。
// 这就是"一级文件夹改名后刷新就没了、但有时又能存住"的根源（取决于扫描/SSE
// 什么时候回来）。autoFor 把这个联系固定下来，改过名也依然认得。
function autoFolderKey(folder) {
  return folder && typeof folder.autoFor === 'string' ? folder.autoFor : null;
}

// 老数据迁移：给还没有 autoFor 的顶层分组补上。
// 判据是"名字正好等于某个 projectName"——那就是当初自动生成的那一批。
// 用户手工新建的顶层分组匹配不上，保持没有 autoFor（也就不参与自动归类）。
function backfillAutoFor(tree, projectNames) {
  let changed = false;
  for (const n of tree) {
    if (n.type !== 'folder') continue;
    if (typeof n.autoFor === 'string') continue;
    if (projectNames.has(n.name)) {
      n.autoFor = n.name;
      changed = true;
    }
  }
  return changed;
}

// 把"用户给自动分组起的名字"单独记一份到 store.folderAliases。
//
// 为什么不能只存在 store.tree 里：那个名字一旦只活在树结构上，任何让分组从树上
// 消失的操作都会把它一起带走——归档（/api/archive 直接 filter 掉整个分组）、
// 被当成空壳回收、前端整树覆盖。存成一条独立的偏好之后，reconcile 重建分组时
// 能把名字取回来，改名就不再依赖树结构的存续。
function syncFolderAliases(store, tree) {
  if (!store.folderAliases || typeof store.folderAliases !== 'object') {
    store.folderAliases = {};
  }
  for (const n of tree) {
    if (!n || n.type !== 'folder') continue;
    const key = autoFolderKey(n);
    if (key === null) continue;
    if (n.name === key) delete store.folderAliases[key];  // 改回原名 = 清除这条偏好
    else store.folderAliases[key] = n.name;
  }
}

// 自动分组该显示什么名字：用户起过名就用它，否则用项目目录名
function autoFolderDisplayName(store, projectName) {
  const alias = store.folderAliases && store.folderAliases[projectName];
  return (typeof alias === 'string' && alias) ? alias : projectName;
}

// 空分组要不要留下来。
//
// 只有"自动生成、且用户没动过名字"的空壳才该被回收——那是扫描的副产物，
// 没有展示价值。另外两类都代表用户的投入，删掉就是丢数据：
//   · 改过名的自动分组：一时变空是常态（AI 覆盖写文件会先 unlink 再 add、
//     扫描根短暂不可达、切换 docTypes 都会让分组瞬时清空），一旦删掉那个名字
//     就永久丢了，下一轮只会按 projectName 重建一个自动名的新分组。
//   · 手工新建的分组（没有 autoFor）：POST /api/folders/new 建出来时本来就是
//     空的，原先会在下一次 /api/state 被清掉，用户看到的是"新建分组立刻消失"。
function shouldKeepEmptyFolder(folder) {
  const key = autoFolderKey(folder);
  if (key === null) return true;      // 手工建的，留
  return folder.name !== key;         // 自动建的：只有改过名才留
}

// 自底向上递归丢弃空的虚拟文件夹（判据见 shouldKeepEmptyFolder）
function pruneEmptyFolders(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'folder') {
      n.children = pruneEmptyFolders(n.children || []);
      if (n.children.length === 0 && !shouldKeepEmptyFolder(n)) continue;
    }
    out.push(n);
  }
  return out;
}

// 归档过滤：projectName 落在 store.archivedProjects 里的文件视为"从看板隐藏"。
//
// 树、统计、未读、搜索、快速打开必须共用这一个可见集合。历史上只有 reconcile
// 过滤了归档、而 /api/state 的 fileMap 用的是全量 scanned，于是出现一个自相
// 矛盾的状态：侧边栏树里看不到归档文档，但底栏仍把它们算成未读，点"全部标为
// 已读"也清不掉（那个接口走的是已过滤的 store.tree）。
function visibleFiles(scanned, store) {
  const archived = new Set(store.archivedProjects || []);
  if (archived.size === 0) return scanned;
  return scanned.filter(f => !archived.has(f.projectName));
}

function reconcile(store, scanned) {
  migrateLegacyRootFolders(store.tree);

  // 归档的 file 跳过——既不进 scannedSet（也就不会被 prune 留下来），
  // 也不会被 reconcile 重建出 folder
  const visibleScanned = visibleFiles(scanned, store);

  const scannedSet = new Set(visibleScanned.map(f => f.path));
  store.tree = pruneMissing(store.tree, scannedSet);

  // 先给历史数据补上 autoFor（见 backfillAutoFor 的注释），后面的匹配才认得
  // 那些在这个字段出现之前就已经存在的顶层分组
  backfillAutoFor(store.tree, new Set(visibleScanned.map(f => f.projectName)));

  const existing = new Set();
  collectFilePaths(store.tree, existing);

  const newFiles = visibleScanned.filter(f => !existing.has(f.path));
  newFiles.sort((a, b) => b.mtime - a.mtime);

  for (const file of newFiles) {
    const folderName = file.projectName;
    // 先按 autoFor 认领（改过名的分组也能认出来，这是关键），
    // 再退回按名字认领没有 autoFor 的分组（用户手工建的同名分组，沿用旧行为）
    let folder = store.tree.find(n => n.type === 'folder' && autoFolderKey(n) === folderName)
      || store.tree.find(n => n.type === 'folder' && autoFolderKey(n) === null && n.name === folderName);
    if (!folder) {
      // 名字优先取用户起过的那个（见 syncFolderAliases）：分组可能是被归档、
      // 被误回收之后重建的，这时不该退回自动名
      folder = {
        id: genId(), type: 'folder', name: autoFolderDisplayName(store, folderName),
        autoFor: folderName, collapsed: false, children: [],
      };
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
        // autoFor 可选，但给了就必须是字符串：它是自动归类的身份键
        // （见 autoFolderKey），类型错了会让 reconcile 认错分组
        if (n.autoFor !== undefined && typeof n.autoFor !== 'string') return false;
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

let watchers = new Map();   // root → chokidar watcher（增量增删，见 startWatchers）
function buildIgnoredFn() {
  const ignore = getIgnoreSet();
  return (p) => {
    const base = path.basename(p);
    if (base.startsWith('.')) return true;
    if (ignore.has(base)) return true;
    // 跳过明显不是 HTML 也不可能含 HTML 的特殊文件，避免 chokidar 试图监视它们时频繁 EUNKNOWN
    if (base.endsWith('.sock') || base.endsWith('.lock') || base.endsWith('.pid')) return true;
    return false;
  };
}

// 为单个扫描根创建 watcher。抽出来是为了支持增量增删（见 startWatchers）
function createWatcher(root, ignoredFn) {
    const watcher = chokidar.watch(root, {
      ignored: ignoredFn,
      ignoreInitial: true,
      depth: getMaxDepth(),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      persistent: true,
    });

    const onEvent = (kind) => async (filePath) => {
      // 索引维护对所有文档类型都做（html + md），与当前启用的 docTypes 无关：
      // 这样在设置里切换文档类型不需要重新扫盘。
      if (!isAnyDocPath(filePath)) return;

      if (kind === 'unlink') {
        indexRemove(filePath);
        // 文件没了，它的 diff 底本也没有留存价值——顺手清掉，别让 versions/ 无限长
        try { versionStore.removeAllFor(filePath); } catch {}
        const st = loadStore();
        if (st.seenVersions && st.seenVersions[filePath]) {
          delete st.seenVersions[filePath];
          saveStore(st);
        }
      } else {
        await indexUpsert(filePath);
      }

      // 但对外通知（未读标记 / SSE 推送）只针对当前启用的类型
      if (!matchesDocType(path.basename(filePath))) return;

      let mtime = 0;
      try { mtime = (await fsp.stat(filePath)).mtimeMs; } catch {}
      const rel = path.relative(root, filePath);
      const segments = rel.split(path.sep);
      const projectName = segments.length > 1 ? segments[0] : path.basename(root);

      // 归档分组一律不对外通知、也不标未读：它在看板里已经不存在了，
      // 弹一条"文档已更新"只会让人去树里找一篇找不到的文档
      const store = loadStore();
      if ((store.archivedProjects || []).includes(projectName)) return;

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
    return watcher;
}

// 同步 watcher 到当前 scanRoots。
//   full=false（默认，仅 scanRoots 变动）：只给新增的根建 watcher、只关掉被移除的，
//     保留不变的根不动。这很关键——chokidar 为大目录（含 node_modules 等）建立监听
//     要同步遍历数十秒并卡住事件循环，期间浏览器所有请求都被拖慢，加一个扫描根
//     就会让整个 dashboard 假死。
//   full=true（ignore / maxDepth 变动）：这些选项作用于每个 watcher 自身，只能全部重建。
function startWatchers({ full = true } = {}) {
  const ignoredFn = buildIgnoredFn();
  const targets = getScanRoots().filter(r => fs.existsSync(r));

  if (full) {
    for (const w of watchers.values()) w.close().catch(() => {});
    watchers.clear();
  } else {
    for (const [root, w] of [...watchers]) {
      if (!targets.includes(root)) {
        w.close().catch(() => {});
        watchers.delete(root);
      }
    }
  }

  for (const root of targets) {
    if (watchers.has(root)) continue;   // 已在监听，保持原 watcher 不动
    watchers.set(root, createWatcher(root, ignoredFn));
  }
}

const app = express();
// 上限要高于各路由自己的内容上限（save-md 是 5MB），否则请求会先被 body parser
// 以一个含义不清的 413 挡掉，路由里那句"内容过大"的提示根本走不到
const JSON_BODY_LIMIT_MB = 8;
app.use(express.json({ limit: `${JSON_BODY_LIMIT_MB}mb` }));
// 把 body parser 的错误翻译成 JSON，前端才能拿到可读信息
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体超过 ${JSON_BODY_LIMIT_MB}MB 上限` });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  return next(err);
});

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

// /raw/<扫描根序号>/<相对路径> → 直接服务磁盘文件。
//
// 扫描根可以在运行时增删，所以这里的映射必须能重建。原来的做法是每次
// app.use() 一批新的 static 中间件、再从 app._router.stack 里 splice 掉旧的
// ——依赖 Express 的内部结构，Express 5 已经把 app._router 移除了，静默失效。
// 现在只注册一个稳定入口，真正的 handler 放在数组里按序号查表。
let rawHandlers = [];
function mountRawRoutes() {
  rawHandlers = getScanRoots().map(root => express.static(root, {
    setHeaders(res) { res.setHeader('Cache-Control', 'no-store'); },
  }));
}
mountRawRoutes();

app.use('/raw', (req, res, next) => {
  // 这里的 req.url 形如 /0/proj/a.html（Express 已经剥掉了 /raw 前缀）
  const m = /^\/(\d+)(\/[\s\S]*)?$/.exec(req.url);
  if (!m) return next();
  const handler = rawHandlers[Number(m[1])];
  if (!handler) return next();
  const originalUrl = req.url;
  req.url = m[2] || '/';
  handler(req, res, (err) => {
    req.url = originalUrl;   // 没命中就还原，交给后面的路由
    next(err);
  });
});

// 全文搜索：HTML 内容缓存（按 mtime 失效）+ 简单 contains 匹配
// path → { mtime, text, lower, usedAt }
//   text  = 归一化空白后的原文（保留大小写，给 snippet 用）
//   lower = 同一份的小写副本（给 indexOf 匹配用）
// 为什么两份都留：原来只存小写，snippet 也就只能是小写的，
// 英文正文摘要看起来像坏了（"README" 显示成 "readme"）。
// 代价是内存翻倍，但 LRU 上限 500 个文件，可接受。
const contentCache = new Map();

// 文件集合发生结构性变化（配置改动）后调用：丢弃派生缓存 + 让文件索引重建
function invalidateIndex() {
  contentCache.clear();
  invalidateFileIndex();
}
// 返回 { text, lower }：text 保留原始大小写，lower 用于匹配
async function getFileText(filePath, mtime) {
  const cached = contentCache.get(filePath);
  if (cached && cached.mtime === mtime) {
    cached.usedAt = Date.now();   // LRU 淘汰用
    return cached;
  }
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    let text;
    if (docTypeOfPath(filePath) === 'md') {
      // Markdown 基本就是纯文本，直接归一化空白即可
      text = raw.replace(/\s+/g, ' ');
    } else {
      text = raw
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ');
    }
    // toLowerCase() 对少数字符会改变长度（如 'İ' → 'i̇'），一旦长度不等，
    // 用 lower 里的下标去切 text 就会错位。这种情况直接让两者都用小写版，
    // 摘要丑一点也比切歪了强。
    let lower = text.toLowerCase();
    if (lower.length !== text.length) text = lower;
    const entry = { mtime, text, lower, usedAt: Date.now() };
    contentCache.set(filePath, entry);
    return entry;
  } catch {
    return { text: '', lower: '' };
  }
}

// 查询词切分：空白分隔的多个关键词按 AND 组合（"配网 转化率" = 两个词都要出现）。
// 用引号可以把含空格的短语当成一个词："error rate"
function parseQueryTerms(q) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    const t = (m[1] || m[2] || '').trim();
    if (t) terms.push(t);
  }
  return terms;
}

// 单字符 ASCII（'a'/'e'）匹配面太广没意义；非 ASCII（中日韩）单字通常是有意义的词
function termIsSearchable(t) {
  if (!t) return false;
  return /^[\x00-\x7F]+$/.test(t) ? t.length >= 2 : true;
}

// 数一个词在正文里出现多少次（不重叠）。上限 200：显示成「200+ 处」就够了，
// 常见词在长文档里能有上千处，全数完纯属浪费
function countOccurrences(hay, needle, cap = 200) {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  let idx;
  while ((idx = hay.indexOf(needle, from)) !== -1) {
    n++;
    if (n >= cap) break;
    from = idx + needle.length;
  }
  return n;
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  // 空查询与"没有可搜的词"（单个 ASCII 字符匹配面太广）都返回空集，
  // 且字段形状和正常返回保持一致，客户端不用做 undefined 判断
  if (q.length === 0) return res.json({ matches: [], terms: [], truncated: false });
  const terms = parseQueryTerms(q).filter(termIsSearchable);
  if (terms.length === 0) return res.json({ matches: [], terms: [], truncated: false });
  // limit：⌘K 快速打开只需要前几十条，没必要把 800 个命中全序列化回去。
  // 不传则不限，保持侧栏搜索"过滤整棵树"的语义不变。
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : Infinity;
  try {
    // 按修改时间倒序再扫。带 limit 时循环会在攒够条数后提前 break，
    // 若按扫描顺序走，返回的就是"目录里碰巧排在前面的 25 篇"——等于随机。
    // 按 mtime 倒序则是"最近改过的那些里含这个词的"，符合这个工具的前提：
    // AI 刚动过的文档最可能是你在找的。
    // 不带 limit（侧栏搜索）时要读完全部文件，顺序不影响结果集，只是稳定了输出次序。
    // 归档的文档要一并排除：它们在树里、统计里都不存在，正文搜索却把它们捞
    // 出来的话，前端拿 state.files 查不到条目，命中就变成一条点不开的死结果
    const scanned = visibleFiles(await getScannedFiles(), loadStore()).slice()
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    const matches = [];
    let truncated = false;
    for (const f of scanned) {
      const { text, lower } = await getFileText(f.path, f.mtime);
      // AND：所有关键词都要命中
      let firstIdx = -1;
      let firstLen = 0;
      let all = true;
      for (const t of terms) {
        const idx = lower.indexOf(t);
        if (idx < 0) { all = false; break; }
        if (firstIdx < 0 || idx < firstIdx) { firstIdx = idx; firstLen = t.length; }
      }
      if (!all || firstIdx < 0) continue;
      if (matches.length >= limit) { truncated = true; break; }
      const start = Math.max(0, firstIdx - 35);
      const end = Math.min(text.length, firstIdx + firstLen + 35);
      // 从 text 切（保留原始大小写），下标来自 lower —— 两者等长由 getFileText 保证
      const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
      // 命中处数按第一个关键词算：多词 AND 时它最能代表"这篇里有多少地方提到"
      const count = countOccurrences(lower, terms[0]);
      matches.push({ path: f.path, snippet, count });
    }
    // GC：缓存大于 500 个文件时按最久未访问淘汰一半
    // （原来按 mtime 排序淘汰，等于优先丢掉最稳定、最该留着的老文件）
    if (contentCache.size > 500) {
      const all = [...contentCache.entries()].sort((a, b) => (a[1].usedAt || 0) - (b[1].usedAt || 0));
      for (let i = 0; i < all.length / 2; i++) contentCache.delete(all[i][0]);
    }
    res.json({ matches, terms, truncated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/state', async (_req, res) => {
  try {
    const scanned = await getScannedFiles();
    const store = loadStore();
    // 只在 reconcile 真的改动了树结构时才落盘。原来是无条件 saveStore()，
    // 而 /api/state 每 60s 就被调用一次——等于每分钟无意义地重写一遍 store.json
    const treeBefore = JSON.stringify(store.tree);
    reconcile(store, scanned);
    let storeDirty = JSON.stringify(store.tree) !== treeBefore;

    // 两个集合，用途严格分开：
    //   diskPaths —— 磁盘上真实存在的全部文档，只用于"剪掉已消失的记录"这类清理。
    //                归档只是隐藏，文件还在，不能因为归档就把用户的收藏/标签删掉。
    //   visible   —— 看板可见的文档，返回给前端的一切（fileMap / favorites /
    //                allTags / recent）都只认它，和侧边栏树保持同一口径。
    const diskPaths = new Set(scanned.map(f => f.path));
    const visible = visibleFiles(scanned, store);
    // 底本 / 版本历史相关的字段（含必要的内容核对），见 buildVersionMeta
    const versionMeta = buildVersionMeta(store, visible);

    const fileMap = {};
    for (const f of visible) {
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
        // 只看 store 里有没有登记（内存判断，免费）。不在这里 stat 底本文件——
        // 那是每个文件一次 syscall，几百篇文档就把 /api/state 拖回去了
        hasBaseline: versionMeta[f.path].hasBaseline,
        baselineAt: versionMeta[f.path].baselineAt,
        // 当前内容是否和最新底本逐字节相同。顶栏那个"有改动"提示要靠它，
        // 不能只看 mtime —— 详见下面 buildVersionMeta 的注释
        baselineSame: versionMeta[f.path].baselineSame,
        versionCount: versionMeta[f.path].versionCount,
        favorite: !!(store.favorites && store.favorites[f.path]),
        favoritedAt: (store.favorites && store.favorites[f.path]) || 0,
        tags: (store.tags && Array.isArray(store.tags[f.path])) ? store.tags[f.path] : [],
      };
    }

    // 可见集合：下面的 favorites / allTags / recent 都按它过滤后再发给前端
    const allPaths = new Set(visible.map(f => f.path));
    // 清理 recent 里已消失的文件。判断用 diskPaths 而不是 allPaths——归档只是
    // 隐藏，不该把归档分组的条目从 recent 里永久剔掉，取消归档后它得原样回来
    if (Array.isArray(store.recent)) {
      const cleaned = store.recent.filter(p => diskPaths.has(p));
      if (cleaned.length !== store.recent.length) {
        store.recent = cleaned;
        storeDirty = true;
      }
    }
    // 收藏 / 标签的惰性清理：文件被删掉时 chokidar 的 unlink 回调不动这两个字段
    // （那样每个 unlink 都要 loadStore+saveStore，批量删除会连着打很多次盘），
    // 统一在这里剪。
    //
    // 关于 syscall：上面 fileMap 那圈明确不许 stat，这里的 existsSync 不违背它——
    // 遍历的是"用户手工收藏 / 打过标签的条目"（十几到几十条），而且只有条目不在
    // 本次扫描结果里时才会真的落到 existsSync。稳定状态下一次 syscall 都不发生。
    for (const field of ['favorites', 'tags']) {
      const map = store[field];
      if (!map || typeof map !== 'object') continue;
      let changed = false;
      for (const p of Object.keys(map)) {
        if (diskPaths.has(p)) continue;
        // 不在扫描结果里有两种可能：文件真被删了（该清），或只是当前 docTypes
        // 没启用它（不该清——用户在设置里取消勾选 Markdown，不代表要丢掉 md 的收藏）。
        // 收藏和标签是用户手工投入的信息，误删的代价远高于留一条僵尸记录。
        if (fs.existsSync(p)) continue;
        delete map[p];
        changed = true;
      }
      if (changed) storeDirty = true;
    }
    if (storeDirty) saveStore(store);

    // 收藏夹：按收藏时间倒序（最近收藏的在最前），只含当前可见的文件
    const favorites = Object.entries(store.favorites || {})
      .filter(([p]) => allPaths.has(p))
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .map(([p]) => p);
    const allTags = collectTagCounts(store, allPaths);

    // 归档列表：给每个归档的 projectName 附带磁盘上的实际文件数（让用户决定要不要恢复）
    const projCounts = countByProject(scanned);
    const archivedProjects = (store.archivedProjects || []).map(name => ({
      name,
      count: projCounts.get(name) || 0,
    }));

    res.json({
      tree: store.tree,
      files: fileMap,
      // recent 在 store 里保留归档项，但只把可见的发给前端
      recent: (store.recent || []).filter(p => allPaths.has(p)),
      favorites,
      allTags,
      scanRoots: getScanRoots(),
      // 可见文档数，和 files 的口径一致（不含归档分组）
      scannedCount: visible.length,
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
  // 用户对自动分组的重命名要单独留一份，别只依赖树结构（见 syncFolderAliases）
  syncFolderAliases(store, store.tree);
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
    expiresAt: entry.expiresAt || null,
    scope: entry.scope === 'dir' ? 'dir' : 'refs',
    urls: buildShareUrls(token, entry.path),
  };
}

// 允许的有效期档位（分钟）。0 = 永不过期
const SHARE_TTL_CHOICES = [0, 30, 120, 1440];
const SHARE_TTL_DEFAULT = 120;

// 资源白名单缓存：path → { mtime, allow }
// 按入口文件 mtime 失效，这样编辑文档后新引用的图片能立刻放行
const shareAllowCache = new Map();
async function getShareAllowlist(entry) {
  const baseDir = path.dirname(entry.path);
  const entryRel = path.basename(entry.path);
  let mtime = 0;
  try { mtime = (await fsp.stat(entry.path)).mtimeMs; } catch {}
  const cached = shareAllowCache.get(entry.path);
  if (cached && cached.mtime === mtime) return cached.allow;
  const allow = await share.buildAllowlist(
    { readFile: (p) => fsp.readFile(p, 'utf8') },
    baseDir,
    entryRel,
  );
  shareAllowCache.set(entry.path, { mtime, allow });
  return allow;
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
  // 有效期：默认 2 小时。README 里写的是"暂时发布到局域网"，但原来 token
  // 永不过期还跨重启保留，和"暂时"完全不符
  let ttl = req.body && req.body.ttlMinutes;
  ttl = SHARE_TTL_CHOICES.includes(Number(ttl)) ? Number(ttl) : SHARE_TTL_DEFAULT;
  const scope = (req.body && req.body.scope) === 'dir' ? 'dir' : 'refs';

  const store = loadStore();
  // 同一个文件如果已经在分享，复用旧 token（避免每次按按钮都换 URL），
  // 但按本次选择刷新有效期与范围
  const existing = Object.entries(store.shares || {})
    .find(([, v]) => v && v.path === filePath && !share.isExpired(v));
  const token = existing ? existing[0] : share.genToken();
  const now = Date.now();
  store.shares[token] = {
    path: filePath,
    sharedAt: existing ? (existing[1].sharedAt || now) : now,
    expiresAt: ttl > 0 ? now + ttl * 60_000 : null,
    scope,
  };
  saveStore(store);
  shareAllowCache.delete(filePath);   // 范围可能变了，重算白名单
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
  // 顺手把已过期的条目从 store 里清掉，别让它无限堆积
  let pruned = false;
  for (const [token, v] of Object.entries(store.shares || {})) {
    if (!v || !v.path || share.isExpired(v)) {
      delete store.shares[token];
      pruned = true;
    }
  }
  if (pruned) saveStore(store);
  const list = Object.entries(store.shares || {})
    .filter(([, v]) => v && v.path && fs.existsSync(v.path))
    .sort((a, b) => (b[1].sharedAt || 0) - (a[1].sharedAt || 0))
    .map(([token, v]) => shareEntryPublic(token, v));
  res.json({
    shares: list,
    lanIps: share.getLanIPs(),
    port: PORT,
    ttlChoices: SHARE_TTL_CHOICES,
    ttlDefault: SHARE_TTL_DEFAULT,
  });
});

// 公开访问入口：/share/:token → 重定向到 /share/:token/<原文件名>
// 这样 HTML 里的相对资源（./style.css）浏览器会自动拼成 /share/:token/style.css，命中下面的资源 handler
// 分享失效页：统一文案，不区分"不存在 / 已过期 / 已停止"，避免向外部泄漏细节
function shareGonePage(res, reason) {
  return res.status(410).type('html').send(
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>链接已失效</title>'
    + '<style>body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;color:#444;'
    + 'background:#f6f7f9;display:flex;align-items:center;justify-content:center;height:100vh;'
    + 'margin:0;padding:2rem;text-align:center;line-height:1.6}main{max-width:460px}'
    + 'h1{font-size:18px;margin:0 0 10px}p{font-size:14px;color:#666;margin:0}</style>'
    + '</head><body><main><h1>链接已失效</h1>'
    + `<p>${markdown.escapeHtml(reason || '这个分享链接已过期或被作者停止。')}</p>`
    + '</main></body></html>',
  );
}

app.get('/share/:token', (req, res) => {
  const store = loadStore();
  const entry = store.shares && store.shares[req.params.token];
  if (!entry) return shareGonePage(res);
  if (share.isExpired(entry)) return shareGonePage(res, '分享已到期。请让作者重新生成链接。');
  if (!fs.existsSync(entry.path)) return shareGonePage(res, '源文件已不存在。');
  return res.redirect(302, `/share/${req.params.token}/${encodeURIComponent(path.basename(entry.path))}`);
});

// 资源服务：/share/:token/<相对路径> → 服务 HTML 同目录子树
// 严格防 path traversal——只能访问 baseDir 及其子目录
app.get('/share/:token/*', async (req, res) => {
  const token = req.params.token;
  const store = loadStore();
  const entry = store.shares && store.shares[token];
  if (!entry) return shareGonePage(res);
  if (share.isExpired(entry)) return shareGonePage(res, '分享已到期。请让作者重新生成链接。');
  if (!fs.existsSync(entry.path)) return shareGonePage(res, '源文件已不存在。');

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

  // 默认只放行文档真正引用到的资源。
  // 不这么做的话，分享 ~/Documents/report.html 等于把整个 ~/Documents/
  // 开放给局域网内拿到 token 的人——token 猜不到，但转发出去就是全量访问权。
  if (entry.scope !== 'dir') {
    const allow = await getShareAllowlist(entry);
    const wanted = path.relative(baseDir, resolved.abs).split(path.sep).join('/');
    if (!allow.has(wanted)) {
      return res.status(403).type('html').send(
        '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>403</title>'
        + '<style>body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;color:#444;'
        + 'background:#f6f7f9;display:flex;align-items:center;justify-content:center;height:100vh;'
        + 'margin:0;padding:2rem;text-align:center;line-height:1.6}main{max-width:460px}'
        + 'h1{font-size:18px;margin:0 0 10px}p{font-size:13px;color:#666;margin:0}</style>'
        + '</head><body><main><h1>这个文件不在分享范围内</h1>'
        + '<p>分享只放行文档本身引用到的资源。如果页面缺图，请让作者在分享面板里把范围改成「同目录全部资源」。</p>'
        + '</main></body></html>',
      );
    }
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
  // 同步把对应的顶层 folder 立即拿掉，UI 不用等下次扫描。
  // 按 autoFor 认领而不是按名字：用户改过名的分组照样要能归档
  // （原来只比 n.name === name，改过名的分组归档后仍留在树里）
  store.tree = (store.tree || []).filter(n => !(
    n.type === 'folder'
    && (autoFolderKey(n) === name || (autoFolderKey(n) === null && n.name === name))
  ));
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

// store.seenVersions[path] 的历史形态是单个 { file, hash, at }，现在是一个数组
// （最近的排在最前）。读的时候统一成数组，老数据不需要额外迁移步骤。
function versionsOf(store, filePath) {
  const v = store.seenVersions && store.seenVersions[filePath];
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(x => x && typeof x.file === 'string');
  if (typeof v === 'object' && typeof v.file === 'string') return [v];   // 老格式
  return [];
}

// 每个文件在 store 里保留几份版本记录。和 versionStore.KEEP_PER_FILE 对齐——
// 磁盘上只留那么多份快照，store 里记更多也读不到。
const KEEP_VERSIONS = versionStore.KEEP_PER_FILE;

// 记录"用户看过某个版本"，同时留一份底本供之后 diff。
// 这是 diff 视图的地基：只有在用户看过的那一刻存下内容，之后 AI 改了文件
// 才有东西可比——事后再想补是补不回来的。
//
// 为什么要留一条历史而不是只留最新一份：打开文档时就会刷新底本，可"打开文档"
// 恰恰是用户想去看变更的那个动作——只留一份的话，对比基准会被这个动作自己刷掉，
// 于是点开对比永远显示"没有变更"，想看的那次差异被吃掉了。有了历史，即使最新
// 一份等于当前内容，也还能和上一个内容不同的版本对比（见 /api/diff 的选版逻辑）。
//
// 内容没变就不追加，只保留原来那份：这样列表是"内容变化的历史"，
// 而不是"打开了多少次"的历史，也才对得上用户说的"最近几次修改记录"。
// ack（acknowledged）区分这份底本是怎么来的，它决定 /api/diff 默认拿哪一版比：
//   · false —— 打开文档时自动记的。用户还没看过差异，所以不能拿它当基准
//     （那只会得到空 diff，想看的变更就被"打开"这个动作吃掉了）。
//   · true  —— 用户明确表过态：点了「标记为已看过」、执行了回退、或在 Atlas 里
//     保存了编辑。这时"没有变更"正是他期望看到的结果。
function recordSeenVersion(store, filePath, opts = {}) {
  const ack = !!opts.ack;
  const snap = versionStore.snapshot(filePath);
  if (!snap.ok) return snap;
  if (!store.seenVersions || typeof store.seenVersions !== 'object') store.seenVersions = {};
  const list = versionsOf(store, filePath);
  if (list.length && list[0].hash === snap.hash) {
    // 内容与最新一份相同：保留原来的 at，那才是"第一次看到这个内容"的时间。
    // 但这次若是用户明确确认，要把标记升上去——否则「标记为已看过」会失效
    // （打开文档时已经记过同样内容的一份，accept 会走进这个分支）。
    if (ack && !list[0].ack) list[0] = { ...list[0], ack: true };
    store.seenVersions[filePath] = list;
    return snap;
  }
  list.unshift({ file: snap.file, hash: snap.hash, at: snap.at, ack });
  store.seenVersions[filePath] = list.slice(0, KEEP_VERSIONS);
  return snap;
}

// 给每个可见文件算出底本 / 版本相关的字段。
//
// 重点是 baselineSame。顶栏「这个文档自上次查看后有改动」原来只比 mtime
// （file.mtime > baselineAt），可 mtime 前进并不等于内容变了 —— AI 用相同内容
// 重新生成一遍文档、touch、网盘同步都会让 mtime 往前跳。于是就有了那个矛盾：
// 提示说有更新，点开对比却说"和你上次看到的内容完全一致"。一边看时间、一边看
// 内容，两者从来没对过账。
//
// 这里把账对上，但只对候选文件做：有底本、且 mtime 比底本新。这个集合是"用户
// 打开过、之后又被写过"的文件，通常只有个位数到几十个，远小于全量；结果还按
// mtime 缓存，同一个版本只算一次 sha1。所以 fileMap 那圈"不许 stat"的约束
// 并没有被破坏。
function buildVersionMeta(store, files) {
  const out = {};
  for (const f of files) {
    const list = versionsOf(store, f.path);
    const latest = list[0] || null;
    // baselineSame 的含义是"当前内容与最新底本一致"。
    // mtime 不比底本新时直接判定一致，不读盘：那本来就是底本记下的那份内容。
    // 只有 mtime 前进了才真的核对一次 —— 那正是"时间变了但内容可能没变"的
    // 可疑区间，也就是假警报的来源。
    let baselineSame = !!latest;
    if (latest && f.mtime > (latest.at || 0)) {
      const h = currentContentHash(f.path, f.mtime);
      baselineSame = !!(h && h === latest.hash);
    }
    out[f.path] = {
      hasBaseline: list.length > 0,
      baselineAt: latest ? (latest.at || 0) : 0,
      baselineSame,
      versionCount: list.length,
    };
  }
  return out;
}

// 当前磁盘内容的 sha1，按 mtime 缓存。
//
// 用途是给"有更新"提示做内容核对（见 /api/state 里 baselineSame 的注释）。
// 缓存是必须的：同一个 mtime 下内容不会变，没有它就会在每次 /api/state 反复
// 读同一批文件。只在候选文件上调用，不是全量。
const contentHashCache = new Map();
function currentContentHash(filePath, mtime) {
  const c = contentHashCache.get(filePath);
  if (c && c.mtime === mtime) return c.hash;
  let hash = null;
  try { hash = versionStore.sha1(fs.readFileSync(filePath)); } catch {}
  if (hash) {
    // 上限兜底：长期运行 + 大量文件时别让它无限长
    if (contentHashCache.size > 500) contentHashCache.clear();
    contentHashCache.set(filePath, { mtime, hash });
  }
  return hash;
}

app.post('/api/seen', (req, res) => {
  const filePath = req.body && req.body.path;
  if (!filePath || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  const store = loadStore();
  let mtime = 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch {}
  store.seen[filePath] = markSeenAt(mtime);
  pushRecent(store, filePath);   // 同时更新 recent
  recordSeenVersion(store, filePath);
  saveStore(store);
  res.json({ ok: true, seenAt: store.seen[filePath] });
});

// GET /api/diff?path=<abs>：当前磁盘内容 vs 上次已读版本
app.get('/api/diff', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string' || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const store = loadStore();
  // 磁盘上被淘汰的快照要剔掉：versions/ 每个源文件只留最近几份
  const list = versionsOf(store, filePath).filter(v => versionStore.hasSnapshot(v.file));
  if (!list.length) {
    return res.json({
      hasBaseline: false,
      reason: 'no-baseline',
      message: '还没有可对比的底本。打开过一次之后，Atlas 会记下你看到的版本，下次它被改动就能对比了。',
    });
  }
  try {
    // 读 Buffer 再解码：hash 必须和 versionStore.snapshot 那边算的一致
    // （它是对原始字节做 sha1），先转成字符串再编码回去遇到 BOM / 非法字节会对不上
    const curBuf = await fsp.readFile(filePath);
    const current = curBuf.toString('utf8');
    const curHash = versionStore.sha1(curBuf);

    // 选底本：
    //   · 指定了 version 就用那一份（用户在面板里挑了某个历史版本）
    //   · 否则自动挑「第一个内容不同于当前磁盘内容的版本」。这一条是关键：
    //     打开文档时会记一份等于当前内容的底本，直接拿最新那份比只会得到空 diff
    //     —— 那正是"提示有更新、点开却说没变更"的另一半原因。
    const wanted = typeof req.query.version === 'string' && req.query.version ? req.query.version : null;
    let picked;
    if (wanted) {
      picked = list.find(v => v.file === wanted);
      if (!picked) return res.status(404).json({ error: '这个版本已经不在留存范围内' });
    } else if (list[0].ack) {
      // 最新一份是用户明确确认过的（标记为已看过 / 回退 / 站内保存）：
      // 就以它为基准，此时"没有变更"正是用户期望的结果
      picked = list[0];
    } else {
      picked = list.find(v => v.hash !== curHash) || list[0];
    }

    const baseline = versionStore.readSnapshot(picked.file);
    if (baseline == null) {
      return res.json({ hasBaseline: false, reason: 'baseline-unreadable', message: '底本读取失败。' });
    }
    // 注意不能写 `parseInt(...) || 3`：context=0 是合法值，会被 || 吃掉变成 3
    const rawCtx = parseInt(req.query.context, 10);
    const context = Number.isFinite(rawCtx) ? Math.min(10, Math.max(0, rawCtx)) : 3;
    const result = diffLib.diffText(baseline, current, { context });
    res.json({
      hasBaseline: true,
      baselineAt: picked.at || null,
      version: picked.file,
      versions: list.map(v => ({
        file: v.file,
        at: v.at || 0,
        isCurrent: v.hash === curHash,
      })),
      ...result,
    });
  } catch (e) {
    res.status(500).json({ error: e && e.message || String(e) });
  }
});

// POST /api/revert：把文件回退到某个历史版本。
//
// 这是 Atlas 少数会写用户文件的操作，所以严格走编辑保存那条路：先备份到
// backups/，再临时文件 + rename 原子写回，并登记 selfWrite —— 不登记的话
// watcher 会把 Atlas 自己的写入当成外部变更，回退完立刻又亮起未读红点。
app.post('/api/revert', async (req, res) => {
  const { path: filePath, version } = req.body || {};
  if (!filePath || typeof filePath !== 'string' || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: '缺少 version' });
  }
  const store = loadStore();
  const picked = versionsOf(store, filePath).find(v => v.file === version);
  if (!picked || !versionStore.hasSnapshot(picked.file)) {
    return res.status(404).json({ error: '这个版本已经不在留存范围内' });
  }
  const content = versionStore.readSnapshot(picked.file);
  if (content == null) {
    return res.status(500).json({ error: '底本读取失败' });
  }
  try {
    let backupPath = null;
    try { backupPath = editBackup.backup(filePath); } catch {}
    const tmp = filePath + '.atlas-tmp';
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, filePath);
    const stat = await fsp.stat(filePath);
    markSelfWrite(filePath, stat.mtimeMs);
    contentHashCache.delete(filePath);

    // 回退后的内容就是用户此刻看到的：标为已读，并把它记成最新底本。
    // ack: true —— 这是用户主动做的改动，不该在下次对比时被当成"别人的变更"
    const st = loadStore();
    st.seen[filePath] = markSeenAt(stat.mtimeMs);
    recordSeenVersion(st, filePath, { ack: true });
    saveStore(st);

    res.json({ ok: true, mtime: stat.mtimeMs, backup: backupPath, revertedTo: picked.at || 0 });
  } catch (e) {
    console.error('revert 失败:', e);
    res.status(500).json({ error: e && e.message || String(e) });
  }
});

// POST /api/diff/accept：把当前内容设为新底本（"这些改动我看过了"）
app.post('/api/diff/accept', (req, res) => {
  const filePath = req.body && req.body.path;
  if (!filePath || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const store = loadStore();
  // ack: true —— 用户明确说"这些改动我看过了"，之后再点对比就该是干净的
  const snap = recordSeenVersion(store, filePath, { ack: true });
  let mtime = 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch {}
  store.seen[filePath] = markSeenAt(mtime);
  saveStore(store);
  res.json({ ok: true, baselineAt: snap.ok ? snap.at : null });
});

// 全部标为已读。
//
// 走"当前可见的扫描结果"而不是 store.tree：tree 会滞后于磁盘（刚落地、还没被
// reconcile 收进树的新文件就不在里面），按 tree 标会漏掉它们，用户看到的就是
// "点了全部标为已读，底栏还剩几篇未读"。归档分组的文件不在看板里，也不参与。
app.post('/api/seen/all', async (_req, res) => {
  try {
    const scanned = await getScannedFiles();
    const store = loadStore();
    for (const f of visibleFiles(scanned, store)) {
      store.seen[f.path] = markSeenAt(f.mtime);
    }
    saveStore(store);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 清除「最近打开」列表。只清 store.recent——seen / seenVersions / favorites / tags
// 一个都不碰：用户要的是抹掉浏览痕迹，不是把阅读状态重置回未读。
app.post('/api/recent/clear', (_req, res) => {
  const store = loadStore();
  const cleared = (store.recent || []).length;
  store.recent = [];
  saveStore(store);
  res.json({ ok: true, cleared });
});

app.post('/api/unseen', (req, res) => {
  const filePath = req.body && req.body.path;
  if (!filePath) return res.status(400).json({ error: '缺少 path' });
  const store = loadStore();
  delete store.seen[filePath];
  saveStore(store);
  res.json({ ok: true });
});

// 重命名磁盘上的文件。备注名（alias）只是显示层的别名，改不了真实文件名，
// 而 AI 生成的 `report-final-v3-copy.html` 这类名字用户往往就是想改掉本体。
// 只允许在同目录内改名（不做移动），并把 store 里挂在旧路径上的状态一起迁移。
app.post('/api/rename', async (req, res) => {
  const { path: filePath, name } = req.body || {};
  if (!filePath || typeof filePath !== 'string' || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  const raw = (name || '').toString().trim();
  if (!raw) return res.status(400).json({ error: '文件名不能为空' });
  // 只接受纯文件名：禁止路径分隔符、上跳、控制字符与 Windows 保留字符
  if (/[\\/]/.test(raw) || raw === '.' || raw === '..') {
    return res.status(400).json({ error: '文件名不能包含路径分隔符' });
  }
  if (/[\x00-\x1f<>:"|?*]/.test(raw)) {
    return res.status(400).json({ error: '文件名包含非法字符' });
  }
  if (Buffer.byteLength(raw, 'utf8') > 240) {
    return res.status(400).json({ error: '文件名过长' });
  }
  // 扩展名必须仍属于当前支持的文档类型，否则改完就从看板里消失了
  if (!matchesDocType(raw)) {
    return res.status(400).json({
      error: `扩展名需要是 ${currentExtensions().join(' / ')} 之一`,
    });
  }
  const dir = path.dirname(filePath);
  const nextPath = path.join(dir, raw);
  if (nextPath === filePath) return res.json({ ok: true, unchanged: true, path: filePath });
  if (!isPathInScanRoots(nextPath)) {
    return res.status(400).json({ error: '目标路径超出扫描根' });
  }
  // 大小写不敏感的文件系统上，`a.md` → `A.md` 的 existsSync 会误报冲突，
  // 因此只在解析后路径确实不同的情况下才判定重名
  if (fs.existsSync(nextPath) && nextPath.toLowerCase() !== filePath.toLowerCase()) {
    return res.status(409).json({ error: '同目录下已存在同名文件' });
  }
  try {
    await fsp.rename(filePath, nextPath);
  } catch (e) {
    return res.status(500).json({ error: '重命名失败：' + (e && e.message || e) });
  }
  // 迁移 store 里挂在旧路径上的状态：已读时间、备注名、diff 底本、收藏、标签、
  // 最近打开、分享、树节点。漏一个用户就会觉得"改个名字东西就丢了"
  const store = loadStore();
  if (store.seen[filePath] != null) {
    store.seen[nextPath] = store.seen[filePath];
    delete store.seen[filePath];
  }
  if (store.aliases[filePath] != null) {
    store.aliases[nextPath] = store.aliases[filePath];
    delete store.aliases[filePath];
  }
  if (store.seenVersions && store.seenVersions[filePath]) {
    store.seenVersions[nextPath] = store.seenVersions[filePath];
    delete store.seenVersions[filePath];
  }
  if (store.favorites && store.favorites[filePath] != null) {
    store.favorites[nextPath] = store.favorites[filePath];
    delete store.favorites[filePath];
  }
  if (store.tags && store.tags[filePath] != null) {
    store.tags[nextPath] = store.tags[filePath];
    delete store.tags[filePath];
  }
  store.recent = (store.recent || []).map(p => (p === filePath ? nextPath : p));
  for (const [token, entry] of Object.entries(store.shares || {})) {
    if (entry && entry.path === filePath) store.shares[token].path = nextPath;
  }
  const retarget = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'file' && n.path === filePath) n.path = nextPath;
      else if (n.type === 'folder' && Array.isArray(n.children)) retarget(n.children);
    }
  };
  retarget(store.tree || []);
  saveStore(store);
  // 定点更新索引即可，不必为一次改名触发全盘重建
  indexRemove(filePath);
  await indexUpsert(nextPath);
  res.json({ ok: true, path: nextPath, name: raw });
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

// ---------- 收藏 ----------
// 收藏是"从不同文件夹里挑出常看的那几篇"，所以它必须独立于 store.tree 的分组结构。
// 存成 path → 收藏时间，收藏夹就能按"最近收藏"排在前面。
app.post('/api/favorite', (req, res) => {
  const { path: filePath, favorite } = req.body || {};
  if (!filePath || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  const store = loadStore();
  store.favorites = store.favorites || {};
  // 不传 favorite 就当"切换"，传了就按传的值——前端点星标用切换语义最省事
  const next = favorite === undefined ? !store.favorites[filePath] : !!favorite;
  if (next) {
    // 已收藏时重复收藏不刷新时间戳，否则收藏夹顺序会被误触打乱
    if (!store.favorites[filePath]) store.favorites[filePath] = Date.now();
  } else {
    delete store.favorites[filePath];
  }
  saveStore(store);
  res.json({
    ok: true,
    favorite: !!store.favorites[filePath],
    favoritedAt: store.favorites[filePath] || 0,
  });
});

// ---------- 标签 ----------
// 整组覆盖式写入（不做单个 add/remove）：编辑入口是一个"逗号分隔"的输入框，
// 用户看到的就是全集，覆盖语义和界面一致，也省掉一半端点。
app.post('/api/tags', (req, res) => {
  const { path: filePath, tags } = req.body || {};
  if (!filePath || !isPathInScanRoots(filePath)) {
    return res.status(400).json({ error: '路径非法' });
  }
  const store = loadStore();
  store.tags = store.tags || {};
  const normalized = normalizeTags(tags);
  if (normalized.length) store.tags[filePath] = normalized;
  else delete store.tags[filePath];   // 清空即删 key，同 alias
  saveStore(store);
  res.json({ ok: true, tags: store.tags[filePath] || [] });
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

// 自动分组在磁盘上对应的目录。
//
// projectName 的来历见 makeRecord：文件躺在扫描根的子目录里时取那个子目录名，
// 直接躺在扫描根下时取 basename(scanRoot)。反解必须覆盖这两种情况。
// 只在扫描根范围内查找，所以不会解析出看板之外的路径。
function resolveProjectDir(projectName) {
  for (const root of getScanRoots()) {
    const sub = path.join(root, projectName);
    try { if (fs.statSync(sub).isDirectory()) return sub; } catch {}
    if (path.basename(root) === projectName) {
      try { if (fs.statSync(root).isDirectory()) return root; } catch {}
    }
  }
  return null;
}

// 「在访达中显示」的分组版。只有自动生成的分组（带 autoFor）才有磁盘目录可去；
// 用户手工建的虚拟分组没有对应目录，前端也不会给它这个按钮。
app.post('/api/reveal-folder', (req, res) => {
  const projectName = req.body && req.body.autoFor;
  if (!projectName || typeof projectName !== 'string') {
    return res.status(400).json({ error: '缺少 autoFor' });
  }
  // autoFor 来自 store，但它最终会拼进 path.join——按不可信输入处理
  if (/[\\/]/.test(projectName) || projectName.includes('..')) {
    return res.status(400).json({ error: '分组标识非法' });
  }
  const dir = resolveProjectDir(projectName);
  if (!dir) {
    return res.status(404).json({ error: '这个分组在磁盘上没有对应的目录' });
  }
  revealInFileManager(dir, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, path: dir });
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
  const lowerPath = filePath.toLowerCase();
  const isHtml = lowerPath.endsWith('.html') || lowerPath.endsWith('.htm');
  const isMd = isMarkdownPath(filePath);
  if (!isHtml && !isMd) {
    send({ phase: 'error', reason: 'unsupported', message: '只支持 HTML 与 Markdown 文件' });
    return res.end();
  }
  if (!fs.existsSync(filePath)) {
    send({ phase: 'error', reason: 'source-missing', message: '文件不存在' });
    return res.end();
  }

  // Markdown 先渲染成一份打印版 HTML 落到临时目录，再交给同一套 Chromium 管线。
  // base href 指向 md 原目录的 file:// URL：PDF 是在 file:// 下渲染的，
  // 预览页那套 /raw/ 前缀在这里取不到图。
  let renderPath = filePath;
  let tempDir = null;
  try {
    if (isMd) {
      send({ phase: 'launching', message: '正在渲染 Markdown…' });
      const raw = await fsp.readFile(filePath, 'utf8');
      const html = markdown.renderPage(raw, {
        title: path.basename(filePath),
        baseHref: pdfExport.dirFileUrl(path.dirname(filePath)),
        forPrint: true,
      });
      tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atlas-mdpdf-'));
      renderPath = path.join(tempDir, 'doc.html');
      await fsp.writeFile(renderPath, html, 'utf8');
    }
    const result = await pdfExport.exportPdf(
      { htmlPath: renderPath, fileName },
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
  } finally {
    if (tempDir) {
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
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

    // 标记已读，避免自我写入被标未读。
    // 同时把保存后的内容记成新底本：不记的话底本会停留在编辑之前，用户下次点
    // 「对比」看到的是自己刚做的那些改动被当成"变更"——他当然知道自己改了什么，
    // 对比要回答的是"别人（AI）动了什么"。
    const store = loadStore();
    store.seen[filePath] = markSeenAt(stat.mtimeMs);
    recordSeenVersion(store, filePath, { ack: true });
    saveStore(store);
    contentHashCache.delete(filePath);

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

// Markdown 预览页的 <base href>：该文件所在目录对应的 /raw/<idx>/<dir>/ 前缀。
// 与 HTML 编辑文档（editable.buildAnnotatedDoc）用的是同一套逻辑。
function mdBaseHref(filePath) {
  const fileUrl = buildFileUrl(filePath);
  if (!fileUrl) return null;
  return fileUrl.slice(0, fileUrl.lastIndexOf('/') + 1);
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
    // base href 指向该 md 所在目录的 /raw/ 前缀：预览页 URL 是
    // /api/render-md?path=...，没有 base 的话文档里 `![](./img/a.png)`
    // 会被解析成 /api/img/a.png → 404，md 里的本地图片全部裂开
    // theme=light|dark：用户在设置里把主题钉死时，预览页要一起钉，
    // 否则 iframe 内仍按系统配色渲染，出现「外壳浅色 + 预览深色」的割裂
    const theme = req.query.theme === 'light' || req.query.theme === 'dark'
      ? req.query.theme : undefined;
    const html = markdown.renderPage(raw, {
      title: path.basename(filePath),
      baseHref: mdBaseHref(filePath),
      theme,
    });
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

    // 同 save-edits：标记已读，并把保存后的内容记成新底本，
    // 否则对比面板会把用户自己刚写的内容当成"变更"
    const store = loadStore();
    store.seen[filePath] = markSeenAt(stat.mtimeMs);
    recordSeenVersion(store, filePath, { ack: true });
    saveStore(store);
    contentHashCache.delete(filePath);

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
  // ignore / maxDepth 作用于每个 watcher 自身，改了只能全部重建；
  // 只动 scanRoots 时走增量，避免为没变化的大目录重复建监听（会卡住事件循环数十秒）
  let watchOptsChanged = false;
  if (Array.isArray(body.scanRoots)) {
    const cleaned = [...new Set(body.scanRoots.map(p => path.resolve(String(p).trim())).filter(Boolean))];
    for (const p of cleaned) {
      if (!fs.existsSync(p)) return res.status(400).json({ error: `路径不存在：${p}` });
      const stat = fs.statSync(p);
      if (!stat.isDirectory()) return res.status(400).json({ error: `不是目录：${p}` });
    }
    if (JSON.stringify(cleaned) !== JSON.stringify(config.scanRoots || [])) {
      rootsChanged = true;
    }
    next.scanRoots = cleaned;
  }
  if (Array.isArray(body.ignore)) {
    next.ignore = body.ignore.map(String);
    if (JSON.stringify(next.ignore) !== JSON.stringify(config.ignore || [])) watchOptsChanged = true;
  }
  if (typeof body.maxDepth === 'number') {
    next.maxDepth = Math.min(20, Math.max(1, body.maxDepth));
    if (next.maxDepth !== config.maxDepth) watchOptsChanged = true;
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
  // 扫描根 / ignore / maxDepth 变了 → 文件索引必须重建。
  // （docTypes 变化不需要：索引存全部文档类型，读取时按启用类型过滤）
  if (rootsChanged || watchOptsChanged) invalidateIndex();
  // 仅在真正影响到的时候才做重活，避免切换文档类型时无谓地重挂路由 / 重启 watcher（卡顿源头）
  // mountRawRoutes 很快（只改 router stack），且前端拿到响应后立刻会请求 /raw/*，必须同步做完
  if (rootsChanged) mountRawRoutes();
  // 先把响应发出去：startWatchers 要为每个扫描根重建 chokidar watcher，
  // 大目录（含 node_modules 等）遍历建监听可达数十秒。压在响应前面会让前端
  // 迟迟等不到结果——UI 既不弹 toast 也不刷新列表，看起来就是"点了没反应"。
  res.json({ ok: true, config: next });
  // 同步 watcher 挪到响应之后异步执行。延后仅一个事件循环 tick，
  // 且用户刚改完扫描配置本就要重新扫描，期间漏掉文件事件的影响可忽略。
  if (rootsChanged || watchOptsChanged) setImmediate(() => {
    try {
      startWatchers({ full: watchOptsChanged });
    } catch (e) {
      console.warn('  ! 同步 watcher 失败:', e && e.message);
    }
  });
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
  for (const w of watchers.values()) {
    try { w.close().catch(() => {}); } catch {}
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
