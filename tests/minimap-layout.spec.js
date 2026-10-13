// 首页迷你星图 / 主星图远景的布局护栏（桌面实机验收 client-fix §9，纯 node，不起服务）
//
// 用夹具同款的极不均衡分布：800 / 408 / 160 / 110 篇的大星团 + 34 个 1–9 篇的小星团。
//   - clusterRadius：64 篇以内 = 14√n；更多时对数增长、单调、远小于 14√n（800 篇 < 70%）
//   - 星团两两 dist ≥ Hi + Hj + 28（压缩半径后布局约束照旧）
//   - fitThumb：623×212 画布横向利用率 ≥ 70%（以前 31%）；屏幕上任意两星团光晕间隙 ≥ 28·rs，
//     并且至少 2px；最大光晕面积占比 < 30%（以前 39%）
//   - placeThumbLabels：放出的星团名两两不相交、不压任何星团的星盘、不出画布；画出的数量 ≥ 以前（12）
//   - 主星图远景 placeLabels：星团名不压别的星团的星盘
const SM = require('../public/starmap.js');
let fail = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`✗ ${name}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`); }
  else console.log(`✓ ${name}`);
}
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

console.log('[clusterRadius]');
check('n ≤ 64：R = 14√n', [1, 9, 64].map(n => +SM.clusterRadius(n).toFixed(6)), [1, 9, 64].map(n => +(14 * Math.sqrt(n)).toFixed(6)));
const rs = [65, 100, 160, 408, 800, 5000].map(SM.clusterRadius);
check('n > 64：单调递增', rs.every((r, i) => i === 0 || r > rs[i - 1]), true);
check('n = 64 处连续', Math.abs(SM.clusterRadius(64) - SM.clusterRadius(64.0001)) < 0.01, true);
check('800 篇的半径 < 14√800 的 70%（压缩生效）', SM.clusterRadius(800) < 0.7 * 14 * Math.sqrt(800), true);
console.log(`      （800 篇 R = ${SM.clusterRadius(800).toFixed(1)}，原 ${(14 * Math.sqrt(800)).toFixed(1)}）`);

// 夹具分布（gen-fixture.js）：名字带序号前缀，和真实项目名一样按名字排序放置
const SIZES = [800, 408, 160, 110, 60, 42, 30, 24, 18, 14, 12, 10, 9, 9, 8, 7, 7, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const NAMES = ['DSH', 'data-analysis', 'push', 'web-demo', 'camera-ui', 'feishu-bot', 'datum-sql', 'design-tokens', 'energy-report',
  'atlas-notes', 'benchmarks', 'archive-2025', 'hr-docs', 'ideas', 'scratch', 'infra-ops', 'onboarding', 'mijia-app', 'ota', 'cloud',
  'iot-spec', 'qa', 'perf', 'bugbash', 'weekly', 'okr', 'retro', 'misc', 'legal', 'brand', 'travel', 'faq', 'mail', 'tmp', 'x1', 'x2', 'x3', 'x4'];
const projects = SIZES.map((count, i) => ({ name: NAMES[i], count }));
const cl = SM.layoutClusters(projects);
let minGap = Infinity;
for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
  minGap = Math.min(minGap, Math.hypot(cl[i].cx - cl[j].cx, cl[i].cy - cl[j].cy) - (cl[i].h + cl[j].h + 28));
}
check(`${cl.length} 个星团两两 dist ≥ Hi + Hj + 28`, minGap >= -1e-6, true);

console.log('\n[fitThumb] 623×212 画布');
const CW = 623, CH = 212;
const fit = SM.fitThumb(cl, CW, CH);
let x0 = Infinity, x1 = -Infinity;
const disc = cl.map(c => ({ x: fit.tx(c.cx), y: fit.ty(c.cy), h: c.h * fit.rs, r: c.r * fit.rs, count: c.count, name: c.name }));
for (const d of disc) { x0 = Math.min(x0, d.x - d.h); x1 = Math.max(x1, d.x + d.h); }
const useW = (x1 - x0) / CW;
console.log(`      （sx ${fit.sx.toFixed(3)} · sy ${fit.sy.toFixed(3)} · rs ${fit.rs.toFixed(3)} · 横向利用率 ${(useW * 100).toFixed(0)}%）`);
check('横向利用率 ≥ 70%（以前按包围盒等比缩放只有 31%）', useW >= 0.70, true);
check('全部光晕在画布内', disc.every(d => d.x - d.h >= -0.5 && d.x + d.h <= CW + 0.5 && d.y - d.h >= -0.5 && d.y + d.h <= CH + 0.5), true);
let minScreenGap = Infinity;
for (let i = 0; i < disc.length; i++) for (let j = i + 1; j < disc.length; j++) {
  minScreenGap = Math.min(minScreenGap, Math.hypot(disc[i].x - disc[j].x, disc[i].y - disc[j].y) - disc[i].h - disc[j].h);
}
console.log(`      （屏幕上光晕最小间隙 ${minScreenGap.toFixed(2)}px，下限 28·rs = ${(28 * fit.rs).toFixed(2)}px）`);
check('屏幕上任意两光晕间隙 ≥ 28·rs', minScreenGap >= 28 * fit.rs - 1e-6, true);
check('屏幕上任意两光晕间隙 ≥ 2px', minScreenGap >= 2, true);
const areas = disc.map(d => d.h * d.h);
const share = Math.max(...areas) / areas.reduce((a, b) => a + b, 0);
console.log(`      （最大光晕面积占比 ${(share * 100).toFixed(0)}%）`);
check('最大光晕面积占全部光晕 < 30%（以前 39%）', share < 0.30, true);

console.log('\n[placeThumbLabels]');
const charW = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 11 : 6.2), 0);
const items = disc.map((d, i) => ({ i, x: d.x, y: d.y, r: Math.max(2, d.r), w: charW(d.name), h: 13, count: d.count }));
const placed = SM.placeThumbLabels(items, CW, CH);
console.log(`      （放出 ${placed.length} / ${items.length} 个星团名）`);
check('放出的星团名 ≥ 12 个（以前 12 个里有 10 个压在星点上）', placed.length >= 12, true);
let lblOverlap = 0, discHit = 0, outOf = 0;
for (let a = 0; a < placed.length; a++) {
  for (let b = a + 1; b < placed.length; b++) if (overlap(placed[a], placed[b])) lblOverlap++;
  for (const it of items) if (SM.boxHitsCircle(placed[a], it.x, it.y, it.r)) discHit++;
  const p = placed[a];
  if (p.x < 0 || p.y < 0 || p.x + p.w > CW || p.y + p.h > CH) outOf++;
}
check('星团名两两不相交', lblOverlap, 0);
check('星团名不压任何星团的星盘（含自己的）', discHit, 0);
check('星团名不出画布', outOf, 0);
check('篇数最多的星团一定有名字', placed.some(p => p.i === items.reduce((m, it) => it.count > items[m].count ? it.i : m, 0)), true);
check('同输入结果相同', JSON.stringify(SM.placeThumbLabels(items, CW, CH)), JSON.stringify(placed));

console.log('\n[随机分布] 30 组 2–60 个星团，迷你星图间隙与标签');
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
let okGap = true, okLbl = true;
for (let t = 0; t < 30; t++) {
  const P = 2 + Math.floor(rnd() * 59);
  const ps = Array.from({ length: P }, (_, i) => ({ name: 'p' + i + '-' + Math.floor(rnd() * 1e4), count: 1 + Math.floor(rnd() < 0.15 ? rnd() * 900 : rnd() * 20) }));
  const c2 = SM.layoutClusters(ps);
  const f2 = SM.fitThumb(c2, CW, CH);
  const d2 = c2.map(c => ({ x: f2.tx(c.cx), y: f2.ty(c.cy), h: c.h * f2.rs, r: c.r * f2.rs, count: c.count, w: charW(c.name) }));
  for (let i = 0; i < d2.length; i++) for (let j = i + 1; j < d2.length; j++) {
    if (Math.hypot(d2[i].x - d2[j].x, d2[i].y - d2[j].y) - d2[i].h - d2[j].h < 28 * f2.rs - 1e-6) okGap = false;
  }
  const it2 = d2.map((d, i) => ({ i, x: d.x, y: d.y, r: Math.max(2, d.r), w: d.w, h: 13, count: d.count }));
  const pl = SM.placeThumbLabels(it2, CW, CH);
  for (let a = 0; a < pl.length; a++) {
    for (let b = a + 1; b < pl.length; b++) if (overlap(pl[a], pl[b])) okLbl = false;
    for (const it of it2) if (SM.boxHitsCircle(pl[a], it.x, it.y, it.r)) okLbl = false;
  }
}
check('30 组随机分布：屏幕光晕间隙全部 ≥ 28·rs', okGap, true);
check('30 组随机分布：星团名不互压、不压星盘', okLbl, true);

console.log('\n[主星图远景 placeLabels] 星团名不压别的星团的星盘');
{
  const rows = [];
  cl.forEach(c => { for (let k = 0; k < c.count; k++) rows.push({ path: `/f/${c.name}/${k}`, project: c.name }); });
  const st = SM.layoutStars(rows, cl);
  const n = rows.length;
  const stars = { n, x: st.x, y: st.y, tier: new Uint8Array(n).fill(3), flags: new Uint8Array(n), mtime: new Float64Array(n), hit: null, labelW: null, selected: -1, hovered: -1 };
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const c of cl) { bx0 = Math.min(bx0, c.cx - c.h); by0 = Math.min(by0, c.cy - c.h); bx1 = Math.max(bx1, c.cx + c.h); by1 = Math.max(by1, c.cy + c.h); }
  const VW = 1100, VH = 760;
  const s = Math.min(VW / (bx1 - bx0), VH / (by1 - by0)) * 0.95;
  const cam = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2, s };
  const clW = cl.map(c => ({ ...c, lw: charW(c.name) + 40 }));
  const res = SM.placeLabels(stars, clW, cam, { w: VW, h: VH }, [], null);
  const sxOf = (wx) => (wx - cam.x) * s + VW / 2, syOf = (wy) => (wy - cam.y) * s + VH / 2;
  let hits = 0;
  for (const lb of res.clusterLabels) {
    cl.forEach((c, ci) => { if (ci !== lb.i && SM.boxHitsCircle(lb, sxOf(c.cx), syOf(c.cy), c.r * s)) hits++; });
  }
  console.log(`      （远景 s=${s.toFixed(3)}：放出 ${res.clusterLabels.length} 个星团名，隐藏 ${res.clusterHidden}）`);
  check('远景：星团名不压别的星团的星盘', hits, 0);
  check('远景：返回 clusterHidden（HUD 的「隐藏」计入星团名）', typeof res.clusterHidden, 'number');
  check('远景：放出的 + 隐藏的 = 视口内星团数', res.clusterLabels.length + res.clusterHidden, cl.length);
}

console.log(`\n总计 ${total} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
