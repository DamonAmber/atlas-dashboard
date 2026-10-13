// 星图标签布局基准（design §10.2）：5 万颗星、1440×900 视口跑 600 帧，打印 placeLabels 的 p95。
// 期望 p95 < 4ms。node 基准脚本，不进 test 串（不是 *.spec.js）。
//   node tests/bench/starmap-labels.bench.js
const path = require('path');
const SM = require(path.join(__dirname, '..', '..', 'public', 'starmap.js'));

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const r = rng(42);
const N = 50_000, P = 120;
const projects = Array.from({ length: P }, (_, i) => ({ name: 'proj-' + String(i).padStart(3, '0'), count: 0 }));
const rows = [];
for (let i = 0; i < N; i++) {
  // 项目大小不均：少数大项目 + 长尾
  const p = projects[Math.floor(Math.pow(r(), 2) * P)];
  p.count++;
  rows.push({ path: `/bench/${p.name}/doc-${i}.html`, project: p.name });
}
const live = projects.filter(p => p.count > 0);
const clusters = SM.layoutClusters(live);
const st = SM.layoutStars(rows, clusters);
const HOUR = 3_600_000;
const now = Date.now();
const mtime = new Float64Array(N), tier = new Uint8Array(N), flags = new Uint8Array(N), labelW = new Float32Array(N);
for (let i = 0; i < N; i++) {
  mtime[i] = now - Math.pow(r(), 3) * 60 * 24 * HOUR;
  tier[i] = SM.tierOf(mtime[i], now);
  const unread = r() < (tier[i] <= 2 ? 0.3 : 0.04);
  flags[i] = (unread ? 1 : 0) | (unread && tier[i] <= 2 ? 2 : 0) | (r() < 0.002 ? 4 : 0);
  labelW[i] = 50 + r() * 110;
}
clusters.forEach(c => { c.lw = 40 + c.name.length * 7 + 30; });
const stars = { n: N, x: st.x, y: st.y, tier, flags, mtime, hit: new Uint8Array(N).fill(1), labelW, selected: -1, hovered: -1 };
const vp = { w: 1440, h: 900 };
const hud = [
  { x: 16, y: 14, w: 470, h: 32 }, { x: 1300, y: 14, w: 124, h: 30 },
  { x: 16, y: 600, w: 250, h: 284 }, { x: 1384, y: 760, w: 40, h: 124 },
];

// 600 帧：远景 / 中景 / 近景各 200 帧，沿几个大星团之间平移
const big = clusters.slice().sort((a, b) => b.count - a.count).slice(0, 6);
const scales = [0.12, 0.6, 2.4];
const times = [];
let prev = null;
const perLod = { far: [], mid: [], near: [] };
for (let f = 0; f < 600; f++) {
  const seg = Math.floor(f / 200), t = (f % 200) / 200;
  const a = big[seg % big.length], b = big[(seg + 1) % big.length];
  const cam = { x: a.cx + (b.cx - a.cx) * t, y: a.cy + (b.cy - a.cy) * t, s: scales[seg] * (1 + 0.3 * Math.sin(t * Math.PI)) };
  stars.selected = f % 37 === 0 ? Math.floor(r() * N) : -1;
  const t0 = process.hrtime.bigint();
  const res = SM.placeLabels(stars, clusters, cam, vp, hud, prev);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  prev = res.placed;
  times.push(ms);
  perLod[res.lod].push(ms);
}
const pct = (arr, q) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const p95 = pct(times, 0.95);
console.log(`星图标签布局基准：${N.toLocaleString()} 颗星 · ${clusters.length} 个星团 · ${vp.w}×${vp.h} · 600 帧`);
for (const k of ['far', 'mid', 'near']) {
  if (perLod[k].length) console.log(`  ${k.padEnd(4)} ${String(perLod[k].length).padStart(3)} 帧  p50 ${pct(perLod[k], 0.5).toFixed(2)}ms  p95 ${pct(perLod[k], 0.95).toFixed(2)}ms`);
}
console.log(`  全部 p50 ${pct(times, 0.5).toFixed(2)}ms  p95 ${p95.toFixed(2)}ms  max ${Math.max(...times).toFixed(2)}ms`);
console.log(p95 < 4 ? `p95 ${p95.toFixed(2)}ms < 4ms ✓` : `p95 ${p95.toFixed(2)}ms ≥ 4ms ✗`);
process.exit(p95 < 4 ? 0 : 1);
