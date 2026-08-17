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
  btnDiff: document.getElementById('btn-diff'),
  diffPanel: document.getElementById('diff-panel'),
  diffBody: document.getElementById('diff-body'),
  diffStats: document.getElementById('diff-stats'),
  diffContext: document.getElementById('diff-context'),
  diffAccept: document.getElementById('diff-accept'),
  diffClose: document.getElementById('diff-close'),
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
  shareTtl: document.getElementById('share-ttl'),
  shareScope: document.getElementById('share-scope'),
  shareExpiry: document.getElementById('share-expiry'),
  shareScopeHint: document.getElementById('share-scope-hint'),
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
  mdEditorSplit: document.getElementById('md-editor-split'),
  mdToolbar: document.querySelector('.md-toolbar'),
  mdOutline: document.getElementById('md-outline'),
  mdOutlineList: document.getElementById('md-outline-list'),
  mdOutlineToggle: document.getElementById('md-outline-toggle'),
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

// ---------- 弹窗基础设施：Esc 关闭 / 焦点陷阱 / 焦点归还 ----------
// 所有弹窗（设置、分享、确认框）共用一个栈。原来的弹窗既不能按 Esc 关闭，
// 也没有 role=dialog / aria-modal，Tab 会跑到弹窗背后的侧边栏按钮上。
const openModals = [];
const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusablesIn(panel) {
  return [...panel.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter(el => !el.hasAttribute('hidden') && el.offsetParent !== null);
}

function pushModal({ panel, close, initialFocus }) {
  const entry = { panel, close, prevFocus: document.activeElement };
  openModals.push(entry);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
  requestAnimationFrame(() => {
    const target = initialFocus || focusablesIn(panel)[0] || panel;
    try { target.focus(); } catch {}
  });
  return entry;
}

function popModal(entry) {
  const i = openModals.indexOf(entry);
  if (i >= 0) openModals.splice(i, 1);
  if (entry && entry.prevFocus && document.contains(entry.prevFocus)) {
    try { entry.prevFocus.focus(); } catch {}
  }
}

// 用 capture 阶段：要先于其它全局快捷键处理，避免 Esc 同时清掉搜索框
document.addEventListener('keydown', (e) => {
  if (!openModals.length) return;
  const top = openModals[openModals.length - 1];
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    top.close();
    return;
  }
  if (e.key === 'Tab') {
    const list = focusablesIn(top.panel);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    const inPanel = top.panel.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inPanel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inPanel)) {
      e.preventDefault();
      first.focus();
    }
  }
}, true);

// ---------- 应用内确认 / 输入对话框 ----------
// 替代原生 confirm() / prompt()：原生弹窗与整体设计语言割裂，而且浏览器可能
// 出现"阻止此页面创建更多对话框"从而让操作彻底点不动。
function showDialog({
  title, body, confirmText = '确定', cancelText = '取消', danger = false, input = null,
} = {}) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'modal atlas-dialog';
    root.innerHTML = `
      <div class="modal-backdrop" data-dialog-cancel></div>
      <div class="modal-panel dialog-panel" tabindex="-1">
        <header class="modal-header"><h2></h2></header>
        <div class="dialog-body"></div>
        <div class="dialog-actions">
          <button type="button" class="dialog-cancel" data-dialog-cancel></button>
          <button type="button" class="dialog-confirm"></button>
        </div>
      </div>`;
    const panel = root.querySelector('.dialog-panel');
    panel.querySelector('h2').textContent = title || '确认';
    const bodyEl = root.querySelector('.dialog-body');
    if (body) {
      const p = document.createElement('p');
      p.className = 'dialog-text';
      p.textContent = body;   // 配合 CSS white-space:pre-line 保留换行
      bodyEl.appendChild(p);
    }
    let inputEl = null;
    if (input) {
      inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.className = 'dialog-input';
      inputEl.spellcheck = false;
      inputEl.value = input.value || '';
      inputEl.placeholder = input.placeholder || '';
      inputEl.setAttribute('aria-label', input.label || title || '输入');
      bodyEl.appendChild(inputEl);
    }
    const okBtn = root.querySelector('.dialog-confirm');
    const cancelBtn = root.querySelector('.dialog-cancel');
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    if (danger) okBtn.classList.add('danger');

    let entry = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (entry) popModal(entry);
      root.remove();
      resolve(value);
    };
    const close = () => finish(input ? null : false);
    root.addEventListener('click', (e) => {
      if (e.target.dataset && e.target.dataset.dialogCancel !== undefined) close();
    });
    okBtn.addEventListener('click', () => finish(input ? (inputEl.value.trim() || null) : true));
    cancelBtn.addEventListener('click', close);
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(inputEl.value.trim() || null);
        }
      });
    }
    document.body.appendChild(root);
    entry = pushModal({ panel, close, initialFocus: inputEl || okBtn });
    if (inputEl) requestAnimationFrame(() => { try { inputEl.select(); } catch {} });
  });
}

function showConfirm(opts) {
  return showDialog(opts);
}
// 返回 trim 后的字符串，取消 / 空输入返回 null
function showPrompt({ title, body, label, value, placeholder, confirmText = '确定' } = {}) {
  return showDialog({ title, body, confirmText, input: { label, value, placeholder } });
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

const STATE_TIMEOUT_MS = 15_000;
let stateRetryTimer = null;
let stateRetryDelay = 1000;
let stateFailed = false;
let stateInFlight = null;

async function fetchState() {
  if (stateRetryTimer) { clearTimeout(stateRetryTimer); stateRetryTimer = null; }
  setSaveStatus('loading');
  // 已经处于失败态时，后台重试不再点亮转圈动画：否则退避重试会让刷新按钮
  // 看起来"一直在转"，和故障时的观感没有区别。此时错误信息已经写在统计栏里。
  const showSpinner = !stateFailed;
  if (showSpinner) setScanning(true);
  // 手动 AbortController（而非 AbortSignal.timeout，兼容旧内核）：
  // 没有超时的话，一旦浏览器连接池被占满，这个 fetch 会永久 pending，
  // finally 不执行 → 刷新按钮永远停在 scanning 状态。
  const ctrl = new AbortController();
  // 让新请求取代仍在飞的旧请求：并发的 fetchState（手动刷新 + SSE 推送 + 重试）
  // 会各自占一个 scanning 计数，只要有一个迟迟不返回，刷新按钮就一直转；
  // 而且旧响应后到还会覆盖新数据。同一时刻只保留最后一个。
  if (stateInFlight) {
    stateInFlight.superseded = true;
    try { stateInFlight.abort(); } catch {}
  }
  stateInFlight = ctrl;
  const timer = setTimeout(() => ctrl.abort(), STATE_TIMEOUT_MS);
  try {
    const res = await fetch('/api/state', { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    stateRetryDelay = 1000;
    stateFailed = false;
    state.tree = data.tree;
    state.files = data.files;
    state.recent = Array.isArray(data.recent) ? data.recent : [];
    state.archivedProjects = Array.isArray(data.archivedProjects) ? data.archivedProjects : [];
    const unread = Object.values(data.files).filter(f => f.unread).length;
    els.stats.textContent = `${Object.keys(data.files).length} 个文档 · ${unread} 未读`;
    setSaveStatus('idle');
    render();
    renderRecent();
    // 对比面板开着的时候，如果当前文件在磁盘上又被改了，自动刷新差异
    if (diffState.open && diffState.path) {
      const f = state.files[diffState.path];
      if (f && f.mtime !== diffState.mtime) loadDiff();
    }
  } catch (e) {
    // 被后来的请求主动取代：不是故障，静默退场（重试由接替者负责）
    if (ctrl.superseded) return;
    console.error(e);
    setSaveStatus('error');
    stateFailed = true;
    const aborted = e && e.name === 'AbortError';
    els.stats.textContent = aborted
      ? `加载超时，${Math.round(stateRetryDelay / 1000)}s 后重试…`
      : '加载失败：' + e.message + `（${Math.round(stateRetryDelay / 1000)}s 后重试）`;
    // 自动重试（指数退避，上限 30s）：server 重启或连接暂时不可用后页面能自己恢复，
    // 不必手动刷新
    stateRetryTimer = setTimeout(() => {
      stateRetryTimer = null;
      fetchState();
    }, stateRetryDelay);
    stateRetryDelay = Math.min(stateRetryDelay * 2, 30_000);
  } finally {
    clearTimeout(timer);
    if (stateInFlight === ctrl) stateInFlight = null;
    if (showSpinner) setScanning(false);   // 与上面成对，保证 scanningCount 不失衡
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
// 查询词切分：空白分隔多关键词按 AND 组合，引号内当成一个短语。
// 必须和 server 的 parseQueryTerms 保持一致，否则前端过滤和内容搜索结果会打架。
function parseQueryTerms(q) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(q || '').toLowerCase())) !== null) {
    const t = (m[1] || m[2] || '').trim();
    if (t) terms.push(t);
  }
  return terms;
}

function fileMatches(file) {
  if (state.onlyUnread && !file.unread) return false;
  if (!state.search) return true;
  const terms = parseQueryTerms(state.search);
  if (!terms.length) return true;
  // 内容命中由后端判定（它已经做过 AND）
  if (state.contentMatches.has(file.path)) return true;
  // 文件名 / 备注 / 路径：拼成一条待搜文本，要求每个关键词都出现
  const haystack = [
    file.name,
    file.relPath,
    file.alias || '',
    file.projectName || '',
  ].join('\n').toLowerCase();
  return terms.every(t => haystack.includes(t));
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
      <button data-act="new-sub" title="在此分组内新建子分组" aria-label="在「${escapeHtml(folder.name)}」内新建子分组"><span aria-hidden="true">＋</span></button>
      <button data-act="rename" title="重命名" aria-label="重命名分组「${escapeHtml(folder.name)}」"><span aria-hidden="true">✎</span></button>
      <button data-act="delete" title="删除分组（文件下次扫描会回到所属项目）" aria-label="删除分组「${escapeHtml(folder.name)}」"><span aria-hidden="true">✕</span></button>
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
    const name = await showPrompt({
      title: '新建子分组',
      body: `新分组会建在「${folder.name}」里面。`,
      label: '分组名称',
      value: '新分组',
      confirmText: '创建',
    });
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
  const terms = state.search ? parseQueryTerms(state.search) : [];
  const isNameMatch = terms.length > 0 && (() => {
    const haystack = [file.name, file.relPath, file.alias || ''].join('\n').toLowerCase();
    return terms.every(t => haystack.includes(t));
  })();
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
      <button data-act="share" title="分享到局域网（生成可访问链接 + 二维码）" aria-label="分享「${escapeHtml(displayName)}」到局域网">
        <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8L9 5M5 8a2 2 0 0 1-2-2 2 2 0 0 1 4 0M9 5a2 2 0 0 1 2-2 2 2 0 0 1 0 4 2 2 0 0 1-2-2M5 8a2 2 0 0 0-2 2 2 2 0 0 0 4 0 2 2 0 0 0-2-2"/></svg>
      </button>
      <button data-act="rename-file" title="重命名磁盘文件" aria-label="重命名文件「${escapeHtml(file.name)}」"><span aria-hidden="true">Aa</span></button>
      <button data-act="alias" title="备注名（不改源文件名）" aria-label="给「${escapeHtml(displayName)}」起备注名"><span aria-hidden="true">✎</span></button>
      <button data-act="reveal" title="在访达中显示" aria-label="在访达中显示「${escapeHtml(displayName)}」"><span aria-hidden="true">📂</span></button>
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
  fileEl.querySelector('[data-act="rename-file"]').addEventListener('click', (e) => {
    e.stopPropagation();
    renameFileOnDisk(file);
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

// 重命名磁盘上的真实文件（区别于 alias 备注名：那个只改显示）
async function renameFileOnDisk(file) {
  const next = await showPrompt({
    title: '重命名文件',
    body: `会改动磁盘上的真实文件名。\n当前：${file.relPath}`,
    label: '新文件名（含扩展名）',
    value: file.name,
    confirmText: '重命名',
  });
  if (!next || next === file.name) return;
  try {
    const r = await fetch('/api/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file.path, name: next }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      showToast({ kind: 'error', text: '重命名失败', secondary: data.error || ('HTTP ' + r.status) });
      return;
    }
    // 当前正预览 / 正编辑的就是它 → 让新路径接管，避免预览指向一个已不存在的文件
    const wasActive = state.activeFilePath === file.path;
    if (editState.active && editState.path === file.path) editState.path = data.path;
    if (wasActive) state.activeFilePath = data.path;
    await fetchState();
    if (wasActive && state.files[data.path]) setActiveFile(data.path, true);
    showToast({ kind: 'success', text: '已重命名', secondary: data.name });
  } catch (e) {
    showToast({ kind: 'error', text: '重命名失败', secondary: e.message });
  }
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

async function deleteFolder(folder) {
  // 判断这个 folder 是不是磁盘扫描自动建的"项目分组"（projectName 同名）：
  // 如果是 → 走"归档"路径，下次扫描跳过同名 projectName，不再被自动重建
  // 如果不是（用户自建子分组）→ 单纯删除，里面的文件下次扫描会回到所属项目分组
  const projectNames = new Set();
  Object.values(state.files).forEach(f => { if (f && f.projectName) projectNames.add(f.projectName); });
  const isAutoProject = projectNames.has(folder.name);

  const counts = countDescendants(folder);

  if (isAutoProject) {
    // 归档对话——告诉用户这是隐藏，不是删除文件
    const detail = counts.files > 0
      ? `该分组下有 ${counts.files} 个文档（磁盘文件不会被删），归档后将不再扫描，可在 设置 → 已归档分组 中恢复。`
      : '归档后将不再扫描，可在 设置 → 已归档分组 中恢复。';
    const ok = await showConfirm({
      title: `归档分组「${folder.name}」？`,
      body: detail,
      confirmText: '归档',
      cancelText: '不归档',
    });
    if (!ok) return;

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
    const ok = await showConfirm({
      title: `删除分组「${folder.name}」？`,
      body: `分组中有 ${counts.files} 个文件（含子分组）。删除只是拆掉这个分组，文件下次扫描会回到所属项目分组，磁盘文件不受影响。`,
      confirmText: '删除分组',
      danger: true,
    });
    if (!ok) return;
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
  // 编辑模式下切换到别的文件：先确认丢弃改动再退出编辑
  // （放在这里而不是 setActiveFile 里：确认框是异步的，而 setActiveFile
  //   也被 render() 以 doNavigate=false 同步调用，不该被 await 卡住）
  if (editState.active && editState.path && editState.path !== filePath) {
    if (!(await confirmDiscardIfDirty())) return;
    exitEditMode({ restore: false });
  }
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
  els.btnExportPdf.disabled = false;
  els.btnExportPdf.title = '导出为 PDF 保存到 Downloads';
  els.btnShare.disabled = false;
  els.btnEdit.disabled = false;
  // 已在分享中的文件，让顶栏 share 按钮高亮提示状态
  els.btnShare.classList.toggle('shared', state.sharesByPath && state.sharesByPath.has(file.path));
  updateDiffButton();

  if (doNavigate) {
    // 切到别的文件时关掉对比面板（面板内容是上一个文件的）
    if (diffState.open && diffState.path !== filePath) closeDiff();
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
  } else if (pendingPreviewScrollPct != null) {
    // 退出 Markdown 编辑后重载渲染预览：按百分比恢复浏览位置（扣除底部留白）
    applyPendingScrollPct(pendingPreviewScrollPct);
    pendingPreviewScrollPct = null;
    updateIframeHighlight();
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
// 退出 Markdown 编辑时，按百分比恢复只读预览的滚动位置（编辑器与 iframe 布局/尺寸不同，
// 无法用绝对像素；且 iframe 末尾有一段占位留白，需要从可滚动高度里扣掉）
let pendingPreviewScrollPct = null;

function applyPendingScrollPct(pct) {
  if (pct == null) return;
  const doScroll = () => {
    try {
      const w = els.preview.contentWindow;
      const doc = w.document;
      const root = doc.scrollingElement || doc.documentElement;
      const spacer = doc.querySelector('.md-tail-space');
      const spacerH = spacer ? spacer.offsetHeight : 0;
      const fullMax = root.scrollHeight - root.clientHeight;
      const realMax = Math.max(0, fullMax - spacerH);
      const y = Math.round(pct * realMax);
      const prevRoot = root && root.style.scrollBehavior;
      const prevBody = doc.body && doc.body.style.scrollBehavior;
      if (root) root.style.scrollBehavior = 'auto';
      if (doc.body) doc.body.style.scrollBehavior = 'auto';
      w.scrollTo(0, y);
      if (root) root.scrollTop = y;
      if (root) root.style.scrollBehavior = prevRoot || '';
      if (doc.body) doc.body.style.scrollBehavior = prevBody || '';
    } catch {}
  };
  doScroll();
  requestAnimationFrame(doScroll);
}

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

async function confirmDiscardIfDirty() {
  if (!editState.active || !editState.dirty) return true;
  return showConfirm({
    title: '放弃未保存的改动？',
    body: '当前文档有还没保存的编辑内容，离开会丢弃它们。\n（草稿会在本地留 7 天，下次进入编辑时可以恢复）',
    confirmText: '放弃改动',
    cancelText: '继续编辑',
    danger: true,
  });
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
  // annotateRaw：给每个顶层块记上原始 Markdown 源码。用户在预览里改动时
  // 只有被改过的块会重新序列化，其余原样吐回——这样"改一个字"不会把
  // 表格对齐、段落软换行这些渲染器无法完整往返的东西一起改掉。
  els.mdPreview.innerHTML = window.AtlasMarkdown.renderBody(els.mdSource.value, { annotateRaw: true });
  scheduleMdOutline();
}

// 大纲重建比渲染重（要建 DOM 按钮），单独用一个更慢的节流，不跟着每帧渲染跑
let mdOutlineTimer = null;
function scheduleMdOutline() {
  if (!mdOutlineVisible) return;
  if (mdOutlineTimer) clearTimeout(mdOutlineTimer);
  mdOutlineTimer = setTimeout(() => {
    mdOutlineTimer = null;
    renderMdOutline();
  }, 250);
}

// ---------- 编辑器大纲（第三栏） ----------
// 只读预览页早就有可折叠 TOC，但一进编辑模式就没了，长文档定位全靠滚。
// 这里从预览面板已渲染的标题直接生成，点击滚动预览区——滚动同步会带着源码栏一起走。
let mdOutlineVisible = localStorage.getItem('atlas:mdOutline') === '1';
let mdOutlineHeadings = [];

function renderMdOutline() {
  if (!els.mdOutlineList || !els.mdPreview) return;
  const heads = [...els.mdPreview.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  mdOutlineHeadings = heads;
  els.mdOutlineList.innerHTML = '';
  if (!heads.length) {
    const empty = document.createElement('div');
    empty.className = 'md-outline-empty';
    empty.textContent = '这篇文档还没有标题';
    els.mdOutlineList.appendChild(empty);
    return;
  }
  heads.forEach((h, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-outline-item';
    btn.dataset.level = h.tagName[1];
    btn.dataset.idx = String(idx);
    const text = (h.textContent || '').trim();
    btn.textContent = text || '(空标题)';
    btn.title = text;
    btn.addEventListener('click', () => {
      h.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setMdOutlineActive(idx);
      // 钉住高亮，别让平滑滚动过程中的 scroll 事件把它抢回去。
      // 文档末尾的标题滚不到面板顶部（下面没有更多内容了），按位置算出来的
      // "当前章节"会一直是上一个——用户点了哪个就该高亮哪个。
      mdOutlinePinnedUntil = Date.now() + 800;
    });
    els.mdOutlineList.appendChild(btn);
  });
  updateMdOutlineActive();
}

function setMdOutlineActive(idx) {
  if (!els.mdOutlineList) return;
  els.mdOutlineList.querySelectorAll('.md-outline-item.active')
    .forEach(e => e.classList.remove('active'));
  const el = els.mdOutlineList.querySelector(`.md-outline-item[data-idx="${idx}"]`);
  if (el) el.classList.add('active');
}

// 按预览区滚动位置高亮当前章节：取最后一个顶边越过面板上沿的标题
let mdOutlinePinnedUntil = 0;
function updateMdOutlineActive() {
  if (!mdOutlineVisible || !mdOutlineHeadings.length || !els.mdPreview) return;
  if (Date.now() < mdOutlinePinnedUntil) return;   // 刚点过大纲，别覆盖用户的选择
  const top = els.mdPreview.getBoundingClientRect().top + 8;
  let active = 0;
  for (let i = 0; i < mdOutlineHeadings.length; i++) {
    if (mdOutlineHeadings[i].getBoundingClientRect().top <= top + 40) active = i;
    else break;
  }
  setMdOutlineActive(active);
}

function applyMdOutlineVisibility() {
  if (!els.mdOutline || !els.mdOutlineToggle) return;
  els.mdOutline.classList.toggle('hidden', !mdOutlineVisible);
  els.mdOutlineToggle.setAttribute('aria-pressed', String(mdOutlineVisible));
  if (mdOutlineVisible) renderMdOutline();
}

if (els.mdOutlineToggle) {
  els.mdOutlineToggle.addEventListener('click', () => {
    mdOutlineVisible = !mdOutlineVisible;
    localStorage.setItem('atlas:mdOutline', mdOutlineVisible ? '1' : '0');
    applyMdOutlineVisibility();
  });
}

// ---------- 分栏拖拽 ----------
// 原来 50/50 是写死的（.md-editor-split { flex: 0 0 1px }，没有任何拖拽逻辑）。
// 复用侧边栏 resizer 那套 pointer capture 方案：指针被拖出窗口也能正确收尾。
const MD_SPLIT_MIN = 15, MD_SPLIT_MAX = 85, MD_SPLIT_DEFAULT = 50;

function applyMdSplit(pct) {
  const v = Math.min(MD_SPLIT_MAX, Math.max(MD_SPLIT_MIN, pct));
  els.mdEditor.style.setProperty('--md-split', v + '%');
  if (els.mdEditorSplit) els.mdEditorSplit.setAttribute('aria-valuenow', String(Math.round(v)));
  return v;
}

(function setupMdSplit() {
  if (!els.mdEditorSplit || !els.mdEditor) return;
  const saved = parseFloat(localStorage.getItem('atlas:mdSplit'));
  let current = applyMdSplit(Number.isFinite(saved) ? saved : MD_SPLIT_DEFAULT);

  let dragging = false;
  let pointerId = null;
  let rafId = 0;
  let pending = null;

  const flush = () => {
    rafId = 0;
    if (pending != null) current = applyMdSplit(pending);
  };
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (pointerId != null) {
      try { els.mdEditorSplit.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    }
    document.body.classList.remove('md-splitting');
    els.mdEditorSplit.classList.remove('dragging');
    localStorage.setItem('atlas:mdSplit', String(Math.round(current)));
  };

  els.mdEditorSplit.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    pointerId = e.pointerId;
    try { els.mdEditorSplit.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add('md-splitting');
    els.mdEditorSplit.classList.add('dragging');
  });
  els.mdEditorSplit.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = els.mdEditor.getBoundingClientRect();
    if (rect.width <= 0) return;
    pending = ((e.clientX - rect.left) / rect.width) * 100;
    if (!rafId) rafId = requestAnimationFrame(flush);
  });
  els.mdEditorSplit.addEventListener('pointerup', endDrag);
  els.mdEditorSplit.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);
  document.addEventListener('visibilitychange', () => { if (document.hidden) endDrag(); });

  // 双击复位
  els.mdEditorSplit.addEventListener('dblclick', () => {
    current = applyMdSplit(MD_SPLIT_DEFAULT);
    localStorage.setItem('atlas:mdSplit', String(MD_SPLIT_DEFAULT));
  });
  // 键盘可达：方向键微调
  els.mdEditorSplit.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') { e.preventDefault(); current = applyMdSplit(current - step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); current = applyMdSplit(current + step); }
    else if (e.key === 'Home') { e.preventDefault(); current = applyMdSplit(MD_SPLIT_DEFAULT); }
    else return;
    localStorage.setItem('atlas:mdSplit', String(Math.round(current)));
  });
  els.mdEditorSplit.setAttribute('aria-valuemin', String(MD_SPLIT_MIN));
  els.mdEditorSplit.setAttribute('aria-valuemax', String(MD_SPLIT_MAX));
})();

// ---------- 格式工具条 ----------
// 快捷键已经有了，但没有任何可见入口——工具条主要解决"发现不了"的问题，
// title 里带上快捷键，用两次就能记住。
function mdLinePrefix(prefix, { toggle = true } = {}) {
  const ta = els.mdSource;
  const v = ta.value;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const blockStart = v.lastIndexOf('\n', s - 1) + 1;
  let blockEnd = v.indexOf('\n', e);
  if (blockEnd < 0) blockEnd = v.length;
  const lines = v.slice(blockStart, blockEnd).split('\n');
  // 已经全部带该前缀 → 再点一次去掉
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const has = new RegExp('^\\s*' + escaped);
  const allHave = toggle && lines.every(l => !l.trim() || has.test(l));
  const next = lines.map(l => {
    if (!l.trim()) return l;
    if (allHave) return l.replace(has, '');
    return prefix + l;
  }).join('\n');
  mdReplaceRange(blockStart, blockEnd, next);
  ta.setSelectionRange(blockStart, blockStart + next.length);
}

const MD_TOOLBAR_ACTIONS = {
  bold: () => mdWrapSelection('**', '粗体'),
  italic: () => mdWrapSelection('*', '斜体'),
  code: () => mdWrapSelection('`', 'code'),
  link: () => mdInsertLink(),
  h2: () => mdLinePrefix('## '),
  ul: () => mdLinePrefix('- '),
  task: () => mdLinePrefix('- [ ] '),
  quote: () => mdLinePrefix('> '),
};

if (els.mdToolbar) {
  els.mdToolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-md-cmd]');
    if (!btn) return;
    const fn = MD_TOOLBAR_ACTIONS[btn.dataset.mdCmd];
    if (fn) fn();
  });
  // 按下工具条按钮不要抢走 textarea 的选区
  els.mdToolbar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button[data-md-cmd]')) e.preventDefault();
  });
}

// 标记"用户真正改过"的顶层块。在 beforeinput 阶段做：那时 DOM 还没变，
// selection 仍指向原始节点，能稳定定位到所属的顶层块。
function markMdEditedBlock() {
  if (!els.mdPreview) return;
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount) return;
  const mark = (node) => {
    let n = node;
    if (n && n.nodeType === 3) n = n.parentElement;
    while (n && n.parentElement && n.parentElement !== els.mdPreview) n = n.parentElement;
    if (n && n.nodeType === 1 && n.parentElement === els.mdPreview) {
      n.setAttribute('data-md-dirty', '1');
    }
  };
  const range = sel.getRangeAt(0);
  mark(range.startContainer);
  if (range.endContainer !== range.startContainer) mark(range.endContainer);
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

// ---------- 未保存草稿：崩溃 / 误关标签页后可恢复 ----------
// beforeunload 只能拦住"用户主动关闭"，进程崩溃、断电、强制退出都拦不住。
// 编辑期间把内容定期写进 localStorage，下次进入同一文件的编辑模式时提示恢复。
const MD_DRAFT_KEY = 'atlas:mdDrafts';
const MD_DRAFT_MAX = 8;
const MD_DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;

function loadMdDrafts() {
  try {
    const raw = JSON.parse(localStorage.getItem(MD_DRAFT_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return {};
    // 顺手清掉过期条目
    const now = Date.now();
    let changed = false;
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v.content !== 'string' || now - (v.savedAt || 0) > MD_DRAFT_TTL_MS) {
        delete raw[k];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(MD_DRAFT_KEY, JSON.stringify(raw));
    return raw;
  } catch { return {}; }
}

function writeMdDraft(path, content, baseHash) {
  if (!path) return;
  try {
    const all = loadMdDrafts();
    all[path] = { content, baseHash, savedAt: Date.now() };
    // 超量时丢掉最旧的
    const keys = Object.keys(all);
    if (keys.length > MD_DRAFT_MAX) {
      keys.sort((a, b) => (all[a].savedAt || 0) - (all[b].savedAt || 0));
      for (const k of keys.slice(0, keys.length - MD_DRAFT_MAX)) delete all[k];
    }
    localStorage.setItem(MD_DRAFT_KEY, JSON.stringify(all));
  } catch {}
}

function clearMdDraft(path) {
  if (!path) return;
  try {
    const all = loadMdDrafts();
    if (all[path]) {
      delete all[path];
      localStorage.setItem(MD_DRAFT_KEY, JSON.stringify(all));
    }
  } catch {}
}

let mdDraftTimer = null;
function scheduleMdDraftSave() {
  if (!editState.active || editState.kind !== 'md' || !editState.path) return;
  if (mdDraftTimer) clearTimeout(mdDraftTimer);
  mdDraftTimer = setTimeout(() => {
    mdDraftTimer = null;
    if (!editState.active || editState.kind !== 'md') return;
    writeMdDraft(editState.path, els.mdSource.value, editState.baseHash);
  }, 700);
}
function cancelMdDraftSave() {
  if (mdDraftTimer) { clearTimeout(mdDraftTimer); mdDraftTimer = null; }
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

  // 有未保存草稿且与磁盘内容不同 → 问用户要不要恢复
  let content = data.content || '';
  let restoredDraft = false;
  const draft = loadMdDrafts()[filePath];
  if (draft && typeof draft.content === 'string' && draft.content !== content) {
    const when = fmtMtime(draft.savedAt);
    const useDraft = await showConfirm({
      title: '发现未保存的草稿',
      body: `这个文件有一份 ${when} 的未保存编辑内容（可能是上次浏览器意外关闭留下的）。\n\n要恢复草稿，还是丢弃它、用磁盘上的当前内容？`,
      confirmText: '恢复草稿',
      cancelText: '丢弃草稿',
    });
    if (useDraft) {
      content = draft.content;
      restoredDraft = true;
    } else {
      clearMdDraft(filePath);
    }
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

  els.mdSource.value = content;
  renderMdPreview();
  if (restoredDraft) {
    markDirty();
    showToast({ kind: 'info', text: '已恢复未保存的草稿', secondary: '确认无误后按 ⌘S 保存' });
  }

  updateEditToolbar();
  els.emptyState.classList.add('hidden');
  els.preview.classList.add('hidden');   // 隐藏 iframe，显示分栏编辑器
  els.mdEditor.classList.remove('hidden');
  applyMdOutlineVisibility();            // 恢复上次的大纲显示状态
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

// ---------- Markdown 源码框编辑辅助 ----------
// 统一的"改源码"入口：优先走 execCommand('insertText') 以保留浏览器原生撤销栈
// （直接赋值 textarea.value 会把 ⌘Z 历史清空，长文档编辑时很致命）
function mdReplaceRange(start, end, text) {
  const ta = els.mdSource;
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok) {
    const v = ta.value;
    ta.value = v.slice(0, start) + text + v.slice(end);
    ta.setSelectionRange(start + text.length, start + text.length);
  }
  afterMdSourceEdit();
}
function afterMdSourceEdit() {
  if (editState.active && editState.kind === 'md') markDirty();
  scheduleMdRender();
  scheduleMdDraftSave();
}

// 包裹 / 取消包裹选区（加粗、斜体、行内代码、删除线）
function mdWrapSelection(marker, placeholder) {
  const ta = els.mdSource;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const v = ta.value;
  const sel = v.slice(s, e);
  const m = marker.length;
  // 选区外侧已有标记 → 取消
  if (v.slice(Math.max(0, s - m), s) === marker && v.slice(e, e + m) === marker) {
    mdReplaceRange(s - m, e + m, sel);
    ta.setSelectionRange(s - m, s - m + sel.length);
    return;
  }
  // 选区内侧已含标记 → 取消
  if (sel.length >= m * 2 && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(m, sel.length - m);
    mdReplaceRange(s, e, inner);
    ta.setSelectionRange(s, s + inner.length);
    return;
  }
  const body = sel || placeholder;
  mdReplaceRange(s, e, marker + body + marker);
  ta.setSelectionRange(s + m, s + m + body.length);
}

// 插入链接：有选区时把选区当链接文字，光标落在 url 上便于直接输入
function mdInsertLink() {
  const ta = els.mdSource;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const label = ta.value.slice(s, e) || '链接文字';
  const urlPlaceholder = 'https://';
  mdReplaceRange(s, e, '[' + label + '](' + urlPlaceholder + ')');
  const urlStart = s + 1 + label.length + 2;
  ta.setSelectionRange(urlStart, urlStart + urlPlaceholder.length);
}

// 列表行解析：缩进 / 标记 / 序号 / 分隔符 / 标记后空白 / 任务框 / 正文
const MD_LIST_LINE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\][ \t]+)?(.*)$/;

// 回车自动续列表：`- foo` 回车 → 自动补 `- `；有序列表序号自增；
// 在空列表项上回车 → 结束列表（清掉标记），符合主流编辑器行为
function handleMdEnter() {
  const ta = els.mdSource;
  if (ta.selectionStart !== ta.selectionEnd) return false;
  const pos = ta.selectionStart;
  const v = ta.value;
  const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
  const line = v.slice(lineStart, pos);
  const m = line.match(MD_LIST_LINE);
  if (!m) return false;
  const indent = m[1];
  const bullet = m[2];
  const num = m[3];
  const delim = m[4];
  const space = m[5];
  const task = m[6];
  const content = m[7];
  // 空列表项：结束列表
  if (!content.trim()) {
    mdReplaceRange(lineStart, pos, indent);
    return true;
  }
  const nextMarker = num ? (String(parseInt(num, 10) + 1) + delim) : bullet;
  const taskPart = task ? '[ ] ' : '';
  mdReplaceRange(pos, pos, '\n' + indent + nextMarker + space + taskPart);
  return true;
}

// Tab / Shift+Tab：单行插入缩进；跨行选区整体缩进 / 反缩进
function handleMdTab(shift) {
  const ta = els.mdSource;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const v = ta.value;
  const multiline = v.slice(s, e).indexOf('\n') >= 0;
  if (!multiline && !shift) {
    mdReplaceRange(s, e, '  ');
    return;
  }
  const blockStart = v.lastIndexOf('\n', s - 1) + 1;
  let blockEnd = v.indexOf('\n', e);
  if (blockEnd < 0) blockEnd = v.length;
  const block = v.slice(blockStart, blockEnd);
  const next = block.split('\n').map(line => {
    if (shift) return line.replace(/^ {1,2}/, '');
    return line.trim() ? '  ' + line : line;
  }).join('\n');
  mdReplaceRange(blockStart, blockEnd, next);
  ta.setSelectionRange(blockStart, blockStart + next.length);
}

// textarea 输入 → 每帧刷新预览 + 标脏（实时）
if (els.mdSource) {
  els.mdSource.addEventListener('input', () => {
    if (editState.active && editState.kind === 'md') markDirty();
    scheduleMdRender();
    scheduleMdDraftSave();
  });
  els.mdSource.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      // ⌘B 加粗 / ⌘I 斜体 / ⌘K 插链接（⌘S 保存由全局处理器接管）
      if (k === 'b' && !e.shiftKey) { e.preventDefault(); mdWrapSelection('**', '粗体'); return; }
      if (k === 'i' && !e.shiftKey) { e.preventDefault(); mdWrapSelection('*', '斜体'); return; }
      if (k === 'k' && !e.shiftKey) { e.preventDefault(); mdInsertLink(); return; }
      if (k === 'e' && !e.shiftKey) { e.preventDefault(); mdWrapSelection('`', 'code'); return; }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      handleMdTab(e.shiftKey);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      if (handleMdEnter()) e.preventDefault();
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
  els.mdPreview.addEventListener('scroll', () => {
    syncScroll(els.mdPreview, els.mdSource);
    updateMdOutlineActive();
  }, { passive: true });

  // 预览区（所见即所得）编辑 → 每帧反向序列化回源码 textarea（不回写预览，避免打断输入/光标）
  let mdSerializeScheduled = false;
  const scheduleMdSerialize = () => {
    if (mdSerializeScheduled) return;
    mdSerializeScheduled = true;
    requestAnimationFrame(() => {
      mdSerializeScheduled = false;
      if (!window.AtlasMarkdown || !window.AtlasMarkdown.htmlToMarkdown) return;
      els.mdSource.value = window.AtlasMarkdown.htmlToMarkdown(els.mdPreview);
      scheduleMdDraftSave();
    });
  };
  // beforeinput 先于 DOM 变更触发，此时 selection 还指向原节点，
  // 用来把"被碰过的块"打上标记
  els.mdPreview.addEventListener('beforeinput', () => {
    if (!(editState.active && editState.kind === 'md')) return;
    markMdEditedBlock();
  });
  els.mdPreview.addEventListener('input', () => {
    if (!(editState.active && editState.kind === 'md')) return;
    markMdEditedBlock();   // 兜底：不支持 beforeinput 的场景
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
      cancelMdDraftSave();
      clearMdDraft(savedPath);      // 已落盘，草稿使命结束
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
  cancelMdDraftSave();
  // 退出时如果还有未保存改动（用户选了"放弃"），草稿留在 localStorage 里，
  // 7 天内下次进入同一文件仍可恢复——比直接丢掉更安全
  if (editState.kind === 'md' && editState.dirty && editState.path) {
    writeMdDraft(editState.path, els.mdSource.value, editState.baseHash);
  }
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
    // 退出前记录编辑器预览面板的滚动百分比，重载 iframe 后按同比例恢复，避免跳回顶部
    if (restore && rawUrl) {
      try {
        const pv = els.mdPreview;
        const max = pv.scrollHeight - pv.clientHeight;
        pendingPreviewScrollPct = max > 0 ? pv.scrollTop / max : 0;
      } catch { pendingPreviewScrollPct = null; }
    }
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

async function cancelEdit() {
  if (!editState.active) return;
  if (!(await confirmDiscardIfDirty())) return;
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
  [els.btnExportPdf, els.btnShare, els.btnReloadPreview, els.btnMarkUnread, els.btnDiff].forEach((b) => {
    if (b) b.disabled = editing ? true : b.disabled;
  });
  // 进编辑模式先收掉对比面板：两者都要占满预览区
  if (editing && diffState.open) closeDiff();
  if (!editing && state.activeFilePath) {
    // 退出编辑后恢复这些按钮可用
    els.btnExportPdf.disabled = false;
    els.btnShare.disabled = false;
    els.btnReloadPreview.disabled = false;
    els.btnMarkUnread.disabled = false;
    updateDiffButton();
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


// ==================== Diff：和上次已读版本对比 ====================
// 未读红点只回答了"AI 动过这个文件"，但用户真正想知道的是"动了什么"。
// 底本在用户每次打开文件时由 /api/seen 落一份快照，这里做的是把差异呈现出来。
const diffState = { open: false, path: null, loading: false };

function diffContextValue() {
  const v = els.diffContext ? parseInt(els.diffContext.value, 10) : 3;
  return Number.isFinite(v) ? v : 3;
}

function renderDiffEmpty(html) {
  els.diffBody.innerHTML = html;
}

function renderDiffResult(data) {
  els.diffBody.innerHTML = '';
  if (!data.hasBaseline) {
    els.diffStats.textContent = '';
    renderDiffEmpty(`
      <div class="diff-empty">
        <div class="diff-empty-art">🕰️</div>
        <div>${escapeHtml(data.message || '还没有可对比的底本。')}</div>
        <div class="diff-empty-hint">底本会在你打开文档时自动记录，之后 AI 再改动就能看到逐行差异。</div>
      </div>`);
    return;
  }
  const when = data.baselineAt ? fmtMtime(data.baselineAt) : '未知时间';
  if (!data.changed) {
    els.diffStats.textContent = `底本记录于 ${when}`;
    renderDiffEmpty(`
      <div class="diff-empty">
        <div class="diff-empty-art">✅</div>
        <div>和你上次看到的内容完全一致</div>
        <div class="diff-empty-hint">底本记录于 ${escapeHtml(when)}</div>
      </div>`);
    return;
  }
  els.diffStats.innerHTML =
    `<span class="add">+${data.added}</span> / <span class="del">−${data.removed}</span>`
    + ` · 底本记录于 ${escapeHtml(when)}`;

  const frag = document.createDocumentFragment();
  for (const hunk of data.hunks) {
    const box = document.createElement('div');
    box.className = 'diff-hunk';
    if (hunk.skipped > 0) {
      const skip = document.createElement('div');
      skip.className = 'diff-skip';
      skip.textContent = `⋯ 省略 ${hunk.skipped} 行未改动内容 ⋯`;
      box.appendChild(skip);
    }
    for (const line of hunk.lines) {
      const row = document.createElement('div');
      row.className = 'diff-line ' + line.type;
      const gutter = document.createElement('div');
      gutter.className = 'diff-gutter';
      gutter.innerHTML =
        `<span>${line.oldLine == null ? '' : line.oldLine}</span>`
        + `<span>${line.newLine == null ? '' : line.newLine}</span>`;
      const sign = document.createElement('div');
      sign.className = 'diff-sign';
      sign.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
      const text = document.createElement('div');
      text.className = 'diff-text';
      text.textContent = line.text === '' ? '\u00a0' : line.text;
      row.appendChild(gutter);
      row.appendChild(sign);
      row.appendChild(text);
      box.appendChild(row);
    }
    frag.appendChild(box);
  }
  if (data.truncated) {
    const more = document.createElement('div');
    more.className = 'diff-truncated';
    more.textContent = '差异过多，只显示了前面一部分。';
    frag.appendChild(more);
  }
  els.diffBody.appendChild(frag);
}

async function loadDiff() {
  if (!diffState.path || diffState.loading) return;
  diffState.loading = true;
  const f = state.files[diffState.path];
  diffState.mtime = f ? f.mtime : 0;   // 记下这次对比针对的版本
  els.diffStats.textContent = '正在对比…';
  try {
    const url = '/api/diff?path=' + encodeURIComponent(diffState.path)
      + '&context=' + diffContextValue();
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      els.diffStats.textContent = '';
      renderDiffEmpty(`<div class="diff-empty"><div class="diff-empty-art">⚠️</div>
        <div>对比失败：${escapeHtml(data.error || ('HTTP ' + r.status))}</div></div>`);
      return;
    }
    renderDiffResult(data);
  } catch (e) {
    els.diffStats.textContent = '';
    renderDiffEmpty(`<div class="diff-empty"><div class="diff-empty-art">⚠️</div>
      <div>对比失败：${escapeHtml(e.message)}</div></div>`);
  } finally {
    diffState.loading = false;
  }
}

function openDiff() {
  const filePath = state.activeFilePath;
  if (!filePath) return;
  // 编辑态下不开对比：两个面板都要占预览区，而且编辑中的内容还没落盘
  if (editState.active) {
    showToast({ kind: 'info', text: '请先退出编辑再对比' });
    return;
  }
  diffState.open = true;
  diffState.path = filePath;
  els.diffPanel.classList.remove('hidden');
  els.emptyState.classList.add('hidden');
  loadDiff();
}

function closeDiff() {
  diffState.open = false;
  diffState.path = null;
  els.diffPanel.classList.add('hidden');
  els.diffBody.innerHTML = '';
}

if (els.btnDiff) {
  els.btnDiff.addEventListener('click', () => {
    if (els.btnDiff.disabled) return;
    if (diffState.open) closeDiff();
    else openDiff();
  });
}
if (els.diffClose) els.diffClose.addEventListener('click', closeDiff);
if (els.diffContext) els.diffContext.addEventListener('change', loadDiff);
if (els.diffAccept) {
  els.diffAccept.addEventListener('click', async () => {
    if (!diffState.path) return;
    const p = diffState.path;
    els.diffAccept.disabled = true;
    try {
      const r = await fetch('/api/diff/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (state.files[p]) {
        state.files[p].unread = false;
        state.files[p].hasBaseline = true;
        state.files[p].baselineAt = Date.now();
      }
      updateUnreadDecorations();
      updateDiffButton();
      showToast({ kind: 'success', text: '已更新对比底本' });
      loadDiff();
    } catch (e) {
      showToast({ kind: 'error', text: '操作失败', secondary: e.message });
    } finally {
      els.diffAccept.disabled = false;
    }
  });
}

// 按钮可用性：有底本才能对比；文件被改过时给个 accent 色提示
function updateDiffButton() {
  if (!els.btnDiff) return;
  const file = state.activeFilePath && state.files[state.activeFilePath];
  if (!file) {
    els.btnDiff.disabled = true;
    els.btnDiff.classList.remove('has-changes');
    els.btnDiff.title = '和上次已读版本对比';
    return;
  }
  els.btnDiff.disabled = editState.active;
  const changed = file.hasBaseline && file.baselineAt && file.mtime > file.baselineAt;
  els.btnDiff.classList.toggle('has-changes', !!changed);
  els.btnDiff.title = !file.hasBaseline
    ? '还没有对比底本（打开一次后即可对比）'
    : (changed ? '这个文档自上次查看后有改动，点击查看差异' : '和上次已读版本对比');
}

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
  // 多关键词：每个词都单独高亮（搜索是 AND 过滤，但高亮要把所有词都标出来）
  const terms = parseQueryTerms(query);
  if (!terms.length) return;

  injectHighlightStyle(doc);

  // 在一个文本节点里找出所有关键词的命中区间，按位置排序并去掉重叠
  const findRanges = (lower) => {
    const ranges = [];
    for (const t of terms) {
      let from = 0;
      let idx;
      while ((idx = lower.indexOf(t, from)) !== -1) {
        ranges.push([idx, idx + t.length]);
        from = idx + t.length;
      }
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] < last[1]) {
        if (r[1] > last[1]) last[1] = r[1];   // 重叠则合并
      } else {
        merged.push(r.slice());
      }
    }
    return merged;
  };

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
      const lower = (node.nodeValue || '').toLowerCase();
      return terms.some(t => lower.indexOf(t) >= 0)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const todo = [];
  while (walker.nextNode()) todo.push(walker.currentNode);

  for (const node of todo) {
    const text = node.nodeValue;
    const ranges = findRanges(text.toLowerCase());
    if (!ranges.length) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const [s, e] of ranges) {
      if (s > last) frag.appendChild(doc.createTextNode(text.slice(last, s)));
      const mark = doc.createElement('mark');
      mark.setAttribute(HIGHLIGHT_MARK_ATTR, '1');
      mark.textContent = text.slice(s, e);
      frag.appendChild(mark);
      highlightMatches.push(mark);
      last = e;
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
  // 与 server 的 termIsSearchable 一致：至少要有一个"够具体"的关键词
  return parseQueryTerms(q).some(t => (/^[\x00-\x7F]+$/.test(t) ? t.length >= 2 : true));
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
  const name = await showPrompt({
    title: '新建顶层分组',
    label: '分组名称',
    value: '新分组',
    confirmText: '创建',
  });
  if (!name) return;
  const res = await fetch('/api/folders/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.ok) fetchState();
});

els.btnMarkAll.addEventListener('click', async () => {
  const ok = await showConfirm({
    title: '全部标为已读？',
    body: '所有文档的未读红点都会被清掉。',
    confirmText: '全部标为已读',
  });
  if (!ok) return;
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

  // 去扩展名要覆盖 .md/.markdown，不能只处理 .html
  const stem = (file.alias || stripDocExt(file.name)).trim() || 'export';

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
  // 只改按钮里的图标 span，别动按钮自身（否则会把 aria-label 之外的结构冲掉）
  const icon = els.btnCopyPath.querySelector('span') || els.btnCopyPath;
  navigator.clipboard.writeText(state.activeFilePath).then(() => {
    const orig = icon.textContent;
    icon.textContent = '✓';
    setTimeout(() => { icon.textContent = orig; }, 1000);
  }).catch(() => {
    showToast({ kind: 'error', text: '复制失败', secondary: '浏览器拒绝了剪贴板访问' });
  });
});

// 判断焦点是否落在"正在输入文字"的元素上。
// 注意 <input> / <textarea> 的 isContentEditable 是 false——只判 isContentEditable
// 会让全局单键快捷键（比如 `/`）把用户正在输入的字符抢走：在设置里手输
// 扫描根路径 `/Users/...` 时每个 `/` 都会把焦点弹到搜索框，路径根本打不进去。
function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// 焦点是否在 Markdown 编辑器内部（源码框或可编辑预览区）
function isInMdEditor(el) {
  if (!el || !editState.active || editState.kind !== 'md') return false;
  return el === els.mdSource || (els.mdPreview && els.mdPreview.contains(el));
}

document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const mod = e.metaKey || e.ctrlKey;

  // ⌘S / Ctrl+S：编辑态下保存到文件，而不是让浏览器弹"保存网页"
  if (mod && e.key.toLowerCase() === 's' && !e.altKey && !e.shiftKey) {
    if (editState.active) {
      e.preventDefault();
      saveEdit();
      return;
    }
  }

  // ⌘K / Ctrl+K：快速打开。在 Markdown 编辑器里让位给"插入链接"
  if (mod && e.key.toLowerCase() === 'k' && !e.altKey && !e.shiftKey) {
    if (isInMdEditor(active)) return;
    e.preventDefault();
    if (qoEntry) closeQuickOpen();
    else openQuickOpen();
    return;
  }

  // ⌘B / Ctrl+B：Markdown 编辑器里是"加粗"，其余场景才是切换侧边栏
  if (mod && e.key.toLowerCase() === 'b' && !e.altKey && !e.shiftKey) {
    if (isInMdEditor(active)) return;   // 交给编辑器自己的处理器
    e.preventDefault();
    toggleSidebar();
    return;
  }

  // 单键快捷键：焦点在输入框 / 可编辑区里时一律不抢
  if (e.key === '/' && !isTypingTarget(active)) {
    e.preventDefault();
    els.search.focus();
    return;
  }
  if (e.key === 'Escape' && active === els.search) {
    els.search.value = '';
    state.search = '';
    state.contentMatches = new Map();
    render();
    updateIframeHighlight();
  }
});

// ==================== ⌘K 快速打开 ====================
// 原来切文件只能走「搜索框 → ↓ → Enter」，而搜索框还兼着"过滤目录树"和
// "iframe 内高亮"两个职责。快速打开是纯导航：敲几个字，Enter 走。
const qoEls = {
  root: document.getElementById('quickopen'),
  input: document.getElementById('quickopen-input'),
  list: document.getElementById('quickopen-list'),
  count: document.getElementById('quickopen-count'),
};
const QO_LIMIT = 50;
let qoEntry = null;
let qoResults = [];
let qoActive = 0;

// 子序列模糊匹配：'aprt' 能命中 'api-report'。
// 返回 { score, hits }，hits 是命中字符在原串里的下标（用于高亮）；不匹配返回 null。
function fuzzyMatch(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const hits = [];
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    hits.push(found);
    // 连续命中、词首命中都加分——让 'aprt' 更倾向匹配 'api-report' 而不是零散撞上
    if (found === ti && qi > 0) { streak++; score += 6 + streak * 2; }
    else { streak = 0; score += 1; }
    if (found === 0 || /[\s\-_./\\]/.test(t[found - 1] || '')) score += 4;
    ti = found + 1;
  }
  score -= (t.length - q.length) * 0.05;   // 同等命中下更短的更相关
  return { score, hits };
}

function qoHighlight(text, hits) {
  if (!hits || !hits.length) return escapeHtml(text);
  const set = new Set(hits);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = escapeHtml(text[i]);
    out += set.has(i) ? `<mark>${c}</mark>` : c;
  }
  return out;
}

function qoSearch(query) {
  const files = Object.values(state.files);
  const q = query.trim();
  if (!q) {
    // 空查询：最近打开优先，其次按修改时间
    const recentSet = new Map((state.recent || []).map((p, i) => [p, i]));
    return files
      .slice()
      .sort((a, b) => {
        const ra = recentSet.has(a.path) ? recentSet.get(a.path) : Infinity;
        const rb = recentSet.has(b.path) ? recentSet.get(b.path) : Infinity;
        if (ra !== rb) return ra - rb;
        return (b.mtime || 0) - (a.mtime || 0);
      })
      .slice(0, QO_LIMIT)
      .map(f => ({ file: f, hits: [], label: f.alias || stripDocExt(f.name) }));
  }
  const scored = [];
  for (const f of files) {
    const label = f.alias || stripDocExt(f.name);
    // 分别打分：文件名/备注权重最高，其次项目名，最后整条相对路径
    const byLabel = fuzzyMatch(label, q);
    const byProject = fuzzyMatch(f.projectName || '', q);
    const byPath = fuzzyMatch(f.relPath || '', q);
    let best = null;
    if (byLabel) best = { score: byLabel.score + 30, hits: byLabel.hits };
    if (byProject && (!best || byProject.score + 10 > best.score)) {
      best = { score: byProject.score + 10, hits: [] };
    }
    if (byPath && (!best || byPath.score > best.score)) {
      best = { score: byPath.score, hits: [] };
    }
    if (!best) continue;
    if (f.unread) best.score += 3;   // 未读的略微靠前——它更可能是你要找的
    scored.push({ file: f, score: best.score, hits: best.hits, label });
  }
  scored.sort((a, b) => b.score - a.score || (b.file.mtime || 0) - (a.file.mtime || 0));
  return scored.slice(0, QO_LIMIT);
}

function qoRender() {
  qoResults = qoSearch(qoEls.input.value);
  qoActive = 0;
  qoEls.list.innerHTML = '';
  if (!qoResults.length) {
    const empty = document.createElement('div');
    empty.className = 'quickopen-empty';
    empty.textContent = '没有匹配的文档';
    qoEls.list.appendChild(empty);
    qoEls.count.textContent = '';
    return;
  }
  qoResults.forEach((r, idx) => {
    const f = r.file;
    const dtype = isMdFile(f) ? 'md' : 'html';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quickopen-item' + (idx === 0 ? ' active' : '');
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(idx === 0));
    btn.dataset.idx = String(idx);
    btn.innerHTML = `
      <span class="qo-icon" aria-hidden="true">${dtype === 'md' ? '📝' : '🌐'}</span>
      <span class="qo-main">
        <span class="qo-name">${qoHighlight(r.label, r.hits)}</span>
        <span class="qo-path">${escapeHtml(f.relPath)}</span>
      </span>
      <span class="qo-badge">${dtype === 'md' ? 'MD' : 'HTML'}</span>
      ${f.unread ? '<span class="qo-unread" title="未读"></span>' : ''}
    `;
    btn.addEventListener('click', () => qoOpen(idx));
    btn.addEventListener('mousemove', () => qoSetActive(idx));
    qoEls.list.appendChild(btn);
  });
  qoEls.count.textContent = `${qoResults.length}${qoResults.length >= QO_LIMIT ? '+' : ''} 个结果`;
}

function qoSetActive(idx) {
  if (!qoResults.length) return;
  qoActive = (idx + qoResults.length) % qoResults.length;
  const items = [...qoEls.list.querySelectorAll('.quickopen-item')];
  items.forEach((el, i) => {
    const on = i === qoActive;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
}

function qoOpen(idx) {
  const r = qoResults[typeof idx === 'number' ? idx : qoActive];
  if (!r) return;
  closeQuickOpen();
  openFile(r.file.path);
}

function openQuickOpen() {
  if (!qoEls.root || qoEntry) return;
  qoEls.root.classList.remove('hidden');
  qoEls.input.value = '';
  qoRender();
  qoEntry = pushModal({
    panel: qoEls.root.querySelector('.modal-panel'),
    close: closeQuickOpen,
    initialFocus: qoEls.input,
  });
}

function closeQuickOpen() {
  if (!qoEls.root) return;
  qoEls.root.classList.add('hidden');
  if (qoEntry) { popModal(qoEntry); qoEntry = null; }
}

if (qoEls.root) {
  qoEls.root.addEventListener('click', (e) => {
    if (e.target.dataset && e.target.dataset.close !== undefined) closeQuickOpen();
  });
  qoEls.input.addEventListener('input', qoRender);
  qoEls.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); qoSetActive(qoActive + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); qoSetActive(qoActive - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); qoOpen(); }
    else if (e.key === 'Home') { e.preventDefault(); qoSetActive(0); }
    else if (e.key === 'End') { e.preventDefault(); qoSetActive(qoResults.length - 1); }
  });
}

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
  if (!settingsModalEntry) {
    settingsModalEntry = pushModal({
      panel: els.modal.querySelector('.modal-panel'),
      close: closeSettings,
    });
  }
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
      <span class="share-list-meta"></span>
      <button class="share-list-stop" type="button">停止</button>
    `;
    li.querySelector('.share-list-name').textContent = display;
    li.querySelector('.share-list-url').textContent = url;
    li.querySelector('.share-list-url').title = url;
    // 有效期 + 范围：一眼看出哪条链接还开着、开得多大
    const metaParts = [];
    if (item.expiresAt) {
      const mins = Math.ceil((item.expiresAt - Date.now()) / 60_000);
      metaParts.push(mins > 60 ? `${Math.floor(mins / 60)}h 后过期` : (mins > 0 ? `${mins}m 后过期` : '已过期'));
    } else {
      metaParts.push('不过期');
    }
    metaParts.push(item.scope === 'dir' ? '同目录全开' : '仅引用资源');
    const metaEl = li.querySelector('.share-list-meta');
    metaEl.textContent = metaParts.join(' · ');
    metaEl.title = metaParts.join(' · ');
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
  const ok = await showConfirm({
    title: `停止全部 ${count} 个分享？`,
    body: '所有链接立即失效，已经打开的页面刷新会看到 404。',
    confirmText: '全部停止',
    danger: true,
  });
  if (!ok) return;
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
// 接入弹窗栈：Esc 关闭 + Tab 焦点锁在面板内 + 关闭后焦点还给触发按钮
let settingsModalEntry = null;
function closeSettings() {
  els.modal.classList.add('hidden');
  if (els.dirPicker) els.dirPicker.classList.add('hidden');
  if (settingsModalEntry) { popModal(settingsModalEntry); settingsModalEntry = null; }
}
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
      const ok0 = await showConfirm({
        title: '移除这个扫描根？',
        body: `${p}\n\n只是不再扫描这个目录，磁盘上的文件一个都不会删。`,
        confirmText: '移除',
        danger: true,
      });
      if (!ok0) return;
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
let sseRetryTimer = null;
function connectSSE() {
  // 已排程的重连作废——否则多个 timer 会各建一条 EventSource，
  // 而下面只 close 得到 evtSrc 这一个引用，其余实例丢引用却还占着连接。
  // 浏览器对同源 HTTP/1.1 只给 6 个连接，泄漏满 6 条后整页所有请求（预览、/api/state）永久排队。
  if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
  if (evtSrc) { try { evtSrc.close(); } catch {} evtSrc = null; }

  const es = new EventSource('/api/events');
  evtSrc = es;
  es.onmessage = (msg) => {
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
  es.onerror = () => {
    // 已被后来的实例取代：这是条僵尸连接，关掉就好，不参与重连排程
    if (evtSrc !== es) { try { es.close(); } catch {} return; }
    // EventSource 自身也会尝试自动重连，这里先彻底关闭，重连统一由我们排程，
    // 避免"浏览器自动重连 + 手动重连"两条连接叠加
    try { es.close(); } catch {}
    evtSrc = null;
    if (sseRetryTimer) return;   // 已有重连在排队，不重复排
    sseRetryTimer = setTimeout(() => { sseRetryTimer = null; connectSSE(); }, 3000);
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
        // 不用普通 reload：部分 Chromium 浏览器会在服务重启后保留 localhost 的空文档状态。
        // 新 URL 强制创建一次全新导航，同时用版本号方便诊断升级后的页面来源。
        const nextUrl = new URL(location.href);
        nextUrl.searchParams.set('_atlas_v', info.current);
        nextUrl.searchParams.set('_atlas_reload', String(Date.now()));
        location.replace(nextUrl.href);
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

// 记住上次选的有效期 / 范围
const SHARE_TTL_KEY = 'atlas:shareTtl';
const SHARE_SCOPE_KEY = 'atlas:shareScope';

function shareTtlValue() {
  const v = els.shareTtl ? els.shareTtl.value : '120';
  return Number.isFinite(Number(v)) ? Number(v) : 120;
}
function shareScopeValue() {
  return els.shareScope && els.shareScope.value === 'dir' ? 'dir' : 'refs';
}

// 剩余时间文案 + 到期前变红提醒
let shareExpiryTimer = null;
function renderShareExpiry() {
  if (!els.shareExpiry) return;
  const exp = shareCurrent && shareCurrent.expiresAt;
  if (!exp) {
    els.shareExpiry.textContent = '不会自动过期';
    els.shareExpiry.classList.remove('expiring');
    return;
  }
  const left = exp - Date.now();
  if (left <= 0) {
    els.shareExpiry.textContent = '已过期';
    els.shareExpiry.classList.add('expiring');
    return;
  }
  const mins = Math.ceil(left / 60_000);
  const text = mins >= 60
    ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分后过期`
    : `${mins} 分钟后过期`;
  els.shareExpiry.textContent = text;
  els.shareExpiry.classList.toggle('expiring', mins <= 5);
}

function renderShareScopeHint() {
  if (!els.shareScopeHint) return;
  els.shareScopeHint.textContent = shareScopeValue() === 'dir'
    ? '同目录全部资源：该文件所在目录及其子目录下的所有文件，拿到链接的人都能访问。方便，但范围大——评审完记得停掉。'
    : '仅引用到的资源：只放行文档里出现过的图片 / CSS / 脚本。如果页面在 JS 里动态拼接资源路径，可能缺图，这时再切到「同目录全部资源」。';
}

if (els.shareScope) {
  els.shareScope.addEventListener('change', () => {
    localStorage.setItem(SHARE_SCOPE_KEY, shareScopeValue());
    renderShareScopeHint();
    if (shareCurrent) reissueShare();
  });
}
if (els.shareTtl) {
  els.shareTtl.addEventListener('change', () => {
    localStorage.setItem(SHARE_TTL_KEY, String(shareTtlValue()));
    if (shareCurrent) reissueShare();
  });
}

// 改了有效期 / 范围 → 用同一个 token 重新签发（URL 不变，条件更新）
async function reissueShare() {
  if (!shareCurrent) return;
  try {
    const r = await fetch('/api/share/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: shareCurrent.path,
        ttlMinutes: shareTtlValue(),
        scope: shareScopeValue(),
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    shareCurrent = await r.json();
    state.sharesByPath.set(shareCurrent.path, shareCurrent);
    renderShareExpiry();
    renderShareList();
    showToast({ kind: 'success', text: '分享设置已更新' });
  } catch (e) {
    showToast({ kind: 'error', text: '更新分享设置失败', secondary: e.message });
  }
}

async function openShareModal(filePath) {
  const file = state.files[filePath];
  if (!file) return;
  // 恢复上次选择
  const savedTtl = localStorage.getItem(SHARE_TTL_KEY);
  if (els.shareTtl && savedTtl !== null && [...els.shareTtl.options].some(o => o.value === savedTtl)) {
    els.shareTtl.value = savedTtl;
  }
  const savedScope = localStorage.getItem(SHARE_SCOPE_KEY);
  if (els.shareScope && (savedScope === 'refs' || savedScope === 'dir')) {
    els.shareScope.value = savedScope;
  }
  // 调后端：已存在则复用 token，不存在则新建
  let entry;
  try {
    const r = await fetch('/api/share/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: filePath,
        ttlMinutes: shareTtlValue(),
        scope: shareScopeValue(),
      }),
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
  renderShareScopeHint();
  renderShareExpiry();
  if (shareExpiryTimer) clearInterval(shareExpiryTimer);
  shareExpiryTimer = setInterval(renderShareExpiry, 30_000);
  els.shareModal.classList.remove('hidden');
  if (!shareModalEntry) {
    shareModalEntry = pushModal({
      panel: els.shareModal.querySelector('.modal-panel'),
      close: closeShareModal,
    });
  }

  // 同步 sharesByPath 状态（角标 + 设置面板列表）
  state.sharesByPath.set(filePath, entry);
  render();
}

let shareModalEntry = null;
function closeShareModal() {
  els.shareModal.classList.add('hidden');
  shareCurrent = null;
  if (shareExpiryTimer) { clearInterval(shareExpiryTimer); shareExpiryTimer = null; }
  if (shareModalEntry) { popModal(shareModalEntry); shareModalEntry = null; }
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
  const ok = await showConfirm({
    title: `停止分享「${shareCurrent.name}」？`,
    body: '停止后链接立即失效，已经打开的页面刷新会看到 404。',
    confirmText: '停止分享',
    danger: true,
  });
  if (!ok) return;
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
