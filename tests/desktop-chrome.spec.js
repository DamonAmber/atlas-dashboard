// 桌面版原生外壳（macOS）的前端钩子
//
// Playwright 跑的是浏览器，覆盖不到 Electron 主进程；这里用 addInitScript 注入一个假的
// window.atlasDesktop（与 electron/preload.js 暴露的字段同形），验证"同一份前端在桌面壳里"
// 的表现：
//   - 防闪脚本按 atlasDesktop.platform 写 html[data-desktop="darwin"]
//   - 红绿灯避让：.sidebar-header 左内边距 = 主进程下发的 titlebarInset（缺省 90px，macOS 26 灯组 60pt + 留白），
//     但 .sidebar 的几何（left 0 / 宽 320）不变；electron/titlebar.js 的灯组几何（node 段）
//   - 双击缩放的前提：主顶栏绝大部分是拖动区，面包屑文字也是；窗口放大前后同一屏幕点都还在拖动区
//     （原生 NSWindow 按 AppleActionOnDoubleClick 在拖动区上缩放 / 还原，前端只需保证拖动区不被吃掉）
//   - 降低透明度：onWindowState 推 { reducedTransparency:true } 后侧栏改实底
//   - 拖动区：顶栏可拖（drag），顶栏里的按钮不可拖（no-drag）
//   - 侧栏是半透明着色层（--sidebar-tint-light 60%），透出 vibrancy；吸顶分组头标 .is-stuck
//   - 切主题时 setTheme 收到正确参数（启动时也同步一次已保存的主题）
//   - 全屏（onWindowState 推 { fullscreen:true }）后内边距回到原值
//   - 不注入假桥（浏览器版）时没有 data-desktop，原生化 CSS 一条都不生效
//   - 专注模式：#focus-drag 28px 拖动条（drag）、#focus-exit 不可拖且命中、.preview 下移 28px、
//     setChromeState 收到 { focusMode: true / false }、菜单命令 toggle-focus 能进出；
//     浏览器版 #focus-drag 始终 display:none
const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');

let fail = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`✗ ${name}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`); }
  else console.log(`✓ ${name}`);
}

// 与 electron/preload.js 同形的假桥；记录 setTheme / setChromeState 的调用
function fakeBridge() {
  window.__themes = [];
  window.__chrome = [];
  window.__ws = null;
  window.__menu = null;
  window.atlasDesktop = {
    isDesktop: true,
    platform: 'darwin',
    electronVersion: '0.0.0-test',
    exportPdf: async () => ({ ok: false, error: 'test' }),
    onMenuCommand: (cb) => { window.__menu = cb; return () => { window.__menu = null; }; },
    closeWindow: () => {},
    onOpenPath: () => () => {},
    takePendingOpen: async () => null,
    appVersion: async () => null,
    setTheme: (m) => { window.__themes.push(m); },
    setChromeState: (s) => { window.__chrome.push(s); },
    onWindowState: (cb) => { window.__ws = cb; return () => { window.__ws = null; }; },
    updates: {
      getState: async () => ({ state: 'idle' }),
      check: async () => ({ state: 'unsupported' }),
      quitAndInstall: async () => ({ ok: false }),
      onStatus: () => () => {},
    },
  };
}

function chrome() {
  const sh = document.querySelector('.sidebar-header');
  const mh = document.querySelector('.main-header');
  const sb = document.querySelector('.sidebar');
  const btn = document.querySelector('.main-header button');
  const region = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion || cs.getPropertyValue('app-region') || '';
  };
  const r = sb.getBoundingClientRect();
  return {
    desktop: document.documentElement.getAttribute('data-desktop'),
    fullscreen: document.documentElement.classList.contains('is-fullscreen'),
    headerPadLeft: getComputedStyle(sh).paddingLeft,
    mainHeaderPadLeft: getComputedStyle(mh).paddingLeft,
    sidebarLeft: r.left,
    sidebarW: r.width,
    headerRegion: region(sh),
    mainHeaderRegion: region(mh),
    buttonRegion: region(btn),
    brandRegion: region(document.getElementById('btn-home')),
    sidebarBg: getComputedStyle(sb).backgroundColor,
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
  };
}

// 某个视口点的实际拖动属性：从命中元素往上找第一个显式 drag / no-drag
function regionAt(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    const v = cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion || cs.getPropertyValue('app-region') || '';
    if (v === 'drag' || v === 'no-drag') return v;
    el = el.parentElement;
  }
  return 'none';
}
// 主顶栏 y=23（红绿灯中线）每 4px 采样一次的拖动区覆盖率，外加指定点的属性
function dragCoverage(points) {
  const mh = document.querySelector('.main-header').getBoundingClientRect();
  let drag = 0, n = 0;
  for (let x = mh.left + 2; x < mh.right - 2; x += 4) { n++; if (regionAt(x, mh.top + 23) === 'drag') drag++; }
  return { ratio: drag / n, at: points.map(([x, y]) => regionAt(x, y)) };
}
// 专注模式下的拖动条 / 退出胶囊（design §3g）
function focusChrome() {
  const region = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion || cs.getPropertyValue('app-region') || '';
  };
  const drag = document.getElementById('focus-drag');
  const ex = document.getElementById('focus-exit');
  const dr = drag.getBoundingClientRect();
  const er = ex.getBoundingClientRect();
  const hit = document.elementFromPoint(er.left + er.width / 2, er.top + er.height / 2);
  return {
    focus: document.documentElement.classList.contains('focus-mode'),
    dragDisplay: getComputedStyle(drag).display,
    dragTop: Math.round(dr.top),
    dragH: Math.round(dr.height),
    dragW: Math.round(dr.width),
    dragRegion: region(drag),
    exitRegion: region(ex),
    exitHit: !!hit && (hit === ex || ex.contains(hit)),
    previewPadTop: getComputedStyle(document.querySelector('.preview')).paddingTop,
  };
}
(async () => {
  // ---------- electron/titlebar.js：红绿灯几何（纯函数） ----------
  {
    const { trafficLightGeometry } = require('../electron/titlebar');
    const g26 = trafficLightGeometry('darwin', '25.5.0');
    const g15 = trafficLightGeometry('darwin', '24.6.0');
    check('macOS 26（Darwin 25）：灯组 60pt、垂直居中 y=16、避让 90px', [g26.groupWidth, g26.position, g26.inset], [60, { x: 18, y: 16 }, 90]);
    check('macOS 15（Darwin 24）：灯组 52pt、y=17、避让 82px', [g15.groupWidth, g15.position, g15.inset], [52, { x: 18, y: 17 }, 82]);
    check('避让宽度 ≥ 灯组右缘 + 12px', g26.inset >= g26.position.x + g26.groupWidth + 12, true);
    check('灯组垂直中心 = 顶栏 46px 的中线', g26.position.y + g26.diameter / 2, 23);
  }
  const atlas = await startAtlas({
    prefix: 'atlas-desktop-spec-',
    files: { 'proj/a.md': '# A\n\n正文\n', 'proj/b.html': '<!doctype html><h1>B</h1>' },
  });
  const browser = await chromium.launch();

  // ---------- 桌面壳（注入假桥） ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(fakeBridge);
    await ctx.addInitScript(`window.regionAt = ${regionAt.toString()};`);
    const page = await ctx.newPage();
    await page.goto(atlas.base, { waitUntil: 'load' });
    await page.waitForSelector('#tree .file');
    let s = await page.evaluate(chrome);
    check('桌面：html[data-desktop="darwin"] 已设', s.desktop, 'darwin');
    check('桌面：.sidebar-header 左内边距 90px（红绿灯避让，缺省值）', s.headerPadLeft, '90px');
    check('桌面：.sidebar 仍贴左（left === 0）', s.sidebarLeft, 0);
    check('桌面：.sidebar 宽度仍是 320', s.sidebarW, 320);
    check('桌面：.sidebar-header 可拖动', s.headerRegion, 'drag');
    check('桌面：.main-header 可拖动', s.mainHeaderRegion, 'drag');
    check('桌面：.main-header 里的按钮不可拖动', s.buttonRegion, 'no-drag');
    check('桌面：品牌区（回首页）不可拖动', s.brandRegion, 'no-drag');
    check('桌面：html 背景透明（vibrancy 透得出来）', s.htmlBg, 'rgba(0, 0, 0, 0)');
    check('桌面：侧栏是 60% 半透明着色层（浅色）', /\/ 0\.6\)$|, 0\.6\)$/.test(s.sidebarBg), true);
    check('桌面：订阅了 onWindowState', await page.evaluate(() => typeof window.__ws), 'function');
    check('桌面：启动时同步一次已保存的主题（默认跟随系统）',
      await page.evaluate(() => window.__themes[0]), 'system');

    // 切主题：setTheme 收到对应参数
    await page.evaluate(() => document.querySelector('[data-theme-pick="dark"]').click());
    await page.evaluate(() => document.querySelector('[data-theme-pick="light"]').click());
    await page.evaluate(() => document.querySelector('[data-theme-pick="system"]').click());
    check('桌面：切主题时 setTheme 依次收到 dark / light / system',
      await page.evaluate(() => window.__themes.slice(-3)), ['dark', 'light', 'system']);

    // 双击缩放的前提：主顶栏绝大部分是拖动区（以前面包屑整块 no-drag，只剩 13%）。
    // 1512 宽模拟"窗口放大后"，诊断里那个落进面包屑的点（x=1140）放大前后都必须在拖动区
    const cov1280 = await page.evaluate(dragCoverage, [[1140, 23]]);
    check('桌面：首页态主顶栏拖动区覆盖 ≥ 60%（y=23）', cov1280.ratio >= 0.6, true);
    check('桌面：x=1140,y=23 在拖动区', cov1280.at, ['drag']);
    check('桌面：面包屑里的「首页」文字在拖动区、顶栏文字不可选中',
      await page.evaluate(() => [getComputedStyle(document.querySelector('.main-header')).userSelect,
        (() => { const r = document.querySelector('#crumbs .placeholder').getBoundingClientRect(); return regionAt(r.left + r.width / 2, r.top + r.height / 2); })()]),
      ['none', 'drag']);
    await page.click('#tree .file[data-path$="b.html"] .file-name');
    await page.waitForTimeout(800);
    const covDoc = await page.evaluate(() => {
      const home = document.querySelector('#crumbs .crumb-home').getBoundingClientRect();
      const name = document.querySelector('#crumbs .crumb-name').getBoundingClientRect();
      const tb = document.querySelector('#btn-edit').getBoundingClientRect();
      return { home: regionAt(home.left + home.width / 2, home.top + home.height / 2),
        name: regionAt(name.left + name.width / 2, name.top + name.height / 2),
        btn: regionAt(tb.left + tb.width / 2, tb.top + tb.height / 2) };
    });
    check('桌面：文档态面包屑「回到首页」按钮 no-drag、文件名文字 drag、工具按钮 no-drag',
      [covDoc.home, covDoc.name, covDoc.btn], ['no-drag', 'drag', 'no-drag']);
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.waitForTimeout(200);
    const cov1512 = await page.evaluate(dragCoverage, [[1140, 23]]);
    check('桌面：放大到 1512 宽后 x=1140,y=23 仍在拖动区（双击能还原）', cov1512.at, ['drag']);
    check('桌面：放大后文档态主顶栏拖动区覆盖 ≥ 50%', cov1512.ratio >= 0.5, true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    // 降低透明度：主进程从 nativeTheme 读出推过来 → 侧栏实底
    await page.evaluate(() => window.__ws({ fullscreen: false, reducedTransparency: true }));
    check('降低透明度：html.reduce-transparency、侧栏实底',
      await page.evaluate(() => [document.documentElement.classList.contains('reduce-transparency'),
        getComputedStyle(document.querySelector('.sidebar')).backgroundColor]),
      [true, await page.evaluate(() => { const d = document.createElement('div'); d.style.background = 'var(--bg-elev)'; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; })]);
    await page.evaluate(() => window.__ws({ fullscreen: false, reducedTransparency: false }));
    check('关闭降低透明度：侧栏回到半透明', /\/ 0\.6\)$/.test(await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).backgroundColor)), true);
    // 吸顶分组头：静息透明，滚动后吸顶的那一个标 .is-stuck（换遮挡底色）
    const stuck = await page.evaluate(async () => {
      const tree = document.getElementById('tree');
      const h = document.querySelector('#tree > .folder > .folder-header');
      const restBg = getComputedStyle(h).backgroundColor;
      for (let i = 0; i < 30; i++) { const d = document.createElement('div'); d.className = 'file'; d.style.height = '26px'; d.dataset.pad = '1'; h.parentElement.querySelector('.folder-children').appendChild(d); }
      tree.scrollTop = 60;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = { restBg, stuck: h.classList.contains('is-stuck'), stuckBg: getComputedStyle(h).backgroundColor };
      tree.scrollTop = 0; document.querySelectorAll('[data-pad]').forEach(d => d.remove());
      return out;
    });
    check('桌面：分组头静息透明、吸顶时标 .is-stuck 并换成遮挡底色',
      [stuck.restBg, stuck.stuck, stuck.stuckBg !== 'rgba(0, 0, 0, 0)'], ['rgba(0, 0, 0, 0)', true, true]);
    // 全屏：红绿灯消失，内边距回到原值
    await page.evaluate(() => window.__ws({ fullscreen: true }));
    s = await page.evaluate(chrome);
    check('全屏：html.is-fullscreen', s.fullscreen, true);
    check('全屏：.sidebar-header 左内边距回到 12px', s.headerPadLeft, '12px');
    await page.evaluate(() => window.__ws({ fullscreen: false }));
    s = await page.evaluate(chrome);
    check('退出全屏：.sidebar-header 左内边距恢复 90px', s.headerPadLeft, '90px');

    // 侧栏收起：红绿灯压在主区顶栏上，改由 .main-header 让位
    await page.locator('#btn-toggle-sidebar').click();
    await page.waitForTimeout(300);
    s = await page.evaluate(chrome);
    check('侧栏收起：.main-header 左内边距 90px', s.mainHeaderPadLeft, '90px');
    await page.evaluate(() => window.__ws({ fullscreen: true }));
    await page.waitForTimeout(300);   // 顶栏左内边距有 200ms 过渡（跟随主区平移）
    s = await page.evaluate(chrome);
    check('侧栏收起 + 全屏：.main-header 左内边距回到 14px', s.mainHeaderPadLeft, '14px');
    await page.evaluate(() => window.__ws({ fullscreen: false }));
    await page.locator('#btn-toggle-sidebar').click();
    await page.waitForTimeout(300);
    s = await page.evaluate(chrome);
    check('侧栏展开：.main-header 左内边距回到 14px', s.mainHeaderPadLeft, '14px');

    // 专注模式：顶栏被隐藏，补一条 28px 透明拖动条；红绿灯经 setChromeState 隐藏
    await page.click('#tree .file[data-path$="a.md"] .file-name');
    await page.waitForTimeout(1200);
    check('专注前：#focus-drag 为 display:none', (await page.evaluate(focusChrome)).dragDisplay, 'none');
    await page.focus('#btn-focus');
    await page.keyboard.press('Meta+.');
    await page.waitForTimeout(400);
    let f = await page.evaluate(focusChrome);
    check('专注：html.focus-mode', f.focus, true);
    check('专注：#focus-drag 可见（display:block）', f.dragDisplay, 'block');
    check('专注：#focus-drag 贴顶、高 28px、横跨整窗', [f.dragTop, f.dragH, f.dragW], [0, 28, 1280]);
    check('专注：#focus-drag 可拖动', f.dragRegion, 'drag');
    check('专注：#focus-exit 不可拖动', f.exitRegion, 'no-drag');
    check('专注：elementFromPoint(胶囊中心) 命中 #focus-exit', f.exitHit, true);
    check('专注：.preview 下移 28px（拖动条压在空白上）', f.previewPadTop, '28px');
    check('专注：setChromeState 收到 { focusMode: true }',
      await page.evaluate(() => window.__chrome.slice(-1)), [{ focusMode: true }]);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    f = await page.evaluate(focusChrome);
    check('退出专注：#focus-drag 回到 display:none', f.dragDisplay, 'none');
    check('退出专注：.preview 内边距复原', f.previewPadTop, '0px');
    check('退出专注：setChromeState 收到 { focusMode: false }',
      await page.evaluate(() => window.__chrome.slice(-1)), [{ focusMode: false }]);
    // 菜单「显示 → 专注阅读」（CmdOrCtrl+.）经 onMenuCommand('toggle-focus') 转发
    await page.evaluate(() => window.__menu && window.__menu('toggle-focus'));
    await page.waitForTimeout(300);
    check('菜单命令 toggle-focus 进入专注', (await page.evaluate(focusChrome)).focus, true);
    await page.evaluate(() => window.__menu && window.__menu('toggle-focus'));
    await page.waitForTimeout(300);
    check('菜单命令 toggle-focus 退出专注', (await page.evaluate(focusChrome)).focus, false);
    check('setChromeState 依次收到 true / false / true / false',
      await page.evaluate(() => window.__chrome.map(x => x.focusMode)), [true, false, true, false]);
    await ctx.close();
  }

  // ---------- 桌面壳：主进程下发的避让宽度首帧生效 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(fakeBridge);
    await ctx.addInitScript(() => { window.atlasDesktop.titlebarInset = 82; window.atlasDesktop.reducedTransparency = true; });
    const page = await ctx.newPage();
    await page.goto(atlas.base, { waitUntil: 'load' });
    await page.waitForSelector('#tree .file');
    const s = await page.evaluate(chrome);
    check('桥下发 titlebarInset=82 → .sidebar-header 左内边距 82px', s.headerPadLeft, '82px');
    check('桥下发 reducedTransparency → 首帧就是 html.reduce-transparency',
      await page.evaluate(() => document.documentElement.classList.contains('reduce-transparency')), true);
    await ctx.close();
  }
  // ---------- 浏览器版（不注入） ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(atlas.base, { waitUntil: 'load' });
    await page.waitForSelector('#tree .file');
    const s = await page.evaluate(chrome);
    check('浏览器：没有 html[data-desktop]', s.desktop, null);
    check('浏览器：.sidebar-header 左内边距保持 12px', s.headerPadLeft, '12px');
    check('浏览器：顶栏不是拖动区', s.headerRegion === 'drag' || s.mainHeaderRegion === 'drag', false);
    check('浏览器：侧栏是不透明实底', /0\.\d+\)$/.test(s.sidebarBg), false);
    check('浏览器：.sidebar 贴左、宽 320', [s.sidebarLeft, s.sidebarW], [0, 320]);
    await page.click('#tree .file[data-path$="a.md"] .file-name');
    await page.waitForTimeout(1200);
    await page.focus('#btn-focus');
    await page.keyboard.press('Meta+.');
    await page.waitForTimeout(400);
    const f = await page.evaluate(focusChrome);
    check('浏览器：专注模式已进入', f.focus, true);
    check('浏览器：专注时 #focus-drag 仍是 display:none', f.dragDisplay, 'none');
    check('浏览器：专注时 .preview 不下移', f.previewPadTop, '0px');
    await ctx.close();
  }

  await browser.close();
  await atlas.stop();
  console.log(`\n总计 ${total} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
