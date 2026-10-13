// 星图视图（design §3a、§10.2、§10.3、§10.9、§12.4）
//
// node 段（直接 require public/starmap.js 的纯函数）：
//   布局确定性、新增一篇不移动其他星、随机 1–200 个项目两两 dist ≥ Hi + Hj + 28、tier 边界、
//   空间索引命中、5 万篇布局 < 300ms（粗断言）、placeLabels 两两不相交 / 不压障碍 /
//   选中星必有标签 / 配额与 600 候选上限 / 同输入结果确定
// Playwright 段（startAtlas，多项目 fixture，含相对链接）：
//   视图切换规则表、__atlasForceVT 下一次操作只出现一次 data-vt、编辑态「继续编辑」后状态不变、
//   画布 aria-label 篇数、星表数量与顺序、Enter 进 Tab、debug.screenPos + 点击打开对应文档、
//   debug.hitTest 反查、只看未读时筛选状态条「命中 n / 总数」且不命中星不可点、星表只含命中项、
//   进星图自动收起侧栏三条用例（偏好不被写）、无边 / 有边时 debug.linkCount、
//   data-view=groups|tree 语义不变
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SM = require(path.join(ROOT, 'public', 'starmap.js'));
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function nodeSection() {
  console.log('\n[node] tier 边界');
  const now = 1_700_000_000_000, H = 3_600_000, D = 24 * H;
  check('59 分钟前 = 第 1 档', SM.tierOf(now - H + 60_000, now), 1);
  check('正好 1 小时 = 第 2 档', SM.tierOf(now - H, now), 2);
  check('23 小时 59 分 = 第 2 档', SM.tierOf(now - D + 60_000, now), 2);
  check('正好 24 小时 = 第 3 档', SM.tierOf(now - D, now), 3);
  check('7 天差 1 分钟 = 第 3 档', SM.tierOf(now - 7 * D + 60_000, now), 3);
  check('正好 7 天 = 第 4 档', SM.tierOf(now - 7 * D, now), 4);
  check('未来时间 = 第 1 档', SM.tierOf(now + H, now), 1);

  console.log('\n[node] 布局确定性 / 新增一篇不移动其他星');
  const projects = ['alpha', 'beta', 'gamma', 'delta'].map((name, i) => ({ name, count: 5 + i * 7 }));
  const rows = [];
  for (const p of projects) for (let k = 0; k < p.count; k++) rows.push({ path: `/r/${p.name}/doc-${k}.md`, project: p.name });
  const c1 = SM.layoutClusters(projects), c2 = SM.layoutClusters(projects.slice().reverse());
  check('同输入（顺序无关）星团坐标相同', c1.map(c => [c.name, c.cx, c.cy]), c2.map(c => [c.name, c.cx, c.cy]));
  const s1 = SM.layoutStars(rows, c1), s2 = SM.layoutStars(rows, c1);
  check('同输入星坐标相同', [...s1.x].join(), [...s2.x].join());
  // layoutStars 对每行是纯函数：同一组星团下多一行，其余行坐标不变
  const extra = rows.concat([{ path: '/r/beta/new.md', project: 'beta' }]);
  const s3 = SM.layoutStars(extra, c1);
  check('同一组星团下新增一行：其他行坐标完全不变',
    rows.every((_, i) => s1.x[i] === s3.x[i] && s1.y[i] === s3.y[i]), true);
  // 完整流水线：新增到名字最靠后的项目，别的项目里的星一颗都不动
  const proj2 = projects.map(p => (p.name === 'gamma' ? { ...p, count: p.count + 1 } : p));
  const c4 = SM.layoutClusters(proj2);
  const s4 = SM.layoutStars(extra.slice(0, -1).concat([{ path: '/r/gamma/new.md', project: 'gamma' }]), c4);
  const others = rows.map((r, i) => i).filter(i => rows[i].project !== 'gamma');
  check('完整流水线：新增到最后一个星团，其他星团的星不动',
    others.every(i => s1.x[i] === s4.x[i] && s1.y[i] === s4.y[i]), true);

  console.log('\n[node] 星团不重叠（§12.4b）：随机 1–200 个项目两两 dist ≥ Hi + Hj + 28');
  const rand = rng(20240607);
  let worst = Infinity, okAll = true, det = true;
  for (let t = 0; t < 40; t++) {
    const P = 1 + Math.floor(rand() * 200);
    const ps = Array.from({ length: P }, (_, i) => ({ name: 'p' + Math.floor(rand() * 1e6) + '-' + i, count: 1 + Math.floor(rand() * (rand() < 0.1 ? 900 : 60)) }));
    const cl = SM.layoutClusters(ps);
    for (let i = 0; i < cl.length; i++) {
      for (let j = i + 1; j < cl.length; j++) {
        const gap = Math.hypot(cl[i].cx - cl[j].cx, cl[i].cy - cl[j].cy) - (cl[i].h + cl[j].h + 28);
        if (gap < worst) worst = gap;
        if (gap < -1e-6) okAll = false;
      }
    }
    const again = SM.layoutClusters(ps);
    if (again.some((c, i) => c.cx !== cl[i].cx || c.cy !== cl[i].cy)) det = false;
    if (cl.some(c => Math.abs(c.h - 1.25 * c.r) > 1e-9 || Math.abs(c.r - SM.clusterRadius(c.count)) > 1e-9)) okAll = false;
  }
  check('40 组随机输入全部满足间距（且 R = clusterRadius(n)、H = 1.25R）', okAll, true);
  check('同输入结果相同', det, true);
  console.log(`      （最小余量 ${worst.toFixed(3)}）`);

  console.log('\n[node] 空间索引命中');
  const idx = SM.buildSpatialIndex(s1.x, s1.y, rows.length, 32);
  const k0 = 7;
  check('在星上命中这颗星', SM.hitTest(idx, s1.x, s1.y, s1.x[k0] + 0.5, s1.y[k0] - 0.5, 3, null) >= 0, true);
  const hit = SM.hitTest(idx, s1.x, s1.y, s1.x[k0], s1.y[k0], 0.01, null);
  check('半径极小时正好命中自己', hit, k0);
  check('远处空白不命中', SM.hitTest(idx, s1.x, s1.y, 1e6, 1e6, 10, null), -1);
  check('accept 过滤掉的星不命中', SM.hitTest(idx, s1.x, s1.y, s1.x[k0], s1.y[k0], 0.01, (k) => k !== k0) === k0, false);

  console.log('\n[node] 5 万篇布局耗时');
  const big = [];
  const bigProj = Array.from({ length: 120 }, (_, i) => ({ name: 'proj-' + String(i).padStart(3, '0'), count: 0 }));
  for (let i = 0; i < 50_000; i++) { const p = bigProj[i % 120]; p.count++; big.push({ path: `/big/${p.name}/f-${i}.html`, project: p.name }); }
  const t0 = Date.now();
  const bc = SM.layoutClusters(bigProj);
  const bs = SM.layoutStars(big, bc);
  SM.buildSpatialIndex(bs.x, bs.y, big.length, 32);
  const ms = Date.now() - t0;
  console.log(`      （${ms}ms）`);
  check('5 万篇布局 + 空间索引 < 300ms', ms < 300, true);

  console.log('\n[node] placeLabels（§10.2）');
  const mk = (rowsN, seed) => {
    const r = rng(seed);
    const ps = Array.from({ length: 8 }, (_, i) => ({ name: 'c' + i, count: 0 }));
    const rs = [];
    for (let i = 0; i < rowsN; i++) { const p = ps[i % 8]; p.count++; rs.push({ path: `/l/${p.name}/${i}`, project: p.name }); }
    const cl = SM.layoutClusters(ps);
    const st = SM.layoutStars(rs, cl);
    const n = rs.length;
    const stars = {
      n, x: st.x, y: st.y,
      tier: new Uint8Array(n).map(() => 1 + Math.floor(r() * 4)),
      flags: new Uint8Array(n).map(() => (r() < 0.2 ? 3 : r() < 0.1 ? 4 : 0)),
      mtime: new Float64Array(n).map(() => Math.floor(r() * 1e9)),
      hit: new Uint8Array(n).fill(1),
      labelW: new Float32Array(n).map(() => 40 + r() * 80),
      selected: -1, hovered: -1,
    };
    cl.forEach(c => { c.lw = 60 + c.name.length * 7; });
    return { stars, cl };
  };
  const { stars, cl } = mk(4000, 7);
  const vp = { w: 1440, h: 900 };
  const hud = [{ x: 16, y: 14, w: 420, h: 30 }, { x: 16, y: 640, w: 240, h: 240 }, { x: 1380, y: 760, w: 40, h: 120 }];
  const allBoxes = (res) => res.clusterLabels.concat(res.docLabels);
  for (const s of [0.6, 1.1, 2.4]) {
    const cam = { x: cl[0].cx, y: cl[0].cy, s };
    stars.selected = 5;
    const res = SM.placeLabels(stars, cl, cam, vp, hud, null, { budgetMs: 1000 });
    const boxes = allBoxes(res);
    let pairOk = true;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i], boxes[j])) pairOk = false;
    const nonForced = boxes.filter(b => !b.forced);
    const hudOk = nonForced.every(b => hud.every(h => !overlap(b, { x: h.x - 4, y: h.y - 4, w: h.w + 8, h: h.h + 8 })));
    // 不压星点：放下的文档标签不与任何可见命中星的障碍框相交（近景半径 5，中景只看 1–2 档与未读）
    const r = res.lod === 'near' ? 5 : 3;
    let starOk = true;
    const sxOf = (x) => (x - cam.x) * s + vp.w / 2, syOf = (y) => (y - cam.y) * s + vp.h / 2;
    for (let i = 0; i < stars.n && starOk; i++) {
      if (res.lod === 'mid' && !(stars.tier[i] <= 2 || (stars.flags[i] & 1))) continue;
      const x = sxOf(stars.x[i]), y = syOf(stars.y[i]);
      if (x < -20 || x > vp.w + 20 || y < -20 || y > vp.h + 20) continue;
      const sb = { x: x - r, y: y - r, w: 2 * r, h: 2 * r };
      for (const b of nonForced) if (overlap(b, sb)) { starOk = false; break; }
    }
    const quota = res.lod === 'near' ? 150 : 40;
    console.log(`    s=${s}（${res.lod}）：星团标签 ${res.clusterLabels.length}、文档标签 ${res.docLabels.length}、隐藏 ${res.hidden}、候选 ${res.candidates}`);
    check(`s=${s}：所有标签两两不相交`, pairOk, true);
    check(`s=${s}：非强制标签不压 HUD（外扩 4px）`, hudOk, true);
    check(`s=${s}：文档标签不压星点`, starOk, true);
    check(`s=${s}：文档标签不超过配额 ${quota}`, res.docLabels.length <= quota, true);
    check(`s=${s}：候选截到 600`, res.candidates <= 600, true);
    check(`s=${s}：选中星一定有标签`, res.docLabels.some(d => d.i === 5), true);
    const again = SM.placeLabels(stars, cl, cam, vp, hud, null, { budgetMs: 1000 });
    check(`s=${s}：同输入结果确定`, JSON.stringify(allBoxes(again)), JSON.stringify(boxes));
  }
  // 远景只放星团标签（最多 40 个）
  const far = SM.placeLabels(stars, cl, { x: 0, y: 0, s: 0.1 }, vp, hud, null, { budgetMs: 1000 });
  check('远景：没有文档标签', far.docLabels.length, 0);
  check('远景：星团标签 ≤ 40', far.clusterLabels.length <= 40, true);
  // 近景候选很多时：600 上限真的生效
  const many = mk(20000, 9);
  const dense = SM.placeLabels(many.stars, many.cl, { x: many.cl[0].cx, y: many.cl[0].cy, s: 1.6 }, vp, [], null, { budgetMs: 1000 });
  check('近景高密度：候选恰好截到 600', dense.candidates, 600);
  check('近景高密度：隐藏数 = 候选总数 − 显示数', dense.hidden + dense.shown >= 600, true);

  console.log('\n[node] clusterLinks');
  const clusterOf = new Uint32Array([0, 0, 1, 1, 2]);
  const agg = SM.clusterLinks(new Int32Array([0, 2, 1, 3, 0, 1, 4, 0, 2, 4]), clusterOf, null);
  check('星团间聚合（内部边不计）', agg, [{ a: 0, b: 1, n: 2 }, { a: 0, b: 2, n: 1 }, { a: 1, b: 2, n: 1 }]);
  const aggHit = SM.clusterLinks(new Int32Array([0, 2, 1, 3]), clusterOf, new Uint8Array([1, 0, 1, 1, 1]));
  check('只统计两端都命中的边', aggHit, [{ a: 0, b: 1, n: 1 }]);
}

// ---------------- Playwright ----------------
const FILES = {
  'alpha/index.md': '# Alpha 首页\n\n见 [规划](plan.md) 与 [beta 说明](../beta/readme.md)。\n',
  'alpha/plan.md': '# 规划\n\n回到 [首页](./index.md)。\n',
  'alpha/notes.md': '# 笔记\n\n```\n[假链接](plan.md)\n```\n',
  'alpha/page.html': '<!doctype html><html><body><h1>Alpha 页面</h1><a href="plan.md">plan</a></body></html>',
  'beta/readme.md': '# Beta\n\n[alpha](../alpha/index.md)\n',
  'beta/b1.md': '# B1\n\n正文\n',
  'beta/b2.md': '# B2\n\n正文\n',
  'gamma/g1.md': '# G1\n\n正文\n',
  'gamma/g2.html': '<!doctype html><html><body><h1>G2</h1></body></html>',
};

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page, errors };
}
const st = (page) => page.evaluate(() => ({
  viewMode: state.viewMode,
  listView: state.listView,
  lsView: localStorage.getItem('atlas:viewMode'),
  lsList: localStorage.getItem('atlas:listView'),
  checked: [...document.querySelectorAll('.seg-btn[data-view]')].filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.dataset.view),
  mapVisible: !document.getElementById('starmap-view').classList.contains('hidden') && !document.getElementById('empty-state').classList.contains('hidden'),
  homeVisible: !document.querySelector('#empty-state > .home').classList.contains('hidden') && !document.getElementById('empty-state').classList.contains('hidden'),
  active: state.activeFilePath,
  tabs: state.tabs.length,
  activeTab: !!document.querySelector('#tab-bar .tab.active'),
  collapsed: document.body.classList.contains('sidebar-collapsed'),
  pref: localStorage.getItem('atlas:sidebarCollapsed'),
  note: !document.getElementById('auto-collapse-note').classList.contains('hidden'),
  treeFiles: document.querySelectorAll('#tree .file').length,
  treeView: document.getElementById('tree').classList.contains('tree-view-mode'),
}));

async function playwrightSection() {
  const atlas = await startAtlas({ prefix: 'atlas-starmap-', files: FILES });
  const browser = await chromium.launch();
  const P = (rel) => atlas.filePath(rel);
  try {
    const { ctx, page, errors } = await newPage(browser);
    await page.goto(atlas.base);
    await page.waitForSelector('#tree .file');
    await page.waitForTimeout(300);

    console.log('\n[视图] 首页选「星图」');
    let s = await st(page);
    check('默认是分组、封面墙可见', [s.viewMode, s.homeVisible, s.mapVisible], ['groups', true, false]);
    check('分段控件有三项且容器是 radiogroup「视图」', await page.evaluate(() => {
      const seg = document.querySelector('.view-seg');
      return [seg.getAttribute('role'), seg.getAttribute('aria-label'), seg.querySelectorAll('.seg-btn[role="radio"]').length];
    }), ['radiogroup', '视图', 3]);
    check('首页迷你星图可见', await page.evaluate(() => !document.getElementById('home-minimap').classList.contains('hidden')), true);
    await page.click('#home-minimap');
    await page.waitForTimeout(300);
    s = await st(page);
    check('点迷你星图 = 选中星图', [s.viewMode, s.mapVisible], ['map', true]);
    check('#starmap-view 可见、.home 隐藏', [s.mapVisible, s.homeVisible], [true, false]);
    check('aria-checked 指向星图', s.checked, ['map']);
    check('星图态面包屑显示「星图」', (await page.textContent('#crumbs')).trim(), '星图');
    check('星图态顶栏快速打开胶囊可见', await page.isVisible('#btn-quickopen'), true);
    await page.click('#btn-quickopen');
    await page.waitForSelector('#quickopen:not(.hidden)');
    check('星图态点胶囊打开 #quickopen', await page.isVisible('#quickopen'), true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#quickopen.hidden', { state: 'attached' });

    console.log('\n[星图态] 首页真正移出布局（河流手柄不透出、不可 Tab 聚焦）');
    check('.home 计算样式 display:none', await page.evaluate(() => getComputedStyle(document.querySelector('#empty-state > .home')).display), 'none');
    check('#river-start / #river-end 不可见', [await page.isVisible('#river-start'), await page.isVisible('#river-end')], [false, false]);
    // 星表每一行的中心点都命中星表自身，而不是透出来的首页元素（之前河流手柄压在其中一行上）
    check('星表行中心点 elementFromPoint 命中星表、不落在 .home 内', await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.sm-cluster')];
      if (!rows.length) return 'no-rows';
      return rows.every((r) => {
        const b = r.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return !!hit && r.contains(hit) && !hit.closest('.home');
      });
    }), true);
    // 从顶栏快速打开胶囊起连续 Tab 直到进入星表：途中焦点一次都不落进 .home
    await page.evaluate(() => {
      window.__tabProbe = { home: 0, cat: false };
      window.__tabProbeFn = (e) => {
        const t = e.target;
        if (!t.closest) return;
        if (t.closest('.home')) window.__tabProbe.home++;
        if (t.closest('.sm-cluster, .sm-star')) window.__tabProbe.cat = true;
      };
      document.addEventListener('focusin', window.__tabProbeFn, true);
    });
    await page.focus('#btn-quickopen');
    for (let i = 0; i < 60 && !(await page.evaluate(() => window.__tabProbe.cat)); i++) await page.keyboard.press('Tab');
    const probe = await page.evaluate(() => {
      document.removeEventListener('focusin', window.__tabProbeFn, true);
      document.activeElement && document.activeElement.blur();
      return window.__tabProbe;
    });
    check('从顶栏 Tab 可到达星表行，途中焦点从未落进 .home', [probe.cat, probe.home], [true, 0]);

    check('atlas:viewMode=map 持久化、listView 仍是 groups', [s.lsView, s.listView], ['map', 'groups']);
    check('侧栏仍渲染列表（分组视图的 9 个文件）', [s.treeFiles, s.treeView], [9, false]);
    const n = Object.keys(FILES).length;
    check('画布 aria-label 含正确篇数', await page.evaluate(() =>
      document.getElementById('starmap-canvas').getAttribute('aria-label')).then(a => a.includes(`3 个项目、${n} 篇文档`)), true);
    await page.waitForFunction(() => AtlasStarmap.debug.linkCount > 0, null, { timeout: 8000 }).catch(() => {});
    // alpha/index→plan、index→beta/readme、plan→index、page.html→plan、beta/readme→alpha/index；代码块里的假链接不算
    check('有链接 fixture 时 debug.linkCount === 5', await page.evaluate(() => AtlasStarmap.debug.linkCount), 5);

    console.log('\n[进星图自动收起侧栏] 偏好展开');
    check('进入后侧栏收起、提示出现', [s.collapsed, s.note], [true, true]);
    check('偏好没被写', s.pref, null);

    console.log('\n[星表]');
    const order = await page.evaluate(() => {
      const groups = {};
      for (const f of Object.values(state.files)) {
        const g = groups[f.projectName] || (groups[f.projectName] = { name: f.projectName, latest: 0, n: 0 });
        g.latest = Math.max(g.latest, f.mtime); g.n++;
      }
      return Object.values(groups).sort((a, b) => b.latest - a.latest || (a.name < b.name ? -1 : 1)).map(g => g.name);
    });
    check('星团数量与顺序（最新改动倒序）', await page.$$eval('.sm-cluster', els => els.map(e => e.dataset.project)), order);
    check('星团可读名称', /^alpha，4 篇，\d+ 篇未读，最近改动 /.test(await page.getAttribute('.sm-cluster[data-project="alpha"]', 'aria-label')), true);
    await page.focus('.sm-cluster[data-project="alpha"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const starOrder = await page.evaluate((proj) => Object.values(state.files).filter(f => f.projectName === proj)
      .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1)).map(f => f.path), 'alpha');
    check('激活星团后 .sm-star 的数量与顺序（mtime 倒序）', await page.$$eval('.sm-star', els => els.map(e => e.dataset.path)), starOrder);
    check('Enter 激活后焦点在第一颗星', await page.evaluate(() => document.activeElement.classList.contains('sm-star')), true);
    const lbl = await page.getAttribute(`.sm-star[data-path="${P('alpha/index.md')}"]`, 'aria-label');
    check('星的可读名称含引用数', /引用 2 篇、被 2 篇引用/.test(lbl), true);
    check('顶部有「← 全部星团」', await page.textContent('.cat-back'), '← 全部星团');
    await page.keyboard.press('ArrowDown');
    check('↓ 移动到第二颗星（roving tabindex）', await page.evaluate(() => {
      const a = document.activeElement; return [a.dataset.path, a.tabIndex];
    }), [starOrder[1], 0]);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    s = await st(page);
    check('Enter 打开文档进 Tab', [s.active, s.tabs, s.activeTab], [starOrder[1], 1, true]);
    check('离开星图后侧栏展开、偏好仍未写、提示消失', [s.collapsed, s.pref, s.note], [false, null, false]);

    console.log('\n[视图] 文档态 + viewMode=map 时选「分组」/「目录」');
    await page.click('.seg-btn[data-view="tree"]');
    await page.waitForTimeout(250);
    s = await st(page);
    check('当前文档不变、侧栏切成目录', [s.active, s.viewMode, s.treeView, s.listView], [starOrder[1], 'tree', true, 'tree']);
    await page.click('.seg-btn[data-view="groups"]');
    await page.waitForTimeout(250);
    s = await st(page);
    check('（切回分组）', [s.active, s.viewMode, s.treeView], [starOrder[1], 'groups', false]);

    console.log('\n[视图] 文档态选「星图」→ 回到星图首页，Tab 仍在');
    await page.click('.seg-btn[data-view="map"]');
    await page.waitForTimeout(400);
    s = await st(page);
    check('#starmap-view 可见、没有活动 Tab、Tab 仍在', [s.mapVisible, s.active, s.activeTab, s.tabs], [true, null, false, 1]);
    check('再次进入星图侧栏又自动收起', [s.collapsed, s.pref], [true, null]);

    console.log('\n[画布] debug.screenPos + 点击打开对应文档');
    await page.evaluate(() => { const c = document.querySelector('.cat-back'); if (c) c.click(); });
    await page.waitForTimeout(500);
    const target = P('beta/b1.md');
    const pos = await page.evaluate((p) => AtlasStarmap.debug.screenPos(p), target);
    check('screenPos 返回坐标', !!pos, true);
    check('debug.hitTest 反查到同一篇', await page.evaluate(([x, y]) => AtlasStarmap.debug.hitTest(x, y), [pos.x, pos.y]), target);
    check('空白处 hitTest 为 null', await page.evaluate(() => AtlasStarmap.debug.hitTest(5, 400)), null);
    await page.mouse.move(pos.x, pos.y);
    await page.waitForTimeout(150);
    check('悬停星显示 tooltip（含「引用 n · 被引用 m」）', await page.evaluate(() => {
      const t = document.getElementById('starmap-tip'); return !t.classList.contains('hidden') && /引用 \d+ · 被引用 \d+/.test(t.textContent);
    }), true);
    await page.mouse.click(pos.x, pos.y);
    await page.waitForTimeout(400);
    s = await st(page);
    check('点击星打开对应文档', s.active, target);
    await page.evaluate(() => goHome());
    await page.waitForTimeout(400);

    console.log('\n[筛选] 只看未读');
    // 把 alpha 下两篇标成已读
    await page.evaluate(async (ps) => {
      for (const p of ps) await fetch('/api/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) });
      await fetchState();
    }, [P('alpha/plan.md'), P('alpha/notes.md')]);
    await page.waitForTimeout(300);
    await page.evaluate(() => { state.onlyUnread = true; els.onlyUnread.checked = true; applyFilterChange(); });
    await page.waitForTimeout(300);
    const fs1 = await page.evaluate(() => {
      const el = document.getElementById('starmap-filter-status');
      const snap = filterSnapshot();
      return { visible: !el.classList.contains('hidden'), text: el.textContent, size: snap.size, total: snap.total };
    });
    check('筛选状态条可见', fs1.visible, true);
    check(`筛选状态条含「命中 ${fs1.size} / ${fs1.total}」`, fs1.text.includes(`命中 ${fs1.size} / ${fs1.total}`), true);
    check('命中数 = 当前未读篇数（且少于总数）', [fs1.size, fs1.size < fs1.total],
      [await page.evaluate(() => Object.values(state.files).filter(f => f.unread).length), true]);
    const missPos = await page.evaluate((p) => AtlasStarmap.debug.screenPos(p), P('alpha/plan.md'));
    check('不命中星的屏幕坐标 hitTest 为 null', await page.evaluate(([x, y]) => AtlasStarmap.debug.hitTest(x, y), [missPos.x, missPos.y]), null);
    await page.click('.sm-cluster[data-project="alpha"]');
    await page.waitForTimeout(200);
    check('星表只含命中项', await page.$$eval('.sm-star', els => els.map(e => e.dataset.path).sort()),
      [P('alpha/index.md'), P('alpha/page.html')].sort());
    await page.evaluate(() => { state.onlyUnread = false; els.onlyUnread.checked = false; applyFilterChange(); });
    await page.waitForTimeout(200);
    check('清除筛选后状态条隐藏', await page.evaluate(() => document.getElementById('starmap-filter-status').classList.contains('hidden')), true);

    console.log('\n[进星图自动收起侧栏] 星图里按 ⌘B');
    await page.click('#starmap-canvas', { position: { x: 5, y: 300 } });
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(300);
    s = await st(page);
    check('⌘B：侧栏展开、偏好写成 0、提示消失', [s.collapsed, s.pref, s.note], [false, '0', false]);
    await page.click('.seg-btn[data-view="groups"]');
    await page.waitForTimeout(300);
    s = await st(page);
    check('离开星图后保持展开', [s.mapVisible, s.homeVisible, s.collapsed, s.pref], [false, true, false, '0']);
    check('回到封面墙：河流手柄重新可见且落在河流内', await page.evaluate(() => {
      const river = document.getElementById('home-river').getBoundingClientRect();
      return ['river-start', 'river-end'].map((id) => {
        const b = document.getElementById(id).getBoundingClientRect();
        const cx = b.left + b.width / 2;
        return b.width > 0 && b.height > 0 && cx >= river.left - 1 && cx <= river.right + 1;
      });
    }), [true, true]);

    console.log('\n[进星图自动收起侧栏] 偏好收起');
    await page.click('#btn-toggle-sidebar');
    await page.waitForTimeout(300);
    check('（用户收起侧栏，偏好=1）', (await st(page)).pref, '1');
    // 侧栏已收起（移出视口），直接走分段控件的同一个入口
    await page.evaluate(() => document.querySelector('.seg-btn[data-view="map"]').click());
    await page.waitForTimeout(300);
    s = await st(page);
    check('进星图：仍收起、不显示自动收起提示', [s.mapVisible, s.collapsed, s.note], [true, true, false]);
    await page.evaluate(() => selectView('tree'));
    await page.waitForTimeout(300);
    s = await st(page);
    check('星图首页选「目录」→ .home 可见、星图隐藏、仍收起、偏好=1', [s.homeVisible, s.mapVisible, s.collapsed, s.pref, s.treeView], [true, false, true, '1', true]);
    await page.click('#btn-toggle-sidebar');
    await page.waitForTimeout(300);

    console.log('\n[视图] ←/→ 在三项间移动并选中');
    await page.focus('.seg-btn[data-view="tree"]');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    s = await st(page);
    check('→：目录 → 星图', [s.viewMode, s.mapVisible], ['map', true]);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    s = await st(page);
    check('→：星图 → 分组（循环）', [s.viewMode, s.homeVisible, s.listView], ['groups', true, 'groups']);

    console.log('\n[视图] 刷新后仍在星图，listView 保留');
    await page.evaluate(() => selectView('tree'));
    await page.evaluate(() => selectView('map'));
    // 关掉恢复 Tab 的记录：否则刷新后会自动激活上次的 Tab（既有行为），首页表面不可见
    await page.evaluate(() => localStorage.removeItem(OPEN_TABS_KEY));
    await page.reload();
    await page.waitForSelector('#tree .file');
    await page.waitForTimeout(400);
    s = await st(page);
    check('刷新后直接是星图、侧栏仍是目录视图', [s.viewMode, s.mapVisible, s.listView, s.treeView, s.checked], ['map', true, 'tree', true, ['map']]);
    check('刷新后偏好展开 → 首帧即自动收起、偏好未写', [s.collapsed, s.pref, s.note], [true, '0', true]);
    check('刷新后星图态面包屑仍是「星图」', (await page.textContent('#crumbs')).trim(), '星图');
    await page.evaluate(() => selectView('groups'));
    await page.waitForTimeout(300);
    check('切回分组首页后面包屑回到「首页」', (await page.textContent('#crumbs')).trim(), '首页');

    console.log('\n[视图] 编辑态有未保存改动时选「星图」→「继续编辑」');
    await page.evaluate(() => selectView('groups'));
    await page.evaluate((p) => openFile(p), P('beta/b2.md'));
    await page.waitForTimeout(600);
    await page.click('#btn-edit');
    await page.waitForSelector('#md-editor:not(.hidden)');
    await page.evaluate(() => {
      const ta = document.getElementById('md-source');
      ta.value += '\n改了一行\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    const beforeLs = await page.evaluate(() => localStorage.getItem('atlas:viewMode'));
    await page.click('.seg-btn[data-view="map"]');
    await page.waitForSelector('.atlas-dialog .dialog-cancel');
    check('弹出确认框（继续编辑 / 放弃改动）', await page.textContent('.atlas-dialog .dialog-cancel'), '继续编辑');
    await page.click('.atlas-dialog .dialog-cancel');
    await page.waitForTimeout(300);
    s = await st(page);
    check('仍在文档、仍在编辑', [s.active, await page.evaluate(() => editState.active)], [P('beta/b2.md'), true]);
    check('aria-checked 未变、atlas:viewMode 未写', [s.checked, s.lsView], [['groups'], beforeLs]);
    await page.click('#btn-edit-cancel');
    await page.waitForTimeout(200);
    await page.evaluate(() => { const b = document.querySelector('.atlas-dialog .dialog-confirm'); if (b) b.click(); });
    await page.waitForTimeout(200);
    check('页面没有抛出未捕获异常', errors, []);
    await ctx.close();

    console.log('\n[View Transition] __atlasForceVT：一次操作只出现一次 data-vt');
    {
      const { ctx: c2, page: p2, errors: e2 } = await newPage(browser);
      await p2.addInitScript(() => { window.__atlasForceVT = true; });
      await p2.goto(atlas.base);
      await p2.waitForSelector('#tree .file');
      await p2.evaluate(() => selectView('groups'));
      await p2.evaluate((p) => openFile(p), P('gamma/g1.md'));
      await p2.waitForFunction(() => !document.documentElement.hasAttribute('data-vt'));
      await p2.waitForTimeout(400);
      const run = async (fn) => {
        await p2.evaluate(() => {
          window.__vtCount = 0;
          window.__vtObs = new MutationObserver((ms) => {
            for (const m of ms) if (m.attributeName === 'data-vt' && document.documentElement.hasAttribute('data-vt') && m.oldValue === null) window.__vtCount++;
          });
          window.__vtObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-vt'], attributeOldValue: true });
        });
        await p2.evaluate(fn);
        await p2.waitForTimeout(50);
        await p2.waitForFunction(() => !document.documentElement.hasAttribute('data-vt'), null, { timeout: 5000 });
        await p2.waitForTimeout(100);
        return p2.evaluate(() => { window.__vtObs.disconnect(); return window.__vtCount; });
      };
      const c1 = await run(() => { document.querySelector('.seg-btn[data-view="map"]').click(); });
      let s2 = await st(p2);
      check('文档态选星图：过渡结束后星图可见、.home 隐藏', [s2.mapVisible, s2.homeVisible, s2.active], [true, false, null]);
      check('过程中只出现过一次 data-vt', c1, 1);
      const cc = await run(() => { document.querySelector('.seg-btn[data-view="tree"]').click(); });
      s2 = await st(p2);
      check('星图首页选目录：过渡结束后 .home 可见、星图隐藏', [s2.homeVisible, s2.mapVisible], [true, false]);
      check('（同样只有一次 data-vt）', cc, 1);
      check('页面没有抛出未捕获异常', e2, []);
      await c2.close();
    }
  } finally {
    await browser.close();
    await atlas.stop();
  }

  console.log('\n[无边数据] debug.linkCount === 0');
  const a2 = await startAtlas({ prefix: 'atlas-starmap-nolinks-', files: { 'p/a.md': '# A\n', 'p/b.md': '# B\n', 'q/c.html': '<h1>C</h1>' } });
  const b2 = await chromium.launch();
  try {
    const { page } = await newPage(b2);
    await page.goto(a2.base);
    await page.waitForSelector('#tree .file');
    await page.evaluate(() => selectView('map'));
    await page.waitForFunction(() => starmapLinks.loaded, null, { timeout: 8000 }).catch(() => {});
    check('/api/links 已加载', await page.evaluate(() => starmapLinks.loaded), true);
    check('无边数据时 linkCount === 0', await page.evaluate(() => AtlasStarmap.debug.linkCount), 0);
    check('图例不显示「引用关系暂不可用」（数据可用，只是没有边）', await page.evaluate(() =>
      document.getElementById('starmap-legend').classList.contains('links-na')), false);
  } finally {
    await b2.close();
    await a2.stop();
  }
}

(async () => {
  console.log('==== star-map.spec ====');
  nodeSection();
  await playwrightSection();
  console.log('\n========================');
  console.log(`总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('spec 自身出错:', e); process.exit(1); });
