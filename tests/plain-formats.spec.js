// CSV / JSON / 纯文本 / SVG 的扫描与预览
//
// 为什么默认不扫这四种：AI 顺手导出的数据文件通常比正文多得多（一次分析吐
// 十几个 csv 很常见）。无条件扫进来会把目录树冲淡，未读红点也跟着失真，
// 而红点的价值全在于稀缺。所以它们是"需要时再勾"的。
//
// 本 spec 钉住的点：
//   ① 默认只扫 html + md，勾选后才出现
//   ② CSV 解析要顶得住真实数据：引号里的分隔符与换行、"" 转义、空字段、
//      非逗号分隔符。切错一行整张表就全错位了
//   ③ 数字列右对齐（一列价格扫下来能比大小），宽表有横向滚动提示
//   ④ JSON 格式化 + 语法高亮；非法 JSON 不白屏，报出位置并按原文显示
//   ⑤ SVG 用 <img> 引入，里面的脚本不执行
//   ⑥ 这些格式在 Atlas 里只读（没有编辑器），SVG 不支持导出 PDF
//   ⑦ 全文搜索能命中它们的内容
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');
const plainRender = require(path.join(ROOT, 'lib/plain-render.js'));

// 真实数据里的四种麻烦：字段含分隔符、字段含换行、字段含引号、字段为空
const CSV = [
  '指标,启动次数,转化率,归因说明',
  '"设备 A, 型号 X",128304,38.2%,"多行\n说明第二行"',
  '设备 B,1290,41.0%,"含 ""引号"" 的说明"',
  '设备 C,,,空数据',
].join('\n');

const WIDE_CSV = ['a,b,c,d,e,f,g,h,i,j,k,l',
  '1,2,3,4,5,6,7,8,9,10,11,一段够长的说明文字把这一列撑开'].join('\n');

const JSON_OK = JSON.stringify({
  name: 'atlas', version: 3, ok: true, nothing: null,
  list: [1, 'two', false, null], nested: { a: { b: [1, 2] } },
});
const JSON_BAD = '{\n  "a": 1,\n  "b": [1, 2, 3],\n  "c": [1,2,, ]\n}';
const TXT = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行日志 needle-txt`).join('\n');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">'
  + '<title>图形标题 needle-svg</title>'
  + '<rect width="120" height="60" fill="#5b9cff"/>'
  + '<text x="10" y="35" fill="#fff">标签文字</text>'
  + '<script>window.__pwned = 1;</script>'
  + '</svg>';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

(async () => {
  // ---- CSV 解析（纯函数，失败信息最直接）----
  console.log('\n[CSV 解析]');
  const parsed = plainRender.parseCsv(CSV, ',');
  check('行数正确（引号内的换行不算换行）', parsed.rows.length, 4);
  check('字段里的分隔符不切行', parsed.rows[1][0], '设备 A, 型号 X');
  check('字段里的换行原样保留', parsed.rows[1][3], '多行\n说明第二行');
  check('"" 还原成一个引号', parsed.rows[2][3], '含 "引号" 的说明');
  check('空字段保留成空串（不塌缩）', [parsed.rows[3][1], parsed.rows[3][2]], ['', '']);
  console.log('\n[分隔符嗅探]');
  check('逗号', plainRender.sniffDelimiter('a,b,c', '.csv'), ',');
  check('分号（欧洲区域导出的就是这种）', plainRender.sniffDelimiter('a;b;c', '.csv'), ';');
  check('.tsv 直接用 Tab', plainRender.sniffDelimiter('a\tb', '.tsv'), '\t');
  check('引号内的分隔符不参与计数', plainRender.sniffDelimiter('"a,b";c;d', '.csv'), ';');

  // ---- 默认不扫 ----
  const atlas = await startAtlas({
    prefix: 'atlas-plain-',
    files: {
      'proj/data.csv': CSV,
      'proj/wide.csv': WIDE_CSV,
      'proj/conf.json': JSON_OK,
      'proj/broken.json': JSON_BAD,
      'proj/log.txt': TXT,
      'proj/icon.svg': SVG,
      'proj/note.md': '# 笔记\n\n正文。\n',
      'proj/page.html': '<!doctype html><html><body><h1>页面</h1></body></html>',
    },
  });
  console.log('\n[默认只扫 HTML + Markdown]');
  const st0 = await (await fetch(atlas.base + '/api/state')).json();
  check('默认 docTypes', st0.docTypes, ['html', 'md']);
  check('只扫到 html 与 md',
    Object.values(st0.files).map(f => f.name).sort(), ['note.md', 'page.html']);

  // ---- 打开全部类型 ----
  console.log('\n[勾选后]');
  const put = await fetch(atlas.base + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: atlas.base },
    body: JSON.stringify({ docTypes: ['html', 'md', 'csv', 'json', 'txt', 'svg'] }),
  });
  check('配置接口接受新类型', put.status, 200);
  await new Promise(r => setTimeout(r, 600));
  const st1 = await (await fetch(atlas.base + '/api/state')).json();
  const byName = {};
  for (const f of Object.values(st1.files)) byName[f.name] = f;
  check('八个文件都进来了', Object.keys(byName).length, 8);
  check('docType 标注正确',
    ['data.csv', 'conf.json', 'log.txt', 'icon.svg'].map(n => byName[n].docType),
    ['csv', 'json', 'txt', 'svg']);

  // ---- 全文搜索 ----
  console.log('\n[全文搜索]');
  const search = async (q) => {
    const r = await (await fetch(atlas.base + '/api/search?q=' + encodeURIComponent(q))).json();
    return (r.matches || []).map(m => path.basename(m.path)).sort();
  };
  check('命中 txt 正文', await search('needle-txt'), ['log.txt']);
  check('命中 csv 的列名', await search('归因说明'), ['data.csv']);
  check('命中 json 的键名', await search('nested'), ['conf.json']);
  check('命中 svg 里的文字（坐标不进索引）', await search('needle-svg'), ['icon.svg']);

  // ---- 渲染页 ----
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const openRender = async (name) => {
    await page.goto(atlas.base + '/api/render-doc?path=' + encodeURIComponent(byName[name].path));
    await page.waitForTimeout(400);
  };

  console.log('\n[CSV 预览]');
  await openRender('data.csv');
  const csvView = await page.evaluate(() => ({
    meta: document.querySelector('.plain-meta').textContent.trim(),
    rows: document.querySelectorAll('table tbody tr').length,
    cols: document.querySelectorAll('table thead th').length,
    newlineKept: [...document.querySelectorAll('td')].some(td => td.textContent.includes('说明第二行')),
    quoteKept: [...document.querySelectorAll('td')].some(td => td.textContent.includes('含 "引号" 的说明')),
    rightAligned: [...document.querySelectorAll('td')].filter(td => td.style.textAlign === 'right').length,
    // 文本列不该被右对齐
    textColRight: [...document.querySelectorAll('tbody tr')]
      .some(tr => tr.children[3] && tr.children[3].style.textAlign === 'right'),
  }));
  check('显示行列数与分隔符', /3 行 · 4 列 · 分隔符/.test(csvView.meta), true);
  check('表格结构正确', [csvView.rows, csvView.cols], [3, 4]);
  check('引号内的换行留在同一个单元格', csvView.newlineKept, true);
  check('"" 转义正确显示', csvView.quoteKept, true);
  check('数字列右对齐（启动次数 + 转化率 × 3 行）', csvView.rightAligned, 6);
  check('文本列不右对齐', csvView.textColRight, false);

  await openRender('wide.csv');
  check('宽表套上了横向滚动层（右缘会给出「还有内容」提示）',
    await page.evaluate(() => document.querySelectorAll('.md-table-scroll').length), 1);

  console.log('\n[JSON 预览]');
  await openRender('conf.json');
  const jsonView = await page.evaluate(() => ({
    meta: document.querySelector('.plain-meta').textContent.trim(),
    keys: document.querySelectorAll('.j-key').length,
    strs: document.querySelectorAll('.j-str').length,
    nums: document.querySelectorAll('.j-num').length,
    bools: document.querySelectorAll('.j-bool').length,
    nulls: document.querySelectorAll('.j-null').length,
    // 压缩成一行的源码要被重新缩进，否则看不出结构
    lines: document.querySelector('.plain-pre').textContent.split('\n').length,
  }));
  check('顶部说明是对象与键数', jsonView.meta, '对象 · 6 个键');
  check('键名全部高亮', jsonView.keys, 8);
  check('字符串 / 数字 / 布尔 / null 各自上色',
    [jsonView.strs, jsonView.nums, jsonView.bools, jsonView.nulls], [2, 4, 2, 2]);
  check('压缩的一行 JSON 被重新缩进展开', jsonView.lines > 10, true);

  await openRender('broken.json');
  const badView = await page.evaluate(() => ({
    hasError: !!document.querySelector('.plain-note-error'),
    errText: (document.querySelector('.plain-note-error') || {}).textContent || '',
    showsRaw: (document.querySelector('.plain-pre') || {}).textContent.includes('"b": [1, 2, 3]'),
  }));
  check('非法 JSON 明确报错而不是白屏', badView.hasError, true);
  check('报错里说清是哪一行', /第 \d+ 行/.test(badView.errText), true);
  check('并且按原文显示，内容不丢', badView.showsRaw, true);

  console.log('\n[纯文本预览]');
  await openRender('log.txt');
  check('行数正确',
    await page.evaluate(() => document.querySelector('.plain-meta').textContent.trim()), '12 行');
  check('等宽显示且保留空白',
    await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.plain-pre'));
      return cs.whiteSpace === 'pre-wrap' && /mono/i.test(cs.fontFamily);
    }), true);

  console.log('\n[SVG 预览]');
  await openRender('icon.svg');
  const svgView = await page.evaluate(() => ({
    imgSrc: (document.querySelector('.plain-svg-stage img') || {}).getAttribute
      ? document.querySelector('.plain-svg-stage img').getAttribute('src') : null,
    loaded: (() => { const i = document.querySelector('.plain-svg-stage img'); return !!(i && i.naturalWidth > 0); })(),
    inlineSvg: document.querySelectorAll('svg').length,
    pwned: typeof window.__pwned,
  }));
  check('用 <img> 引 /raw/ 地址', /^\/raw\/0\/proj\/icon\.svg$/.test(svgView.imgSrc || ''), true);
  check('图确实加载出来了', svgView.loaded, true);
  check('不内联 SVG 标记（避免脚本进页面）', svgView.inlineSvg, 0);
  check('SVG 里的脚本没有执行', svgView.pwned, 'undefined');
  check('渲染页全程没有 console 报错', consoleErrors, []);

  // ---- dashboard 内的表现 ----
  console.log('\n[目录树与顶栏]');
  await page.goto(atlas.base);
  await page.waitForSelector('.file');
  // 排序后比较：树的渲染顺序不该影响这条断言
  const badges = await page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('.file')) {
      out[el.dataset.doctype] = el.querySelector('.file-type-badge').textContent;
    }
    return Object.keys(out).sort().map(k => k + '=' + out[k]);
  });
  check('每种类型都有自己的角标',
    badges, ['csv=CSV', 'html=HTML', 'json=JSON', 'md=MD', 'svg=SVG', 'txt=TXT']);

  await page.click('.file[data-doctype="csv"] .file-name');
  await page.waitForTimeout(900);
  const csvTop = await page.evaluate(() => ({
    src: document.getElementById('preview').getAttribute('src').split('?')[0],
    editDisabled: document.getElementById('btn-edit').disabled,
    pdfDisabled: document.getElementById('btn-export-pdf').disabled,
    shareDisabled: document.getElementById('btn-share').disabled,
  }));
  check('CSV 走 /api/render-doc', csvTop.src, '/api/render-doc');
  check('CSV 只读（编辑按钮禁用）', csvTop.editDisabled, true);
  check('CSV 可以导出 PDF', csvTop.pdfDisabled, false);
  check('CSV 可以分享', csvTop.shareDisabled, false);

  await page.click('.file[data-doctype="svg"] .file-name');
  await page.waitForTimeout(900);
  check('SVG 不支持导出 PDF',
    await page.evaluate(() => document.getElementById('btn-export-pdf').disabled), true);

  // ---- 分享页要渲染而不是让浏览器下载 ----
  console.log('\n[局域网分享]');
  const share = await (await fetch(atlas.base + '/api/share/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: atlas.base },
    body: JSON.stringify({ path: byName['data.csv'].path }),
  })).json();
  const res = await fetch(`${atlas.base}/share/${share.token}/data.csv`);
  const html = await res.text();
  check('分享 CSV 返回的是网页', (res.headers.get('content-type') || '').includes('text/html'), true);
  check('并且已经渲染成表格', /<table>/.test(html) && html.includes('归因说明'), true);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(failures === 0 ? '总计 全部通过' : `总计 ${failures} 项未通过`);
  if (failures > 0) process.exit(1);
})();
