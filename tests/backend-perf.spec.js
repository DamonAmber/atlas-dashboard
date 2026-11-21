// 后端热路径的机制回归：直接执行 server.js 中的原函数，磁盘读取使用可计数 mock。
// 这里不 import server.js（避免启动服务/读取用户配置），接口行为由原有隔离 spec 覆盖。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
// 独立的旧算法参照，仅用于比较分组语义和成本；不依赖 Git 历史（CI 可能浅克隆）。
const before = `function reconcile(store, scanned) {
  const existing = new Set(); collectFilePaths(store.tree, existing);
  const newFiles = scanned.filter(f => !existing.has(f.path)).sort((a, b) => b.mtime - a.mtime);
  for (const file of newFiles) {
    const folderName = file.projectName;
    let folder = store.tree.find(n => n.type === 'folder' && autoFolderKey(n) === folderName)
      || store.tree.find(n => n.type === 'folder' && autoFolderKey(n) === null && n.name === folderName);
    if (!folder) {
      folder = { id: genId(), type: 'folder', name: autoFolderDisplayName(store, folderName), autoFor: folderName, collapsed: false, children: [] };
      store.tree.push(folder);
    }
    folder.children.unshift({ type: 'file', path: file.path });
  }
  store.tree.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : (a.name || '').localeCompare(b.name || '', 'zh'));
}
// 统计每个 projectName`;
let total = 0;
function check(name, actual, expected = true) { assert.deepStrictEqual(actual, expected, name); total++; console.log(`✓ ${name}`); }
function section(src, first, last) { const a = src.indexOf(first), b = src.indexOf(last, a); assert(a >= 0 && b > a); return src.slice(a, b); }
function reconcileFrom(src) {
  let ids = 0, comparisons = 0;
  const ctx = {
    Map, Set,
    migrateLegacyRootFolders() {}, pruneMissing: tree => tree, backfillAutoFor() {},
    visibleFiles: files => files, collectFilePaths(nodes, out) { for (const n of nodes) for (const f of n.children || []) out.add(f.path); },
    autoFolderKey: f => typeof f.autoFor === 'string' ? f.autoFor : null,
    autoFolderDisplayName: (store, key) => store.folderAliases?.[key] || key,
    pruneEmptyFolders: tree => tree, genId: () => String(++ids),
  };
  const fn = vm.runInNewContext(section(src, 'function reconcile(store, scanned)', '// 统计每个 projectName') + '\nreconcile', ctx);
  return (tree, files) => {
    const store = { tree: JSON.parse(JSON.stringify(tree)), folderAliases: {} };
    store.tree.find = function (predicate) { comparisons++; return Array.prototype.find.call(this, predicate); };
    const t = performance.now(); fn(store, files); const ms = performance.now() - t;
    return { tree: JSON.parse(JSON.stringify(store.tree)), ms, comparisons };
  };
}
const fixture = [
  { id: 'auto', type: 'folder', name: '用户改名', autoFor: 'p', children: [{ type: 'file', path: '/old' }] },
  { id: 'duplicate', type: 'folder', name: 'p', autoFor: 'p', children: [] },
  { id: 'manual', type: 'folder', name: 'q', children: [] },
];
const files = [
  { path: '/p/a', projectName: 'p', mtime: 10 }, { path: '/p/b', projectName: 'p', mtime: 20 },
  { path: '/q/a', projectName: 'q', mtime: 15 }, { path: '/r/a', projectName: 'r', mtime: 5 },
];
check('分组索引保持首个自动/手工分组认领与原子项顺序', reconcileFrom(source)(fixture, files).tree, reconcileFrom(before)(fixture, files).tree);
const many = Array.from({ length: 10000 }, (_, i) => ({ path: `/p${i}/a.md`, projectName: `p${String(i).padStart(5, '0')}`, mtime: i }));
const baseline = reconcileFrom(before)([], many), optimized = reconcileFrom(source)([], many);
check('大量项目分组结果与优化前一致', optimized.tree, baseline.tree);
check('新分组不再逐文件调用顶层 find', optimized.comparisons, 0);
console.log(`· 10000 个项目：分组 ${baseline.ms.toFixed(1)}ms → ${optimized.ms.toFixed(1)}ms；原顶层 find ${baseline.comparisons} 次。`);
let reads = 0;
const index = new Map();
const ctx = {
  Map, Set, MAX_INDEX_FILES: 50000, CLOUD_ON: false, fileIndex: index,
  fs: { readFileSync(p) { reads++; return Buffer.from(p); } },
  versionStore: { sha1: b => crypto.createHash('sha1').update(b).digest('hex') },
  versionsOf: () => [{ at: 0, hash: 'baseline' }],
};
const functions = section(source, 'function buildVersionMeta(store, files)', '// 当前磁盘内容的 sha1')
  + section(source, 'const contentHashCache = new Map();', "app.post('/api/seen'")
  + '\n({ currentContentHash, buildVersionMeta, contentHashCache })';
const hash = vm.runInNewContext(functions, ctx);
const candidates = Array.from({ length: 600 }, (_, i) => { const p = `/candidate-${i}.md`; index.set(p, {}); return { path: p, mtime: 10 }; });
for (let round = 0; round < 3; round++) hash.buildVersionMeta({}, candidates);
check('600 个候选、连续三轮只读取首轮 600 次', reads, 600);
hash.currentContentHash(candidates[0].path, 11);
check('修改时间变化时只重读对应文件', reads, 601);
index.delete(candidates[1].path); hash.buildVersionMeta({}, candidates.filter((_, i) => i !== 1));
check('索引已删除的 hash 被清理', hash.contentHashCache.has(candidates[1].path), false);
console.log(`\n通过 ${total} 项，失败 0 项。`);
