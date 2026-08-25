// Mermaid 图表与数学公式
//
// 为什么要有这一组：AI 写的架构说明、时序、流程几乎默认用 ```mermaid，
// 推导和指标定义常带 $…$。在这之前它们在 Atlas 里只是一段灰色代码块和一串
// 美元符号——用户看到一张图变成源码就会转去别的工具。
//
// 本 spec 钉住的点：
//   ① 图表真的渲染成 SVG；语法写错时显示 mermaid 的原始报错，且源码仍在
//      （降级必须可读——AI 写错 mermaid 语法是常事）
//   ② 行内与块级公式渲染成 KaTeX
//   ③ 价格不被当成公式：「单价 $5，折后 $4」这种句子必须原样显示。
//      这是整套边界规则里最容易回归的一条
//   ④ 按需加载：没有图表 / 公式的文档一个字节的 mermaid 都不该下载（3.5MB）
//   ⑤ 往返保真：含图表的文档在预览里改一个字，图表源码逐字节不变
//   ⑥ 打印版与局域网分享页同样能出图（这两条路径的资源前缀各不相同，
//      最容易漏——一条走 file://，一条走局域网访问）
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');
const markdown = require(path.join(ROOT, 'public/vendor/markdown.js'));

const RICH_MD = [
  '# 富内容',
  '',
  '```mermaid',
  'graph TD',
  '  A[开始] --> B{判断}',
  '  B -->|是| C[执行]',
  '  B -->|否| D[结束]',
  '```',
  '',
  '行内公式 $E = mc^2$ 与块级：',
  '',
  '$$',
  '\\int_0^1 x^2 dx = \\frac{1}{3}',
  '$$',
  '',
  '单价 $5，折后 $4，不是公式。$100 到 $200 也不是。',
  '',
  '句中 $$a^2+b^2=c^2$$ 算一条行内公式。',
  '',
  '`$notmath$` 在代码里不算。',
  '',
  '行内 \\(x_1\\) 反斜杠形式也认。',
  '',
  '```mermaid',
  'this is definitely not valid mermaid !!!',
  '```',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '| 列 | 值 |',
  '|----|---:|',
  '| a | 1 |',
  // 以换行结尾：正常的文本文件都是这样，而回写会把内容规范化成以换行结尾。
  // 少了这个换行，"除标题外逐字节不变"那条断言会被末尾的一个 \n 绊倒
].join('\n') + '\n';

const PLAIN_MD = '# 无图无式\n\n只有一段普通正文。\n\n```js\nconst a = 1;\n```\n';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

// 等图表渲染完：mermaid 是异步的，串行渲染多张图要一点时间
async function waitRich(frameOrPage, expectMermaid) {
  for (let i = 0; i < 40; i++) {
    const done = await frameOrPage.evaluate((n) => {
      const all = [...document.querySelectorAll('pre.md-mermaid')];
      return all.length >= n && all.every(p => p.getAttribute('data-md-rich') === 'done'
        || p.getAttribute('data-md-rich') === 'error');
    }, expectMermaid).catch(() => false);
    if (done) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

(async () => {
  // ---- 纯函数层：解析边界（不需要起服务，跑得快、失败信息直接）----
  console.log('\n[解析边界]');
  const html = markdown.renderBody(RICH_MD);
  check('mermaid 块用 pre.md-mermaid（降级即普通代码块）',
    /<pre class="md-mermaid"><code class="language-mermaid">/.test(html), true);
  check('mermaid 源码被转义后原样保留',
    html.includes('A[开始] --&gt; B{判断}'), true);
  check('行内公式抽出 data-md-tex', /data-md-tex="E = mc\^2"/.test(html), true);
  check('块级公式带 data-md-display', /class="md-math md-math-block" data-md-tex="[^"]*int_0/.test(html), true);
  check('价格不被当公式（单价 / 折后）', html.includes('单价 $5，折后 $4，不是公式。'), true);
  check('价格区间不被当公式（$100 到 $200）', html.includes('$100 到 $200 也不是。'), true);
  check('句中 $$…$$ 不留下孤立的 $',
    /data-md-tex="a\^2\+b\^2=c\^2"/.test(html) && !/<\/span>\$/.test(html), true);
  check('代码里的 $ 不算公式', html.includes('<code>$notmath$</code>'), true);
  check('\\(…\\) 形式也认', /data-md-tex="x_1"/.test(html), true);
  check('普通代码块不受影响', /<pre><code class="language-js">/.test(html), true);
  const plainHtml = markdown.renderBody(PLAIN_MD);
  check('无图无式的文档不产生富内容标记',
    markdown.detectRichInHtml(plainHtml), { mermaid: false, math: false });

  // ---- 只读预览页 ----
  const atlas = await startAtlas({
    prefix: 'atlas-rich-',
    files: { 'proj/rich.md': RICH_MD, 'proj/plain.md': PLAIN_MD },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // 按需加载：记录每篇文档加载了哪些 vendor 资源
  let vendorHits = [];
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/vendor/mermaid') || u.includes('/vendor/katex')) vendorHits.push(u.split('/vendor/')[1]);
  });

  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  console.log('\n[只读预览页]');
  await page.click('.file[data-path$="rich.md"] .file-name');
  const frame = () => page.frames().find(f => f !== page.mainFrame());
  await page.waitForTimeout(600);
  await waitRich(frame(), 2);

  const r = await frame().evaluate(() => {
    const mm = [...document.querySelectorAll('pre.md-mermaid')];
    const math = [...document.querySelectorAll('.md-math[data-md-tex]')];
    return {
      mermaidTotal: mm.length,
      mermaidRendered: mm.filter(p => p.classList.contains('is-rendered')).length,
      mermaidErrored: mm.filter(p => p.classList.contains('has-error')).length,
      svgCount: document.querySelectorAll('.md-mermaid-figure svg').length,
      errText: (document.querySelector('.md-mermaid-err') || {}).textContent || '',
      errKeepsSource: mm.filter(p => p.classList.contains('has-error'))
        .every(p => (p.querySelector('code') || {}).textContent),
      sourceToggles: document.querySelectorAll('.md-mermaid-btn').length,
      mathTotal: math.length,
      mathRendered: math.filter(e => e.classList.contains('is-rendered')).length,
      katexNodes: document.querySelectorAll('.katex').length,
      displayRendered: document.querySelectorAll('.md-math-block.is-rendered').length,
      // 图表块不该再被套上「MERMAID / 复制」的代码块头部
      mermaidCodeHead: document.querySelectorAll('pre.md-mermaid .md-code-head').length,
      plainCodeHead: document.querySelectorAll('pre:not(.md-mermaid) .md-code-head').length,
      priceText: document.body.innerText.includes('单价 $5，折后 $4'),
    };
  });
  check('两个 mermaid 块都被处理', r.mermaidTotal, 2);
  check('合法的那个渲染成 SVG', [r.mermaidRendered, r.svgCount], [1, 1]);
  check('非法的那个标成错误', r.mermaidErrored, 1);
  check('错误里带 mermaid 的原始报错', /diagram|syntax|mermaid/i.test(r.errText), true);
  check('出错的块仍保留源码（可读降级）', r.errKeepsSource, true);
  check('渲染成功的块有「源码」切换', r.sourceToggles, 1);
  check('四条公式全部渲染', [r.mathTotal, r.mathRendered], [4, 4]);
  check('KaTeX 节点数与公式数一致', r.katexNodes, 4);
  check('块级公式按 display 渲染', r.displayRendered, 1);
  check('图表块没有代码块头部', r.mermaidCodeHead, 0);
  check('普通代码块仍有代码块头部', r.plainCodeHead, 1);
  check('页面上价格文字原样显示', r.priceText, true);
  check('预览页没有 console 报错', consoleErrors, []);
  check('这篇文档确实加载了图表与公式库',
    ['mermaid.min.js', 'katex/katex.min.js', 'katex/katex.min.css']
      .every(x => vendorHits.some(h => h === x || h.startsWith(x))), true);

  console.log('\n[按需加载]');
  vendorHits = [];
  await page.click('.file[data-path$="plain.md"] .file-name');
  await page.waitForTimeout(1200);
  check('没有图表 / 公式的文档不下载这两个库（省 3.5MB）', vendorHits, []);

  // ---- 编辑器实时预览 ----
  console.log('\n[编辑器实时预览]');
  await page.click('.file[data-path$="rich.md"] .file-name');
  await page.waitForTimeout(500);
  await page.click('#btn-edit');
  await page.waitForSelector('#md-editor:not(.hidden)');
  // 实时预览的富渲染是 350ms 防抖 + mermaid 异步
  for (let i = 0; i < 40; i++) {
    const ok = await page.evaluate(() => {
      const mm = [...document.querySelectorAll('#md-preview pre.md-mermaid')];
      return mm.length >= 2 && mm.every(p => p.getAttribute('data-md-rich'));
    });
    if (ok) break;
    await page.waitForTimeout(150);
  }
  const ed = await page.evaluate(() => ({
    svg: document.querySelectorAll('#md-preview .md-mermaid-figure svg').length,
    katex: document.querySelectorAll('#md-preview .katex').length,
  }));
  check('编辑器预览面板里图表也出图', ed.svg, 1);
  check('编辑器预览面板里公式也渲染', ed.katex, 4);

  // ---- 往返保真：改一个字，图表源码不能被动 ----
  console.log('\n[往返保真]');
  const before = fs.readFileSync(atlas.filePath('proj/rich.md'), 'utf8');
  await page.evaluate(() => {
    const h1 = document.querySelector('#md-preview h1');
    h1.textContent = '富内容（改过）';
    h1.setAttribute('data-md-dirty', '1');
    h1.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.click('#btn-edit-save');
  await page.waitForTimeout(900);
  const after = fs.readFileSync(atlas.filePath('proj/rich.md'), 'utf8');
  check('标题确实改了', after.includes('# 富内容（改过）'), true);
  check('mermaid 源码逐字节不变',
    after.includes('```mermaid\ngraph TD\n  A[开始] --> B{判断}\n  B -->|是| C[执行]\n  B -->|否| D[结束]\n```'), true);
  check('公式源码逐字节不变',
    after.includes('$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$'), true);
  check('除标题外其余内容不变',
    after.replace('# 富内容（改过）', '# 富内容') === before, true);

  // ---- 打印版 ----
  console.log('\n[打印版]');
  const printHtml = markdown.renderPage(RICH_MD, {
    title: 'rich.md', baseHref: 'file:///tmp/docs/', forPrint: true,
    assetBase: 'file:///tmp/vendor/',
  });
  check('打印版挂上了渲染器（否则纸上是一段源码）',
    printHtml.includes('file:///tmp/vendor/markdown.js'), true);
  check('打印版的图表主题钉成浅色（深色图印在白纸上是墨块）',
    /"theme":"light"/.test(printHtml), true);
  const printPlain = markdown.renderPage(PLAIN_MD, { title: 'p.md', forPrint: true });
  check('无图无式的打印版不挂渲染器', printPlain.includes('markdown.js'), false);

  // ---- 局域网分享页 ----
  console.log('\n[局域网分享页]');
  const share = await (await fetch(atlas.base + '/api/share/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: atlas.base },
    body: JSON.stringify({ path: atlas.filePath('proj/rich.md') }),
  })).json();
  const sharePage = await fetch(`${atlas.base}/share/${share.token}/rich.md`);
  const shareHtml = await sharePage.text();
  check('分享页引用了渲染库', /\/vendor\/markdown\.js/.test(shareHtml), true);
  // /vendor/ 必须对局域网访客放行，否则他们打开分享链接只能看到源码
  const vendorRes = await fetch(atlas.base + '/vendor/mermaid.min.js', { method: 'HEAD' });
  check('/vendor/ 可访问（分享页要靠它渲染）', vendorRes.status, 200);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(failures === 0 ? '总计 全部通过' : `总计 ${failures} 项未通过`);
  if (failures > 0) process.exit(1);
})();
