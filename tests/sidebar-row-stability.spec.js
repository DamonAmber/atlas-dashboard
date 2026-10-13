// 侧栏文件行几何稳定 + 文件名优先（桌面实机验收 client-fix §5 / §11）
//
// §5 复现条件：窄侧栏（280 / 260 / 240px）+ 长中文文件名 + 长中间目录 + 标签 chip。以前 .file 是
// flex-wrap，静息态挤成两行（40.5px）、悬停后元素变少回到一行（26px），鼠标停在两行交界处时
// 两行高度每帧来回翻。这里断言：
//   - 每种宽度下所有文件行静息高度恰好 26px（带正文摘要的命中行 42px）
//   - 悬停前后同一行的 getBoundingClientRect 完全相等，下一行的位置也不变
//   - 鼠标在两行交界 ±0.5px 来回移动 40 次：两行高度 / top 每一帧都不变（逐帧 rAF 采样），
//     且采样期间没有一次 layout-shift
//   - 目录视图 content-visibility 占位高度 = 26px（未渲染 / 渲染后一致）
// §11 文件名优先：320px 下带目录提示的行，文件名可见宽度 ≥ 目录提示宽度；树宽 < 280px 时目录提示整段隐藏；
//   目录提示截断时保留末级目录（direction: rtl）；完整路径在行 title 里
const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');
let fail = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`✗ ${name}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`); }
  else console.log(`✓ ${name}`);
}

const LONG = ['20260602_推送到达率与点击率_内部复盘', '配网数据周报（修订）_第二十三周_含渠道拆分', '设备控制页交互走查记录_空调与新风',
  '用户反馈聚类_米家App_八月下半月', '启动性能基线与回归对比_冷启动与热启动'];
const FILES = {};
for (let i = 0; i < 24; i++) {
  const deep = i % 3 === 0 ? '03-数据分析/deliverables/weekly' : i % 3 === 1 ? '01-需求文档/2026Q4/评审' : 'reports';
  FILES[`DSH/${deep}/${LONG[i % LONG.length]}_${i}.${i % 2 ? 'md' : 'html'}`] =
    i % 2 ? `# 文档 ${i}\n\n正文\n` : `<!doctype html><h1>文档 ${i}</h1>`;
}
FILES['DSH/short.md'] = '# short\n';

async function rowsAt(page, w) {
  await page.evaluate((px) => {
    document.documentElement.style.setProperty('--sidebar-w', px + 'px');
  }, w);
  await page.waitForTimeout(150);
  return page.evaluate(() => [...document.querySelectorAll('#tree .file')]
    .filter(r => r.offsetParent)
    .map(r => +r.getBoundingClientRect().height.toFixed(2)));
}

(async () => {
  const atlas = await startAtlas({ prefix: 'atlas-row-stability-', files: FILES });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(atlas.base, { waitUntil: 'load' });
  await page.waitForSelector('#tree .file');
  // 每篇都挂上标签：最坏情况（文件名 + 目录提示 + 标签 chip + 类型角标）
  await page.evaluate(async () => {
    const paths = [...document.querySelectorAll('#tree .file')].map(r => r.dataset.path);
    for (const p of paths) {
      await fetch('/api/tags', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p, tags: ['周报汇总'] }) });
    }
    await fetchState();
  });
  await page.waitForTimeout(400);

  // ---------- §5 静息行高 ----------
  for (const w of [320, 280, 260, 240]) {
    const hs = await rowsAt(page, w);
    check(`侧栏 ${w}px：${hs.length} 行全部恰好 26px（不换行）`, hs.every(h => h === 26), true);
  }

  // ---------- §5 悬停前后几何一致 + 交界处不振荡 ----------
  for (const w of [280, 240]) {
    await rowsAt(page, w);
    const pick = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#tree .file')].filter(r => r.offsetParent && r.querySelector('.file-dir-hint'));
      const a = rows[2], b = a.nextElementSibling && a.nextElementSibling.classList.contains('file') ? a.nextElementSibling : rows[3];
      a.dataset.probe = 'a'; b.dataset.probe = 'b';
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return { a: [ra.left, ra.top, ra.width, ra.height], b: [rb.left, rb.top, rb.width, rb.height] };
    });
    await page.mouse.move(pick.a[0] + 60, pick.a[1] + 13);
    await page.waitForTimeout(250);
    const hovered = await page.evaluate(() => {
      const g = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
      const a = document.querySelector('[data-probe="a"]');
      return { a: g('[data-probe="a"]'), b: g('[data-probe="b"]'), hover: a.matches(':hover'),
        actionsW: a.querySelector('.file-actions').getBoundingClientRect().width,
        actionsPos: getComputedStyle(a.querySelector('.file-actions')).position };
    });
    check(`侧栏 ${w}px：悬停态生效且操作组展开（绝对定位）`, [hovered.hover, hovered.actionsW > 100, hovered.actionsPos], [true, true, 'absolute']);
    check(`侧栏 ${w}px：悬停前后该行 getBoundingClientRect 完全相等`, hovered.a, pick.a);
    check(`侧栏 ${w}px：悬停前后下一行位置不变`, hovered.b, pick.b);
    // 逐帧采样：鼠标在交界 ±0.5px 来回 40 次
    await page.evaluate(() => {
      const a = document.querySelector('[data-probe="a"]'), b = document.querySelector('[data-probe="b"]');
      window.__samples = []; window.__shifts = 0; window.__sampling = true;
      // 只数"行"级别的位移：悬停操作组自己（绝对定位、宽度展开）和悬停预览浮窗不算
      try {
        new PerformanceObserver(l => {
          for (const e of l.getEntries()) {
            const src = (e.sources || []).map(x => x.node).filter(n => n && n.nodeType === 1
              && !n.closest('.file-actions') && !n.closest('#peek'));
            if (src.length) { window.__shifts++; (window.__shiftSrc = window.__shiftSrc || []).push(src.map(n => n.className).join('|')); }
          }
        }).observe({ type: 'layout-shift' });
      } catch {}
      const tick = () => {
        if (!window.__sampling) return;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        window.__samples.push([ra.height, rb.height, rb.top]);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const boundary = pick.b[1];
    for (let k = 0; k < 40; k++) {
      await page.mouse.move(pick.a[0] + 80, boundary + (k % 2 ? 0.5 : -0.5));
      await page.waitForTimeout(16);
    }
    const res = await page.evaluate(() => { window.__sampling = false; return { s: window.__samples, shifts: window.__shifts, src: window.__shiftSrc }; });
    if (res.shifts) console.log('      位移来源：', res.src);
    const distinct = new Set(res.s.map(x => x.join(','))).size;
    check(`侧栏 ${w}px：交界处来回移动 40 次，${res.s.length} 帧里两行高度与位置只有 1 种取值`, distinct, 1);
    check(`侧栏 ${w}px：采样期间没有行级 layout-shift（操作组 / 预览浮窗除外）`, res.shifts, 0);
    await page.mouse.move(900, 600);
    await page.evaluate(() => document.querySelectorAll('[data-probe]').forEach(e => delete e.dataset.probe));
  }

  // ---------- §11 文件名优先 ----------
  await rowsAt(page, 320);
  const w320 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree .file')].filter(r => r.offsetParent && r.querySelector('.file-dir-hint'));
    const vis = (el) => el && getComputedStyle(el).display !== 'none' ? el.getBoundingClientRect().width : 0;
    return rows.map(r => ({ name: vis(r.querySelector('.file-name')), hint: vis(r.querySelector('.file-dir-hint')),
      title: r.title, rel: r.dataset.path, dir: getComputedStyle(r.querySelector('.file-dir-hint')).direction }));
  });
  check('320px：带目录提示的行，文件名可见宽度 ≥ 目录提示宽度（全部）', w320.length > 0 && w320.every(r => r.name >= r.hint), true);
  check('320px：目录提示 ≤ 行宽 30%，截断时省略号在开头（direction: rtl，末级目录可见）',
    w320.every(r => r.hint <= 320 * 0.3 + 1 && r.dir === 'rtl'), true);
  check('完整相对路径在行 title 里', w320.every(r => r.title.includes('DSH/')), true);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`      （320px：文件名平均 ${avg(w320.map(r => r.name)).toFixed(0)}px，目录提示平均 ${avg(w320.map(r => r.hint)).toFixed(0)}px）`);
  await rowsAt(page, 280);
  const hidden280 = await page.evaluate(() => [...document.querySelectorAll('#tree .file-dir-hint')]
    .filter(h => h.closest('.file').offsetParent).every(h => getComputedStyle(h).display === 'none'));
  check('280px（树宽 < 280px）：目录提示整段隐藏，空间全给文件名', hidden280, true);

  // ---------- 目录视图：content-visibility 占位 = 26px ----------
  await rowsAt(page, 320);
  await page.click('.seg-btn[data-view="tree"]');
  await page.waitForTimeout(400);
  const cis = await page.evaluate(() => {
    const r = document.querySelector('#tree.tree-view-mode .file');
    return r ? getComputedStyle(r).containIntrinsicSize : null;
  });
  check('目录视图：文件行 contain-intrinsic-size 占位 26px（与真实行高一致）', /26px/.test(cis || ''), true);
  await page.click('.seg-btn[data-view="groups"]');
  await page.waitForTimeout(300);

  // ---------- 键盘聚焦操作组（无悬停）：行上悬停底色，操作组不透明地盖住行尾（client-fix review #5） ----------
  await page.mouse.move(900, 600);   // 鼠标挪到主区，确保没有任何行处于 :hover
  // 先按一下键盘：最近一次交互是键盘时，脚本 focus() 才算 :focus-visible（行规则只认键盘焦点）
  await page.keyboard.press('Shift');
  const kb = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('#tree .file')].find(r => r.offsetParent && !r.classList.contains('active'));
    const rect0 = row.getBoundingClientRect();
    const bg0 = getComputedStyle(row).backgroundColor;
    row.querySelector('.file-actions button').focus();
    await new Promise(r => setTimeout(r, 400));   // 等 width / background 过渡走完
    const cs = getComputedStyle(row), act = getComputedStyle(row.querySelector('.file-actions'));
    // 期望底色 = 同一页面下悬停行的 --bg-hover
    const probe = document.createElement('div'); probe.style.background = 'var(--bg-hover)'; row.parentElement.appendChild(probe);
    const hoverBg = getComputedStyle(probe).backgroundColor; probe.remove();
    const rect1 = row.getBoundingClientRect();
    const out = { hover: row.matches(':hover'), bg0, bg: cs.backgroundColor, hoverBg, actBg: act.backgroundColor, actW: parseFloat(act.width),
      same: [rect0.top, rect0.height, rect0.width].join() === [rect1.top, rect1.height, rect1.width].join(),
      focused: !!(document.activeElement && document.activeElement.closest('.file-actions')) };
    document.activeElement.blur();
    return out;
  });
  console.log('      ' + JSON.stringify(kb));
  check('键盘聚焦操作组：行没有悬停、但底色 = --bg-hover，操作组继承到同一不透明底色',
    [kb.hover, kb.bg === kb.hoverBg, kb.actBg === kb.hoverBg, kb.bg !== 'rgba(0, 0, 0, 0)'], [false, true, true, true]);
  check('键盘聚焦操作组：操作组展开、行高与位置不变', [kb.actW > 100, kb.same], [true, true]);
  // ---------- 鼠标点操作按钮后移开：不再停在悬停态（第 2 轮评审 #2） ----------
  // 真实鼠标点击会让按钮获得焦点（但不是 :focus-visible）。在 window 捕获阶段拦掉 click，
  // 只留下"按钮拿到焦点、行不重渲染"这个状态（对应「分享」「在访达中显示」这类不重画行的按钮）
  const target = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#tree .file')].find(r => r.offsetParent && !r.classList.contains('active'));
    row.dataset.clickProbe = '1';
    window.__stopClick = (e) => { if (e.target.closest('.file-actions')) { e.stopImmediatePropagation(); e.preventDefault(); } };
    window.addEventListener('click', window.__stopClick, true);
    const r = row.getBoundingClientRect();
    return { x: r.right - 12, y: r.top + r.height / 2 };
  });
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(300);   // 悬停展开操作组
  const btnBox = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-click-probe] .file-actions button')].pop().getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(btnBox.x, btnBox.y);
  await page.mouse.move(900, 600);
  await page.waitForTimeout(400);
  const mc = await page.evaluate(() => {
    const row = document.querySelector('[data-click-probe]');
    const out = {
      focusedInRow: !!(document.activeElement && row.contains(document.activeElement)),
      hover: row.matches(':hover'),
      bg: getComputedStyle(row).backgroundColor,
      actOpacity: getComputedStyle(row.querySelector('.file-actions')).opacity,
      mtimeVis: row.querySelector('.file-mtime') ? getComputedStyle(row.querySelector('.file-mtime')).visibility : 'visible',
    };
    window.removeEventListener('click', window.__stopClick, true);
    delete row.dataset.clickProbe;
    document.activeElement.blur();
    return out;
  });
  console.log('      ' + JSON.stringify(mc));
  check('鼠标点操作按钮后移开：按钮仍有焦点，但行回到静息（无悬停底色、操作组收起、mtime 不被藏）',
    [mc.focusedInRow, mc.hover, mc.bg === kb.bg0, mc.actOpacity, mc.mtimeVis], [true, false, true, '0', 'visible']);

  check('全程无页面错误', errors, []);
  await browser.close();
  await atlas.stop();
  console.log(`\n总计 ${total} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
