// Markdown 渲染与往返保真
//
// 覆盖两组回归：
//   ① 只读预览页渲染 —— <base href>（相对图片能加载）、front matter 不再渲染成
//      「hr + 乱码段落」、正文锚点链接不再新开标签页、GFM 任务列表复选框、
//      代码块语言标签 + 复制按钮、标题 hover 锚点、宽表格横向滚动、深色模式
//   ② 所见即所得编辑的反解析保真 —— 在预览里改一个标题，回写的源码除了那一行
//      必须逐字节不变：表格对齐（:---:）、段落软换行、front matter、任务列表
//      语法、代码块、块间距都不能被顺手改掉（否则 git 里全是无意义 diff）
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

const MD = [
  '---',
  'title: 探针报告',
  'author: ai',
  '---',
  '',
  '# 标题一',
  '',
  '看图：![架构图](./assets/pic.png)',
  '',
  '跳转到 [第二节](#第二节)，外链 [示例](https://example.com)。',
  '',
  '| 左 | 中 | 右 |',
  '|:---|:--:|---:|',
  '| a | b | c |',
  '',
  '- [ ] 待办一',
  '- [x] 已完成',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '## 第二节',
  '这是一段中文，源码里做了软换行，',
  '所以它在源文件里占了两行。',
].join('\n');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

(async () => {
  // 真实的 1x1 PNG，否则 naturalWidth 永远是 0（是 fixture 的问题，不是产品问题）
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const atlas = await startAtlas({
    prefix: 'atlas-vmd-',
    files: { 'proj/note.md': MD, 'proj/assets/pic.png': PNG_1x1 },
  });
  const browser = await chromium.launch();

  // ---- 浅色 ----
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const bad404 = [];
  page.on('response', r => { if (r.status() === 404) bad404.push(r.url()); });
  await page.goto(atlas.base);
  await page.waitForSelector('.file');
  await page.click('.file[data-doctype="md"] .file-name');
  await page.waitForTimeout(1200);

  const inIframe = await page.evaluate(() => {
    const d = document.getElementById('preview').contentDocument;
    const bodyLink = d.querySelector('.md-body a[href^="#"]');
    const extLink = d.querySelector('.md-body a[href^="https://"]');
    const img = d.querySelector('.md-body img');
    return {
      hasBase: !!d.querySelector('base'),
      baseHref: d.querySelector('base') && d.querySelector('base').getAttribute('href'),
      imgSrc: img && img.src,
      imgLoaded: !!(img && img.naturalWidth > 0),
      frontMatterRows: d.querySelectorAll('.md-frontmatter .md-fm-row').length,
      strayHr: d.querySelectorAll('.md-body > hr').length,
      anchorLinkTarget: bodyLink && bodyLink.getAttribute('target'),
      extLinkTarget: extLink && extLink.getAttribute('target'),
      taskCheckboxes: d.querySelectorAll('input.md-task').length,
      taskChecked: d.querySelectorAll('input.md-task:checked').length,
      copyButtons: d.querySelectorAll('.md-code-copy').length,
      codeLang: d.querySelector('.md-code-lang') && d.querySelector('.md-code-lang').textContent,
      headingAnchors: d.querySelectorAll('.md-body h2 .md-anchor').length,
      tableScrollWrap: d.querySelectorAll('.md-table-scroll').length,
      tableAlignPreserved: !!d.querySelector('.md-body th[style*="center"]'),
    };
  });
  console.log('\n[只读预览页]');
  check('注入了 <base href>', inIframe.hasBase, true);
  check('base 指向 /raw/ 目录', /^\/raw\/0\/proj\/$/.test(inIframe.baseHref || ''), true);
  check('相对图片解析到 /raw/', /\/raw\/0\/proj\/assets\/pic\.png$/.test(inIframe.imgSrc || ''), true);
  check('图片实际加载成功', inIframe.imgLoaded, true);
  check('图片路径不再 404', bad404.filter(u => u.includes('pic.png')).length, 0);
  check('front matter 渲染成元信息行', inIframe.frontMatterRows, 2);
  check('front matter 不再产生游离 <hr>', inIframe.strayHr, 0);
  check('正文锚点链接不加 target', inIframe.anchorLinkTarget, null);
  check('外链仍然新开标签页', inIframe.extLinkTarget, '_blank');
  check('任务列表渲染成复选框', inIframe.taskCheckboxes, 2);
  check('已完成项处于勾选态', inIframe.taskChecked, 1);
  check('代码块有复制按钮', inIframe.copyButtons, 1);
  check('代码块显示语言标签', inIframe.codeLang, 'js');
  check('标题有 hover 锚点', inIframe.headingAnchors, 1);
  check('宽表格套了横向滚动层', inIframe.tableScrollWrap, 1);
  check('表格居中对齐已渲染', inIframe.tableAlignPreserved, true);

  // ---- 代码复制按钮真的能复制 ----
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: atlas.base });
  const copied = await page.evaluate(async () => {
    const d = document.getElementById('preview').contentDocument;
    d.querySelector('.md-code-copy').click();
    await new Promise(r => setTimeout(r, 250));
    return d.querySelector('.md-code-copy').textContent;
  });
  check('点复制按钮后有反馈', copied, '已复制');

  // ---- 反解析保真 ----
  await page.click('#btn-edit');
  await page.waitForSelector('#md-editor:not(.hidden)');
  const original = await page.inputValue('#md-source');
  await page.evaluate(() => {
    const pv = document.getElementById('md-preview');
    const h1 = pv.querySelector('h1');
    h1.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));
    // 模拟真实编辑：选中 h1 再改字
    const r = document.createRange();
    r.selectNodeContents(h1);
    const s = document.getSelection();
    s.removeAllRanges(); s.addRange(r);
    pv.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));
    h1.textContent = '标题一改了';
    pv.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  const rt = await page.inputValue('#md-source');
  console.log('\n[所见即所得编辑 → 反解析]');
  check('标题改动已生效', /^# 标题一改了$/m.test(rt), true);
  check('表格对齐保留', (rt.split('\n').find(l => /^\|\s*:/.test(l)) || '').trim(), '|:---|:--:|---:|');
  check('段落软换行保留（未被压成一行）', /软换行，\n所以它在源文件里占了两行。/.test(rt), true);
  check('front matter 完整保留', /^---\ntitle: 探针报告\nauthor: ai\n---/.test(rt), true);
  check('任务列表语法保留', /- \[ \] 待办一\n- \[x\] 已完成/.test(rt), true);
  check('代码块保留', /```js\nconst a = 1;\n```/.test(rt), true);
  check('块间距保留（标题紧跟正文，未被塞入空行）', /## 第二节\n这是一段中文/.test(rt), true);
  // 唯一的规范化：文件末尾补一个换行符（POSIX 习惯，只在首次保存产生 1 行 diff）
  const onlyH1Changed = rt === original.replace('# 标题一', '# 标题一改了') + '\n';
  check('除了被改的标题，全文逐字节不变', onlyH1Changed, true);
  if (!onlyH1Changed) {
    console.log('  --- 原始 ---\n' + JSON.stringify(original));
    console.log('  --- 回写 ---\n' + JSON.stringify(rt));
  }
  await page.close();

  // ---- 深色模式 ----
  const dark = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });
  await dark.goto(atlas.base);
  await dark.waitForSelector('.file');
  await dark.click('.file[data-doctype="md"] .file-name');
  await dark.waitForTimeout(1200);
  const darkColors = await dark.evaluate(() => {
    const d = document.getElementById('preview').contentDocument;
    const body = d.body;
    const mdBody = d.querySelector('.md-body') || body;
    return {
      pageBg: getComputedStyle(body).backgroundColor,
      textColor: getComputedStyle(mdBody).color,
    };
  });
  console.log('\n[深色模式]');
  const isDarkBg = /rgb\((\d+), (\d+), (\d+)\)/.test(darkColors.pageBg)
    && darkColors.pageBg.match(/\d+/g).slice(0, 3).every(v => +v < 60);
  check('预览页背景是深色（不再是刺眼白板）', isDarkBg, true);
  const isLightText = darkColors.textColor.match(/\d+/g).slice(0, 3).every(v => +v > 150);
  check('正文文字是浅色', isLightText, true);

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
