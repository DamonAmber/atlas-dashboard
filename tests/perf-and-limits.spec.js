// 性能 / 内存边界（回归防线）
//
// 背景：一次 Markdown 渲染正则灾难性递归把服务 OOM 崩了（见 md-fence-infostring.spec）。
// 顺着排查发现两类系统性缺口，这个 spec 把修复钉住：
//   ① 后端渲染链的文件大小闸门 —— md/html 渲染、编辑加载原本没有大小上限
//      （csv/json/txt 有 8MB 上限，md/html 没有，不对称）。超大文件必须降级/拒绝，
//      而不是整份读进来渲染把进程拖垮。
//   ② 前端多 Tab 帧预算 —— 每个已访问 Tab 常驻一个满配 iframe。打开很多篇时
//      最久未用的后台帧要被休眠（卸载文档释放内存），再切回时重载。
//      避免「100 个 Tab = 100 份常驻文档运行时」。
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

// 略大于 8MB 上限的 md（用重复短语堆出来，内容无所谓）
const BIG_MD = '# 巨大文档\n\n' + 'lorem ipsum dolor sit amet 内容 数据 '.repeat(300000); // ~11MB
const SMALL_MD = '# 正常文档\n\n这是一篇正常大小的 Markdown，`code` 和 **粗体**。\n';
const longMd = (n) => `# 文档 ${n}\n\n` + `正文行，够长以出现滚动条。lorem ipsum 内容 数据。\n\n`.repeat(120);

(async () => {
  // 16 篇 md 供多 Tab 帧预算测试（MAX_LIVE_FRAMES=12，必须 > 12 才会触发休眠）
  const docFiles = {};
  for (let i = 1; i <= 16; i++) docFiles[`docs/doc-${String(i).padStart(2, '0')}.md`] = longMd(i);

  const atlas = await startAtlas({
    prefix: 'atlas-perf-',
    files: {
      'big.md': BIG_MD,
      'small.md': SMALL_MD,
      ...docFiles,
    },
  });

  // ================================================================
  // Part 1 — 后端文件大小闸门（HTTP 层，不需要浏览器）
  // ================================================================
  console.log('\n[后端大小闸门]');
  const t0 = Date.now();
  const bigRes = await fetch(`${atlas.base}/api/render-md?path=${encodeURIComponent(atlas.filePath('big.md'))}`);
  const bigHtml = await bigRes.text();
  const bigMs = Date.now() - t0;
  check('超大 md 的 render-md 返回 200（降级页，不是 500/崩溃）', bigRes.status, 200);
  check('超大 md 返回的是"超过预览上限"降级页', /预览上限/.test(bigHtml), true);
  check('降级页很小（没有真去渲染 11MB 正文）', bigHtml.length < 100000, true);
  check('降级快速返回（没有卡在渲染上）', bigMs < 3000, true);

  const smallRes = await fetch(`${atlas.base}/api/render-md?path=${encodeURIComponent(atlas.filePath('small.md'))}`);
  const smallHtml = await smallRes.text();
  check('正常 md 不受闸门影响，正常渲染', smallRes.status === 200 && /<strong>粗体<\/strong>/.test(smallHtml), true);

  const bigSrc = await fetch(`${atlas.base}/api/md-source?path=${encodeURIComponent(atlas.filePath('big.md'))}`);
  check('超大 md 的 md-source 被拒绝（413）', bigSrc.status, 413);
  const smallSrc = await fetch(`${atlas.base}/api/md-source?path=${encodeURIComponent(atlas.filePath('small.md'))}`);
  const smallSrcJson = await smallSrc.json();
  check('正常 md 的 md-source 正常返回内容', smallSrc.status === 200 && smallSrcJson.content.includes('正常大小'), true);

  // 服务在处理完超大文件后仍然健康（没被拖垮）
  const stateRes = await fetch(`${atlas.base}/api/state`);
  check('处理超大文件后服务仍健康', stateRes.status, 200);

  // ================================================================
  // Part 2 — 前端多 Tab 帧预算（LRU 休眠）
  // ================================================================
  console.log('\n[多 Tab 帧预算 · LRU 休眠]');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  // 依次打开全部 16 篇
  for (let i = 1; i <= 16; i++) {
    const suffix = `doc-${String(i).padStart(2, '0')}.md`;
    await page.click(`.file[data-path$="${suffix}"] .file-name`);
    await page.waitForTimeout(250);
  }

  const frameStats = () => page.evaluate(() => {
    const frames = [...document.querySelectorAll('.preview .preview-frame')];
    let live = 0, slept = 0;
    for (const f of frames) {
      const src = f.getAttribute('src') || '';
      if (!src || src === 'about:blank') slept++;
      else live++;
    }
    return { total: frames.length, live, slept, tabs: document.querySelectorAll('#tab-bar .tab').length };
  });

  let fs1 = await frameStats();
  check('16 篇都有标签（Tab 不因休眠消失）', fs1.tabs, 16);
  check('16 个常驻 iframe 都在 DOM 里', fs1.total, 16);
  check('已加载帧数被压在预算内（≤ 12）', fs1.live <= 12, true);
  check('确有后台帧被休眠（释放了内存）', fs1.slept >= 4, true);

  // 切回最早打开、已被休眠的第一个 Tab：应重新加载并显示内容（不是空白）
  await page.click('#tab-bar .tab:nth-child(1)');
  await page.waitForTimeout(1200);
  const revived = await page.evaluate(() => {
    const active = document.getElementById('preview');
    const src = active ? (active.getAttribute('src') || '') : '';
    let bodyText = '';
    try { bodyText = active.contentDocument.body.innerText || ''; } catch {}
    return { srcIsReal: !!src && src !== 'about:blank', hasContent: bodyText.includes('文档 1') };
  });
  check('切回被休眠的 Tab 会重新加载（src 恢复）', revived.srcIsReal, true);
  check('唤醒后的 Tab 正常显示内容（非空白）', revived.hasContent, true);

  check('多 Tab 全程无 JS 报错', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
