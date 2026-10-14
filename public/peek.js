// 快速查看（悬停预览）浮窗控制器 —— window.AtlasPeek
//
// 只管浮窗本身：悬停计时、定位、内容切换（缓存截图 <img> / 实时 iframe）、iframe src 尾防抖、
// title 暂存与还原、aria-describedby。状态与判断全部由 app.js 经 init(deps) 注入：
//   getFile(path)              → state.files[path] | undefined
//   pathOf(el)                 → 触发元素对应的路径
//   canPeek(path, el, via)     → 是否允许弹出（拖拽 / 编辑 / 模态 / 活动文档 / 视口宽度 …）
//   hoverEnabled()             → 设置里的「悬停预览」开关
//   thumbUrl(path)             → 当前主题下 ready / stale 截图的 URL，没有返回 null
//   requestThumb(path)         → 顺手请求生成截图（受 webdriver 闸门约束）
//   frameUrl(file)             → 实时 iframe 的地址（previewUrlFor；云端文件为 null）
//   isCloud(file) / cloudText(file) → 是否只在 iCloud 里 / 此时 #peek-empty 显示的说明
//   applySandbox(ifr)          → 设 src 之前调用：sandbox 严格等于 allow-scripts
//   titleFor(file) / metaFor(file) → 浮窗标题 / { line1, line2 }
//   findAnchor(path)           → 重渲染后按路径重新找触发元素（键盘模式用）
//
// 安全：.peek-frame 永远是 opaque origin（sandbox="allow-scripts"），无论文档是否被信任；
// 不带 .preview-frame 类、不带 id=preview，不计入 MAX_LIVE_FRAMES，不进 state.tabs。
(function () {
  'use strict';

  const HOVER_DELAY_MS = 450;
  const LEAVE_DELAY_MS = 150;
  const RETARGET_DEBOUNCE_MS = 150;
  const FRAME_TIMEOUT_MS = 8000;
  const BLANK_AFTER_CLOSE_MS = 2000;
  const FRAME_W = 1280;
  const FRAME_H = 800;
  const SIDE_GAP = 10;
  const EDGE = 8;
  const TRIGGER_SELECTOR = [
    '#tree .file[data-path]',
    '#tab-bar .tab[data-path]:not(.active)',
    '.cover-card[data-path]',
    '.home-row[data-path]',
    '.sm-star[data-path]',
  ].join(',');

  let deps = null;
  let els = null;
  let frame = null;

  // 当前打开的目标
  let cur = null;               // { path, anchor, via, prevDescribedBy }
  let hoverEl = null;           // 指针当前所在的触发元素
  let hoverTimer = null;
  let leaveTimer = null;
  let srcTimer = null;          // retarget 的 iframe src 尾防抖
  let frameTimeout = null;      // 8 秒无 load → #peek-empty
  let blankTimer = null;        // 关闭 2 秒后导航 about:blank
  let frameWantUrl = null;      // iframe 正在加载 / 已加载的目标地址
  const stashed = new Set();    // 被暂存了 title 的元素

  function $(id) { return document.getElementById(id); }

  function ensureEls() {
    if (els) return els;
    const root = $('peek');
    if (!root) return null;
    els = {
      root,
      title: $('peek-title'),
      meta: $('peek-meta'),
      body: root.querySelector('.peek-body'),
      img: $('peek-img'),
      empty: $('peek-empty'),
    };
    els.emptyDefault = els.empty.textContent;
    els.img.addEventListener('error', () => {
      // 缓存截图 404 / 加载失败 → 回退到实时 iframe（不防抖）
      if (!cur || els.img.classList.contains('hidden')) return;
      els.img.classList.add('hidden');
      els.img.removeAttribute('src');
      const file = deps.getFile(cur.path);
      if (!file) return;
      // 这条回退绕过了 renderContent 的云端判断：frameUrl 对云端文件返回 null，
      // 此时只显示说明，不建帧（N6）
      const url = deps.frameUrl(file);
      if (!url) {
        blankFrame();
        if (frame) frame.classList.add('hidden');
        els.empty.textContent = deps.isCloud && deps.isCloud(file) && deps.cloudText ? deps.cloudText(file) : els.emptyDefault;
        els.empty.classList.remove('hidden');
        return;
      }
      loadFrame(url, false);
    });
    return els;
  }

  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.className = 'peek-frame hidden';
    deps.applySandbox(frame);
    frame.setAttribute('allow', "autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'");
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('title', '快速查看');
    frame.style.width = FRAME_W + 'px';
    frame.style.height = FRAME_H + 'px';
    frame.addEventListener('load', () => {
      if (!frameWantUrl) return;
      clearTimeout(frameTimeout);
      frameTimeout = null;
    });
    els.body.insertBefore(frame, els.empty);
    return frame;
  }

  function scaleFrame() {
    if (!frame || !els) return;
    const w = els.body.clientWidth || 0;
    if (w > 0) frame.style.transform = `scale(${w / FRAME_W})`;
  }

  function blankFrame() {
    clearTimeout(srcTimer); srcTimer = null;
    clearTimeout(frameTimeout); frameTimeout = null;
    frameWantUrl = null;
    if (frame && frame.getAttribute('src') !== 'about:blank') frame.setAttribute('src', 'about:blank');
  }

  function setFrameSrc(url) {
    const f = ensureFrame();
    deps.applySandbox(f);         // sandbox 只在导航时生效：必须先于 src
    frameWantUrl = url;
    f.setAttribute('src', url);
    clearTimeout(frameTimeout);
    frameTimeout = setTimeout(() => {
      frameTimeout = null;
      if (!cur || frameWantUrl !== url) return;
      // 8 秒没 load：给一句说明，iframe 回 about:blank
      blankFrame();
      if (frame) frame.classList.add('hidden');
      els.empty.classList.remove('hidden');
    }, FRAME_TIMEOUT_MS);
  }

  // debounce=true：先 about:blank，150ms 后才真正赋 src（按住方向键只加载最后停下的那一篇）
  function loadFrame(url, debounce) {
    const f = ensureFrame();
    els.empty.classList.add('hidden');
    f.classList.remove('hidden');
    scaleFrame();
    if (!url) {
      blankFrame();
      f.classList.add('hidden');
      els.empty.classList.remove('hidden');
      return;
    }
    if (!debounce) {
      clearTimeout(srcTimer); srcTimer = null;
      if (frameWantUrl === url) return;
      setFrameSrc(url);
      return;
    }
    if (frameWantUrl === url && !srcTimer) return;
    if (frameWantUrl) blankFrame();
    clearTimeout(srcTimer);
    srcTimer = setTimeout(() => {
      srcTimer = null;
      if (!cur) return;
      setFrameSrc(url);
    }, RETARGET_DEBOUNCE_MS);
  }

  function renderContent(debounce) {
    const file = deps.getFile(cur.path);
    if (!file) return;
    els.title.textContent = deps.titleFor(file);
    const meta = deps.metaFor(file) || {};
    els.meta.innerHTML = '';
    const l1 = document.createElement('span');
    l1.className = 'peek-meta-l1';
    l1.innerHTML = meta.line1Html || '';
    els.meta.appendChild(l1);
    if (meta.line2) {
      const l2 = document.createElement('span');
      l2.className = 'peek-meta-l2';
      l2.textContent = meta.line2;
      els.meta.appendChild(l2);
    }
    // 云端文件（只在 iCloud 里）：不截图、不建 / 不导航 iframe，只显示一行说明
    if (deps.isCloud && deps.isCloud(file)) {
      blankFrame();
      if (frame) frame.classList.add('hidden');
      els.img.classList.add('hidden');
      els.img.removeAttribute('src');
      els.empty.textContent = deps.cloudText ? deps.cloudText(file) : els.emptyDefault;
      els.empty.classList.remove('hidden');
      return;
    }
    els.empty.textContent = els.emptyDefault;
    const thumb = deps.thumbUrl(cur.path);
    if (thumb) {
      // 缓存截图：零渲染成本，不防抖（Atlas 自己的 PNG，没有外发请求）
      blankFrame();
      if (frame) frame.classList.add('hidden');
      els.empty.classList.add('hidden');
      els.img.classList.remove('hidden');
      if (els.img.getAttribute('src') !== thumb) els.img.setAttribute('src', thumb);
      return;
    }
    els.img.classList.add('hidden');
    els.img.removeAttribute('src');
    try { deps.requestThumb(cur.path); } catch {}
    loadFrame(deps.frameUrl(file), debounce);
  }

  // ---------- title 暂存 / 还原（原生提示会叠在浮窗上） ----------
  function stashTitle(el) {
    if (!el || stashed.has(el)) return;
    if (!el.hasAttribute('title')) return;
    el.dataset.peekTitle = el.getAttribute('title');
    el.removeAttribute('title');
    stashed.add(el);
  }
  function restoreTitle(el) {
    if (!el || !stashed.has(el)) return;
    stashed.delete(el);
    if (el.dataset.peekTitle !== undefined) {
      el.setAttribute('title', el.dataset.peekTitle);
      delete el.dataset.peekTitle;
    }
  }
  function restoreAllTitles(except) {
    for (const el of [...stashed]) if (el !== except) restoreTitle(el);
  }

  // ---------- aria-describedby ----------
  function describe(anchor) {
    if (!cur) return;
    cur.prevDescribedBy = anchor.getAttribute('aria-describedby');
    anchor.setAttribute('aria-describedby', 'peek-meta');
  }
  function undescribe() {
    if (!cur || !cur.anchor) return;
    const a = cur.anchor;
    if (cur.prevDescribedBy) a.setAttribute('aria-describedby', cur.prevDescribedBy);
    else a.removeAttribute('aria-describedby');
  }

  // ---------- 定位 ----------
  function position() {
    if (!cur || !cur.anchor || !els) return;
    const a = cur.anchor;
    const r = a.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = els.root.offsetWidth || 380;
    const h = els.root.offsetHeight || 320;
    const clampY = (y) => Math.max(EDGE, Math.min(y, vh - h - EDGE));
    const clampX = (x) => Math.max(EDGE, Math.min(x, vw - w - EDGE));
    let left;
    let top;
    const sidebar = a.closest('#tree') ? document.getElementById('sidebar') : null;
    if (sidebar) {
      // 侧栏行：左缘贴侧栏右缘外 10px，与行垂直居中
      left = sidebar.getBoundingClientRect().right + SIDE_GAP;
      top = clampY(r.top + r.height / 2 - h / 2);
    } else if (a.closest('#tab-bar')) {
      left = clampX(r.left);
      top = Math.min(r.bottom + 6, vh - h - EDGE);
    } else {
      // 封面 / 首页行 / 星：优先右侧，不够放左侧
      left = r.right + SIDE_GAP;
      if (left + w > vw - EDGE) left = r.left - SIDE_GAP - w;
      left = clampX(left);
      top = clampY(r.top + r.height / 2 - h / 2);
    }
    els.root.style.left = Math.round(left) + 'px';
    els.root.style.top = Math.round(top) + 'px';
  }

  // ---------- 公开接口 ----------
  function isOpen() { return !!cur; }

  function openFor(path, anchorEl, opts) {
    const via = (opts && opts.via) || 'key';
    if (!deps || !ensureEls() || !path || !anchorEl) return;
    if (!deps.canPeek(path, anchorEl, via)) { if (cur) close(); return; }
    clearTimeout(hoverTimer); hoverTimer = null;
    clearTimeout(leaveTimer); leaveTimer = null;
    clearTimeout(blankTimer); blankTimer = null;
    const wasOpen = !!cur;
    if (wasOpen) {
      undescribe();
      if (cur.anchor !== anchorEl && cur.anchor !== hoverEl) restoreTitle(cur.anchor);
    }
    cur = { path, anchor: anchorEl, via, prevDescribedBy: null };
    describe(anchorEl);
    els.root.classList.remove('hidden');
    // 首次打开立即赋 src；已打开时切换目标（悬停换行 / 方向键）走 150ms 尾防抖
    renderContent(wasOpen);
    position();
    scaleFrame();
  }

  function retarget(anchorEl) {
    if (!cur || !anchorEl) return;
    const path = deps.pathOf(anchorEl);
    if (!path) return;
    if (path === cur.path && anchorEl === cur.anchor) return;
    openFor(path, anchorEl, { via: cur.via });
  }

  function toggleFor(path, anchorEl) {
    if (cur && cur.path === path) { close(); return; }
    openFor(path, anchorEl, { via: 'key' });
  }

  function close() {
    clearTimeout(hoverTimer); hoverTimer = null;
    clearTimeout(leaveTimer); leaveTimer = null;
    if (!cur) { restoreAllTitles(hoverEl); return; }
    undescribe();
    cur = null;
    if (els) {
      els.root.classList.add('hidden');
      els.img.classList.add('hidden');
      els.img.removeAttribute('src');
      els.empty.classList.add('hidden');
    }
    clearTimeout(srcTimer); srcTimer = null;
    clearTimeout(frameTimeout); frameTimeout = null;
    // 关闭 2 秒后才导航 about:blank：马上又打开同一篇时不必重新加载
    clearTimeout(blankTimer);
    blankTimer = setTimeout(() => { blankTimer = null; if (!cur) blankFrame(); }, BLANK_AFTER_CLOSE_MS);
    restoreAllTitles(hoverEl);
  }

  // SSE thumb 到达：正好是浮窗当前目标 → 换成 <img>、iframe 回 about:blank
  function onThumb(path) {
    if (!cur || cur.path !== path) return;
    if (!deps.thumbUrl(path)) return;
    renderContent(false);
  }

  // 整树重建之后：触发元素被换掉了。键盘模式下同一路径的行还在就重新定位过去，否则关闭
  function reanchor() {
    if (!cur) return;
    if (cur.anchor && cur.anchor.isConnected) { position(); return; }
    const next = cur.via === 'key' && deps.findAnchor ? deps.findAnchor(cur.path) : null;
    if (next) {
      cur.anchor = next;
      describe(next);
      position();
    } else {
      close();
    }
  }

  // ---------- 悬停（仅鼠标） ----------
  function onPointerOver(e) {
    if (!deps || e.pointerType !== 'mouse') return;
    const el = e.target && e.target.closest ? e.target.closest(TRIGGER_SELECTOR) : null;
    if (!el || el === hoverEl) return;
    if (hoverEl) leaveTarget(hoverEl);
    hoverEl = el;
    clearTimeout(leaveTimer); leaveTimer = null;
    if (!deps.hoverEnabled()) return;           // 关掉悬停时完全不碰 title
    const path = deps.pathOf(el);
    if (!path || !deps.canPeek(path, el, 'hover')) return;
    stashTitle(el);
    if (cur) {
      // 已由悬停弹出：移到另一目标立即切换。键盘打开的浮窗不跟指针走——
      // 方向键让目录树滚动时，静止的指针下面会"经过"别的行，不能把内容抢走
      if (cur.via === 'hover' && cur.anchor !== el) openFor(path, el, { via: 'hover' });
      return;
    }
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      if (hoverEl !== el || !el.isConnected) return;
      openFor(path, el, { via: 'hover' });
    }, HOVER_DELAY_MS);
  }

  function leaveTarget(el) {
    clearTimeout(hoverTimer); hoverTimer = null;
    if (cur && cur.anchor === el && cur.via === 'hover') {
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => { leaveTimer = null; close(); }, LEAVE_DELAY_MS);
    } else if (!cur || cur.anchor !== el) {
      restoreTitle(el);
    }
  }

  function onPointerOut(e) {
    if (!deps || e.pointerType !== 'mouse' || !hoverEl) return;
    const to = e.relatedTarget;
    if (to && hoverEl.contains(to)) return;
    const el = hoverEl;
    hoverEl = null;
    leaveTarget(el);
  }

  function closeNow() { if (cur || hoverTimer) close(); }

  function init(d) {
    deps = d;
    ensureEls();
    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    // 按下鼠标、滚轮、窗口失焦、开始拖拽、窗口尺寸变化：立即关闭
    document.addEventListener('pointerdown', closeNow, true);
    document.addEventListener('wheel', closeNow, { capture: true, passive: true });
    document.addEventListener('dragstart', closeNow, true);
    window.addEventListener('blur', closeNow);
    window.addEventListener('resize', closeNow);
  }

  window.AtlasPeek = {
    init,
    openFor,
    toggleFor,
    retarget,
    close,
    isOpen,
    onThumb,
    reanchor,
    currentPath: () => (cur ? cur.path : null),
    TRIGGER_SELECTOR,
  };
})();
