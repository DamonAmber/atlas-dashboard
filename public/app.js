const state = {
  tree: [],
  files: {},
  recent: [],
  activeFilePath: null,
  search: '',
  contentMatches: new Map(),       // path → snippet（全文搜索结果）
  onlyUnread: false,
  collapsed: new Set(JSON.parse(localStorage.getItem('atlas:collapsed') || '[]')),
  recentCollapsed: localStorage.getItem('atlas:recentCollapsed') === '1',
  notifyEnabled: localStorage.getItem('atlas:notify') === '1',
  // 'name' | 'mtime' | 'custom'：folder.children 排序模式
  // 默认按名称——一系列文档（v1/v2/v3）会自动聚合在一起
  sortMode: localStorage.getItem('atlas:sortMode') || 'name',
  // path → { token, urls } —— 用于文件行渲染时判断是否已分享 + 状态角标
  sharesByPath: new Map(),
};

// 预览区轻量编辑模式状态
const editState = {
  active: false,      // 是否处于编辑模式
  kind: 'html',       // 'html'（iframe 内联编辑）| 'md'（源码 + 实时预览分栏）
  path: null,         // 正在编辑的文件路径
  rawUrl: null,       // 进入编辑前的 /raw/ 预览 url（取消时恢复）
  baseHash: null,     // 进入编辑时源文件哈希（保存时冲突检测）
  dirty: false,       // 有无未保存改动
  ops: new Map(),     // eid → op（setText / reorder，覆盖式）
  sortables: [],      // 已创建的 Sortable 实例（退出时销毁）
  saving: false,      // 保存请求进行中
};

const els = {
  sidebar: document.getElementById('sidebar'),
  resizer: document.getElementById('resizer'),
  tree: document.getElementById('tree'),
  search: document.getElementById('search'),
  onlyUnread: document.getElementById('only-unread'),
  stats: document.getElementById('stats'),
  preview: document.getElementById('preview'),
  emptyState: document.getElementById('empty-state'),
  crumbs: document.getElementById('crumbs'),
  saveStatus: document.getElementById('save-status'),
  btnToggleSidebar: document.getElementById('btn-toggle-sidebar'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnNewFolder: document.getElementById('btn-new-folder'),
  btnMarkAll: document.getElementById('btn-mark-all'),
  btnSettings: document.getElementById('btn-settings'),
  btnMarkUnread: document.getElementById('btn-mark-unread'),
  btnReveal: document.getElementById('btn-reveal'),
  btnOpenExternal: document.getElementById('btn-open-external'),
  btnReloadPreview: document.getElementById('btn-reload-preview'),
  btnExportPdf: document.getElementById('btn-export-pdf'),
  btnShare: document.getElementById('btn-share'),
  btnEdit: document.getElementById('btn-edit'),
  btnEditSave: document.getElementById('btn-edit-save'),
  btnEditCancel: document.getElementById('btn-edit-cancel'),
  btnCopyPath: document.getElementById('btn-copy-path'),
  // settings modal
  modal: document.getElementById('settings-modal'),
  rootList: document.getElementById('root-list'),
  archiveList: document.getElementById('archive-list'),
  shareModal: document.getElementById('share-modal'),
  shareFilename: document.getElementById('share-filename'),
  shareQr: document.getElementById('share-qr'),
  shareUrls: document.getElementById('share-urls'),
  shareOpenBtn: document.getElementById('share-open-btn'),
  shareStopBtn: document.getElementById('share-stop-btn'),
  shareList: document.getElementById('share-list'),
  shareStopAllBtn: document.getElementById('share-stop-all-btn'),
  rootInput: document.getElementById('root-input'),
  rootAddBtn: document.getElementById('root-add-btn'),
  rootBrowseBtn: document.getElementById('root-browse-btn'),
  dirPicker: document.getElementById('dir-picker'),
  dirCurrent: document.getElementById('dir-current'),
  dirList: document.getElementById('dir-list'),
  dirUp: document.getElementById('dir-up'),
  dirHome: document.getElementById('dir-home'),
  dirCancel: document.getElementById('dir-cancel'),
  dirSelect: document.getElementById('dir-select'),
  notifyToggle: document.getElementById('notify-toggle'),
  notifyHint: document.getElementById('notify-hint'),
  ignoreInput: document.getElementById('ignore-input'),
  ignoreSaveBtn: document.getElementById('ignore-save-btn'),
  recentBar: document.getElementById('recent-bar'),
  recentList: document.getElementById('recent-list'),
  recentToggle: document.getElementById('recent-toggle'),
  updateBadge: document.getElementById('update-badge'),
  updateBanner: document.getElementById('update-banner'),
  segButtons: document.querySelectorAll('.seg-btn[data-sort]'),
  matchBadge: document.getElementById('match-badge'),
  matchPrev: document.getElementById('match-prev'),
  matchNext: document.getElementById('match-next'),
  toastContainer: document.getElementById('toast-container'),
  // Markdown 编辑器
  mdEditor: document.getElementById('md-editor'),
  mdSource: document.getElementById('md-source'),
  mdPreview: document.getElementById('md-preview'),
  // 设置：文档类型单选
  doctypeRadios: document.querySelectorAll('input[name="doctype"]'),
};

// 注入 Markdown 预览基础样式到主文档（供编辑器右侧实时预览面板使用）
(function injectMarkdownCss() {
  try {
    if (window.AtlasMarkdown && !document.getElementById('atlas-md-css')) {
      const st = document.createElement('style');
      st.id = 'atlas-md-css';
      st.textContent = window.AtlasMarkdown.markdownCss;
      document.head.appendChild(st);
    }
  } catch (e) {}
})();

// 文档扩展名工具：显示名去扩展名 / 预览 URL 路由
function stripDocExt(name) {
  return String(name || '').replace(/\.(html?|md|markdown)$/i, '');
}
function isMdFile(file) {
  if (!file) return false;
  if (file.docType) return file.docType === 'md';
  return /\.(md|markdown)$/i.test(file.name || '');
}
// iframe 预览地址：md 走服务端渲染，html 用原始 /raw/ 地址
function previewUrlFor(file) {
  if (!file) return '';
  if (isMdFile(file)) return '/api/render-md?path=' + encodeURIComponent(file.path);
  return file.url;
}

// ---------- Toast 通知 ----------
// showToast({ kind, text, secondary, duration, progress })
//   - progress: true → 不自动消失（duration 被忽略）+ 内部 indeterminate 进度条
//   - 返回 { close, setText, setSecondary }——progress 模式下需要外部更新阶段文字
function showToast({ kind = 'info', text = '', secondary = '', duration = 2800, progress = false } = {}) {
  if (!els.toastContainer) return { close: () => {}, setText: () => {}, setSecondary: () => {} };
  const t = document.createElement('div');
  t.className = `toast ${kind}` + (progress ? ' toast-progress' : '');
  t.setAttribute('role', 'status');
  const ico = progress ? '⟳' : (kind === 'success' ? '✓' : kind === 'error' ? '✕' : 'i');
  t.innerHTML = `
    <span class="toast-icon">${ico}</span>
    <div class="toast-msg"></div>
    <button class="toast-close" aria-label="关闭">×</button>
    ${progress ? '<div class="toast-progress-bar"><div></div></div>' : ''}
  `;
  const msgEl = t.querySelector('.toast-msg');
  const mainTextNode = document.createTextNode(text);
  msgEl.appendChild(mainTextNode);
  const secEl = document.createElement('span');
  secEl.className = 'toast-secondary';
  if (secondary) {
    secEl.textContent = secondary;
    msgEl.appendChild(secEl);
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    t.classList.add('fading');
    setTimeout(() => t.remove(), 250);
  };
  const setText = (s) => { mainTextNode.nodeValue = s || ''; };
  const setSecondary = (s) => {
    if (s) {
      secEl.textContent = s;
      if (!secEl.parentNode) msgEl.appendChild(secEl);
    } else if (secEl.parentNode) {
      secEl.remove();
    }
  };
  t.querySelector('.toast-close').addEventListener('click', close);
  els.toastContainer.appendChild(t);
  if (!progress && duration > 0) setTimeout(close, duration);
  return { close, setText, setSecondary, el: t };
}

// ---------- 侧边栏宽度 / 收起 ----------
const SIDEBAR_MIN = 220, SIDEBAR_MAX = 800;
const ANIM_MS = 200;

const savedWidth = parseInt(localStorage.getItem('atlas:sidebarWidth'), 10);
if (savedWidth && savedWidth >= SIDEBAR_MIN && savedWidth <= SIDEBAR_MAX) {
  document.documentElement.style.setProperty('--sidebar-w', savedWidth + 'px');
}
if (localStorage.getItem('atlas:sidebarCollapsed') === '1') {
  document.body.classList.add('sidebar-collapsed');
}
// 等首次布局稳定后再启用过渡 + 移除 init class，避免首次加载看到动画
requestAnimationFrame(() => requestAnimationFrame(() => {
  document.documentElement.classList.remove('init-sidebar-collapsed');
  document.body.classList.add('tx-ready');
}));

// sidebar 切换：让 iframe 自然跟随 main 一起 transition。
// 不再 freeze iframe 宽度——freeze 会带来副作用：动画期间 iframe 锁宽与
// main 实际宽度不一致，用户在锁定期间的操作会被 230ms 的 inline style 干扰，
// 释放时还有一次"咔哒"般的 layout 跳变。让 iframe 跟随更稳更可预期。
let sidebarAnimTimer = null;
function toggleSidebar(force) {
  const next = typeof force === 'boolean'
    ? force
    : !document.body.classList.contains('sidebar-collapsed');

  if (sidebarAnimTimer) {
    clearTimeout(sidebarAnimTimer);
    sidebarAnimTimer = null;
  }

  document.body.classList.add('sidebar-animating');
  document.body.classList.toggle('sidebar-collapsed', next);
  localStorage.setItem('atlas:sidebarCollapsed', next ? '1' : '0');
  els.btnToggleSidebar.title = next ? '展开侧边栏（⌘B）' : '收起侧边栏（⌘B）';

  sidebarAnimTimer = setTimeout(() => {
    document.body.classList.remove('sidebar-animating');
    sidebarAnimTimer = null;
  }, ANIM_MS + 30);
}
els.btnToggleSidebar.addEventListener('click', () => toggleSidebar());

// 拖拽 resizer 调整宽度
// 用 pointer events + setPointerCapture：
// 即使指针被拖出浏览器窗口或在窗口外释放，pointerup/pointercancel 仍会送回 resizer，
// 不会出现 "body.resizing 卡住 → iframe pointer-events:none → 无法滚动" 的 bug。
(function setupResizer() {
  let dragging = false;
  let pointerId = null;
  let pendingW = null;
  let rafId = 0;
  const apply = () => {
    rafId = 0;
    if (pendingW != null) {
      document.documentElement.style.setProperty('--sidebar-w', pendingW + 'px');
    }
  };
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (pointerId != null) {
      try { els.resizer.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    }
    document.body.classList.remove('resizing');
    els.resizer.classList.remove('dragging');
    if (pendingW != null) {
      localStorage.setItem('atlas:sidebarWidth', String(pendingW));
    }
  }
  els.resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    pointerId = e.pointerId;
    try { els.resizer.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add('resizing');
    els.resizer.classList.add('dragging');
  });
  els.resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pendingW = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
    if (!rafId) rafId = requestAnimationFrame(apply);
  });
  els.resizer.addEventListener('pointerup', endDrag);
  els.resizer.addEventListener('pointercancel', endDrag);
  // 终极兜底：窗口失焦 / 标签隐藏时也释放，防止任何 edge case 卡住状态
  window.addEventListener('blur', endDrag);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) endDrag();
  });
})();

// ---------- 工具 ----------
function fmtMtime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = 60_000, h = 3_600_000, d = 86_400_000;
  if (diff < m) return '刚刚';
  if (diff < h) return Math.floor(diff / m) + ' 分钟前';
  if (diff < d) return Math.floor(diff / h) + ' 小时前';
  if (diff < 30 * d) return Math.floor(diff / d) + ' 天前';
  const date = new Date(ts);
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const da = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function setSaveStatus(s) {
  els.saveStatus.classList.remove('saving', 'error');
  if (s === 'saving' || s === 'loading') els.saveStatus.classList.add('saving');
  if (s === 'error') els.saveStatus.classList.add('error');
}

// ---------- 加载状态 ----------
let scanningCount = 0;
function setScanning(on) {
  scanningCount += on ? 1 : -1;
  if (scanningCount < 0) scanningCount = 0;
  els.btnRefresh.classList.toggle('scanning', scanningCount > 0);
}

async function fetchState() {
  setSaveStatus('loading');
  setScanning(true);
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.tree = data.tree;
    state.files = data.files;
    state.recent = Array.isArray(data.recent) ? data.recent : [];
    state.archivedProjects = Array.isArray(data.archivedProjects) ? data.archivedProjects : [];
    const unread = Object.values(data.files).filter(f => f.unread).length;
    els.stats.textContent = `${Object.keys(data.files).length} 个文档 · ${unread} 未读`;
    setSaveStatus('idle');
    render();
    renderRecent();
  } catch (e) {
    console.error(e);
    setSaveStatus('error');
    els.stats.textContent = '加载失败：' + e.message;
  } finally {
    setScanning(false);
  }
}

let saveTimer = null;
function scheduleSaveTree() {
  if (saveTimer) clearTimeout(saveTimer);
  setSaveStatus('saving');
  saveTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/tree', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tree: state.tree }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      setSaveStatus('idle');
    } catch (e) {
      console.error(e);
      setSaveStatus('error');
    }
  }, 250);
}

// ---------- 过滤 ----------
function fileMatches(file) {
  if (state.onlyUnread && !file.unread) return false;
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return file.name.toLowerCase().includes(q)
    || file.relPath.toLowerCase().includes(q)
    || (file.alias && file.alias.toLowerCase().includes(q))
    || state.contentMatches.has(file.path);   // 内容匹配
}
function nodeMatches(node) {
  if (node.type === 'file') {
    const f = state.files[node.path];
    return f && fileMatches(f);
  }
  if (node.type === 'folder') {
    return node.children.some(nodeMatches);
  }
  return false;
}
function countDescendants(node) {
  if (node.type === 'file') return { files: 1, unread: state.files[node.path] && state.files[node.path].unread ? 1 : 0 };
  let files = 0, unread = 0;
  for (const c of node.children) {
    const r = countDescendants(c);
    files += r.files;
    unread += r.unread;
  }
  return { files, unread };
}

// ---------- 渲染 ----------
function render() {
  els.tree.innerHTML = '';
  for (const node of state.tree) {
    if (state.search || state.onlyUnread) {
      if (!nodeMatches(node)) continue;
    }
    els.tree.appendChild(renderNode(node));
  }
  initSortables();
  if (state.activeFilePath && state.files[state.activeFilePath]) {
    setActiveFile(state.activeFilePath, false);
  }
}

function renderRecent() {
  const list = state.recent || [];
  // 过滤掉磁盘上已不存在的（state.files 里没有）
  const usable = list.filter(p => !!state.files[p]);
  if (usable.length === 0) {
    els.recentBar.classList.add('hidden');
    return;
  }
  els.recentBar.classList.remove('hidden');
  els.recentBar.classList.toggle('collapsed', state.recentCollapsed);
  els.recentList.innerHTML = '';
  for (const p of usable) {
    const file = state.files[p];
    const div = document.createElement('div');
    div.className = 'recent-item'
      + (file.unread ? ' unread' : '')
      + (file.alias ? ' has-alias' : '')
      + (p === state.activeFilePath ? ' active' : '');
    div.dataset.path = p;
    div.title = file.alias ? `${file.alias}\n${file.relPath}` : file.relPath;
    const rIcon = isMdFile(file) ? '📝' : '🌐';
    div.innerHTML = `
      <span class="recent-icon">${rIcon}</span>
      <span class="recent-name">${escapeHtml(file.alias || stripDocExt(file.name))}</span>
      <span class="recent-project">${escapeHtml(file.projectName)}</span>
    `;
    div.addEventListener('click', () => openFile(p));
    els.recentList.appendChild(div);
  }
}

// ---------- 排序 ----------
// 三档：name（默认） / mtime / custom
// folder 始终在 file 之前；folder 之间按 name 排（不受 mode 影响——避免顶层文件夹乱跳）
// file 之间按 mode 排：custom 保持原顺序（不动）
function sortChildren(children, mode) {
  if (mode === 'custom') return children;
  return [...children].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    if (a.type === 'folder') return (a.name || '').localeCompare(b.name || '', 'zh');
    // file
    const fa = state.files[a.path];
    const fb = state.files[b.path];
    if (!fa || !fb) return 0;
    if (mode === 'mtime') return (fb.mtime || 0) - (fa.mtime || 0);
    // name 模式：用 alias > basename，localeCompare zh + numeric（v2 < v10 这种正确）
    const na = (fa.alias || fa.name || '').toLowerCase();
    const nb = (fb.alias || fb.name || '').toLowerCase();
    return na.localeCompare(nb, 'zh', { numeric: true });
  });
}

function updateSortBar() {
  const mode = state.sortMode;
  els.segButtons.forEach(btn => {
    const isActive = btn.dataset.sort === mode;
    btn.setAttribute('aria-checked', String(isActive));
  });
}

function setSortMode(mode, opts = {}) {
  state.sortMode = mode;
  localStorage.setItem('atlas:sortMode', mode);
  updateSortBar();
  if (!opts.noRender) render();
}

els.segButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.sort;
    if (mode === state.sortMode) return;
    setSortMode(mode);
  });
});
updateSortBar();

function renderNode(node) {
  if (node.type === 'folder') return renderFolder(node);
  if (node.type === 'file') return renderFile(state.files[node.path], node);
  return document.createDocumentFragment();
}

function renderFolder(folder) {
  const isCollapsed = state.collapsed.has(folder.id);
  const folderEl = document.createElement('div');
  folderEl.className = 'folder' + (isCollapsed ? ' collapsed' : '');
  folderEl.dataset.nodeType = 'folder';
  folderEl.dataset.folderId = folder.id;

  const counts = countDescendants(folder);
  const visibleChildren = sortChildren(folder.children.filter(c => {
    if (!state.search && !state.onlyUnread) return true;
    return nodeMatches(c);
  }), state.sortMode);

  const header = document.createElement('div');
  header.className = 'folder-header';
  header.innerHTML = `
    <span class="folder-toggle">▾</span>
    <span class="folder-icon">📁</span>
    <span class="folder-name" data-folder-id="${folder.id}">${escapeHtml(folder.name)}</span>
    ${counts.unread > 0 ? `<span class="folder-unread-dot" title="${counts.unread} 个未读"></span>` : ''}
    <span class="folder-count">${counts.files}</span>
    <span class="folder-actions">
      <button data-act="new-sub" title="在此分组内新建子分组">＋</button>
      <button data-act="rename" title="重命名">✎</button>
      <button data-act="delete" title="删除分组（文件下次扫描会回到所属项目）">✕</button>
    </span>
  `;
  folderEl.appendChild(header);

  const childrenEl = document.createElement('div');
  childrenEl.className = 'folder-children';
  childrenEl.dataset.folderId = folder.id;
  for (const c of visibleChildren) {
    childrenEl.appendChild(renderNode(c));
  }
  folderEl.appendChild(childrenEl);

  // 用 pointerdown + pointerup 替代 click（同 file 元素）
  // SortableJS forceFallback 模式吞掉 click 事件，导致点击 folder header
  // 有时不响应、要点 2-3 次才能折叠/展开
  let hpdX = 0, hpdY = 0, hpdDown = false;
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.folder-actions')) return;
    if (e.target.classList.contains('folder-name') && e.target.isContentEditable) return;
    hpdX = e.clientX; hpdY = e.clientY; hpdDown = true;
  });
  header.addEventListener('pointerup', (e) => {
    if (!hpdDown || e.button !== 0) return;
    hpdDown = false;
    if (e.target.closest('.folder-actions')) return;
    if (e.target.classList.contains('folder-name') && e.target.isContentEditable) return;
    const dx = Math.abs(e.clientX - hpdX);
    const dy = Math.abs(e.clientY - hpdY);
    if (dx <= 5 && dy <= 5) {
      toggleFolder(folder.id);
    }
  });
  header.addEventListener('pointercancel', () => { hpdDown = false; });
  header.querySelector('[data-act="new-sub"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = prompt(`在「${folder.name}」中新建子分组：`, '新分组');
    if (!name) return;
    const res = await fetch('/api/folders/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, parentId: folder.id }),
    });
    if (res.ok) {
      state.collapsed.delete(folder.id);
      saveCollapsed();
      fetchState();
    }
  });
  header.querySelector('[data-act="rename"]').addEventListener('click', (e) => {
    e.stopPropagation();
    startRenameFolder(folder, header.querySelector('.folder-name'));
  });
  header.querySelector('[data-act="delete"]').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteFolder(folder);
  });
  header.querySelector('.folder-name').addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRenameFolder(folder, e.currentTarget);
  });

  return folderEl;
}

function renderFile(file, node) {
  if (!file) {
    const el = document.createElement('div');
    el.className = 'file';
    el.dataset.nodeType = 'file';
    el.dataset.path = node.path;
    el.style.display = 'none';
    return el;
  }
  const fileEl = document.createElement('div');
  // 是否是"仅内容匹配"（文件名/备注/路径都不命中，只内容命中）
  const snippet = state.contentMatches.get(file.path);
  const q = state.search ? state.search.toLowerCase() : '';
  const isNameMatch = q && (
    file.name.toLowerCase().includes(q)
    || file.relPath.toLowerCase().includes(q)
    || (file.alias && file.alias.toLowerCase().includes(q))
  );
  const contentOnly = !!snippet && !isNameMatch;
  const dtype = isMdFile(file) ? 'md' : 'html';
  fileEl.className = 'file'
    + ' doctype-' + dtype
    + (file.unread ? ' unread' : '')
    + (file.alias ? ' has-alias' : '')
    + (file.path === state.activeFilePath ? ' active' : '')
    + (contentOnly ? ' content-match' : '');
  fileEl.dataset.nodeType = 'file';
  fileEl.dataset.path = file.path;
  fileEl.dataset.doctype = dtype;
  fileEl.tabIndex = -1;  // 可被 JS focus，但不出现在 Tab 序列中
  let titleParts = [];
  if (file.alias) titleParts.push(file.alias);
  titleParts.push(file.name);
  titleParts.push(file.relPath);
  if (snippet) titleParts.push('🔍 ' + snippet);
  fileEl.title = titleParts.join('\n');
  const displayName = file.alias || stripDocExt(file.name);
  const isShared = state.sharesByPath && state.sharesByPath.has(file.path);
  if (isShared) fileEl.classList.add('shared');
  const typeIcon = dtype === 'md' ? '📝' : '🌐';
  fileEl.innerHTML = `
    <span class="unread-dot"></span>
    <span class="folder-icon file-type-icon">${typeIcon}</span>
    <span class="file-name" data-path="${escapeHtml(file.path)}">${escapeHtml(displayName)}</span>
    <span class="file-type-badge type-${dtype}">${dtype === 'md' ? 'MD' : 'HTML'}</span>
    <span class="share-badge" title="正在分享到局域网" aria-hidden="${isShared ? 'false' : 'true'}">
      <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7L7 5M4 8a2 2 0 0 1 0-3l1-1M8 4a2 2 0 0 1 0 3l-1 1"/></svg>
    </span>
    <span class="file-mtime">${fmtMtime(file.mtime)}</span>
    <span class="file-actions">
      <button data-act="share" title="分享到局域网（生成可访问链接 + 二维码）">
        <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8L9 5M5 8a2 2 0 0 1-2-2 2 2 0 0 1 4 0M9 5a2 2 0 0 1 2-2 2 2 0 0 1 0 4 2 2 0 0 1-2-2M5 8a2 2 0 0 0-2 2 2 2 0 0 0 4 0 2 2 0 0 0-2-2"/></svg>
      </button>
      <button data-act="alias" title="备注名（不改源文件名）">✎</button>
      <button data-act="reveal" title="在访达中显示">📂</button>
    </span>
  `;
  // 用 pointerdown + pointerup 替代 click：
  // SortableJS forceFallback 模式会在鼠标按下后任何 mousemove 启动拖拽并 preventDefault click，
  // 导致用户手抖几像素就 click 失效（"点 3-4 次才打开"）。
  // pointer 事件早于 click 触发，且 SortableJS 不会拦截。
  let pdX = 0, pdY = 0, pdDown = false;
  fileEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.file-actions')) return;
    if (e.target.classList.contains('file-name') && e.target.isContentEditable) return;
    pdX = e.clientX; pdY = e.clientY; pdDown = true;
  });
  fileEl.addEventListener('pointerup', (e) => {
    if (!pdDown || e.button !== 0) return;
    pdDown = false;
    if (e.target.closest('.file-actions')) return;
    if (e.target.classList.contains('file-name') && e.target.isContentEditable) return;
    const dx = Math.abs(e.clientX - pdX);
    const dy = Math.abs(e.clientY - pdY);
    if (dx <= 5 && dy <= 5) {
      openFile(file.path);
    }
  });
  fileEl.addEventListener('pointercancel', () => { pdDown = false; });
  fileEl.querySelector('[data-act="alias"]').addEventListener('click', (e) => {
    e.stopPropagation();
    startEditAlias(file, fileEl.querySelector('.file-name'));
  });
  fileEl.querySelector('.file-name').addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startEditAlias(file, e.currentTarget);
  });
  fileEl.querySelector('[data-act="reveal"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file.path }),
    });
  });
  fileEl.querySelector('[data-act="share"]').addEventListener('click', (e) => {
    e.stopPropagation();
    openShareModal(file.path);
  });
  return fileEl;
}

function saveCollapsed() {
  localStorage.setItem('atlas:collapsed', JSON.stringify([...state.collapsed]));
}
function toggleFolder(id) {
  if (state.collapsed.has(id)) state.collapsed.delete(id);
  else state.collapsed.add(id);
  saveCollapsed();
  const el = els.tree.querySelector(`.folder[data-folder-id="${id}"]`);
  if (el) el.classList.toggle('collapsed');
}

function normalizeText(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// 共用的 inline edit：粘贴强制纯文本，多空白合一，Enter 提交，Esc 取消，blur 提交
function startInlineEdit(nameEl, originalText, onCommit) {
  // 1) 把当前节点彻底清空成纯文本，防止之前的 innerHTML 里残留 alias 装饰节点
  nameEl.textContent = originalText;
  nameEl.contentEditable = 'true';
  nameEl.spellcheck = false;
  nameEl.focus();
  // 全选当前文本，便于直接覆盖输入
  const sel = document.getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  sel.addRange(range);

  let cancelled = false;

  const onPaste = (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    const cleaned = normalizeText(text);
    // 用 insertText 走浏览器原生路径，仍受 contentEditable 控制但不带格式
    document.execCommand('insertText', false, cleaned);
  };

  // 拦截带格式的拖入（拖拽富文本进来同样会带样式）
  const onDrop = (e) => {
    e.preventDefault();
    const text = e.dataTransfer && e.dataTransfer.getData('text/plain');
    if (text) document.execCommand('insertText', false, normalizeText(text));
  };
  const onDragOver = (e) => e.preventDefault();

  // 兜底：所有输入完成后，把当前 DOM 里的富文本节点清扁平成纯文本（最后一道防线）
  const onInput = () => {
    if (nameEl.querySelector('*')) {
      // 选区位置以"文本字符 offset"为准
      const offset = caretOffset(nameEl);
      nameEl.textContent = nameEl.innerText;
      restoreCaret(nameEl, offset);
    }
  };

  const finish = () => {
    nameEl.contentEditable = 'false';
    nameEl.removeEventListener('blur', onBlur);
    nameEl.removeEventListener('keydown', onKey);
    nameEl.removeEventListener('paste', onPaste);
    nameEl.removeEventListener('drop', onDrop);
    nameEl.removeEventListener('dragover', onDragOver);
    nameEl.removeEventListener('input', onInput);
    const next = normalizeText(nameEl.textContent);
    if (cancelled) {
      nameEl.textContent = originalText;
      return;
    }
    onCommit(next);
  };
  const onBlur = () => finish();
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; nameEl.blur(); }
  };
  nameEl.addEventListener('blur', onBlur);
  nameEl.addEventListener('keydown', onKey);
  nameEl.addEventListener('paste', onPaste);
  nameEl.addEventListener('drop', onDrop);
  nameEl.addEventListener('dragover', onDragOver);
  nameEl.addEventListener('input', onInput);
}

function caretOffset(el) {
  const sel = document.getSelection();
  if (!sel.rangeCount) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}
function restoreCaret(el, offset) {
  const sel = document.getSelection();
  const range = document.createRange();
  const node = el.firstChild;
  if (!node) {
    range.setStart(el, 0);
  } else {
    const len = node.textContent.length;
    range.setStart(node, Math.min(offset, len));
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function startRenameFolder(folder, nameEl) {
  startInlineEdit(nameEl, folder.name, (next) => {
    if (!next || next === folder.name) {
      nameEl.textContent = folder.name;
      return;
    }
    folder.name = next;
    nameEl.textContent = next;
    scheduleSaveTree();
  });
}

function startEditAlias(file, nameEl) {
  const baseName = stripDocExt(file.name);
  const original = file.alias || baseName;
  startInlineEdit(nameEl, original, async (next) => {
    if (next === original) {
      nameEl.textContent = original;
      return;
    }
    // 改回与原文件名一致 = 删除 alias
    const aliasToSet = (next === baseName) ? '' : next;
    try {
      const res = await fetch('/api/alias', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file.path, alias: aliasToSet }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      file.alias = data.alias;
      render();
    } catch (e) {
      console.error(e);
      nameEl.textContent = original;
    }
  });
}

function deleteFolder(folder) {
  // 判断这个 folder 是不是磁盘扫描自动建的"项目分组"（projectName 同名）：
  // 如果是 → 走"归档"路径，下次扫描跳过同名 projectName，不再被自动重建
  // 如果不是（用户自建子分组）→ 单纯删除，里面的文件下次扫描会回到所属项目分组
  const projectNames = new Set();
  Object.values(state.files).forEach(f => { if (f && f.projectName) projectNames.add(f.projectName); });
  const isAutoProject = projectNames.has(folder.name);

  const counts = countDescendants(folder);

  if (isAutoProject) {
    // 归档对话——告诉用户这是隐藏，不是删除文件
    const prompt = counts.files > 0
      ? `归档分组「${folder.name}」？\n\n该分组下有 ${counts.files} 个文档（磁盘文件不会被删），归档后将不再扫描，可在 设置 → 已归档分组 中恢复。`
      : `归档分组「${folder.name}」？归档后将不再扫描，可在 设置 → 已归档分组 中恢复。`;
    if (!confirm(prompt)) return;

    fetch('/api/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: folder.name }),
    }).then(async r => {
      if (!r.ok) {
        showToast({ kind: 'error', text: '归档失败', secondary: 'HTTP ' + r.status });
        return;
      }
      removeFolderFromTree(state.tree, folder.id);
      render();
      fetchState();
      showToast({
        kind: 'success',
        text: `已归档「${folder.name}」`,
        secondary: '可在 设置 → 已归档分组 中恢复',
        duration: 4500,
      });
    }).catch(err => {
      showToast({ kind: 'error', text: '归档失败', secondary: err.message });
    });
    return;
  }

  // 自建分组 —— 原行为（删完文件下次扫描会回到所属项目分组）
  if (counts.files > 0) {
    if (!confirm(`分组「${folder.name}」中有 ${counts.files} 个文件（含子分组），删除后文件下次扫描会回到所属项目分组。继续？`)) return;
  }
  removeFolderFromTree(state.tree, folder.id);
  scheduleSaveTree();
  render();
  setTimeout(fetchState, 300);
}
function removeFolderFromTree(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === 'folder' && n.id === id) {
      nodes.splice(i, 1);
      return true;
    }
    if (n.type === 'folder' && removeFolderFromTree(n.children, id)) return true;
  }
  return false;
}

// ---------- 拖拽 ----------
// 保存所有 Sortable 实例，render 前先 destroy，避免实例泄漏导致长时间使用后卡顿
let sortableInstances = [];
function destroySortables() {
  for (const s of sortableInstances) {
    try { s.destroy(); } catch {}
  }
  sortableInstances = [];
}
function initSortables() {
  destroySortables();
  const containers = [els.tree, ...els.tree.querySelectorAll('.folder-children')];
  for (const el of containers) {
    sortableInstances.push(new Sortable(el, {
      group: 'atlas-nodes',
      animation: 150,
      ghostClass: 'dragging-ghost',
      filter: '[contenteditable="true"], .folder-actions, .folder-actions *, .file-actions, .file-actions *',
      preventOnFilter: false,
      fallbackOnBody: true,
      // forceFallback: 不用 native HTML5 drag，统一走 mouse 事件路径
      // 让 onMove 在每次有意义的鼠标移动都触发（支持 hover-to-expand 检测）
      forceFallback: true,
      // 鼠标按下后必须移动 5px 才识别为拖拽。否则手抖被当成 drag，吞掉 click 事件，
      // 用户表现为"点击文件没反应、要点 3~4 次才能打开"
      touchStartThreshold: 5,
      swapThreshold: 0.55,
      // 在 onMove 里做两件事：
      //   1. hover-to-expand：拖拽悬停在折叠 folder 头上 600ms 自动展开
      //   2. 阻止 folder 拖进自己或自己的子孙
      // 用 onMove（而不是 document mousemove）是因为 native HTML5 drag 模式下
      // mousemove 不触发；onMove 由 SortableJS 内部统一了 native/fallback 两种模式。
      // 阻止 folder 拖进自己或自己的子孙：避免在数据层形成循环引用
      onMove(evt) {
        const dragged = evt.dragged;
        if (!dragged || dragged.dataset.nodeType !== 'folder') return true;
        const draggedId = dragged.dataset.folderId;
        if (!draggedId) return true;
        let p = evt.to;
        while (p && p !== document.body) {
          if (p.dataset && p.dataset.folderId === draggedId) return false;
          p = p.parentElement;
        }
        return true;
      },
      onStart() { isDragging = true; },
      onEnd() {
        isDragging = false;
        clearDragHover();
        rebuildTreeFromDom();
        // 在 name / mtime 模式下拖动 → 自动切到 custom：
        // 当前 DOM 顺序就是用户拖完后的最终态，rebuildTreeFromDom 已写入 state.tree
        // 不需要再 renderTree——custom 模式下渲染就按数据顺序，DOM 已正确
        if (state.sortMode !== 'custom') {
          state.sortMode = 'custom';
          localStorage.setItem('atlas:sortMode', 'custom');
          updateSortBar();
          // 不发 toast——分段控件上的"自定义"按钮高亮变化本身就是反馈
        }
      },
    }));
  }
}

// hover-to-expand：拖拽悬停在折叠 folder 头上 600ms 自动展开
// forceFallback 模式下用 document mousemove + elementFromPoint 检测，
// 比 onMove 更可靠（onMove 仅在 sibling 切换时触发，错过 hover 在 folder header 上的情况）
let isDragging = false;
let dragHoverHead = null;
let dragHoverTimer = null;
function clearDragHover() {
  if (dragHoverTimer) { clearTimeout(dragHoverTimer); dragHoverTimer = null; }
  if (dragHoverHead) { dragHoverHead.classList.remove('drag-hover'); dragHoverHead = null; }
}
document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  // 用 elementFromPoint 拿真实位置下方元素（绕开 SortableJS ghost 干扰）
  const elAt = document.elementFromPoint(e.clientX, e.clientY);
  let head = elAt && typeof elAt.closest === 'function' ? elAt.closest('.folder-header') : null;
  if (head) {
    const parent = head.parentElement;
    if (!parent || !parent.classList.contains('folder') || !parent.classList.contains('collapsed')) {
      head = null;
    }
  }
  if (head === dragHoverHead) return;
  clearDragHover();
  if (head) {
    dragHoverHead = head;
    head.classList.add('drag-hover');
    dragHoverTimer = setTimeout(() => {
      const folderEl = head.closest('.folder');
      if (!folderEl) return;
      const folderId = folderEl.dataset.folderId;
      if (state.collapsed.has(folderId)) {
        state.collapsed.delete(folderId);
        saveCollapsed();
        folderEl.classList.remove('collapsed');
      }
      head.classList.remove('drag-hover');
      dragHoverHead = null;
      dragHoverTimer = null;
    }, 600);
  }
});

function rebuildTreeFromDom() {
  const newTree = readContainer(els.tree);
  state.tree = newTree;
  scheduleSaveTree();
}
function readContainer(containerEl) {
  const out = [];
  for (const child of containerEl.children) {
    if (child.dataset.nodeType === 'folder') {
      const id = child.dataset.folderId;
      const original = findFolderById(state.tree, id);
      const childrenEl = child.querySelector('.folder-children');
      out.push({
        id,
        type: 'folder',
        name: original ? original.name : child.querySelector('.folder-name').textContent.trim(),
        collapsed: state.collapsed.has(id),
        children: childrenEl ? readContainer(childrenEl) : [],
      });
    } else if (child.dataset.nodeType === 'file') {
      out.push({ type: 'file', path: child.dataset.path });
    }
  }
  return out;
}
function findFolderById(nodes, id) {
  for (const n of nodes) {
    if (n.type === 'folder') {
      if (n.id === id) return n;
      const r = findFolderById(n.children, id);
      if (r) return r;
    }
  }
  return null;
}

// ---------- 打开文件 ----------
async function openFile(filePath) {
  const file = state.files[filePath];
  if (!file) return;
  setActiveFile(filePath, true);

  // 更新 recent（即时本地，server 端会通过 /api/seen 同步）
  state.recent = [filePath, ...(state.recent || []).filter(p => p !== filePath)].slice(0, 10);

  if (file.unread) {
    file.unread = false;
    file.seenAt = Date.now();
    await fetch('/api/seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    }).catch(console.error);
    updateUnreadDecorations();
  } else {
    // 即使没有 unread 也要把这次打开 push 到 server 的 recent
    fetch('/api/seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    }).catch(() => {});
  }
  renderRecent();
}

function updateUnreadDecorations() {
  els.tree.querySelectorAll('.file').forEach(fileEl => {
    const f = state.files[fileEl.dataset.path];
    if (!f) return;
    fileEl.classList.toggle('unread', !!f.unread);
  });
  els.tree.querySelectorAll('.folder').forEach(folderEl => {
    const fid = folderEl.dataset.folderId;
    const folder = findFolderById(state.tree, fid);
    if (!folder) return;
    const counts = countDescendants(folder);
    const dot = folderEl.querySelector(':scope > .folder-header > .folder-unread-dot');
    if (counts.unread > 0) {
      if (!dot) {
        const newDot = document.createElement('span');
        newDot.className = 'folder-unread-dot';
        newDot.title = counts.unread + ' 个未读';
        const header = folderEl.querySelector(':scope > .folder-header');
        const countEl = header.querySelector('.folder-count');
        header.insertBefore(newDot, countEl);
      } else {
        dot.title = counts.unread + ' 个未读';
      }
    } else if (dot) {
      dot.remove();
    }
  });
  const total = Object.values(state.files).filter(f => f.unread).length;
  els.stats.textContent = `${Object.keys(state.files).length} 个文档 · ${total} 未读`;
}

function setActiveFile(filePath, doNavigate) {
  // 编辑模式下切换到别的文件：先确认丢弃改动并退出编辑
  if (doNavigate && editState.active && editState.path && editState.path !== filePath) {
    if (!confirmDiscardIfDirty()) return;
    exitEditMode({ restore: false });
  }
  state.activeFilePath = filePath;
  els.tree.querySelectorAll('.file.active').forEach(e => e.classList.remove('active'));
  // 切换 active 时清除键盘焦点态，避免"两个被选中"的视觉异常
  els.tree.querySelectorAll('.file.kbd-focus').forEach(e => e.classList.remove('kbd-focus'));
  const fileEl = els.tree.querySelector(`.file[data-path="${CSS.escape(filePath)}"]`);
  if (fileEl) fileEl.classList.add('active');

  const file = state.files[filePath];
  if (!file) return;
  const aliasPart = file.alias
    ? `<span class="crumb-alias">${escapeHtml(file.alias)}</span><span class="crumb-original">（${escapeHtml(file.name)}）</span>`
    : `<span class="crumb-name">${escapeHtml(file.name)}</span>`;
  const dtype = isMdFile(file) ? 'md' : 'html';
  els.crumbs.innerHTML = `
    <span class="file-type-badge type-${dtype}">${dtype === 'md' ? 'MD' : 'HTML'}</span>
    <span class="crumb-project">${escapeHtml(file.projectName)}</span>
    <span class="crumb-sep">›</span>
    ${aliasPart}
    <span class="crumb-meta">更新于 ${fmtMtime(file.mtime)}</span>
  `;
  els.btnMarkUnread.disabled = false;
  els.btnReveal.disabled = false;
  els.btnOpenExternal.disabled = false;
  els.btnCopyPath.disabled = false;
  els.btnReloadPreview.disabled = false;
  // PDF 导出目前仅支持 HTML；md 文件禁用该按钮
  els.btnExportPdf.disabled = isMdFile(file);
  els.btnExportPdf.title = isMdFile(file) ? 'PDF 导出暂仅支持 HTML 文档' : '导出为 PDF 保存到 Downloads';
  els.btnShare.disabled = false;
  els.btnEdit.disabled = false;
  // 已在分享中的文件，让顶栏 share 按钮高亮提示状态
  els.btnShare.classList.toggle('shared', state.sharesByPath && state.sharesByPath.has(file.path));

  if (doNavigate) {
    els.preview.classList.remove('hidden');
    els.emptyState.classList.add('hidden');
    // 切换前淡出，加载完成后淡入；同 url 直接显示不闪烁
    const previewUrl = previewUrlFor(file);
    const targetUrl = new URL(previewUrl, location.href).href;
    if (els.preview.src !== targetUrl) {
      els.preview.classList.add('loading');
      els.preview.src = previewUrl;
    } else {
      els.preview.classList.remove('loading');
    }
  }
}

els.preview.addEventListener('load', () => {
  if (editState.active && editState.kind === 'html') {
    // 编辑文档加载完成 → 绑定可编辑区域，并恢复进入编辑前的滚动位置
    bindEditableDoc();
    applyPendingScroll(pendingEditScroll);
    pendingEditScroll = null;
  } else {
    // 退出编辑后重载 /raw/：恢复之前的滚动锚点
    applyPendingScroll(pendingPreviewScroll);
    pendingPreviewScroll = null;
    updateIframeHighlight();
  }
  // 滚动就位后再淡入，避免看到从顶部滚动的过程
  els.preview.classList.remove('loading');
});

// ==================== 预览区轻量编辑 ====================
const EDIT_STYLE_ATTR = 'data-atlas-edit-style';

// 退出编辑重载 /raw/、或进入编辑切到编辑文档时，用于保持滚动锚点不跳变
let pendingPreviewScroll = null;
let pendingEditScroll = null;

// 在 iframe 仍处于淡入前（.loading opacity:0）时恢复滚动。
// 强制 scroll-behavior:auto 覆盖页面可能的 smooth，避免出现「从顶部滚下来」的动画。
function applyPendingScroll(target) {
  if (!target) return;
  const doScroll = () => {
    try {
      const w = els.preview.contentWindow;
      const doc = w.document;
      const root = doc.scrollingElement || doc.documentElement;
      const prevRoot = root && root.style.scrollBehavior;
      const prevBody = doc.body && doc.body.style.scrollBehavior;
      if (root) root.style.scrollBehavior = 'auto';
      if (doc.body) doc.body.style.scrollBehavior = 'auto';
      w.scrollTo(target.x, target.y);
      if (root) root.scrollTop = target.y, root.scrollLeft = target.x;
      if (root) root.style.scrollBehavior = prevRoot || '';
      if (doc.body) doc.body.style.scrollBehavior = prevBody || '';
    } catch {}
  };
  doScroll();
  requestAnimationFrame(doScroll);
}

function confirmDiscardIfDirty() {
  if (!editState.active || !editState.dirty) return true;
  return window.confirm('当前有未保存的编辑改动，确定要放弃吗？');
}

// 进入编辑模式：把 iframe 切到带锚点的编辑文档
function enterEditMode() {
  const filePath = state.activeFilePath;
  const file = filePath && state.files[filePath];
  if (!file || editState.active) return;

  editState.active = true;
  editState.kind = 'html';
  editState.path = filePath;
  editState.rawUrl = file.url;       // 取消时恢复到只读预览
  editState.baseHash = null;
  editState.dirty = false;
  editState.ops = new Map();
  editState.sortables = [];
  editState.saving = false;

  updateEditToolbar();
  els.preview.classList.remove('hidden');
  els.emptyState.classList.add('hidden');
  // 记录当前滚动位置，编辑文档加载后恢复，避免跳到顶部
  try {
    const w = els.preview.contentWindow;
    pendingEditScroll = { x: w.scrollX || 0, y: w.scrollY || 0 };
  } catch { pendingEditScroll = null; }
  els.preview.classList.add('loading');
  els.preview.src = '/api/edit-doc?path=' + encodeURIComponent(filePath);
}

// ==================== Markdown 编辑：源码 + 实时预览 ====================
let mdRenderScheduled = false;

function renderMdPreview() {
  if (!els.mdPreview || !window.AtlasMarkdown) return;
  els.mdPreview.innerHTML = window.AtlasMarkdown.render(els.mdSource.value);
}
// 每帧渲染：合并连续输入，视觉上即时更新，不卡输入
function scheduleMdRender() {
  if (mdRenderScheduled) return;
  mdRenderScheduled = true;
  requestAnimationFrame(() => {
    mdRenderScheduled = false;
    renderMdPreview();
  });
}

// 进入 Markdown 编辑模式：拉取源码 → 填入 textarea → 渲染预览 → 显示分栏编辑器
async function enterMdEditMode() {
  const filePath = state.activeFilePath;
  const file = filePath && state.files[filePath];
  if (!file || editState.active) return;

  let data;
  try {
    const r = await fetch('/api/md-source?path=' + encodeURIComponent(filePath));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    showToast({ kind: 'error', text: '无法加载 Markdown 源码：' + e.message });
    return;
  }

  editState.active = true;
  editState.kind = 'md';
  editState.path = filePath;
  editState.rawUrl = previewUrlFor(file);   // 取消/保存后恢复只读预览
  editState.baseHash = data.hash || null;
  editState.dirty = false;
  editState.ops = new Map();
  editState.sortables = [];
  editState.saving = false;

  // 记录进入编辑前只读预览（iframe）的滚动百分比，编辑器按同比例定位，
  // 避免跳到文档末尾
  let enterPct = 0;
  try {
    const w = els.preview.contentWindow;
    const el = w.document.scrollingElement || w.document.documentElement;
    const max = el.scrollHeight - el.clientHeight;
    enterPct = max > 0 ? el.scrollTop / max : 0;
  } catch { enterPct = 0; }

  els.mdSource.value = data.content || '';
  renderMdPreview();

  updateEditToolbar();
  els.emptyState.classList.add('hidden');
  els.preview.classList.add('hidden');   // 隐藏 iframe，显示分栏编辑器
  els.mdEditor.classList.remove('hidden');
  // 预览区可直接编辑（所见即所得），编辑后实时同步回源码
  els.mdPreview.setAttribute('contenteditable', 'true');
  els.mdPreview.setAttribute('spellcheck', 'false');

  // 光标置顶，避免 focus 把 textarea 滚到末尾
  els.mdSource.focus();
  try { els.mdSource.setSelectionRange(0, 0); } catch {}

  // 下一帧（布局就绪后）按之前浏览位置的百分比同步定位源码区与预览区
  requestAnimationFrame(() => {
    const sMax = els.mdSource.scrollHeight - els.mdSource.clientHeight;
    const pMax = els.mdPreview.scrollHeight - els.mdPreview.clientHeight;
    els.mdSource.scrollTop = enterPct * sMax;
    els.mdPreview.scrollTop = enterPct * pMax;
  });
}

// textarea 输入 → 每帧刷新预览 + 标脏（实时）
if (els.mdSource) {
  els.mdSource.addEventListener('input', () => {
    if (editState.active && editState.kind === 'md') markDirty();
    scheduleMdRender();
  });
  // Tab 键插入缩进而非切换焦点
  els.mdSource.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = els.mdSource.selectionStart, en = els.mdSource.selectionEnd;
      const v = els.mdSource.value;
      els.mdSource.value = v.slice(0, s) + '  ' + v.slice(en);
      els.mdSource.selectionStart = els.mdSource.selectionEnd = s + 2;
      if (editState.active && editState.kind === 'md') markDirty();
      scheduleMdRender();
    }
  });

  // 编辑区 / 预览区滚动同步（按百分比双向联动，rAF 防抖避免回环）
  let mdSyncing = false;
  const syncScroll = (fromEl, toEl) => {
    if (mdSyncing) return;
    mdSyncing = true;
    const sMax = fromEl.scrollHeight - fromEl.clientHeight;
    const tMax = toEl.scrollHeight - toEl.clientHeight;
    const pct = sMax > 0 ? fromEl.scrollTop / sMax : 0;
    toEl.scrollTop = pct * tMax;
    requestAnimationFrame(() => { mdSyncing = false; });
  };
  els.mdSource.addEventListener('scroll', () => syncScroll(els.mdSource, els.mdPreview), { passive: true });
  els.mdPreview.addEventListener('scroll', () => syncScroll(els.mdPreview, els.mdSource), { passive: true });

  // 预览区（所见即所得）编辑 → 每帧反向序列化回源码 textarea（不回写预览，避免打断输入/光标）
  let mdSerializeScheduled = false;
  const scheduleMdSerialize = () => {
    if (mdSerializeScheduled) return;
    mdSerializeScheduled = true;
    requestAnimationFrame(() => {
      mdSerializeScheduled = false;
      if (!window.AtlasMarkdown || !window.AtlasMarkdown.htmlToMarkdown) return;
      els.mdSource.value = window.AtlasMarkdown.htmlToMarkdown(els.mdPreview);
    });
  };
  els.mdPreview.addEventListener('input', () => {
    if (!(editState.active && editState.kind === 'md')) return;
    markDirty();
    scheduleMdSerialize();
  });
  // 编辑态下预览区里的链接不跳转（否则点链接会导航走掉）
  els.mdPreview.addEventListener('click', (e) => {
    if (!els.mdPreview.isContentEditable) return;
    const a = e.target.closest && e.target.closest('a');
    if (a) e.preventDefault();
  });
}

// 保存 Markdown：把 textarea 全文写回文件
async function saveMdEdit() {
  if (!editState.active || editState.saving) return;
  if (!editState.dirty) {
    showToast({ kind: 'info', text: '没有改动' });
    exitEditMode({ restore: true });
    return;
  }
  editState.saving = true;
  updateEditToolbar();
  try {
    const resp = await fetch('/api/save-md', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: editState.path, baseHash: editState.baseHash, content: els.mdSource.value }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      const savedPath = editState.path;
      showToast({ kind: 'success', text: '已保存到文件' });
      if (state.files[savedPath]) {
        state.files[savedPath].unread = false;
        state.files[savedPath].seenAt = Date.now();
      }
      exitEditMode({ restore: true });
    } else if (resp.status === 409) {
      editState.saving = false;
      updateEditToolbar();
      showToast({ kind: 'error', text: '文件已被外部修改，请取消后重新打开再编辑' });
    } else {
      editState.saving = false;
      updateEditToolbar();
      showToast({ kind: 'error', text: '保存失败：' + (data.error || resp.status) });
    }
  } catch (e) {
    editState.saving = false;
    updateEditToolbar();
    showToast({ kind: 'error', text: '保存失败：' + e.message });
  }
}

// iframe 编辑文档加载完成后调用：注入样式 + 绑定 contentEditable / Sortable
function bindEditableDoc() {
  const doc = (() => { try { return els.preview.contentDocument; } catch { return null; } })();
  if (!doc || !doc.body) return;

  // 读 baseHash
  const meta = doc.querySelector('meta[name="atlas-base-hash"]');
  editState.baseHash = meta ? meta.getAttribute('content') : null;

  injectEditStyle(doc);

  // 编辑模式下拦截链接跳转 / 表单提交：可编辑文字常位于 <a> 内，点击编辑
  // 不应让 iframe 导航走掉（否则整页跳到 base href 目录，报 Cannot GET）
  doc.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('a, area')) {
      e.preventDefault();
    }
  }, true);
  doc.addEventListener('submit', (e) => { e.preventDefault(); }, true);

  // 文本节点：可就地编辑
  const textEls = doc.querySelectorAll('span[data-atlas-role="text"][data-atlas-eid]');
  textEls.forEach((el) => {
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.addEventListener('input', () => {
      const eid = parseInt(el.getAttribute('data-atlas-eid'), 10);
      editState.ops.set(eid, { eid, type: 'setText', text: el.textContent });
      markDirty();
    });
    // 编辑时回车不插入换行（保持单段文本）
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });
  });

  // 列表容器：拖动重排（仅同容器内）。SortableJS 需在 iframe 内运行，
  // 否则跨文档事件绑定不可靠 → 把 vendor 脚本注入 iframe 后再绑定。
  const lists = doc.querySelectorAll('[data-atlas-role="list"][data-atlas-eid]');
  if (lists.length > 0) {
    ensureSortableInIframe(doc, els.preview.contentWindow, (SortableCtor) => {
      if (!SortableCtor) return;
      let groupSeq = 0;
      lists.forEach((container) => {
        const containerEid = parseInt(container.getAttribute('data-atlas-eid'), 10);
        const itemSelector = '[data-atlas-role="list-item"][data-atlas-eid]';
        const s = SortableCtor.create(container, {
          group: 'atlas-edit-' + (groupSeq++),   // 唯一 group：禁止跨容器
          draggable: itemSelector,
          animation: 150,
          forceFallback: true,                    // 走统一 mouse 事件路径（更稳、可测）
          // 从可编辑文本上按下不触发拖拽（卡片含标题/正文时可正常选词编辑）
          filter: '[data-atlas-role="text"], [contenteditable="true"]',
          preventOnFilter: false,
          ghostClass: 'atlas-edit-ghost',
          onSort: () => {
            const order = Array.from(container.children)
              .filter((c) => c.matches(itemSelector))
              .map((c) => parseInt(c.getAttribute('data-atlas-eid'), 10));
            editState.ops.set(containerEid, { eid: containerEid, type: 'reorder', order });
            markDirty();
          },
        });
        editState.sortables.push(s);
      });
    });
  }

  // 链接编辑：点入 <a> 内文字时浮出小编辑条，可改 href
  setupLinkEditing(doc);

  if (textEls.length === 0 && lists.length === 0) {
    showToast({ kind: 'info', text: '此文档没有可编辑的文案或列表' });
  }
}

// 在编辑文档里挂一个浮动「链接编辑条」：当焦点进入某个 <a> 内的可编辑文字时，
// 浮出输入框显示/修改该链接的 href。改动记为 setAttr op，保存时写回。
function setupLinkEditing(doc) {
  let bar = null, input = null, currentAnchor = null, hideTimer = null;
  const win = doc.defaultView;

  function ensureBar() {
    if (bar) return;
    bar = doc.createElement('div');
    bar.setAttribute('data-atlas-linkbar', '1');
    bar.hidden = true;
    const ico = doc.createElement('span');
    ico.className = 'lk-ico';
    ico.textContent = '🔗';
    input = doc.createElement('input');
    input.type = 'text';
    input.placeholder = '链接地址 (href)';
    bar.appendChild(ico);
    bar.appendChild(input);
    doc.body.appendChild(bar);

    input.addEventListener('input', () => {
      if (!currentAnchor) return;
      const eid = parseInt(currentAnchor.getAttribute('data-atlas-eid'), 10);
      const v = input.value;
      editState.ops.set(eid, { eid, type: 'setAttr', name: 'href', value: v });
      currentAnchor.setAttribute('data-atlas-href', v);
      currentAnchor.setAttribute('href', v);
      markDirty();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); input.blur(); }
    });
  }

  function showFor(anchor, span) {
    ensureBar();
    currentAnchor = anchor;
    const cur = anchor.getAttribute('data-atlas-href');
    input.value = cur != null ? cur : (anchor.getAttribute('href') || '');
    bar.hidden = false;
    const r = span.getBoundingClientRect();
    const top = r.top + (win.scrollY || 0) - 40;
    const left = r.left + (win.scrollX || 0);
    bar.style.top = Math.max(2, top) + 'px';
    bar.style.left = Math.max(2, left) + 'px';
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const ae = doc.activeElement;
      if (bar && bar.contains(ae)) return;
      if (ae && ae.matches && ae.matches('span[data-atlas-role="text"]') && ae.closest('[data-atlas-link]')) return;
      if (bar) bar.hidden = true;
      currentAnchor = null;
    }, 140);
  }

  doc.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('span[data-atlas-role="text"]')) {
      const anchor = t.closest('[data-atlas-link][data-atlas-eid]');
      if (anchor) showFor(anchor, t);
    }
  }, true);
  doc.addEventListener('focusout', scheduleHide, true);
}

// 把 SortableJS 注入到 iframe 内（同源），确保拖拽事件在 iframe 文档内绑定
function ensureSortableInIframe(doc, win, cb) {
  if (win && win.Sortable) return cb(win.Sortable);
  const existing = doc.querySelector('script[data-atlas-sortable]');
  if (existing) {
    existing.addEventListener('load', () => cb(win.Sortable || null));
    return;
  }
  const s = doc.createElement('script');
  s.src = '/vendor/Sortable.min.js';   // 绝对路径，绕过 base href
  s.setAttribute('data-atlas-sortable', '1');
  s.onload = () => cb(win.Sortable || null);
  s.onerror = () => cb(null);
  (doc.head || doc.documentElement).appendChild(s);
}

function injectEditStyle(doc) {
  if (doc.querySelector(`style[${EDIT_STYLE_ATTR}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(EDIT_STYLE_ATTR, '1');
  style.textContent = `
    [data-atlas-role="text"] {
      outline: 1px dashed rgba(91,156,255,.55);
      outline-offset: 2px;
      border-radius: 3px;
      cursor: text;
      transition: background .12s ease, outline-color .12s ease;
    }
    [data-atlas-role="text"]:hover {
      outline-color: rgba(91,156,255,.95);
      background: rgba(91,156,255,.10);
    }
    [data-atlas-role="text"]:focus {
      outline: 2px solid #5b9cff;
      background: rgba(91,156,255,.14);
    }
    [data-atlas-role="list-item"] {
      cursor: grab;
      position: relative;
    }
    [data-atlas-role="list-item"]:hover {
      outline: 1px dashed rgba(91,156,255,.45);
      outline-offset: 2px;
      border-radius: 3px;
    }
    .atlas-edit-ghost {
      opacity: .5;
      background: rgba(91,156,255,.18) !important;
      outline: 2px solid #5b9cff;
    }
    [data-atlas-linkbar] {
      position: absolute; z-index: 2147483600;
      display: flex; align-items: center; gap: 6px;
      padding: 4px 7px; border-radius: 8px;
      background: #1d222b; color: #e6e8ec;
      border: 1px solid #5b9cff;
      box-shadow: 0 6px 22px rgba(0,0,0,.38);
      font: 12px/1.4 -apple-system, system-ui, sans-serif;
    }
    [data-atlas-linkbar][hidden] { display: none; }
    [data-atlas-linkbar] .lk-ico { flex: none; }
    [data-atlas-linkbar] input {
      width: 280px; max-width: 52vw;
      border: 1px solid #3a4150; border-radius: 5px;
      background: #0f1217; color: #e6e8ec;
      padding: 3px 7px; font: inherit; outline: none;
    }
    [data-atlas-linkbar] input:focus { border-color: #5b9cff; }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

function markDirty() {
  if (!editState.dirty) {
    editState.dirty = true;
    updateEditToolbar();
  }
}

// 退出编辑模式（清理 Sortable / 状态）；restore=true 时把预览切回只读预览
function exitEditMode({ restore } = { restore: true }) {
  for (const s of editState.sortables) {
    try { s.destroy(); } catch {}
  }
  const wasMd = editState.kind === 'md';
  const rawUrl = editState.rawUrl;
  editState.active = false;
  editState.kind = 'html';
  editState.path = null;
  editState.baseHash = null;
  editState.dirty = false;
  editState.ops = new Map();
  editState.sortables = [];
  editState.saving = false;
  updateEditToolbar();

  if (wasMd) {
    // Markdown：隐藏分栏编辑器，恢复 iframe 只读预览
    els.mdPreview.removeAttribute('contenteditable');
    els.mdEditor.classList.add('hidden');
    els.preview.classList.remove('hidden');
    if (restore && rawUrl) {
      els.preview.classList.add('loading');
      // 强制重载（源可能未变，用 reload 保证刷新渲染结果）
      if (els.preview.src === new URL(rawUrl, location.href).href && els.preview.contentWindow) {
        try { els.preview.contentWindow.location.reload(); } catch { els.preview.src = rawUrl; }
      } else {
        els.preview.src = rawUrl;
      }
    }
    return;
  }

  if (restore && rawUrl) {
    // 记录当前滚动位置，重载后恢复，避免保存/取消后跳回顶部
    try {
      const w = els.preview.contentWindow;
      pendingPreviewScroll = { x: w.scrollX || 0, y: w.scrollY || 0 };
    } catch { pendingPreviewScroll = null; }
    els.preview.classList.add('loading');
    els.preview.src = rawUrl;
  }
}

function cancelEdit() {
  if (!editState.active) return;
  if (!confirmDiscardIfDirty()) return;
  exitEditMode({ restore: true });
}

async function saveEdit() {
  if (!editState.active || editState.saving) return;
  if (editState.kind === 'md') return saveMdEdit();
  const ops = Array.from(editState.ops.values());
  if (ops.length === 0 || !editState.dirty) {
    showToast({ kind: 'info', text: '没有改动' });
    exitEditMode({ restore: true });
    return;
  }
  editState.saving = true;
  updateEditToolbar();
  try {
    const resp = await fetch('/api/save-edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: editState.path, baseHash: editState.baseHash, ops }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      const savedPath = editState.path;
      showToast({ kind: 'success', text: '已保存到文件' });
      // 标已读（防止自我写入红点）
      if (state.files[savedPath]) {
        state.files[savedPath].unread = false;
        state.files[savedPath].seenAt = Date.now();
      }
      exitEditMode({ restore: true });   // 切回 /raw/ 展示已保存结果
    } else if (resp.status === 409) {
      editState.saving = false;
      updateEditToolbar();
      showToast({ kind: 'error', text: '文件已被外部修改，请取消后重新打开再编辑' });
    } else {
      editState.saving = false;
      updateEditToolbar();
      showToast({ kind: 'error', text: '保存失败：' + (data.error || resp.status) });
    }
  } catch (e) {
    editState.saving = false;
    updateEditToolbar();
    showToast({ kind: 'error', text: '保存失败：' + e.message });
  }
}

// 切换工具栏到编辑态 / 常规态
function updateEditToolbar() {
  const editing = editState.active;
  els.btnEdit.classList.toggle('hidden', editing);
  els.btnEditSave.classList.toggle('hidden', !editing);
  els.btnEditCancel.classList.toggle('hidden', !editing);
  els.btnEditSave.disabled = editState.saving;
  els.btnEditSave.textContent = editState.saving ? '保存中…' : '保存';
  els.btnEditCancel.disabled = editState.saving;
  // 编辑态下禁用会冲突的操作
  [els.btnExportPdf, els.btnShare, els.btnReloadPreview, els.btnMarkUnread].forEach((b) => {
    if (b) b.disabled = editing ? true : b.disabled;
  });
  if (!editing && state.activeFilePath) {
    // 退出编辑后恢复这些按钮可用
    const activeFile = state.files[state.activeFilePath];
    els.btnExportPdf.disabled = isMdFile(activeFile);
    els.btnShare.disabled = false;
    els.btnReloadPreview.disabled = false;
    els.btnMarkUnread.disabled = false;
  }
  // 编辑态给主区域一个视觉标识
  document.body.classList.toggle('editing-mode', editing);
}

els.btnEdit.addEventListener('click', () => {
  if (els.btnEdit.disabled) return;
  const file = state.activeFilePath && state.files[state.activeFilePath];
  if (isMdFile(file)) enterMdEditMode();
  else enterEditMode();
});
els.btnEditSave.addEventListener('click', () => saveEdit());
els.btnEditCancel.addEventListener('click', () => cancelEdit());

// 有未保存改动时离开页面拦截
window.addEventListener('beforeunload', (e) => {
  if (editState.active && editState.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});


// ---------- iframe 内高亮搜索命中 ----------
// 同源（都是 localhost:4321），可直接操作 contentDocument
const HIGHLIGHT_STYLE_ATTR = 'data-atlas-hl-style';
const HIGHLIGHT_MARK_ATTR = 'data-atlas-hl';

function clearIframeHighlight(doc) {
  if (!doc) return;
  doc.querySelectorAll(`mark[${HIGHLIGHT_MARK_ATTR}]`).forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

function injectHighlightStyle(doc) {
  if (doc.querySelector(`style[${HIGHLIGHT_STYLE_ATTR}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(HIGHLIGHT_STYLE_ATTR, '1');
  style.textContent = `
    mark[${HIGHLIGHT_MARK_ATTR}] {
      background: #fff176 !important;
      color: #1a1a1a !important;
      padding: 0 1px;
      border-radius: 2px;
      box-shadow: 0 0 0 1px #fbc02d40;
    }
    mark[${HIGHLIGHT_MARK_ATTR}].atlas-hl-current {
      background: #ff9800 !important;
      box-shadow: 0 0 0 2px #ff5722, 0 4px 12px rgba(255, 87, 34, 0.4) !important;
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

let highlightMatches = [];
let highlightCurrentIdx = -1;

function highlightInIframe(query) {
  const doc = (() => {
    try { return els.preview.contentDocument; } catch { return null; }
  })();
  if (!doc || !doc.body) return;

  clearIframeHighlight(doc);
  highlightMatches = [];
  highlightCurrentIdx = -1;
  updateMatchBadge(0, 0);

  if (!query) return;
  const q = query.toLowerCase();
  const ql = q.length;

  injectHighlightStyle(doc);

  // 收集所有要拆分的 text node，避免遍历时同时 mutate
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
          p.closest(`[${HIGHLIGHT_MARK_ATTR}]`)) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.nodeValue || '';
      return text.toLowerCase().indexOf(q) >= 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const todo = [];
  while (walker.nextNode()) todo.push(walker.currentNode);

  for (const node of todo) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const frag = doc.createDocumentFragment();
    let last = 0;
    let idx = 0;
    while ((idx = lower.indexOf(q, last)) !== -1) {
      if (idx > last) frag.appendChild(doc.createTextNode(text.slice(last, idx)));
      const mark = doc.createElement('mark');
      mark.setAttribute(HIGHLIGHT_MARK_ATTR, '1');
      mark.textContent = text.slice(idx, idx + ql);
      frag.appendChild(mark);
      highlightMatches.push(mark);
      last = idx + ql;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
  }

  if (highlightMatches.length > 0) {
    highlightCurrentIdx = 0;
    highlightMatches[0].classList.add('atlas-hl-current');
    highlightMatches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  updateMatchBadge(highlightMatches.length, highlightCurrentIdx);
}

function gotoMatch(delta) {
  if (!highlightMatches.length) return;
  const cur = highlightMatches[highlightCurrentIdx];
  if (cur) cur.classList.remove('atlas-hl-current');
  highlightCurrentIdx = (highlightCurrentIdx + delta + highlightMatches.length) % highlightMatches.length;
  const next = highlightMatches[highlightCurrentIdx];
  next.classList.add('atlas-hl-current');
  next.scrollIntoView({ block: 'center', behavior: 'smooth' });
  updateMatchBadge(highlightMatches.length, highlightCurrentIdx);
}

function updateMatchBadge(total, currentIdx) {
  const badge = els.matchBadge;
  if (!badge) return;
  if (total === 0) {
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');
  badge.querySelector('.match-text').textContent = `${currentIdx + 1} / ${total}`;
}

// 在 search 改变 / iframe load 后被调用
function updateIframeHighlight() {
  highlightInIframe(state.search);
}

// 上下跳转按钮
els.matchPrev.addEventListener('click', () => gotoMatch(-1));
els.matchNext.addEventListener('click', () => gotoMatch(1));

// 搜索框聚焦时按 Enter 跳到下一处，Shift+Enter 上一处
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && highlightMatches.length > 0) {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  }
});

// ---------- 顶部按钮 ----------
let searchDebounceTimer = null;
els.recentToggle.addEventListener('click', () => {
  state.recentCollapsed = !state.recentCollapsed;
  localStorage.setItem('atlas:recentCollapsed', state.recentCollapsed ? '1' : '0');
  els.recentBar.classList.toggle('collapsed', state.recentCollapsed);
});

let contentSearchSeq = 0;
async function doContentSearch(q) {
  const my = ++contentSearchSeq;
  try {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q));
    if (!r.ok || my !== contentSearchSeq) return;
    const data = await r.json();
    if (my !== contentSearchSeq) return;
    state.contentMatches = new Map((data.matches || []).map(m => [m.path, m.snippet]));
    render();
  } catch {}
}

function shouldSearchContent(q) {
  if (!q) return false;
  if (q.length >= 2) return true;
  // 单字符：仅当非 ASCII（中文/日文等）才搜，'a' 这种太宽不搜
  return /[^\x00-\x7F]/.test(q);
}

els.search.addEventListener('input', (e) => {
  const v = e.target.value;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    if (state.search === v) return;
    state.search = v;
    state.contentMatches = new Map();   // 先按文件名渲染（即时反馈）
    render();
    if (shouldSearchContent(v)) doContentSearch(v);
    else contentSearchSeq++;             // cancel pending
    // 同步刷新 iframe 内高亮
    updateIframeHighlight();
  }, 80);
});
els.onlyUnread.addEventListener('change', (e) => { state.onlyUnread = e.target.checked; render(); });
els.btnRefresh.addEventListener('click', fetchState);

els.btnNewFolder.addEventListener('click', async () => {
  const name = prompt('新建顶层分组：', '新分组');
  if (!name) return;
  const res = await fetch('/api/folders/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.ok) fetchState();
});

els.btnMarkAll.addEventListener('click', async () => {
  if (!confirm('将所有文档标记为已读？')) return;
  await fetch('/api/seen/all', { method: 'POST' });
  fetchState();
});

els.btnMarkUnread.addEventListener('click', async () => {
  if (!state.activeFilePath) return;
  await fetch('/api/unseen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: state.activeFilePath }),
  });
  fetchState();
});
els.btnReveal.addEventListener('click', async () => {
  if (!state.activeFilePath) return;
  await fetch('/api/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: state.activeFilePath }),
  });
});
els.btnOpenExternal.addEventListener('click', () => {
  if (!state.activeFilePath) return;
  const f = state.files[state.activeFilePath];
  if (f) window.open(previewUrlFor(f), '_blank');
});
els.btnShare.addEventListener('click', () => {
  if (!state.activeFilePath) return;
  openShareModal(state.activeFilePath);
});
// 刷新当前 iframe 内的文档（不刷整个 Dashboard，保留树展开状态、滚动、未读等）
els.btnReloadPreview.addEventListener('click', () => {
  if (!state.activeFilePath) return;
  const ifr = els.preview;
  if (!ifr || !ifr.src) return;
  const filePath = state.activeFilePath;
  els.btnReloadPreview.classList.add('spinning');
  // 用 contentWindow.location.reload 而非 src 重赋值——保留 hash / location.search 不重置
  try {
    if (ifr.contentWindow && ifr.contentWindow.location) {
      ifr.contentWindow.location.reload();
    } else {
      // 兜底：跨源等无法访问 contentWindow 时用 src 重赋值
      const u = ifr.src;
      ifr.src = 'about:blank';
      requestAnimationFrame(() => { ifr.src = u; });
    }
  } catch {
    const u = ifr.src;
    ifr.src = 'about:blank';
    requestAnimationFrame(() => { ifr.src = u; });
  }
  // load 事件 = 加载完成；超时 1.5s 兜底防止动画卡住
  let cleared = false;
  const stop = () => {
    if (cleared) return;
    cleared = true;
    els.btnReloadPreview.classList.remove('spinning');
  };
  ifr.addEventListener('load', stop, { once: true });
  setTimeout(stop, 1500);

  // 文件外部更新时会被自动标回未读；reload 等同于"再次查看"，标为已读
  const file = state.files[filePath];
  if (file && file.unread) {
    file.unread = false;
    file.seenAt = Date.now();
    fetch('/api/seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    }).catch(() => {});
    updateUnreadDecorations();
  }
});

// 导出 PDF：后端 SSE 流推 phase 事件，前端 progress toast 实时切换阶段文字
// 找不到 chromium 时降级——调 iframe.contentWindow.print() 弹原生打印对话框
els.btnExportPdf.addEventListener('click', async () => {
  if (!state.activeFilePath) return;
  const filePath = state.activeFilePath;
  const file = state.files[filePath];
  if (!file) return;

  els.btnExportPdf.disabled = true;
  els.btnExportPdf.classList.add('spinning');

  const stem = (file.alias || file.name.replace(/\.html?$/i, '')).trim() || 'export';

  // 进度 toast——不自动消失，阶段切换时更新文字
  const prog = showToast({
    kind: 'info',
    progress: true,
    text: '导出 PDF',
    secondary: '准备启动浏览器…',
  });

  let resp;
  try {
    resp = await fetch('/api/export-pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath, fileName: stem }),
    });
  } catch (err) {
    prog.close();
    showToast({ kind: 'error', text: '导出失败', secondary: '网络错误：' + err.message, duration: 5000 });
    els.btnExportPdf.classList.remove('spinning');
    els.btnExportPdf.disabled = false;
    return;
  }

  if (!resp.ok || !resp.body) {
    prog.close();
    showToast({ kind: 'error', text: '导出失败', secondary: 'HTTP ' + resp.status, duration: 5000 });
    els.btnExportPdf.classList.remove('spinning');
    els.btnExportPdf.disabled = false;
    return;
  }

  // 流式读 SSE
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lastResult = null;

  while (true) {
    let chunk;
    try { chunk = await reader.read(); } catch { break; }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const ev of events) {
      const m = ev.match(/^data:\s*(.+)$/m);
      if (!m) continue;
      let data; try { data = JSON.parse(m[1]); } catch { continue; }
      lastResult = data;
      // 把每个阶段事件反映到 toast 的副消息
      switch (data.phase) {
        case 'launching': prog.setSecondary(data.message || '启动浏览器…'); break;
        case 'rendering': prog.setSecondary(data.message || '正在渲染页面…'); break;
        case 'writing':   prog.setSecondary(data.message || '正在写入 PDF…'); break;
        case 'retrying':  prog.setSecondary(data.message || '首次失败，重试中…'); break;
        // done / error 在循环结束后统一处理
      }
    }
  }

  els.btnExportPdf.classList.remove('spinning');
  els.btnExportPdf.disabled = false;
  prog.close();

  if (!lastResult) {
    showToast({ kind: 'error', text: '导出失败', secondary: '没有收到响应', duration: 5000 });
    return;
  }

  if (lastResult.phase === 'done' && lastResult.ok) {
    const t = showToast({
      kind: 'success',
      text: '✓ 已保存到 Downloads',
      secondary: lastResult.savedPath.replace(/^.*\/Downloads\//, 'Downloads/'),
      duration: 6000,
    });
    // 在 toast msg 里追加"在访达中显示"按钮
    const msgEl = t.el && t.el.querySelector('.toast-msg');
    if (msgEl) {
      const link = document.createElement('button');
      link.className = 'toast-action';
      link.textContent = '在访达中显示';
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        fetch('/api/reveal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: lastResult.savedPath }),
        }).catch(() => {});
      });
      msgEl.appendChild(link);
    }
    return;
  }

  // 找不到 chromium → 降级走 A：iframe.contentWindow.print()
  if (lastResult.reason === 'no-chromium') {
    showToast({
      kind: 'info',
      text: '未检测到 Chrome / Edge / Brave，使用浏览器打印框导出',
      secondary: '在弹出的对话框里"目标"选「另存为 PDF」',
      duration: 4500,
    });
    setTimeout(() => {
      try {
        if (els.preview && els.preview.contentWindow) {
          els.preview.contentWindow.focus();
          els.preview.contentWindow.print();
        }
      } catch (err) {
        showToast({ kind: 'error', text: '调起打印失败', secondary: err.message });
      }
    }, 600);
    return;
  }

  showToast({
    kind: 'error',
    text: '导出 PDF 失败',
    secondary: lastResult.message || lastResult.reason || '未知错误',
    duration: 5000,
  });
});
els.btnCopyPath.addEventListener('click', () => {
  if (!state.activeFilePath) return;
  navigator.clipboard.writeText(state.activeFilePath).then(() => {
    const orig = els.btnCopyPath.textContent;
    els.btnCopyPath.textContent = '✓';
    setTimeout(() => { els.btnCopyPath.textContent = orig; }, 1000);
  });
});

document.addEventListener('keydown', (e) => {
  // Cmd+B / Ctrl+B 切换侧边栏
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if (e.key === '/' && document.activeElement !== els.search && !document.activeElement.isContentEditable) {
    e.preventDefault();
    els.search.focus();
  }
  if (e.key === 'Escape' && document.activeElement === els.search) {
    els.search.value = '';
    state.search = '';
    render();
  }
});

// ---------- 键盘导航：搜索框 ↓ 进列表，列表 ↑↓ Enter Esc ----------
function visibleFilesInOrder() {
  return [...els.tree.querySelectorAll('.file')]
    .filter(el => !el.closest('.folder.collapsed'));
}
function setKbdFocus(el) {
  els.tree.querySelectorAll('.file.kbd-focus').forEach(e => e.classList.remove('kbd-focus'));
  if (el) {
    el.classList.add('kbd-focus');
    el.focus({ preventScroll: false });
    el.scrollIntoView({ block: 'nearest' });
  }
}
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    const list = visibleFilesInOrder();
    if (list.length) {
      e.preventDefault();
      setKbdFocus(list[0]);
    }
  }
});
els.tree.addEventListener('keydown', (e) => {
  // 不打断 inline rename / alias 编辑
  if (e.target.isContentEditable) return;
  const focused = e.target.closest('.file');
  if (!focused) return;
  const list = visibleFilesInOrder();
  const idx = list.indexOf(focused);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (idx < list.length - 1) setKbdFocus(list[idx + 1]);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (idx > 0) setKbdFocus(list[idx - 1]);
    else { setKbdFocus(null); els.search.focus(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openFile(focused.dataset.path);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    setKbdFocus(null);
    els.search.focus();
  }
});

// ---------- 设置弹窗 ----------
async function openSettings() {
  const res = await fetch('/api/config');
  const cfg = await res.json();
  renderRootList(cfg.scanRoots);
  // 已归档 + 已分享：拉最新
  try {
    const s = await (await fetch('/api/state')).json();
    state.archivedProjects = Array.isArray(s.archivedProjects) ? s.archivedProjects : [];
  } catch {}
  await refreshSharesState();
  renderArchiveList();
  renderShareList();
  els.ignoreInput.value = (cfg.ignore || []).join(', ');
  els.notifyToggle.checked = state.notifyEnabled;
  updateNotifyHint();
  // 文档类型多选：反映当前启用的类型（数组，可共存）
  const enabled = Array.isArray(cfg.docTypes) && cfg.docTypes.length ? cfg.docTypes : ['html'];
  els.doctypeRadios.forEach(cb => { cb.checked = enabled.includes(cb.value); });
  lastDocTypes = enabled.slice();
  els.modal.classList.remove('hidden');
}

// 记录上一次的勾选，用于失败/非法回滚
let lastDocTypes = null;
// 切换启用的文档类型（html / md 可共存）：写配置 → 平滑刷新
els.doctypeRadios.forEach(cb => {
  cb.addEventListener('change', async () => {
    const checked = [...els.doctypeRadios].filter(x => x.checked).map(x => x.value);
    // 至少保留一项
    if (checked.length === 0) {
      cb.checked = true;
      showToast({ kind: 'info', text: '至少保留一种文档类型' });
      return;
    }
    const prev = lastDocTypes || [...els.doctypeRadios].map(x => x.value); // 兜底
    lastDocTypes = checked.slice();

    // 立即给反馈：扫描指示 + 轻量 toast
    setScanning(true);
    const t = showToast({ kind: 'info', text: '正在应用文档类型…', progress: true });
    const ok = await updateConfig({ docTypes: checked });
    if (!ok) {
      // 回滚勾选
      els.doctypeRadios.forEach(x => { x.checked = prev.includes(x.value); });
      lastDocTypes = prev;
      setScanning(false);
      t.close();
      return;
    }

    // 平滑刷新：只在当前预览文件失效时才重置预览，否则保持不动
    const prevActive = state.activeFilePath;
    await fetchState();
    if (prevActive && !state.files[prevActive]) {
      if (editState.active) exitEditMode({ restore: false });
      state.activeFilePath = null;
      els.preview.src = 'about:blank';
      els.preview.classList.add('hidden');
      els.mdEditor.classList.add('hidden');
      els.emptyState.classList.remove('hidden');
      els.crumbs.innerHTML = '<span class="placeholder">从左侧选择一个文档开始预览</span>';
    }
    setScanning(false);
    t.close();
    const hasHtml = checked.includes('html'), hasMd = checked.includes('md');
    const label = hasHtml && hasMd ? 'HTML + Markdown' : hasMd ? 'Markdown' : 'HTML';
    showToast({ kind: 'success', text: '已更新扫描类型', secondary: label });
  });
});

function renderShareList() {
  if (!els.shareList) return;
  const list = [...state.sharesByPath.values()];
  els.shareList.innerHTML = '';
  els.shareStopAllBtn.disabled = list.length === 0;
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'share-list-empty';
    li.textContent = '当前没有正在分享的文件';
    els.shareList.appendChild(li);
    return;
  }
  // 按 sharedAt DESC
  list.sort((a, b) => (b.sharedAt || 0) - (a.sharedAt || 0));
  list.forEach(item => {
    const li = document.createElement('li');
    const file = state.files[item.path];
    const display = (file && file.alias) || item.name || item.path;
    const url = pickPreferredUrl(item.urls);
    li.innerHTML = `
      <span class="share-list-name"></span>
      <span class="share-list-url"></span>
      <button class="share-list-stop" type="button">停止</button>
    `;
    li.querySelector('.share-list-name').textContent = display;
    li.querySelector('.share-list-url').textContent = url;
    li.querySelector('.share-list-url').title = url;
    li.querySelector('.share-list-stop').addEventListener('click', async () => {
      try {
        const r = await fetch('/api/share/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: item.token }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        state.sharesByPath.delete(item.path);
        renderShareList();
        render();
        showToast({ kind: 'success', text: '已停止分享', secondary: display });
      } catch (err) {
        showToast({ kind: 'error', text: '停止失败', secondary: err.message });
      }
    });
    els.shareList.appendChild(li);
  });
}

els.shareStopAllBtn.addEventListener('click', async () => {
  const count = state.sharesByPath.size;
  if (count === 0) return;
  if (!confirm(`停止全部 ${count} 个分享？\n\n所有链接立即失效。`)) return;
  try {
    const r = await fetch('/api/share/stop-all', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    state.sharesByPath = new Map();
    renderShareList();
    render();
    showToast({ kind: 'success', text: `✓ 已停止 ${data.count} 个分享` });
  } catch (err) {
    showToast({ kind: 'error', text: '停止失败', secondary: err.message });
  }
});

function renderArchiveList() {
  if (!els.archiveList) return;
  const list = state.archivedProjects || [];
  els.archiveList.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'archive-empty';
    li.textContent = '没有归档的分组';
    els.archiveList.appendChild(li);
    return;
  }
  list.forEach(item => {
    // item 可能是 string（旧格式）或 { name, count }
    const name = typeof item === 'string' ? item : item.name;
    const count = typeof item === 'object' && item.count != null ? item.count : null;
    const li = document.createElement('li');
    const nameEl = document.createElement('span');
    nameEl.className = 'archive-name';
    nameEl.textContent = name;
    li.appendChild(nameEl);
    if (count != null) {
      const c = document.createElement('span');
      c.className = 'archive-count';
      c.textContent = count > 0 ? `磁盘 ${count} 个文档` : '磁盘已无文件';
      li.appendChild(c);
    }
    const btn = document.createElement('button');
    btn.className = 'archive-restore';
    btn.type = 'button';
    btn.textContent = '恢复';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await fetch('/api/archive/restore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        await r.json();
        // 重新拉 state 让分组立即重新出现
        await fetchState();
        // 重新渲染 archive-list
        renderArchiveList();
        showToast({ kind: 'success', text: `已恢复「${name}」` });
      } catch (err) {
        btn.disabled = false;
        showToast({ kind: 'error', text: '恢复失败', secondary: err.message });
      }
    });
    li.appendChild(btn);
    els.archiveList.appendChild(li);
  });
}
function closeSettings() { els.modal.classList.add('hidden'); }
els.btnSettings.addEventListener('click', openSettings);
els.modal.addEventListener('click', (e) => {
  if (e.target.dataset.close !== undefined) closeSettings();
});

function renderRootList(roots) {
  els.rootList.innerHTML = '';
  roots.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="root-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
      <button data-remove>✕</button>
    `;
    li.querySelector('[data-remove]').addEventListener('click', async () => {
      const next = roots.filter(x => x !== p);
      if (next.length === 0) {
        showToast({ kind: 'error', text: '至少保留一个扫描根目录' });
        return;
      }
      if (!confirm(`移除扫描根：\n${p}\n\n（不会删除磁盘上的任何文件）`)) return;
      const ok = await updateConfig({ scanRoots: next });
      if (ok) {
        const cfg = await (await fetch('/api/config')).json();
        renderRootList(cfg.scanRoots);
        fetchState();
        showToast({ kind: 'success', text: '已移除扫描根', secondary: p });
      }
    });
    els.rootList.appendChild(li);
  });
}

els.rootAddBtn.addEventListener('click', async () => {
  const v = els.rootInput.value.trim();
  if (!v) return;
  const cfg = await (await fetch('/api/config')).json();
  // 已存在不重复加
  if (cfg.scanRoots.some(p => p === v)) {
    showToast({ kind: 'info', text: '该目录已经在扫描列表里', secondary: v });
    els.rootInput.value = '';
    return;
  }
  const next = [...cfg.scanRoots, v];
  const ok = await updateConfig({ scanRoots: next });
  if (ok) {
    els.rootInput.value = '';
    const cfg2 = await (await fetch('/api/config')).json();
    renderRootList(cfg2.scanRoots);
    fetchState();
    showToast({ kind: 'success', text: '已添加扫描根', secondary: v });
  }
});

// ---------- 目录浏览器 picker ----------
let pickerHomePath = '';
async function loadDir(path) {
  const url = path ? '/api/browse?path=' + encodeURIComponent(path) : '/api/browse';
  els.dirList.innerHTML = '<div class="dir-empty">加载中…</div>';
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      els.dirList.innerHTML = `<div class="dir-empty">✗ ${escapeHtml(err.error || '加载失败')}</div>`;
      return;
    }
    const data = await r.json();
    pickerHomePath = data.home;
    els.dirCurrent.value = data.path;
    els.dirCurrent.dataset.path = data.path;
    els.dirUp.disabled = !data.parent;
    els.dirSelect.disabled = false;

    if (data.entries.length === 0) {
      els.dirList.innerHTML = '<div class="dir-empty">（此目录下没有子文件夹）</div>';
      return;
    }
    els.dirList.innerHTML = '';
    for (const entry of data.entries) {
      const div = document.createElement('div');
      div.className = 'dir-item';
      div.dataset.path = entry.path;
      div.innerHTML = `<span class="dir-icon">📁</span><span>${escapeHtml(entry.name)}</span>`;
      div.addEventListener('click', () => loadDir(entry.path));
      els.dirList.appendChild(div);
    }
  } catch (e) {
    els.dirList.innerHTML = `<div class="dir-empty">✗ 网络错误：${escapeHtml(e.message)}</div>`;
  }
}

els.rootBrowseBtn.addEventListener('click', () => {
  els.dirPicker.classList.remove('hidden');
  // 初始路径：input 里如果已有，用它；否则 home
  const seed = els.rootInput.value.trim();
  loadDir(seed || null);
});
els.dirCancel.addEventListener('click', () => {
  els.dirPicker.classList.add('hidden');
});
els.dirSelect.addEventListener('click', () => {
  const p = els.dirCurrent.dataset.path || els.dirCurrent.value.trim();
  if (p) {
    els.rootInput.value = p;
    els.dirPicker.classList.add('hidden');
  }
});
els.dirUp.addEventListener('click', () => {
  // 用当前路径计算父目录由后端处理：发当前路径的"父"作为 path
  // 先拿当前显示路径，让后端 resolve
  const cur = els.dirCurrent.dataset.path;
  if (!cur) return;
  // 简单本地处理父路径（兼容 win/posix）：取最后一个分隔符之前
  const sep = cur.includes('\\') ? '\\' : '/';
  const idx = cur.lastIndexOf(sep);
  if (idx <= 0) return loadDir(sep);
  loadDir(cur.slice(0, idx) || sep);
});
els.dirHome.addEventListener('click', () => {
  loadDir(pickerHomePath || null);
});
// 在 dir-current 输入框直接回车 → 跳转到该路径
els.dirCurrent.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = els.dirCurrent.value.trim();
    if (v) loadDir(v);
  }
});

els.ignoreSaveBtn.addEventListener('click', async () => {
  const ignore = els.ignoreInput.value.split(',').map(s => s.trim()).filter(Boolean);
  const ok = await updateConfig({ ignore });
  if (ok) {
    fetchState();
    const orig = els.ignoreSaveBtn.textContent;
    els.ignoreSaveBtn.textContent = '已保存 ✓';
    setTimeout(() => { els.ignoreSaveBtn.textContent = orig; }, 1200);
  }
});

async function updateConfig(patch) {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast({ kind: 'error', text: '保存失败', secondary: err.error || ('HTTP ' + res.status), duration: 4500 });
    return false;
  }
  return true;
}

// ---------- 桌面通知 ----------
els.notifyToggle.addEventListener('change', async (e) => {
  if (e.target.checked) {
    if (!('Notification' in window)) {
      alert('浏览器不支持桌面通知。');
      e.target.checked = false;
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      alert('未获得通知权限，无法开启。请在浏览器站点设置中允许通知。');
      e.target.checked = false;
      return;
    }
    state.notifyEnabled = true;
    localStorage.setItem('atlas:notify', '1');
  } else {
    state.notifyEnabled = false;
    localStorage.setItem('atlas:notify', '0');
  }
  updateNotifyHint();
});
function updateNotifyHint() {
  if (!('Notification' in window)) {
    els.notifyHint.textContent = '当前浏览器不支持桌面通知。';
    return;
  }
  const perm = Notification.permission;
  if (perm === 'denied') els.notifyHint.textContent = '通知已被浏览器阻止，请在站点设置中重新允许。';
  else if (perm === 'granted' && state.notifyEnabled) els.notifyHint.textContent = '✓ 通知已启用。';
  else els.notifyHint.textContent = '勾选后将请求权限并启用通知。';
}

function notify(title, body) {
  if (!state.notifyEnabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, silent: false, tag: 'atlas-' + Date.now() });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) { console.error(e); }
}

// ---------- SSE ----------
let evtSrc = null;
let pendingRefresh = null;
function connectSSE() {
  if (evtSrc) try { evtSrc.close(); } catch {}
  evtSrc = new EventSource('/api/events');
  evtSrc.onmessage = (msg) => {
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }

    // 新版本可用——立即弹 banner + 桌面通知
    if (data.channel === 'update') {
      if (window.__handleUpdateSSE) window.__handleUpdateSSE(data);
      return;
    }

    // 文件系统事件（旧 fs 流，兼容没 channel 的旧 payload）
    if (data.kind === 'add') {
      notify('📄 新文档', `${data.projectName} / ${data.name}`);
    } else if (data.kind === 'change') {
      notify('✏️ 文档已更新', `${data.projectName} / ${data.name}`);
    }
    if (pendingRefresh) clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(() => { pendingRefresh = null; fetchState(); }, 400);
  };
  evtSrc.onerror = () => {
    setTimeout(connectSSE, 3000);
  };
}

// ---------- 新版本提示：banner + 顶栏小标签 + 桌面通知 ----------
const UPDATE_DISMISS_KEY = 'atlas-update-dismissed';
const notifiedVersions = new Set(); // 桌面通知本会话只发一次

function getDismissed() {
  try { return localStorage.getItem(UPDATE_DISMISS_KEY) || ''; } catch { return ''; }
}
function setDismissed(version) {
  try { localStorage.setItem(UPDATE_DISMISS_KEY, version); } catch {}
}

// 把 ub-cmd 这种"点击复制命令"按钮统一绑定（idle / error 兜底两个 .ub-cmd 都用）
function bindCmdCopy(cmdBtn) {
  cmdBtn.addEventListener('click', async () => {
    const cmd = cmdBtn.querySelector('.ub-cmd-text').textContent;
    const hint = cmdBtn.querySelector('.ub-cmd-hint');
    try {
      await navigator.clipboard.writeText(cmd);
      cmdBtn.classList.add('copied');
      const old = hint.textContent;
      hint.textContent = '已复制 ✓';
      setTimeout(() => {
        cmdBtn.classList.remove('copied');
        hint.textContent = old;
      }, 1800);
    } catch {
      showToast({ kind: 'error', text: '复制失败，请手动选中复制' });
    }
  });
}

function setBannerPhase(text) {
  const phaseEl = els.updateBanner.querySelector('.ub-phase');
  if (phaseEl) phaseEl.textContent = text;
}

function appendBannerLog(line, stream = 'stdout') {
  const logEl = els.updateBanner.querySelector('.ub-log');
  if (!logEl) return;
  const span = document.createElement('span');
  span.className = `log-line ${stream}`;
  span.textContent = line;
  logEl.appendChild(span);
  // 自动滚到底
  logEl.scrollTop = logEl.scrollHeight;
}

function clearBannerLog() {
  const logEl = els.updateBanner.querySelector('.ub-log');
  if (logEl) logEl.innerHTML = '';
}

// 启动一键升级流程
async function startSelfUpgrade() {
  els.updateBanner.classList.remove('state-error');
  els.updateBanner.classList.add('state-busy');
  setBannerPhase('正在下载新版本…');
  clearBannerLog();

  // 用 fetch + ReadableStream 处理 SSE（POST 不能用 EventSource）
  let resp;
  try {
    resp = await fetch('/api/self-upgrade', { method: 'POST' });
  } catch (err) {
    showUpgradeError('网络错误：' + err.message);
    return;
  }
  if (!resp.ok || !resp.body) {
    showUpgradeError(`server 错误：HTTP ${resp.status}`);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let restartingSeen = false;

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      // server 关闭连接（重启时正常）
      break;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const ev of events) {
      const m = ev.match(/^data:\s*(.+)$/m);
      if (!m) continue;
      let data;
      try { data = JSON.parse(m[1]); } catch { continue; }
      handleUpgradeEvent(data);
      if (data.phase === 'restarting') restartingSeen = true;
      if (data.phase === 'error') return; // 已经显示错误，停止
    }
  }

  // 流结束——如果看到了 restarting，进入"等 server 上线"阶段
  if (restartingSeen) {
    setBannerPhase('Atlas 重启中，正在重连…');
    waitForServerBack();
  }
}

function handleUpgradeEvent(data) {
  switch (data.phase) {
    case 'start':
      setBannerPhase(data.message || '开始升级…');
      break;
    case 'log':
      appendBannerLog(data.text, data.stream);
      break;
    case 'installed':
      setBannerPhase(data.message || '下载完成，正在重启…');
      break;
    case 'restarting':
      setBannerPhase(data.message || '正在重启 Atlas…');
      break;
    case 'error':
      showUpgradeError(data.message || '未知错误');
      break;
  }
}

function showUpgradeError(message) {
  els.updateBanner.classList.remove('state-busy');
  els.updateBanner.classList.add('state-error');
  const errEl = els.updateBanner.querySelector('.ub-error-text');
  if (errEl) errEl.textContent = '✕ ' + message;
}

// server 重启后，轮询 /api/state 等它上线，然后自动 reload 页面
async function waitForServerBack() {
  const start = Date.now();
  // 最多等 60s
  while (Date.now() - start < 60_000) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch('/api/update-info', { cache: 'no-store' });
      if (r.ok) {
        const info = await r.json();
        // current 字段就是新版本号——说明新 server 已起
        setBannerPhase(`✓ 已更新到 ${info.current}，正在刷新…`);
        await new Promise(r2 => setTimeout(r2, 800));
        location.reload();
        return;
      }
    } catch {}
  }
  showUpgradeError('重连超时，请手动刷新页面');
}

function bindUpdateBannerOnce() {
  if (els.updateBanner.dataset.bound) return;
  els.updateBanner.dataset.bound = '1';

  // 所有 .ub-cmd（idle 和 error 兜底）都绑定复制
  els.updateBanner.querySelectorAll('.ub-cmd').forEach(bindCmdCopy);

  // 一键更新主按钮
  const upgradeBtn = els.updateBanner.querySelector('.ub-upgrade');
  upgradeBtn.addEventListener('click', () => {
    upgradeBtn.disabled = true;
    startSelfUpgrade();
  });

  // 重试
  const retryBtn = els.updateBanner.querySelector('.ub-retry');
  retryBtn.addEventListener('click', () => {
    startSelfUpgrade();
  });

  // 日志折叠
  const logToggle = els.updateBanner.querySelector('.ub-log-toggle');
  logToggle.addEventListener('click', () => {
    const isOpen = els.updateBanner.classList.toggle('log-open');
    logToggle.setAttribute('aria-expanded', String(isOpen));
    logToggle.querySelector('.ub-log-toggle-text').textContent = isOpen ? '收起日志' : '查看日志';
  });

  // 关闭按钮（idle 和 error 各一个）
  els.updateBanner.querySelectorAll('.ub-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = els.updateBanner.dataset.version || '';
      if (v) setDismissed(v);
      els.updateBanner.classList.add('hidden');
    });
  });
}

function showUpdateUI(current, latest) {
  if (!latest) return;
  // 顶栏小标签——常驻提示，关掉 banner 后仍可见
  els.updateBadge.classList.remove('hidden');
  els.updateBadge.querySelector('.text').textContent = `${current} → ${latest}`;
  els.updateBadge.title = `新版本 ${latest} 可用，点击查看升级命令`;
  els.updateBadge.onclick = (e) => {
    e.preventDefault();
    const cmd = `npm i -g atlas-dashboard@latest`;
    navigator.clipboard.writeText(cmd).then(() => {
      els.updateBadge.querySelector('.text').textContent = '命令已复制 ✓';
      setTimeout(() => {
        els.updateBadge.querySelector('.text').textContent = `${current} → ${latest}`;
      }, 1600);
    });
  };

  // 横幅——只在用户未对当前版本 dismiss 过时显示
  bindUpdateBannerOnce();
  if (getDismissed() !== latest) {
    els.updateBanner.dataset.version = latest;
    els.updateBanner.querySelector('.ub-version').textContent = latest;
    // 复位到 idle 态（防止上次是错误态）
    els.updateBanner.classList.remove('state-busy', 'state-error', 'log-open');
    const upBtn = els.updateBanner.querySelector('.ub-upgrade');
    if (upBtn) upBtn.disabled = false;
    els.updateBanner.classList.remove('hidden');
  }

  // 桌面通知：本会话每个版本只发一次（避免连开几小时反复扰人）
  if (!notifiedVersions.has(latest)) {
    notifiedVersions.add(latest);
    notify(`🚀 Atlas ${latest} 已发布`, `当前 ${current}，点击 banner 复制升级命令`);
  }
}

async function checkForUpdate() {
  try {
    const r = await fetch('/api/update-info');
    if (!r.ok) return;
    const info = await r.json();
    if (info.hasUpdate && info.latest) {
      showUpdateUI(info.current, info.latest);
    }
  } catch {}
}

setInterval(() => { if (!document.hidden) fetchState(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchState(); });

fetchState();
connectSSE();
checkForUpdate();
// 长期开着的页面也定期复查（兜底，server SSE 推送是主路径）
setInterval(checkForUpdate, 60 * 60 * 1000);

// 把 SSE 'update' channel 接进 banner
window.__handleUpdateSSE = (data) => {
  if (data && data.latest) showUpdateUI(data.current, data.latest);
};

// ---------- 局域网分享 ----------
let shareCurrent = null; // { token, path, name, urls }

async function refreshSharesState() {
  try {
    const r = await fetch('/api/shares');
    if (!r.ok) return;
    const data = await r.json();
    state.sharesByPath = new Map();
    for (const s of data.shares || []) {
      state.sharesByPath.set(s.path, s);
    }
    state.lanIps = data.lanIps || [];
    // 重新渲染让"已分享"角标更新
    render();
    return data;
  } catch {
    return null;
  }
}

function pickPreferredUrl(urls) {
  // 优先 LAN URL（同事用），fallback localhost
  if (urls && urls.lan && urls.lan.length > 0) return urls.lan[0];
  return urls && urls.localhost;
}

function renderShareUrls(container, urls) {
  container.innerHTML = '';
  const rows = [];
  (urls.lan || []).forEach((u, i) => rows.push({ label: `局域网${urls.lan.length > 1 ? ' ' + (i + 1) : ''}`, url: u, primary: i === 0 }));
  if (urls.localhost) rows.push({ label: '本机', url: urls.localhost, primary: false });
  rows.forEach(({ label, url, primary }) => {
    const row = document.createElement('div');
    row.className = 'share-url-row';
    row.innerHTML = `
      <span class="share-url-label">${escapeHtml(label)}</span>
      <span class="share-url-text"></span>
      <button class="share-url-copy" type="button">复制</button>
    `;
    row.querySelector('.share-url-text').textContent = url;
    const copyBtn = row.querySelector('.share-url-copy');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copyBtn.classList.add('copied');
        copyBtn.textContent = '已复制 ✓';
        setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.textContent = '复制'; }, 1600);
      } catch {
        showToast({ kind: 'error', text: '复制失败' });
      }
    });
    container.appendChild(row);
  });
}

function renderQrCode(container, text) {
  container.innerHTML = '';
  if (typeof QRCode === 'undefined') {
    container.textContent = '（QR 库未加载）';
    return;
  }
  // davidshimjs/qrcodejs：自动检测 canvas 支持
  // eslint-disable-next-line no-new
  new QRCode(container, {
    text,
    width: 180,
    height: 180,
    colorDark: '#1d2230',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

async function openShareModal(filePath) {
  const file = state.files[filePath];
  if (!file) return;
  // 调后端：已存在则复用 token，不存在则新建
  let entry;
  try {
    const r = await fetch('/api/share/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!r.ok) {
      // 404 → 大概率是 server 进程是旧版（npm i -g 升级了文件但没 atlas restart）
      // 旧 server.js 没注册 /api/share/* 路由，Express 默认返 404
      if (r.status === 404) {
        showToast({
          kind: 'error',
          text: '分享功能不可用',
          secondary: 'Atlas 服务还在跑旧版本——请在终端运行 atlas restart 重启',
          duration: 7000,
        });
        return;
      }
      const err = await r.json().catch(() => ({}));
      showToast({ kind: 'error', text: '启动分享失败', secondary: err.error || ('HTTP ' + r.status) });
      return;
    }
    entry = await r.json();
  } catch (err) {
    showToast({ kind: 'error', text: '启动分享失败', secondary: err.message });
    return;
  }
  shareCurrent = entry;

  // 填 modal
  els.shareFilename.textContent = file.alias ? `${file.alias}（${file.name}）` : file.name;
  renderShareUrls(els.shareUrls, entry.urls);
  renderQrCode(els.shareQr, pickPreferredUrl(entry.urls));
  els.shareModal.classList.remove('hidden');

  // 同步 sharesByPath 状态（角标 + 设置面板列表）
  state.sharesByPath.set(filePath, entry);
  render();
}

function closeShareModal() {
  els.shareModal.classList.add('hidden');
  shareCurrent = null;
}

els.shareModal.addEventListener('click', (e) => {
  if (e.target.dataset.close !== undefined) closeShareModal();
});
els.shareOpenBtn.addEventListener('click', () => {
  if (!shareCurrent) return;
  window.open(pickPreferredUrl(shareCurrent.urls), '_blank');
});
els.shareStopBtn.addEventListener('click', async () => {
  if (!shareCurrent) return;
  if (!confirm(`停止分享「${shareCurrent.name}」？\n\n停止后链接立即失效，已经打开的页面刷新会 404。`)) return;
  try {
    const r = await fetch('/api/share/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: shareCurrent.token }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.sharesByPath.delete(shareCurrent.path);
    showToast({ kind: 'success', text: '已停止分享', secondary: shareCurrent.name });
    closeShareModal();
    render();
  } catch (err) {
    showToast({ kind: 'error', text: '停止失败', secondary: err.message });
  }
});

// 启动时拉一次分享列表（让已分享角标第一时间出现）
// 同时也作为"server 是否新版"的特征检测——/api/shares 是 0.4.4+ 引入
// 如果 404，说明 daemon 进程跑的是 npm 升级前的旧 server.js
(async () => {
  try {
    const r = await fetch('/api/shares', { cache: 'no-store' });
    if (r.status === 404) {
      showToast({
        kind: 'info',
        text: 'Atlas 服务是旧版本',
        secondary: '部分新功能（分享 / 归档 / 导出 PDF）可能不可用——在终端运行 atlas restart 重启即可',
        duration: 8000,
      });
      return;
    }
    if (r.ok) {
      const data = await r.json();
      state.sharesByPath = new Map();
      for (const s of data.shares || []) state.sharesByPath.set(s.path, s);
      state.lanIps = data.lanIps || [];
      render();
    }
  } catch {}
})();
