// Markdown 导出 PDF
//
// 之前 md 文件的「导出 PDF」按钮是直接 disabled 的。现在走同一套 Chromium 管线：
// 先把 md 渲染成打印版 HTML 落到临时目录，再交给 pdf-export。
//
// 本 spec 检查：
//   ① 打印版 HTML 的形态（不带目录侧栏 / 复制按钮 / hover 锚点，配色钉回浅色，
//      base href 指向 md 原目录的 file:// 以便相对图片可用）
//   ② 顶栏按钮对 md 文件不再 disabled
//   ③ 端到端导出：真的在 Downloads 里产出一个非空 PDF（本机没有 Chromium 时跳过）
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');
const markdown = require(path.join(ROOT, 'public/vendor/markdown.js'));
const pdfExport = require(path.join(ROOT, 'lib/pdf-export.js'));

const MD = [
  '# 导出测试',
  '',
  '## 第一节',
  '',
  '正文一段，带一个[外链](https://example.com)。',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '| 左 | 右 |',
  '|:---|---:|',
  '| a | b |',
].join('\n');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

(async () => {
  // ---- ① 打印版 HTML 形态（纯函数，不需要起服务）----
  console.log('\n[打印版 HTML]');
  const printHtml = markdown.renderPage(MD, {
    title: 'note.md',
    baseHref: 'file:///tmp/docs/',
    forPrint: true,
  });
  // 注意：只能断言"DOM 里没有这些元素"，不能断言字符串里不出现这些名字——
  // markdownCss 本身带着 .md-code-copy / .md-anchor 的样式规则
  check('不含目录侧栏元素', /class="md-toc/.test(printHtml), false);
  check('完全不带 <script>（复制按钮靠 enhanceScript 注入，打印版不注入）',
    /<script/.test(printHtml), false);
  check('不含标题 hover 锚点元素', /class="md-anchor"/.test(printHtml), false);
  check('注入了 base href', /<base href="file:\/\/\/tmp\/docs\/"/.test(printHtml), true);
  check('声明 color-scheme 为 light', /content="light"/.test(printHtml), true);
  check('把配色变量钉回浅色', /--md-fg:#24292f/.test(printHtml.split('@media (prefers-color-scheme: dark)').pop()), true);
  check('带 @page 页边距', /@page\{margin:16mm 14mm;\}/.test(printHtml), true);
  check('正文内容在里面', /导出测试/.test(printHtml), true);
  check('表格对齐保留', /text-align:right/.test(printHtml), true);
  check('外链在纸上打印出地址', /a\[href\^="http"\]::after/.test(printHtml), true);

  // dirFileUrl 行为
  console.log('\n[file:// base 计算]');
  check('目录 URL 以 / 结尾', pdfExport.dirFileUrl('/tmp/docs').endsWith('/'), true);
  check('含空格的目录被正确编码',
    pdfExport.dirFileUrl('/tmp/my docs'), 'file:///tmp/my%20docs/');

  // ---- ② 按钮可用性 ----
  // 前缀不能用 atlas-mdpdf-：server 渲染 md 的临时目录就是这个前缀，
  // 下面要断言那类目录已被清理，撞前缀会误报
  const atlas = await startAtlas({
    prefix: 'atlas-pdfspec-',
    files: { 'proj/note.md': MD, 'proj/page.html': '<!doctype html><html><body><h1>x</h1></body></html>' },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  console.log('\n[顶栏按钮]');
  await page.click('.file[data-doctype="md"] .file-name');
  await page.waitForTimeout(900);
  check('选中 md 文件后「导出 PDF」可用',
    await page.evaluate(() => document.getElementById('btn-export-pdf').disabled), false);
  check('按钮提示文案不再说"仅支持 HTML"',
    await page.evaluate(() => document.getElementById('btn-export-pdf').title),
    '导出为 PDF 保存到 Downloads');

  // ---- ③ 端到端导出 ----
  console.log('\n[端到端导出]');
  const hasChromium = !!pdfExport.findChromium();
  if (!hasChromium) {
    console.log('  - 本机未检测到 Chromium 系浏览器，跳过端到端导出');
  } else {
    const before = new Set(fs.existsSync(pdfExport.downloadsDir())
      ? fs.readdirSync(pdfExport.downloadsDir()) : []);
    const result = await page.evaluate(async () => {
      const p = document.querySelector('.file[data-doctype="md"]').dataset.path;
      const resp = await fetch('/api/export-pdf', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p, fileName: 'atlas-md-pdf-spec' }),
      });
      const text = await resp.text();
      const events = text.split('\n\n')
        .map(b => { const m = b.match(/^data:\s*(.+)$/m); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } })
        .filter(Boolean);
      return events;
    });
    const last = result[result.length - 1];
    check('SSE 最后一个事件是 done', last && last.phase, 'done');
    if (last && last.phase === 'done') {
      check('产出的 PDF 存在', fs.existsSync(last.savedPath), true);
      check('PDF 非空', last.size > 1000, true);
      check('文件名用了传入的 stem', path.basename(last.savedPath).startsWith('atlas-md-pdf-spec'), true);
      // 清理：只删本次新产生的文件
      try { fs.unlinkSync(last.savedPath); } catch {}
    } else {
      console.log('    导出事件流：' + JSON.stringify(result));
    }
    const after = new Set(fs.existsSync(pdfExport.downloadsDir())
      ? fs.readdirSync(pdfExport.downloadsDir()) : []);
    const leftover = [...after].filter(f => !before.has(f));
    check('没有残留临时文件在 Downloads', leftover, []);
    // 临时渲染目录必须被清掉。清理发生在 res.end() 之后的 finally 里（异步 rm），
    // 所以要轮询一下，不能读完响应就立刻断言。
    let strays = [];
    for (let i = 0; i < 20; i++) {
      strays = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('atlas-mdpdf-'));
      if (!strays.length) break;
      await new Promise(r => setTimeout(r, 100));
    }
    check('临时渲染目录已清理', strays, []);
  }

  // 不支持的类型仍然被拒
  console.log('\n[非法输入]');
  const bad = await page.evaluate(async () => {
    const resp = await fetch('/api/export-pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd', fileName: 'x' }),
    });
    const text = await resp.text();
    const m = text.match(/^data:\s*(.+)$/m);
    return m ? JSON.parse(m[1]) : null;
  });
  check('扫描根外的路径被拒', bad && bad.reason, 'invalid-path');

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
