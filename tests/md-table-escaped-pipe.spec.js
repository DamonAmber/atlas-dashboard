// 表格单元格里的转义竖线 \|（纯函数单测，不需要起服务）
//
// 回归的 bug：splitRow 曾经无脑 s.split('|')，把单元格里 GFM 合法的 `\|`
// （字面竖线的标准写法）也当成列分隔符。后果是一格写了 `a \| b` 就凭空多切出
// 一列、整张表往右错位，多出来的尾列被丢掉；而且如果 `\|` 落在 `**...**` 中间，
// 加粗会因为找不到配对的收尾而按字面量显示。
//
// 更隐蔽的是往返（改一个字再存回）：序列化侧 cellText 正是把单元格里的 `|`
// 转义成 `\|` 写回源码的，解析侧不认它，写得出、读不回。
//
// 修好后：`\|` 不切列、还原成字面 `|`，列数与行内标记都不受影响。
const path = require('path');
const md = require(path.join(__dirname, '..', 'public', 'vendor', 'markdown.js'));

let fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    fail++;
    console.log(`✗ ${name}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

// 从渲染出的表格 HTML 里抽出某类单元格（th / td）的内容，按出现顺序排列。
// tag 后面用 (?:\s[^>]*)?> 收尾，既能匹配 <th> 和 <th style=...>，又不会把
// <thead> 这种前缀相同的标签误当成单元格。
function cellsOf(html, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// ---- ① 核心：转义竖线不切列，加粗与后续列都不受影响 ----
const A = md.render([
  '| 位置 | 内容 | 交互 |',
  '|------|------|------|',
  '| 二级页 | 副标题「**房间名 \\| 故障描述**」 | 点击进二级页 |',
].join('\n'));
const aTd = cellsOf(A, 'td');
eq('转义竖线：数据行仍是 3 列（没有多切出一列）', aTd.length, 3);
eq('转义竖线：加粗正确闭合、竖线还原为字面量',
  aTd[1], '副标题「<strong>房间名 | 故障描述</strong>」');
eq('转义竖线：后面的「交互」列没有被挤掉', aTd[2], '点击进二级页');

// ---- ② 一格里多个转义竖线都要还原（此解析器不支持单列表，故用两列）----
const B = md.render([
  '| 值 | 说明 |',
  '|----|------|',
  '| a \\| b \\| c | ok |',
].join('\n'));
const bTd = cellsOf(B, 'td');
eq('多个转义竖线：仍是 2 列（没被拆散）', bTd.length, 2);
eq('多个转义竖线：全部还原为字面量', bTd[0], 'a | b | c');
eq('多个转义竖线：相邻列不受影响', bTd[1], 'ok');

// ---- ③ 转义竖线出现在表头里（表头也走 splitRow）----
const C = md.render([
  '| a \\| b | 值 |',
  '|--------|-----|',
  '| 1 | 2 |',
].join('\n'));
const cTh = cellsOf(C, 'th');
const cTd = cellsOf(C, 'td');
eq('表头转义竖线：表头是 2 列', cTh.length, 2);
eq('表头转义竖线：首列还原为字面量', cTh[0], 'a | b');
eq('表头转义竖线：数据列数与表头一致', cTd.length, 2);

// ---- ④ 回归：普通表格（无转义）照常切列 ----
const D = md.render([
  '| 左 | 右 |',
  '|----|----|',
  '| 1 | 2 |',
].join('\n'));
eq('普通表格：表头两列', cellsOf(D, 'th'), ['左', '右']);
eq('普通表格：数据两列', cellsOf(D, 'td'), ['1', '2']);

// ---- ⑤ 回归：省略首尾边框竖线的表格照常识别与切列 ----
const E = md.render([
  'x | y',
  '---|---',
  '1 | 2',
].join('\n'));
eq('无边框表格：表头两列', cellsOf(E, 'th'), ['x', 'y']);
eq('无边框表格：数据两列', cellsOf(E, 'td'), ['1', '2']);

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项未通过'}`);
process.exit(fail === 0 ? 0 : 1);
