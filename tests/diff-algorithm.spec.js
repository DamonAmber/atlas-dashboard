// 行级 diff 算法单测（纯函数，不需要起服务）
//
// 重点回归：Myers 的差异上限必须卡在编辑距离 D 上，不能卡在 N+M —— 卡错的话
// 一份 6000 行只改了 12 处的文件会被误判成"差异过大"而退化成整体替换。
// 另外 trace 每层切片的左边界不能算成负数（TypedArray.slice 会当成从末尾数）。
const { diffText } = require('../lib/diff.js');
let fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`✗ ${name}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`); }
  else console.log(`✓ ${name}`);
}

// 1. 完全相同
let r = diffText('a\nb\nc', 'a\nb\nc');
eq('相同内容 changed=false', r.changed, false);
eq('相同内容无 hunk', r.hunks.length, 0);

// 2. 改一行
r = diffText('a\nb\nc', 'a\nB\nc');
eq('改一行 added', r.added, 1);
eq('改一行 removed', r.removed, 1);
eq('改一行只有一个 hunk', r.hunks.length, 1);
eq('hunk 里的行序列', r.hunks[0].lines.map(l => l.type + ':' + l.text),
   ['eq:a', 'del:b', 'add:B', 'eq:c']);
eq('行号：删除行的旧行号', r.hunks[0].lines[1].oldLine, 2);
eq('行号：新增行的新行号', r.hunks[0].lines[2].newLine, 2);

// 3. 纯新增
r = diffText('a\nb', 'a\nb\nc\nd');
eq('纯新增 added', r.added, 2);
eq('纯新增 removed', r.removed, 0);

// 4. 纯删除
r = diffText('a\nb\nc', 'a');
eq('纯删除 removed', r.removed, 2);
eq('纯删除 added', r.added, 0);

// 5. 空 → 有内容
r = diffText('', 'x\ny');
eq('空到有 added', r.added, 2);
eq('空到有 changed', r.changed, true);

// 6. 有内容 → 空
r = diffText('x\ny', '');
eq('有到空 removed', r.removed, 2);

// 7. 远距离两处改动 → 两个 hunk
const base = Array.from({ length: 40 }, (_, i) => 'line' + i).join('\n');
const mod = base.split('\n').map((l, i) => (i === 2 ? 'CHANGED2' : i === 30 ? 'CHANGED30' : l)).join('\n');
r = diffText(base, mod);
eq('两处远距离改动 → 2 个 hunk', r.hunks.length, 2);
eq('两处改动 added', r.added, 2);
eq('两处改动 removed', r.removed, 2);
eq('第二个 hunk 记录了跳过的行数 > 0', r.hunks[1].skipped > 0, true);

// 8. 上下文行数
r = diffText(base, mod, { context: 1 });
eq('context=1 时首个 hunk 只有 3 行', r.hunks[0].lines.length, 4); // eq, del, add, eq
// del+add 相邻，前后各 1 行上下文

// 9. 结尾换行差异
r = diffText('a\nb', 'a\nb\n');
eq('仅结尾换行不同视为无改动', r.changed, false);

// 10. 中文与长行
r = diffText('标题\n正文一', '标题\n正文二');
eq('中文改动 added', r.added, 1);
eq('中文改动内容', r.hunks[0].lines.filter(l => l.type === 'add')[0].text, '正文二');

// 11. 大文件性能 + 不炸
const bigA = Array.from({ length: 6000 }, (_, i) => 'row ' + i).join('\n');
const bigB = Array.from({ length: 6000 }, (_, i) => (i % 500 === 0 ? 'ROW ' + i : 'row ' + i)).join('\n');
const t0 = Date.now();
r = diffText(bigA, bigB);
const ms = Date.now() - t0;
eq('6000 行 12 处改动 added', r.added, 12);
eq('6000 行 12 处改动 removed', r.removed, 12);
console.log(`· 6000 行 diff 耗时 ${ms}ms`);
eq('6000 行 diff 在 2s 内完成', ms < 2000, true);

// 12. 完全不同的大文件（差异距离极大）→ 走 wholeReplace，不能挂
const wildA = Array.from({ length: 5000 }, (_, i) => 'aaa' + i).join('\n');
const wildB = Array.from({ length: 5000 }, (_, i) => 'bbb' + i).join('\n');
const t1 = Date.now();
r = diffText(wildA, wildB);
const ms2 = Date.now() - t1;
console.log(`· 5000 行全不同 diff 耗时 ${ms2}ms`);
eq('全不同：所有行都算改动', r.added === 5000 && r.removed === 5000, true);
eq('全不同不超时', ms2 < 5000, true);

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
