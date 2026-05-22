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
  btnCopyPath: document.getElementById('btn-copy-path'),
  // settings modal
  modal: document.getElementById('settings-modal'),
  rootList: document.getElementById('root-list'),
  rootInput: document.getElementById('root-input'),
  rootAddBtn: document.getElementById('root-add-btn'),
  notifyToggle: document.getElementById('notify-toggle'),
  notifyHint: document.getElementById('notify-hint'),
  ignoreInput: document.getElementById('ignore-input'),
  ignoreSaveBtn: document.getElementById('ignore-save-btn'),
  recentBar: document.getElementById('recent-bar'),
  recentList: document.getElementById('recent-list'),
  recentToggle: document.getElementById('recent-toggle'),
};

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
    div.innerHTML = `
      <span class="recent-icon">📄</span>
      <span class="recent-name">${escapeHtml(file.alias || file.name.replace(/\.html$/i, ''))}</span>
      <span class="recent-project">${escapeHtml(file.projectName)}</span>
    `;
    div.addEventListener('click', () => openFile(p));
    els.recentList.appendChild(div);
  }
}

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
  const visibleChildren = folder.children.filter(c => {
    if (!state.search && !state.onlyUnread) return true;
    return nodeMatches(c);
  });

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

  header.addEventListener('click', (e) => {
    if (e.target.closest('.folder-actions')) return;
    if (e.target.classList.contains('folder-name') && e.target.isContentEditable) return;
    toggleFolder(folder.id);
  });
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
  fileEl.className = 'file'
    + (file.unread ? ' unread' : '')
    + (file.alias ? ' has-alias' : '')
    + (file.path === state.activeFilePath ? ' active' : '')
    + (contentOnly ? ' content-match' : '');
  fileEl.dataset.nodeType = 'file';
  fileEl.dataset.path = file.path;
  fileEl.tabIndex = -1;  // 可被 JS focus，但不出现在 Tab 序列中
  let titleParts = [];
  if (file.alias) titleParts.push(file.alias);
  titleParts.push(file.name);
  titleParts.push(file.relPath);
  if (snippet) titleParts.push('🔍 ' + snippet);
  fileEl.title = titleParts.join('\n');
  const displayName = file.alias || file.name.replace(/\.html$/i, '');
  fileEl.innerHTML = `
    <span class="unread-dot"></span>
    <span class="folder-icon">📄</span>
    <span class="file-name" data-path="${escapeHtml(file.path)}">${escapeHtml(displayName)}</span>
    <span class="file-mtime">${fmtMtime(file.mtime)}</span>
    <span class="file-actions">
      <button data-act="alias" title="备注名（不改源文件名）">✎</button>
      <button data-act="reveal" title="在访达中显示">📂</button>
    </span>
  `;
  fileEl.addEventListener('click', (e) => {
    if (e.target.closest('.file-actions')) return;
    if (e.target.classList.contains('file-name') && e.target.isContentEditable) return;
    openFile(file.path);
  });
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
  const baseName = file.name.replace(/\.html$/i, '');
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
  const counts = countDescendants(folder);
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
  state.activeFilePath = filePath;
  els.tree.querySelectorAll('.file.active').forEach(e => e.classList.remove('active'));
  const fileEl = els.tree.querySelector(`.file[data-path="${CSS.escape(filePath)}"]`);
  if (fileEl) fileEl.classList.add('active');

  const file = state.files[filePath];
  if (!file) return;
  const aliasPart = file.alias
    ? `<span class="crumb-alias">${escapeHtml(file.alias)}</span><span class="crumb-original">（${escapeHtml(file.name)}）</span>`
    : `<span class="crumb-name">${escapeHtml(file.name)}</span>`;
  els.crumbs.innerHTML = `
    <span class="crumb-project">${escapeHtml(file.projectName)}</span>
    <span class="crumb-sep">›</span>
    ${aliasPart}
    <span class="crumb-meta">更新于 ${fmtMtime(file.mtime)}</span>
  `;
  els.btnMarkUnread.disabled = false;
  els.btnReveal.disabled = false;
  els.btnOpenExternal.disabled = false;
  els.btnCopyPath.disabled = false;

  if (doNavigate) {
    els.preview.classList.remove('hidden');
    els.emptyState.classList.add('hidden');
    // 切换前淡出，加载完成后淡入；同 url 直接显示不闪烁
    const targetUrl = new URL(file.url, location.href).href;
    if (els.preview.src !== targetUrl) {
      els.preview.classList.add('loading');
      els.preview.src = file.url;
    } else {
      els.preview.classList.remove('loading');
    }
  }
}

els.preview.addEventListener('load', () => {
  els.preview.classList.remove('loading');
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

els.search.addEventListener('input', (e) => {
  const v = e.target.value;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    if (state.search === v) return;
    state.search = v;
    state.contentMatches = new Map();   // 先按文件名渲染（即时反馈）
    render();
    if (v && v.length >= 2) doContentSearch(v);   // 异步加上内容匹配
    else contentSearchSeq++;             // cancel pending
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
  if (f) window.open(f.url, '_blank');
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
  els.ignoreInput.value = (cfg.ignore || []).join(', ');
  els.notifyToggle.checked = state.notifyEnabled;
  updateNotifyHint();
  els.modal.classList.remove('hidden');
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
      if (next.length === 0) { alert('至少保留一个扫描根目录。'); return; }
      if (!confirm(`移除扫描根：\n${p}\n\n（不会删除磁盘上的任何文件）`)) return;
      await updateConfig({ scanRoots: next });
      const cfg = await (await fetch('/api/config')).json();
      renderRootList(cfg.scanRoots);
      fetchState();
    });
    els.rootList.appendChild(li);
  });
}

els.rootAddBtn.addEventListener('click', async () => {
  const v = els.rootInput.value.trim();
  if (!v) return;
  const cfg = await (await fetch('/api/config')).json();
  const next = [...cfg.scanRoots, v];
  const ok = await updateConfig({ scanRoots: next });
  if (ok) {
    els.rootInput.value = '';
    const cfg2 = await (await fetch('/api/config')).json();
    renderRootList(cfg2.scanRoots);
    fetchState();
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
    alert('保存失败：' + (err.error || res.status));
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
    if (data.kind === 'add') {
      notify('📄 新 HTML 文档', `${data.projectName} / ${data.name}`);
    } else if (data.kind === 'change') {
      notify('✏️ HTML 已更新', `${data.projectName} / ${data.name}`);
    }
    // 节流刷新（chokidar awaitWriteFinish 已经稳定，但还是合并多次事件）
    if (pendingRefresh) clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(() => { pendingRefresh = null; fetchState(); }, 400);
  };
  evtSrc.onerror = () => {
    setTimeout(connectSSE, 3000);
  };
}

setInterval(() => { if (!document.hidden) fetchState(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchState(); });

fetchState();
connectSSE();
