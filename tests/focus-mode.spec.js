// 专注阅读模式（design §3f「可测性」+ §10.11 + §11.D）
//
// html.focus-mode 一个类隐藏侧栏 / 顶栏 / 标签栏，只留正文。本 spec 钉住：
//   ① 进出：⌘. 进入后侧栏移出视口、顶栏与标签栏不可见、退出胶囊出现、焦点进正文；
//      Esc 退出后侧栏几何与进入前一致（侧栏展开 / 收起两种初始态），
//      atlas:sidebarCollapsed 与 body.sidebar-collapsed 都没被碰过，焦点回到 #btn-focus
//   ② 不能进入：首页 ⌘. 无效（按钮也隐藏）；编辑态 ⌘. 出 toast 且不进入
//   ③ 快捷键桥：焦点在 Atlas 渲染的 MD 帧 / 已信任 HTML 帧里时 ⌘. 与 Esc 经桥生效；
//      非专注时帧内 Esc 仍不转发（preview-shortcut-bridge 语义不变）
//   ④ 阅读进度：长 MD 进专注后 #focus-progress 可见，帧内滚到底 scaleX ≈ 1；
//      未信任 HTML（沙箱帧）进专注后 #focus-progress 带 .hidden
//   ⑤ 阅读宽度（§10.11 / §11.D）：帧内 data-focus 进入设置、退出移除；左下角控件实底、
//      第一次进入即可见，鼠标静止 2 秒后与退出胶囊一起淡出、移动后回来；
//      专注中点「加宽」→ atlas:mdReadWidth==='wide' 且帧内 data-read-width="wide"，
//      按 [ 回推荐，退出后普通预览仍是推荐
//   ⑥ 不持久化：刷新后不在专注；自动退出：查找栏进入时关闭、关掉最后一个 Tab / 文档被删除
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

const longMd = '# 长文档\n\n' + Array.from({ length: 12 }, (_, i) =>
  `## 第 ${i + 1} 节\n\n` + '这是一段用来撑开篇幅的正文，阅读进度条要能从 0 走到 1。'.repeat(12) + '\n\n'
).join('');
const longHtml = '<!doctype html><html><body><h1>已信任的报告</h1>'
  + '<p>段落文字，用来承载点击落点与滚动。</p>'.repeat(120) + '</body></html>';

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-focus-',
    files: {
      'proj/long.md': longMd,
      'proj/short.md': '# 短文\n\n一段话。\n',
      'proj/sandboxed.html': longHtml.replace('已信任的报告', '沙箱里的报告'),
      'proj/trusted.html': longHtml,
      'proj/doomed.md': '# 将被删除\n\n正文。\n',
    },
  });
  const browser = await chromium.launch();
  // reduced-motion：过渡时长令牌归零，几何 / 透明度断言不用等动画
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(atlas.base);
  await page.waitForSelector('#tree .file');

  // ---------- 工具 ----------
  const frame = async () => {
    const h = await page.$('#preview');
    const f = h && await h.contentFrame();
    if (!f) throw new Error('找不到预览 iframe');
    return f;
  };
  const openFile = async (suffix) => {
    await page.click(`#tree .file[data-path$="${suffix}"] .file-name`);
    await page.waitForFunction((s) => {
      const f = document.getElementById('preview');
      if (!f || !f.dataset) return false;
      const tabs = document.querySelectorAll('#tab-bar .tab.active');
      const t = tabs[0];
      if (!t || !t.dataset.path.endsWith(s)) return false;
      return !f.classList.contains('loading');
    }, suffix, { timeout: 8000 });
    await page.waitForTimeout(500);
  };
  const shell = () => page.evaluate(() => {
    const vis = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0 && r.width > 0;
    };
    const sb = document.querySelector('.sidebar').getBoundingClientRect();
    const ex = document.getElementById('focus-exit');
    const bar = document.getElementById('focus-progress');
    return {
      focus: document.documentElement.classList.contains('focus-mode'),
      sidebarRight: Math.round(sb.right),
      sidebarRect: [sb.left, sb.width].map(Math.round),
      headerVisible: vis(document.querySelector('.main-header')),
      tabBarVisible: vis(document.getElementById('tab-bar')),
      exitShown: !!ex && !ex.classList.contains('hidden') && getComputedStyle(ex).display !== 'none',
      exitAwake: !!ex && ex.classList.contains('awake'),
      exitOpacity: ex ? getComputedStyle(ex).opacity : null,
      pressed: document.getElementById('btn-focus').getAttribute('aria-pressed'),
      btnHidden: document.getElementById('btn-focus').classList.contains('hidden'),
      active: document.activeElement.tagName + (document.activeElement.id ? '#' + document.activeElement.id : ''),
      collapsedClass: document.body.classList.contains('sidebar-collapsed'),
      collapsedLs: localStorage.getItem('atlas:sidebarCollapsed'),
      barHidden: bar.classList.contains('hidden'),
      barScale: (() => { const m = getComputedStyle(bar).transform; const a = /matrix\(([^,]+)/.exec(m); return a ? +(+a[1]).toFixed(3) : m; })(),
      badgeInMain: document.getElementById('match-badge').parentNode === document.querySelector('.main'),
      findOpen: !document.getElementById('find-bar').classList.contains('hidden'),
    };
  });
  const frameState = async () => (await frame()).evaluate(() => {
    const root = document.documentElement;
    const sw = document.querySelector('.md-width-switch');
    const lbl = sw && sw.querySelector('.md-width-lbl');
    const r = sw && sw.getBoundingClientRect();
    const toc = document.querySelector('.md-toc');
    return {
      // 目录栏底部留白必须 ≥ 控件高度 + 底边距，长目录滚到底时末项不被左下角的宽度控件压住
      tocClear: toc && r ? parseFloat(getComputedStyle(toc).paddingBottom) >= Math.ceil(innerHeight - r.top) : null,
      dataFocus: root.getAttribute('data-focus'),
      idle: root.getAttribute('data-focus-idle'),
      readWidth: root.getAttribute('data-read-width') || 'comfortable',
      sw: sw ? {
        left: Math.round(r.left), bottomGap: Math.round(innerHeight - r.bottom),
        opacity: getComputedStyle(sw).opacity,
        bg: getComputedStyle(sw).backgroundColor,
        lbl: lbl ? (getComputedStyle(lbl).display !== 'none' ? lbl.textContent : '(隐藏)') : null,
      } : null,
    };
  });
  const pressFocusKey = () => page.keyboard.press('Meta+.');

  // ================================================================
  console.log('\n[首页] ⌘. 无效，按钮隐藏');
  await page.focus('#search');
  await page.evaluate(() => document.activeElement.blur());
  await pressFocusKey();
  await page.waitForTimeout(200);
  let s = await shell();
  check('首页：未进入专注', s.focus, false);
  check('首页：#btn-focus 隐藏', s.btnHidden, true);

  // ================================================================
  console.log('\n[进入 / 退出] 侧栏展开的初始态');
  await openFile('long.md');
  const before = await shell();
  check('打开文档后 #btn-focus 可见', before.btnHidden, false);
  check('初始态侧栏展开', before.collapsedClass, false);
  await page.focus('#btn-focus');
  await pressFocusKey();
  await page.waitForTimeout(300);
  s = await shell();
  check('⌘. 后 html.focus-mode', s.focus, true);
  check('.sidebar 的 right ≤ 0', s.sidebarRight <= 0, true);
  check('.main-header 不可见', s.headerVisible, false);
  check('#tab-bar 不可见', s.tabBarVisible, false);
  check('#focus-exit 出现', s.exitShown, true);
  check('#btn-focus aria-pressed=true', s.pressed, 'true');
  check('焦点移到预览帧', s.active, 'IFRAME#preview');
  check('命中导航条挪到 .main 下（随正文保留）', s.badgeInMain, true);
  check('没碰 body.sidebar-collapsed', s.collapsedClass, false);
  let fst = await frameState();
  check('MD 帧 <html data-focus="1">', fst.dataFocus, '1');
  check('宽度控件第一次进入即可见（opacity 1）', fst.sw && fst.sw.opacity, '1');
  check('宽度控件在左下角（left 18 / bottom 18）', fst.sw && [fst.sw.left, fst.sw.bottomGap], [18, 18]);
  check('宽度控件前置「宽度 [ ]」标签', fst.sw && fst.sw.lbl, '宽度 [ ]');
  check('宽度控件实底（浅色 = --bg-elev-2 #edf0f5）', fst.sw && fst.sw.bg, 'rgb(237, 240, 245)');
  check('目录栏底部留白让出宽度控件（末项不被遮住）', fst.tocClear, true);

  console.log('\n[阅读进度] 长 MD');
  check('#focus-progress 可见', s.barHidden, false);
  check('顶部 scaleX ≈ 0', s.barScale <= 0.02, true);
  // MD 页全局 scroll-behavior:smooth，用 instant 直接到位
  await (await frame()).evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(200);
  s = await shell();
  check('滚到底后 scaleX ≈ 1（实际 ' + s.barScale + '）', Math.abs(s.barScale - 1) < 0.02, true);
  await (await frame()).evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  console.log('\n[淡出] 鼠标静止 2 秒后退出胶囊与宽度控件一起淡出，移动后回来');
  await page.waitForTimeout(2300);
  s = await shell();
  fst = await frameState();
  check('静止后 #focus-exit 不再 .awake', s.exitAwake, false);
  check('静止后 #focus-exit opacity 0', s.exitOpacity, '0');
  check('静止后帧内 data-focus-idle="1"', fst.idle, '1');
  check('静止后宽度控件 opacity 0', fst.sw.opacity, '0');
  await page.mouse.move(700, 450);
  await page.mouse.move(720, 470);
  await page.waitForTimeout(150);
  s = await shell();
  fst = await frameState();
  check('鼠标移动（帧内）后 #focus-exit 回到 opacity 1', s.exitOpacity, '1');
  check('鼠标移动后宽度控件回到 opacity 1', fst.sw.opacity, '1');

  console.log('\n[阅读宽度] 专注中切档写同一个偏好');
  check('初始是推荐宽度', fst.readWidth, 'comfortable');
  await (await frame()).click('.md-width-switch button[data-w="wide"]');
  await page.waitForTimeout(150);
  fst = await frameState();
  check('点「加宽」→ 帧内 data-read-width="wide"', fst.readWidth, 'wide');
  check('点「加宽」→ localStorage atlas:mdReadWidth === "wide"',
    await page.evaluate(() => localStorage.getItem('atlas:mdReadWidth')), 'wide');
  await (await frame()).click('h1');
  await page.keyboard.press('[');
  await page.waitForTimeout(150);
  fst = await frameState();
  check('按 [ 回推荐', fst.readWidth, 'comfortable');
  check('localStorage 同步为 comfortable',
    await page.evaluate(() => localStorage.getItem('atlas:mdReadWidth')), 'comfortable');

  console.log('\n[Esc 经桥] 焦点在 MD 帧内按 Esc 退出专注');
  check('焦点仍在帧内', (await shell()).active, 'IFRAME#preview');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  s = await shell();
  check('Esc 后退出专注', s.focus, false);
  check('退出后仍停在文档（没有连带回首页）',
    await page.evaluate(() => !!document.querySelector('#crumbs .crumb-name')), true);
  check('侧栏几何与进入前一致', s.sidebarRect, before.sidebarRect);
  check('atlas:sidebarCollapsed 未变', s.collapsedLs, before.collapsedLs);
  check('body.sidebar-collapsed 未变', s.collapsedClass, before.collapsedClass);
  check('顶栏恢复可见', s.headerVisible, true);
  check('焦点回到 #btn-focus', s.active, 'BUTTON#btn-focus');
  check('#focus-exit 收起', s.exitShown, false);
  check('#focus-progress 收起', s.barHidden, true);
  check('命中导航条回到顶栏', s.badgeInMain, false);
  fst = await frameState();
  check('退出后帧内 data-focus 移除', fst.dataFocus, null);
  check('退出后普通预览仍是推荐宽度', fst.readWidth, 'comfortable');
  check('普通预览态宽度控件回到右上角、无标签', fst.sw && [fst.sw.lbl, fst.sw.bottomGap > 400], ['(隐藏)', true]);

  // ================================================================
  console.log('\n[非专注] 帧内 Esc 仍不转发');
  await (await frame()).click('h1');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('帧内 Esc 没有让外壳回首页',
    await page.evaluate(() => !!document.querySelector('#crumbs .crumb-name')), true);

  // ================================================================
  console.log('\n[⌘. 经桥] 焦点在 MD 帧内按 ⌘. 进出');
  await (await frame()).click('h1');
  await pressFocusKey();
  await page.waitForTimeout(300);
  check('帧内 ⌘. 进入专注', (await shell()).focus, true);
  await (await frame()).click('h1');
  await pressFocusKey();
  await page.waitForTimeout(300);
  check('帧内再按 ⌘. 退出专注', (await shell()).focus, false);

  // ================================================================
  console.log('\n[进入 / 退出] 侧栏收起的初始态');
  await page.focus('#btn-toggle-sidebar');
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(300);
  const beforeC = await shell();
  check('初始态侧栏收起', beforeC.collapsedClass, true);
  await page.click('#btn-focus');
  await page.waitForTimeout(300);
  s = await shell();
  check('点 #btn-focus 进入专注', s.focus, true);
  check('收起态进入：.sidebar 的 right ≤ 0', s.sidebarRight <= 0, true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  s = await shell();
  check('收起态：Esc 退出', s.focus, false);
  check('收起态：侧栏几何与进入前一致', s.sidebarRect, beforeC.sidebarRect);
  check('收起态：body.sidebar-collapsed 仍为 true', s.collapsedClass, true);
  check('收起态：atlas:sidebarCollapsed 未变', s.collapsedLs, beforeC.collapsedLs);
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(300);

  // ================================================================
  console.log('\n[查找栏] 进入时关闭');
  await page.focus('#btn-focus');
  await page.keyboard.press('Meta+f');
  await page.waitForTimeout(200);
  check('⌘F 打开查找栏', (await shell()).findOpen, true);
  await page.focus('#btn-focus');
  await pressFocusKey();
  await page.waitForTimeout(300);
  s = await shell();
  check('进入专注时查找栏关闭', [s.focus, s.findOpen], [true, false]);
  await page.click('#focus-exit');
  await page.waitForTimeout(300);
  check('点 #focus-exit 退出', (await shell()).focus, false);

  // ================================================================
  console.log('\n[编辑态] ⌘. 出 toast 且不进入');
  await page.click('#btn-edit');
  await page.waitForSelector('#btn-edit-cancel:not(.hidden)');
  await page.waitForTimeout(400);
  await page.focus('#btn-edit-cancel');
  await pressFocusKey();
  await page.waitForTimeout(300);
  check('编辑态：未进入专注', (await shell()).focus, false);
  check('编辑态：出现提示 toast', await page.evaluate(() => [...document.querySelectorAll('.toast')]
    .some(t => /编辑中不能进入专注模式，先保存或取消/.test(t.textContent))), true);
  await page.click('#btn-edit-cancel');
  await page.waitForTimeout(600);

  // ================================================================
  console.log('\n[刷新] 不持久化');
  await page.focus('#btn-focus');
  await pressFocusKey();
  await page.waitForTimeout(200);
  check('刷新前在专注', (await shell()).focus, true);
  await page.reload();
  await page.waitForSelector('#tree .file');
  await page.waitForTimeout(800);
  s = await shell();
  check('刷新后不在专注', s.focus, false);
  check('刷新后侧栏正常（right > 0）', s.sidebarRight > 0, true);

  // ================================================================
  console.log('\n[未信任 HTML] 沙箱帧不显示进度条');
  await openFile('sandboxed.html');
  check('sandboxed.html 确实在沙箱里预览',
    await page.evaluate(() => (document.getElementById('preview').getAttribute('sandbox') || '').includes('allow-same-origin')), false);
  await page.focus('#btn-focus');
  await pressFocusKey();
  await page.waitForTimeout(300);
  s = await shell();
  check('沙箱帧：进入专注', s.focus, true);
  check('沙箱帧：#focus-progress 带 .hidden', s.barHidden, true);
  check('沙箱帧：没被放宽成同源',
    await page.evaluate(() => (document.getElementById('preview').getAttribute('sandbox') || '').includes('allow-same-origin')), false);
  await page.keyboard.press('Escape');   // 焦点在沙箱帧里：桥绑不上，Esc 到不了外壳（设计如此）
  await page.waitForTimeout(200);
  await page.click('#focus-exit');
  await page.waitForTimeout(300);
  check('沙箱帧：用 #focus-exit 退出', (await shell()).focus, false);

  // ================================================================
  console.log('\n[已信任 HTML] 帧内 ⌘. 与 Esc 经桥生效，进度条可见');
  const trustedPath = atlas.filePath('proj/trusted.html');
  const tr = await page.evaluate(async (p) => {
    const r = await fetch('/api/trust', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, trusted: true }) });
    return r.status;
  }, trustedPath);
  check('信任 trusted.html', tr, 200);
  await page.reload();
  await page.waitForSelector('#tree .file');
  await page.waitForTimeout(600);
  await openFile('trusted.html');
  check('trusted.html 是同源帧（无 sandbox）',
    await page.evaluate(() => document.getElementById('preview').hasAttribute('sandbox')), false);
  await (await frame()).click('h1');
  await pressFocusKey();
  await page.waitForTimeout(300);
  s = await shell();
  check('已信任帧内 ⌘. 进入专注', s.focus, true);
  check('已信任帧：#focus-progress 可见', s.barHidden, false);
  check('已信任帧：HTML 不设 data-focus（宽度控件只在 MD 页）',
    await (await frame()).evaluate(() => document.documentElement.getAttribute('data-focus')), null);
  await (await frame()).evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(200);
  check('已信任帧：滚到底 scaleX ≈ 1', Math.abs((await shell()).barScale - 1) < 0.02, true);
  await (await frame()).click('h1');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('已信任帧内 Esc 经桥退出专注', (await shell()).focus, false);

  // ================================================================
  console.log('\n[自动退出] 文档被删除');
  await openFile('doomed.md');
  await page.focus('#btn-focus');
  await pressFocusKey();
  await page.waitForTimeout(300);
  check('doomed.md 进入专注', (await shell()).focus, true);
  fs.unlinkSync(atlas.filePath('proj/doomed.md'));
  await page.waitForFunction(() => !document.documentElement.classList.contains('focus-mode'), null, { timeout: 8000 }).catch(() => {});
  s = await shell();
  check('活动文档被删除后自动退出专注', s.focus, false);
  check('退出后红绿灯 / 侧栏恢复（right > 0）', s.sidebarRight > 0, true);

  console.log('\n[自动退出] 关掉最后一个 Tab');
  // 只留一个 Tab
  while (await page.evaluate(() => document.querySelectorAll('#tab-bar .tab').length) > 1) {
    await page.click('#tab-bar .tab:not(.active) .tab-close');
    await page.waitForTimeout(150);
  }
  if (!(await page.evaluate(() => !!document.querySelector('#tab-bar .tab.active')))) await openFile('short.md');
  await page.focus('#btn-focus');
  await pressFocusKey();
  await page.waitForTimeout(300);
  check('最后一个 Tab 进入专注', (await shell()).focus, true);
  // ⌘W 在真实浏览器里会先被浏览器吃掉；这里直接派发给外壳的 keydown
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(500);
  s = await shell();
  check('关掉最后一个 Tab 后回首页且退出专注', [s.focus, await page.evaluate(() => !!document.querySelector('#crumbs .crumb-name'))], [false, false]);
  check('首页 #btn-focus 隐藏', s.btnHidden, true);

  // ================================================================
  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log(`\n总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
