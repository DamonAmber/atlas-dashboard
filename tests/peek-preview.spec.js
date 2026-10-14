// 快速查看（悬停预览，design §3c / §11.B5）
//
// 钉住：
//   ① 悬停 450ms 弹出、title 暂存、离开 150ms 收起并还原；侧栏定位（左缘 = 侧栏右缘 + 10px）
//   ② 键盘：Space 开关（#tree 不滚动）、↑/↓ 换内容、Esc 只关浮窗（焦点留在原行）、
//      再 Esc 才"退出列表"、第一行 ↑ 关浮窗并回 #search、Enter 关浮窗并打开
//   ③ 沙箱：.peek-frame 的 sandbox 严格等于 allow-scripts（含已信任的文档），不是预览帧
//   ④ 不标已读；设置关掉悬停后悬停不弹、Space 仍可用；拖拽期间不弹；设置页写明会加载在线资源
//   ⑤ 防抖：无缓存截图时连按 10 次 ↓，iframe 只加载最后一篇；有缓存截图时 <img> 每次立即换
//   ⑥ ⌘K 空状态 Space 打开；输入非空时 Space 照常输入
//   ⑦ 星表 .sm-star：Space 开关、↓ 换内容、Esc 只关浮窗且焦点留在原星
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

function tinyPng() {
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 90, 90, 200, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const files = {};
  for (let i = 1; i <= 14; i++) {
    const n = String(i).padStart(2, '0');
    files[`proj/doc-${n}.html`] = `<!doctype html><html><body><h1>文档 ${n}</h1><p>${'正文 '.repeat(40)}</p></body></html>`;
  }
  files['proj/zz-note.md'] = '# 笔记\n\n正文。\n';
  const atlas = await startAtlas({ prefix: 'atlas-peek-', files });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.route(u => u.pathname === '/api/thumb', route => route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng() }));
  await page.goto(atlas.base);
  await page.waitForSelector('#tree .file[data-path]');
  await page.waitForTimeout(400);

  const rowSel = (rel) => `#tree .file[data-path="${atlas.filePath(rel)}"]`;
  const peekOpen = () => page.evaluate(() => !document.getElementById('peek').classList.contains('hidden'));
  const peekTitle = () => page.evaluate(() => document.getElementById('peek-title').textContent);
  const parkMouse = () => page.mouse.move(900, 12);   // 顶栏空白处：不是任何触发目标

  // ================================================================
  console.log('\n[悬停] 450ms 弹出、title 暂存、离开还原');
  await parkMouse();
  const r1 = rowSel('proj/doc-01.html');
  const titleBefore = await page.getAttribute(r1, 'title');
  await page.hover(`${r1} .file-name`);
  await page.waitForTimeout(250);
  check('250ms 时还没弹出（意图延迟）', await peekOpen(), false);
  check('悬停计时开始时 title 已移走', await page.getAttribute(r1, 'title'), null);
  await page.waitForTimeout(350);
  check('450ms 后弹出', await peekOpen(), true);
  check('#peek-title 是文件名', await peekTitle(), 'doc-01');
  check('触发行 aria-describedby=peek-meta', await page.getAttribute(r1, 'aria-describedby'), 'peek-meta');
  check('title 信息并入 #peek-meta 第二行', await page.evaluate(() =>
    document.querySelector('#peek-meta .peek-meta-l2').textContent), 'proj/doc-01.html');
  // 等弹出动画（atlas-peek-in，spring 缓动会过冲到 scale≈1.006）播完再量几何：
  // 过冲期间 top 会比夹紧值小零点几 px（宽度仍四舍五入成 380），机器忙时检查恰好落在这段里就偶发失败
  await page.evaluate(() => Promise.all(document.getElementById('peek').getAnimations().map(a => a.finished.catch(() => {}))));
  const geo = await page.evaluate(() => {
    const pk = document.getElementById('peek').getBoundingClientRect();
    const sb = document.getElementById('sidebar').getBoundingClientRect();
    return { gap: pk.left - sb.right, width: pk.width, top: pk.top, bottom: pk.bottom, vh: innerHeight };
  });
  check('侧栏定位：左缘 = 侧栏右缘 + 10px（±1）', Math.abs(geo.gap - 10) <= 1, true);
  check('宽 380px', Math.round(geo.width), 380);
  check('上下夹在视口内 8px', geo.top >= 8 && geo.bottom <= geo.vh - 8, true);
  check('浮窗整体 pointer-events:none', await page.evaluate(() =>
    getComputedStyle(document.getElementById('peek')).pointerEvents), 'none');
  check('无缓存截图 → 实时 iframe', await page.evaluate(() => {
    const f = document.querySelector('#peek .peek-frame');
    return !!f && !f.classList.contains('hidden') && f.getAttribute('src');
  }), '/raw/0/proj/doc-01.html');
  // 已弹出时移到另一行：立即切换
  await page.hover(`${rowSel('proj/doc-02.html')} .file-name`);
  await page.waitForTimeout(60);
  check('已弹出时移到另一行立即切换', await peekTitle(), 'doc-02');
  check('上一行的 title 已还原', await page.getAttribute(r1, 'title'), titleBefore);
  await parkMouse();
  await page.waitForTimeout(80);
  check('离开 80ms 时还开着（150ms 收起）', await peekOpen(), true);
  await page.waitForTimeout(200);
  check('离开后收起', await peekOpen(), false);
  check('离开后 title 还原', await page.getAttribute(rowSel('proj/doc-02.html'), 'title') !== null, true);
  check('关闭后移除 aria-describedby', await page.getAttribute(rowSel('proj/doc-02.html'), 'aria-describedby'), null);
  // 按下鼠标立即关闭
  await page.hover(`${rowSel('proj/doc-03.html')} .file-name`);
  await page.waitForTimeout(550);
  check('（再次弹出）', await peekOpen(), true);
  await page.mouse.wheel(0, 10);
  await page.waitForTimeout(50);
  check('滚轮立即关闭', await peekOpen(), false);
  await parkMouse();

  // ================================================================
  console.log('\n[沙箱] .peek-frame 只有 allow-scripts，不切同源，不是预览帧');
  const frameAttrs = () => page.evaluate(() => {
    const f = document.querySelector('#peek .peek-frame');
    return f && {
      sandbox: f.getAttribute('sandbox'), id: f.id, cls: f.className.replace(/\s*hidden/, ''),
      referrer: f.getAttribute('referrerpolicy'), tabindex: f.getAttribute('tabindex'),
      ariaHidden: f.getAttribute('aria-hidden'), allow: f.getAttribute('allow'),
    };
  });
  const fa = await frameAttrs();
  check('sandbox 严格等于 allow-scripts', fa && fa.sandbox, 'allow-scripts');
  check('不带 id=preview、不带 .preview-frame', fa && [fa.id, fa.cls], ['', 'peek-frame']);
  check('referrerpolicy=no-referrer、tabindex=-1、aria-hidden', fa && [fa.referrer, fa.tabindex, fa.ariaHidden], ['no-referrer', '-1', 'true']);
  check('allow 禁掉 autoplay / camera / mic / geolocation / fullscreen', fa && fa.allow,
    "autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'");
  check('不进 state.tabs', await page.evaluate(() => state.tabs.length), 0);
  // 已信任的文档也不切同源
  const trustedPath = atlas.filePath('proj/doc-05.html');
  await page.evaluate(async (p) => {
    await fetch('/api/trust', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p, trusted: true }) });
    await fetchState();
  }, trustedPath);
  check('（doc-05 已信任）', await page.evaluate((p) => state.trusted.has(p), trustedPath), true);
  await page.hover(`${rowSel('proj/doc-05.html')} .file-name`);
  await page.waitForTimeout(600);
  check('已信任的文档：sandbox 仍严格等于 allow-scripts', (await frameAttrs()).sandbox, 'allow-scripts');
  check('frame 指向 doc-05', await page.evaluate(() => document.querySelector('#peek .peek-frame').getAttribute('src')), '/raw/0/proj/doc-05.html');
  await parkMouse();
  await page.waitForTimeout(300);

  console.log('\n[不标已读]');
  const st = await page.evaluate(async () => (await (await fetch('/api/state')).json()).files);
  check('快速查看过的文档仍是 unread', [st[atlas.filePath('proj/doc-01.html')].unread, st[trustedPath].unread], [true, true]);

  // ================================================================
  console.log('\n[键盘] Space / ↑↓ / Esc / Enter');
  await page.click('#search');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  const focusedPath = () => page.evaluate(() => document.activeElement && document.activeElement.dataset.path);
  check('↓ 进入列表第一行', await focusedPath(), atlas.filePath('proj/doc-01.html'));
  const scroll0 = await page.evaluate(() => els.tree.scrollTop);
  await page.keyboard.press(' ');
  await page.waitForTimeout(100);
  check('Space 打开', await peekOpen(), true);
  check('打开的是焦点行', await peekTitle(), 'doc-01');
  check('#tree 没有因 Space 滚动', await page.evaluate(() => els.tree.scrollTop), scroll0);
  check('焦点行 aria-describedby=peek-meta', await page.getAttribute(rowSel('proj/doc-01.html'), 'aria-describedby'), 'peek-meta');
  await page.keyboard.press(' ');
  await page.waitForTimeout(80);
  check('再按 Space 关闭', await peekOpen(), false);
  await page.keyboard.press(' ');
  await page.waitForTimeout(80);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  check('↓ 后浮窗内容跟着换', [await peekOpen(), await peekTitle()], [true, 'doc-02']);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(80);
  check('↑ 换回上一行', await peekTitle(), 'doc-01');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  check('Esc 关闭浮窗', await peekOpen(), false);
  check('焦点仍在原 .file', await focusedPath(), atlas.filePath('proj/doc-02.html'));
  check('它仍带 .kbd-focus', await page.evaluate(() => document.activeElement.classList.contains('kbd-focus')), true);
  check('#search 没拿到焦点', await page.evaluate(() => document.activeElement.id !== 'search'), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  check('再按 Esc 才走"退出列表"（焦点回 #search）', await page.evaluate(() => document.activeElement.id), 'search');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  await page.waitForTimeout(80);
  check('（第一行打开浮窗）', await peekOpen(), true);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(80);
  check('第一行按 ↑：浮窗关闭', await peekOpen(), false);
  check('焦点在 #search', await page.evaluate(() => document.activeElement.id), 'search');

  // ================================================================
  console.log('\n[防抖] 无缓存截图：连按 10 次 ↓，iframe 只加载最后一篇');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  await page.waitForFunction(() => {
    const f = document.querySelector('#peek .peek-frame');
    return f && f.getAttribute('src') === '/raw/0/proj/doc-01.html' && f.contentWindow;
  });
  await page.waitForTimeout(500);   // 首个 load 之后再挂 observer
  await page.evaluate(() => {
    window.__srcSets = [];
    const f = document.querySelector('#peek .peek-frame');
    new MutationObserver((ms) => {
      for (const m of ms) if (m.attributeName === 'src') window.__srcSets.push(f.getAttribute('src'));
    }).observe(f, { attributes: true, attributeFilter: ['src'] });
  });
  const titlesOk = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('ArrowDown');
    const [t, f] = await page.evaluate(() => [document.getElementById('peek-title').textContent,
      document.activeElement.querySelector('.file-name').textContent]);
    titlesOk.push(t === f);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(600);
  const sets = await page.evaluate(() => window.__srcSets.filter(s => s !== 'about:blank'));
  check('#peek-title 每次按键后都已更新', titlesOk.every(Boolean), true);
  check('非 about:blank 的 src 赋值恰好 1 次，指向最后一行', sets, ['/raw/0/proj/doc-11.html']);
  check('期间先导航 about:blank（不让上一篇的脚本继续跑）', await page.evaluate(() => window.__srcSets[0]), 'about:blank');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);

  console.log('\n[防抖] 有缓存截图：<img> 每次按键立即更新');
  await page.evaluate(() => {
    const th = effectiveTheme();
    for (const f of Object.values(state.files)) {
      state.thumbs.items.set(th + '|' + f.path, { status: 'ready', k: '0123456789abcdef', mtime: f.mtime });
    }
  });
  await page.keyboard.press(' ');
  await page.waitForTimeout(80);
  const imgOk = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowUp');
    imgOk.push(await page.evaluate(() => {
      const img = document.getElementById('peek-img');
      const p = document.activeElement.dataset.path;
      return !img.classList.contains('hidden') && img.getAttribute('src').includes(encodeURIComponent(p));
    }));
  }
  check('<img> 每次按键都立即换成焦点行的截图', imgOk, [true, true, true]);
  check('有截图时 iframe 回 about:blank 且隐藏', await page.evaluate(() => {
    const f = document.querySelector('#peek .peek-frame');
    return f.classList.contains('hidden') && f.getAttribute('src');
  }), 'about:blank');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  check('Enter：关浮窗并打开文档', [await peekOpen(), await page.evaluate(() => state.activeFilePath)],
    [false, atlas.filePath('proj/doc-08.html')]);
  await page.evaluate(() => state.thumbs.items.clear());

  // ================================================================
  console.log('\n[标签] 非活动 Tab 悬停弹出、活动 Tab 不弹');
  await page.click(`${rowSel('proj/doc-09.html')} .file-name`);
  await page.waitForTimeout(600);
  await parkMouse();
  check('.tab 带 data-path', await page.evaluate(() => [...document.querySelectorAll('#tab-bar .tab')].every(t => !!t.dataset.path)), true);
  await page.hover(`#tab-bar .tab[data-path="${atlas.filePath('proj/doc-08.html')}"] .tab-name`);
  await page.waitForTimeout(600);
  check('悬停非活动 Tab 弹出', [await peekOpen(), await peekTitle()], [true, 'doc-08']);
  const tabGeo = await page.evaluate((p) => {
    const t = document.querySelector(`#tab-bar .tab[data-path="${p}"]`).getBoundingClientRect();
    return document.getElementById('peek').getBoundingClientRect().top >= t.bottom;
  }, atlas.filePath('proj/doc-08.html'));
  check('Tab → 浮窗在标签下方', tabGeo, true);
  await parkMouse();
  await page.waitForTimeout(300);
  await page.hover('#tab-bar .tab.active .tab-name');
  await page.waitForTimeout(600);
  check('活动 Tab 不弹', await peekOpen(), false);
  await page.hover(`${rowSel('proj/doc-09.html')} .file-name`);
  await page.waitForTimeout(600);
  check('当前活动文档的侧栏行也不弹', await peekOpen(), false);
  await parkMouse();
  await page.click('#btn-home');
  await page.waitForTimeout(500);

  // ================================================================
  console.log('\n[⌘K] 空状态 Space 打开，输入非空时照常输入');
  await page.keyboard.press('Meta+K');
  await page.waitForSelector('#quickopen:not(.hidden)');
  await page.waitForTimeout(200);
  const activeName = await page.evaluate(() => {
    const it = document.querySelector('#quickopen-list .quickopen-item.active[data-path]');
    return it && state.files[it.dataset.path] && stripDocExt(state.files[it.dataset.path].name);
  });
  await page.keyboard.press(' ');
  await page.waitForTimeout(100);
  check('⌘K 空状态 Space 打开快速查看', [await peekOpen(), await peekTitle()], [true, activeName]);
  check('输入框没被写进空格', await page.inputValue('#quickopen-input'), '');
  check('浮窗叠在 ⌘K 之上', await page.evaluate(() =>
    +getComputedStyle(document.getElementById('peek')).zIndex > +getComputedStyle(document.getElementById('quickopen')).zIndex), true);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  const activeName2 = await page.evaluate(() => {
    const it = document.querySelector('#quickopen-list .quickopen-item.active[data-path]');
    return stripDocExt(state.files[it.dataset.path].name);
  });
  check('⌘K 里 ↓ 浮窗跟着换', await peekTitle(), activeName2);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('Esc 先只关浮窗', [await peekOpen(), await page.evaluate(() => !document.getElementById('quickopen').classList.contains('hidden'))], [false, true]);
  await page.keyboard.type('doc ');
  await page.waitForTimeout(100);
  check('输入非空时 Space 照常输入', [await page.inputValue('#quickopen-input'), await peekOpen()], ['doc ', false]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('再 Esc 关 ⌘K', await page.evaluate(() => document.getElementById('quickopen').classList.contains('hidden')), true);

  // ================================================================
  console.log('\n[拖拽] 拖拽期间不弹');
  await page.evaluate(() => { isDragging = true; });
  await page.hover(`${rowSel('proj/doc-04.html')} .file-name`);
  await page.waitForTimeout(600);
  check('isDragging 时悬停不弹', await peekOpen(), false);
  await page.evaluate(() => { isDragging = false; });
  await parkMouse();

  // ================================================================
  console.log('\n[设置] 关闭悬停预览');
  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const t = document.querySelector('[data-pane-tab="appearance"], [data-pane-btn="appearance"], [data-tab="appearance"]');
    if (t) t.click();
  });
  check('设置页「悬停预览」一行写明会加载在线资源', await page.evaluate(() =>
    document.getElementById('peek-net-note').textContent.includes('在线资源')), true);
  await page.evaluate(() => document.querySelector('[data-peek-pick="off"]').click());
  check('localStorage atlas:peek=off', await page.evaluate(() => localStorage.getItem('atlas:peek')), 'off');
  check('「关」选中', await page.getAttribute('[data-peek-pick="off"]', 'aria-checked'), 'true');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const r6 = rowSel('proj/doc-06.html');
  const t6 = await page.getAttribute(r6, 'title');
  await page.hover(`${r6} .file-name`);
  await page.waitForTimeout(650);
  check('关闭后悬停不弹', await peekOpen(), false);
  check('关闭后完全不碰 title', await page.getAttribute(r6, 'title'), t6);
  await parkMouse();
  await page.click('#search');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  await page.waitForTimeout(100);
  check('关闭悬停后 Space 仍可用', await peekOpen(), true);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('[data-peek-pick="on"]').click());

  // ================================================================
  console.log('\n[星表] .sm-star 上 Space / ↓ / Esc');
  await page.evaluate(() => selectView('map'));
  await page.waitForTimeout(400);
  await page.click('.sm-cluster[data-project="proj"]');
  await page.waitForTimeout(200);
  await page.focus('.sm-star');
  const star0 = await page.evaluate(() => document.activeElement.dataset.path);
  await page.keyboard.press(' ');
  await page.waitForTimeout(150);
  check('Space 打开浮窗', await peekOpen(), true);
  check('浮窗内容是聚焦的那颗星', await page.evaluate(() => AtlasPeek.currentPath()), star0);
  check('星表行 aria-describedby=peek-meta', await page.evaluate(() => document.activeElement.getAttribute('aria-describedby')), 'peek-meta');
  check('Space 没有打开文档', await page.evaluate(() => state.activeFilePath), null);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const star1 = await page.evaluate(() => document.activeElement.dataset.path);
  check('↓ 移到下一颗星，浮窗跟着换', [star1 !== star0, await page.evaluate(() => AtlasPeek.currentPath()) === star1], [true, true]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Esc 只关浮窗', await peekOpen(), false);
  check('Esc 后焦点留在原星', await page.evaluate(() => document.activeElement.dataset.path), star1);
  check('Esc 没有离开星图', await page.evaluate(() => starmapVisible()), true);
  await page.keyboard.press(' ');
  await page.waitForTimeout(100);
  await page.keyboard.press(' ');
  await page.waitForTimeout(100);
  check('Space 再按一次关闭（开关）', await peekOpen(), false);
  await page.evaluate(() => selectView('groups'));
  await page.waitForTimeout(300);

  console.log('\n[快捷键速查表] 有 Space 一行');
  check('SHORTCUTS 有 Space 快速查看', await page.evaluate(() =>
    SHORTCUTS.some(g => g.group === '侧栏与目录树' && g.items.some(([k, d]) => k[0] === 'Space' && d.includes('快速查看')))), true);

  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
