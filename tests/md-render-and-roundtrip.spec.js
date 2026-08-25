// Markdown 渲染与往返保真
//
// 覆盖四组回归：
//   ① 只读预览页渲染 —— <base href>（相对图片能加载）、front matter 不再渲染成
//      「hr + 乱码段落」、正文锚点链接不再新开标签页、GFM 任务列表复选框、
//      代码块语言标签 + 复制按钮、标题 hover 锚点、宽表格横向滚动、深色模式
//   ② 表格结构 —— 表头必须和数据列对齐（<th> 的浏览器默认值是 center 而 <td>
//      是 left，不显式声明的话每张表的表头都是歪的）、宽表要真的溢出并出现
//      「右边还有内容」的提示（曾经因为 table 上写了 max-width:100%，宽表永远
//      不溢出，浏览器只能把中文压成一列一个字的竖排）
//   ③ GFM alert（> [!NOTE] 这类）—— 渲染成带类型的提示块，且在预览里改过它
//      之后回写的源码仍然是 `> [!NOTE]`，不能退化成一行中文
//   ④ 所见即所得编辑的反解析保真 —— 在预览里改一个标题，回写的源码除了那一行
//      必须逐字节不变：表格对齐（:---:）、段落软换行、front matter、任务列表
//      语法、代码块、块间距都不能被顺手改掉（否则 git 里全是无意义 diff）
//   ⑤ 阅读宽度三档切换 —— 点一下就换档、记在 localStorage 跨文档保持
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
  // 表头不写对齐语法：正是「<th> 默认居中、<td> 默认左对齐」会露馅的那种表
  '| 名称 | 说明 |',
  '|------|------|',
  '| alpha | 一段稍长的说明文字，用来把这一列撑开 |',
  '',
  // 12 列宽表：必须溢出并出现横向滚动提示，而不是被压成竖排
  '| 指标 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 归因说明 |',
  '|------|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|------|',
  '| 启动次数 | 128,304 | 133,900 | 141,220 | 139,880 | 152,301 | 160,442 | 158,900 | 171,220 | 180,110 | 191,400 | 新机型首发带量 |',
  '',
  '> [!WARNING]',
  '> 这一步不可逆。',
  '',
  '> [!TIP] 同一行写法也要认出来',
  '',
  '> 普通引用不该被当成 alert。',
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
  check('每张表格都套了横向滚动层', inIframe.tableScrollWrap, 3);
  check('表格居中对齐已渲染', inIframe.tableAlignPreserved, true);

  // ---- 表格结构 ----
  const tables = await page.evaluate(() => {
    const d = document.getElementById('preview').contentDocument;
    const cellLeft = (el) => Math.round(el.getBoundingClientRect().left);
    const plain = d.querySelectorAll('.md-body table')[1];   // 没写对齐语法的那张
    const wide = d.querySelectorAll('.md-body table')[2];    // 12 列宽表
    const wideWrap = wide.closest('.md-table-scroll');
    const wideBlock = wide.closest('.md-table-block');
    return {
      // 表头文字的左边缘要和它那一列数据的左边缘对齐
      headAlignedWithBody: [0, 1].every((i) => {
        const th = plain.querySelectorAll('thead th')[i];
        const td = plain.querySelectorAll('tbody tr td')[i];
        return Math.abs(cellLeft(th) - cellLeft(td)) <= 1;
      }),
      thTextAlign: getComputedStyle(plain.querySelector('thead th')).textAlign,
      // 写了 ---: 的列仍然右对齐（单元格自带的 style 优先级更高）
      alignedColStillRight: getComputedStyle(wide.querySelectorAll('thead th')[1]).textAlign,
      wideOverflows: wideWrap.scrollWidth > wideWrap.clientWidth + 2,
      wideHasScrollHint: wideBlock.classList.contains('md-can-scroll-right'),
      // 竖排回归的探针：把中文压成一列一个字时，表头行会高得离谱
      wideHeadHeight: Math.round(wide.querySelector('thead tr').getBoundingClientRect().height),
      zebra: getComputedStyle(wide.querySelector('tbody tr td')).backgroundColor,
    };
  });
  console.log('\n[表格结构]');
  check('表头和数据列左边缘对齐', tables.headAlignedWithBody, true);
  check('表头默认左对齐（不再是浏览器默认的居中）', tables.thTextAlign, 'left');
  check('写了 ---: 的列仍然右对齐', tables.alignedColStillRight, 'right');
  check('12 列宽表真的溢出容器', tables.wideOverflows, true);
  check('溢出时出现「右边还有内容」提示', tables.wideHasScrollHint, true);
  check('宽表表头没有被压成竖排（行高在一行的量级）', tables.wideHeadHeight < 60, true);

  // ---- GFM alert ----
  const alerts = await page.evaluate(() => {
    const d = document.getElementById('preview').contentDocument;
    return {
      list: [...d.querySelectorAll('.md-alert')].map(a => ({
        type: a.getAttribute('data-md-alert'),
        title: (a.querySelector('.md-alert-title span') || {}).textContent,
        hasIcon: !!a.querySelector('.md-alert-title svg'),
        body: (a.querySelector('p:not(.md-alert-title)') || {}).textContent,
      })),
      plainQuotes: d.querySelectorAll('.md-body blockquote:not(.md-alert)').length,
      literalMarker: /\[!WARNING\]/.test(d.querySelector('.md-alert-warning').textContent),
    };
  });
  console.log('\n[GFM alert]');
  check('[!WARNING] 渲染成 warning 提示块',
    alerts.list[0], { type: 'warning', title: '注意', hasIcon: true, body: '这一步不可逆。' });
  check('[!TIP] 同行写法也认',
    alerts.list[1], { type: 'tip', title: '提示', hasIcon: true, body: '同一行写法也要认出来' });
  check('提示块里不再残留 [!WARNING] 字面量', alerts.literalMarker, false);
  check('普通引用不受影响', alerts.plainQuotes, 1);

  // ---- 阅读宽度三档 ----
  console.log('\n[阅读宽度]');
  const widthOf = () => page.evaluate(() => {
    const d = document.getElementById('preview').contentDocument;
    return {
      mode: d.documentElement.getAttribute('data-read-width'),
      innerW: Math.round(d.querySelector('.md-inner').getBoundingClientRect().width),
      contentW: Math.round(d.querySelector('.md-content').getBoundingClientRect().width),
      stored: d.defaultView.localStorage.getItem('atlas:mdReadWidth'),
      pressed: [...d.querySelectorAll('.md-width-switch button')]
        .filter(b => b.getAttribute('aria-pressed') === 'true')
        .map(b => b.getAttribute('data-w')),
    };
  });
  const pickWidth = (w) => page.evaluate((mode) => {
    const d = document.getElementById('preview').contentDocument;
    d.querySelector(`.md-width-switch button[data-w="${mode}"]`).click();
  }, w);

  const w0 = await widthOf();
  check('默认是推荐宽度（820 - 左右 padding）', w0.innerW, 820);
  check('默认档按钮处于按下态', w0.pressed, ['comfortable']);
  await pickWidth('wide');
  await page.waitForTimeout(260);
  const w1 = await widthOf();
  check('切到「加宽」后正文变宽', w1.innerW > w0.innerW, true);
  check('加宽档写进 localStorage', w1.stored, 'wide');
  await pickWidth('full');
  await page.waitForTimeout(260);
  const w2 = await widthOf();
  // 用「占满可用宽度」而不是「比上一档更宽」来断言：iframe 在这个视口下未必比
  // 1120px 宽，比大小会随视口飘，占满与否才是这一档真正的语义
  check('切到「占满全屏」后正文铺满可用宽度', w2.innerW, w2.contentW);
  check('全屏档只有它一个是按下态', w2.pressed, ['full']);
  // 换一篇文档（这里就是重载同一篇）后档位要还在——这才叫"记住了"
  await page.evaluate(() => { document.getElementById('preview').contentWindow.location.reload(); });
  await page.waitForTimeout(900);
  const w3 = await widthOf();
  check('重载后档位保持', w3.mode, 'full');
  check('重载后按钮态也跟着恢复', w3.pressed, ['full']);
  await pickWidth('comfortable');
  await page.waitForTimeout(260);
  check('能切回推荐宽度', (await widthOf()).innerW, 820);

  // [ / ] 逐档切换（焦点在预览文档里按）
  const pressInPreview = (key) => page.evaluate((k) => {
    const d = document.getElementById('preview').contentDocument;
    d.dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true }));
  }, key);
  await pressInPreview(']');
  await page.waitForTimeout(260);
  check('按 ] 放宽一档', (await widthOf()).mode, 'wide');
  await pressInPreview(']');
  await page.waitForTimeout(260);
  check('再按 ] 到全屏档', (await widthOf()).mode, 'full');
  await pressInPreview(']');
  await page.waitForTimeout(200);
  check('已是最宽档，再按 ] 不越界', (await widthOf()).mode, 'full');
  await pressInPreview('[');
  await pressInPreview('[');
  await page.waitForTimeout(300);
  check('按两次 [ 回到推荐宽度', (await widthOf()).mode, 'comfortable');
  await pressInPreview('[');
  await page.waitForTimeout(200);
  check('已是最窄档，再按 [ 不越界', (await widthOf()).mode, 'comfortable');

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
  check('alert 语法保留', /> \[!WARNING\]\n> 这一步不可逆。/.test(rt), true);
  // 唯一的规范化：文件末尾补一个换行符（POSIX 习惯，只在首次保存产生 1 行 diff）
  const onlyH1Changed = rt === original.replace('# 标题一', '# 标题一改了') + '\n';
  check('除了被改的标题，全文逐字节不变', onlyH1Changed, true);
  if (!onlyH1Changed) {
    console.log('  --- 原始 ---\n' + JSON.stringify(original));
    console.log('  --- 回写 ---\n' + JSON.stringify(rt));
  }

  // 真的去改 alert 的正文：这时它不能走"原样吐回"的快路径，必须靠序列化
  // 把「注意」这个装饰标题还原成 [!WARNING]，否则提示块类型会悄悄消失
  await page.evaluate(() => {
    const pv = document.getElementById('md-preview');
    const p = pv.querySelector('.md-alert-warning p:not(.md-alert-title)');
    const r = document.createRange(); r.selectNodeContents(p);
    const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
    pv.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));
    p.textContent = '这一步不可逆（改过）。';
    pv.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  const rtAlert = await page.inputValue('#md-source');
  check('改过 alert 正文后，类型标记仍是 [!WARNING]',
    /> \[!WARNING\]\n> 这一步不可逆（改过）。/.test(rtAlert), true);
  check('装饰用的「注意」二字没有被写进源码', /^> 注意$/m.test(rtAlert), false);
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
