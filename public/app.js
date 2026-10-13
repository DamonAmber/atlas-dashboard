const state = {
  tree: [],
  files: {},
  recent: [],
  activeFilePath: null,
  search: '',
  contentMatches: new Map(),       // path → snippet（全文搜索结果）
  onlyUnread: false,
  // 收藏：路径数组，服务端按收藏时间倒序给（最近收藏的在最前）
  favorites: [],
  // 全量标签表 [{ name, count }]，服务端按用量倒序给——驱动标签筛选条
  allTags: [],
  // 已选中的筛选标签（多选按 AND：与搜索多关键词的语义一致，逐步收窄）。
  // 故意不持久化，和 onlyUnread 一致——否则刷新后"文档凭空少了一半"很难自查
  tagFilter: new Set(),
  collapsed: new Set(JSON.parse(localStorage.getItem('atlas:collapsed') || '[]')),
  notifyEnabled: localStorage.getItem('atlas:notify') === '1',
  // 'name' | 'mtime' | 'custom'：folder.children 排序模式
  // 默认按名称——一系列文档（v1/v2/v3）会自动聚合在一起
  sortMode: localStorage.getItem('atlas:sortMode') || 'name',
  // 侧栏目录树视图：
  //   'groups' —— 虚拟分组（默认）：可拖拽重排、手工建分组、归档，持久化在 store.tree
  //   'tree'   —— 真实目录树：完全按磁盘上的多级目录结构展示（只读镜像，不持久化、不可拖拽），
  //               解决"深层嵌套目录被压平成一级、多个 README 分不清"的问题
  //   'map'    —— 星图（design §3a）：占据主区的首页表面；侧栏仍渲染 listView 那种列表
  // viewMode 是分段控件当前选中项；listView 是侧栏实际渲染的列表（分组 / 目录），
  // 两者拆开后侧栏一律经 listViewMode() 判断，见下方
  viewMode: (() => {
    const v = localStorage.getItem('atlas:viewMode');
    return v === 'tree' || v === 'map' ? v : 'groups';
  })(),
  listView: (() => {
    const v = localStorage.getItem('atlas:listView');
    if (v === 'tree' || v === 'groups') return v;
    // 老用户只有 atlas:viewMode：它就是侧栏列表
    return localStorage.getItem('atlas:viewMode') === 'tree' ? 'tree' : 'groups';
  })(),
  // 进入星图时自动收起了侧栏（内存态，design §10.3）：离开星图时据此恢复，从不写偏好
  sidebarAutoCollapsed: false,
  // 时间河流的时间段筛选（design §3d）：{ from: 整点 ms, to: ms | null（开放到现在）} | null。
  // 只存内存、不持久化：重开 App 总是一个没有时间筛选的看板
  timeRange: null,
  // recomputeTimeRange() 同步算出：区间内有至少一个计数事件的文档，及其区间内最后一次事件的 t
  timeRangePaths: new Set(),
  timeRangeLatest: new Map(),
  timeRangeVer: 0,   // 每次重算 +1，进 filterSnapshotKey（区间不变、命中集合变了也要让缓存失效）
  // 目录视图当前这一帧的顶层节点（由 buildDirTree 生成）。缓存供 allFolderIds / collapse-all 复用，
  // 避免它们各自重建一遍
  dirTree: [],
  // path → { token, urls } —— 用于文件行渲染时判断是否已分享 + 状态角标
  sharesByPath: new Map(),
  // 已显式信任的 HTML 路径。未信任的走沙箱 iframe 预览（拿不到同源权限）
  trusted: new Set(),
  // 设置里的全局开关：打开后所有 HTML 都按信任处理
  trustAllHtml: false,
  // ---- 多 Tab ----
  // 打开的文档标签，按显示顺序。每项 { id, path, frame, loaded }：
  //   frame  = 这个 Tab 专属的常驻 <iframe>（不销毁，切换 Tab 只是显隐）
  //   loaded = frame 是否已经导航过一次（懒加载：恢复的 Tab 先建帧、激活时才 set src）
  tabs: [],
  activeTabId: null,
  // 「AI 刚改过」：本会话经 SSE 收到 add / change、且不是 Atlas 自己写的（负载 self !== true）
  // 的文档。path → 收到时刻（ms）。JUST_CHANGED_MS 窗口内侧栏行 / 首页封面带 .just-changed
  // （点做 3 次轻闪），到期由一个共享定时器清理。
  justChanged: new Map(),
  // 真实缩略图（design §3b）。available：null = 还不知道，false = 本会话不再请求。
  // items 的键是 "theme|path"（theme = effectiveTheme()，只会是 light / dark），
  // 值 { status, k, mtime }，mtime 是请求时的 state.files[path].mtime，用来判断要不要重新请求
  thumbs: { available: null, browser: null, reason: null, items: new Map() },
};
// 「刚变更」信号的持续窗口。侧栏、首页、星图共用这一个常量
const JUST_CHANGED_MS = 90_000;
// 时间河流（design §3d）的数据与交互状态。放在这里（而不是河流那一段）是因为 renderHome()
// 在脚本加载早期就可能被调用。
//   log：undefined = 还没拉过 /api/activity；null = 拉取失败（只用修改时间兜底）；否则是本地副本
//        （AtlasRiver.decodeLog 的结果，SSE 事件按同一套合并规则追加进去）
//   ver：log 每次变化 +1，ensureRiverModel() 据此与 state.files 身份、当前整点判断要不要重算
const riverState = {
  log: undefined, failed: false, loading: false, again: false,
  ver: 0, model: null, drawn: null, grown: false, drag: null,
};
// 侧栏实际渲染的列表视图：选中「星图」时沿用切换前的分组 / 目录
function listViewMode() {
  return state.viewMode === 'map' ? state.listView : state.viewMode;
}

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
  treeCount: document.getElementById('tree-count'),
  treeFilterNote: document.getElementById('tree-filter-note'),
  btnSort: document.getElementById('btn-sort'),
  btnSortLabel: document.getElementById('btn-sort-label'),
  sortWrap: document.getElementById('sort-wrap'),
  sortMenu: document.getElementById('sort-menu'),
  sortMenuTags: document.getElementById('sort-menu-tags'),
  sortMenuTagsSec: document.getElementById('sort-menu-tags-sec'),
  btnCollapseAll: document.getElementById('btn-collapse-all'),
  collapseAllIco: document.getElementById('collapse-all-ico'),
  // preview 不再是页面里的静态元素，而是"当前活动 Tab 的 iframe"。
  // 由 activateTab / ensureFrameLoaded 在切换时重新指向，初始为 null。
  // 所有既有的 els.preview.xxx 代码因此自动作用到正确的那个帧上。
  preview: null,
  previewArea: document.querySelector('.preview'),   // 承载各 Tab iframe 的容器
  tabBar: document.getElementById('tab-bar'),
  emptyState: document.getElementById('empty-state'),
  // 首页的两个表面：封面墙 .home 与星图 #starmap-view，只经 showHomeSurface() 切换
  home: document.querySelector('#empty-state > .home'),
  starmapView: document.getElementById('starmap-view'),
  starmapStage: document.getElementById('starmap-stage'),
  starmapCanvas: document.getElementById('starmap-canvas'),
  starmapFx: document.getElementById('starmap-fx'),
  starmapReadout: document.getElementById('starmap-readout'),
  starmapFilterStatus: document.getElementById('starmap-filter-status'),
  starmapLegend: document.getElementById('starmap-legend'),
  starmapTip: document.getElementById('starmap-tip'),
  starmapEmpty: document.getElementById('starmap-empty'),
  starmapNoCanvas: document.getElementById('starmap-nocanvas'),
  starmapCatalog: document.getElementById('starmap-catalog'),
  starmapCatalogBody: document.getElementById('starmap-catalog-body'),
  starmapCatalogToggle: document.getElementById('starmap-catalog-toggle'),
  homeMinimap: document.getElementById('home-minimap'),
  homeMinimapCanvas: document.getElementById('home-minimap-canvas'),
  autoCollapseNote: document.getElementById('auto-collapse-note'),
  homeSub: document.getElementById('home-sub'),
  homeEyebrow: document.getElementById('home-eyebrow'),
  homeClock: document.getElementById('home-clock'),
  homeReadouts: document.getElementById('home-readouts'),
  homeTagStrip: document.getElementById('home-tag-strip'),
  tagStripHits: document.getElementById('tag-strip-hits'),
  homeRecentClear: document.getElementById('home-recent-clear'),
  homeHeroLine: document.getElementById('home-hero-line'),
  homeChips: document.getElementById('home-chips'),
  homeRiverCard: document.getElementById('home-river-card'),
  homeRiver: document.getElementById('home-river'),
  homeRiverMeta: document.getElementById('home-river-meta'),
  homeRiverSum: document.getElementById('home-river-sum'),
  homeRiverFallback: document.getElementById('home-river-fallback'),
  homeRiverNote: document.getElementById('home-river-note'),
  riverStart: document.getElementById('river-start'),
  riverEnd: document.getElementById('river-end'),
  riverSel: document.getElementById('river-sel'),
  riverDays: document.getElementById('river-days'),
  riverHatchTag: document.getElementById('river-hatch-tag'),
  riverNowTag: document.getElementById('river-now-tag'),
  timeFilterChip: document.getElementById('time-filter-chip'),
  homeFeedTitle: document.getElementById('home-feed-title'),
  homeFeedAll: document.getElementById('home-feed-all'),
  homeFeedCount: document.getElementById('home-feed-count'),
  homeFeedHint: document.getElementById('home-feed-hint'),
  homeGrid: document.getElementById('home-grid'),
  homeRecent: document.getElementById('home-recent'),
  homeFav: document.getElementById('home-fav'),
  homeFavRail: document.getElementById('home-fav-rail'),
  crumbs: document.getElementById('crumbs'),
  btnHome: document.getElementById('btn-home'),
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
  diffVersionWrap: document.getElementById('diff-version-wrap'),
  diffVersion: document.getElementById('diff-version'),
  diffRevert: document.getElementById('diff-revert'),
  diffAccept: document.getElementById('diff-accept'),
  diffClose: document.getElementById('diff-close'),
  btnTrust: document.getElementById('btn-trust'),
  btnEdit: document.getElementById('btn-edit'),
  btnEditSave: document.getElementById('btn-edit-save'),
  btnEditCancel: document.getElementById('btn-edit-cancel'),
  btnCopyPath: document.getElementById('btn-copy-path'),
  btnMore: document.getElementById('btn-more'),
  tbMore: document.getElementById('tb-more'),
  tbMoreMenu: document.getElementById('tb-more-menu'),
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
  trustAllToggle: document.getElementById('trust-all-toggle'),
  trustClearBtn: document.getElementById('trust-clear-btn'),
  notifyHint: document.getElementById('notify-hint'),
  ignoreInput: document.getElementById('ignore-input'),
  ignoreSaveBtn: document.getElementById('ignore-save-btn'),
  btnFavorite: document.getElementById('btn-favorite'),
  // 标签 chip 区（首页顶部筛选条里）。#recent-clear 由 ⌘K 空状态动态渲染，不在这里缓存
  tagBar: document.getElementById('tag-bar'),
  tagBarClear: document.getElementById('tag-bar-clear'),
  updateBadge: document.getElementById('update-badge'),
  updateBanner: document.getElementById('update-banner'),
  segButtons: document.querySelectorAll('.seg-btn[data-sort]'),
  viewButtons: document.querySelectorAll('.seg-btn[data-view]'),
  matchBadge: document.getElementById('match-badge'),
  matchClose: document.getElementById('match-close'),
  // 专注阅读（design §3f）
  btnFocus: document.getElementById('btn-focus'),
  btnFocusMenu: document.getElementById('btn-focus-menu'),
  focusExit: document.getElementById('focus-exit'),
  focusProgress: document.getElementById('focus-progress'),
  findBar: document.getElementById('find-bar'),
  findInput: document.getElementById('find-input'),
  findCount: document.getElementById('find-count'),
  findPrev: document.getElementById('find-prev'),
  findNext: document.getElementById('find-next'),
  findClose: document.getElementById('find-close'),
  matchPrev: document.getElementById('match-prev'),
  matchNext: document.getElementById('match-next'),
  toastContainer: document.getElementById('toast-container'),
  // Markdown 编辑器
  mdEditor: document.getElementById('md-editor'),
  mdSource: document.getElementById('md-source'),
  mdPreview: document.getElementById('md-preview'),
  mdSourceWrap: document.getElementById('md-source-wrap'),
  mdSourceHl: document.getElementById('md-source-hl'),
  mdSourceMirror: document.getElementById('md-source-mirror'),
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
      // previewThemeCss 让预览面板的正文配色跟随 Atlas 强制主题（data-theme），
      // 而不是只跟随系统的 @media (prefers-color-scheme)——否则「系统深色 +
      // 应用钉浅色」时右侧预览会变成白底浅灰字，几乎看不清。
      st.textContent = window.AtlasMarkdown.markdownCss + (window.AtlasMarkdown.previewThemeCss || '');
      document.head.appendChild(st);
    }
  } catch (e) {}
})();

// 文档扩展名工具：显示名去扩展名 / 预览 URL 路由
function stripDocExt(name) {
  return String(name || '').replace(/\.(html?|md|markdown|csv|tsv|json|txt|text|svg)$/i, '');
}
function isMdFile(file) {
  if (!file) return false;
  if (file.docType) return file.docType === 'md';
  return /\.(md|markdown)$/i.test(file.name || '');
}
// 只读格式：有预览、没有编辑器。改 csv/json 该用对应的专业工具，
// Atlas 要回答的是"AI 刚生成了什么"
const READONLY_DOC_TYPES = new Set(['csv', 'json', 'txt', 'svg']);
function isReadonlyDoc(file) {
  return READONLY_DOC_TYPES.has(docTypeOf(file));
}
// 目录树 / 面包屑 / ⌘K 里的类型角标文字
const DOC_TYPE_BADGE = {
  html: 'HTML', md: 'MD', csv: 'CSV', json: 'JSON', txt: 'TXT', svg: 'SVG',
};
// 类型图标：md 是带文字行的文件、html 是地球（能在浏览器里打开）、
// csv 是表格、json 是花括号、txt 是文本行、svg 是图形
const DOC_TYPE_ICON = {
  html: 'globe', md: 'file-text', csv: 'table', json: 'braces', txt: 'align-left', svg: 'shapes',
};
function docTypeBadge(file) {
  return DOC_TYPE_BADGE[docTypeOf(file)] || 'HTML';
}
function docTypeIconName(file) {
  return DOC_TYPE_ICON[docTypeOf(file)] || 'globe';
}
// ---------- 图标 ----------
// 全站图标只有一个来源：index.html 顶部内嵌的 <symbol> sprite。
// 这样图标改一处全局生效，也不会再出现 emoji 在不同系统上长得完全不一样的问题。
function ic(name, size = 14, extraClass = '') {
  const cls = 'ico' + (extraClass ? ' ' + extraClass : '');
  return `<svg class="${cls}" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
// 文档类型图标：md = 带文字行的文件，html = 地球（对应"能在浏览器里打开"），
// csv/json/txt/svg 各有自己的形状
function docTypeIcon(file, size = 13) {
  return ic(docTypeIconName(file), size);
}
// 当前生效的主题：system 不传给服务端，让预览页自己跟随系统
function forcedTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : '';
}
// iframe 预览地址：
//   html          → 原始 /raw/ 地址（文档自己就是一个网页）
//   md            → /api/render-md
//   csv/json/txt/svg → /api/render-doc
// 后两类都是 Atlas 自己渲染的页面，所以要带上 theme：iframe 里的
// prefers-color-scheme 读系统设置、不继承父文档，主题钉死时它得跟着钉
function previewUrlFor(file) {
  if (!file) return '';
  const th = forcedTheme();
  const themeQs = th ? '&theme=' + th : '';
  if (isMdFile(file)) {
    return '/api/render-md?path=' + encodeURIComponent(file.path) + themeQs;
  }
  if (isReadonlyDoc(file)) {
    return '/api/render-doc?path=' + encodeURIComponent(file.path) + themeQs;
  }
  return file.url;
}

// ==================== 预览沙箱与信任分级 ====================
//
// 问题：预览用的是同源 iframe（localhost:4321），而里面那份 HTML 是 AI 写的。
// 同源意味着它的脚本能 fetch("/api/save-md")、能开分享链接、能读扫描根配置——
// 一篇文档因此可以改写磁盘上别的文档。同源不是疏忽，是换来的能力：预览内编辑、
// 正文高亮、⌘K/⌘B 转发、滚动位置恢复，全都要访问 contentDocument。
//
// 所以做成分级：默认沙箱（保留 allow-scripts，图表照样能画，但没有
// allow-same-origin —— 文档的源变成 opaque，同源那套权限一并失效），
// 用户对某一篇按下"信任"之后才切回同源，把那几项增强能力交还给它。
//
// allow-scripts 与 allow-same-origin 只有同时给出才危险（文档能自己把
// sandbox 属性摘掉）。只给 allow-scripts 是安全的。
const PREVIEW_SANDBOX = [
  'allow-scripts',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-forms',
  'allow-modals',
  'allow-downloads',
].join(' ');

// 快速查看只"看"，不需要预览能提供的任何增强能力。
// 无论文档类型、无论用户是否信任过它，一律 opaque origin + 只允许脚本（让图表能画出来）。
const PEEK_SANDBOX = 'allow-scripts';
function applyPeekSandbox(ifr) {           // 必须在设置 src 之前调用：sandbox 只在导航时生效
  if (ifr.getAttribute('sandbox') !== PEEK_SANDBOX) ifr.setAttribute('sandbox', PEEK_SANDBOX);
}

// 文件的文档类型。服务端会给 docType，兜底按扩展名推断
function docTypeOf(file) {
  if (!file) return 'html';
  if (file.docType) return file.docType;
  const n = String(file.name || '');
  if (/\.(md|markdown)$/i.test(n)) return 'md';
  if (/\.(csv|tsv)$/i.test(n)) return 'csv';
  if (/\.json$/i.test(n)) return 'json';
  if (/\.txt$/i.test(n)) return 'txt';
  if (/\.svg$/i.test(n)) return 'svg';
  return 'html';
}

// 只有原始 HTML 需要沙箱。其余类型的预览页都是 Atlas 自己渲染的：
// 内容全部转义过，不会有来自文档的脚本在里面执行（SVG 也是用 <img> 嵌进去的，
// 那条路径下浏览器本来就不执行 SVG 里的脚本）。
function isSandboxableType(file) {
  return docTypeOf(file) === 'html';
}
function isTrustedDoc(file) {
  if (!file) return false;
  if (state.trustAllHtml) return true;
  return state.trusted.has(file.path);
}
function needsSandbox(file) {
  return isSandboxableType(file) && !isTrustedDoc(file);
}

// 把 sandbox 属性调整到与当前文件匹配的状态。
// 返回是否发生了变化——变了就必须重新加载 iframe：sandbox 是在文档创建时
// 生效的，改属性对已经载入的文档没有任何作用。
// 按指定帧设置 sandbox（多 Tab：每个 Tab 有独立帧，重载后台 Tab 时也要能定向设置）
function applyPreviewSandboxTo(ifr, file) {
  if (!ifr) return false;
  const want = needsSandbox(file) ? PREVIEW_SANDBOX : null;
  const has = ifr.getAttribute('sandbox');
  if (want === has) return false;
  if (want === null) ifr.removeAttribute('sandbox');
  else ifr.setAttribute('sandbox', want);
  return true;
}
function applyPreviewSandbox(file) {
  return applyPreviewSandboxTo(els.preview, file);
}

// 顶栏盾牌按钮：只在预览原始 HTML 时出现（其它类型的预览页是 Atlas 自己渲染的，
// 没有"要不要信任"这回事，摆一个常灰的图标只是噪音）。
function updateTrustButton() {
  const btn = els.btnTrust;
  if (!btn) return;
  const file = state.files[state.activeFilePath];
  if (!file || !isSandboxableType(file)) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  const trusted = isTrustedDoc(file);
  const forcedByConfig = state.trustAllHtml;
  btn.classList.toggle('is-trusted', trusted);
  btn.setAttribute('aria-pressed', trusted ? 'true' : 'false');
  btn.disabled = forcedByConfig;   // 全局开关打开时，单篇开关没有意义
  const use = btn.querySelector('use');
  if (use) use.setAttribute('href', trusted ? '#i-shield-check' : '#i-shield');
  btn.title = forcedByConfig
    ? '设置里已开启「信任所有本地 HTML」，全部文档都以同源方式预览'
    : trusted
      ? '已信任：以同源方式预览，可用预览内编辑 / 正文高亮 / 快捷键转发。点击撤销'
      : '在沙箱中预览：文档脚本碰不到 Atlas 的数据。点击信任以启用编辑与正文高亮';
}

// 切换信任态。改完必须重新导航一次预览，sandbox 才会真的换挡。
async function toggleTrust(force) {
  const file = state.files[state.activeFilePath];
  if (!file || !isSandboxableType(file)) return false;
  if (state.trustAllHtml) return true;
  const next = force === undefined ? !isTrustedDoc(file) : !!force;
  if (next === isTrustedDoc(file)) return next;
  // 先动本地状态：sandbox 属性要在重新导航之前就位
  if (next) state.trusted.add(file.path);
  else state.trusted.delete(file.path);
  updateTrustButton();
  applyPreviewSandbox(file);
  if (!editState.active) reloadPreviewSandboxed(previewUrlFor(file));
  try {
    const res = await fetch('/api/trust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.path, trusted: next }),
    });
    if (!res.ok) throw new Error('save-failed');
  } catch {
    // 回滚：信任态是安全相关的开关，不能让它只在界面上生效
    if (next) state.trusted.delete(file.path);
    else state.trusted.add(file.path);
    updateTrustButton();
    applyPreviewSandbox(file);
    showToast({ kind: 'error', text: '信任状态没能保存' });
    return !next;
  }
  showToast(next
    ? { kind: 'success', text: '已信任这份文档', secondary: '同源预览，编辑与正文高亮可用' }
    : { kind: 'info', text: '已改回沙箱预览', secondary: '文档脚本碰不到 Atlas 的数据' });
  return next;
}

// 未信任时提示一次就够。每打开一篇 AI 报告都弹一条"正在沙箱里"是纯噪音——
// 沙箱是常态，用户需要知道的是"这件事存在、开关在哪"，不是每次都被通报一遍。
const SANDBOX_HINT_KEY = 'atlas:sandboxHintShown';
function maybeHintSandbox(file) {
  if (!file || !needsSandbox(file)) return;
  try {
    if (localStorage.getItem(SANDBOX_HINT_KEY) === '1') return;
    localStorage.setItem(SANDBOX_HINT_KEY, '1');
  } catch { return; }
  showToast({
    kind: 'info',
    text: 'HTML 默认在沙箱中预览',
    secondary: '文档里的脚本碰不到 Atlas 的数据。需要预览内编辑或正文高亮时，点顶栏的盾牌信任它',
    duration: 7000,
  });
}

// 强制重新导航一次（不复用当前文档）。信任态变化后必须走这条路：
// sandbox 属性只在创建文档的那一刻被读取，给同一个 src 重新赋值不算导航。
function reloadPreviewSandboxed(url) {
  const ifr = els.preview;
  if (!ifr || !url) return;
  ifr.src = 'about:blank';
  requestAnimationFrame(() => { ifr.src = url; });
}

// 重载预览 iframe，使其停在 canonicalUrl 这份文档上。
//
// 不能无脑 contentWindow.location.reload()：iframe 里的文档可能已经把自己的 URL
// 改掉了（预览页注入了 <base href="/raw/…/">，页内脚本 replaceState("#id") 的
// 相对 URL 是按 base 解析的，文档 URL 会变成 /raw/…/ 目录），此时 reload 会去
// GET 一个目录 → Cannot GET /raw/0/xxx/。所以先比对实际地址，跑偏了就重新赋 src。
function reloadPreviewDoc(canonicalUrl) {
  const ifr = els.preview;
  if (!ifr || !canonicalUrl) return;
  const canonical = new URL(canonicalUrl, location.href);
  const reassign = (url) => {
    ifr.src = 'about:blank';
    requestAnimationFrame(() => { ifr.src = url; });
  };
  try {
    const loc = ifr.contentWindow && ifr.contentWindow.location;
    if (!loc) throw new Error('no contentWindow');
    if (loc.pathname !== canonical.pathname || loc.search !== canonical.search) {
      // 保留 hash，重载后仍能定位到原来的章节
      reassign(canonical.pathname + canonical.search + (loc.hash || ''));
    } else {
      // 同一份文档：用 reload 而非 src 重赋值，hash / search 不被重置
      loc.reload();
    }
  } catch {
    // 跨源等拿不到 contentWindow 时只能重新赋 src
    reassign(canonical.href);
  }
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
  const icoName = progress ? 'loader' : (kind === 'success' ? 'check-circle' : kind === 'error' ? 'alert' : 'info');
  t.innerHTML = `
    <span class="toast-icon">${ic(icoName, 15)}</span>
    <div class="toast-msg"></div>
    <button class="toast-close" aria-label="关闭">${ic('x', 13)}</button>
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

// 点击是否落在「关闭」元素上（遮罩、✕ 按钮，或它们内部的图标）。
//
// 必须用 closest() 往上找，不能只看 e.target 自己：✕ 按钮的图标包在
// <span aria-hidden="true"> 里（为了不让屏幕阅读器去读符号本身），点在图标上时
// e.target 是那个 span，它没有 data-close 属性。0.8.0 就是这么把分享弹窗和
// 设置弹窗的关闭按钮弄失效的——按钮点了完全没反应，只能靠遮罩或 Esc 退出。
function isCloseTarget(target, attr = 'data-close') {
  if (!target || typeof target.closest !== 'function') return false;
  return !!target.closest(`[${attr}]`);
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
  // Esc 分级退出链的第 1 级：关闭快速查看浮窗（design §3f）。放在 capture 层最前，
  // 这样 ⌘K 里 Space 打开的浮窗按 Esc 只关浮窗、不连带关掉 ⌘K；
  // 目录树焦点行上按 Esc 也只关浮窗，焦点与 .kbd-focus 留在原行
  if (e.key === 'Escape' && window.AtlasPeek && AtlasPeek.isOpen()) {
    e.preventDefault();
    e.stopPropagation();
    AtlasPeek.close();
    return;
  }
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
// input 模式下的返回值约定：
//   默认            —— 取消、或者清空后确定，都返回 null（调用方多半只想拿到"新名字"）
//   allowEmpty:true —— 取消返回 null，确定返回 trim 后的字符串（可以是空串）
// 后者是"可清空的字段"必需的：标签 / 备注这类东西，用户清空输入框再确定
// 表达的是"删掉它"，和"我不改了"必须能区分开——否则要么点取消把内容清了，
// 要么永远清不掉。
function showDialog({
  title, body, confirmText = '确定', cancelText = '取消', danger = false, input = null,
  allowEmpty = false,
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
      if (isCloseTarget(e.target, 'data-dialog-cancel')) close();
    });
    const confirmValue = () => {
      if (!input) return true;
      const v = inputEl.value.trim();
      return allowEmpty ? v : (v || null);
    };
    okBtn.addEventListener('click', () => finish(confirmValue()));
    cancelBtn.addEventListener('click', close);
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(confirmValue());
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
// 返回 trim 后的字符串，取消 / 空输入返回 null。
// 需要区分"取消"和"清空后确定"时传 allowEmpty:true（确定返回 ''，取消返回 null）
function showPrompt({
  title, body, label, value, placeholder, confirmText = '确定', allowEmpty = false,
} = {}) {
  return showDialog({ title, body, confirmText, allowEmpty, input: { label, value, placeholder } });
}

// ---------- 侧边栏宽度 / 收起 ----------
const SIDEBAR_MIN = 220, SIDEBAR_MAX = 800;
const ANIM_MS = 200;
// 侧栏头放得下「品牌图标 + 操作组」的最窄侧栏宽度（品牌字样此时已由容器查询收起）。
// 桌面版左侧有红绿灯内边距（macOS 26 为 90px），220 时图标会压到操作按钮上，所以按实际内边距现算：
// 浏览器 / 全屏 = 220，桌面 inset 90 ≈ 268。只限制生效宽度，不改用户存的偏好
function sidebarMinWidth() {
  const head = document.querySelector('.sidebar-header');
  const brand = head && head.querySelector('.brand');
  const mark = brand && brand.querySelector('.brand-mark');
  const actions = head && head.querySelector('.actions');
  if (!mark || !actions) return SIDEBAR_MIN;
  // 侧栏头没在布局里（专注模式等）量不出来：返回 null，调用方保持现有宽度，免得按 0 算出 220 把重叠写回去
  if (!mark.offsetWidth || !actions.offsetWidth) return null;
  const hs = getComputedStyle(head), bs = getComputedStyle(brand);
  const px = (v) => parseFloat(v) || 0;
  const need = px(hs.paddingLeft) + px(hs.paddingRight) + px(hs.columnGap)
    + px(bs.marginLeft) + px(bs.paddingLeft) + mark.offsetWidth + px(bs.paddingRight)
    + actions.offsetWidth;
  return Math.max(SIDEBAR_MIN, Math.ceil(need));
}
const savedWidth = parseInt(localStorage.getItem('atlas:sidebarWidth'), 10);
let sidebarPrefW = (savedWidth && savedWidth >= SIDEBAR_MIN && savedWidth <= SIDEBAR_MAX) ? savedWidth : null;
// 偏好宽度按当下的最窄宽度兜底后写进 --sidebar-w；进出全屏（红绿灯内边距变了）时重算
function applySidebarWidth() {
  if (sidebarPrefW == null) return;   // 没存过：用 CSS 默认 320，任何情形都放得下
  const minW = sidebarMinWidth();
  if (minW == null) return;
  document.documentElement.style.setProperty('--sidebar-w', Math.max(minW, sidebarPrefW) + 'px');
}
applySidebarWidth();
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
// 两条调用路径（design §10.3）：
//   用户操作（⌘B、#btn-toggle-sidebar）—— 写 atlas:sidebarCollapsed；在星图里还会清掉
//     「自动收起」标志与提示，离开星图时不再自动改（用户的选择优先）
//   自动（{ auto: true }，进出星图）—— 绝不写 localStorage
function toggleSidebar(force, { auto = false } = {}) {
  const next = typeof force === 'boolean'
    ? force
    : !document.body.classList.contains('sidebar-collapsed');

  if (sidebarAnimTimer) {
    clearTimeout(sidebarAnimTimer);
    sidebarAnimTimer = null;
  }

  document.body.classList.add('sidebar-animating');
  document.body.classList.toggle('sidebar-collapsed', next);
  if (!auto) {
    localStorage.setItem('atlas:sidebarCollapsed', next ? '1' : '0');
    if (state.sidebarAutoCollapsed) state.sidebarAutoCollapsed = false;
    showAutoCollapseNote(false);
  }
  els.btnToggleSidebar.title = next ? '展开侧边栏（⌘B）' : '收起侧边栏（⌘B）';

  sidebarAnimTimer = setTimeout(() => {
    document.body.classList.remove('sidebar-animating');
    sidebarAnimTimer = null;
    window.dispatchEvent(new Event('atlas:sidebar-settled'));
  }, ANIM_MS + 30);
}
els.btnToggleSidebar.addEventListener('click', () => toggleSidebar());

// 主区跟着侧栏：.main 的 margin-left 逐帧过渡（styles.css），内容连续重排。
// 曾经试过"主区只排一次、靠 transform 平移"：重排次数少了，但动画期间主区宽度和终态不一样，
// 居中内容在收起首帧 / 展开末帧会横跳约半个侧栏宽、右侧按钮会滑出窗口（client-fix review #1，
// 实测见 verification §2）。连续重排在首页和预览上的帧数与平移方案相同（主区重排 <1ms），
// 而真正拖慢动画的两处已经单独处理：迷你星图在动画期间不重画（ResizeObserver 去抖到
// atlas:sidebar-settled，画布 object-fit: cover 等比缩放、不拉伸），启动初期的后台任务推迟到静默期之后。

// 拖拽 resizer 调整宽度
// 用 pointer events + setPointerCapture：
// 即使指针被拖出浏览器窗口或在窗口外释放，pointerup/pointercancel 仍会送回 resizer，
// 不会出现 "body.resizing 卡住 → iframe pointer-events:none → 无法滚动" 的 bug。
(function setupResizer() {
  let dragging = false;
  let pointerId = null;
  let pendingW = null;
  let minW = SIDEBAR_MIN;   // 每次按下时现算（全屏与否红绿灯内边距不同）
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
      sidebarPrefW = pendingW;
      localStorage.setItem('atlas:sidebarWidth', String(pendingW));
    }
  }
  els.resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    minW = sidebarMinWidth() ?? SIDEBAR_MIN;
    pointerId = e.pointerId;
    try { els.resizer.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add('resizing');
    els.resizer.classList.add('dragging');
  });
  els.resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pendingW = Math.min(SIDEBAR_MAX, Math.max(minW, e.clientX));
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
// ---------- 筛选快照：所有"命中数"的唯一来源 ----------
// 筛选口径统一（design §13.1）：目录树计数「命中 / 总数」、首页筛选条「命中 n 篇」、
// 待看（= 未读 ∩ 命中），以及之后的星图 HUD / 时间段，都读同一次 fileMatches() 的结果，
// 数字才不会互相打架。render() 每次强制重算一次（一个渲染周期只算这一次），
// 其余读取方按筛选条件 + 数据对象身份命中缓存，不再各自遍历。
// 底栏 #stats 仍是全量「N 篇文档 · M 未读」，它的 N 就是各处「/总数」的分母。
let filterSnap = null;
function filterSnapshotKey() {
  return [
    state.search,
    state.onlyUnread ? 1 : 0,
    [...state.tagFilter].map(t => t.toLowerCase()).sort().join('\u0001'),
    // 时间段：区间本身 + 重算版本（区间不变而命中集合变了——新事件 / 窗口滚动——也要失效）
    state.timeRange ? `${state.timeRange.from}-${state.timeRange.to}-${state.timeRangeVer}` : '',
  ].join('\u0002');
}
function filterSnapshot(force = false) {
  const key = filterSnapshotKey();
  if (!force && filterSnap && filterSnap.key === key
      && filterSnap.files === state.files && filterSnap.contentMatches === state.contentMatches) {
    return filterSnap;
  }
  const all = Object.values(state.files);
  const active = hasActiveFilter();
  const hits = new Set();
  for (const f of all) {
    if (!active || fileMatches(f)) hits.add(f.path);
  }
  filterSnap = {
    key, files: state.files, contentMatches: state.contentMatches,
    active, total: all.length, hits, size: hits.size,
  };
  return filterSnap;
}

// 筛选条件变化后的统一刷新：树、首页（待看 / 筛选条）、计数、两处 chip、排序按钮小字。
// 首页 chip、侧栏菜单 chip、#tag-bar-clear、#tree-filter-note 的「清除」、仅未读、搜索都走这里
function applyFilterChange() {
  render();
  renderTagBar();
  updateStats();
  renderHome();
  updateSortLabel();
}

// 底栏一行说清三件事：一共扫到多少篇、其中多少未读、当前树里正显示多少篇。
// 原来这行挤在 brand 下面（brand-sub），320px 侧栏里总是被截成「804 个文档 · 377 未…」。
// 同时刷新所有读筛选快照的计数（树计数、首页筛选条命中数、树顶筛选提示）。
function updateStats() {
  const total = Object.keys(state.files).length;
  const unread = Object.values(state.files).filter(f => f.unread).length;
  if (els.stats) {
    let html = `${total} 篇文档`
      + (unread > 0 ? ` · <span class="stat-unread">${unread} 未读</span>` : ' · 全部已读');
    // 撞到收录上限：常驻一个警示标记，hover 说清原因与建议
    if (state.indexTruncated) {
      const cap = (state.maxIndexFiles || 0).toLocaleString();
      html += ` · <span class="stat-warn" title="文档数量已达收录上限 ${cap} 篇，超出的未纳入。建议收窄扫描根或在设置里增加忽略项。">⚠ 已达上限</span>`;
    }
    els.stats.innerHTML = html;
    els.stats.title = state.indexTruncated
      ? `已达收录上限：只纳入了约前 ${total.toLocaleString()} 篇（上限 ${(state.maxIndexFiles || 0).toLocaleString()}）。建议收窄扫描根或增加忽略项。`
      : `共 ${total} 篇文档，其中 ${unread} 篇未读`;
  }
  const snap = filterSnapshot();
  if (els.treeCount) {
    // 从筛选快照取数，不能数 DOM 里的 .file——折叠分组懒渲染后它们的文件行根本不在 DOM 里。
    // 未筛选时显示的就是全部；筛选时显示「命中 / 总数」（总数 = #stats 的 N）。
    const shown = snap.active ? snap.size : total;
    els.treeCount.textContent = snap.active ? `${shown}/${total}` : String(total);
    els.treeCount.title = snap.active
      ? `当前筛选命中 ${shown} 篇，共 ${total} 篇`
      : `${total} 篇文档`;
  }
  if (els.tagStripHits) {
    if (snap.active) {
      els.tagStripHits.dataset.hits = String(snap.size);
      els.tagStripHits.innerHTML = `命中 <b>${snap.size}</b> 篇 · 目录树 / 待看 / 星图同步`;
    } else {
      delete els.tagStripHits.dataset.hits;
      els.tagStripHits.textContent = '选中后同时筛选目录树、待看和星图';
    }
  }
  updateTreeFilterNote();
  updateTimeFilterChip();
}

// 树顶筛选提示：标签筛选 / 仅未读生效时说清"树被筛过了"，并给一个「清除」。
// 搜索不在这里提示——搜索框本身就在树的正上方，内容一眼可见。
function updateTreeFilterNote() {
  const el = els.treeFilterNote;
  if (!el) return;
  const tags = [...state.tagFilter];
  const parts = [];
  if (tags.length) parts.push(`已按标签筛选：<b>${tags.map(escapeHtml).join('、')}</b>`);
  if (state.onlyUnread) parts.push('仅看未读');
  if (state.timeRange) parts.push(`时间段 <b>${escapeHtml(AtlasRiver.fmtRange(state.timeRange))}</b>`);
  if (!parts.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `${ic(tags.length ? 'tag' : (state.onlyUnread ? 'mail-open' : 'clock'), 12)}`
    + `<span class="tree-filter-note-text">${parts.join(' · ')}</span>`
    + `<button type="button" class="tree-filter-note-clear" data-act="clear-filter" title="清除提示里列出的筛选（标签 / 仅未读 / 时间段）">清除</button>`;
}
// 清掉树顶提示里列出的筛选（标签 + 仅未读 + 时间段）。搜索不动：它有自己的清除方式（Esc / 清空输入框）
function clearTreeFilters() {
  if (!state.tagFilter.size && !state.onlyUnread && !state.timeRange) return;
  state.tagFilter.clear();
  state.onlyUnread = false;
  if (els.onlyUnread) els.onlyUnread.checked = false;
  if (state.timeRange) setTimeRange(null, { render: false });
  applyFilterChange();
}
// ---------- 首页 ----------
// 「AI 又改了哪些文档」是这个工具存在的理由，首页就直接答这个问题：
// 未读队列按 mtime 倒序，点一行直接进文档。最近 / 收藏同理。
const HOME_LIST_MAX = 7;   // 最近 / 收藏 两条轨道各取前几条
const HOME_FEED_MAX = 8;   // 首页封面墙一屏放几张

// ---------- 真实缩略图（design §3b） ----------
// 服务端用本机 Chrome 系浏览器在后台、断网截图；这里只负责：按需请求、记状态、
// 把 <img class="cover-thumb"> 插到 .cover-art 最底层（生成式封面保留为占位与降级）。
// 当前生效的外观：钉死的主题，或跟随系统时的系统外观。缩略图的主题键只会是 light / dark
function effectiveTheme() {
  const t = forcedTheme();
  if (t) return t;
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  catch { return 'light'; }
}
const THUMB_READY = new Set(['ready', 'stale']);
const THUMBS_MAX_PER_REQUEST = 48;
function thumbItem(path, theme = effectiveTheme()) {
  return state.thumbs.items.get(theme + '|' + path);
}
function thumbUrlFor(path, theme = effectiveTheme()) {
  const it = thumbItem(path, theme);
  if (!it || !THUMB_READY.has(it.status) || !it.k) return null;
  return '/api/thumb?path=' + encodeURIComponent(path) + '&theme=' + theme + '&k=' + it.k;
}
function coverThumbHtml(url) {
  return `<img class="cover-thumb" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">`;
}
// 「需要请求」= 没有条目 / 条目是 stale / 条目记下的 mtime 与当前不同。
// ready / queued / failed / remote-deps / too-large 都不再问
function thumbNeedsRequest(path, theme) {
  const f = state.files[path];
  if (!f) return false;
  const it = thumbItem(path, theme);
  if (!it) return true;
  if (it.status === 'stale') return true;
  return it.mtime !== f.mtime;
}
// 每个调用方（首页封面 / 快速查看）一份去重签名，互不覆盖
const thumbReqSig = new Map();
function requestThumbs(paths, slot = 'home') {
  // 自动化环境闸门：与 View Transitions 同口径。thumbnail.spec 用 __atlasForceThumbs 打开
  if (navigator.webdriver && !window.__atlasForceThumbs) return;
  if (state.thumbs.available === false) return;
  const theme = effectiveTheme();
  const need = paths.filter(p => thumbNeedsRequest(p, theme)).slice(0, THUMBS_MAX_PER_REQUEST);
  if (!need.length) { thumbReqSig.delete(slot); return; }
  const sig = theme + '\n' + need.map(p => p + '@' + state.files[p].mtime).join('\n');
  if (thumbReqSig.get(slot) === sig) return;
  thumbReqSig.set(slot, sig);
  const mtimes = new Map(need.map(p => [p, state.files[p].mtime]));
  fetch('/api/thumbs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: need, theme }),
  }).then(r => (r.ok ? r.json() : null)).then((data) => {
    if (!data) return;
    if (data.available === false) state.thumbs.available = false;
    for (const [p, it] of Object.entries(data.items || {})) {
      if (!it || it.status === 'invalid' || it.status === 'unavailable') continue;
      state.thumbs.items.set(theme + '|' + p, { status: it.status, k: it.k || null, mtime: mtimes.get(p) });
      if (theme === effectiveTheme()) {
        updateCoverThumb(p);
        if (window.AtlasPeek) AtlasPeek.onThumb(p);
      }
    }
  }).catch(() => { thumbReqSig.delete(slot); });
}
// 首页可见封面里需要请求的那部分，renderHome() 之后防抖 300ms 发一次
let thumbReqTimer = null;
function scheduleThumbRequests() {
  clearTimeout(thumbReqTimer);
  thumbReqTimer = setTimeout(() => {
    thumbReqTimer = null;
    if (!els.homeGrid) return;
    const paths = [...els.homeGrid.querySelectorAll('.cover-card[data-path]')].map(el => el.dataset.path);
    requestThumbs(paths, 'home');
  }, 300);
}
// 只更新这一张卡的 <img>，不重渲染首页、不 fetchState
function updateCoverThumb(path) {
  if (!els.homeGrid) return;
  let card = null;
  try { card = els.homeGrid.querySelector(`.cover-card[data-path="${CSS.escape(path)}"]`); } catch { return; }
  const art = card && card.querySelector('.cover-art');
  if (!art) return;
  const url = thumbUrlFor(path);
  const img = art.querySelector('img.cover-thumb');
  if (!url) { if (img) img.remove(); return; }
  if (img && img.getAttribute('src') === url) return;
  if (img) img.remove();
  art.insertAdjacentHTML('afterbegin', coverThumbHtml(url));
}
// 主题变了：可见封面按新主题换图 / 重新请求（签名里含主题，会真的发出去）
function refreshThumbsForTheme() {
  if (!els.homeGrid) return;
  els.homeGrid.querySelectorAll('.cover-card[data-path]').forEach(el => updateCoverThumb(el.dataset.path));
  scheduleThumbRequests();
}
// SSE channel:'thumb'：完成 / 最终失败 / 被挤出队列
function onThumbReady(data) {
  if (!data || !data.path || (data.theme !== 'light' && data.theme !== 'dark')) return;
  const key = data.theme + '|' + data.path;
  if (data.status === 'dropped') {
    // 回到"从未请求过"：下次出现在可见封面 / 快速查看里时会重新请求
    state.thumbs.items.delete(key);
    return;
  }
  const prev = state.thumbs.items.get(key);
  const f = state.files[data.path];
  state.thumbs.items.set(key, {
    status: data.status,
    k: data.k || null,
    mtime: prev ? prev.mtime : (f ? f.mtime : 0),
  });
  if (data.theme === effectiveTheme()) {
    updateCoverThumb(data.path);
    if (window.AtlasPeek) AtlasPeek.onThumb(data.path);
  }
}
// <img> 的 load / error 不冒泡，用 capture 在 document 上统一接
document.addEventListener('load', (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('cover-thumb')) t.classList.add('loaded');
}, true);
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('cover-thumb')) t.remove();
}, true);
// 设置 → 外观「封面」一行的状态说明
function renderThumbsSetting() {
  const el = document.getElementById('thumbs-status');
  if (!el) return;
  const t = state.thumbs;
  if (t.available) el.textContent = `使用本机 ${t.browser || '浏览器'} 生成真实缩略图`;
  else if (t.reason === 'disabled') el.textContent = '已用 ATLAS_THUMBS=off 关闭真实缩略图，使用生成式封面';
  else if (t.reason === 'circuit-open') el.textContent = `暂时无法启动 ${t.browser || '浏览器'}，使用生成式封面（10 分钟后重试）`;
  else if (t.available === false) el.textContent = '未找到 Chrome、Edge 等浏览器，使用生成式封面';
  else el.textContent = '正在检测本机浏览器…';
}

// 封面卡（缩略图还没生成时的兜底）：单色——--bg-elev-2 底 + --text-faint 类型字形。
// 配色收敛（design §10.8）：全界面只有一个品牌强调色，封面不再按项目名哈希色相。
function coverCard(file, i = 0) {
  const name = file.alias || stripDocExt(file.name);
  const fresh = isFreshUnread(file);
  const thumb = thumbUrlFor(file.path);
  return `
    <button class="cover-card${isJustChanged(file.path) ? ' just-changed' : ''}" type="button" style="--i:${i}"
            data-path="${escapeHtml(file.path)}" data-doctype="${docTypeOf(file)}" title="${escapeHtml(file.relPath)}">
      <span class="cover-art" aria-hidden="true">
        ${thumb ? coverThumbHtml(thumb) : ''}
        <span class="cover-glyph">${docTypeIcon(file, 30)}</span>
        <span class="cover-badge">${docTypeBadge(file)}</span>
        ${fresh ? '<span class="cover-fresh"></span>' : ''}
      </span>
      <span class="cover-body">
        <span class="cover-name">${escapeHtml(name)}</span>
        <span class="cover-meta">
          <span class="cover-proj">${escapeHtml(file.projectName || '未分组')}</span>
          <span class="cover-dot"></span>
          <span>${fmtMtime(file.mtime)}</span>
        </span>
      </span>
    </button>`;
}

// 单行（最近 / 收藏 轨道复用）
function homeRow(file) {
  const name = file.alias || stripDocExt(file.name);
  const stale = file.unread && !isFreshUnread(file);
  return `
    <button class="home-row${file.unread ? ' unread' : ''}${stale ? ' stale' : ''}" type="button"
            data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.relPath)}">
      <span class="home-row-dot" aria-hidden="true"></span>
      <span class="home-row-ico">${docTypeIcon(file, 13)}</span>
      <span class="home-row-name">${escapeHtml(name)}</span>
      <span class="home-row-proj">${escapeHtml(file.projectName || '')}</span>
      <span class="home-row-time">${fmtMtime(file.mtime)}</span>
    </button>`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 眉标「今日 · 周X」与旁边的 HH:mm 时钟一起刷新：挂在 60 秒轮询与回前台时，
// 跨过午夜不刷新页面也会翻到新的一天
function updateHomeClock() {
  const d = new Date();
  if (els.homeEyebrow) els.homeEyebrow.textContent = `今日 · ${WEEKDAYS[d.getDay()]}`;
  if (els.homeClock) {
    els.homeClock.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

// 英雄区右栏竖排读数。「近 7 天改动」= 时间河流 7 天内的计数事件总数（日志事件 + mtime 兜底），
// 与河流卡片头、#home-river-sum 共用同一次 riverTotals()；活动日志不可用时三处都按 mtime 兜底，
// 这一格带「仅修改时间」小标签
function homeReadoutsHtml({ total, projects, unread, week, weekFallback }) {
  const row = (k, v, extra = '', cls = '') =>
    `<div class="home-readout${cls}" role="listitem"><span class="home-readout-k">${k}${extra}</span><span class="home-readout-v">${v.toLocaleString()}</span></div>`;
  return row('文档', total)
    + row('项目', projects)
    + row('未读', unread, '', unread ? ' is-unread' : '')
    + row('近 7 天改动', week, weekFallback
      ? '<span class="home-readout-tag" title="活动日志暂不可用，按每篇文档的修改时间推断">仅修改时间</span>' : '', ' is-signal');
}

// 首页底部两条轨道（最近打开 / 收藏）。renderRecent / renderFavorites 也走这里：
// 侧栏的收藏 / 最近块移除后（design §11.B1），这两份数据只在首页轨道与 ⌘K 空状态里出现
function renderHomeRails() {
  if (!els.homeRecent) return;
  if (!Object.keys(state.files).length) {
    els.homeRecent.innerHTML = '';
    if (els.homeRecentClear) els.homeRecentClear.classList.add('hidden');
    if (els.homeFavRail) els.homeFavRail.classList.add('hidden');
    return;
  }
  // 最近打开
  const recentAll = (state.recent || []).filter(p => state.files[p]);
  const recent = recentAll.slice(0, HOME_LIST_MAX);
  if (els.homeRecentClear) els.homeRecentClear.classList.toggle('hidden', recentAll.length === 0);
  els.homeRecent.innerHTML = recent.length
    ? recent.map(p => homeRow(state.files[p])).join('')
    : homeEmpty({
        icon: 'clock',
        title: '还没有浏览记录',
        hint: '打开过的文档会集中在这里',
        action: { label: '快速打开', icon: 'search', kbd: '⌘K', attr: 'data-open-quickopen' },
      });

  // 收藏（没有收藏就整条轨道不出现，不占版面）
  const favs = (state.favorites || []).filter(p => state.files[p]).slice(0, HOME_LIST_MAX);
  if (els.homeFavRail) els.homeFavRail.classList.toggle('hidden', favs.length === 0);
  if (els.homeFav) els.homeFav.innerHTML = favs.length ? favs.map(p => homeRow(state.files[p])).join('') : '';
}

function renderHome() {
  if (!els.homeGrid) return;
  const all = Object.values(state.files);
  const total = all.length;

  updateHomeClock();

  if (total === 0) {
    els.homeHeroLine.textContent = '还没有文档';
    els.homeSub.textContent = '到 ⚙ 设置里加一个扫描根目录，Atlas 就会把里面的 HTML / Markdown 都收进来。';
    if (els.homeChips) els.homeChips.innerHTML = '';
    if (els.homeReadouts) {
      els.homeReadouts.innerHTML = homeReadoutsHtml({
        total: 0, projects: 0, unread: 0, week: 0, weekFallback: riverState.failed,
      });
    }
    renderRiverCard();
    setFeedTimeMode(false);
    els.homeFeedCount.textContent = '';
    if (els.homeFeedHint) els.homeFeedHint.textContent = '';
    els.homeGrid.innerHTML = homeEmpty({
      icon: 'search', title: '空空如也', hint: '添加扫描根目录后，文档会出现在这里',
    });
    renderHomeRails();
    renderMinimap();
    return;
  }

  const unread = all.filter(f => f.unread).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const projects = new Set(all.map(f => f.projectName).filter(Boolean));
  // 「今天改过」才是这个 dashboard 真正要回答的问题（"AI 刚动了什么"）。
  // 红色只留给这个 24h 窗口内的数字——几百篇常亮未读不是警报，是背景噪音。
  const fresh = unread.filter(isFreshUnread);

  // 英雄标题：数字（喷品牌渐变）是句子的一部分，而不是一格格仪表
  if (fresh.length) {
    els.homeHeroLine.innerHTML = `今天 AI 改了 <span class="n">${fresh.length}</span> 篇文档`;
    els.homeSub.textContent = unread.length > fresh.length
      ? `另有 ${unread.length - fresh.length} 篇更早的还没看`
      : '点开封面即可查看，看完自动清除未读标记';
  } else if (unread.length) {
    els.homeHeroLine.innerHTML = `还有 <span class="n">${unread.length}</span> 篇待看`;
    els.homeSub.textContent = '今天没有新变动，慢慢看';
  } else {
    els.homeHeroLine.innerHTML = `全部 <span class="n calm">${total}</span> 篇都看过了`;
    els.homeSub.textContent = 'AI 一有更新，这里就会重新排起队';
  }

  // 统计 chips：数字放大、单位轻描，比原来的四个大方块克制
  if (els.homeChips) {
    els.homeChips.innerHTML = [
      { k: '文档', v: total },
      { k: '项目', v: projects.size },
      { k: '待看', v: unread.length },
    ].map(c => `<span class="home-chip"><b>${c.v}</b>${c.k}</span>`).join('');
  }

  // 竖排读数（文档 / 项目 / 未读 / 近 7 天改动）：全量口径，不随筛选变化。
  // 「近 7 天改动」与河流卡片同一次 riverTotals()
  const river = ensureRiverModel();
  if (els.homeReadouts) {
    els.homeReadouts.innerHTML = homeReadoutsHtml({
      total, projects: projects.size, unread: unread.length,
      week: river.totals.total, weekFallback: riverState.failed,
    });
  }
  renderRiverCard();

  // 封面墙：有时间段筛选时切成「该时段改动的文档」，否则是待看（未读）
  const snap = filterSnapshot();
  if (state.timeRange) renderHomeTimeFeed(snap);
  else renderHomeUnreadFeed(snap, unread);

  renderHomeRails();
  renderMinimap();
  // 从缓存里同步出来的 <img> 可能在监听前就已加载完
  els.homeGrid.querySelectorAll('img.cover-thumb').forEach((img) => {
    if (img.complete && img.naturalWidth) img.classList.add('loaded');
  });
  scheduleThumbRequests();
}
// 待看：封面图卡墙。有筛选时 = 未读 ∩ 筛选命中（与目录树同一次 filterSnapshot），
// 计数后注明按什么筛的；无筛选时与过去完全一致
function renderHomeUnreadFeed(snap, unread) {
  setFeedTimeMode(false);
  const feed = snap.active ? unread.filter(f => snap.hits.has(f.path)) : unread;
  const why = [];
  if (snap.active) {
    if (state.tagFilter.size) why.push(`已按标签「${[...state.tagFilter].join('、')}」筛选`);
    if (state.search) why.push(`已按搜索「${state.search}」筛选`);
  }
  els.homeFeedCount.textContent = (feed.length || snap.active ? String(feed.length) : '')
    + (why.length ? ' · ' + why.join(' · ') : '');
  if (feed.length) {
    if (els.homeFeedHint) {
      els.homeFeedHint.textContent = feed.length > HOME_FEED_MAX ? '在侧栏排序菜单里勾选「仅未读」看全部' : '';
    }
    els.homeGrid.innerHTML = feed.slice(0, HOME_FEED_MAX).map((f, i) => coverCard(f, i)).join('');
  } else if (snap.active && unread.length) {
    if (els.homeFeedHint) els.homeFeedHint.textContent = '';
    els.homeGrid.innerHTML = homeEmpty({
      icon: 'search', title: '当前筛选下没有未读文档', hint: '清除筛选后可以看到全部待看',
    });
  } else {
    if (els.homeFeedHint) els.homeFeedHint.textContent = '';
    els.homeGrid.innerHTML = `<div class="home-cheer">
      <span class="home-cheer-badge">${ic('check', 24)}</span>
      <span class="home-cheer-title">收件箱清空了</span>
      <span class="home-cheer-hint">没有未读文档，AI 一更新就会回到这里</span>
    </div>`;
  }
}
// 首页卡片的空状态。
// 三件套：图标 + 一句"这里为什么是空的" + 一个能立刻做点什么的按钮。
// 原来是一行灰色小字顶在卡片里，既没解释也没出路，还让左右两张卡片高度差一大截。
function homeEmpty({ icon, title, hint, action }) {
  return `<div class="home-empty">
    <span class="home-empty-ico">${ic(icon, 18)}</span>
    <span class="home-empty-title">${escapeHtml(title)}</span>
    ${hint ? `<span class="home-empty-hint">${escapeHtml(hint)}</span>` : ''}
    ${action ? `<button class="home-empty-act" type="button" ${action.attr}>
      ${ic(action.icon, 12)}<span>${escapeHtml(action.label)}</span>
      ${action.kbd ? `<kbd>${escapeHtml(action.kbd)}</kbd>` : ''}
    </button>` : ''}
  </div>`;
}

// 事件委托：首页的行是动态渲染的，挂在容器上一次就够
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('[data-open-quickopen]')) {
    openQuickOpen();
    return;
  }
  const row = e.target.closest && e.target.closest('.home-row, .cover-card');
  if (row && row.dataset.path) openFile(row.dataset.path);
});

// ---------- View Transitions：页面级切换的唯一入口 ----------
// 整个仓库只有这里调 document.startViewTransition。kind 决定 CSS 走哪套场景规则
// （styles.css「运动需授权」段，按 :root[data-vt] / [data-vt-dir] 分场景）：
//   'home' —— 回首页 / 从首页进文档：整体交叉淡入
//   'tab'  —— 切标签：只有 .preview 做方向性滑移（dir: 'fwd' | 'back'）
//   'view' —— 首页封面墙 ↔ 星图：只作用于主区
// 降级规则（命中任一条就直接同步执行 fn，DOM 结果完全一致，只是没有过渡）：
//   1. 浏览器没有 startViewTransition
//   2. reduced-motion（系统偏好或设置里的「界面动效：减少」）
//   3. 上一次过渡还没结束、或距上次调用 < 150ms（连切时一张张慢慢滑只会拖手）——
//      顺手 skipTransition() 掉进行中的那次
//   4. 拖拽中 / 行内编辑中 / 编辑器打开：快照期间 DOM 冻结一帧，会打乱 Sortable 落点与光标
//   5. startViewTransition 抛错
//   6. 自动化环境（navigator.webdriver，Playwright 即如此）且未设 window.__atlasForceVT：
//      VT 的更新回调是异步的，大量 spec "点完立刻读 DOM" 的写法依赖同步时序
// 被后一次切换取代的回调不再执行（"最后一次切换为准"）：skipTransition 后浏览器
// 仍会异步调用旧回调，若照常执行会把状态拨回上一个 Tab。
const VT_MIN_GAP_MS = 150;
let vtActive = null;     // 进行中的 ViewTransition
let vtLastAt = -Infinity;
let vtSeq = 0;           // 每次切换 +1，回调执行前比对，过期的不执行
function withViewTransition(fn, kind = 'home', dir) {
  const now = performance.now();
  const tooSoon = now - vtLastAt < VT_MIN_GAP_MS;
  vtLastAt = now;
  const seq = ++vtSeq;
  const root = document.documentElement;
  const direct = () => {
    if (vtActive) { try { vtActive.skipTransition(); } catch {} }
    fn();
  };
  if (typeof document.startViewTransition !== 'function') return direct();
  if (prefersReducedMotion()) return direct();
  if (navigator.webdriver === true && !window.__atlasForceVT) return direct();
  if (vtActive || tooSoon) return direct();
  if (isDragging || isInlineEditing() || editState.active) return direct();

  root.dataset.vt = kind;
  if (dir) root.dataset.vtDir = dir; else delete root.dataset.vtDir;
  let t;
  try {
    t = document.startViewTransition(() => { if (seq === vtSeq) fn(); });
  } catch {
    delete root.dataset.vt; delete root.dataset.vtDir;
    fn();
    return;
  }
  vtActive = t;
  // 被 skip 时 ready / updateCallbackDone 会 reject，吞掉，免得刷屏 unhandled rejection
  if (t.ready) t.ready.catch(() => {});
  if (t.updateCallbackDone) t.updateCallbackDone.catch((e) => console.error(e));
  const done = () => {
    if (vtActive === t) vtActive = null;
    // 之后没有新的过渡接手时才清属性（新过渡已经写了自己的 kind）
    if (!vtActive) { delete root.dataset.vt; delete root.dataset.vtDir; }
  };
  t.finished.then(done, done);
}

// ---------- 工具 ----------
// 「新鲜的未读」= 24h 内被改动过。侧栏文件行的未读点与粗体、分组未读点、
// 首页 KPI 的「今天改过」和待看队列里的点，全部共用这一个窗口——
// 只有稀缺的红色才是警报，几百个常亮未读点等于没有信号。
function isFreshUnread(file) {
  const FRESH_WINDOW_MS = 86_400_000;
  return !!(file && file.unread && (Date.now() - (file.mtime || 0)) < FRESH_WINDOW_MS);
}

// ---------- 「AI 刚改过」：state.justChanged ----------
// SSE 收到非 Atlas 自写的 add / change 时登记；JUST_CHANGED_MS 内侧栏行与首页封面带
// .just-changed（只追加类名，不改结构）。到期清理用一个共享 setTimeout，按最早到期时刻排程。
function isJustChanged(p) {
  const t = state.justChanged.get(p);
  return t != null && Date.now() - t < JUST_CHANGED_MS;
}
// 同一路径的侧栏行 / 封面卡（目录视图与分组视图里各自只有一行；首页可能同时在两处出现）
function justChangedEls(p) {
  const sel = `.file[data-path="${CSS.escape(p)}"], .cover-card[data-path="${CSS.escape(p)}"]`;
  return document.querySelectorAll(sel);
}
let justChangedTimer = null;
function scheduleJustChangedSweep() {
  if (justChangedTimer) { clearTimeout(justChangedTimer); justChangedTimer = null; }
  if (!state.justChanged.size) return;
  const earliest = Math.min(...state.justChanged.values());
  const wait = Math.max(0, earliest + JUST_CHANGED_MS - Date.now()) + 20;
  justChangedTimer = setTimeout(() => {
    justChangedTimer = null;
    const now = Date.now();
    for (const [p, t] of [...state.justChanged]) {
      if (now - t < JUST_CHANGED_MS) continue;
      state.justChanged.delete(p);
      jcVersion++;
      // 只重渲染受影响的行：摘掉类名即可，不必整树重建
      justChangedEls(p).forEach(el => el.classList.remove('just-changed'));
    }
    if (starmapVisible()) refreshStarmap();
    scheduleJustChangedSweep();
  }, wait);
}
// 刚变更集合的版本号：星图据此判断要不要把 flags 重新推一遍
let jcVersion = 0;
function markJustChanged(p) {
  if (!p) return;
  state.justChanged.set(p, Date.now());
  jcVersion++;
  // 已在屏上的行立刻挂上（随后 fetchState 的整树重建也会按 state.justChanged 带上）。
  // 先摘再挂，让同一行 90 秒内第二次被改时轻闪重新开始
  justChangedEls(p).forEach(el => {
    el.classList.remove('just-changed');
    void el.offsetWidth;
    el.classList.add('just-changed');
  });
  scheduleJustChangedSweep();
}
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
  // 同年省掉年份：侧栏每一行都顶着一个 "2026-" 是纯噪音，而且那 28px
  // 正是文件名被截断成 `01-user-segment-and...` 缺的宽度。
  if (y === new Date().getFullYear()) return `${mo}-${da}`;
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

// /api/state 响应体的轻量签名。/api/state 被 60s 定时轮询 + 每个文件事件(SSE)
// 频繁触发，但多数时候数据一字未变，却仍会 innerHTML='' 重建整棵树 —— 大扫描根
// (上万文件)下每次重建同步创建数千 DOM 节点 + 数万监听器，是持续掉帧的来源。
// 用完整响应体做签名：逐字节相同 ⇒ 渲染结果必然相同(不存在"漏了某个字段"的风险)，
// 直接跳过整树重渲染。数据真变了签名就不同，照常重建。
let lastStateSig = null;
let indexTruncationNotified = false;   // 收录上限提示本会话只弹一次
function stateSignature(text) {
  // djb2：对几百 KB 文本足够快，碰撞最坏也只是多重建一次，无正确性影响
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return text.length + ':' + h;
}

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
    const bodyText = await res.text();
    const data = JSON.parse(bodyText);
    stateRetryDelay = 1000;
    stateFailed = false;
    // 两种情况下不能拿服务端的树覆盖内存，其余字段照常更新：
    //   ① 有还没落盘的树改动——服务端还没收到，它返回的树上是旧的分组名 /
    //      旧的顺序，覆盖下去用户刚做的操作就没了（紧接着那次 PUT 还会把旧值
    //      正式写回磁盘）。
    //   ② 正在行内重命名——此刻替换整棵树会让重命名回调持有的那个 folder
    //      变成游离对象，提交的新名字进不了将要保存的树。
    if (!hasPendingTreeWrite() && !isInlineEditing()) {
      state.tree = data.tree;
    }
    state.files = data.files;
    state.recent = Array.isArray(data.recent) ? data.recent : [];
    state.favorites = Array.isArray(data.favorites) ? data.favorites : [];
    state.allTags = Array.isArray(data.allTags) ? data.allTags : [];
    // 标签可能在别处被删掉了（比如另一个标签页清空了它），把已失效的筛选撤掉，
    // 否则树里一片空白而筛选条上没有 chip 可点，看起来像文档全丢了
    const liveTags = new Set(state.allTags.map(t => t.name.toLowerCase()));
    for (const t of [...state.tagFilter]) {
      if (!liveTags.has(t.toLowerCase())) state.tagFilter.delete(t);
    }
    state.archivedProjects = Array.isArray(data.archivedProjects) ? data.archivedProjects : [];
    state.trusted = new Set(Array.isArray(data.trusted) ? data.trusted : []);
    state.trustAllHtml = !!data.trustAllHtml;
    // 缩略图能力：一旦为 false，本会话不再请求（不是错误，是环境能力差异）
    {
      const t = data.thumbs || { available: false };
      if (state.thumbs.available !== false) state.thumbs.available = !!t.available;
      state.thumbs.browser = t.browser || null;
      state.thumbs.reason = t.reason || null;
    }
    renderThumbsSetting();
    // 索引护栏：撞到收录上限时，底栏常驻一个「已达上限」标记（见 updateStats），
    // 本会话首次出现再额外弹一次 toast 说清原因与建议。
    state.indexTruncated = !!data.indexTruncated;
    state.indexCount = data.indexCount || 0;
    state.maxIndexFiles = data.maxIndexFiles || 0;
    if (state.indexTruncated && !indexTruncationNotified) {
      indexTruncationNotified = true;
      showToast({
        kind: 'info',
        text: '文档数量已达收录上限',
        secondary: `已收录约 ${state.indexCount.toLocaleString()} 篇，超出的暂未纳入。建议把扫描根收窄到更具体的目录，或在设置里增加"忽略的目录名"。`,
        duration: 6500,
      });
    }
    setSaveStatus('idle');
    // 响应体与上次逐字节相同 → 树/首页/侧栏渲染结果必然一致，跳过整树重建。
    // filter/search/collapsed 的变化走各自的代码路径（会各自 render），不经过
    // 这里；fetchState 本身不改动这些状态，所以数据不变时跳过是安全的。
    const sig = stateSignature(bodyText);
    const unchanged = sig === lastStateSig;
    lastStateSig = sig;
    // 这次扫描后消失的文档（被归档 / 磁盘上被删 / 改了扫描类型）：把对应的 Tab 关掉。
    // 不做的话那个 Tab 的帧会一直挂着一篇已经不在看板里的文档，点刷新 / 分享 / 导出
    // 全是 404，而侧栏里已经找不到它了。若关掉的是活动 Tab，pruneDeadTabs 会自动
    // 激活邻居或回首页；草稿由 exitEditMode 落到本地，没什么可保存的。
    pruneDeadTabs();
    // 首次拿到文件列表后，恢复上次打开的 Tab（只此一次）
    restoreTabs();
    // 数据无变化则跳过所有重渲染（大树下这是持续掉帧的主因）。首次(lastStateSig
    // 曾为 null，unchanged=false)与每次真实变化都照常重建。
    // 时间段筛选（FEAT-005）：文件变了或 60 秒那一拍跨了整点 → 在渲染之前重算一次，
    // 之后只渲染一次（design-review NIT 1）
    const needRecompute = (!unchanged && !!state.timeRange) || pendingHourRecompute;
    if (needRecompute) {
      pendingHourRecompute = false;
      recomputeTimeRange({ render: false });
    }
    stateLoaded = true;
    if (!unchanged || needRecompute) {
      renderTagBar();
      render();
      renderRecent();
      renderFavorites();
      updateStats();
      renderHome();
      updateFavButton();
    }
    // 对比面板开着的时候，如果当前文件在磁盘上又被改了，自动刷新差异
    if (diffState.open && diffState.path) {
      const f = state.files[diffState.path];
      if (f && f.mtime !== diffState.mtime) loadDiff();
    }
  } catch (e) {
    // 被后来的请求主动取代：不是故障，静默退场（重试由接替者负责；
    // pendingHourRecompute 留给接替的那次请求）
    if (ctrl.superseded) return;
    console.error(e);
    setSaveStatus('error');
    // 拉取失败但这一拍跨了整点：时间段照样按现有数据重算（单独一次）
    if (pendingHourRecompute) {
      pendingHourRecompute = false;
      recomputeTimeRange();
    }
    stateFailed = true;
    // 作废渲染签名：错误态下 stats 被改成了"加载超时…"，并未正常渲染。若不作废，
    // 重试成功时数据可能与失败前一致(unchanged=true)从而跳过重渲染，stats 会停在
    // 错误文案上。置空后，恢复后的第一次成功必然重渲染，把 UI 拉回正常态。
    lastStateSig = null;
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
let pendingTree = null;      // 已排程、还没发出去的树快照
let treeSaveInFlight = 0;    // 正在飞的 PUT /api/tree 数量

// 是否有还没安全落盘的树改动。fetchState 用它决定要不要接受服务端的树
// （见 fetchState 里的说明）
function hasPendingTreeWrite() {
  return !!saveTimer || pendingTree !== null || treeSaveInFlight > 0;
}

function scheduleSaveTree() {
  // 关键：排程的同时就把树快照下来。
  // 原来是等 250ms 后在定时器里现取 state.tree —— 而这 250ms 里任何一次
  // fetchState 返回都会把 state.tree 整体换成服务端的版本（那上面还是旧名字，
  // 因为改动还没发出去），于是自己的保存请求把自己的改动覆盖掉了，
  // 界面上却显示"已保存"。这就是分组改名偶发丢失的前端那一半原因。
  pendingTree = JSON.parse(JSON.stringify(state.tree));
  if (saveTimer) clearTimeout(saveTimer);
  setSaveStatus('saving');
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const body = pendingTree;
    pendingTree = null;
    treeSaveInFlight++;
    try {
      const res = await fetch('/api/tree', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tree: body }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      setSaveStatus('idle');
    } catch (e) {
      console.error(e);
      setSaveStatus('error');
    } finally {
      treeSaveInFlight--;
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

// 文件是否带齐了所有被选中的筛选标签（AND）。
// 比较按小写：服务端保留用户输入的大小写写法，但 "AI" 与 "ai" 视为同一个标签
function matchesTagFilter(file) {
  if (!state.tagFilter.size) return true;
  const owned = new Set((file.tags || []).map(t => String(t).toLowerCase()));
  for (const t of state.tagFilter) {
    if (!owned.has(t.toLowerCase())) return false;
  }
  return true;
}

// 是否存在任何"会让部分文件从树里消失"的筛选。render / renderFolder 都要用它做守卫：
// 没有任何筛选时直接跳过 nodeMatches，几百篇文档下省掉一次全树递归
function hasActiveFilter() {
  return !!state.search || state.onlyUnread || state.tagFilter.size > 0 || !!state.timeRange;
}

function fileMatches(file) {
  // 时间河流的时间段：区间内有计数事件的文档（state.timeRangePaths 由 recomputeTimeRange 预先算好）
  if (state.timeRange && !state.timeRangePaths.has(file.path)) return false;
  if (state.onlyUnread && !file.unread) return false;
  if (!matchesTagFilter(file)) return false;
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
  if (node.type === 'file') {
    const f = state.files[node.path];
    const unread = f && f.unread ? 1 : 0;
    // 分组未读点靠 fresh 决定用饱和红还是灰（见 .folder-unread-dot.stale）：
    // 一个分组里全是几个月前的旧未读时，它不该和"AI 刚刚动过这里"长得一样。
    return { files: 1, unread, fresh: isFreshUnread(f) ? 1 : 0 };
  }
  let files = 0, unread = 0, fresh = 0;
  for (const c of node.children) {
    const r = countDescendants(c);
    files += r.files;
    unread += r.unread;
    fresh += r.fresh;
  }
  return { files, unread, fresh };
}

// ---------- 目录视图：按磁盘真实层级即时构建多级树 ----------
// 只读镜像，不写 store：从 state.files 的 relPath 逐段建 folder 节点，末端挂 file。
// 节点结构和虚拟分组树完全一致（type: 'folder' | 'file'），所以 renderNode /
// countDescendants / nodeMatches / sortChildren 全部原样复用。目录 folder 用
// kind:'dir' 标记，renderFolder 据此只给它折叠 + 「在访达中显示」，不给重命名 /
// 删除 / 新建子分组（那些只对虚拟分组有意义）。
//
// folder.id 用稳定的 'dir:<rootIndex>/<相对目录>' —— 和虚拟分组的 'f-xxxx' 不会撞，
// 所以折叠状态（state.collapsed）在两个视图间各记各的、互不干扰。
function buildDirTree() {
  const files = Object.values(state.files || {});
  // 只扫到一个根时，顶层直接是根下的第一级目录 / 散落文件；扫到多个根时，
  // 顶层先按根分一层（用根目录名），避免不同根下的同名目录混在一起。
  const multiRoot = new Set(files.map(f => f.rootIndex)).size > 1;
  const rootNodes = [];
  const dirIndex = new Map();   // id → folder 节点

  const mkDir = (id, name, dirPath, container) => {
    let node = dirIndex.get(id);
    if (!node) {
      node = { id, type: 'folder', kind: 'dir', name, dirPath, collapsed: false, children: [] };
      dirIndex.set(id, node);
      container.push(node);
    }
    return node;
  };

  for (const f of files) {
    const sep = f.path.includes('\\') ? '\\' : '/';
    const rel = f.relPath || f.name;
    const segs = rel.split(/[\\/]/).filter(Boolean);
    // 根的绝对路径 = 绝对路径去掉相对路径尾巴（含尾部分隔符）
    let curAbs = f.path.slice(0, Math.max(0, f.path.length - rel.length)).replace(/[\\/]+$/, '');
    let container = rootNodes;
    let idKey = 'dir:' + f.rootIndex;

    if (multiRoot) {
      const rootName = curAbs.split(/[\\/]/).filter(Boolean).pop() || curAbs;
      const rootFolder = mkDir(idKey + ':@root', rootName, curAbs, container);
      container = rootFolder.children;
    }

    // 中间目录（不含最后一段文件名）逐级建 folder
    for (let i = 0; i < segs.length - 1; i++) {
      curAbs = curAbs + sep + segs[i];
      idKey = idKey + '/' + segs[i];
      const df = mkDir(idKey, segs[i], curAbs, container);
      container = df.children;
    }
    container.push({ type: 'file', path: f.path });
  }
  return rootNodes;
}

// 当前视图要渲染的顶层节点：目录视图用即时构建的目录树（并缓存到 state.dirTree），
// 分组视图用持久化的 store.tree
function currentTreeData() {
  if (listViewMode() === 'tree') {
    state.dirTree = buildDirTree();
    return state.dirTree;
  }
  return state.tree;
}

// ---------- 渲染 ----------
// 树里是否有正在进行的行内重命名（分组名 / 备注名）
function isInlineEditing() {
  return !!els.tree.querySelector('[contenteditable="true"]');
}
let renderSkippedDuringEdit = false;
let renderSkippedDuringDrag = false;

function render() {
  // 正在重命名时不要重建树。render() 第一件事就是 innerHTML=''，会把用户
  // 正在输入的那个 contenteditable 节点直接摘掉；而浏览器移除聚焦元素并不会
  // 触发 blur，于是提交回调根本不执行，刚敲进去的名字静默消失。
  // 跳过的这次渲染在编辑结束时补上（见 startInlineEdit 的 finish）。
  if (isInlineEditing()) { renderSkippedDuringEdit = true; return; }
  renderSkippedDuringEdit = false;
  // 【幽灵残影根治】拖拽途中同样不能重建树，原因与上面同类但后果更脏。
  //
  // 现象：侧栏里出现浮在页面上、盖住其它内容的"幽灵分组名 / 文件名"——叠在文件行上、
  // 折叠侧边栏后仍浮着、甚至跨到右侧文档「目录」面板上，反复操作越积越多。
  //
  // 根因：树的 Sortable 用 forceFallback + fallbackOnBody，拖拽时会把被拖节点克隆一份
  // 挂到 document.body 上（position:fixed、z-index:100000）跟着指针走，正常松手时由
  // SortableJS 自己移除。但 render() 会 innerHTML='' 清空整棵树、并在末尾 initSortables()
  // → destroySortables() 销毁实例：被拖的那个元素和它的 Sortable 实例双双消失，松手时
  // 收尾逻辑再也跑不到，那个 fixed 克隆就永久孤立在 body 上 —— 它不在 .sidebar 里，
  // 所以折叠侧边栏也带不走它；每被打断一次就多留一个，于是"越积越多"。
  // 触发频率很高：SSE 文件事件与 60s 轮询都会 fetchState → render，AI 持续写文件时
  // 拖拽过程中撞上一次几乎是必然。
  //
  // 治法：拖拽期间直接跳过整树重建（本处），跳过的这次在拖拽结束时补上（见 onEnd）；
  // 另外 destroySortables 兜底清扫可能已被孤立的克隆（见 sweepDragArtifacts）。
  if (isDragging) { renderSkippedDuringDrag = true; return; }
  renderSkippedDuringDrag = false;
  // 一个渲染周期只算一次筛选命中集合：树计数、首页筛选条、待看都读这一份
  filterSnapshot(true);
  bindTreeIconHydration();   // 幂等，只在首次真正绑定
  els.tree.innerHTML = '';
  // 目录视图（只读、无拖拽）给树容器打标：CSS 据此对 .folder 加 layout containment，
  // 让展开 / 折叠时下方兄弟节点只需整体平移、不必深度重排。分组视图不加（拖拽依赖正常布局）。
  els.tree.classList.toggle('tree-view-mode', listViewMode() === 'tree');
  const filtering = hasActiveFilter();
  const nodes = currentTreeData();
  for (const node of nodes) {
    if (filtering) {
      if (!nodeMatches(node)) continue;
    }
    els.tree.appendChild(renderNode(node));
  }
  // 拖拽重排只对虚拟分组有意义；目录视图是磁盘的只读镜像，不挂 Sortable。
  if (listViewMode() === 'tree') destroySortables();
  else initSortables();
  updateCollapseAllBtn();
  scheduleStuckHeader();
  if (state.activeFilePath && state.files[state.activeFilePath]) {
    setActiveFile(state.activeFilePath, false);
  }
  // 树刚按新快照重建：计数（树头 / 首页筛选条 / 树顶提示）同步刷新，免得各处数字不一致
  updateStats();
  // 星图（可见时）跟着同一次筛选快照刷新：命中编码、HUD、星表、筛选状态条
  if (starmapVisible()) refreshStarmap();
  // 快速查看的触发行被换掉了：键盘模式下重新定位到同一路径的新行，否则关闭
  if (window.AtlasPeek) AtlasPeek.reanchor();
}

// ⌘K 开着且输入为空时，它的「最近打开 / 收藏」分段读的是同一份数据，跟着重画
function refreshQuickOpenIfEmpty() {
  if (qoEntry && qoEls.input && !qoEls.input.value.trim()) {
    const keep = qoActive;
    qoRender();
    if (keep) qoSetActive(Math.min(keep, qoResults.length - 1));
  }
}

// 最近打开：侧栏的「最近」块已移除（design §11.B1），数据只在首页轨道与 ⌘K 空状态里出现。
// 函数名与调用点保留（openFile / goHome / fetchState 都在调），只换挂载点。
function renderRecent() {
  renderHomeRails();
  refreshQuickOpenIfEmpty();
}

// 清除最近浏览记录。只清 store.recent 这一份列表——已读状态、收藏、标签都不动：
// 用户点这个按钮想的是"别让列表一直摆着我看过什么"，不是"把阅读状态重置"。
// 先本地清、再打后端，失败就把列表原样放回去（这是个不可撤销的动作，
// 一次没成功却看着像成功了，比慢半拍难受得多）。
// 入口两个：⌘K 空状态「最近打开」段头的 #recent-clear、首页轨道头的 #home-recent-clear。
async function clearRecent() {
  const count = (state.recent || []).filter(p => !!state.files[p]).length;
  if (count === 0) return;
  const ok = await showConfirm({
    title: '清除最近浏览记录？',
    body: `列表里的 ${count} 条记录会被清空，无法恢复。\n文档本身、未读标记和收藏都不受影响。`,
    confirmText: '清除',
    danger: true,
  });
  if (!ok) return;
  const backup = (state.recent || []).slice();
  state.recent = [];
  renderRecent();
  renderHome();   // 首页那张「最近打开」卡片同一份数据，得一起变
  // 从 ⌘K 段头点的「清除」：按钮随重画消失了，焦点还回输入框，面板继续可用
  if (qoEntry && qoEls.input) qoEls.input.focus();
  try {
    const r = await fetch('/api/recent/clear', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    showToast({ kind: 'success', text: '已清除最近浏览记录' });
  } catch (e) {
    state.recent = backup;
    renderRecent();
    renderHome();
    showToast({ kind: 'error', text: '清除失败', secondary: e.message });
  }
}

// ---------- 收藏夹 ----------
// 跨文件夹的平铺列表：收藏的意义就是把散落在各个分组里的常看文档聚到一处。
// 侧栏收藏块已移除（design §11.B1），改由首页「收藏」轨道 + ⌘K 空状态「收藏」段提供；
// 当前文档用顶栏星标 #btn-favorite。函数名保留，数据逻辑不变（服务端已按收藏时间倒序）。
function renderFavorites() {
  renderHomeRails();
  refreshQuickOpenIfEmpty();
}

// ---------- 标签筛选 chip ----------
// 同一份 chip 渲染进两处：首页顶部筛选条 #tag-bar、侧栏排序菜单的 #sort-menu-tags。
// 两处与 #tag-bar-clear、树顶 #tree-filter-note 的「清除」读写同一个 state.tagFilter。
// 没有任何标签时首页筛选条整条隐藏、菜单里那一段也隐藏。
function tagChipEl({ name, count }, on) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tag-chip' + (on ? ' on' : '');
  // aria-pressed 而不是 aria-checked：这是一组可独立开关的过滤开关，不是单选项
  btn.setAttribute('aria-pressed', String(on));
  btn.dataset.tag = name;
  btn.title = on ? `取消筛选「${name}」` : `只看带「${name}」标签的文档（多选为「同时具备」）`;
  btn.innerHTML = `<span class="tag-chip-name"></span><span class="tag-chip-count">${count}</span>`;
  btn.querySelector('.tag-chip-name').textContent = name;
  btn.addEventListener('click', () => toggleTagFilter(name));
  return btn;
}
function renderTagBar() {
  const tags = state.allTags || [];
  const has = tags.length > 0;
  if (els.homeTagStrip) els.homeTagStrip.classList.toggle('hidden', !has);
  if (els.tagBar) els.tagBar.classList.toggle('hidden', !has);
  if (els.sortMenuTagsSec) els.sortMenuTagsSec.classList.toggle('hidden', !has);
  if (els.homeTagStrip) els.homeTagStrip.classList.toggle('filtering', state.tagFilter.size > 0);
  const selectedLower = new Set([...state.tagFilter].map(t => t.toLowerCase()));
  for (const host of [els.tagBar, els.sortMenuTags]) {
    if (!host) continue;
    host.innerHTML = '';
    if (!has) continue;
    const frag = document.createDocumentFragment();
    for (const t of tags) frag.appendChild(tagChipEl(t, selectedLower.has(t.name.toLowerCase())));
    host.appendChild(frag);
  }
  if (els.sortMenuTags) els.sortMenuTags.classList.toggle('scrollable', tags.length > 12);
  if (els.tagBarClear) els.tagBarClear.classList.toggle('hidden', state.tagFilter.size === 0);
  syncTagChipsOverflow();
}

// 首页筛选条的 chip 横向滚动：只在真的溢出、且还没滚到最右时挂右侧渐隐——
// 无条件挂会把最后一个 chip 也淡掉，看着像渲染坏了
function syncTagChipsOverflow() {
  const el = els.tagBar;
  if (!el) return;
  const overflow = el.scrollWidth - el.clientWidth;
  el.classList.toggle('scrollable', overflow > 1);
  el.classList.toggle('at-end', overflow <= 1 || el.scrollLeft >= overflow - 1);
}

function toggleTagFilter(name) {
  // 用原始写法存进 Set，但去重按小写——避免同时选中 "AI" 和 "ai" 两个 chip
  const lower = name.toLowerCase();
  const existing = [...state.tagFilter].find(t => t.toLowerCase() === lower);
  if (existing !== undefined) state.tagFilter.delete(existing);
  else state.tagFilter.add(name);
  // chip 会被整组重建：记下焦点在哪一组的哪个 chip 上，重建后还给同一个位置（键盘用户不丢焦点）
  const focused = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('.tag-chip') : null;
  const host = focused ? focused.parentElement : null;
  applyFilterChange();
  if (host) {
    const again = [...host.querySelectorAll('.tag-chip')].find(c => c.dataset.tag === name);
    if (again) again.focus();
  }
}

function clearTagFilter() {
  if (!state.tagFilter.size) return;
  state.tagFilter.clear();
  applyFilterChange();
}

// ---------- 收藏 / 标签的写入 ----------
// 乐观更新：先改本地 state 再发请求，点星标的反馈必须是即时的。
// 失败就回滚并 toast——静默失败会让用户以为收藏成功了，下次刷新才发现没了。
async function setFavorite(filePath, next) {
  const file = state.files[filePath];
  if (!file) return;
  const before = !!file.favorite;
  const target = typeof next === 'boolean' ? next : !before;
  if (before === target) return;

  file.favorite = target;
  if (target) {
    file.favoritedAt = Date.now();
    state.favorites = [filePath, ...(state.favorites || []).filter(p => p !== filePath)];
  } else {
    file.favoritedAt = 0;
    state.favorites = (state.favorites || []).filter(p => p !== filePath);
  }
  updateFavoriteDecorations();
  renderFavorites();

  try {
    const r = await fetch('/api/favorite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath, favorite: target }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    // 以服务端的时间戳为准，保证刷新前后收藏夹顺序一致
    file.favorite = !!data.favorite;
    file.favoritedAt = data.favoritedAt || 0;
  } catch (e) {
    file.favorite = before;
    file.favoritedAt = before ? (file.favoritedAt || Date.now()) : 0;
    if (before) state.favorites = [filePath, ...(state.favorites || []).filter(p => p !== filePath)];
    else state.favorites = (state.favorites || []).filter(p => p !== filePath);
    updateFavoriteDecorations();
    renderFavorites();
    showToast({ kind: 'error', text: '收藏没保存成功', secondary: e.message });
  }
}

// 编辑标签：一个逗号分隔的输入框。用现成的 showPrompt 而不是新做一个标签编辑器——
// 标签就是几个短词，输入框是最快的路径，也不用再实现一遍弹窗的焦点陷阱那套。
async function editTags(file) {
  const current = (file.tags || []).join(', ');
  const displayName = file.alias || stripDocExt(file.name);
  const nextRaw = await showPrompt({
    title: `「${displayName}」的标签`,
    body: '逗号分隔，例如：周报, 待评审, AI。\n清空并确定即删除全部标签。',
    label: '标签',
    value: current,
    placeholder: '周报, 待评审',
    confirmText: '保存',
    // 必须区分"点取消"（null，什么都不做）和"清空后确定"（''，删掉全部标签）
    allowEmpty: true,
  });
  if (nextRaw === null) return;                       // 取消
  if (nextRaw.trim() === current.trim()) return;      // 没改动

  const before = file.tags || [];
  try {
    const r = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 拆分交给服务端的 normalizeTags 做，前端不重复实现一遍规则
      body: JSON.stringify({ path: file.path, tags: nextRaw.split(/[,，]/) }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    file.tags = Array.isArray(data.tags) ? data.tags : [];
    recomputeAllTags();
    // 标签影响文件行内容，也可能影响当前筛选下的可见性（树 / 待看 / 计数）→ 全量刷新
    applyFilterChange();
    const removed = before.length && !file.tags.length;
    showToast({
      kind: 'success',
      text: removed ? '标签已清除' : '标签已保存',
      secondary: file.tags.length ? file.tags.join(' · ') : '',
    });
  } catch (e) {
    showToast({ kind: 'error', text: '标签没保存成功', secondary: e.message });
  }
}

// 从 state.files 重算全量标签表。服务端每次 /api/state 也会给一份，但改完一个
// 文件的标签后不该为了刷新筛选条再拉一次全量状态。
function recomputeAllTags() {
  const counts = new Map();
  for (const f of Object.values(state.files)) {
    for (const t of f.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  state.allTags = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'zh'));
  // 标签被删光后，筛选里那个已经不存在的标签要一起撤掉，否则树里空空如也
  // 而筛选条上已经没有对应 chip 可以取消 —— 用户会以为文档全丢了
  const live = new Set(state.allTags.map(t => t.name.toLowerCase()));
  for (const t of [...state.tagFilter]) {
    if (!live.has(t.toLowerCase())) state.tagFilter.delete(t);
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
  updateSortLabel();
  if (!opts.noRender) render();
}

// 树头排序按钮的小字与 tooltip：小字只说排序方式（开了仅未读再加「· 未读」），
// tooltip 写全排序与筛选两件事
const SORT_LABELS = { name: '名称', mtime: '时间', custom: '自定义' };
function updateSortLabel() {
  if (!els.btnSort) return;
  const sortName = SORT_LABELS[state.sortMode] || SORT_LABELS.name;
  if (els.btnSortLabel) els.btnSortLabel.textContent = sortName + (state.onlyUnread ? ' · 未读' : '');
  const filters = [];
  if (state.onlyUnread) filters.push('仅未读');
  if (state.tagFilter.size) filters.push(`标签「${[...state.tagFilter].join('、')}」`);
  els.btnSort.title = `排序：按${sortName} · 筛选：${filters.length ? filters.join('、') : '全部'}（点击修改）`;
  els.btnSort.classList.toggle('filtering', filters.length > 0);
}

// ---------- 排序 / 筛选菜单（#btn-sort → #sort-menu） ----------
// 菜单里的 [data-sort] / #only-unread 沿用原有事件绑定，这里只管开合。
// 点菜单外关闭；Esc 关闭并把焦点还给按钮（全局 Esc 阶梯里排在模态之后、其它之前）。
function isSortMenuOpen() {
  return !!(els.sortMenu && !els.sortMenu.classList.contains('hidden'));
}
function openSortMenu() {
  if (!els.sortMenu || !els.btnSort) return;
  els.sortMenu.classList.remove('hidden');
  els.btnSort.setAttribute('aria-expanded', 'true');
}
function closeSortMenu({ restoreFocus = false } = {}) {
  if (!isSortMenuOpen()) return;
  els.sortMenu.classList.add('hidden');
  els.btnSort.setAttribute('aria-expanded', 'false');
  if (restoreFocus) els.btnSort.focus();
}
if (els.btnSort) {
  els.btnSort.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isSortMenuOpen()) closeSortMenu();
    else openSortMenu();
  });
}
// 点菜单以外任何地方都收起。用 composedPath 而不是 target.closest：点标签 chip 会整组重建，
// 事件冒泡到这里时 target 已经脱离文档，closest 找不到菜单，会被误判成"点了外面"
document.addEventListener('click', (e) => {
  if (!isSortMenuOpen() || !els.sortWrap) return;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (path.includes(els.sortWrap)) return;
  closeSortMenu();
});
// 树顶筛选提示里的「清除」（提示内容由 updateTreeFilterNote 动态渲染，用委托）
if (els.treeFilterNote) {
  els.treeFilterNote.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-act="clear-filter"]')) clearTreeFilters();
  });
}

els.segButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.sort;
    if (mode === state.sortMode) return;
    setSortMode(mode);
  });
});
updateSortBar();
updateSortLabel();

// 视图切换：分组（虚拟分组，可拖拽/归档）/ 目录（磁盘真实多级结构，只读镜像）/ 星图（主区首页表面）
const VIEW_MODES = ['groups', 'tree', 'map'];
function updateViewBar() {
  els.viewButtons.forEach(btn => {
    btn.setAttribute('aria-checked', String(btn.dataset.view === state.viewMode));
  });
}
// 只写状态，不碰主区 DOM（design §3a）：主区显示哪个首页表面由 showHomeSurface() 决定
function setViewMode(next) {
  if (!VIEW_MODES.includes(next)) return;
  const prevList = listViewMode();
  state.viewMode = next;
  if (next !== 'map') state.listView = next;
  try {
    localStorage.setItem('atlas:viewMode', next);
    if (next !== 'map') localStorage.setItem('atlas:listView', next);
  } catch {}
  updateViewBar();
  // 侧栏按 listViewMode() 重画；选星图时列表本身没变，省掉一次整树重建
  if (listViewMode() !== prevList) render();
}
// 分段控件的唯一入口：点击、Enter / Space、←/→ 都走这里（规则表见 design §3a）。
// 一次用户操作只开一次 View Transition：文档态选星图时由 goHome 自己的 'home' 过渡负责
async function selectView(next) {
  if (!VIEW_MODES.includes(next)) return;
  if (next === state.viewMode) { updateViewBar(); return; }
  if (next === 'map' && state.activeFilePath) {
    // 编辑态有未保存改动：用户选了「继续编辑」就什么都不写
    if (editState.active && !(await confirmDiscardIfDirty())) { updateViewBar(); return; }
    setViewMode('map');
    await goHome({ confirmDirty: false });
    return;
  }
  setViewMode(next);
  // 有活动文档且切的是分组 / 目录：只动侧栏，主区保持当前文档不变
  if (!state.activeFilePath) withViewTransition(showHomeSurface, 'view');
}
els.viewButtons.forEach(btn => {
  btn.addEventListener('click', () => selectView(btn.dataset.view));
});
// radiogroup：←/→ 在三项间移动并选中
(function bindViewSegKeys() {
  const seg = document.querySelector('.view-seg');
  if (!seg) return;
  seg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const btns = [...els.viewButtons];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
    next.focus();
    selectView(next.dataset.view);
  });
})();
updateViewBar();

function renderNode(node) {
  if (node.type === 'folder') return renderFolder(node);
  if (node.type === 'file') return renderFile(state.files[node.path], node);
  return document.createDocumentFragment();
}

// ---------- 行内图标的延迟注入 ----------
// 文件行尾那排操作按钮的图标建出来就是给 hover 看的，没必要在渲染整棵树时就付这份代价
// （见 renderFile 里 data-ico-pending 的说明）。这里在首次 hover / 聚焦到该行时补上。
function hydrateRowIcons(rowEl) {
  if (!rowEl || !rowEl.dataset.icoPending) return;
  delete rowEl.dataset.icoPending;
  for (const btn of rowEl.querySelectorAll('button[data-ico]')) {
    btn.innerHTML = ic(btn.dataset.ico, Number(btn.dataset.icoSize) || 12);
    delete btn.dataset.ico;
    delete btn.dataset.icoSize;
  }
}
// 委托到 #tree 上挂一次即可：render() 只清 innerHTML、不替换 els.tree 本身，
// 所以监听器不会随整树重建丢失，也不会每行各挂一个。
// mouseover 用于鼠标（会冒泡，mouseenter 不冒泡）；focusin 覆盖键盘 ↑↓ 导航。
let treeIconHydrationBound = false;
function bindTreeIconHydration() {
  if (treeIconHydrationBound || !els.tree) return;
  treeIconHydrationBound = true;
  const onHover = (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const row = t.closest('.file[data-ico-pending]');
    if (row) hydrateRowIcons(row);
  };
  els.tree.addEventListener('mouseover', onHover);
  els.tree.addEventListener('focusin', onHover);
}

// 把一个 folder 的子节点（经筛选 + 排序）渲染进给定容器。renderFolder 的正常渲染
// 与 ensureFolderChildrenRendered 的懒展开都走这里，保证两条路径的筛选/排序口径一致。
function fillFolderChildren(childrenEl, folder) {
  const visibleChildren = sortChildren(folder.children.filter(c => {
    if (!hasActiveFilter()) return true;
    return nodeMatches(c);
  }), state.sortMode);
  // 先在离屏 fragment 里建好整批子节点，再一次性挂进容器：逐个 appendChild 到已经在
  // 文档里的容器会反复触发样式失效记账，上百行的大分组下这部分开销可观。
  const frag = document.createDocumentFragment();
  for (const c of visibleChildren) {
    frag.appendChild(renderNode(c));
  }
  childrenEl.appendChild(frag);
}

function renderFolder(folder) {
  // 筛选生效时强制展开：能活到这一步的分组本身就是"含命中项"的，
  // 再让用户手动一个个点开是反直觉的 —— 折叠着的分组里的命中结果直接看不见，
  // 表现为"筛选了但什么都没出来"。只在渲染时忽略折叠，不写 state.collapsed，
  // 所以清除筛选后每个分组的折叠状态原样恢复。
  const isCollapsed = hasActiveFilter() ? false : state.collapsed.has(folder.id);
  // 目录视图里的目录节点（kind:'dir'）是磁盘的只读镜像：只给折叠 + 「在访达中显示」，
  // 不给重命名 / 删除 / 新建子分组（那些只对虚拟分组有意义），也不能拖拽或双击改名。
  const isDir = folder.kind === 'dir';
  const folderEl = document.createElement('div');
  folderEl.className = 'folder' + (isCollapsed ? ' collapsed' : '') + (isDir ? ' dir-node' : '');
  folderEl.dataset.nodeType = 'folder';
  folderEl.dataset.folderId = folder.id;

  const counts = countDescendants(folder);

  const header = document.createElement('div');
  header.className = 'folder-header';
  header.innerHTML = `
    <span class="folder-toggle">${ic('chevron-down', 12)}</span>
    <span class="folder-icon">${ic('folder', 15, 'fi-closed')}${ic('folder-open', 15, 'fi-open')}</span>
    <span class="folder-name" data-folder-id="${folder.id}">${escapeHtml(folder.name)}</span>
    ${counts.unread > 0 ? `<span class="folder-unread-dot${counts.fresh ? '' : ' stale'}" title="${counts.unread} 个未读${counts.fresh ? `，其中 ${counts.fresh} 个今天改过` : '（都超过 24 小时）'}"></span>` : ''}
    <span class="folder-count">${counts.files}</span>
    <span class="folder-actions">
      ${isDir
        ? `<button data-act="reveal-dir" title="在访达中显示这个目录" aria-label="在访达中显示「${escapeHtml(folder.name)}」">${ic('folder-open', 12)}</button>`
        : `${folder.autoFor ? `<button data-act="reveal-folder" title="在访达中显示这个目录" aria-label="在访达中显示「${escapeHtml(folder.name)}」">${ic('folder-open', 12)}</button>` : ''}`
          + `<button data-act="new-sub" title="在此分组内新建子分组" aria-label="在「${escapeHtml(folder.name)}」内新建子分组">${ic('plus', 12)}</button>`
          + `<button data-act="rename" title="重命名" aria-label="重命名分组「${escapeHtml(folder.name)}」">${ic('pencil', 11)}</button>`
          + `<button data-act="delete" title="删除分组（文件下次扫描会回到所属项目）" aria-label="删除分组「${escapeHtml(folder.name)}」">${ic('x', 12)}</button>`}
    </span>
  `;
  folderEl.appendChild(header);

  const childrenEl = document.createElement('div');
  childrenEl.className = 'folder-children';
  childrenEl.dataset.folderId = folder.id;
  // 折叠且非筛选态：懒渲染——只留空容器并标 data-lazy，展开时(toggleFolder /
  // hover-expand)才真正填充子节点。大扫描根的常态是绝大多数分组折叠着，这样每次
  // 整树重建只创建"展开部分"的 DOM，而不是把成千上万个文件行全铺进来——那正是大树
  // 卡顿与高 DOM 内存的直接来源。筛选时 isCollapsed 被强制为 false（见上方），
  // 走正常渲染以便看到命中项；拖拽读回树时对 data-lazy 的分组直接用数据模型的
  // 原样子节点（见 readContainer），绝不会因为"没渲染"而丢掉分组内的文件。
  if (isCollapsed) {
    childrenEl.dataset.lazy = '1';
  } else {
    fillFolderChildren(childrenEl, folder);
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
  // 下面几个按钮只在分组视图存在（目录视图的 dir 节点没有），逐个判空后再绑。
  const newSubBtn = header.querySelector('[data-act="new-sub"]');
  if (newSubBtn) newSubBtn.addEventListener('click', async (e) => {
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
  const renameBtn = header.querySelector('[data-act="rename"]');
  if (renameBtn) renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startRenameFolder(folder, header.querySelector('.folder-name'));
  });
  const deleteBtn = header.querySelector('[data-act="delete"]');
  if (deleteBtn) deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteFolder(folder);
  });
  // 只有自动生成的分组（带 autoFor）在磁盘上有对应目录，按钮也只给它们渲染
  const revealBtn = header.querySelector('[data-act="reveal-folder"]');
  if (revealBtn) {
    revealBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await fetch('/api/reveal-folder', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ autoFor: folder.autoFor }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          showToast({ kind: 'error', text: '打开失败', secondary: data.error || ('HTTP ' + r.status) });
        }
      } catch (err) {
        showToast({ kind: 'error', text: '打开失败', secondary: err.message });
      }
    });
  }
  // 目录视图的 dir 节点：reveal 走通用的 /api/reveal（传真实目录绝对路径）
  const revealDirBtn = header.querySelector('[data-act="reveal-dir"]');
  if (revealDirBtn) {
    revealDirBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await fetch('/api/reveal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: folder.dirPath }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          showToast({ kind: 'error', text: '打开失败', secondary: data.error || ('HTTP ' + r.status) });
        }
      } catch (err) {
        showToast({ kind: 'error', text: '打开失败', secondary: err.message });
      }
    });
  }
  // 双击分组名改名：只对可重命名的虚拟分组绑定，目录节点不改名
  if (!isDir) {
    header.querySelector('.folder-name').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenameFolder(folder, e.currentTarget);
    });
  }

  return folderEl;
}

// 已收藏文件名后的小实心星（装饰；收藏态的可读信息在行尾星标按钮的 aria-pressed 上）
const FAV_MARK_HTML = `<span class="fav-mark" aria-hidden="true">${ic('star', 9)}</span>`;

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
  const dtype = docTypeOf(file);
  // 未读点的新鲜度：超过 24h 的变更降级成灰点（.stale）。
  // 未读点的意思是"AI 刚动过这个文件"，可 588 个满亮度未读点铺满整个侧栏时，
  // 这个信号就等于不存在了。只有今天动过的才配得上红色。
  const isFresh = isFreshUnread(file);
  fileEl.className = 'file'
    + ' doctype-' + dtype
    + (file.unread ? ' unread' : '')
    + (file.unread && !isFresh ? ' stale' : '')
    + (file.alias ? ' has-alias' : '')
    + (file.path === state.activeFilePath ? ' active' : '')
    + (file.favorite ? ' favorite' : '')
    + (contentOnly ? ' content-match' : '')
    + (isJustChanged(file.path) ? ' just-changed' : '');
  fileEl.dataset.nodeType = 'file';
  fileEl.dataset.path = file.path;
  fileEl.dataset.doctype = dtype;
  // 行尾那排操作按钮（.file-actions）平时 width:0 / opacity:0，只有 hover 才可见，但过去
  // 每一行都把 5 个图标 SVG 一起建出来。实测（400 行）：每行 30 个节点里有 16 个属于这排
  // 按钮，其中 10 个就是那 5 个 <svg><use/>；把图标延迟到首次 hover / 聚焦再注入后，
  // 每行降到 20 个节点、400 行的 innerHTML 解析从 11.1ms 降到 7.5ms（-32%）。
  // 按钮本体（含 data-act）照旧存在，事件绑定与外部查询都不受影响。
  fileEl.dataset.icoPending = '1';
  fileEl.tabIndex = -1;  // 可被 JS focus，但不出现在 Tab 序列中
  let titleParts = [];
  if (file.alias) titleParts.push(file.alias);
  titleParts.push(file.name);
  titleParts.push(file.relPath);
  // 行上只显示第一个标签，剩下的靠 title 补全（悬停能看到完整列表）
  if ((file.tags || []).length) titleParts.push('标签：' + file.tags.join(' · '));
  if (snippet) titleParts.push('内容命中：' + snippet);
  fileEl.title = titleParts.join('\n');
  const displayName = file.alias || stripDocExt(file.name);
  const isShared = state.sharesByPath && state.sharesByPath.has(file.path);
  if (isShared) fileEl.classList.add('shared');
  const typeIcon = ic(docTypeIconName(file), 12);
  // 分组视图里，分组名之下还有子目录的深层文件（relPath 段数 > 2）在行上补一个
  // 中间目录提示，让多个同名文件（README / index …）平铺后仍能区分——正是用户
  // 反馈的痛点。目录视图本身已按真实层级展示，不需要这个提示。
  const relSegs = (file.relPath || '').split(/[\\/]/).filter(Boolean);
  const midDirs = relSegs.slice(1, -1);
  const dirHintHtml = (listViewMode() !== 'tree' && midDirs.length)
    // 截断时保留末级目录（CSS direction:rtl 让省略号落在开头，<bdi> 保住路径本身的书写顺序）
    ? `<span class="file-dir-hint" title="${escapeHtml(file.relPath)}"><bdi>${escapeHtml(midDirs.join('/'))}</bdi></span>`
    : '';
  // 星标按钮在行尾悬停操作组 .file-actions 里排第一（design §12.2）：文件行左侧不再留星标列，
  // 文件名才能和同级文件夹名对齐。已收藏的行在名字后常驻一个 9px 实心星 .fav-mark。
  // 它仍在拖拽把手区内，所以 initSortables 的 filter 与本行 pointerdown/pointerup 的守卫
  // 都要排除它：点星不启动拖拽、不顺带打开文档。图标随 .file-actions 一起延迟注入。
  const favLabel = file.favorite ? `取消收藏「${escapeHtml(displayName)}」` : `收藏「${escapeHtml(displayName)}」`;
  // 行上最多一个标签 chip（design §10.5），完整列表在 title 里；
  // 三层文件夹内（及更深）的文件行不显示，由 styles.css 按 .folder-children 嵌套深度隐藏，
  // 懒展开渲染的子树也同样生效。
  const tagsHtml = (file.tags || []).length
    ? `<span class="file-tags"><span class="file-tag">${escapeHtml(file.tags[0])}</span></span>`
    : '';
  // 前缀是一个 40px 固定列：6px 状态点放在里面，对准同级文件夹图标的位置；
  // .file-type-icon 保留 DOM（CSS 隐藏），类型只看右侧角标
  fileEl.innerHTML = `
    <span class="unread-dot"></span>
    <span class="folder-icon file-type-icon">${typeIcon}</span>
    <span class="file-name" data-path="${escapeHtml(file.path)}">${escapeHtml(displayName)}</span>
    ${file.favorite ? FAV_MARK_HTML : ''}
    ${dirHintHtml}
    ${tagsHtml}
    <span class="file-type-badge type-${dtype}">${docTypeBadge(file)}</span>
    <span class="share-badge" title="正在分享到局域网" aria-hidden="${isShared ? 'false' : 'true'}">
      ${ic('share', 11)}
    </span>
    <span class="file-mtime">${fmtMtime(file.mtime)}</span>
    <span class="file-actions">
      <button class="fav-btn" type="button" data-ico="star" data-ico-size="12" title="${file.favorite ? '取消收藏' : '收藏'}" aria-label="${favLabel}" aria-pressed="${file.favorite ? 'true' : 'false'}"></button>
      <button data-act="share" data-ico="share" data-ico-size="12" title="分享到局域网（生成可访问链接 + 二维码）" aria-label="分享「${escapeHtml(displayName)}」到局域网"></button>
      <button data-act="tags" data-ico="tag" data-ico-size="12" title="编辑标签（逗号分隔）" aria-label="编辑「${escapeHtml(displayName)}」的标签"></button>
      <button data-act="rename-file" data-ico="file-pen" data-ico-size="12" title="重命名磁盘上的真实文件名" aria-label="重命名文件「${escapeHtml(file.name)}」"></button>
      <button data-act="alias" data-ico="pencil" data-ico-size="11" title="备注名（不改源文件名）" aria-label="给「${escapeHtml(displayName)}」起备注名"></button>
      <button data-act="reveal" data-ico="folder-open" data-ico-size="12" title="在访达中显示" aria-label="在访达中显示「${escapeHtml(displayName)}」"></button>
    </span>
    ${snippet ? `<span class="file-snippet">${qoMarkSnippet(snippet, state.search)}</span>` : ''}
  `;
  // 用 pointerdown + pointerup 替代 click：
  // SortableJS forceFallback 模式会在鼠标按下后任何 mousemove 启动拖拽并 preventDefault click，
  // 导致用户手抖几像素就 click 失效（"点 3-4 次才打开"）。
  // pointer 事件早于 click 触发，且 SortableJS 不会拦截。
  let pdX = 0, pdY = 0, pdDown = false;
  fileEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.file-actions') || e.target.closest('.fav-btn')) return;
    if (e.target.classList.contains('file-name') && e.target.isContentEditable) return;
    pdX = e.clientX; pdY = e.clientY; pdDown = true;
  });
  fileEl.addEventListener('pointerup', (e) => {
    if (!pdDown || e.button !== 0) return;
    pdDown = false;
    if (e.target.closest('.file-actions') || e.target.closest('.fav-btn')) return;
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
  fileEl.querySelector('[data-act="tags"]').addEventListener('click', (e) => {
    e.stopPropagation();
    editTags(file);
  });
  fileEl.querySelector('.fav-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    setFavorite(file.path);
  });
  return fileEl;
}

function saveCollapsed() {
  localStorage.setItem('atlas:collapsed', JSON.stringify([...state.collapsed]));
}
// 是否减少动效：系统「减少动态效果」或设置里的「界面动效：减少」（html[data-motion="reduce"]）
// 任一为真。所有 JS 动画（View Transitions、分组展开、之后的星图相机 / 轻闪循环）都先问它。
// 运行中切换系统设置或应用内开关会派发 window 'atlas:motion-change'（见 applyMotion 一节），
// 持续循环的模块据此当场停下。
function prefersReducedMotion() {
  if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// 单个分组的展开 / 折叠高度动画。
// 关键约束：末态一律落到 .collapsed 类（CSS 里 = display:none）。这保证三条链路和
// 过去完全一致——① 键盘上下导航按 .folder.collapsed 过滤；② 折叠后文件行"真的
// 不可见"（高度动画到 0 时子行仍有自己的包围盒，仅靠 overflow 不算隐藏）；
// ③ collapse-all / 首屏走整树重建，分组一出生即 .collapsed，压根不进这个函数、
// 也就没有"满屏分组一起展开"。动画只发生在用户单击某个分组头这一条路径。
// 子树高度超过这个阈值（约 1.5 屏）就即时展开 / 收起、不做高度动画：对几十屏高的子树做
// height 过渡毫无意义，且在 content-visibility 下会"卡一会儿才跳开"（见 animateFolderChildren）。
const ANIMATE_MAX_PX = 1200;

function animateFolderChildren(folderEl, expand) {
  const childrenEl = folderEl.querySelector(':scope > .folder-children');
  // 没有子容器、或系统要求减少动效：直接切类（0ms 过渡不触发 transitionend，
  // 若还指望它收尾会导致分组永远收不起来）
  if (!childrenEl || prefersReducedMotion()) {
    folderEl.classList.toggle('collapsed', !expand);
    return;
  }
  // 打断可能在途的上一次动画（快速连点同一个分组）
  if (childrenEl._collapseCleanup) childrenEl._collapseCleanup();

  let done = false;
  let timer = 0;
  function cleanup() {
    if (done) return;
    done = true;
    childrenEl.removeEventListener('transitionend', onTransitionEnd);
    clearTimeout(timer);
    childrenEl.classList.remove('animating', 'is-opening');
    childrenEl.style.height = '';
    childrenEl.style.willChange = '';
    childrenEl.style.contentVisibility = '';   // 复原动画期间临时关掉的 content-visibility
    childrenEl._collapseCleanup = null;
  }
  const onTransitionEnd = (e) => {
    if (e.target === childrenEl && e.propertyName === 'height') cleanup();
  };
  childrenEl._collapseCleanup = cleanup;

  // 先按「直接子项数 × 行高」免费估一把规模，再决定要不要真去读 scrollHeight。
  //
  // 为什么不一上来就读：读 scrollHeight 会强制同步布局整棵子树，几百行的分组这一下实测
  // 约 22ms —— 占首次展开同步阻塞的一半。而这种大分组走完判断后恰恰进的是下面「即时展开、
  // 不做高度过渡」那条分支：那次布局纯粹是为了判断而付的钱，浏览器在这一帧本来还会再
  // 布局一次，等于白做一遍。行数是免费的（children.length 不触发布局），拿它先挡住大分组。
  //
  // 子项里可能有嵌套分组（1 个子项却很高），所以这只是下界估计：估出来就已超阈值的，
  // 结论只会更超，直接即时展开；没超的再真正量一次高度，把嵌套很深的情况兜住。
  const ROW_PX = 28;                                        // --h-row，文件行高
  const roughPx = childrenEl.children.length * ROW_PX;
  let estimate = roughPx;
  if (roughPx <= ANIMATE_MAX_PX) {
    // 加 .animating（display:block !important）让折叠中的子树可布局，才能量到高度
    childrenEl.classList.add('animating');
    estimate = childrenEl.scrollHeight;
  }

  // 大子树（> ~1.5 屏）：即时展开 / 收起，不做高度过渡。
  // 原因有二：① 对几十屏高的子树做 height 动画毫无意义——视口一帧就填满、下方内容瞬间飞出；
  // ② 目录视图的 .folder-children 挂了 content-visibility:auto，展开时元素从 display:none
  //    变可见，过渡起点无法提交，height 过渡根本不触发，只能等 400ms 兜底 cleanup 才 height:auto
  //    跳满——表现就是"点了之后卡一会儿才啪一下打开"。即时展开点击即开、零延迟，正是该有的手感。
  if (estimate > ANIMATE_MAX_PX) {
    folderEl.classList.toggle('collapsed', !expand);
    childrenEl.classList.remove('animating');   // 走行数估算时压根没加过，remove 无副作用
    cleanup();
    return;
  }

  // 小 / 中子树：高度滑动（展开时叠加子项错峰淡入）。content-visibility:auto 会让
  // display:none→可见的过渡起点无法提交（同上），故动画期间临时把【这一个】容器的 cv 关掉
  // ——子树小、代价可忽略，nested 子容器仍保留 cv——让过渡正常跑，cleanup 里复原。
  //
  // 刻意不设 will-change:height —— height 不是可合成属性，动画每帧都要走布局，
  // will-change 帮不上忙，只会白白把这个容器提成一个 GPU 合成层、多占一份光栅内存。
  childrenEl.style.contentVisibility = 'visible';
  childrenEl.addEventListener('transitionend', onTransitionEnd);
  const full = childrenEl.scrollHeight;   // cv 已关，读到真实高度
  if (expand) {
    folderEl.classList.remove('collapsed');
    childrenEl.classList.add('is-opening');
    childrenEl.style.height = '0px';
    void childrenEl.offsetHeight;                        // 强制回流，认账起点
    childrenEl.style.height = full + 'px';
  } else {
    folderEl.classList.add('collapsed');                 // 同步进入折叠态（display 由 .animating 兜住）
    childrenEl.style.height = full + 'px';
    void childrenEl.offsetHeight;
    childrenEl.style.height = '0px';
  }
  // 兜底：transitionend 可能因中断不触发，超时强制收尾（略大于 --dur 200ms）
  timer = setTimeout(cleanup, 400);
}

function toggleFolder(id) {
  const willExpand = state.collapsed.has(id);   // 当前折叠 → 这次点击是展开
  if (state.collapsed.has(id)) state.collapsed.delete(id);
  else state.collapsed.add(id);
  saveCollapsed();
  const el = els.tree.querySelector(`.folder[data-folder-id="${id}"]`);
  if (el) {
    // 懒渲染的分组第一次展开时，先把子节点真正建出来，animateFolderChildren 才能
    // 量到真实高度、Sortable 也才有东西可挂。
    if (willExpand) {
      const rendered = ensureFolderChildrenRendered(el);
      // 新渲染出的子容器（含子分组的空容器）需要挂上 Sortable 才能作为拖放目标。
      // 这是用户点击展开（非拖拽途中），initSortables 全量重建是安全的；目录视图
      // 只读、render 已 destroySortables，不挂。
      if (rendered && listViewMode() !== 'tree') initSortables();
    }
    animateFolderChildren(el, willExpand);
  }
  updateCollapseAllBtn();
}

// 在当前视图的数据源里按 id 找 folder 节点（分组视图 = state.tree，目录视图 = state.dirTree）。
function findFolderNode(id) {
  const roots = listViewMode() === 'tree' ? (state.dirTree || []) : (state.tree || []);
  return findFolderById(roots, id);
}

// 懒渲染兑现：若该 folder 的子容器还是 data-lazy 空壳，就用数据模型把子节点填出来。
// 展开的三条路径（toggleFolder / hover-to-expand / 打开文件定位）都先过这里。
// 返回是否真的渲染了（已渲染过则返回 false）。
function ensureFolderChildrenRendered(folderEl) {
  if (!folderEl) return false;
  const childrenEl = folderEl.querySelector(':scope > .folder-children');
  if (!childrenEl || childrenEl.dataset.lazy !== '1') return false;
  const folder = findFolderNode(folderEl.dataset.folderId);
  delete childrenEl.dataset.lazy;
  if (folder) fillFolderChildren(childrenEl, folder);
  // 当前文档若正好在这个刚展开的分组里，重标一次高亮 / 祖先路径引导线
  // （全量渲染时它在懒容器里没被建出来，markSidebarActive 当时找不到它）。
  markSidebarActive(state.activeFilePath);
  return true;
}

// 树里所有分组的 id（含子分组）
function allFolderIds(nodes, out = []) {
  // 默认取当前视图的数据源：目录视图用即时目录树、分组视图用 store.tree。
  // 目录视图下 state.dirTree 由最近一次 render() 更新，collapse-all 直接复用它，
  // 不必再重建一遍。
  if (nodes === undefined) nodes = listViewMode() === 'tree' ? state.dirTree : state.tree;
  for (const n of nodes) {
    if (n && n.type === 'folder') {
      out.push(n.id);
      allFolderIds(n.children || [], out);
    }
  }
  return out;
}

// 全部折叠 / 全部展开。
// 分组一多，逐个点开点关是这个界面里最费手的操作。做成一个按钮两个状态
// （已全部折叠 → 变成"全部展开"），比并排放两个按钮省一格空间，也不用让人
// 先判断该点哪个。
function toggleCollapseAll() {
  const ids = allFolderIds();
  if (!ids.length) return;
  const allCollapsed = ids.every(id => state.collapsed.has(id));
  if (allCollapsed) {
    // 顺手把陈旧 id（分组已删/改名重建）一起清掉
    state.collapsed.clear();
  } else {
    for (const id of ids) state.collapsed.add(id);
  }
  saveCollapsed();
  // 一次动几十个节点，不走 toggleFolder 的单节点 classList 切换，整树重渲染
  // （render 末尾会顺带刷新按钮自身的图标与文案）
  render();
}

function updateCollapseAllBtn() {
  const btn = els.btnCollapseAll;
  if (!btn) return;
  const ids = allFolderIds();
  // 筛选生效时树是被强制展开的（见 renderFolder 里的说明），此时折叠写进了
  // state.collapsed 却看不到任何变化，按钮点起来像坏的——直接禁用并说明原因
  const filtering = hasActiveFilter();
  btn.disabled = filtering || ids.length === 0;
  const allCollapsed = ids.length > 0 && ids.every(id => state.collapsed.has(id));
  const label = allCollapsed ? '全部展开' : '全部折叠';
  btn.title = filtering ? '筛选中：分组已强制展开' : label;
  btn.setAttribute('aria-label', label);
  if (els.collapseAllIco) {
    els.collapseAllIco.setAttribute('href', allCollapsed ? '#i-expand-all' : '#i-collapse-all');
  }
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
    } else {
      onCommit(next);
    }
    // 编辑期间被 render() 跳过的那次渲染补回来（见 render 里的说明）。
    // 放在 onCommit 之后、并且延到下一个 tick：onCommit 可能是异步的
    // （备注名要发请求），此刻先让它把内存状态改完。
    if (renderSkippedDuringEdit) {
      setTimeout(() => { if (!isInlineEditing()) render(); }, 0);
    }
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
  const folderId = folder.id;
  startInlineEdit(nameEl, folder.name, (next) => {
    // 按 id 重新定位，不用渲染时闭包捕获的那个对象引用：万一编辑期间
    // state.tree 被整体替换过（fetchState 的 `state.tree = data.tree`），
    // 闭包里的 folder 就是个游离对象，改它不会进入接下来要保存的那棵树。
    const target = findFolderById(state.tree, folderId) || folder;
    if (!next || next === target.name) {
      nameEl.textContent = target.name;
      return;
    }
    target.name = next;
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
    // 让所有指向旧路径的 Tab 接管新路径，避免 fetchState 的 pruneDeadTabs 把它
    // 当成"文件消失"而关掉；正编辑的也把 editState.path 迁到新路径
    const renamedTab = findTabByPath(file.path);
    const wasActive = state.activeFilePath === file.path;
    if (editState.active && editState.path === file.path) editState.path = data.path;
    if (renamedTab) renamedTab.path = data.path;
    if (wasActive) state.activeFilePath = data.path;
    await fetchState();
    if (renamedTab && state.files[data.path]) {
      reloadTab(renamedTab);   // 帧当前挂在旧 /raw 路径上，强制重载到新文档
      renderTabs();            // 标签名跟着更新
      if (wasActive) applyActiveDocUI(state.files[data.path]);
    }
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
// 清扫被孤立的拖拽残留物（幽灵残影的直接可见物，见 render() 里的【幽灵残影根治】）。
//
// forceFallback + fallbackOnBody 下，SortableJS 把被拖节点克隆一份挂到 document.body，
// 带 .sortable-fallback（position:fixed / z-index:100000）。正常松手由它自己移除；
// 实例在拖拽途中被 destroy 时收尾跑不到，克隆就永久浮在 body 上。
// 只在"确定不在拖拽中"时调用，否则会把正在用的克隆误删。
function sweepDragArtifacts() {
  // 挂在 body 上的 fallback 克隆
  for (const el of document.querySelectorAll('body > .sortable-fallback')) el.remove();
  // 保险：任何落在树外的 fallback / drag 克隆
  for (const el of document.querySelectorAll('.sortable-fallback, .sortable-drag')) {
    if (!els.tree || !els.tree.contains(el)) el.remove();
  }
  // 树内元素上可能卡住的拖拽视觉态（半透明的 dragging-ghost / sortable-chosen）
  if (els.tree) {
    for (const el of els.tree.querySelectorAll('.dragging-ghost, .sortable-chosen')) {
      el.classList.remove('dragging-ghost', 'sortable-chosen');
    }
  }
}

// 保存所有 Sortable 实例，render 前先 destroy，避免实例泄漏导致长时间使用后卡顿
let sortableInstances = [];
function destroySortables() {
  for (const s of sortableInstances) {
    try { s.destroy(); } catch {}
  }
  sortableInstances = [];
  // 实例已销毁 ⇒ 正在进行的拖拽已经死了，onEnd 不会再来。必须自己收尾：
  //   ① 复位 isDragging —— 否则它永远为 true，render() 被永久跳过、整棵树冻住不再更新；
  //   ② 清掉 hover-to-expand 的计时器与视觉态；
  //   ③ 清扫已被孤立的 fallback 克隆（幽灵残影本体）。
  // render() 里已有拖拽守卫，正常渲染路径走到这里时本就不在拖拽中，不会误删活跃克隆。
  if (isDragging) {
    isDragging = false;
    clearDragHover();
  }
  sweepDragArtifacts();
}
function initSortables() {
  destroySortables();
  const containers = [els.tree, ...els.tree.querySelectorAll('.folder-children')];
  for (const el of containers) {
    sortableInstances.push(new Sortable(el, {
      group: 'atlas-nodes',
      animation: 150,
      ghostClass: 'dragging-ghost',
      // .fav-btn 现在在 .file-actions 里（已被上一条覆盖），仍单独列出：
      // 万一以后挪出操作组，按下星标也不会被当成开始拖这一行
      filter: '[contenteditable="true"], .folder-actions, .folder-actions *, .file-actions, .file-actions *, .fav-btn, .fav-btn *',
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
      onStart() { isDragging = true; if (window.AtlasPeek) AtlasPeek.close(); },
      onEnd() {
        isDragging = false;
        clearDragHover();
        // 正常收尾时 SortableJS 已移除自己的克隆；这里兜一手，保证任何异常路径
        // （克隆已被挂到 body 但收尾没跑全）都不会留下浮层。
        sweepDragArtifacts();
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
        // 拖拽期间被跳过的那次整树重建在这里补上（见 render() 的拖拽守卫）。
        // 延到下一个 tick：此刻 rebuildTreeFromDom 刚把 DOM 顺序写回 state.tree，
        // 让它先落定，再按数据重建一次，把拖拽期间到达的服务端变化一并呈现。
        if (renderSkippedDuringDrag) {
          renderSkippedDuringDrag = false;
          setTimeout(() => { if (!isDragging && !isInlineEditing()) render(); }, 0);
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
        // 先兑现懒渲染再显示：这样展开后立刻能看到子节点。此处发生在拖拽途中，
        // 不调 initSortables（会 destroy 掉正在拖的实例）；而这个分组自己的子容器
        // 在全量渲染时就已挂过 Sortable（当时是空的 data-lazy 容器），拖入它照样生效。
        ensureFolderChildrenRendered(folderEl);
        folderEl.classList.remove('collapsed');
        updateCollapseAllBtn();
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
      // 折叠懒渲染的分组：子节点从没建进 DOM（data-lazy 空壳），绝不能读空 DOM——那会
      // 把分组里的文件全丢掉、拖一次就写坏 store.json。它是折叠的、用户碰不到里面的
      // 内容，子树与数据模型里的原样完全一致，直接取原节点的 children。
      let children;
      if (childrenEl && childrenEl.dataset.lazy === '1') {
        children = original && Array.isArray(original.children) ? original.children : [];
      } else {
        children = childrenEl ? readContainer(childrenEl) : [];
      }
      const node = {
        id,
        type: 'folder',
        name: original ? original.name : child.querySelector('.folder-name').textContent.trim(),
        collapsed: state.collapsed.has(id),
        children,
      };
      // autoFor 必须原样带回去：它是服务端做自动归类时的身份键
      // （见 server.js 的 autoFolderKey）。这里漏掉的话，一次拖拽就会把它从
      // 整棵树上抹掉，改过名的分组随即又变得认不出来、下次扫描被自动名顶替。
      if (original && typeof original.autoFor === 'string') node.autoFor = original.autoFor;
      out.push(node);
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

// ==================== 多 Tab 文档浏览 ====================
// 过去整个前端假设"同一时刻只有一个文档"：一个 #preview iframe、一个 activeFilePath。
// 多 Tab 的做法是给每个打开的文档一个常驻 iframe（切 Tab 只显隐、不重载，
// 因此滚动位置和页面内部状态都留得住），并让 els.preview 始终指向当前活动 Tab 的帧。
// state.activeFilePath 依旧维护（= 活动 Tab 的 path），几十处读它的既有代码原样可用。

let tabSeq = 0;
function newTabId() { return 'tab-' + (++tabSeq) + '-' + Date.now().toString(36); }
function findTabByPath(path) { return state.tabs.find(t => t.path === path) || null; }
function getActiveTab() { return state.tabs.find(t => t.id === state.activeTabId) || null; }
function tabBasename(path) {
  const s = String(path || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

// 让当前活动帧独占 id="preview"（兼容既有以 #preview 定位预览的代码/测试）。
function setActivePreviewFrameId(frame) {
  for (const t of state.tabs) {
    if (t.frame && t.frame !== frame && t.frame.id === 'preview') t.frame.removeAttribute('id');
  }
  if (frame) frame.id = 'preview';
}

// 创建某 Tab 专属的预览 iframe，挂到 .preview 容器最前（覆盖层是 absolute，
// 永远浮在这些帧之上，DOM 顺序不影响层级）。load 事件按帧绑定。
function createPreviewFrame() {
  const ifr = document.createElement('iframe');
  ifr.className = 'preview-frame hidden';
  ifr.setAttribute('title', '预览');
  ifr.addEventListener('load', () => onPreviewFrameLoad(ifr));
  if (els.previewArea) els.previewArea.insertBefore(ifr, els.previewArea.firstChild);
  return ifr;
}

// 后台帧预算：同时最多保留这么多个"已加载"的帧。超出后把最久未激活的后台帧
// 休眠掉（卸载文档、只留空 iframe），把它占的内存（文档 DOM + 各自的 mermaid /
// katex / markdown 运行时）还给系统。再切回时按懒加载路径重载并恢复滚动位置。
//
// 取 8：每个已加载帧是独立文档，含图表 / 公式的那几篇各自带一份 mermaid(3.5MB)
// + katex 运行时并实例化大量 SVG 节点，12 份并存时渲染进程内存可达数 GB（活动
// 监视器里看到的高占用主要来自这里）。8 个对常规使用（来回切几篇）依旧不重载、
// 状态全留住，又把"重量级运行时"的并存上限显著压低。
const MAX_LIVE_FRAMES = 8;

// 打开的 Tab 总数上限。每个 Tab 即便休眠也占一个空 iframe + 标签栏 DOM，无上限地
// 开会随使用缓慢堆积。超过就自动关掉最久未激活的（非当前、非编辑中）Tab。设得足够
// 宽（远大于常规使用量），只在极端堆叠时兜底，正常使用完全感知不到。
const MAX_OPEN_TABS = 24;

// 读某个帧当前的滚动百分比（跨域 / 未就绪时返回 null）。
function frameScrollPct(frame) {
  try {
    const w = frame.contentWindow;
    const doc = w.document;
    const root = doc.scrollingElement || doc.documentElement;
    const spacer = doc.querySelector('.md-tail-space');
    const spacerH = spacer ? spacer.offsetHeight : 0;
    const realMax = Math.max(0, (root.scrollHeight - root.clientHeight) - spacerH);
    return realMax > 0 ? (root.scrollTop || 0) / realMax : 0;
  } catch { return null; }
}

// 休眠一个后台帧：记下滚动位置，把 iframe 导航到 about:blank 释放其文档与运行时。
function sleepFrame(tab) {
  if (!tab || !tab.loaded) return;
  tab.sleptScrollPct = frameScrollPct(tab.frame);
  try { tab.frame.src = 'about:blank'; } catch {}
  tab.frame.classList.remove('loading');
  tab.loaded = false;
}

// 保持"已加载帧数 ≤ MAX_LIVE_FRAMES"：超出时休眠最久未激活的后台帧。
// 当前活动帧、正在编辑的帧永不休眠。
function enforceFrameBudget() {
  const liveCount = state.tabs.reduce((n, t) => n + (t.loaded ? 1 : 0), 0);
  if (liveCount <= MAX_LIVE_FRAMES) return;
  const candidates = state.tabs.filter(t =>
    t.loaded &&
    t.id !== state.activeTabId &&
    !(editState.active && editState.path === t.path)
  ).sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));   // 最久未用在前
  let over = liveCount - MAX_LIVE_FRAMES;
  for (const t of candidates) {
    if (over <= 0) break;
    sleepFrame(t);
    over--;
  }
}

// 保持"打开的 Tab 总数 ≤ MAX_OPEN_TABS"：超出时关掉最久未激活的后台 Tab。
// 当前活动 Tab、正在编辑的 Tab 永不自动关。只在用户新开 Tab（openInTab）时触发，
// 会话恢复（restoreTabs 一次性还原上次开的那些）不受影响。
function enforceTabBudget() {
  if (state.tabs.length <= MAX_OPEN_TABS) return;
  const closable = state.tabs
    .filter(t => t.id !== state.activeTabId && !(editState.active && editState.path === t.path))
    .sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));   // 最久未用在前
  let over = state.tabs.length - MAX_OPEN_TABS;
  for (const t of closable) {
    if (over <= 0) break;
    const idx = state.tabs.findIndex(x => x.id === t.id);
    if (idx >= 0) { removeTab(idx); over--; }
  }
}

// 懒加载：把 Tab 的帧导航到它的文档。首次激活、以及从休眠中唤醒时调用。
function ensureFrameLoaded(tab) {
  if (!tab || tab.loaded) return;
  const file = state.files[tab.path];
  if (!file) return;
  els.preview = tab.frame;
  applyPreviewSandboxTo(tab.frame, file);
  // 从休眠中唤醒：重载后按休眠前的滚动百分比复位（由 onPreviewFrameLoad 兑现）
  if (tab.sleptScrollPct != null) {
    pendingPreviewScrollPct = tab.sleptScrollPct;
    tab.sleptScrollPct = null;
  }
  tab.frame.classList.add('loading');
  tab.frame.src = previewUrlFor(file);
  tab.loaded = true;
}

// 强制重载某 Tab 的帧（重命名 / 回退版本后内容变了）。走 about:blank 往返，
// 确保 sandbox flags 与新内容都重新生效。
function reloadTab(tab) {
  const file = tab && state.files[tab.path];
  if (!file) return;
  applyPreviewSandboxTo(tab.frame, file);
  const url = previewUrlFor(file);
  tab.frame.classList.add('loading');
  tab.frame.src = 'about:blank';
  requestAnimationFrame(() => { tab.frame.src = url; });
  tab.loaded = true;
}

// 帧加载完成。只有当前活动帧才做滚动恢复 / 高亮 / 编辑绑定——后台帧正常不会
// 在加载后仍处于非活动态（创建即激活），这里的 guard 只是防快速连点的兜底。
function onPreviewFrameLoad(frame) {
  if (frame !== els.preview) { frame.classList.remove('loading'); return; }
  bindPreviewShortcutBridge();
  syncFocusFrame();   // 专注中帧导航 / 重载：重新接上进度条与 data-focus（不在专注时是空操作）
  if (editState.active && editState.kind === 'html') {
    bindEditableDoc();
    applyPendingScroll(pendingEditScroll);
    pendingEditScroll = null;
  } else if (pendingPreviewScrollPct != null) {
    applyPendingScrollPct(pendingPreviewScrollPct);
    pendingPreviewScrollPct = null;
    updateIframeHighlight();
  } else {
    applyPendingScroll(pendingPreviewScroll);
    pendingPreviewScroll = null;
    updateIframeHighlight();
  }
  frame.classList.remove('loading');
}

// 在某 Tab 打开文档：已开则激活，未开则建 Tab（含帧）再激活。
function openInTab(path) {
  const file = state.files[path];
  if (!file) return;
  let tab = findTabByPath(path);
  if (!tab) {
    tab = { id: newTabId(), path, frame: createPreviewFrame(), loaded: false };
    state.tabs.push(tab);
  }
  activateTab(tab.id);
  enforceTabBudget();   // 打开新 Tab 后若超过总数上限，关掉最久未用的后台 Tab
}

// 激活某 Tab：显隐帧、切 els.preview、同步 activeFilePath、更新联动 UI。
// 前置约定：脏改动由调用方先 confirm；这里把上一个 Tab 的编辑态还原到只读预览。
function activateTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  tab.lastActiveAt = Date.now();   // LRU：记激活时间，帧预算超限时优先休眠最久未用的
  if (id === state.activeTabId) {
    // 已是活动 Tab：只保证已加载 + UI 就位（重复点同一文件不该退出其编辑态），
    // 并兑现可能的 ⌘K 正文命中高亮（重开当前文档时）
    ensureFrameLoaded(tab);
    // 重标侧栏高亮：清掉键盘导航残留的 kbd-focus，避免"点了已打开的文件后
    // 还留着另一行的 kbd-focus"造成两个被选中的视觉
    markSidebarActive(tab.path);
    updateIframeHighlight();
    return;
  }
  // 离开上一个 Tab：编辑态还原到只读预览（返回时不至于停在编辑文档上），关掉对比面板与查找栏
  if (editState.active) exitEditMode({ restore: true });
  if (diffState.open) closeDiff();
  if (findState.open) closeFind();

  // 过渡方向：新 Tab 在旧 Tab 右边 → 从右侧滑入。从首页进文档（没有旧 Tab）走整体淡入
  const prevIdx = state.tabs.findIndex(t => t.id === state.activeTabId);
  const nextIdx = state.tabs.indexOf(tab);
  const vtKind = prevIdx < 0 ? 'home' : 'tab';
  const vtDir = prevIdx < 0 ? undefined : (nextIdx >= prevIdx ? 'fwd' : 'back');

  // 状态先同步落定（View Transition 的 DOM 回调是异步的，调用方紧接着读的
  // activeTabId / activeFilePath / els.preview 必须已经是新值）；显隐等 DOM 变更交给过渡
  const assignActive = () => {
    state.activeTabId = id;
    state.activeFilePath = tab.path;
    els.preview = tab.frame;
    // 兼容层：当前活动帧始终带 id="preview"，其余帧去掉 id（保证唯一）。
    // 这样 document.getElementById('preview') / #preview 选择器 / activeElement.id
    // 依旧指向"当前正在看的那篇"，既有代码与测试无需改动。
    setActivePreviewFrameId(tab.frame);
  };
  assignActive();

  withViewTransition(() => {
  assignActive();
  for (const t of state.tabs) t.frame.classList.toggle('hidden', t !== tab);
  els.emptyState.classList.add('hidden');
  els.mdEditor.classList.add('hidden');
  document.body.classList.remove('no-active-doc');
  syncStarmapPresence();     // 从星图打开文档 = 离开星图：自动收起的侧栏在这里恢复

  const wasLoaded = tab.loaded;
  ensureFrameLoaded(tab);
  if (focusState.on) syncFocusFrame();   // 专注中切 Tab：进度条与 data-focus 换到新帧
  const file = state.files[tab.path];
  if (file) applyActiveDocUI(file);
  markSidebarActive(tab.path);
  // 已加载的帧：内容就绪，立刻刷新高亮（含 ⌘K 正文命中的兑现）。
  // 未加载的帧：src 刚设、还没 load，此刻兑现会把待高亮消费在空文档上——
  // 交给 onPreviewFrameLoad 在 load 完成后再兑现。
  if (wasLoaded) updateIframeHighlight();
  renderTabs();
  persistTabs();
  enforceFrameBudget();   // 激活后若已加载帧数超预算，休眠最久未用的后台帧
  }, vtKind, vtDir);
}

// 用户触发的 Tab 切换（点标签 / 快捷键）：切走带脏改动的编辑先确认。
async function requestActivateTab(id) {
  if (id === state.activeTabId) return;
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  if (editState.active && editState.path && editState.path !== tab.path) {
    if (!(await confirmDiscardIfDirty())) return;
  }
  activateTab(id);
}

// 关闭 Tab（用户手动）：若关的是正在编辑的脏文档，先确认。
async function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  if (editState.active && editState.path === tab.path) {
    if (!(await confirmDiscardIfDirty())) return;
    exitEditMode({ restore: false });   // 帧即将销毁，无需恢复
  }
  removeTab(idx);
}

// 底层移除（不确认脏改动）：销毁帧、从列表剔除、必要时激活邻居或回首页。
function removeTab(idx) {
  const tab = state.tabs[idx];
  if (!tab) return;
  const wasActive = tab.id === state.activeTabId;
  try { tab.frame.remove(); } catch {}
  state.tabs.splice(idx, 1);
  if (wasActive) {
    const next = state.tabs[idx] || state.tabs[idx - 1] || null;
    state.activeTabId = null;   // 让 activateTab 不把它当"已是活动 Tab"而提前返回
    if (next) activateTab(next.id);
    else goHome({ confirmDirty: false });
  } else {
    renderTabs();
  }
  persistTabs();
}

// 扫描后清掉那些文件已消失的 Tab（归档 / 删除 / 改扫描类型）。
function pruneDeadTabs() {
  for (let i = state.tabs.length - 1; i >= 0; i--) {
    const tab = state.tabs[i];
    if (!state.files[tab.path]) {
      if (editState.active && editState.path === tab.path) exitEditMode({ restore: false });
      // 正在专注阅读的文档没了（删除 / 归档 / 改扫描类型）：自动退出专注
      if (focusState.on && tab.id === state.activeTabId) exitFocus({ restoreFocus: false });
      removeTab(i);
    }
  }
}

// 渲染标签栏。
function renderTabs() {
  const bar = els.tabBar;
  if (!bar) return;
  const has = state.tabs.length > 0;
  bar.classList.toggle('hidden', !has);
  document.body.classList.toggle('has-tabs', has);
  // 只移除旧的 .tab，保留常驻的滑动指示层——重建会打断过渡，指示层必须一直在 DOM 里，
  // 改它的 transform 才能从"上一个标签"平滑滑到"新标签"，而不是每次重新出现。
  bar.querySelectorAll('.tab').forEach(el => el.remove());
  ensureTabIndicator();
  for (const tab of state.tabs) {
    const file = state.files[tab.path];
    const dtype = file ? docTypeOf(file) : 'html';
    const label = file ? (file.alias || file.name) : tabBasename(tab.path);
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', tab.id === state.activeTabId ? 'true' : 'false');
    el.dataset.tabId = tab.id;
    el.dataset.path = tab.path;   // 快速查看的触发目标（活动 Tab 不触发）
    el.title = tab.path;
    el.innerHTML =
      `<span class="file-type-badge type-${dtype}">${file ? docTypeBadge(file) : 'HTML'}</span>` +
      `<span class="tab-name"></span>` +
      `<button class="tab-close" type="button" title="关闭（⌘W）" aria-label="关闭标签">${ic('x', 12)}</button>`;
    el.querySelector('.tab-name').textContent = label;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      requestActivateTab(tab.id);
    });
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.addEventListener('auxclick', (e) => {   // 中键关闭
      if (e.button === 1) { e.preventDefault(); closeTab(tab.id); }
    });
    bar.appendChild(el);
  }
  // 指示层挪到最后一个子元素：它是 absolute（不占布局）、z-index 垫底（不挡标签），
  // 放末尾能让 .tab:nth-child(1) 仍指向第一个标签（否则会把标签整体挤后一位）。
  if (els.tabIndicator) bar.appendChild(els.tabIndicator);
  const activeEl = bar.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  positionTabIndicator(true);
}

// 常驻的滑动指示层：只创建一次，之后一直待在 tab-bar 里当第一个子元素（垫在所有 tab 之下）。
// renderTabs 每次只删 .tab、不删它，所以切换时它的 transform 能连续过渡。
function ensureTabIndicator() {
  if (!els.tabBar) return;
  if (!els.tabIndicator) {
    const ind = document.createElement('div');
    ind.className = 'tab-indicator';
    ind.setAttribute('aria-hidden', 'true');
    els.tabIndicator = ind;
  }
  if (els.tabIndicator.parentNode !== els.tabBar) {
    els.tabBar.appendChild(els.tabIndicator);
  }
}

// 把指示层移到当前激活标签的位置 / 宽度。
// animate=false（或首次出现）时无动画直接就位——用于首帧和窗口 / 侧栏改宽的即时跟随；
// animate=true 时靠 CSS 过渡从旧位置滑到新位置——用于切换标签。
function positionTabIndicator(animate) {
  const ind = els.tabIndicator;
  const bar = els.tabBar;
  if (!ind || !bar) return;
  const active = bar.querySelector('.tab.active');
  if (!active) { ind.classList.remove('show'); return; }
  const left = active.offsetLeft;
  const width = active.offsetWidth;
  if (!animate || !ind.classList.contains('show')) {
    const prev = ind.style.transition;
    ind.style.transition = 'none';
    ind.style.transform = `translateX(${left}px)`;
    ind.style.width = `${width}px`;
    void ind.offsetWidth;               // 强制回流，让"无动画就位"落定
    ind.style.transition = prev || '';
    ind.classList.add('show');
  } else {
    ind.style.transform = `translateX(${left}px)`;
    ind.style.width = `${width}px`;
  }
}

// 窗口 / 侧栏改宽会改变标签的排布，指示层要即时跟随（不滑动，避免拖影）。
// ResizeObserver 一网打尽：窗口 resize、侧栏拖拽 / 收起展开导致的 tab-bar 宽度变化都会触发。
if (window.ResizeObserver && els.tabBar) {
  new ResizeObserver(() => positionTabIndicator(false)).observe(els.tabBar);
}

// 键盘：前后切换 / 跳到第 n 个
function switchTabByOffset(delta) {
  if (state.tabs.length === 0) return;
  let idx = state.tabs.findIndex(t => t.id === state.activeTabId);
  if (idx < 0) idx = 0;
  const n = state.tabs.length;
  const next = ((idx + delta) % n + n) % n;
  requestActivateTab(state.tabs[next].id);
}
function focusTabByIndex(i) {   // i 从 0 起；越界则取最后一个（浏览器 ⌘9 习惯）
  if (state.tabs.length === 0) return;
  const idx = i >= state.tabs.length ? state.tabs.length - 1 : i;
  const tab = state.tabs[idx];
  if (tab) requestActivateTab(tab.id);
}

// ---- 持久化：记住上次打开的 Tab，重启 / 刷新后恢复 ----
const OPEN_TABS_KEY = 'atlas:openTabs';
function persistTabs() {
  try {
    const active = getActiveTab();
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({
      paths: state.tabs.map(t => t.path),
      active: active ? active.path : null,
    }));
  } catch {}
}
let tabsRestored = false;
function restoreTabs() {
  if (tabsRestored) return;
  tabsRestored = true;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || 'null'); } catch { saved = null; }
  if (!saved || !Array.isArray(saved.paths)) return;
  const valid = saved.paths.filter(p => state.files[p]);   // 丢弃已不存在的文件
  for (const p of valid) {
    if (findTabByPath(p)) continue;
    state.tabs.push({ id: newTabId(), path: p, frame: createPreviewFrame(), loaded: false });
  }
  if (state.tabs.length === 0) return;
  renderTabs();
  const activePath = (saved.active && valid.includes(saved.active)) ? saved.active : valid[0];
  const tab = activePath ? findTabByPath(activePath) : null;
  if (tab) activateTab(tab.id);
}

// 桌面 App：接主进程菜单/快捷键转发过来的多 Tab 命令。
// close-tab 无可关标签时回退为关窗（符合 ⌘W 的原生预期）。
if (window.atlasDesktop && typeof window.atlasDesktop.onMenuCommand === 'function') {
  window.atlasDesktop.onMenuCommand((cmd) => {
    if (cmd === 'close-tab') {
      const at = getActiveTab();
      if (at) closeTab(at.id);
      else if (typeof window.atlasDesktop.closeWindow === 'function') window.atlasDesktop.closeWindow();
    } else if (cmd === 'next-tab') {
      switchTabByOffset(1);
    } else if (cmd === 'prev-tab') {
      switchTabByOffset(-1);
    } else if (cmd === 'find-in-page') {
      openFind();
    } else if (cmd === 'toggle-focus') {
      // 菜单加速键在应用层生效：焦点在沙箱预览帧里（桥绑不上）也能进出专注
      toggleFocusMode();
    }
  });
}

// 桌面 App：从 Finder「打开方式」/ 双击 / 命令行传入的文件路径。
// 已运行时主进程 push 过来（onOpenPath），冷启动时前端主动来取一次（takePendingOpen）。
if (window.atlasDesktop && typeof window.atlasDesktop.onOpenPath === 'function') {
  window.atlasDesktop.onOpenPath((p) => { if (p) openExternalPath(p); });
  if (typeof window.atlasDesktop.takePendingOpen === 'function') {
    window.atlasDesktop.takePendingOpen()
      .then((p) => { if (p) openExternalPath(p); })
      .catch(() => {});
  }
}

// ---------- 用 Atlas 打开外部传入的文件 / 目录 ----------
// 桌面 App 从系统拿到一个绝对路径后走这里。先问 /api/resolve-open 该路径当前的状态，
// 再按状态处理：直接打开 / 询问启用类型 / 询问加扫描根 / 报错。全部用户确认过才动配置，
// 不静默污染 scanRoots。
const DOC_TYPE_LABELS = { html: 'HTML', md: 'Markdown', csv: 'CSV', json: 'JSON', txt: '文本', svg: 'SVG' };

async function openExternalPath(rawPath) {
  if (!rawPath) return;
  const base = String(rawPath).split(/[\\/]/).filter(Boolean).pop() || String(rawPath);
  let info;
  try {
    const r = await fetch('/api/resolve-open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: rawPath }),
    });
    info = await r.json();
  } catch (e) {
    showToast({ kind: 'error', text: '打开失败', secondary: e.message });
    return;
  }

  if (info.status === 'not-found') {
    showToast({ kind: 'error', text: '找不到这个文件', secondary: rawPath, duration: 4000 });
    return;
  }
  if (info.status === 'not-doc') {
    showToast({ kind: 'error', text: 'Atlas 打不开这种文件', secondary: base, duration: 4000 });
    return;
  }
  if (info.status === 'ready') {
    if (info.kind === 'dir') {
      await selectView('tree');
      await fetchState();
      showToast({ kind: 'success', text: '已在目录视图中打开', secondary: base });
      return;
    }
    await fetchState();
    await openPathAfterState(info.path, base);
    return;
  }
  if (info.status === 'need-doctype') {
    const label = DOC_TYPE_LABELS[info.docType] || info.docType;
    const ok = await showConfirm({
      title: '启用文档类型',
      body: `「${base}」是 ${label} 文件，但当前没有启用这种类型。是否启用「${label}」并打开？`,
      confirmText: '启用并打开',
    });
    if (!ok) return;
    const cfg = await (await fetch('/api/config')).json();
    const nextTypes = [...new Set([...(cfg.docTypes || []), info.docType])];
    if (!(await updateConfig({ docTypes: nextTypes }))) return;
    await fetchState();
    await openPathAfterState(info.path, base);
    return;
  }
  if (info.status === 'need-root') {
    const ok = await showConfirm({
      title: '添加扫描目录',
      body: info.kind === 'dir'
        ? `目录还不在 Atlas 的扫描范围内：\n${info.dir}\n是否把它加为扫描根？`
        : `「${base}」不在 Atlas 的扫描范围内。\n是否把它所在的目录\n${info.dir}\n加为扫描根后打开？`,
      confirmText: '添加并打开',
    });
    if (!ok) return;
    const cfg = await (await fetch('/api/config')).json();
    if (!(cfg.scanRoots || []).includes(info.dir)) {
      if (!(await updateConfig({ scanRoots: [...(cfg.scanRoots || []), info.dir] }))) return;
    }
    // 文件类型没启用的话，一并启用（否则加了根也扫不到这个文件）
    if (info.docType) {
      const cfg2 = await (await fetch('/api/config')).json();
      if (!(cfg2.docTypes || []).includes(info.docType)) {
        await updateConfig({ docTypes: [...new Set([...(cfg2.docTypes || []), info.docType])] });
      }
    }
    await fetchState();
    if (info.kind === 'dir') {
      await selectView('tree');
      showToast({ kind: 'success', text: '已添加目录', secondary: info.dir });
    } else {
      await openPathAfterState(info.path, base);
    }
    return;
  }
}

// 打开一个刚确认在扫描范围内的文件。索引可能刚重建完，state.files 还没这条——
// 再刷新一次、稍等重试，仍找不到才报错。
async function openPathAfterState(filePath, base) {
  if (state.files[filePath]) { openFile(filePath); return; }
  await new Promise(r => setTimeout(r, 300));
  await fetchState();
  if (state.files[filePath]) { openFile(filePath); return; }
  showToast({ kind: 'error', text: '打开失败', secondary: `未能在看板中定位到 ${base}`, duration: 4000 });
}

// ---------- 打开文件 ----------
async function openFile(filePath) {
  const file = state.files[filePath];
  if (!file) return;
  if (window.AtlasPeek) AtlasPeek.close();
  // 编辑模式下切到别的文件：先确认丢弃改动（真正的退出编辑交给 activateTab，
  // 它会把上一个 Tab 的帧恢复到只读预览，返回时不至于停在编辑文档上）
  if (editState.active && editState.path && editState.path !== filePath) {
    if (!(await confirmDiscardIfDirty())) return;
  }
  openInTab(filePath);

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
  renderFavorites();   // 同 recent：active 高亮靠整体重画同步
}

// 只更新「已分享」的视觉标记，不重建整棵树。
// 原来这里调的是全量 render()——那会把用户刚点的那个分享按钮连同整行 DOM
// 一起销毁重建，于是弹窗关闭时焦点无处可还（记下的 prevFocus 已经是游离节点），
// 而且几百篇文档时白白重排一遍侧栏。
function updateSharedDecorations() {
  const shared = state.sharesByPath || new Map();
  els.tree.querySelectorAll('.file').forEach((fileEl) => {
    const isShared = shared.has(fileEl.dataset.path);
    fileEl.classList.toggle('shared', isShared);
    const badge = fileEl.querySelector('.share-badge');
    if (badge) badge.setAttribute('aria-hidden', isShared ? 'false' : 'true');
  });
  if (state.activeFilePath) {
    els.btnShare.classList.toggle('shared', shared.has(state.activeFilePath));
  }
}

// 只更新收藏的视觉标记，不重建整棵树——同 updateSharedDecorations 的理由：
// 全量 render() 会把用户刚点的那个星标按钮连同整行 DOM 销毁重建，焦点丢失，
// 几百篇文档时还白白重排一遍侧栏。收藏不影响可见性，所以不需要重绘。
function updateFavoriteDecorations() {
  els.tree.querySelectorAll('.file').forEach((fileEl) => {
    const f = state.files[fileEl.dataset.path];
    if (!f) return;
    const on = !!f.favorite;
    fileEl.classList.toggle('favorite', on);
    const btn = fileEl.querySelector('.fav-btn');
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on ? '取消收藏' : '收藏';
    }
    // 名字后的小实心星跟着加 / 摘
    const mark = fileEl.querySelector(':scope > .fav-mark');
    if (on && !mark) {
      const nameEl = fileEl.querySelector(':scope > .file-name');
      if (nameEl) nameEl.insertAdjacentHTML('afterend', FAV_MARK_HTML);
    } else if (!on && mark) {
      mark.remove();
    }
  });
  updateFavButton();
}

// 顶栏收藏按钮：跟随当前预览文件的收藏态
function updateFavButton() {
  if (!els.btnFavorite) return;
  const f = state.activeFilePath ? state.files[state.activeFilePath] : null;
  const on = !!(f && f.favorite);
  els.btnFavorite.disabled = !f;
  els.btnFavorite.classList.toggle('on', on);
  els.btnFavorite.setAttribute('aria-pressed', on ? 'true' : 'false');
  els.btnFavorite.title = !f ? '收藏此文档' : (on ? '取消收藏' : '收藏此文档');
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
      // 标题与 stale 判定要和 renderFolder 里那一份保持一致
      const dotTitle = counts.unread + ' 个未读'
        + (counts.fresh ? `，其中 ${counts.fresh} 个今天改过` : '（都超过 24 小时）');
      if (!dot) {
        const newDot = document.createElement('span');
        newDot.className = 'folder-unread-dot' + (counts.fresh ? '' : ' stale');
        newDot.title = dotTitle;
        const header = folderEl.querySelector(':scope > .folder-header');
        const countEl = header.querySelector('.folder-count');
        header.insertBefore(newDot, countEl);
      } else {
        dot.title = dotTitle;
        dot.classList.toggle('stale', !counts.fresh);
      }
    } else if (dot) {
      dot.remove();
    }
  });
  updateStats();
}

// 侧栏树里把当前文档标为 active（树每次重建后都要重标）。
function markSidebarActive(filePath) {
  els.tree.querySelectorAll('.file.active').forEach(e => e.classList.remove('active'));
  // 切换 active 时清除键盘焦点态，避免"两个被选中"的视觉异常
  els.tree.querySelectorAll('.file.kbd-focus').forEach(e => e.classList.remove('kbd-focus'));
  // 清掉上一次的祖先路径高亮
  els.tree.querySelectorAll('.folder.on-active-path').forEach(e => e.classList.remove('on-active-path'));
  if (!filePath) return;
  const fileEl = els.tree.querySelector(`.file[data-path="${CSS.escape(filePath)}"]`);
  if (fileEl) {
    fileEl.classList.add('active');
    // 点亮当前文件所在的整条层级链的缩进引导线（VS Code 同款）：从文件向上，
    // 给每一层 .folder 加 .on-active-path，CSS 据此把 border-left 染成 accent。
    let p = fileEl.parentElement;
    while (p && p !== els.tree) {
      if (p.classList && p.classList.contains('folder')) p.classList.add('on-active-path');
      p = p.parentElement;
    }
  }
}

// 应用"当前文档"相关的联动 UI：面包屑 + 顶栏按钮 + 收藏/对比/信任 + 沙箱提示。
// 不负责导航 iframe——每个 Tab 的帧自己管加载，切 Tab 只显隐。
function applyActiveDocUI(file) {
  if (!file) return;
  const aliasPart = file.alias
    ? `<span class="crumb-alias">${escapeHtml(file.alias)}</span><span class="crumb-original">（${escapeHtml(file.name)}）</span>`
    : `<span class="crumb-name">${escapeHtml(file.name)}</span>`;
  const dtype = docTypeOf(file);
  els.crumbs.innerHTML = `
    ${crumbHomeHtml()}
    <span class="crumb-sep">›</span>
    <span class="file-type-badge type-${dtype}">${docTypeBadge(file)}</span>
    <span class="crumb-project">${escapeHtml(file.projectName)}</span>
    <span class="crumb-sep">›</span>
    ${aliasPart}
    <span class="crumb-meta">更新于 ${fmtMtime(file.mtime)}</span>
  `;
  els.btnMarkUnread.disabled = false;
  els.btnReveal.disabled = false;
  els.btnOpenExternal.disabled = false;
  els.btnCopyPath.disabled = false;
  if (els.btnMore) els.btnMore.disabled = false;
  if (els.btnFocus) els.btnFocus.classList.remove('hidden');
  if (els.btnFocusMenu) els.btnFocusMenu.disabled = false;
  els.btnReloadPreview.disabled = false;
  els.btnExportPdf.disabled = false;
  els.btnExportPdf.title = '导出为 PDF 保存到 Downloads';
  els.btnShare.disabled = false;
  // csv / json / txt / svg 只读：没有编辑器，按钮直接禁用并说明原因，
  // 而不是让用户点进去发现是个空壳
  const readonlyDoc = isReadonlyDoc(file);
  els.btnEdit.disabled = readonlyDoc;
  els.btnEdit.title = readonlyDoc
    ? `${docTypeBadge(file)} 文件在 Atlas 里只读（用「在访达中显示」打开原文件来修改）`
    : '编辑此文档（改文案 / 拖动列表）';
  // SVG 是二进制式的图形资源，导出 PDF 没有意义
  const canExportPdf = docTypeOf(file) !== 'svg';
  els.btnExportPdf.disabled = !canExportPdf;
  if (!canExportPdf) els.btnExportPdf.title = 'SVG 不支持导出 PDF';
  // 已在分享中的文件，让顶栏 share 按钮高亮提示状态
  els.btnShare.classList.toggle('shared', state.sharesByPath && state.sharesByPath.has(file.path));
  updateFavButton();
  updateDiffButton();
  updateTrustButton();
  maybeHintSandbox(file);
}

// 兼容既有调用点：
//   render() 重建树后用 (path, false) 重标高亮 + 刷新联动 UI；
//   少数"内容变了要重载"的场景（重命名 / 回退版本）用 (path, true) 触发对应 Tab 的帧重载。
function setActiveFile(filePath, doNavigate) {
  state.activeFilePath = filePath;
  // 离开首页态：文档工具栏出现（CSS 靠 body.no-active-doc 收起它）
  document.body.classList.remove('no-active-doc');
  markSidebarActive(filePath);
  const file = state.files[filePath];
  if (!file) return;
  applyActiveDocUI(file);
  if (doNavigate) {
    const tab = findTabByPath(filePath);
    if (tab) reloadTab(tab);
  }
}

// ---------- 回到首页 ----------
// setActiveFile 的反操作。原来这条路径根本不存在：activeFilePath 一旦被赋值就
// 再也回不到 null——iframe 永远挂着最后打开的那篇，顶栏那三组"针对当前文档"的
// 按钮永远可用，而首页的待看 / 最近 / 收藏三张卡片在看完第一篇之后就再也见不到，
// 只能靠刷新整个页面。
//
// 顺带收口了几个"当前文档已经不存在了"的场景（归档分组、文件被删、改扫描类型）：
// 它们以前只更新侧栏树，预览区照旧挂着一篇已经不在看板里的文档，点刷新 / 分享
// 全是 404。
//
// confirmDirty=false 用于那些"文档已经没了"的场景：那时没什么可保存的，
// 弹一个「放弃改动吗」只会拦住必须发生的复位（草稿仍会由 exitEditMode 落到本地）。
// 返回 false 表示用户在确认框里选了「继续编辑」，调用方应当中止后续动作。
async function goHome({ confirmDirty = true } = {}) {
  if (editState.active) {
    if (confirmDirty && !(await confirmDiscardIfDirty())) return false;
    // 编辑态还原到只读预览：该 Tab 的帧留一份干净预览，返回时不至于停在编辑文档上
    exitEditMode({ restore: true });
  }
  if (diffState.open) closeDiff();
  if (findState.open) closeFind();
  exitFocus({ restoreFocus: false });   // 回首页（含关掉最后一个 Tab）自动退出专注
  if (els.btnFocus) els.btnFocus.classList.add('hidden');
  if (els.btnFocusMenu) els.btnFocusMenu.disabled = true;

  // 状态先同步落定（过渡的 DOM 回调是异步的，调用方 await 之后读到的必须已是首页态）
  state.activeFilePath = null;
  state.activeTabId = null;
  withViewTransition(() => {
  state.activeFilePath = null;
  state.activeTabId = null;
  document.body.classList.add('no-active-doc');   // 回到首页态：收起文档工具栏
  markSidebarActive(null);

  // 多 Tab：不卸载任何帧（Tab 仍在，内容留着可秒回），只把它们全部隐藏、露出首页。
  // 这和过去"回首页 = 卸载唯一 iframe"不同：现在首页只是一个不选中任何 Tab 的视图。
  for (const t of state.tabs) t.frame.classList.add('hidden');
  els.mdEditor.classList.add('hidden');
  els.emptyState.classList.remove('hidden');
  els.crumbs.innerHTML = crumbHomePlaceholderHtml();

  // 顶栏按钮全部收回禁用态。这里必须手写一遍：它们只在 applyActiveDocUI 里被
  // 逐个 `= false` 打开过，之前没有任何地方关回去
  for (const b of [els.btnReloadPreview, els.btnDiff, els.btnEdit, els.btnMarkUnread,
    els.btnShare, els.btnExportPdf, els.btnOpenExternal, els.btnReveal, els.btnCopyPath, els.btnMore]) {
    if (b) b.disabled = true;
  }
  closeMoreMenu();   // 回首页时把可能开着的「更多」菜单收掉
  if (els.btnShare) els.btnShare.classList.remove('shared');
  updateFavButton();     // 这两个内部都按 activeFilePath == null 自动收敛
  updateDiffButton();
  updateTrustButton();   // 同上：没有当前文档时它自己隐藏
  if (els.preview) updateIframeHighlight();   // 收掉命中角标（帧还在，仅隐藏）
  renderTabs();              // 更新标签的 active 态（此时无活动标签）
  showHomeSurface();         // 封面墙或星图（按 viewMode）；离开首页这段时间里数据可能变过
  renderRecent();            // 重画以清掉列表里的 active 高亮
  renderFavorites();
  }, 'home');
  return true;
}

// 面包屑最左段：首页。
// 以前面包屑是「项目 › 文件名」，没有根——面包屑的第一段本来就该是可点回根的，
// 这个缺口正是"没法回首页"的直接原因。
//
// 两个形态用同一套 markup（图标 + 「首页」），只是打开文档时是可点的 button、
// 没打开时是不可点的占位：图标和文字的位置一模一样，来回切换不横跳，
// 用户才会相信这两者是同一个位置的两种状态。
// 占位那份在 index.html 里还静态写了一遍（首屏不闪），改这里记得同步。
function crumbHomeHtml() {
  return '<button type="button" class="crumb-home" title="回到首页（Esc）" aria-label="回到首页">'
    + ic('home', 12) + '<span>首页</span></button>';
}
// 星图态（首页表面换成星图）时占位显示「星图」，用户看得到自己在哪（mock map.html）
function crumbHomePlaceholderHtml() {
  if (state.viewMode === 'map' && starmapAvailable()) {
    return '<span class="placeholder">' + ic('starmap', 12) + '<span>星图</span></span>';
  }
  return '<span class="placeholder">' + ic('home', 12) + '<span>首页</span></span>';
}

// ==================== 专注阅读模式（design §3f / §10.11） ====================
// html.focus-mode 一个类隐藏侧栏、顶栏、标签栏与升级横幅，只留正文。
// 它是覆盖在原布局上的一层：不碰 body.sidebar-collapsed / atlas:sidebarCollapsed /
// 侧栏宽度，退出后原样恢复；也不持久化——刷新或重开一律回到正常布局。
//
// 入口：⌘.（外壳 keydown + 快捷键桥）、顶栏 #btn-focus、「更多」菜单、桌面菜单「显示 → 专注阅读」。
// 出口：再按 ⌘.、Esc（分级链第 2 级；专注期间桥额外转发帧内未被文档处理的 Esc）、
//       右上角 #focus-exit；回首页 / 关掉最后一个 Tab / 活动文档被删除时自动退出。
const FOCUS_IDLE_MS = 2000;   // 鼠标静止多久后退出胶囊与帧内宽度控件淡出
const focusState = {
  on: false,
  idleTimer: 0,
  lastWake: 0,
  raf: 0,
  frameRoot: null,     // 当前绑定的同源帧 <html>（设 data-focus / data-focus-idle）
  cleanup: null,       // 解绑当前帧上的 scroll / mousemove 监听
  badgeAnchor: null,   // #match-badge 在顶栏里的原位置（专注时挪到 .main 下，退出放回）
};

function toggleFocusMode() {
  if (focusState.on) exitFocus();
  else enterFocus();
}

function enterFocus() {
  if (focusState.on) return;
  const file = state.activeFilePath && state.files[state.activeFilePath];
  if (!file || !els.preview) return;   // 没有活动文档：无效
  if (editState.active) {
    // 编辑器的保存 / 取消都在被隐藏的顶栏里，强行进入会让人找不到保存
    showToast({ kind: 'info', text: '编辑中不能进入专注模式，先保存或取消' });
    return;
  }
  if (diffState.open) closeDiff();
  if (findState.open) closeFind();
  closeMoreMenu();
  if (isSortMenuOpen()) closeSortMenu();
  if (window.AtlasPeek && AtlasPeek.isOpen()) AtlasPeek.close();

  focusState.on = true;
  document.documentElement.classList.add('focus-mode');
  // 命中导航条留在视野里：从（即将隐藏的）顶栏挪到 .main 下，CSS 让它浮在正文顶部中央
  const badge = els.matchBadge;
  const main = document.querySelector('.main');
  if (badge && main && badge.parentNode !== main) {
    focusState.badgeAnchor = { parent: badge.parentNode, next: badge.nextSibling };
    main.appendChild(badge);
  }
  if (els.focusExit) els.focusExit.classList.remove('hidden');
  if (els.btnFocus) els.btnFocus.setAttribute('aria-pressed', 'true');
  syncFocusFrame();
  wakeFocusChrome(true);
  // 焦点进正文：空格 / 方向键直接滚动
  try { els.preview.focus({ preventScroll: true }); } catch {}
  window.atlasDesktop?.setChromeState?.({ focusMode: true });
}

// restoreFocus=false：自动退出（回首页 / 文档没了）时 #btn-focus 也会被隐藏，不往那儿送焦点
function exitFocus({ restoreFocus = true } = {}) {
  if (!focusState.on) return;
  focusState.on = false;
  unbindFocusFrame();
  clearTimeout(focusState.idleTimer);
  document.documentElement.classList.remove('focus-mode');
  const a = focusState.badgeAnchor;
  if (a && els.matchBadge) {
    if (a.next && a.next.parentNode === a.parent) a.parent.insertBefore(els.matchBadge, a.next);
    else a.parent.appendChild(els.matchBadge);
  }
  focusState.badgeAnchor = null;
  if (els.focusExit) { els.focusExit.classList.add('hidden'); els.focusExit.classList.remove('awake'); }
  if (els.btnFocus) els.btnFocus.setAttribute('aria-pressed', 'false');
  if (restoreFocus && els.btnFocus && !els.btnFocus.classList.contains('hidden')) {
    try { els.btnFocus.focus({ preventScroll: true }); } catch {}
  }
  window.atlasDesktop?.setChromeState?.({ focusMode: false });
}

// 鼠标移动 / 聚焦：退出胶囊与帧内宽度控件回到可见，静止 FOCUS_IDLE_MS 后一起淡出
function wakeFocusChrome(force = false) {
  if (!focusState.on) return;
  const now = Date.now();
  if (!force && now - focusState.lastWake < 100) return;   // mousemove 很密，100ms 内只续一次
  focusState.lastWake = now;
  if (els.focusExit) els.focusExit.classList.add('awake');
  setFocusFrameIdle(false);
  clearTimeout(focusState.idleTimer);
  focusState.idleTimer = setTimeout(() => {
    if (!focusState.on) return;
    if (els.focusExit) els.focusExit.classList.remove('awake');
    setFocusFrameIdle(true);
  }, FOCUS_IDLE_MS);
}
function setFocusFrameIdle(idle) {
  const root = focusState.frameRoot;
  if (!root) return;
  try {
    if (idle) root.setAttribute('data-focus-idle', '1');
    else root.removeAttribute('data-focus-idle');
  } catch {}
}

function unbindFocusFrame() {
  if (focusState.cleanup) { try { focusState.cleanup(); } catch {} }
  focusState.cleanup = null;
  focusState.frameRoot = null;
  if (focusState.raf) { cancelAnimationFrame(focusState.raf); focusState.raf = 0; }
  if (els.focusProgress) {
    els.focusProgress.classList.add('hidden');
    els.focusProgress.style.transform = '';
  }
}

// 把当前活动帧接入专注模式：阅读进度（scroll 监听）、帧内鼠标唤醒、MD 帧的 data-focus。
// 进入专注、帧加载完成（含导航 / 信任后重载）、切 Tab 时调用；不在专注时只做解绑。
// 只对同源帧生效：needsSandbox(file) 为真（未信任的 HTML，opaque origin）时
// 进度条保持 .hidden——不为它开 postMessage 通道，也不放宽沙箱。
function syncFocusFrame() {
  unbindFocusFrame();
  if (!focusState.on) return;
  const frame = els.preview;
  const file = state.activeFilePath && state.files[state.activeFilePath];
  if (!frame || !file || needsSandbox(file)) return;
  const bar = els.focusProgress;
  // 与快捷键桥同理：帧里点外链跳到站外时，读 contentDocument 会抛安全错误 → 静默跳过
  try {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    const root = doc && doc.documentElement;
    if (!win || !root) return;
    // 宽度控件只存在于 Atlas 渲染的 MD 页里：帧内 CSS 在 data-focus 下把它移到左下角
    const isMd = docTypeOf(file) === 'md';
    if (isMd) root.setAttribute('data-focus', '1');
    const update = () => {
      focusState.raf = 0;
      if (!bar) return;
      try {
        const sc = doc.scrollingElement || root;
        // MD 页末尾的 .md-tail-space 是给锚点跳转留的空白，不算正文（同 frameScrollPct）
        const spacer = doc.querySelector('.md-tail-space');
        const max = sc.scrollHeight - win.innerHeight - (spacer ? spacer.offsetHeight : 0);
        if (!(max > 0)) { bar.classList.add('hidden'); return; }
        const p = Math.min(1, Math.max(0, (win.scrollY || sc.scrollTop || 0) / max));
        bar.classList.remove('hidden');
        bar.style.transform = `scaleX(${p})`;
      } catch { bar.classList.add('hidden'); }
    };
    const onScroll = () => { if (!focusState.raf) focusState.raf = requestAnimationFrame(update); };
    const onMove = () => wakeFocusChrome();
    win.addEventListener('scroll', onScroll, { passive: true });
    doc.addEventListener('mousemove', onMove, { passive: true });
    focusState.frameRoot = root;
    focusState.cleanup = () => {
      try { win.removeEventListener('scroll', onScroll); } catch {}
      try { doc.removeEventListener('mousemove', onMove); } catch {}
      try { root.removeAttribute('data-focus'); root.removeAttribute('data-focus-idle'); } catch {}
    };
    if (els.focusExit && !els.focusExit.classList.contains('awake')) setFocusFrameIdle(true);
    update();
  } catch {}
}

if (els.btnFocus) els.btnFocus.addEventListener('click', () => toggleFocusMode());
if (els.btnFocusMenu) els.btnFocusMenu.addEventListener('click', () => toggleFocusMode());
if (els.focusExit) {
  els.focusExit.addEventListener('click', () => exitFocus());
  els.focusExit.addEventListener('focus', () => wakeFocusChrome(true));
}
document.addEventListener('mousemove', () => { if (focusState.on) wakeFocusChrome(); }, { passive: true });

// ==================== 预览 iframe 的快捷键桥 ====================
// 预览是一份独立文档，键盘事件不会跨 iframe 边界冒泡到外壳，所以外壳那个
// keydown 总处理器收不到。表现出来就是：点进文档正文读一会儿，再按 ⌘K 想跳
// 下一篇——没反应，得先点侧栏把焦点拿回来。而"读完跳下一篇"恰好是最常见的动线。
//
// 做法：往同源的预览文档里挂一个 keydown 监听，命中 app 级和弦时
//   ① 在 iframe 侧 preventDefault —— 合成事件只影响外壳，管不到原始事件的
//      默认行为，不在这儿拦住的话 ⌘S 仍会弹浏览器的「存储网页」，
//      Windows/Linux 上 Ctrl+K 仍会跳到地址栏搜索
//   ② 构造等价事件重新派发给外壳 document
// 用派发而不是直接调函数，是为了让"哪个键干什么"只存在一处（外壳的总处理器），
// 不至于两边各写一份、日后改了一边忘了另一边。
//
// 只转发带修饰键的组合。单键的 `/`（聚焦搜索）刻意不转发：不少 HTML 报告
// 自己就监听 `/` 做站内搜索，抢过来会破坏文档本身的交互。
// '.'：⌘. 进入 / 退出专注阅读（design §3f）。
const PREVIEW_BRIDGED_KEYS = new Set(['k', 'b', 's', '.']);
// 唯一一个不带修饰键也转发的：? 打开快捷键清单。
// 破例的理由是它正好服务于"读文档时想知道还能怎么用"这个场景；而它被文档自己
// 占用的概率远低于 `/`（站内搜索常用 `/`，几乎没人拿 ? 当功能键）。
// 和其它键一样，文档内正在打字时不抢。
//
// Escape（回首页）刻意不在这里：带 lightbox / 弹层的 HTML 报告普遍用 Escape
// 关闭自己的浮层，抢过来会让文档的交互坏掉——这和 `/` 不转发是同一个理由。
// 代价是读文档时按 Escape 不回首页，但那个场景鼠标本来就在手上，
// 面包屑最左段和侧栏 logo 两个入口都在视野里。
const PREVIEW_BRIDGED_BARE_KEYS = new Set(['?']);
function bindPreviewShortcutBridge() {
  // 预览里点了外链跳到站外时，读 contentDocument 会抛安全错误 → 静默跳过
  let doc = null;
  try { doc = els.preview.contentDocument; } catch { return; }
  if (!doc) return;
  // iframe 每次导航都换一份新 document，打个标记就够防重复绑定
  if (doc.__atlasKeyBridge) return;
  doc.__atlasKeyBridge = true;

  // 用 capture：文档自己的 keydown 监听可能 stopPropagation，
  // 捕获阶段能保证我们先拿到这几个和弦
  doc.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = (e.key || '').toLowerCase();

    // 不带修饰键的白名单（目前只有 ?）：e.key 已经是最终字符，
    // 不用管它在哪个布局上要不要按 Shift
    if (!mod && !e.altKey) {
      if (!PREVIEW_BRIDGED_BARE_KEYS.has(e.key)) return;
      if (isTypingTarget(doc.activeElement)) return;
      forwardKeyToShell(e);
      return;
    }
    if (!mod || e.altKey || e.shiftKey) return;
    if (!PREVIEW_BRIDGED_KEYS.has(key)) return;

    if (key === 's') {
      // ⌘S 只在编辑态下归 Atlas（保存到文件）。非编辑态不抢，让浏览器的
      // 「存储网页」照常工作 —— 和焦点在外壳时的行为保持一致。
      // 编辑态下即便正在改字也要转发：那正是最需要保存的时刻。
      if (!editState.active) return;
    } else if (isTypingTarget(doc.activeElement)) {
      // ⌘K / ⌘B：文档内正在打字（编辑态的可编辑 span、链接编辑条、
      // 文档自带的表单）就不抢，交回给输入上下文
      return;
    }

    forwardKeyToShell(e);
  }, true);

  // 专注模式下的窄口子：Esc 平时不转发（见上），专注时转发给外壳用来退出。
  // 挂在冒泡阶段并检查 defaultPrevented——文档自己用 Esc 关了浮层（并 preventDefault）就不抢。
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!document.documentElement.classList.contains('focus-mode')) return;
    forwardKeyToShell(e);
  });
}
// 在 iframe 侧拦住默认行为，再把等价事件派发给外壳。
// 两步都必须做：合成事件只影响外壳，管不到原始事件的默认行为。
function forwardKeyToShell(e) {
  e.preventDefault();
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: e.key,
    code: e.code,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    bubbles: true,
    cancelable: true,
  }));
}

// 预览帧的 load 处理已移到 onPreviewFrameLoad（多 Tab：每个 Tab 一个帧，
// 在 createPreviewFrame 里按帧绑定，而不是给单例 iframe 挂一个全局监听）。

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

// ==================== 预览区表格：拖动整行重排 ====================
// #md-preview 整体 contenteditable，单元格文字本就能直接改（改完走脏块序列化回源码）。
// 这里补上"拖动整行重排"：给每行注入一个 contenteditable=false 的抓手格
// （data-md-grip，序列化时被 markdown.js 跳过），Sortable 只认这个抓手做 handle——
// 从单元格文字上按下是编辑、从抓手上按下才是拖拽，两者不打架。拖完把整张表标脏、
// 反解析回源码。列拖动更复杂（要同步表头 / 对齐 / 每行同列），这一版先只做拖行。
let mdTableSortables = [];
const MD_ROW_GRIP_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
  + '<circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/>'
  + '<circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/>'
  + '<circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/></svg>';

function teardownMdPreviewTables() {
  for (const s of mdTableSortables) { try { s.destroy(); } catch (_) {} }
  mdTableSortables = [];
}

// 反解析预览区回源码 textarea（拖行等 DOM 操作用；input 编辑走块作用域里的 scheduleMdSerialize）。
function serializeMdPreviewToSource() {
  if (!window.AtlasMarkdown || !window.AtlasMarkdown.htmlToMarkdown) return;
  els.mdSource.value = window.AtlasMarkdown.htmlToMarkdown(els.mdPreview);
  scheduleMdDraftSave();
}

// 把脏标记打到 el 所在的「顶层块」上——即携带 data-md-raw 的最近祖先。
// 反解析（serializeBlock）的脏跟踪粒度是顶层块：未标脏的块直接吐回渲染时
// 记下的原始源码。拖行改的是 DOM，若表格嵌在引用块 / 列表项里，只标 <table>、
// 外层块没标脏 → 外层原样吐回旧源码，拖了个寂寞。所以要冒泡到顶层块。
function markMdRawBlockDirty(el) {
  let node = el;
  while (node && node !== els.mdPreview) {
    if (node.hasAttribute && node.hasAttribute('data-md-raw')) {
      node.setAttribute('data-md-dirty', '1');
      return;
    }
    node = node.parentElement;
  }
  // 兜底：没找到带 raw 的祖先（顶层表格未被注解等罕见情况），至少标自己。
  if (el && el.setAttribute) el.setAttribute('data-md-dirty', '1');
}

// 给一张表的每行注入行首抓手格（幂等）。thead 放一个对齐用的空抓手表头。
function injectMdRowGrips(table) {
  const headRows = table.tHead ? table.tHead.rows : [];
  for (const tr of headRows) {
    if (tr.querySelector('.md-row-grip')) continue;
    const th = document.createElement('th');
    th.className = 'md-row-grip md-row-grip-head';
    th.setAttribute('contenteditable', 'false');
    th.setAttribute('data-md-grip', '1');
    th.setAttribute('aria-hidden', 'true');
    tr.insertBefore(th, tr.firstChild);
  }
  const body = table.tBodies && table.tBodies[0];
  const bodyRows = body ? body.rows : [];
  for (const tr of bodyRows) {
    if (tr.querySelector('.md-row-grip')) continue;
    const td = document.createElement('td');
    td.className = 'md-row-grip';
    td.setAttribute('contenteditable', 'false');
    td.setAttribute('data-md-grip', '1');
    td.title = '拖动重排行';
    td.innerHTML = MD_ROW_GRIP_SVG;
    tr.insertBefore(td, tr.firstChild);
  }
}

// 编辑态下给预览区每张表挂"拖行"能力。renderMdPreview 每次重渲染都会重置 DOM，
// 所以先 teardown 再重建。
function setupMdPreviewTables() {
  teardownMdPreviewTables();
  if (!(editState.active && editState.kind === 'md')) return;
  if (!els.mdPreview || typeof window.Sortable === 'undefined') return;
  els.mdPreview.querySelectorAll('table').forEach((table) => {
    const body = table.tBodies && table.tBodies[0];
    if (!body || body.rows.length === 0) return;
    injectMdRowGrips(table);
    const s = window.Sortable.create(body, {
      draggable: 'tr',
      handle: '.md-row-grip',
      animation: 150,
      forceFallback: true,                 // 与侧栏 / HTML 编辑一致：统一 mouse 路径，更稳可测
      ghostClass: 'md-row-ghost',
      onEnd: () => {
        // 拖行是纯 DOM 操作、不触发 input，必须手动标脏——否则序列化会走 data-md-raw
        // 原样吐回旧顺序（拖了个寂寞）。脏标记要打到携带 data-md-raw 的顶层块上：
        // 表格可能嵌在引用块 / 列表项里，只标 <table> 的话外层块仍被判为「未改动」，
        // serializeBlock 会原样吐回旧源码，右侧行序变了、左侧却不同步（保存即回退）。
        markMdRawBlockDirty(table);
        markDirty();
        serializeMdPreviewToSource();
      },
    });
    mdTableSortables.push(s);
  });
}

function renderMdPreview() {
  if (!els.mdPreview || !window.AtlasMarkdown) return;
  // annotateRaw：给每个顶层块记上原始 Markdown 源码。用户在预览里改动时
  // 只有被改过的块会重新序列化，其余原样吐回——这样"改一个字"不会把
  // 表格对齐、段落软换行这些渲染器无法完整往返的东西一起改掉。
  els.mdPreview.innerHTML = window.AtlasMarkdown.renderBody(els.mdSource.value, { annotateRaw: true });
  rebuildMdBlockMap();     // innerHTML 换了，块 → 源码行的映射要重建
  setupMdPreviewTables();  // 重挂表格拖行（旧 Sortable 随 innerHTML 一起没了，重建）
  scheduleMdOutline();
  scheduleRichEnhance();   // 图表 / 公式：单独一档更慢的节流（见下）
  // 重渲染会抹掉标记，按当前光标位置立刻补回来，避免高亮闪断
  if (document.activeElement === els.mdSource) scheduleMdSync('source');
}

// 图表与公式的渲染比整篇 Markdown 重得多（mermaid 要布局一张有向图），
// 而 innerHTML 每次重置都会把上一轮的成果抹掉。跟着每次按键跑的话，
// 打一段话就是几十次图布局，编辑器会明显发涩。所以单独用一档 350ms 的
// 静默节流：停手之后才出图，打字过程中图表位置暂时留着代码块的样子。
let richEnhanceTimer = null;
function scheduleRichEnhance() {
  if (!els.mdPreview || !window.AtlasMarkdown || !window.AtlasMarkdown.enhanceRich) return;
  if (richEnhanceTimer) clearTimeout(richEnhanceTimer);
  richEnhanceTimer = setTimeout(() => {
    richEnhanceTimer = null;
    const theme = forcedTheme();
    window.AtlasMarkdown.enhanceRich(els.mdPreview, {
      base: '/vendor/',
      theme: theme || undefined,
    });
  }, 350);
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

// ==================== 源码 ↔ 预览 的对应区域高亮 ====================
//
// 目标：光标 / 选区落在一边，另一边同步标出对应的内容。
// 映射靠渲染时写在每个顶层块上的 data-md-line / data-md-endline（1 基闭区间）。
//
// 粒度是"块"而不是"字符"：Markdown → HTML 之后字符级对应关系并不成立
// （在源码里选中 `**粗` 这半截，HTML 里没有任何东西与之对应），块级才是
// 稳定且有意义的单位。
//
// 源码侧的高亮不能靠 textarea 自己——它无法承载任何装饰，而且不聚焦时
// 原生选区根本不绘制。所以垫一层色带，位置由一个与 textarea 同盒模型的
// 镜像元素量出来（这样软换行也能对齐）。

const SYNC_ACTIVE = 'md-sync-active';
const SYNC_SELECTED = 'md-sync-selected';

let mdBlockMap = [];        // [{ el, start, end }]，按源码行升序
let mdLineStarts = null;    // 每行起始字符偏移，随内容失效
let mdLineStartsFor = null; // mdLineStarts 对应的内容快照长度+首尾特征，用于廉价失效判断
let mdSyncLock = false;     // 防止程序化改动再触发同步

// 预览渲染后重建块映射
function rebuildMdBlockMap() {
  if (!els.mdPreview) { mdBlockMap = []; return; }
  mdBlockMap = [];
  for (const el of els.mdPreview.children) {
    const start = parseInt(el.getAttribute('data-md-line'), 10);
    const end = parseInt(el.getAttribute('data-md-endline'), 10);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      mdBlockMap.push({ el, start, end });
    }
  }
  mdBlockMap.sort((a, b) => a.start - b.start);
}

// 每行起始偏移（0 基行号 → 字符偏移）
function mdLineStartOffsets() {
  const v = els.mdSource.value;
  const sig = v.length + '|' + v.slice(0, 32) + '|' + v.slice(-32);
  if (mdLineStarts && mdLineStartsFor === sig) return mdLineStarts;
  const offsets = [0];
  for (let i = 0; i < v.length; i++) {
    if (v.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  mdLineStarts = offsets;
  mdLineStartsFor = sig;
  return offsets;
}

// 字符偏移 → 1 基行号（二分）
function mdOffsetToLine(off) {
  const starts = mdLineStartOffsets();
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// 1 基行范围 → [起始偏移, 结束偏移)（结束偏移落在 endLine 行末，不含换行）
function mdLineRangeToOffsets(startLine, endLine) {
  const v = els.mdSource.value;
  const starts = mdLineStartOffsets();
  const s = starts[Math.max(0, Math.min(starts.length - 1, startLine - 1))];
  const endIdx = Math.max(0, Math.min(starts.length - 1, endLine - 1));
  let e = endIdx + 1 < starts.length ? starts[endIdx + 1] - 1 : v.length;
  if (e < s) e = s;
  return [s, e];
}

// ---------- 源码侧色带 ----------
// 镜像元素的盒模型必须和 textarea 一致，否则量出来的软换行位置会漂
function syncMirrorMetrics() {
  const ta = els.mdSource, mirror = els.mdSourceMirror;
  if (!ta || !mirror) return;
  const cs = getComputedStyle(ta);
  // 宽度用 clientWidth：已扣掉纵向滚动条，和文本实际可用宽度一致
  mirror.style.width = ta.clientWidth + 'px';
  mirror.style.padding = cs.padding;
  mirror.style.font = cs.font;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.tabSize = cs.tabSize;
}

// 量出某段字符范围在源码区里占的每一个视觉行矩形（已处理软换行）
function measureSourceRects(startOff, endOff) {
  const ta = els.mdSource, mirror = els.mdSourceMirror;
  if (!ta || !mirror) return [];
  syncMirrorMetrics();
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 0;
  const v = ta.value;
  mirror.textContent = '';
  mirror.appendChild(document.createTextNode(v.slice(0, startOff)));
  const span = document.createElement('span');
  // 空范围用零宽字符占位，否则拿不到矩形
  span.textContent = v.slice(startOff, endOff) || '\u200b';
  mirror.appendChild(span);
  // 末尾补一个换行，保证最后一行的高度被计入布局
  mirror.appendChild(document.createTextNode(v.slice(endOff) + '\n'));
  const base = mirror.getBoundingClientRect();
  // getClientRects() 给的是「内联盒」（13px 字体约 15px 高），不是「行盒」
  // （line-height 21.45px）。内联盒在行盒里垂直居中，直接拿来画会整体偏下
  // 约 (21.45-15)/2 ≈ 3px、且高度只有半行。这里按行高把它还原成行盒。
  const rects = [...span.getClientRects()].map(r => {
    const halfLeading = lineHeight > r.height ? (lineHeight - r.height) / 2 : 0;
    return {
      top: Math.round(r.top - base.top - halfLeading),
      height: Math.max(Math.round(lineHeight || r.height), 1),
    };
  });
  mirror.textContent = '';   // 量完就清，别留着占内存
  // 合并纵向相邻/重叠的矩形，避免一行画出好几条带
  const merged = [];
  for (const r of rects) {
    const last = merged[merged.length - 1];
    if (last && r.top <= last.top + last.height + 1) {
      last.height = Math.max(last.height, r.top + r.height - last.top);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

function clearSourceBands() {
  if (els.mdSourceHl) els.mdSourceHl.textContent = '';
}

// 在源码区画色带。ranges: [{ startLine, endLine, kind: 'active'|'selected' }]
function paintSourceBands(ranges) {
  if (!els.mdSourceHl) return;
  const inner = document.createElement('div');
  inner.className = 'md-source-hl-inner';
  inner.style.transform = `translateY(${-els.mdSource.scrollTop}px)`;
  for (const r of ranges) {
    const [s, e] = mdLineRangeToOffsets(r.startLine, r.endLine);
    for (const rect of measureSourceRects(s, e)) {
      const band = document.createElement('div');
      band.className = 'md-source-band' + (r.kind === 'active' ? ' active' : '');
      band.style.top = rect.top + 'px';
      band.style.height = rect.height + 'px';
      inner.appendChild(band);
    }
  }
  els.mdSourceHl.textContent = '';
  els.mdSourceHl.appendChild(inner);
}

// 源码滚动时色带跟着走（只改 transform，不重新测量）
function offsetSourceBands() {
  const inner = els.mdSourceHl && els.mdSourceHl.firstElementChild;
  if (inner) inner.style.transform = `translateY(${-els.mdSource.scrollTop}px)`;
}

// ---------- 预览侧块标记 ----------
function clearPreviewMarks() {
  if (!els.mdPreview) return;
  els.mdPreview.querySelectorAll('.' + SYNC_ACTIVE + ', .' + SYNC_SELECTED)
    .forEach(el => el.classList.remove(SYNC_ACTIVE, SYNC_SELECTED));
}

function markPreviewBlocks(startLine, endLine, isRange) {
  clearPreviewMarks();
  const cls = isRange ? SYNC_SELECTED : SYNC_ACTIVE;
  for (const b of mdBlockMap) {
    // 行范围有交集就标上
    if (b.end >= startLine && b.start <= endLine) b.el.classList.add(cls);
  }
}

function clearMdSync() {
  clearPreviewMarks();
  clearSourceBands();
}

// ---------- 源码 → 预览 ----------
function syncFromSource() {
  if (mdSyncLock) return;
  if (!editState.active || editState.kind !== 'md') return;
  const ta = els.mdSource;
  const l1 = mdOffsetToLine(ta.selectionStart);
  const l2 = mdOffsetToLine(ta.selectionEnd);
  const isRange = ta.selectionEnd > ta.selectionStart;
  markPreviewBlocks(Math.min(l1, l2), Math.max(l1, l2), isRange);
  // 源码侧自己不画带：光标和原生选区已经是最清楚的指示了
  clearSourceBands();
}

// ---------- 预览 → 源码 ----------
// 找出某个节点所属的顶层块。必须先确认节点在预览面板内——否则一路 parentElement
// 会爬出面板、爬到 body，返回一个毫无关系的祖先。
function topLevelBlockOf(node) {
  let n = node;
  if (n && n.nodeType === 3) n = n.parentElement;
  if (!n || n === els.mdPreview || !els.mdPreview.contains(n)) return null;
  while (n.parentElement && n.parentElement !== els.mdPreview) n = n.parentElement;
  return n.parentElement === els.mdPreview ? n : null;
}

// Range 的边界容器可能就是预览面板本身（带 offset 指向某个子块），
// 典型来源：全选、跨块鼠标拖选、setStartBefore/setEndAfter。
// 这种情况要按 offset 取出真正的子节点。
function resolveBoundaryNode(container, offset) {
  if (container === els.mdPreview) {
    const kids = container.childNodes;
    if (!kids.length) return null;
    return kids[Math.min(offset, kids.length - 1)];
  }
  return container;
}

function syncFromPreview() {
  if (mdSyncLock) return;
  if (!editState.active || editState.kind !== 'md') return;
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  // 选区必须落在预览面板内
  const anc = range.commonAncestorContainer;
  if (anc !== els.mdPreview && !els.mdPreview.contains(anc)) return;

  let hit;
  if (sel.isCollapsed) {
    // 光标：只认它所在的那一个块
    const el = topLevelBlockOf(resolveBoundaryNode(range.startContainer, range.startOffset));
    hit = el ? mdBlockMap.filter(x => x.el === el) : [];
  } else {
    // 选区：用 intersectsNode 判断，比只看首尾容器可靠得多
    // （首尾容器可能是面板本身，也可能是空白文本节点）
    hit = mdBlockMap.filter((x) => {
      try { return range.intersectsNode(x.el); } catch { return false; }
    });
  }
  if (!hit.length) { clearMdSync(); return; }

  const startLine = Math.min(...hit.map(x => x.start));
  const endLine = Math.max(...hit.map(x => x.end));
  const isRange = !sel.isCollapsed;

  markPreviewBlocks(startLine, endLine, isRange);
  paintSourceBands([{ startLine, endLine, kind: isRange ? 'selected' : 'active' }]);
}

// ---------- 事件接线 ----------
// selectionchange 是唯一能可靠覆盖"鼠标拖选 / 键盘移动 / 双击选词"的事件；
// 它挂在 document 上，所以要自己判断当前焦点在哪一侧。
let mdSyncScheduled = false;
function scheduleMdSync(source) {
  if (mdSyncScheduled) return;
  mdSyncScheduled = true;
  requestAnimationFrame(() => {
    mdSyncScheduled = false;
    if (source === 'preview') syncFromPreview();
    else syncFromSource();
  });
}

document.addEventListener('selectionchange', () => {
  if (!editState.active || editState.kind !== 'md') return;
  const active = document.activeElement;
  if (active === els.mdSource) scheduleMdSync('source');
  else if (els.mdPreview && els.mdPreview.contains(active)) scheduleMdSync('preview');
});

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
  rebuildMdBlockMap();
  clearMdSync();

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
  // 点击 / 聚焦源码区也要立刻同步一次（selectionchange 在某些路径下不触发）
  els.mdSource.addEventListener('click', () => scheduleMdSync('source'));
  els.mdSource.addEventListener('focus', () => scheduleMdSync('source'));
  els.mdPreview.addEventListener('click', () => scheduleMdSync('preview'));
  // 分栏宽度变了 → 软换行位置变了，已画的色带需要重新测量
  window.addEventListener('resize', () => {
    if (editState.active && editState.kind === 'md') scheduleMdSync('preview');
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
  els.mdSource.addEventListener('scroll', () => {
    syncScroll(els.mdSource, els.mdPreview);
    offsetSourceBands();   // 色带跟着滚，只改 transform
  }, { passive: true });
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
  teardownMdPreviewTables();   // 预览区表格拖行的 Sortable 单独管理，一并销毁
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
    clearMdSync();   // 清掉对应区域高亮，别留到下次进编辑
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
      reloadPreviewDoc(rawUrl);
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
      // 标已读（防止自我写入的未读标记）
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

els.btnEdit.addEventListener('click', async () => {
  if (els.btnEdit.disabled) return;
  const file = state.activeFilePath && state.files[state.activeFilePath];
  if (isMdFile(file)) return enterMdEditMode();
  // 预览内编辑要往文档里注入锚点、样式和 Sortable，全都需要同源。
  // 沙箱里做不到，所以顺手问一句——比让编辑按钮变灰、用户不知道为什么点不动要好。
  if (needsSandbox(file)) {
    const ok = await showConfirm({
      title: '编辑需要信任这份文档',
      body: '预览内编辑要把 Atlas 的脚本注入到文档里，沙箱预览下做不到。'
        + '信任之后这份文档会以同源方式加载 —— 它自己的脚本也就能访问 Atlas 的接口了。',
      confirmText: '信任并编辑',
    });
    if (!ok) return;
    await toggleTrust(true);
    // 信任后预览要重新导航一次，等它落地再进编辑态，否则注入会打在旧文档上
    await new Promise((resolve) => {
      const done = () => { els.preview.removeEventListener('load', done); resolve(); };
      els.preview.addEventListener('load', done);
      setTimeout(done, 3000);   // 兜底，别把编辑入口卡死
    });
  }
  enterEditMode();
});
els.btnTrust.addEventListener('click', () => {
  if (els.btnTrust.disabled) return;
  toggleTrust();
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
// 未读标记只回答了"AI 动过这个文件"，但用户真正想知道的是"动了什么"。
// 底本在用户每次打开文件时由 /api/seen 落一份快照，这里做的是把差异呈现出来。
// version = 用户在面板里选中的那一份历史底本（null 表示交给服务端自动挑）
const diffState = { open: false, path: null, loading: false, version: null, versions: [] };

function diffContextValue() {
  const v = els.diffContext ? parseInt(els.diffContext.value, 10) : 3;
  return Number.isFinite(v) ? v : 3;
}

function renderDiffEmpty(html) {
  els.diffBody.innerHTML = html;
}

// 历史版本选择器 + 回退按钮。
// 底本从"只留一份"改成"留最近几份"之后，这里让用户挑要和哪一版比。
// 只有一份可选时整组控件不出现——一个只有单个选项的下拉只是噪音。
function renderDiffVersions(data) {
  if (!els.diffVersionWrap || !els.diffVersion || !els.diffRevert) return;
  const list = Array.isArray(data.versions) ? data.versions : [];
  diffState.versions = list;
  diffState.version = data.version || null;
  const show = list.length > 1;
  els.diffVersionWrap.classList.toggle('hidden', !show);
  els.diffRevert.classList.toggle('hidden', !show);
  if (!show) return;
  els.diffVersion.innerHTML = list.map((v, i) => {
    const label = (i === 0 ? '最近一版' : `往前第 ${i} 版`)
      + ' · ' + fmtMtime(v.at)
      + (v.isCurrent ? '（与当前相同）' : '');
    return `<option value="${escapeHtml(v.file)}"${v.file === data.version ? ' selected' : ''}>`
      + `${escapeHtml(label)}</option>`;
  }).join('');
  // 选中的这一版就是磁盘上的当前内容时，回退没有意义
  const picked = list.find(v => v.file === data.version);
  els.diffRevert.disabled = !!(picked && picked.isCurrent);
}

function renderDiffResult(data) {
  els.diffBody.innerHTML = '';
  renderDiffVersions(data);
  if (!data.hasBaseline) {
    els.diffStats.textContent = '';
    renderDiffEmpty(`
      <div class="diff-empty">
        <div class="diff-empty-art">${ic('clock', 30)}</div>
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
        <div class="diff-empty-art ok">${ic('check-circle', 30)}</div>
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
      + '&context=' + diffContextValue()
      // 不带 version 时由服务端自动挑「第一个内容不同于当前的版本」
      + (diffState.version ? '&version=' + encodeURIComponent(diffState.version) : '');
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      els.diffStats.textContent = '';
      renderDiffEmpty(`<div class="diff-empty"><div class="diff-empty-art warn">${ic('alert', 30)}</div>
        <div>对比失败：${escapeHtml(data.error || ('HTTP ' + r.status))}</div></div>`);
      return;
    }
    renderDiffResult(data);
  } catch (e) {
    els.diffStats.textContent = '';
    renderDiffEmpty(`<div class="diff-empty"><div class="diff-empty-art warn">${ic('alert', 30)}</div>
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
  diffState.version = null;    // 换文档要重新自动挑版本，不能沿用上一篇的选择
  diffState.versions = [];
  els.diffPanel.classList.remove('hidden');
  els.emptyState.classList.add('hidden');
  loadDiff();
}

function closeDiff() {
  diffState.open = false;
  diffState.path = null;
  diffState.version = null;
  diffState.versions = [];
  els.diffPanel.classList.add('hidden');
  els.diffBody.innerHTML = '';
  if (els.diffVersionWrap) els.diffVersionWrap.classList.add('hidden');
  if (els.diffRevert) els.diffRevert.classList.add('hidden');
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
if (els.diffVersion) {
  els.diffVersion.addEventListener('change', () => {
    diffState.version = els.diffVersion.value || null;
    loadDiff();
  });
}
// 回退：这是会写用户文件的操作，先确认，服务端写前还会自动备份
if (els.diffRevert) {
  els.diffRevert.addEventListener('click', async () => {
    if (!diffState.path || !diffState.version) return;
    const p = diffState.path;
    const picked = diffState.versions.find(v => v.file === diffState.version);
    const when = picked && picked.at ? fmtMtime(picked.at) : '选中的这一版';
    const ok = await showConfirm({
      title: '回退到这一版？',
      body: `磁盘上的文件内容会被改回「${when}」那一版。\n`
        + '写入前会自动备份到 ~/.atlas/backups/，但这一步本身不能撤销。',
      confirmText: '回退',
      danger: true,
    });
    if (!ok) return;
    els.diffRevert.disabled = true;
    try {
      const r = await fetch('/api/revert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p, version: diffState.version }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showToast({ kind: 'error', text: '回退失败', secondary: data.error || ('HTTP ' + r.status) });
        els.diffRevert.disabled = false;
        return;
      }
      showToast({ kind: 'success', text: '已回退到选中的版本', secondary: '原内容已备份到 backups/' });
      await fetchState();
      // 内容变了：对应 Tab 的帧要重载，差异要按新的当前内容重新自动选版
      const revertedTab = findTabByPath(p);
      if (revertedTab) reloadTab(revertedTab);
      diffState.version = null;
      loadDiff();
    } catch (e) {
      showToast({ kind: 'error', text: '回退失败', secondary: e.message });
      els.diffRevert.disabled = false;
    }
  });
}
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
        // 底本就是当前内容了，顶栏那个"有改动"提示要跟着灭掉
        state.files[p].baselineSame = true;
      }
      updateUnreadDecorations();
      updateDiffButton();
      showToast({ kind: 'success', text: '已更新对比底本' });
      // 清掉手动选的版本：刚确认过的那一份才是新基准，交给服务端重新自动选，
      // 否则还带着 accept 之前挑的旧版本去比，面板上依旧显示一堆差异
      diffState.version = null;
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
  // 判据不能只看 mtime：AI 用相同内容重新生成一遍文档（或 touch / 网盘同步）
  // 会让 mtime 前进但内容没变，那样点开对比是空的，提示就成了假警报。
  // baselineSame 是服务端做过内容核对的结果（见 server.js buildVersionMeta）。
  const changed = file.hasBaseline && file.baselineAt
    && file.mtime > file.baselineAt && !file.baselineSame;
  els.btnDiff.classList.toggle('has-changes', !!changed);
  els.btnDiff.title = !file.hasBaseline
    ? '还没有对比底本（打开一次后即可对比）'
    : (changed ? '这个文档自上次查看后有改动，点击查看差异'
      : (file.versionCount > 1 ? '查看历史版本 / 和上次已读版本对比' : '和上次已读版本对比'));
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
let highlightTruncated = false;   // 命中数达到 MAX_HIGHLIGHTS 上限被截断（计数显示成「N+」）

function highlightInIframe(query) {
  const doc = (() => {
    try { return els.preview.contentDocument; } catch { return null; }
  })();
  if (!doc || !doc.body) return;

  clearIframeHighlight(doc);
  highlightMatches = [];
  highlightCurrentIdx = -1;
  highlightTruncated = false;
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

  // 命中数硬上限：超大文档配上短 / 常见关键词，一次高亮能瞬间造出上万个 <mark>
  // DOM 节点、把主线程冻住几秒。命中太多时本就没法逐个跳，2000 处足够定位；
  // 到达上限就停止建标记（badge 会显示成「2000+」）。
  const MAX_HIGHLIGHTS = 2000;
  let hlTruncated = false;
  for (const node of todo) {
    if (highlightMatches.length >= MAX_HIGHLIGHTS) { hlTruncated = true; break; }
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
      if (highlightMatches.length >= MAX_HIGHLIGHTS) { hlTruncated = true; break; }
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
    if (hlTruncated) break;
  }
  highlightTruncated = hlTruncated;

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
  // 文档内查找栏（⌘F）打开时，命中计数显示在查找栏上，工具栏那枚命中条不出现，
  // 避免"一处搜索、两处计数"的重复。
  if (findState.open) {
    setFindCount(total, currentIdx);
    if (els.matchBadge) els.matchBadge.classList.add('hidden');
    return;
  }
  const badge = els.matchBadge;
  if (!badge) return;
  if (total === 0) {
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');
  badge.querySelector('.match-text').textContent = `${currentIdx + 1} / ${total}${highlightTruncated ? '+' : ''}`;
}

// 就地清除文档内的搜索高亮 / 命中导航（不离开文档）。
// 这是"⌘K 正文命中后搜索退不出"的直接出口：命中条的 ✕、Esc 阶梯、关闭查找栏都走它。
function clearIframeSearch() {
  pendingPreviewHighlight = null;
  const doc = (() => { try { return els.preview && els.preview.contentDocument; } catch { return null; } })();
  if (doc) clearIframeHighlight(doc);
  highlightMatches = [];
  highlightCurrentIdx = -1;
  updateMatchBadge(0, 0);
}

// ==================== 文档内查找（⌘F） ====================
// 复用 iframe 高亮那套（highlightInIframe / gotoMatch / 命中计数）。查找栏是一个
// 独立于侧栏搜索、独立于 ⌘K 的入口：只在当前文档正文里找，不过滤目录树。
const findState = { open: false };
let findSandboxHinted = false;

function setFindCount(total, currentIdx) {
  if (!els.findCount) return;
  els.findCount.textContent = total > 0 ? `${currentIdx + 1}/${total}${highlightTruncated ? '+' : ''}` : '0/0';
  els.findCount.classList.toggle('none', total === 0 && !!(els.findInput && els.findInput.value));
}

function openFind() {
  if (!els.findBar || !els.findInput) return;
  // 没打开文档、或正处于编辑/对比态时不接管（那些场景 iframe 不是只读预览）
  if (!state.activeFilePath || editState.active || diffState.open) return;
  findState.open = true;
  els.matchBadge && els.matchBadge.classList.add('hidden');   // 让位给查找栏的计数
  els.findBar.classList.remove('hidden');
  els.findInput.focus();
  els.findInput.select();
  // 已有输入则立即重跑一次（保留上次的查找词，像浏览器那样）
  if (els.findInput.value) runFind();
  else setFindCount(0, 0);
}

function closeFind() {
  if (!findState.open) return;
  findState.open = false;
  if (els.findBar) els.findBar.classList.add('hidden');
  clearIframeSearch();
  // 焦点还给预览，方便继续用键盘滚动阅读
  try { if (els.preview) els.preview.focus(); } catch {}
}

function runFind() {
  const q = els.findInput ? els.findInput.value : '';
  const file = state.files[state.activeFilePath];
  // 沙箱 HTML 拿不到 contentDocument，标不出命中位置——提示一次并给出出路
  if (q && file && needsSandbox(file)) {
    setFindCount(0, 0);
    if (!findSandboxHinted) {
      findSandboxHinted = true;
      showToast({
        kind: 'info',
        text: '沙箱预览下无法在文档内查找',
        secondary: '点顶栏盾牌信任这份文档后可用',
        duration: 5000,
      });
    }
    return;
  }
  highlightInIframe(q);   // 内部会调 updateMatchBadge → setFindCount
}

// ⌘K 从「正文命中」打开文档时，要高亮的是那次搜索的词，而不是侧栏搜索框里的内容。
// 刻意不去写侧栏搜索框：那会顺带过滤整棵目录树，而用户只是想跳到某一篇的某一处。
let pendingPreviewHighlight = null;   // { path, query }
function setPendingPreviewHighlight(path, query) {
  pendingPreviewHighlight = (path && query) ? { path, query } : null;
}
// 只在路径对得上时兑现，且兑现后立即失效 —— 否则之后从目录树打开别的文档
// 也会被同一个词高亮
function applyPendingPreviewHighlight() {
  if (!pendingPreviewHighlight) return false;
  if (pendingPreviewHighlight.path !== state.activeFilePath) return false;
  const q = pendingPreviewHighlight.query;
  pendingPreviewHighlight = null;
  // 沙箱预览下拿不到 contentDocument，正文里的命中位置标不出来。
  // ⌘K 的「正文命中」是常用动线，静默不动比报错更让人困惑，所以明确说一句
  // 并给出出路，而不是让用户以为搜错了。
  const file = state.files[state.activeFilePath];
  if (needsSandbox(file)) {
    showToast({
      kind: 'info',
      text: '沙箱预览下无法跳到正文命中处',
      secondary: '点顶栏盾牌信任这份文档后可用',
      duration: 5000,
    });
    return true;
  }
  highlightInIframe(q);
  if (els.matchBadge) els.matchBadge.title = '正文命中：' + q;
  return true;
}
// 在 search 改变 / iframe load 后被调用
function updateIframeHighlight() {
  if (applyPendingPreviewHighlight()) return;
  if (els.matchBadge) els.matchBadge.title = '搜索命中导航';
  highlightInIframe(state.search);
}

// 上下跳转按钮
els.matchPrev.addEventListener('click', () => gotoMatch(-1));
els.matchNext.addEventListener('click', () => gotoMatch(1));
// 命中条的 ✕：就地清掉文档内高亮，不离开文档（"搜索退不出"的鼠标出口）
if (els.matchClose) els.matchClose.addEventListener('click', clearIframeSearch);

// ---- 文档内查找栏（⌘F）的事件接线 ----
if (els.findInput) {
  // 输入防抖：连续打字时不每个键都重扫全文重建高亮（大文档上一次高亮就可能几十毫秒）。
  let findDebounce = null;
  els.findInput.addEventListener('input', () => {
    if (findDebounce) clearTimeout(findDebounce);
    findDebounce = setTimeout(runFind, 120);
  });
  els.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });
}
if (els.findPrev) els.findPrev.addEventListener('click', () => gotoMatch(-1));
if (els.findNext) els.findNext.addEventListener('click', () => gotoMatch(1));
if (els.findClose) els.findClose.addEventListener('click', closeFind);

// 搜索框聚焦时按 Enter 跳到下一处，Shift+Enter 上一处
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && highlightMatches.length > 0) {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  }
});

// ---------- 顶部按钮 ----------
let searchDebounceTimer = null;
// 清除最近：⌘K 空状态段头的 #recent-clear 是每次重画时新建的，用委托；首页轨道头的直接绑
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#recent-clear')) {
    e.preventDefault();
    clearRecent();
  }
});
if (els.homeRecentClear) els.homeRecentClear.addEventListener('click', clearRecent);
if (els.tagBarClear) els.tagBarClear.addEventListener('click', clearTagFilter);
// 首页筛选条宽度一变（拖侧栏 / 改窗口），chip 是否溢出得重新判定
if (els.tagBar) {
  if (window.ResizeObserver) new ResizeObserver(syncTagChipsOverflow).observe(els.tagBar);
  els.tagBar.addEventListener('scroll', syncTagChipsOverflow, { passive: true });
  // 普通鼠标滚轮只有纵向：chip 溢出时把纵向滚动转成横向（触控板横滑原生就行）
  els.tagBar.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if (els.tagBar.scrollWidth <= els.tagBar.clientWidth) return;
    els.tagBar.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
}
// 回到首页的两个入口。
// ① 面包屑最左段——面包屑本来就是导航路径，第一段可点回根是标准语义，
//    而且它就在当前文档标题的左边，视线不用移动
// ② 侧栏左上角的品牌区——"点 logo 回首页"是几乎所有人的肌肉记忆，
//    白捡一个入口，不占任何新的界面位置
// 面包屑每次 setActiveFile 都整体重建，所以用委托而不是直接绑
els.crumbs.addEventListener('click', (e) => {
  if (e.target.closest('.crumb-home')) goHome();
});
if (els.btnHome) els.btnHome.addEventListener('click', () => goHome());

els.btnFavorite.addEventListener('click', () => {
  if (!state.activeFilePath) return;
  setFavorite(state.activeFilePath);
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
    applyFilterChange();
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
    applyFilterChange();
    if (shouldSearchContent(v)) doContentSearch(v);
    else contentSearchSeq++;             // cancel pending
    // 同步刷新 iframe 内高亮
    updateIframeHighlight();
  }, 80);
});
els.onlyUnread.addEventListener('change', (e) => { state.onlyUnread = e.target.checked; applyFilterChange(); });
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
    body: '所有文档的未读标记都会被清掉。',
    confirmText: '全部标为已读',
  });
  if (!ok) return;
  await fetch('/api/seen/all', { method: 'POST' });
  fetchState();
});

if (els.btnCollapseAll) {
  els.btnCollapseAll.addEventListener('click', toggleCollapseAll);
}

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

  // canonical 地址：md 走 /api/render-md，html 走 /raw/。
  // 不直接信任 iframe 当前 URL——详见 reloadPreviewDoc 的注释
  const file = state.files[filePath];
  reloadPreviewDoc(file ? previewUrlFor(file) : ifr.src);
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

  // 桌面 App（Electron）：交给主进程用内置 Chromium 的 printToPDF 导出，
  // 不依赖本机是否装了 Chrome / Edge。浏览器与 npm 用户仍走下面的 SSE + 系统 Chromium 路径。
  if (window.atlasDesktop && window.atlasDesktop.isDesktop) {
    const prog = showToast({ kind: 'info', progress: true, text: '导出 PDF', secondary: '正在用内置渲染器生成…' });
    let result;
    try {
      result = await window.atlasDesktop.exportPdf({ path: filePath, fileName: stem });
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    els.btnExportPdf.classList.remove('spinning');
    els.btnExportPdf.disabled = false;
    prog.close();
    if (result && result.ok) {
      const t = showToast({
        kind: 'success',
        text: '✓ 已保存到 Downloads',
        secondary: result.savedPath.replace(/^.*\/Downloads\//, 'Downloads/'),
        duration: 6000,
      });
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
            body: JSON.stringify({ path: result.savedPath }),
          }).catch(() => {});
        });
        msgEl.appendChild(link);
      }
    } else {
      showToast({ kind: 'error', text: '导出 PDF 失败', secondary: (result && result.error) || '未知错误', duration: 5000 });
    }
    return;
  }

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
  // 现在它是「更多」菜单里的一行，复制后菜单会关掉，就地改文字看不见，
  // 改用 toast 给反馈（也顺带修掉旧写法把按钮内容整段替换的隐患）
  navigator.clipboard.writeText(state.activeFilePath)
    .then(() => showToast({ kind: 'success', text: '已复制文件路径' }))
    .catch(() => showToast({ kind: 'error', text: '复制失败', secondary: '浏览器拒绝了剪贴板访问' }));
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

// ==================== 快捷键速查表 ====================
// 唯一的一份清单，紧挨着下面的全局 keydown 处理器放 —— 改快捷键的人应该
// 在同一屏里看到"清单也要改"。按 ? 唤出，侧栏底部和首页各有一个显式入口。
//
// 为什么需要它：功能全藏在 title 提示和 README 里，用户根本不知道"还能这样用"。
// 首页底部那行提示只在没打开文档时可见，Markdown 编辑器那套键更是完全没有出口。
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const SHORTCUTS = [
  {
    group: '全局',
    items: [
      [[MOD, 'K'], '快速打开（模糊匹配文件名，同时搜正文；再按一次收起）'],
      [[MOD, 'F'], '在当前文档内查找（↑↓ / Enter 在命中处间跳）'],
      [['/'], '聚焦搜索框'],
      [[MOD, 'B'], '收起 / 展开侧边栏'],
      [[MOD, 'S'], '保存改动到文件（编辑态）'],
      [[MOD, '.'], '进入 / 退出专注阅读（Safari 请用顶栏按钮）'],
      [['?'], '打开这份快捷键清单'],
      [['Esc'], '由近及远地退出：关快速查看 → 退出专注 → 关查找/弹窗 → 清空搜索 → 清除文档内高亮 → 收起对比 → 回到首页'],
    ],
  },
  {
    group: '多标签',
    items: [
      [['点击文件'], '在标签里打开（已开则切到该标签）'],
      [[MOD, 'W'], '关闭当前标签'],
      [['中键点标签'], '关闭该标签'],
      [['Ctrl', 'Tab'], '切到后一个标签'],
      [['Ctrl', 'Shift', 'Tab'], '切到前一个标签'],
      [[MOD, '⌥', '←/→'], '切到前 / 后一个标签'],
      [[MOD, '1–9'], '跳到第 1–9 个标签（9 = 最后一个）'],
    ],
  },
  {
    group: '快速打开面板',
    items: [
      [['↑', '↓'], '上下选择'],
      [['Home'], '跳到第一条'],
      [['End'], '跳到最后一条'],
      [['Enter'], '打开选中的文档（正文命中项会直接跳到命中位置）'],
    ],
  },
  {
    group: '侧栏与目录树',
    items: [
      [['↓'], '在搜索框里按 ↓ 进入文件列表'],
      [['↑', '↓'], '在列表里上下移动（第一条再按 ↑ 回搜索框）'],
      [['Enter'], '打开当前文件'],
      [['Space'], '快速查看（目录树焦点行 / ⌘K 空状态）'],
      [['Esc'], '退出列表，回到搜索框'],
      [['双击'], '双击分组名 / 文件名即可重命名'],
    ],
  },
  {
    group: '星图',
    items: [
      [['←', '→'], '视图分段控件上：在分组 / 目录 / 星图间切换'],
      [['↑', '↓', '←', '→'], '画布获得焦点时平移'],
      [['+', '-'], '放大 / 缩小（滚轮与触控板捏合同效）'],
      [['0'], '显示全部'],
      [['Enter'], '画布上：焦点移到星表；星表里：打开星团 / 文档'],
      [['Space'], '星表里：快速查看选中的星'],
    ],
  },
  {
    group: '时间河流',
    items: [
      [['←', '→'], '手柄上：移动一小时'],
      [['Shift', '←', '→'], '手柄上：移动一天'],
      [['Home', 'End'], '手柄移到最左 / 最右（两手柄在两端 = 不筛选）'],
      [['Esc'], '首页 / 星图上：清除时间段筛选'],
    ],
  },
  {
    group: '正文命中导航',
    items: [
      [['Enter'], '焦点在搜索框 / 查找栏时，跳到下一处命中'],
      [['Shift', 'Enter'], '跳到上一处命中'],
      [['▲', '▼'], '顶栏命中条 / 查找栏的上下箭头同样可以跳'],
      [['Esc'], '清除文档内的搜索高亮（顶栏命中条的 ✕ 同效），不离开文档'],
    ],
  },
  {
    group: 'Markdown 预览',
    items: [
      [['['], '阅读宽度收窄一档（推荐 → 加宽 → 占满全屏）'],
      [[']'], '阅读宽度放宽一档'],
      [['点右上角控件'], '同上，三档直选（选择会被记住；专注阅读时控件在左下角）'],
    ],
  },
  {
    group: 'Markdown 编辑器',
    items: [
      [[MOD, 'B'], '加粗'],
      [[MOD, 'I'], '斜体'],
      [[MOD, 'E'], '行内代码'],
      [[MOD, 'K'], '插入链接'],
      [[MOD, 'S'], '保存'],
      [['Tab'], '多行缩进'],
      [['Shift', 'Tab'], '反缩进'],
      [['Enter'], '自动续列表（有序列表序号自增、任务项续出未勾选框）'],
    ],
  },
  {
    group: '编辑器分栏条',
    items: [
      [['←', '→'], '聚焦分栏条后微调宽度'],
      [['Shift', '←/→'], '加速微调'],
      [['Home'], '宽度复位（双击分栏条同效）'],
    ],
  },
  {
    group: '重命名与备注',
    items: [
      [['Enter'], '提交'],
      [['Esc'], '取消，恢复原值'],
    ],
  },
];

let shortcutsEntry = null;
function renderShortcuts() {
  const body = document.getElementById('shortcuts-body');
  if (!body || body.dataset.rendered === '1') return;
  body.innerHTML = SHORTCUTS.map(sec => `
    <section class="sc-group">
      <h3>${escapeHtml(sec.group)}</h3>
      <dl>
        ${sec.items.map(([keys, desc]) => `
          <div class="sc-row">
            <dt>${keys.map(k => `<kbd>${escapeHtml(k)}</kbd>`).join('<span class="sc-plus">+</span>')}</dt>
            <dd>${escapeHtml(desc)}</dd>
          </div>`).join('')}
      </dl>
    </section>`).join('');
  body.dataset.rendered = '1';
}
function openShortcuts() {
  const root = document.getElementById('shortcuts-modal');
  if (!root || shortcutsEntry) return;
  renderShortcuts();
  root.classList.remove('hidden');
  shortcutsEntry = pushModal({
    panel: root.querySelector('.modal-panel'),
    close: closeShortcuts,
  });
}
function closeShortcuts() {
  const root = document.getElementById('shortcuts-modal');
  if (!root) return;
  root.classList.add('hidden');
  if (shortcutsEntry) { popModal(shortcutsEntry); shortcutsEntry = null; }
}

// ==================== 更新日志 / 新功能引导 ====================
// 数据来自 window.ATLAS_CHANGELOG（public/changelog.js，随版本发布，客户端与 web 共用）。
// 两种展示共用一个弹窗：
//   whatsnew —— 升级后首次打开自动弹，只讲本版新功能（feature）+ 使用引导；纯 bug 修复版本不弹。
//   full     —— 用户在设置里手动点「更新日志」，列出全部历史版本的所有改动。
const CHANGELOG_SEEN_KEY = 'atlas:changelogSeen';   // 记已给用户看过引导的最新版本号
let changelogEntry = null;

function changelogData() {
  return Array.isArray(window.ATLAS_CHANGELOG) ? window.ATLAS_CHANGELOG : [];
}
function clTypeLabel(type) { return type === 'feature' ? '新功能' : '修复'; }

// 一条改动。full 模式带「新功能 / 修复」标签；feature 带使用引导。
function clEntryHtml(e, opts = {}) {
  const isFeat = e.type === 'feature';
  const tag = opts.hideTag ? '' :
    `<span class="cl-tag cl-tag-${isFeat ? 'feature' : 'fix'}">${clTypeLabel(e.type)}</span>`;
  const guide = (isFeat && e.guide)
    ? `<p class="cl-entry-guide"><span class="cl-guide-label">怎么用</span>${escapeHtml(e.guide)}</p>`
    : '';
  return `
    <div class="cl-entry cl-${isFeat ? 'feature' : 'fix'}">
      ${tag}
      <div class="cl-entry-body">
        <div class="cl-entry-title">${escapeHtml(e.title || '')}</div>
        ${e.desc ? `<p class="cl-entry-desc">${escapeHtml(e.desc)}</p>` : ''}
        ${guide}
      </div>
    </div>`;
}

function renderChangelogFull() {
  const body = document.getElementById('changelog-body');
  if (!body) return;
  const data = changelogData();
  if (!data.length) { body.innerHTML = '<p class="cl-empty">暂无更新记录。</p>'; return; }
  body.innerHTML = data.map(v => `
    <section class="cl-version">
      <div class="cl-version-head">
        <span class="cl-version-num">v${escapeHtml(v.version)}</span>
        ${v.date ? `<span class="cl-version-date">${escapeHtml(v.date)}</span>` : ''}
      </div>
      ${(v.entries || []).map(e => clEntryHtml(e)).join('')}
    </section>`).join('');
}

// 只渲染某版本的新功能（feature）+ 引导，用于升级后的主动提示。
function renderWhatsNew(v) {
  const body = document.getElementById('changelog-body');
  if (!body) return;
  const feats = (v.entries || []).filter(e => e.type === 'feature');
  body.innerHTML =
    `<div class="cl-whatsnew-head"><span class="cl-whatsnew-badge">v${escapeHtml(v.version)}</span>`
    + '<span class="cl-whatsnew-sub">带来了这些新功能</span></div>'
    + feats.map(e => clEntryHtml(e, { hideTag: true })).join('');
}

function openChangelog(mode) {
  const root = document.getElementById('changelog-modal');
  if (!root || changelogEntry) return;
  const titleEl = document.getElementById('changelog-title');
  const foot = document.getElementById('changelog-foot');
  const data = changelogData();
  if (mode === 'whatsnew' && data.length) {
    if (titleEl) titleEl.textContent = 'Atlas 更新了';
    renderWhatsNew(data[0]);
    if (foot) foot.classList.remove('hidden');   // 引导底部给「看完整更新日志」入口
  } else {
    if (titleEl) titleEl.textContent = '更新日志';
    renderChangelogFull();
    if (foot) foot.classList.add('hidden');
  }
  root.classList.remove('hidden');
  changelogEntry = pushModal({ panel: root.querySelector('.modal-panel'), close: closeChangelog });
}

function closeChangelog() {
  const root = document.getElementById('changelog-modal');
  if (!root) return;
  root.classList.add('hidden');
  if (changelogEntry) { popModal(changelogEntry); changelogEntry = null; }
}

// 升级后首次打开：最新版本有 feature 且还没给这个版本弹过引导 → 弹一次。纯 fix 版本不弹。
// 只对「从旧版本升上来」的用户弹：全新安装（没有任何 seen 记录）不该被弹窗打扰
//   —— 对第一次用的人来说谈不上"更新了"，而且会干扰"干净启动"的预期。
// 全新用户直接把当前版本记为 seen（静默），从下一个带 feature 的版本起才开始弹。
// 无论弹没弹，都把 seen 推进到当前版本——纯 fix 版本升级也算"已处理"，
// 不会累积到下次 feature 版本时补弹一堆历史。
function maybeShowWhatsNew() {
  const data = changelogData();
  if (!data.length) return;
  const latest = data[0];
  let seen = '';
  try { seen = localStorage.getItem(CHANGELOG_SEEN_KEY) || ''; } catch {}
  if (seen === latest.version) return;              // 这个版本的引导已经给过
  const isUpgrade = !!seen && seen !== latest.version;   // 有旧记录 = 从旧版升上来
  const hasFeature = (latest.entries || []).some(e => e.type === 'feature');
  if (isUpgrade && hasFeature) openChangelog('whatsnew');
  try { localStorage.setItem(CHANGELOG_SEEN_KEY, latest.version); } catch {}
}

(() => {
  const root = document.getElementById('changelog-modal');
  if (root) {
    root.addEventListener('click', (e) => {
      if (isCloseTarget(e.target)) closeChangelog();
    });
  }
  const openBtn = document.getElementById('settings-changelog-btn');
  if (openBtn) openBtn.addEventListener('click', () => openChangelog('full'));
  // 引导弹窗底部「查看完整更新日志」：不关弹窗，直接把内容从 whatsnew 切到 full
  const allBtn = document.getElementById('changelog-all-btn');
  if (allBtn) allBtn.addEventListener('click', () => {
    const titleEl = document.getElementById('changelog-title');
    const foot = document.getElementById('changelog-foot');
    if (titleEl) titleEl.textContent = '更新日志';
    renderChangelogFull();
    if (foot) foot.classList.add('hidden');
    const b = document.getElementById('changelog-body');
    if (b) b.scrollTop = 0;
  });
})();
(() => {
  const root = document.getElementById('shortcuts-modal');
  if (root) {
    root.addEventListener('click', (e) => {
      if (isCloseTarget(e.target)) closeShortcuts();
    });
  }
  const btn = document.getElementById('btn-shortcuts');
  if (btn) btn.addEventListener('click', openShortcuts);
  // 首页那个入口是动态渲染出来的兄弟节点，用委托更省事
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-open-shortcuts]')) openShortcuts();
  });
})();

document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const mod = e.metaKey || e.ctrlKey;

  // ? 打开 / 关闭快捷键清单。用 e.key === '?' 而不是判断 Shift+/，
  // 这样不同键盘布局下都对（'?' 落在哪个物理键不重要）
  if (e.key === '?' && !mod && !isTypingTarget(active)) {
    e.preventDefault();
    if (shortcutsEntry) closeShortcuts();
    else openShortcuts();
    return;
  }

  // ⌘S / Ctrl+S：编辑态下保存到文件，而不是让浏览器弹"保存网页"
  if (mod && e.key.toLowerCase() === 's' && !e.altKey && !e.shiftKey) {
    if (editState.active) {
      e.preventDefault();
      saveEdit();
      return;
    }
  }

  // ⌘. / Ctrl+.：进入 / 退出专注阅读。用 e.key 而不是 e.code，理由同 ?（布局无关）。
  // 没有活动文档时无效；编辑态下 enterFocus 自己给 toast 并拒绝进入
  if (mod && e.key === '.' && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    toggleFocusMode();
    return;
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

  // ⌘F / Ctrl+F：在当前文档内查找。桌面 App 里由主进程菜单接管转发（见 electron/main.js），
  // 这里主要服务浏览器场景。没有只读预览可搜时（首页 / 编辑态 / 对比态）放行给浏览器原生查找。
  if (mod && e.key.toLowerCase() === 'f' && !e.altKey && !e.shiftKey) {
    if (isInMdEditor(active)) return;
    if (!state.activeFilePath || editState.active || diffState.open) return;
    e.preventDefault();
    openFind();
    return;
  }

  // ---- 多 Tab 快捷键 ----
  // Ctrl+Tab / Ctrl+Shift+Tab：后 / 前一个标签（跨浏览器与 App 都能收到，不与默认菜单冲突）
  if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
    if (state.tabs.length > 1) { e.preventDefault(); switchTabByOffset(e.shiftKey ? -1 : 1); return; }
  }
  // ⌘⌥→ / ⌘⌥←：后 / 前一个标签（Safari 式，编辑输入时也安全，因为带 ⌘）
  if (mod && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    if (state.tabs.length > 1) { e.preventDefault(); switchTabByOffset(e.key === 'ArrowRight' ? 1 : -1); return; }
  }
  // ⌘1–9：跳到第 n 个标签（⌘9 = 最后一个，浏览器习惯）。编辑器里让位给可能的原生行为
  if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
    if (state.tabs.length > 0 && !isInMdEditor(active)) {
      e.preventDefault();
      focusTabByIndex(e.key === '9' ? state.tabs.length - 1 : (parseInt(e.key, 10) - 1));
      return;
    }
  }
  // ⌘W：关闭当前标签。桌面 App 里由主进程菜单接管（见 electron/main.js），
  // 这里是浏览器场景的兜底——浏览器多半会先自己关标签页，能收到就顺手关我们的 Tab。
  if (mod && e.key.toLowerCase() === 'w' && !e.altKey && !e.shiftKey) {
    const at = getActiveTab();
    if (at) { e.preventDefault(); closeTab(at.id); return; }
  }

  // 单键快捷键：焦点在输入框 / 可编辑区里时一律不抢
  if (e.key === '/' && !isTypingTarget(active)) {
    e.preventDefault();
    els.search.focus();
    return;
  }
  // Escape 是一条"由近及远地退出当前语境"的阶梯，从上到下越来越远：
  //   弹窗（在上面那个 capture 层就被吃掉了，走不到这里）
  //   → 快速查看浮窗 → 专注阅读（§3f 第 2 级）
  //   → 搜索框里的这次搜索
  //   → 对比面板
  //   → 当前文档（回首页）
  // 编辑态整段跳过：那时 Escape 的候选动作是"放弃改动"，不该由一个
  // 顺手按下的键来决定，交给顶栏的「取消」按钮走确认流程。
  if (e.key === 'Escape') {
    // 第一级：关闭快速查看浮窗（通常已在上面的 capture 层处理，这里兜底）
    if (window.AtlasPeek && AtlasPeek.isOpen()) { e.preventDefault(); AtlasPeek.close(); return; }
    // 第二级：退出专注阅读（焦点回到 #btn-focus）
    if (focusState.on) { e.preventDefault(); exitFocus(); return; }
    // 模态之后：收起树头的排序 / 筛选菜单，焦点还给 #btn-sort
    // （菜单里的「仅未读」是 checkbox，所以排在 isTypingTarget 判断之前）
    if (isSortMenuOpen()) { e.preventDefault(); closeSortMenu({ restoreFocus: true }); return; }
    // 最先：关掉打开着的文档内查找栏（并清掉它的高亮）
    if (findState.open) { e.preventDefault(); closeFind(); return; }
    if (active === els.search) {
      els.search.value = '';
      state.search = '';
      state.contentMatches = new Map();
      applyFilterChange();
      updateIframeHighlight();
      return;
    }
    if (isTypingTarget(active)) return;
    if (editState.active) return;
    // 先就地清掉文档内的搜索高亮 / 命中导航（多半是 ⌘K 正文命中留下的），不离开文档；
    // 再按一次 Esc 才按原阶梯回首页。侧栏搜索有内容时交给上面的搜索框分支处理。
    if (!state.search && highlightMatches.length > 0) {
      e.preventDefault();
      clearIframeSearch();
      return;
    }
    if (diffState.open) { e.preventDefault(); closeDiff(); return; }
    if (state.activeFilePath) { e.preventDefault(); goHome(); return; }
    // 末级：没有活动文档（首页 / 星图）且有时间段筛选 → 清除时间筛选
    if (state.timeRange) { e.preventDefault(); clearTimeRange(); }
    return;
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
// 空状态「最近打开」段最多几条；「收藏」段列全部，超过 QO_SECTION_SCROLL 条时该段内部滚动
const QO_RECENT_MAX = 8;
const QO_SECTION_SCROLL = 8;
// 正文命中单独限量：它是"补充手段"，不该把名称命中挤出视野
const QO_CONTENT_LIMIT = 25;
const QO_CONTENT_DEBOUNCE = 180;
let qoEntry = null;
let qoResults = [];
let qoActive = 0;
// 正文搜索的状态。刻意不复用 state.contentMatches——那是侧栏搜索的，
// 写它会顺带过滤整棵目录树，而 ⌘K 是纯导航，不该有这个副作用。
const qoContent = {
  q: '',                  // 已拿到结果的那次查询
  matches: new Map(),     // path → { snippet, count }
  loading: false,
  truncated: false,
};
let qoContentSeq = 0;
let qoContentTimer = null;

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
    const ordered = files
      .slice()
      .sort((a, b) => {
        const ra = recentSet.has(a.path) ? recentSet.get(a.path) : Infinity;
        const rb = recentSet.has(b.path) ? recentSet.get(b.path) : Infinity;
        if (ra !== rb) return ra - rb;
        return (b.mtime || 0) - (a.mtime || 0);
      });
    const row = (f, section) => ({ file: f, hits: [], label: f.alias || stripDocExt(f.name), section });
    const recent = (state.recent || []).filter(p => state.files[p]).slice(0, QO_RECENT_MAX);
    const favs = (state.favorites || []).filter(p => state.files[p]);
    // 没有最近也没有收藏：和过去完全一样，一段平铺
    if (!recent.length && !favs.length) return ordered.slice(0, QO_LIMIT).map(f => row(f));
    // 分段（design §11.B1）：最近打开（≤8）→ 收藏（全部）→ 全部文档（其余，原顺序）。
    // 每篇只出现一次：已在「最近打开」里的收藏不再重复列
    const seen = new Set();
    const out = [];
    for (const p of recent) { seen.add(p); out.push(row(state.files[p], 'recent')); }
    for (const p of favs) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(row(state.files[p], 'fav'));
    }
    let rest = 0;
    for (const f of ordered) {
      if (rest >= QO_LIMIT) break;
      if (seen.has(f.path)) continue;
      out.push(row(f, 'all'));
      rest++;
    }
    return out;
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

// 把 snippet 里的关键词标出来。服务端已经按原始大小写返回 snippet，
// 这里按词做大小写不敏感的匹配再包 <mark>。
function qoMarkSnippet(snippet, query) {
  const text = String(snippet || '');
  const terms = parseQueryTerms(query).filter(t => t.length > 0);
  if (!terms.length) return escapeHtml(text);
  const lower = text.toLowerCase();
  // 收集所有命中区间并合并重叠，避免嵌套 <mark>
  const ranges = [];
  for (const t of terms) {
    const lt = t.toLowerCase();
    let from = 0;
    let idx;
    while ((idx = lower.indexOf(lt, from)) !== -1) {
      ranges.push([idx, idx + lt.length]);
      from = idx + lt.length;
    }
  }
  if (!ranges.length) return escapeHtml(text);
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] < last[1]) { if (r[1] > last[1]) last[1] = r[1]; }
    else merged.push(r.slice());
  }
  let out = '';
  let cur = 0;
  for (const [s, e] of merged) {
    if (s > cur) out += escapeHtml(text.slice(cur, s));
    out += `<mark>${escapeHtml(text.slice(s, e))}</mark>`;
    cur = e;
  }
  if (cur < text.length) out += escapeHtml(text.slice(cur));
  return out;
}

// 正文命中：只保留"名称组没收录"的文件，避免同一篇出现两次。
// 名称已经命中的文件，正文里有没有这个词不影响你要不要打开它。
function qoContentResults(nameResults, query) {
  if (!qoContent.matches.size || qoContent.q !== query.trim()) return [];
  const already = new Set(nameResults.map(r => r.file.path));
  const out = [];
  for (const [p, info] of qoContent.matches) {
    if (already.has(p)) continue;
    const f = state.files[p];
    if (!f) continue;      // 磁盘上已删、索引还没更新
    out.push({
      file: f,
      hits: [],
      label: f.alias || stripDocExt(f.name),
      content: info,
    });
    if (out.length >= QO_CONTENT_LIMIT) break;
  }
  return out;
}

// 结果行的内部结构。末尾那个 .qo-action 只在选中行上显示（由 CSS 控制）：
// Raycast 的招牌做法——"现在按回车会发生什么"写在你正看着的那一行上，
// 而不是只写在底部图例里，眼睛不需要在列表和 footer 之间来回跑。
function qoRowHtml(r, query) {
  const f = r.file;
  // 正文命中的行：第二行给摘要（比路径有用得多），完整路径落到 title 上
  const second = r.content
    ? `<span class="qo-snippet">${qoMarkSnippet(r.content.snippet, query)}</span>`
    : `<span class="qo-path">${escapeHtml(f.relPath)}</span>`;
  const hitCount = r.content
    ? `<span class="qo-hits" title="正文里出现 ${r.content.count >= 200 ? '200 以上' : r.content.count} 处">${r.content.count >= 200 ? '200+' : r.content.count} 处</span>`
    : '';
  return `
    <span class="qo-icon" aria-hidden="true">${ic(docTypeIconName(f), 14)}</span>
    <span class="qo-main">
      <span class="qo-name">${qoHighlight(r.label, r.hits)}</span>
      ${second}
    </span>
    ${hitCount}
    <span class="qo-badge">${docTypeBadge(f)}</span>
    ${f.unread ? `<span class="qo-unread${isFreshUnread(f) ? '' : ' stale'}" title="未读"></span>` : ''}
    <span class="qo-action" aria-hidden="true"><kbd>↵</kbd><span>打开</span></span>
  `;
}

function qoRender() {
  const query = qoEls.input.value;
  const nameResults = qoSearch(query);
  const contentResults = qoContentResults(nameResults, query);
  // 名称命中永远在前：⌘K 的肌肉记忆是"敲两个字母 Enter 就走"，
  // 正文命中排进去会把这条路径搅乱
  qoResults = nameResults.concat(contentResults);
  qoActive = 0;
  qoEls.list.innerHTML = '';

  if (!qoResults.length) {
    const empty = document.createElement('div');
    empty.className = 'quickopen-empty';
    empty.textContent = qoContent.loading ? '正在搜正文…' : '没有匹配的文档';
    qoEls.list.appendChild(empty);
    qoEls.count.textContent = '';
    return;
  }

  const appendRow = (r, idx, host = qoEls.list) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quickopen-item' + (idx === qoActive ? ' active' : '')
      + (r.content ? ' is-content' : '');
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(idx === qoActive));
    btn.dataset.idx = String(idx);
    btn.dataset.path = r.file.path;
    if (r.section) btn.dataset.section = r.section;
    btn.title = r.file.relPath;
    btn.innerHTML = qoRowHtml(r, query);
    btn.addEventListener('click', () => qoOpen(idx));
    btn.addEventListener('mousemove', () => qoSetActive(idx));
    host.appendChild(btn);
  };

  // 空查询的分段（最近打开 / 收藏 / 全部文档）。段头用 .qo-section，
  // 不用 .qo-group——那是「正文命中」专用的分组头
  const QO_SECTION_TITLES = { recent: '最近打开', fav: '收藏', all: '全部文档' };
  if (nameResults.length && nameResults[0].section) {
    let idx = 0;
    for (const key of ['recent', 'fav', 'all']) {
      const rows = nameResults.filter(r => r.section === key);
      if (!rows.length) continue;
      const head = document.createElement('div');
      head.className = 'qo-section';
      head.dataset.section = key;
      head.innerHTML = `${ic(key === 'recent' ? 'clock' : key === 'fav' ? 'star' : 'layers', 11)}<span>${QO_SECTION_TITLES[key]}</span>`
        + (key === 'recent'
          ? '<button id="recent-clear" class="qo-section-act recent-clear" type="button" title="清除最近浏览记录" aria-label="清除最近浏览记录">清除</button>'
          : '');
      qoEls.list.appendChild(head);
      let host = qoEls.list;
      // 收藏超过一屏：这一段自己滚动，别把「全部文档」挤出视野
      if (key === 'fav' && rows.length > QO_SECTION_SCROLL) {
        host = document.createElement('div');
        host.className = 'qo-section-scroll';
        host.setAttribute('role', 'group');
        host.setAttribute('aria-label', QO_SECTION_TITLES[key]);
        qoEls.list.appendChild(host);
      }
      for (const r of rows) appendRow(r, idx++, host);
    }
  } else {
    nameResults.forEach((r, idx) => appendRow(r, idx));
  }

  // 正文命中单独分组，标题行说清这是"文件名没匹配上、但正文里有"
  if (contentResults.length) {
    const head = document.createElement('div');
    head.className = 'qo-group';
    head.innerHTML = `${ic('search', 11)}<span>正文命中</span>`;
    qoEls.list.appendChild(head);
    contentResults.forEach((r, i) => appendRow(r, nameResults.length + i));
  }

  // 正文搜索还在路上：给一行占位，避免结果突然多出一截时毫无预告
  if (qoContent.loading) {
    const hint = document.createElement('div');
    hint.className = 'qo-group qo-group-loading';
    hint.innerHTML = `${ic('loader', 11, 'qo-spin')}<span>正在搜正文…</span>`;
    qoEls.list.appendChild(hint);
  }

  const parts = [`${nameResults.length}${nameResults.length >= QO_LIMIT ? '+' : ''} 个文件名`];
  if (contentResults.length) {
    parts.push(`${contentResults.length}${qoContent.truncated ? '+' : ''} 篇正文`);
  }
  qoEls.count.textContent = parts.join(' · ');
}

// 正文搜索：名称组是同步的、立即出结果；这边 debounce 之后异步追加。
// 短查询不发请求——单个 ASCII 字符匹配面太广，服务端也会直接拒（termIsSearchable）
function qoScheduleContentSearch() {
  const query = qoEls.input.value.trim();
  clearTimeout(qoContentTimer);
  const searchable = parseQueryTerms(query).some(t =>
    /^[\x00-\x7F]+$/.test(t) ? t.length >= 2 : true);
  if (!searchable) {
    qoContentSeq++;                 // 作废在途请求
    qoContent.q = '';
    qoContent.matches = new Map();
    qoContent.loading = false;
    qoContent.truncated = false;
    return;
  }
  if (qoContent.q === query && !qoContent.loading) return;   // 结果已经是这个查询的
  qoContent.loading = true;
  qoContentTimer = setTimeout(async () => {
    const my = ++qoContentSeq;
    try {
      const r = await fetch('/api/search?limit=' + QO_CONTENT_LIMIT
        + '&q=' + encodeURIComponent(query));
      if (my !== qoContentSeq) return;      // 已被后续输入取代
      const data = await r.json();
      if (my !== qoContentSeq) return;
      qoContent.q = query;
      qoContent.matches = new Map(
        (data.matches || []).map(m => [m.path, { snippet: m.snippet, count: m.count || 1 }]));
      qoContent.truncated = !!data.truncated;
    } catch {
      // 搜正文失败不该让整个面板不可用：名称组仍然可用
      if (my === qoContentSeq) { qoContent.q = query; qoContent.matches = new Map(); }
    } finally {
      if (my === qoContentSeq) {
        qoContent.loading = false;
        if (qoEntry) qoRender();          // 面板还开着才重绘
      }
    }
  }, QO_CONTENT_DEBOUNCE);
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

// 快速查看开着时，⌘K 里 ↑↓ 换选中项，浮窗内容跟着换
function qoPeekRetarget() {
  if (!window.AtlasPeek || !AtlasPeek.isOpen()) return;
  const item = qoEls.list.querySelector('.quickopen-item.active[data-path]');
  if (item) AtlasPeek.retarget(item);
  else AtlasPeek.close();
}

function qoOpen(idx) {
  const r = qoResults[typeof idx === 'number' ? idx : qoActive];
  if (!r) return;
  // 正文命中：打开后直接高亮并滚到第一处，顶栏的 ▲▼ 可以继续跳
  setPendingPreviewHighlight(r.content ? r.file.path : null, qoContent.q);
  closeQuickOpen();
  openFile(r.file.path);
}

function openQuickOpen() {
  if (!qoEls.root || qoEntry) return;
  qoEls.root.classList.remove('hidden');
  qoEls.input.value = '';
  // 清掉上一次的正文结果，避免刚打开就闪一批和当前空查询无关的条目
  qoContentSeq++;
  qoContent.q = '';
  qoContent.matches = new Map();
  qoContent.loading = false;
  qoContent.truncated = false;
  clearTimeout(qoContentTimer);
  qoRender();
  qoEntry = pushModal({
    panel: qoEls.root.querySelector('.modal-panel'),
    close: closeQuickOpen,
    initialFocus: qoEls.input,
  });
}

function closeQuickOpen() {
  if (!qoEls.root) return;
  if (window.AtlasPeek) AtlasPeek.close();
  qoEls.root.classList.add('hidden');
  if (qoEntry) { popModal(qoEntry); qoEntry = null; }
}

if (qoEls.root) {
  qoEls.root.addEventListener('click', (e) => {
    if (isCloseTarget(e.target)) closeQuickOpen();
  });
  qoEls.input.addEventListener('input', () => {
    qoRender();                  // 名称组：同步，立即出结果
    qoScheduleContentSearch();   // 正文组：debounce 后异步追加
  });
  qoEls.input.addEventListener('keydown', (e) => {
    // 空状态（还没输入）时 Space = 快速查看当前选中项；输入非空时 Space 照常输入
    if (e.key === ' ' && !e.isComposing && !qoEls.input.value && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const item = qoEls.list.querySelector('.quickopen-item.active[data-path]')
        || qoEls.list.querySelector('.quickopen-item[data-path]');
      if (item) { e.preventDefault(); AtlasPeek.toggleFor(item.dataset.path, item); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); qoSetActive(qoActive + 1); qoPeekRetarget(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); qoSetActive(qoActive - 1); qoPeekRetarget(); }
    else if (e.key === 'Enter') { e.preventDefault(); AtlasPeek.close(); qoOpen(); }
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
  // 快速查看优先：Space 开关；浮窗开着时 Esc 只关浮窗，焦点留在原行
  if (e.key === ' ' && focused.classList.contains('kbd-focus')) {
    e.preventDefault();                       // .file 是 div[tabindex=-1]，默认会滚动 #tree
    AtlasPeek.toggleFor(focused.dataset.path, focused);
    return;
  }
  if (e.key === 'Escape' && AtlasPeek.isOpen()) {
    e.preventDefault();
    e.stopPropagation();                      // 不让 document 层的 Esc 链再处理一次
    AtlasPeek.close();                        // 不调 setKbdFocus(null)，不移焦点
    return;
  }
  const list = visibleFilesInOrder();
  const idx = list.indexOf(focused);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (idx < list.length - 1) {
      const newEl = list[idx + 1];
      setKbdFocus(newEl);
      if (AtlasPeek.isOpen()) AtlasPeek.retarget(newEl);
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (idx > 0) {
      const newEl = list[idx - 1];
      setKbdFocus(newEl);
      if (AtlasPeek.isOpen()) AtlasPeek.retarget(newEl);
    } else { AtlasPeek.close(); setKbdFocus(null); els.search.focus(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    AtlasPeek.close();
    openFile(focused.dataset.path);
  } else if (e.key === 'Escape') {
    // 只有真的在用键盘逐行导航（行上有 .kbd-focus）时，Escape 才是"退出列表"。
    // 鼠标点开一篇文档后焦点也会留在 .file 上（tabindex=-1 可被点击聚焦），
    // 那时不能拦——否则全局那条 Escape 阶梯永远走不到最后一级「回首页」，
    // 而"从侧栏点开文档"恰好是最常见的动线
    if (!focused.classList.contains('kbd-focus')) return;
    e.preventDefault();
    // 拦住冒泡，别让全局 Escape 顺带把文档也关掉
    e.stopPropagation();
    setKbdFocus(null);
    els.search.focus();
  }
});

// ---------- 设置弹窗 ----------
async function openSettings() {
  const res = await fetch('/api/config');
  const cfg = await res.json();
  // 版本号：桌面 App 标注"桌面版"并显示 App bundle 的权威版本号（app.getVersion），
  // 而不是 /api/config 的 pkg.version——后者在复用了旧 CLI 守护进程时会是旧值，
  // 造成"升级后仍显示旧版本"。浏览器 / npm 用户仍用服务端返回的版本。
  const isDesktop = !!(window.atlasDesktop && window.atlasDesktop.isDesktop);
  const verEl = document.getElementById('settings-version');
  if (verEl) {
    let ver = cfg.version || '';
    if (isDesktop && window.atlasDesktop.appVersion) {
      try { const av = await window.atlasDesktop.appVersion(); if (av) ver = av; } catch {}
    }
    const v = ver ? `Atlas v${ver}` : '';
    verEl.textContent = (v && isDesktop) ? `${v} · 桌面版` : v;
  }
  // 桌面版：挂载「检查更新」控件（检查 / 下载进度 / 一键重启安装）。浏览器 / npm 版保持隐藏。
  if (isDesktop) setupDesktopUpdateUI();
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
  if (els.trustAllToggle) {
    els.trustAllToggle.checked = !!cfg.trustAllHtml;
    state.trustAllHtml = !!cfg.trustAllHtml;
  }
  // 文档类型多选：反映当前启用的类型（数组，可共存）
  const enabled = Array.isArray(cfg.docTypes) && cfg.docTypes.length ? cfg.docTypes : ['html'];
  els.doctypeRadios.forEach(cb => { cb.checked = enabled.includes(cb.value); });
  lastDocTypes = enabled.slice();
  updateTransparencyNote();
  els.modal.classList.remove('hidden');
  gotoSettingsPane(settingsPane);
  if (!settingsModalEntry) {
    settingsModalEntry = pushModal({
      panel: els.modal.querySelector('.modal-panel'),
      close: closeSettings,
    });
  }
}

// ---------- 设置弹窗的分区导航 ----------
// 每个 .modal-section 上有 data-pane，点左侧导航只显示对应那组。
// 记住上次看的分区：改扫描根往往要连着改好几次，每次都跳回第一屏很烦。
let settingsPane = 'scan';
function gotoSettingsPane(pane) {
  const items = els.modal.querySelectorAll('.settings-nav-item');
  if (!items.length) return;
  const known = [...items].some(b => b.dataset.goto === pane);
  settingsPane = known ? pane : 'scan';
  items.forEach(b => {
    const on = b.dataset.goto === settingsPane;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  els.modal.querySelectorAll('.modal-section[data-pane]').forEach(sec => {
    sec.hidden = sec.dataset.pane !== settingsPane;
  });
  const content = document.getElementById('settings-content');
  if (content) content.scrollTop = 0;
}
document.querySelectorAll('.settings-nav-item').forEach(btn => {
  btn.addEventListener('click', () => gotoSettingsPane(btn.dataset.goto));
});

// ---------- 主题 ----------
// 三态：system（不设 data-theme，由 CSS 的 color-scheme: light dark 跟随系统）/ light / dark。
// 所有配色都写成 light-dark(浅, 深)，所以切换只需要改根节点的 color-scheme——
// 不用维护两份色板，iframe 里的预览页也会跟着变（used color scheme 会传播给子文档）。
// 用户在设置里切主题：整页交叉淡入（View Transition，kind 'theme'，约 240ms）代替一次性硬切。
//   · 切换期间 html.theme-switching 关掉所有零散的颜色 transition：它们以前各跑各的 120ms，
//     被主线程卡住后过一会儿"又跳一下"（diagnosis §6）；快照里拿到的必须是终值
//   · 原生材质（nativeTheme）在过渡开始时同步切，和网页同一时刻变
//   · 换封面缩略图、重载 MD 预览这类网络 / 重渲染的活放到过渡结束之后，不污染淡入
//   · reduced-motion / 自动化环境：withViewTransition 自己降级为同步硬切
let themeSwitchSeq = 0;
function switchTheme(mode) {
  crossfadeAppearance(() => applyTheme(mode, { deferHeavy: true }), { theme: mode });
}
// 主题 / 界面色调共用：fn 在过渡的更新回调里执行（或降级时同步执行）
function crossfadeAppearance(fn, detail) {
  const root = document.documentElement;
  const seq = ++themeSwitchSeq;
  root.classList.add('theme-switching');
  let applied = false;
  const apply = () => { applied = true; fn(); };
  withViewTransition(apply, 'theme');
  const settle = () => {
    if (seq !== themeSwitchSeq) return;
    root.classList.remove('theme-switching');
    themeHeavyRefresh();
    try { window.dispatchEvent(new CustomEvent('atlas:theme-settled', { detail: detail || {} })); } catch {}
  };
  if (vtActive && vtActive.finished) {
    vtActive.finished.then(settle, settle);
  } else {
    if (!applied) apply();
    // 同步硬切：等两帧（样式已提交、颜色已是终值）再恢复 transition
    requestAnimationFrame(() => requestAnimationFrame(settle));
  }
}
// 主题切换后才做的重活：可见封面换新主题的缩略图；正在预览的 MD 换带 theme 的 src 重新渲染
let themeHeavyPending = false;
function themeHeavyRefresh() {
  if (!themeHeavyPending) return;
  themeHeavyPending = false;
  const f = state.files[state.activeFilePath];
  if (f && isMdFile(f) && !editState.active) {
    const url = previewUrlFor(f);
    if (els.preview.getAttribute('src') !== url) els.preview.src = url;
  }
  refreshThumbsForTheme();
}
function applyTheme(mode, { deferHeavy = false } = {}) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
  else { root.removeAttribute('data-theme'); mode = 'system'; }
  try { localStorage.setItem('atlas:theme', mode); } catch {}
  document.querySelectorAll('[data-theme-pick]').forEach(b => {
    const on = b.dataset.themePick === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  // 桌面版：主题同步给 nativeTheme.themeSource，vibrancy 材质才跟着 Atlas 主题走
  // （浏览器里没有这个桥，可选链即 no-op）。启动时下面那次 applyTheme 也会走到这里
  window.atlasDesktop?.setTheme?.(mode);
  // 正在预览 md 时要换 src（theme 在 URL 上），换完预览页才会重新渲染；
  // 缩略图按外观各存一份：可见封面换成新主题的图 / 重新请求。
  // 普通 HTML 文档的配色由文档自己决定，Atlas 不干预，也就不用动。
  themeHeavyPending = true;
  if (!deferHeavy) themeHeavyRefresh();
}
document.querySelectorAll('[data-theme-pick]').forEach(btn => {
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'system';
    if (btn.dataset.themePick === cur) return;
    switchTheme(btn.dataset.themePick);
  });
});
applyTheme(localStorage.getItem('atlas:theme') || 'system');
// 跟随系统时，系统外观切换也要换封面缩略图
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!forcedTheme()) refreshThumbsForTheme();
  });
} catch {}

// ---------- 界面色调（冷 / 暖 中性皮肤） ----------
// 只切换中性色令牌（[data-skin]），主色 / 品牌 / 封面色不变，和浅/深主题正交。
// 防闪由 index.html 顶部内联脚本负责（和主题同理）。
function applySkin(mode) {
  const root = document.documentElement;
  if (mode === 'warm') root.setAttribute('data-skin', 'warm');
  else { root.removeAttribute('data-skin'); mode = 'cool'; }
  try { localStorage.setItem('atlas:skin', mode); } catch {}
  document.querySelectorAll('[data-skin-pick]').forEach(b => {
    const on = b.dataset.skinPick === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}
document.querySelectorAll('[data-skin-pick]').forEach(btn => {
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-skin') === 'warm' ? 'warm' : 'cool';
    if (btn.dataset.skinPick === cur) return;
    crossfadeAppearance(() => applySkin(btn.dataset.skinPick), { skin: btn.dataset.skinPick });
  });
});
applySkin(localStorage.getItem('atlas:skin') || 'cool');
// ---------- 界面动效（跟随系统 / 减少） ----------
// 「减少」= html[data-motion="reduce"]：CSS 侧所有 --dur-* 与 --stagger 归零、授权块里的动画不生效；
// JS 侧 prefersReducedMotion() 返回 true。它只能比系统更安静：选「跟随系统」时由系统偏好决定。
// 防闪由 index.html 顶部内联脚本负责（和主题同理）。
function notifyMotionChange() {
  // 切到「减少」时进行中的过渡直接跳到终态
  if (prefersReducedMotion() && vtActive) { try { vtActive.skipTransition(); } catch {} }
  try {
    window.dispatchEvent(new CustomEvent('atlas:motion-change', { detail: { reduce: prefersReducedMotion() } }));
  } catch {}
}
function applyMotion(mode) {
  const root = document.documentElement;
  if (mode === 'reduce') root.setAttribute('data-motion', 'reduce');
  else { root.removeAttribute('data-motion'); mode = 'system'; }
  try {
    if (mode === 'reduce') localStorage.setItem('atlas:motion', 'reduce');
    else localStorage.removeItem('atlas:motion');
  } catch {}
  document.querySelectorAll('[data-motion-pick]').forEach(b => {
    const on = b.dataset.motionPick === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  notifyMotionChange();
}
document.querySelectorAll('[data-motion-pick]').forEach(btn => {
  btn.addEventListener('click', () => applyMotion(btn.dataset.motionPick));
});
applyMotion(localStorage.getItem('atlas:motion') === 'reduce' ? 'reduce' : 'system');
// 运行中切换系统「减少动态效果」：立即生效（进行中的过渡直接跳到终态，持续循环由监听方停下）
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.addEventListener) mq.addEventListener('change', notifyMotionChange);
  else if (mq.addListener) mq.addListener(notifyMotionChange);
}
// 桌面版：全屏时红绿灯消失，撤掉顶栏的红绿灯避让内边距（见 styles.css 桌面版段）
// 设置「外观」里的「侧栏透明度」状态行（只在桌面版显示，见 index.html #transparency-section）
function reduceTransparencyOn() {
  if (document.documentElement.classList.contains('reduce-transparency')) return true;
  try { return window.matchMedia('(prefers-reduced-transparency: reduce)').matches; } catch { return false; }
}
function updateTransparencyNote() {
  const el = document.getElementById('transparency-status');
  if (!el) return;
  el.textContent = reduceTransparencyOn()
    ? '当前：系统已开启「降低透明度」，侧栏为实底。'
    : '当前：未开启「降低透明度」，侧栏透出桌面背景。';
}
try {
  const mqt = window.matchMedia('(prefers-reduced-transparency: reduce)');
  if (mqt.addEventListener) mqt.addEventListener('change', updateTransparencyNote);
} catch {}

// 桌面版：标出当前吸顶、盖在滚动内容上的那个顶层分组头（.is-stuck）。侧栏是半透明的，
// 静息的分组头必须透明（否则在材质上盖出一块块实底补丁），只有吸顶的那一个需要遮住下方行
var stuckRaf = 0;      // var：render() 可能早于这里执行（避免 TDZ）
var stuckHeader = null;
function updateStuckHeader() {
  stuckRaf = 0;
  if (!els.tree) return;
  let hit = null;
  if (els.tree.scrollTop > 0) {
    const top = els.tree.getBoundingClientRect().top;
    for (const f of els.tree.children) {
      if (!f.classList.contains('folder')) continue;
      const r = f.getBoundingClientRect();
      if (r.top < top - 0.5 && r.bottom > top + 1) { hit = f.querySelector(':scope > .folder-header'); break; }
      if (r.top >= top) break;
    }
  }
  if (hit === stuckHeader) return;
  if (stuckHeader) stuckHeader.classList.remove('is-stuck');
  if (hit) hit.classList.add('is-stuck');
  stuckHeader = hit;
}
function scheduleStuckHeader() {
  if (!document.documentElement.hasAttribute('data-desktop')) return;
  if (!stuckRaf) stuckRaf = requestAnimationFrame(updateStuckHeader);
}
els.tree.addEventListener('scroll', scheduleStuckHeader, { passive: true });

// 系统「降低透明度」由主进程从 nativeTheme 读出推过来（与 CSS 的 prefers-reduced-transparency 互为兜底）
window.atlasDesktop?.onWindowState?.((s) => {
  const root = document.documentElement;
  root.classList.toggle('is-fullscreen', !!(s && s.fullscreen));
  applySidebarWidth();   // 退出全屏后红绿灯内边距回来，偏好宽度过窄时撑到放得下
  if (s && typeof s.reducedTransparency === 'boolean') {
    root.classList.toggle('reduce-transparency', s.reducedTransparency);
    updateTransparencyNote();
  }
});

// ---------- 顶栏「更多」菜单 ----------
// 菜单项（新标签打开 / 访达 / 复制路径）各自的动作由原按钮监听器处理，
// 这里只管开合。closeMoreMenu 供 goHome 调用（回首页时收掉）。
function closeMoreMenu() {
  if (!els.tbMoreMenu || els.tbMoreMenu.classList.contains('hidden')) return;
  els.tbMoreMenu.classList.add('hidden');
  if (els.btnMore) els.btnMore.setAttribute('aria-expanded', 'false');
}
function toggleMoreMenu() {
  if (!els.tbMoreMenu || !els.btnMore || els.btnMore.disabled) return;
  const willOpen = els.tbMoreMenu.classList.contains('hidden');
  els.tbMoreMenu.classList.toggle('hidden', !willOpen);
  els.btnMore.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}
if (els.btnMore) {
  els.btnMore.addEventListener('click', (e) => { e.stopPropagation(); toggleMoreMenu(); });
}
if (els.tbMoreMenu) {
  els.tbMoreMenu.addEventListener('click', () => closeMoreMenu());
}
if (els.tbMore) {
  // Esc 先关菜单，别让它顺着全局 Esc 阶梯把文档也关掉（焦点此时在触发器上，冒泡经过 tb-more）
  els.tbMore.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.tbMoreMenu && !els.tbMoreMenu.classList.contains('hidden')) {
      e.stopPropagation();
      closeMoreMenu();
      els.btnMore.focus();
    }
  });
}
// 点菜单以外任何地方都收起
document.addEventListener('click', (e) => {
  if (els.tbMore && !(e.target.closest && e.target.closest('#tb-more'))) closeMoreMenu();
});

// ---------- 安全：全局信任开关 ----------
if (els.trustAllToggle) {
  els.trustAllToggle.addEventListener('change', async () => {
    const next = els.trustAllToggle.checked;
    // 关掉沙箱是放宽安全边界，值得一次确认——它一次性影响所有文档
    if (next) {
      const ok = await showConfirm({
        title: '信任所有本地 HTML？',
        body: '打开后每一篇 HTML 都以同源方式加载，文档里的脚本能调用 Atlas 的接口，'
          + '包括改写磁盘上的其它文档和生成局域网分享链接。'
          + '只在你确定扫描根里全是自己产出的内容时才这么做。',
        confirmText: '我了解，打开',
        danger: true,
      });
      if (!ok) { els.trustAllToggle.checked = false; return; }
    }
    const okSaved = await updateConfig({ trustAllHtml: next });
    if (!okSaved) { els.trustAllToggle.checked = !next; return; }
    state.trustAllHtml = next;
    updateTrustButton();
    // 当前正在看的文档要按新规则重新加载一次
    const f = state.files[state.activeFilePath];
    if (f && isSandboxableType(f) && !editState.active) {
      if (applyPreviewSandbox(f)) reloadPreviewSandboxed(previewUrlFor(f));
    }
    showToast(next
      ? { kind: 'info', text: '已信任所有本地 HTML', secondary: '沙箱预览已关闭' }
      : { kind: 'success', text: '已恢复沙箱预览', secondary: '单篇信任记录仍然有效' });
  });
}
if (els.trustClearBtn) {
  els.trustClearBtn.addEventListener('click', async () => {
    const ok = await showConfirm({
      title: '清空单篇信任记录？',
      body: '所有此前被单独信任的 HTML 都会回到沙箱预览。这不影响上面那个全局开关。',
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/trust/clear', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      state.trusted = new Set();
      updateTrustButton();
      const f = state.files[state.activeFilePath];
      if (f && isSandboxableType(f) && !editState.active) {
        if (applyPreviewSandbox(f)) reloadPreviewSandboxed(previewUrlFor(f));
      }
      showToast({ kind: 'success', text: '已清空信任记录', secondary: `${data.cleared || 0} 篇回到沙箱` });
    } catch {
      showToast({ kind: 'error', text: '清空失败' });
    }
  });
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

    // 平滑刷新：当前预览文件失效时的复位现在由 fetchState 统一处理
    // （原来这里内联了一份，漏了关对比面板和收回顶栏按钮）
    await fetchState();
    setScanning(false);
    t.close();
    // 按固定顺序列出启用的类型，而不是用户勾选的顺序——同一组选择每次
    // 看到的文案要一样，否则会让人以为顺序有什么含义
    const label = ['html', 'md', 'csv', 'json', 'txt', 'svg']
      .filter(t => checked.includes(t))
      .map(t => ({ html: 'HTML', md: 'Markdown', csv: 'CSV', json: 'JSON', txt: '文本', svg: 'SVG' })[t])
      .join(' + ');
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
      metaParts.push(mins > 60 ? `${Math.floor(mins / 60)}时后过期` : (mins > 0 ? `${mins}分后过期` : '已过期'));
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
        updateSharedDecorations();
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
    updateSharedDecorations();
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
  if (isCloseTarget(e.target)) closeSettings();
});

function renderRootList(roots) {
  els.rootList.innerHTML = '';
  roots.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="root-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
      <button data-remove title="移除这个扫描根" aria-label="移除这个扫描根">${ic('x', 12)}</button>
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

// 添加扫描根前的体量护栏：估算目录下的文档数，很大就先确认。估算失败 / 目录不大
// 都直接放行（返回 true），不打扰正常操作。阈值 5000：远低于索引硬上限，够早地
// 拦住"手滑把整块磁盘 / home 加进来"。
const WARN_SCAN_FILES = 5000;
async function confirmLargeScanRoot(dir) {
  let est = null;
  try {
    const r = await fetch('/api/estimate-scan?path=' + encodeURIComponent(dir));
    if (r.ok) est = await r.json();
  } catch {}
  if (!est || typeof est.count !== 'number') return true;   // 估算不出来就不拦
  const big = est.capped || est.count >= WARN_SCAN_FILES;
  if (!big) return true;
  const approx = est.capped ? `超过 ${est.count.toLocaleString()}` : `约 ${est.count.toLocaleString()}`;
  const cap = (est.maxIndexFiles || 50000).toLocaleString();
  return await showConfirm({
    title: '这个目录很大',
    body: `「${dir}」下${approx} 篇可扫描文档。\n\n`
      + `扫描和监听这么大的目录会更慢、更占内存，且 Atlas 最多收录 ${cap} 篇，超出的不会纳入。\n\n`
      + `建议收窄到更具体的子目录，或在设置里补充"忽略的目录名"。仍要添加吗？`,
    confirmText: '仍要添加',
    danger: true,
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
  if (!(await confirmLargeScanRoot(v))) return;
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
      div.innerHTML = `<span class="dir-icon">${ic('folder', 13)}</span><span>${escapeHtml(entry.name)}</span>`;
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
// 每个浏览器 tab 都会开一条到 /api/events 的长连接。浏览器对同源 HTTP/1.1 只给 6 条
// 并发连接，后台 tab 若一直占着这条 SSE，开到第 6 个 tab 时连接池就满了：新 tab 想拉
// /api/state 或加载预览 iframe 都排不进队 —— 表现为"tab 一开多，新 tab 打不开文档"。
//
// 解法：只有当前可见的 tab 才持有 SSE，切到后台立刻 disconnectSSE 释放这个连接槽，
// 回到前台再重连（见页面底部的 visibilitychange）。单窗口下任一时刻只有一个 tab 可见，
// 于是同时占用的 SSE 永远≈1 条，tab 数量再多也打不满连接池，等于没有上限。
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
    // 缩略图完成 / 失败 / 被挤出：只更新对应卡片，不当成文件事件（不弹通知、不整包重拉）
    if (data.channel === 'thumb') { onThumbReady(data); return; }
    // 引用关系索引版本变了：星图 / 迷你星图用过的话重拉一次 /api/links（不触发 fetchState）
    if (data.channel === 'links') { onLinksEvent(data); return; }

    // 文件系统事件（旧 fs 流，兼容没 channel 的旧 payload）
    if (data.kind === 'add') {
      notify('📄 新文档', `${data.projectName} / ${data.name}`);
    } else if (data.kind === 'change') {
      notify('✏️ 文档已更新', `${data.projectName} / ${data.name}`);
    }
    // 「AI 刚改过」：只收不是 Atlas 自己写的（保存 / 还原 / 重命名的负载带 self:true）
    if ((data.kind === 'add' || data.kind === 'change') && data.self !== true) {
      markJustChanged(data.path);
    }
    // 时间河流：按 data.mtime 追加到活动日志的本地副本（self 事件也追加：'save' 是覆盖标记、
    // 'rename' 是计数事件，与服务端同一张分类表），然后同步重算时间段
    if (data.kind === 'add' || data.kind === 'change') onRiverSseEvent(data);
    if (pendingRefresh) clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(() => { pendingRefresh = null; fetchState(); }, 400);
  };
  // 首连与重连成功都会触发
  es.onopen = () => {
    if (evtSrc !== es) return;
    setLiveStatus('live');
    // 断线期间可能漏掉 thumb ready：把 queued 条目删掉，下次可见时重新问一次状态
    // （服务端已完成的会直接回 ready，不会重截）
    for (const [k, it] of state.thumbs.items) {
      if (it.status === 'queued') state.thumbs.items.delete(k);
    }
    thumbReqSig.clear();
  };
  es.onerror = () => {
    // 已被后来的实例取代：这是条僵尸连接，关掉就好，不参与重连排程
    if (evtSrc !== es) { try { es.close(); } catch {} return; }
    // EventSource 自身也会尝试自动重连，这里先彻底关闭，重连统一由我们排程，
    // 避免"浏览器自动重连 + 手动重连"两条连接叠加
    try { es.close(); } catch {}
    evtSrc = null;
    if (sseRetryTimer) { setLiveStatus('retry'); return; }   // 已有重连在排队，不重复排
    // 后台 tab 不排重连：连接槽要留给可见 tab，回前台时再由 visibilitychange 统一重连
    if (document.hidden) { setLiveStatus('off'); return; }
    sseRetryTimer = setTimeout(() => { sseRetryTimer = null; connectSSE(); }, 3000);
    setLiveStatus('retry');
  };
}

// 切到后台时调用：关掉 SSE 并作废待重连的 timer，把这条连接槽还给浏览器连接池。
// 关闭的是"我们主动 close"，不会触发 onerror，也就不会排重连。
function disconnectSSE() {
  if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
  if (evtSrc) { try { evtSrc.close(); } catch {} evtSrc = null; }
  setLiveStatus('off');
}

// 侧栏底栏 #live-status：live（已连接）/ retry（重连中）/ off（页面在后台，已暂停）。
// 不加 role="status"，免得断线重连时反复播报；读屏文案写在 .sr-only 里。
const LIVE_STATUS_TEXT = {
  live:  { hud: '实时',   title: '实时更新：已连接',             sr: '实时更新已连接' },
  retry: { hud: '重连中', title: '实时更新：连接中断，正在重连', sr: '实时更新连接中断，正在重连' },
  off:   { hud: '已暂停', title: '实时更新：页面在后台，已暂停', sr: '实时更新已暂停' },
};
function setLiveStatus(s) {
  const el = document.getElementById('live-status');
  const t = LIVE_STATUS_TEXT[s];
  if (!el || !t || el.dataset.state === s) return;
  el.dataset.state = s;
  el.title = t.title;
  const hud = el.querySelector('.hud');
  const sr = el.querySelector('.sr-only');
  if (hud) hud.textContent = t.hud;
  if (sr) sr.textContent = t.sr;
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
  // 桌面 App 有自己的自动更新（electron-updater），这条"npm i -g 升级"的提示对它是错的，直接不显示
  if (window.atlasDesktop && window.atlasDesktop.isDesktop) return;
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

// ---------- 桌面版「检查更新」控件（electron-updater，仅桌面 App） ----------
// 与上面的 npm banner 是两套机制：桌面版走 preload 暴露的 window.atlasDesktop.updates
// （检查 → 后台下载 → 一键重启安装），npm 版走 /api/self-upgrade。设置弹窗里只对桌面版显示。
let desktopUpdateBound = false;
function setupDesktopUpdateUI() {
  const wrap = document.getElementById('settings-update');
  const btn = document.getElementById('settings-update-btn');
  if (!wrap || !btn || !window.atlasDesktop || !window.atlasDesktop.updates) return;
  wrap.classList.remove('hidden');

  if (!desktopUpdateBound) {
    desktopUpdateBound = true;
    btn.addEventListener('click', async () => {
      // 已下载完成 → 这个按钮是"重启以更新"
      if (btn.dataset.mode === 'install') {
        renderDesktopUpdateStatus({ state: 'installing' });
        try { await window.atlasDesktop.updates.quitAndInstall(); } catch (e) {
          renderDesktopUpdateStatus({ state: 'error', error: e && e.message });
        }
        return;
      }
      // 否则触发一次检查
      renderDesktopUpdateStatus({ state: 'checking' });
      try {
        const r = await window.atlasDesktop.updates.check();
        if (r) renderDesktopUpdateStatus(r);
      } catch (e) {
        renderDesktopUpdateStatus({ state: 'error', error: e && e.message });
      }
    });
    // 订阅主进程推送（下载进度 / 完成 / 错误），进度实时反映在按钮与状态文字上
    window.atlasDesktop.updates.onStatus((s) => renderDesktopUpdateStatus(s));
  }
  // 打开设置时同步一次当前状态（可能后台已检查到更新）
  window.atlasDesktop.updates.getState().then((s) => { if (s) renderDesktopUpdateStatus(s); }).catch(() => {});
}

function renderDesktopUpdateStatus(s) {
  const btn = document.getElementById('settings-update-btn');
  const statusEl = document.getElementById('settings-update-status');
  if (!btn || !statusEl) return;
  const state = (s && s.state) || 'idle';
  // 默认复位成"检查更新"，各状态下再覆盖
  btn.dataset.mode = 'check';
  btn.disabled = false;
  btn.textContent = '检查更新';
  statusEl.classList.remove('is-error');
  switch (state) {
    case 'checking':
      btn.disabled = true; btn.textContent = '检查中…';
      statusEl.textContent = '正在检查最新版本…';
      break;
    case 'downloading':
      btn.disabled = true; btn.textContent = '下载中…';
      statusEl.textContent = (s.version ? `正在下载 ${s.version}` : '正在下载新版本')
        + (s.percent ? ` · ${s.percent}%` : '…');
      break;
    case 'downloaded':
      btn.dataset.mode = 'install';
      btn.textContent = '重启以更新';
      statusEl.textContent = s.version
        ? `${s.version} 已就绪，点击重启即可用上新版本`
        : '新版本已就绪，点击重启安装';
      break;
    case 'installing':
      btn.disabled = true; btn.textContent = '重启中…';
      statusEl.textContent = '正在退出并安装…';
      break;
    case 'not-available':
      statusEl.textContent = `已是最新版本${s.current ? `（v${s.current}）` : ''}`;
      break;
    case 'unsupported':
      statusEl.textContent = '开发模式不支持自动更新';
      break;
    case 'error':
      statusEl.classList.add('is-error');
      statusEl.textContent = '检查失败：' + (s.error || '未知错误');
      break;
    default:
      statusEl.textContent = '';
  }
}

// 唯一的 60 秒定时器：先 tickMinute()（首页时钟 / 星图档位随时间变暗 / 跨整点标记），再 fetchState()
// 正赶上侧栏收起 / 展开动画时，等动画落定再做：这次整包重拉 + 重渲染曾和 60.1s 那次收起撞在
// 同一段，掉了 14 帧（client-fix 第 2 轮冷启动探针）。后台兜底刷新晚 ~200ms 无感。
setInterval(() => {
  if (document.hidden) return;
  const run = () => { tickMinute(); fetchState(); };
  if (document.body.classList.contains('sidebar-animating')) window.addEventListener('atlas:sidebar-settled', run, { once: true });
  else run();
}, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // 切到后台：释放 SSE 连接槽，避免后台 tab 一多就把 6 条连接池占满
    disconnectSSE();
    return;
  }
  tickMinute();
  // 回到前台：没连接就重连，并补拉一次最新状态（补上后台断连期间漏掉的文件系统事件）
  if (!evtSrc) connectSSE();
  fetchState();
});

// ==================== 星图（design §3a / §10.1–10.3 / §10.9） ====================
// 星图是第三种视图，但它不在侧栏里：选中「星图」时主区的首页表面从封面墙换成星图，
// 侧栏照旧渲染 listView 那种列表。星图模块（starmap.js）不读 state，数据由这里喂给它。
// 这一段的模块级状态用 var：render() / fetchState() 可能在脚本加载早期就被调用
var stateLoaded = false;            // 第一次 /api/state 成功之后才显示"还没有星星"
var starmapShown = false;           // 上一次 syncStarmapPresence 看到的可见性
var starmapFilesRef = null;         // 上次喂给星图的 state.files（对象身份）
var starmapJcVer = -1;
var pendingHourRecompute = false;   // 60 秒那一拍跨了整点（只在这条路径上合并）
var lastHourStamp = Math.floor(Date.now() / 3_600_000);
var minimapSig = null;
var minimapFirstDone = false;   // 启动后第一次绘制已完成（之前的那次延后到空闲）
var minimapIdle = 0;
var minimapRenders = 0;        // 实际绘制次数（spec 用：侧栏切换一次最多重画一次）
try { Object.defineProperty(window, '__atlasMinimapRenders', { get: () => minimapRenders }); } catch {}
var starmapCatalog = { project: null, limit: 200 };
var starmapLinks = { needed: false, loaded: false, loading: false, again: false, version: -1, tries: 0, timer: null };
var canvasPeekPath = null;

function starmapAvailable() { return !!window.AtlasStarmap; }
function starmapCanDraw() { return starmapAvailable() && AtlasStarmap.canDraw(); }
// 星图此刻是否真的显示在主区上
function starmapVisible() {
  return state.viewMode === 'map' && starmapAvailable() && !state.activeFilePath
    && !!els.starmapView && !els.starmapView.classList.contains('hidden')
    && !els.emptyState.classList.contains('hidden');
}

// 首页表面的唯一切换点：goHome 的过渡体、selectView、启动时都调它
function showHomeSurface() {
  const map = state.viewMode === 'map' && starmapAvailable();
  if (els.home) els.home.classList.toggle('hidden', map);
  if (els.starmapView) els.starmapView.classList.toggle('hidden', !map);
  els.emptyState.classList.toggle('is-map', map);
  if (!state.activeFilePath) els.crumbs.innerHTML = crumbHomePlaceholderHtml();
  if (map) refreshStarmap(true); else renderHome();
  syncStarmapPresence();
}

// 可见性变化时：通知星图模块（开 / 停绘制循环），并处理进出星图的侧栏自动收起
function syncStarmapPresence() {
  const vis = starmapVisible();
  if (vis === starmapShown) return;
  starmapShown = vis;
  if (starmapAvailable()) AtlasStarmap.setVisible(vis && starmapCanDraw());
  if (vis) autoCollapseSidebarForStarmap();
  else restoreSidebarAfterStarmap();
}

// ---------- 进星图自动收起侧栏（§10.3） ----------
function showAutoCollapseNote(on) {
  if (els.autoCollapseNote) els.autoCollapseNote.classList.toggle('hidden', !on);
}
function autoCollapseSidebarForStarmap() {
  if (document.body.classList.contains('sidebar-collapsed')) {
    // 偏好本来就是收起：保持收起，离开时也不动
    state.sidebarAutoCollapsed = false;
    return;
  }
  toggleSidebar(true, { auto: true });
  state.sidebarAutoCollapsed = true;
  showAutoCollapseNote(true);
}
function restoreSidebarAfterStarmap() {
  showAutoCollapseNote(false);
  if (!state.sidebarAutoCollapsed) return;
  state.sidebarAutoCollapsed = false;
  toggleSidebar(false, { auto: true });
}

// ---------- 数据 ----------
// 与侧栏同口径：state.files 已由服务端排除归档分组
function starmapRows() {
  const out = [];
  for (const f of Object.values(state.files)) {
    out.push({
      path: f.path,
      name: f.alias || stripDocExt(f.name),
      project: f.projectName || '',
      mtime: f.mtime || 0,
      unread: !!f.unread,
      fresh: isFreshUnread(f),
      justChanged: isJustChanged(f.path),
    });
  }
  return out;
}
function starmapTruncNote() {
  if (!state.indexTruncated) return '';
  const cap = state.maxIndexFiles || 0;
  const capText = cap && cap % 10_000 === 0 ? `${cap / 10_000} 万` : cap.toLocaleString();
  return `（已达 ${capText}篇上限，部分未纳入）`;
}
// 把最新的数据 / 筛选推给星图，并刷新 HUD 之外由 app.js 负责的几块（筛选状态、星表、空态）
function refreshStarmap(force = false) {
  if (!starmapAvailable() || !els.starmapView) return;
  if (force || state.files !== starmapFilesRef || jcVersion !== starmapJcVer) {
    starmapFilesRef = state.files;
    starmapJcVer = jcVersion;
    AtlasStarmap.setData(starmapRows());
  }
  const snap = filterSnapshot();
  AtlasStarmap.setFilter(snap.active ? snap.hits : null);
  AtlasStarmap.setNote(starmapTruncNote());
  const total = Object.keys(state.files).length;
  const canDraw = starmapCanDraw();
  els.starmapView.classList.toggle('no-canvas', !canDraw);
  if (els.starmapNoCanvas) els.starmapNoCanvas.classList.toggle('hidden', canDraw);
  if (els.starmapEmpty) els.starmapEmpty.classList.toggle('hidden', !(stateLoaded && total === 0));
  updateStarmapFilterStatus(snap);
  renderStarmapCatalog();
  ensureStarmapLinks();
}
function updateStarmapFilterStatus(snap) {
  const el = els.starmapFilterStatus;
  if (!el) return;
  if (!snap.active) {
    el.classList.add('hidden');
    el.textContent = '';
    delete el.dataset.hits;
    return;
  }
  const items = [];
  if (state.onlyUnread) items.push('只看未读');
  if (state.tagFilter.size) items.push(`标签「${[...state.tagFilter].join('、')}」`);
  if (state.search) items.push(`搜索「${state.search}」`);
  if (state.timeRange) items.push(`⏱ ${AtlasRiver.fmtRange(state.timeRange)}`);
  const sep = '<span class="sep" aria-hidden="true"> · </span>';
  el.innerHTML = `<span class="hud">筛选中</span>${sep}`
    + items.map(t => `<span>${escapeHtml(t)}</span>`).join(sep)
    + `${sep}<span>命中 <b>${snap.size.toLocaleString()}</b> / ${snap.total.toLocaleString()}</span>`
    + `${sep}<span class="where">在侧栏中修改</span>`;
  el.dataset.hits = String(snap.size);
  el.classList.remove('hidden');
}

// ---------- 引用关系 ----------
function ensureStarmapLinks() {
  starmapLinks.needed = true;
  if (!starmapLinks.loaded && !starmapLinks.loading && !starmapLinks.timer) loadStarmapLinks();
}
async function loadStarmapLinks() {
  if (!starmapAvailable()) return;
  if (starmapLinks.loading) { starmapLinks.again = true; return; }
  starmapLinks.loading = true;
  let ok = false;
  try {
    const res = await fetch('/api/links', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (res.status === 202) throw new Error('not-ready');   // 首轮解析未完成（服务端 202 { ready:false }）
    const data = await res.json();
    starmapLinks.loaded = true;
    starmapLinks.version = data.version;
    starmapLinks.tries = 0;
    AtlasStarmap.setLinks(data);
    ok = true;
  } catch {
    // 未就绪（503）或失败：星图照常渲染、不画线，图例显示「引用关系暂不可用」；
    // 之后由 SSE 'links' 或有限次重试补上
    starmapLinks.loaded = false;
    AtlasStarmap.setLinks(null);
    if (starmapLinks.tries < 10 && !starmapLinks.timer) {
      starmapLinks.tries++;
      starmapLinks.timer = setTimeout(() => { starmapLinks.timer = null; loadStarmapLinks(); }, 2000);
    }
  } finally {
    starmapLinks.loading = false;
  }
  if (ok) { minimapSig = null; renderMinimap(); }
  if (starmapLinks.again) { starmapLinks.again = false; loadStarmapLinks(); }
}
function onLinksEvent(data) {
  if (!starmapLinks.needed) return;
  if (data && data.version === starmapLinks.version && starmapLinks.loaded) return;
  if (starmapLinks.timer) { clearTimeout(starmapLinks.timer); starmapLinks.timer = null; }
  starmapLinks.tries = 0;
  loadStarmapLinks();
}

// ---------- 首页迷你星图（§10.1） ----------
function renderMinimap() {
  const btn = els.homeMinimap;
  if (!btn || !els.homeMinimapCanvas) return;
  const total = Object.keys(state.files).length;
  const ok = starmapCanDraw() && total > 0;
  btn.classList.toggle('hidden', !ok);
  if (!ok) return;
  // 不在屏上（星图模式 / 文档态）时不画；回到封面墙时 renderHome 会再来
  if ((els.home && els.home.classList.contains('hidden')) || els.emptyState.classList.contains('hidden')) return;
  ensureStarmapLinks();
  const rows = starmapRows();
  const sig = AtlasStarmap.signature(rows) + '|' + starmapLinks.version + '|' + els.homeMinimapCanvas.clientWidth;
  if (sig === minimapSig) return;
  // 启动后的第一次延后到浏览器空闲（最多 1.2s）：首个 /api/state 已经要同步建整棵树和首页，
  // 迷你星图（全量布局 + 画布）与它挤在同一帧会把启动期的长帧再拉长（diagnosis §2）
  if (minimapSig === null && !minimapFirstDone) {
    if (!minimapIdle) {
      const run = () => { minimapIdle = 0; minimapFirstDone = true; renderMinimap(); };
      minimapIdle = typeof requestIdleCallback === 'function'
        ? requestIdleCallback(run, { timeout: 1200 }) : setTimeout(run, 300);
    }
    return;
  }
  minimapSig = sig;
  minimapRenders++;
  // 与主星图同一份布局：先把数据交给星图模块（不可见时只布局、不绘制）
  starmapFilesRef = state.files;
  starmapJcVer = jcVersion;
  AtlasStarmap.setData(rows);
  AtlasStarmap.renderThumbnail(els.homeMinimapCanvas, rows);
}
if (els.homeMinimap) {
  els.homeMinimap.addEventListener('click', () => selectView('map'));
  if (typeof ResizeObserver === 'function') {
    // 尺寸变了才重画（签名里带画布宽度），并且去抖到尺寸稳定：侧栏收起 / 展开动画期间不画，
    // 动画结束（atlas:sidebar-settled）后最多画一次。以前每帧都触发、每次全量重布局 2,000+ 颗星
    let minimapRoTimer = 0;
    const minimapResized = () => {
      clearTimeout(minimapRoTimer);
      minimapRoTimer = setTimeout(() => {
        if (document.body.classList.contains('sidebar-animating')) return;   // settled 事件会再来
        if (!els.homeMinimap.classList.contains('hidden')) renderMinimap();
      }, 120);
    };
    new ResizeObserver(minimapResized).observe(els.homeMinimap);
    window.addEventListener('atlas:sidebar-settled', minimapResized);
  }
}

// ---------- 星表（§3a「可访问性」：画布的等价替代界面） ----------
function relShortTime(ts) {
  const d = Date.now() - (ts || 0);
  if (d < 3_600_000) return Math.max(1, Math.floor(d / 60_000)) + '分';
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + '时';
  return Math.floor(d / 86_400_000) + '天';
}
function starmapTier(ts) {
  return AtlasStarmap.tierOf(ts || 0, Date.now());
}
function catalogOpenPref() {
  const v = localStorage.getItem('atlas:starmapCatalog');
  if (v === 'open') return true;
  if (v === 'closed') return false;
  return window.innerWidth >= 1100;
}
function applyCatalogOpen(open) {
  if (!els.starmapView) return;
  els.starmapView.classList.toggle('catalog-collapsed', !open);
  if (els.starmapCatalogToggle) els.starmapCatalogToggle.setAttribute('aria-expanded', String(open));
}
if (els.starmapCatalogToggle) {
  applyCatalogOpen(catalogOpenPref());
  els.starmapCatalogToggle.addEventListener('click', () => {
    const open = els.starmapView.classList.contains('catalog-collapsed');
    try { localStorage.setItem('atlas:starmapCatalog', open ? 'open' : 'closed'); } catch {}
    applyCatalogOpen(open);
  });
}
if (els.starmapEmpty) {
  els.starmapEmpty.addEventListener('click', async () => {
    await openSettings();
    gotoSettingsPane('scan');
  });
}

function catalogGroups(snap) {
  const groups = new Map();
  for (const f of Object.values(state.files)) {
    const p = f.projectName || '';
    let g = groups.get(p);
    if (!g) { g = { name: p, files: [], hits: 0, unread: 0, fresh: 0, latest: 0 }; groups.set(p, g); }
    g.files.push(f);
    if (!snap.active || snap.hits.has(f.path)) g.hits++;
    if (f.unread) g.unread++;
    if (isFreshUnread(f)) g.fresh++;
    if ((f.mtime || 0) > g.latest) g.latest = f.mtime || 0;
  }
  return groups;
}
function catalogFocusKey() {
  const a = document.activeElement;
  if (!a || !els.starmapCatalogBody || !els.starmapCatalogBody.contains(a)) return null;
  if (a.dataset.path) return { sel: `.sm-star[data-path="${CSS.escape(a.dataset.path)}"]` };
  if (a.dataset.project != null) return { sel: `.sm-cluster[data-project="${CSS.escape(a.dataset.project)}"]` };
  if (a.classList.contains('cat-back')) return { sel: '.cat-back' };
  return null;
}
function renderStarmapCatalog() {
  const body = els.starmapCatalogBody;
  if (!body || !starmapAvailable()) return;
  const snap = filterSnapshot();
  const groups = catalogGroups(snap);
  const focusKey = catalogFocusKey();
  if (starmapCatalog.project != null && !groups.has(starmapCatalog.project)) {
    starmapCatalog.project = null;
    AtlasStarmap.focusPath(null);
  }
  let html = '';
  if (starmapCatalog.project == null) {
    const list = [...groups.values()].sort((a, b) =>
      ((b.hits > 0) - (a.hits > 0)) || (b.latest - a.latest) || (a.name < b.name ? -1 : 1));
    const max = Math.max(1, ...list.map(g => g.files.length));
    html = `<div class="cat-title"><span class="hud">星团 · ${list.length}</span><span class="cat-sort">按最近改动</span></div>`
      + list.map((g, i) => {
        const noHit = snap.active && !g.hits;
        const cnt = snap.active ? `${g.hits}/${g.files.length}` : String(g.files.length);
        const label = `${g.name}，${g.files.length} 篇，${g.unread} 篇未读，最近改动 ${fmtMtime(g.latest)}`
          + (snap.active ? (noHit ? '，无命中' : `，命中 ${g.hits} 篇`) : '');
        const sub = noHit
          ? '<span>无命中</span>'
          : `${g.unread ? `<span class="u">${g.unread} 未读</span>` : ''}<span>最近 ${escapeHtml(fmtMtime(g.latest))}</span>`;
        return `<button class="sm-cluster${g.fresh ? ' has-fresh' : ''}${noHit ? ' no-hit' : ''}" type="button"
          data-project="${escapeHtml(g.name)}" tabindex="${i ? -1 : 0}" aria-label="${escapeHtml(label)}">
          <span class="nm">${escapeHtml(g.name)}</span><span class="ct">${cnt}</span>
          <span class="sub">${sub}</span>
          <span class="bar" aria-hidden="true"><i style="width:${Math.max(2, Math.round(g.files.length / max * 100))}%"></i></span>
        </button>`;
      }).join('');
  } else {
    const g = groups.get(starmapCatalog.project);
    const stars = g.files.filter(f => !snap.active || snap.hits.has(f.path))
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || (a.path < b.path ? -1 : 1));
    const shown = stars.slice(0, starmapCatalog.limit);
    html = `<button class="cat-back" type="button">← 全部星团</button>`
      + `<div class="cat-title"><b>${escapeHtml(g.name)}</b><span class="cat-count">${snap.active ? `${g.hits}/${g.files.length}` : g.files.length} 篇</span>`
      + `${g.unread ? `<span class="u">${g.unread} 未读</span>` : ''}</div>`
      + shown.map((f, i) => {
        const name = f.alias || stripDocExt(f.name);
        const lc = AtlasStarmap.linkCounts(f.path);
        const fresh = isFreshUnread(f);
        const label = `${name}，${fmtMtime(f.mtime)}${f.unread ? '，未读' : ''}，引用 ${lc.out} 篇、被 ${lc.in} 篇引用`;
        return `<button class="sm-star${f.unread ? ' unread' : ''}${fresh ? ' fresh' : ''}" type="button"
          data-path="${escapeHtml(f.path)}" tabindex="${i ? -1 : 0}" aria-label="${escapeHtml(label)}">
          <span class="tdot" aria-hidden="true"><i class="t${starmapTier(f.mtime)}"></i></span>
          <span class="nm">${escapeHtml(name)}</span><span class="tm">${relShortTime(f.mtime)}</span>
        </button>`;
      }).join('')
      + (stars.length > shown.length ? `<button class="cat-more" type="button">再显示 200 条</button>` : '');
  }
  body.innerHTML = html;
  if (focusKey) {
    const el = body.querySelector(focusKey.sel);
    if (el) { setCatalogRoving(el); el.focus({ preventScroll: true }); }
  }
  if (window.AtlasPeek) AtlasPeek.reanchor();
}
function catalogItems() {
  return [...els.starmapCatalogBody.querySelectorAll('.sm-cluster, .sm-star')];
}
function setCatalogRoving(el) {
  for (const it of catalogItems()) it.tabIndex = it === el ? 0 : -1;
}
function activateCatalogCluster(name, { focus = false, fly = true } = {}) {
  starmapCatalog.project = name;
  starmapCatalog.limit = 200;
  renderStarmapCatalog();
  if (fly) AtlasStarmap.flyToProject(name);
  if (focus) {
    const first = els.starmapCatalogBody.querySelector('.sm-star') || els.starmapCatalogBody.querySelector('.cat-back');
    if (first) first.focus();
  }
}
function showCatalogClusters({ focusProject = null } = {}) {
  starmapCatalog.project = null;
  AtlasStarmap.focusPath(null);
  renderStarmapCatalog();
  AtlasStarmap.fit();
  if (focusProject != null) {
    const el = els.starmapCatalogBody.querySelector(`.sm-cluster[data-project="${CSS.escape(focusProject)}"]`);
    if (el) { setCatalogRoving(el); el.focus(); }
  }
}
if (els.starmapCatalogBody) {
  const body = els.starmapCatalogBody;
  body.addEventListener('click', (e) => {
    const c = e.target.closest('.sm-cluster');
    if (c) { activateCatalogCluster(c.dataset.project, { focus: e.detail === 0 }); return; }
    const st = e.target.closest('.sm-star');
    if (st) { if (window.AtlasPeek) AtlasPeek.close(); openFile(st.dataset.path); return; }
    if (e.target.closest('.cat-back')) { showCatalogClusters({ focusProject: starmapCatalog.project }); return; }
    if (e.target.closest('.cat-more')) {
      const before = body.querySelectorAll('.sm-star').length;
      starmapCatalog.limit += 200;
      renderStarmapCatalog();
      const next = body.querySelectorAll('.sm-star')[before];
      if (next) { setCatalogRoving(next); next.focus(); }
    }
  });
  // 星表 roving tabindex：先处理快速查看（与目录树一致），再处理 ↑/↓ / Enter
  body.addEventListener('keydown', (e) => {
    const item = e.target.closest && e.target.closest('.sm-cluster, .sm-star');
    if (!item || e.metaKey || e.ctrlKey || e.altKey) return;
    const isStar = item.classList.contains('sm-star');
    if (isStar && e.key === ' ') {
      e.preventDefault();
      if (window.AtlasPeek) AtlasPeek.toggleFor(item.dataset.path, item);
      return;
    }
    if (e.key === 'Escape' && window.AtlasPeek && AtlasPeek.isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      AtlasPeek.close();          // 焦点留在原处
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = catalogItems();
      const i = items.indexOf(item);
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next && next !== item) {
        setCatalogRoving(next);
        next.focus();
        next.scrollIntoView({ block: 'nearest' });
        if (isStar && window.AtlasPeek && AtlasPeek.isOpen()) AtlasPeek.retarget(next);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isStar) { if (window.AtlasPeek) AtlasPeek.close(); openFile(item.dataset.path); }
      else activateCatalogCluster(item.dataset.project, { focus: true });
    }
  });
  // 聚焦星 → 画布相机平移过去并画焦点环
  body.addEventListener('focusin', (e) => {
    const st = e.target.closest && e.target.closest('.sm-star');
    body.querySelectorAll('.sm-star[aria-current]').forEach(x => x.removeAttribute('aria-current'));
    if (st) {
      st.setAttribute('aria-current', 'true');
      setCatalogRoving(st);
      AtlasStarmap.focusPath(st.dataset.path);
    }
  });
}
// 画布悬停 / 点击星团 → 星表滚到对应项
function highlightCatalogCluster(name) {
  if (!els.starmapCatalogBody) return;
  els.starmapCatalogBody.querySelectorAll('.sm-cluster').forEach((b) => {
    const on = name != null && b.dataset.project === name;
    b.classList.toggle('hl', on);
    if (on) b.scrollIntoView({ block: 'nearest' });
  });
}

// ---------- tickMinute（design §3a 数据流，按 design-review NIT 1 的结构） ----------
// 挂在唯一的 60 秒定时器上（先于 fetchState），回前台时也先补一次
function hourChanged() {
  const h = Math.floor(Date.now() / 3_600_000);
  if (h === lastHourStamp) return false;
  lastHourStamp = h;
  return true;
}
function tickMinute() {
  updateHomeClock();                                         // 首页眉标的周X与 HH:mm
  if (starmapVisible()) AtlasStarmap.retier(Date.now());    // 新鲜度档位随时间变暗
  const hc = hourChanged();
  if (hc && state.timeRange) pendingHourRecompute = true;   // 跨整点：只标记，由紧随其后的 fetchState() 统一重算
  else if (hc) renderRiverCard();                             // 没有时间筛选：只让 168 根柱的窗口往后挪一格
}
// ==================== 时间河流（design §3d） ====================
// 数据 = 活动日志（GET /api/activity，7 天）+ SSE 追加的本地副本 + 修改时间兜底，合并 / 分桶 /
// 区间命中全在 river.js 的纯函数里；这里负责拉取时机、渲染接线、刷选交互与 state.timeRange。
const RIVER_REFRESH_MS = 10 * 60_000;
const RIVER_TIMEOUT_MS = 15_000;
function riverAvailable() { return !!window.AtlasRiver; }

// 河流模型：合并后的事件、168 个桶、总数。state.files 身份 / 日志版本 / 当前整点不变时直接复用
function ensureRiverModel() {
  const now = Date.now();
  if (!riverAvailable()) {
    return { events: [], buckets: null, totals: { total: 0, busiest: -1, busiestCount: 0 }, windowStart: now, logStart: null };
  }
  const hour = AtlasRiver.floorHour(now);
  const m = riverState.model;
  if (m && m.files === state.files && m.ver === riverState.ver && m.hour === hour) return m;
  const log = riverState.log || null;
  const events = AtlasRiver.mergeWithFallback(log, Object.values(state.files), now);
  const buckets = AtlasRiver.bucketize(events, now);
  riverState.model = {
    files: state.files, ver: riverState.ver, hour,
    events, buckets, totals: AtlasRiver.riverTotals(buckets),
    windowStart: buckets.start, logStart: log ? log.logStart : null,
  };
  return riverState.model;
}

// 时间段重算（design-review NIT 1 约定）：始终同步执行，调用方在同一同步段内即可读到新的
// state.timeRangePaths。opts.render === false 时只重算，渲染由调用方负责。
// 窗口滚动：from 早于窗口起点时夹到起点；选中的区段整个滑出窗口时清除并提示
function recomputeTimeRange(opts = {}) {
  if (!riverAvailable()) return;
  const had = !!state.timeRange;
  const m = ensureRiverModel();
  if (state.timeRange) {
    const c = AtlasRiver.clampRange(state.timeRange, m.windowStart);
    state.timeRange = c.range;
    if (c.cleared) showToast({ kind: 'info', text: '所选时段已超出 7 天范围，已清除时间筛选' });
  }
  if (state.timeRange) {
    state.timeRangeLatest = AtlasRiver.timeRangeLatest(m.events, state.timeRange);
    state.timeRangePaths = new Set(state.timeRangeLatest.keys());
  } else {
    state.timeRangeLatest = new Map();
    state.timeRangePaths = new Set();
  }
  state.timeRangeVer++;
  if (opts.render === false) return;
  if (had || state.timeRange) {
    // 命中集合变了：整条筛选管线刷新（render 末尾顺带刷新可见的星图与计数）
    render();
    renderHome();
  } else {
    renderRiverCard();
  }
}

// 用户改时间段（刷选 / 手柄 / 预设 / 清除 / Esc / chip）。range 为 null = 不筛选
function setTimeRange(range, { render: doRender = true } = {}) {
  const same = (!range && !state.timeRange)
    || (range && state.timeRange && range.from === state.timeRange.from && range.to === state.timeRange.to);
  state.timeRange = range || null;
  recomputeTimeRange({ render: false });
  if (doRender) {
    if (same) updateRiverSelection();
    else applyFilterChange();
  }
}
function clearTimeRange() { if (state.timeRange) setTimeRange(null); }

async function loadActivity() {
  if (!riverAvailable()) return;
  if (riverState.loading) { riverState.again = true; return; }
  riverState.loading = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RIVER_TIMEOUT_MS);
  try {
    const res = await fetch('/api/activity', { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const log = AtlasRiver.decodeLog(await res.json());
    if (!log) throw new Error('bad payload');
    riverState.log = log;
    riverState.failed = false;
  } catch {
    // 从没拿到过日志：退化为只用修改时间，并显示一行说明。之前成功过的话保留那份副本
    //（SSE 仍在往里追加），下次定时重拉再试
    if (!riverState.log) { riverState.log = null; riverState.failed = true; }
  } finally {
    clearTimeout(timer);
    riverState.loading = false;
  }
  riverState.ver++;
  recomputeTimeRange();
  if (riverState.again) { riverState.again = false; loadActivity(); }
}
setInterval(() => { if (!document.hidden && riverState.log !== undefined) loadActivity(); }, RIVER_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && riverState.log !== undefined) loadActivity();
});

// SSE fs 事件：追加到本地副本（不重新请求），河流实时长出新柱
function onRiverSseEvent(data) {
  if (!riverAvailable() || !riverState.log) return;
  if (!AtlasRiver.appendSseEvent(riverState.log, data, riverState.log.mergeWindowMs, Date.now())) return;
  riverState.ver++;
  recomputeTimeRange();
}

// ---------- 渲染 ----------
function renderRiverCard() {
  if (!els.homeRiver || !riverAvailable()) return;
  if (stateLoaded && riverState.log === undefined && !riverState.loading) loadActivity();
  const m = ensureRiverModel();
  const loading = riverState.log === undefined;
  if (riverState.drawn !== m || riverState.drawnLoading !== loading) {
    const hasDocs = Object.keys(state.files).length > 0;
    AtlasRiver.renderRiverSvg(els.homeRiver, {
      ...m.buckets,
      // 还没拿到日志时不画「仅修改时间」底纹（马上就有结果，免得闪一下）
      logStart: loading ? m.buckets.start : m.logStart,
    }, {
      grow: hasDocs && !riverState.grown,
      daysEl: els.riverDays,
      hatchTagEl: els.riverHatchTag,
      nowTagEl: els.riverNowTag,
      peaksEl: document.getElementById('river-peaks'),
    });
    if (hasDocs) riverState.grown = true;
    riverState.drawn = m;
    riverState.drawnLoading = loading;
  }
  const t = m.totals;
  if (els.homeRiverMeta) {
    els.homeRiverMeta.textContent = AtlasRiver.metaText(m.buckets, t);
    els.homeRiverMeta.dataset.total = String(t.total);
  }
  if (els.homeRiverSum) els.homeRiverSum.textContent = AtlasRiver.summaryText(m.buckets, t);
  if (els.homeRiverFallback) els.homeRiverFallback.classList.toggle('hidden', !riverState.failed);
  // 说明条：日志不可用时说"全部按修改时间推断"；日志刚开始记录（窗口里有一大段只有修改时间）时
  // 写明日志从何时起记录——首启没有历史，每篇只能按最后一次修改时间算一次，更早的改动补不回来
  if (els.homeRiverNote) {
    const ls = m.logStart;
    const partial = !riverState.failed && !loading && ls != null && ls - m.windowStart >= 12 * AtlasRiver.HOUR;
    els.homeRiverNote.classList.toggle('hidden', !riverState.failed && !partial);
    els.homeRiverNote.textContent = riverState.failed
      ? '活动日志暂不可用，河流按每篇文档的修改时间推断（每篇只算最后一次改动）'
      : (partial ? `活动日志自 ${AtlasRiver.fmtShort(ls)} 起记录；在那之前（斜纹底）每篇文档只按最后一次修改时间算一次，更早的改动无法补回` : '');
  }
  // 读数「近 7 天改动」与这里同一次 riverTotals()
  const cell = els.homeReadouts && els.homeReadouts.querySelector('.home-readout.is-signal');
  if (cell) {
    const v = cell.querySelector('.home-readout-v');
    if (v) v.textContent = t.total.toLocaleString();
    const k = cell.querySelector('.home-readout-k');
    const tag = cell.querySelector('.home-readout-tag');
    if (riverState.failed && !tag && k) {
      k.insertAdjacentHTML('beforeend', '<span class="home-readout-tag" title="活动日志暂不可用，按每篇文档的修改时间推断">仅修改时间</span>');
    } else if (!riverState.failed && tag) tag.remove();
  }
  updateRiverSelection();
}

// 选区矩形、两个手柄、柱子淡化、预设按下态。刷选拖动时只走这里（rAF 节流），不重建 SVG
function updateRiverSelection() {
  if (!els.homeRiver || !riverAvailable()) return;
  const m = ensureRiverModel();
  const ws = m.windowStart;
  const BARS = AtlasRiver.BARS;
  const [a, b] = riverState.drag ? riverState.drag.sel : AtlasRiver.handlesFromRange(state.timeRange, ws);
  const full = a <= 0 && b >= BARS;
  if (els.riverSel) {
    els.riverSel.classList.toggle('hidden', full);
    els.riverSel.style.left = (a / BARS * 100) + '%';
    els.riverSel.style.width = ((b - a) / BARS * 100) + '%';
  }
  for (const [el, v] of [[els.riverStart, a], [els.riverEnd, b]]) {
    if (!el) continue;
    el.style.left = (v / BARS * 100) + '%';
    el.setAttribute('aria-valuenow', String(v));
    el.setAttribute('aria-valuetext', v >= BARS ? '现在' : AtlasRiver.fmtValueText(ws + v * AtlasRiver.HOUR));
  }
  els.homeRiver.classList.toggle('has-sel', !full);
  els.homeRiver.querySelectorAll('rect.bar').forEach((r) => {
    const i = +r.dataset.i;
    r.classList.toggle('dim', !full && (i < a || i >= b));
  });
  const now = Date.now();
  document.querySelectorAll('[data-river-preset]').forEach((btn) => {
    const v = btn.dataset.riverPreset;
    if (v === 'clear') { btn.disabled = !state.timeRange; return; }
    const p = AtlasRiver.presetRange(Number(v), now);
    const on = !!state.timeRange && state.timeRange.to === null && state.timeRange.from === p.from;
    btn.setAttribute('aria-pressed', String(on));
  });
}

// 侧栏搜索框下方的时间段 chip（updateStats 里刷新）
function updateTimeFilterChip() {
  const el = els.timeFilterChip;
  if (!el) return;
  if (!state.timeRange || !riverAvailable()) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const label = AtlasRiver.fmtRange(state.timeRange);
  el.innerHTML = `<span aria-hidden="true">⏱</span> <span class="time-filter-chip-text">${escapeHtml(label)}</span> <span aria-hidden="true">✕</span>`;
  el.setAttribute('aria-label', `时间段筛选 ${label}，点击清除`);
  el.classList.remove('hidden');
}

// 首页封面墙的两种模式：待看（默认）/ 该时段改动的文档
function setFeedTimeMode(on) {
  if (els.homeFeedAll) els.homeFeedAll.classList.toggle('hidden', !on);
  if (!on && els.homeFeedTitle) els.homeFeedTitle.textContent = '待看';
  const feed = document.getElementById('home-feed');
  if (feed) feed.classList.toggle('is-time', on);
}
// 有时间段筛选时：命中（时间段 ∩ 其余筛选，同一次 filterSnapshot）按区间内最后一次事件倒序，至多 8 张
function renderHomeTimeFeed(snap) {
  setFeedTimeMode(true);
  const latest = state.timeRangeLatest;
  const list = [...snap.hits].map(p => state.files[p]).filter(Boolean)
    .sort((x, y) => (latest.get(y.path) || 0) - (latest.get(x.path) || 0));
  const r = state.timeRange;
  const label = `${AtlasRiver.fmtShort(r.from)} – ${r.to === null ? '现在' : AtlasRiver.fmtShort(r.to)}`;
  if (els.homeFeedTitle) els.homeFeedTitle.textContent = `${label} 改动了 ${list.length} 篇`;
  const why = [];
  if (state.tagFilter.size) why.push(`已按标签「${[...state.tagFilter].join('、')}」筛选`);
  if (state.onlyUnread) why.push('仅看未读');
  if (state.search) why.push(`已按搜索「${state.search}」筛选`);
  els.homeFeedCount.textContent = why.join(' · ');
  if (els.homeFeedHint) els.homeFeedHint.textContent = '';
  els.homeGrid.innerHTML = list.length
    ? list.slice(0, HOME_FEED_MAX).map((f, i) => coverCard(f, i)).join('')
    : homeEmpty({ icon: 'clock', title: '这个时段没有改动的文档', hint: '换一个时段，或点「清除」看全部' });
}

// ---------- 刷选交互 ----------
(function bindRiver() {
  const river = els.homeRiver;
  if (!river || !riverAvailable()) return;
  const BARS = AtlasRiver.BARS;
  const posAt = (clientX) => {
    const r = river.getBoundingClientRect();
    return r.width > 0 ? (clientX - r.left) / r.width * BARS : 0;
  };
  const barAt = (clientX) => Math.max(0, Math.min(BARS - 1, Math.floor(posAt(clientX))));
  const edgeAt = (clientX) => Math.max(0, Math.min(BARS, Math.round(posAt(clientX))));
  let raf = 0;
  let lastX = 0;
  const step = () => {
    raf = 0;
    const d = riverState.drag;
    if (!d) return;
    if (d.mode === 'new') {
      const j = barAt(lastX);
      d.sel = j >= d.from ? [d.from, j + 1] : [j, d.from + 1];
    } else if (d.mode === 'a') {
      d.sel = [Math.min(edgeAt(lastX), d.sel[1] - 1), d.sel[1]];
    } else {
      d.sel = [d.sel[0], Math.max(edgeAt(lastX), d.sel[0] + 1)];
    }
    updateRiverSelection();
  };
  river.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const m = ensureRiverModel();
    const cur = AtlasRiver.handlesFromRange(state.timeRange, m.windowStart);
    const handle = e.target.closest && e.target.closest('.river-handle');
    if (handle) {
      riverState.drag = { mode: handle === els.riverStart ? 'a' : 'b', sel: cur };
      handle.focus();
    } else {
      const i = barAt(e.clientX);
      riverState.drag = { mode: 'new', from: i, sel: [i, i + 1] };
    }
    try { river.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    updateRiverSelection();
  });
  river.addEventListener('pointermove', (e) => {
    if (!riverState.drag) return;
    lastX = e.clientX;
    if (!raf) raf = requestAnimationFrame(step);
  });
  const end = (commit) => {
    const d = riverState.drag;
    if (!d) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; step(); }
    riverState.drag = null;
    if (!commit) { updateRiverSelection(); return; }
    setTimeRange(AtlasRiver.rangeFromHandles(d.sel[0], d.sel[1], ensureRiverModel().windowStart));
  };
  river.addEventListener('pointerup', (e) => { lastX = e.clientX; end(true); });
  river.addEventListener('pointercancel', () => end(false));
  river.addEventListener('lostpointercapture', () => end(true));
  river.addEventListener('dblclick', (e) => { e.preventDefault(); setTimeRange(null); });

  // 键盘：两个 role=slider 手柄。←/→ 一小时、Shift+←/→ 一天、Home/End 到两端
  const onKey = (isStart) => (e) => {
    let delta = null;
    if (e.key === 'ArrowLeft') delta = e.shiftKey ? -24 : -1;
    else if (e.key === 'ArrowRight') delta = e.shiftKey ? 24 : 1;
    else if (e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    e.stopPropagation();
    const ws = ensureRiverModel().windowStart;
    let [a, b] = AtlasRiver.handlesFromRange(state.timeRange, ws);
    if (isStart) {
      const v = e.key === 'Home' ? 0 : e.key === 'End' ? BARS : a + delta;
      a = Math.max(0, Math.min(v, b - 1));
    } else {
      const v = e.key === 'Home' ? 0 : e.key === 'End' ? BARS : b + delta;
      b = Math.min(BARS, Math.max(v, a + 1));
    }
    setTimeRange(AtlasRiver.rangeFromHandles(a, b, ws));
  };
  if (els.riverStart) els.riverStart.addEventListener('keydown', onKey(true));
  if (els.riverEnd) els.riverEnd.addEventListener('keydown', onKey(false));

  document.querySelectorAll('[data-river-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.riverPreset;
      setTimeRange(v === 'clear' ? null : AtlasRiver.presetRange(Number(v), Date.now()));
    });
  });
  if (els.timeFilterChip) els.timeFilterChip.addEventListener('click', clearTimeRange);
  // 「在侧栏中列出全部」：侧栏收起时展开，并把目录树滚回顶部
  if (els.homeFeedAll) {
    els.homeFeedAll.addEventListener('click', () => {
      if (document.body.classList.contains('sidebar-collapsed')) toggleSidebar(false);
      if (els.tree) {
        els.tree.scrollTop = 0;
        const first = els.tree.querySelector('.file');
        if (first) first.scrollIntoView({ block: 'nearest' });
      }
    });
  }
})();

if (starmapAvailable()) {
  AtlasStarmap.init({
    fmtRel: (ts) => fmtMtime(ts),
    onOpen: (p) => { if (window.AtlasPeek) AtlasPeek.close(); openFile(p); },
    onPeek: (p, anchor) => {
      if (!window.AtlasPeek) return;
      canvasPeekPath = p;
      AtlasPeek.openFor(p, anchor, { via: 'hover' });
    },
    onPeekClose: () => {
      if (window.AtlasPeek && AtlasPeek.isOpen() && AtlasPeek.currentPath() === canvasPeekPath) AtlasPeek.close();
      canvasPeekPath = null;
    },
    onClusterHover: (name) => { if (starmapCatalog.project == null) highlightCatalogCluster(name); },
    onClusterActivate: (name) => activateCatalogCluster(name, { fly: false }),
    onEnterCatalog: () => {
      applyCatalogOpen(true);
      const el = els.starmapCatalogBody && els.starmapCatalogBody.querySelector('[tabindex="0"]');
      if (el) el.focus();
    },
    onThemeChange: () => { minimapSig = null; renderMinimap(); },
    onUnavailable: () => {
      minimapSig = null;
      if (els.homeMinimap) els.homeMinimap.classList.add('hidden');
      if (starmapVisible()) refreshStarmap(true);
    },
  });
}

// ==================== 快速查看（悬停预览，design §3c / §11.B5） ====================
// 设置 → 外观「悬停预览：开 / 关」（localStorage atlas:peek，默认开）。只影响悬停触发；
// Space 是明确的主动操作，始终可用。关掉时 peek.js 完全不碰触发元素的 title。
function peekHoverEnabled() {
  try { return localStorage.getItem('atlas:peek') !== 'off'; } catch { return true; }
}
function applyPeekSetting(mode) {
  const on = mode !== 'off';
  try {
    if (on) localStorage.removeItem('atlas:peek');
    else localStorage.setItem('atlas:peek', 'off');
  } catch {}
  document.querySelectorAll('[data-peek-pick]').forEach((b) => {
    const sel = (b.dataset.peekPick === 'on') === on;
    b.classList.toggle('is-on', sel);
    b.setAttribute('aria-checked', sel ? 'true' : 'false');
  });
  if (!on && window.AtlasPeek && AtlasPeek.isOpen()) AtlasPeek.close();
}
document.querySelectorAll('[data-peek-pick]').forEach((btn) => {
  btn.addEventListener('click', () => applyPeekSetting(btn.dataset.peekPick));
});
applyPeekSetting(peekHoverEnabled() ? 'on' : 'off');

if (window.AtlasPeek) {
  AtlasPeek.init({
    getFile: (p) => state.files[p],
    pathOf: (el) => (el && el.dataset ? el.dataset.path : null) || null,
    hoverEnabled: peekHoverEnabled,
    // 不弹出：目标不在看板里（始终）；悬停另外让位给拖拽 / 行内编辑 / 任何模态（含 ⌘K）/
    // 当前活动文档 / 窄视口 / 设置关闭
    canPeek(path, el, via) {
      if (!path || !state.files[path]) return false;
      if (via === 'hover') {
        if (!peekHoverEnabled()) return false;
        if (isDragging || isInlineEditing() || openModals.length || qoEntry) return false;
        if (path === state.activeFilePath) return false;
        if (window.innerWidth < 700) return false;
      }
      return true;
    },
    thumbUrl: (p) => thumbUrlFor(p),
    requestThumb: (p) => requestThumbs([p], 'peek'),
    frameUrl: (file) => previewUrlFor(file),
    applySandbox: applyPeekSandbox,
    titleFor: (file) => file.alias || stripDocExt(file.name),
    // 第一行：类型 · 项目 · 多久前更新 · 未读；第二行：原 title 里的信息（完整相对路径 / 标签）
    metaFor(file) {
      const parts = [escapeHtml(docTypeBadge(file))];
      if (file.projectName) parts.push(escapeHtml(file.projectName));
      if (file.mtime) parts.push(escapeHtml(fmtMtime(file.mtime)) + '更新');
      if (file.unread) parts.push('<span class="peek-unread">未读</span>');
      const line2 = [file.relPath || file.path];
      if ((file.tags || []).length) line2.push('标签：' + file.tags.join(' · '));
      return { line1Html: parts.join(' · '), line2: line2.join(' · ') };
    },
    findAnchor(p) {
      try {
        return els.tree.querySelector(`.file[data-path="${CSS.escape(p)}"]`)
          || (els.starmapCatalogBody && els.starmapCatalogBody.querySelector(`.sm-star[data-path="${CSS.escape(p)}"]`));
      } catch { return null; }
    },
  });
}

// 启动时停在星图：第一帧就把主区换成星图（并同步收起侧栏，赶在防闪类移除之前）；
// 数据到了之后 fetchState → render() 会再把星图刷新一遍
if (state.viewMode === 'map') showHomeSurface();
fetchState();
connectSSE();
checkForUpdate();
// 长期开着的页面也定期复查（兜底，server SSE 推送是主路径）
setInterval(checkForUpdate, 60 * 60 * 1000);
// 升级后首次打开：本版有新功能就主动弹一次引导（延迟到首页渲染稳定后，避免和首屏抢）
setTimeout(maybeShowWhatsNew, 800);

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
    // 只刷角标，不重建整棵树
    updateSharedDecorations();
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
  updateSharedDecorations();
}

let shareModalEntry = null;
function closeShareModal() {
  els.shareModal.classList.add('hidden');
  shareCurrent = null;
  if (shareExpiryTimer) { clearInterval(shareExpiryTimer); shareExpiryTimer = null; }
  if (shareModalEntry) { popModal(shareModalEntry); shareModalEntry = null; }
}

els.shareModal.addEventListener('click', (e) => {
  if (isCloseTarget(e.target)) closeShareModal();
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
    updateSharedDecorations();
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
      updateSharedDecorations();
    }
  } catch {}
})();
