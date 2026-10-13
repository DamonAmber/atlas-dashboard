// 时间河流比例尺与 mtime 兜底口径（桌面实机验收 client-fix §10，纯 node，不起服务）
//
// 夹具场景：活动日志刚启用（logStart ≈ now），139 篇今天改过，其中 117 篇落在同一小时（尖峰），
// 其余零散分布。以前按全窗口最大值开方：1 次改动的柱子只有 8.5% 高、168 根柱的中位数 8.51、p90 17。
//   - riverScale：cap = 非零小时的 p95（至少 4），单个尖峰不再决定比例尺；≥ 3·cap 的尖峰列为 peaks（最多 6 根）
//   - barHeight：0 → 2（基线）；1 次 ≥ 14%；cap = 80%；超过 cap 按对数压到 80–92%，最大值画满；单调
//   - 非零柱的中位数高度 ≥ 25%（以前 8.5%）
//   - mergeWithFallback：日志为空且 logStart ≈ now 时，每篇只按最后一次 mtime 合成 1 个事件（数据层面的上限，
//     UI 里写明）；日志里已有同一 mtime 的事件时不重复合成
const R = require('../public/river.js');
let fail = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`✗ ${name}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`); }
  else console.log(`✓ ${name}`);
}
const H = R.HOUR;
const now = new Date(2026, 9, 12, 15, 40).getTime();
const files = [];
let k = 0;
// 117 篇在 15:00 这一小时
for (let i = 0; i < 117; i++) files.push({ path: `/d/spike-${i}.md`, mtime: R.floorHour(now) + 60_000 * (i % 39) });
// 22 篇零散在今天别的小时
for (let i = 0; i < 22; i++) files.push({ path: `/d/day-${i}.md`, mtime: now - (2 + (i % 12)) * H });
// 40 篇散在前 6 天（每天几篇）
for (let i = 0; i < 40; i++) files.push({ path: `/d/week-${i}.md`, mtime: now - (26 + (i * 3.7) % 140) * H });
// 30 篇 30 天前（窗口外）
for (let i = 0; i < 30; i++) files.push({ path: `/d/old-${i}.md`, mtime: now - 30 * 24 * H });
k = files.length;

console.log('[mtime 兜底]');
const log = { logStart: now - 5 * 60_000, mergeWindowMs: 60_000, events: [] };
const evs = R.mergeWithFallback(log, files, now);
check('日志为空：窗口内每篇文档恰好 1 个合成事件（最后一次 mtime）', evs.length, 117 + 22 + 40);
check('合成事件都标 src: mtime', evs.every(e => e.src === 'mtime'), true);
const withLog = { ...log, events: [{ t: files[0].mtime, kind: 1, path: files[0].path }] };
check('日志里已有同一 mtime 的事件：不重复合成', R.mergeWithFallback(withLog, files, now).filter(e => e.path === files[0].path).length, 1);
const b = R.bucketize(evs, now);
const t = R.riverTotals(b);
check('尖峰小时计数 117', t.busiestCount, 117);

console.log('\n[比例尺]');
const sc = R.riverScale(b.counts);
const nz = b.counts.filter(c => c > 0).sort((x, y) => x - y);
console.log(`      （非零小时 ${nz.length} 个，上限 cap = ${sc.cap}，尖峰柱 ${sc.peaks.length} 根）`);
check('上限 cap 远小于尖峰（不被单个尖峰决定）', sc.cap < 117 / 4, true);
check('上限 cap ≥ 4', sc.cap >= 4, true);
check('尖峰所在小时列为 peaks（柱顶标注真实次数）', sc.peaks.includes(t.busiest), true);
check('peaks 都 ≥ 3·cap，最多 6 根', sc.peaks.every(i => b.counts[i] >= 3 * sc.cap) && sc.peaks.length <= 6, true);
check('barHeight：0 次 = 2（基线）', R.barHeight(0, sc.cap), 2);
check('barHeight：1 次 ≥ 14%', R.barHeight(1, sc.cap) >= 14, true);
check('barHeight：达到 cap = 80%', R.barHeight(sc.cap, sc.cap, 117), 80);
check('barHeight：最大的尖峰 = 92%（画满），介于两者之间按对数', [R.barHeight(117, sc.cap, 117), R.barHeight(20, sc.cap, 117) > 80 && R.barHeight(20, sc.cap, 117) < 92], [92, true]);
const hs = [1, 2, 3, 4, 6, 9, 20, 117].map(c => R.barHeight(c, 9, 117));
check('barHeight 单调不减', hs.every((h, i) => i === 0 || h >= hs[i - 1]), true);
const heights = b.counts.filter(c => c > 0).map(c => R.barHeight(c, sc.cap, sc.max)).sort((x, y) => x - y);
const median = heights[Math.floor(heights.length / 2)];
console.log(`      （非零柱高度中位数 ${median.toFixed(1)}%，以前按最大值开方是 ${(Math.max(6, Math.sqrt(nz[Math.floor(nz.length / 2)]) / Math.sqrt(117) * 92)).toFixed(1)}%）`);
check('非零柱高度中位数 ≥ 25%', median >= 25, true);
check('空窗口：cap 1、无 peaks', R.riverScale(new Array(168).fill(0)), { cap: 1, max: 0, peaks: [] });
check('均匀分布（全是 3）：没有 peaks，柱高 ≥ 65%', [R.riverScale(new Array(168).fill(3)).peaks.length, R.barHeight(3, 4, 3) >= 65], [0, true]);

console.log(`\n总计 ${total} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
