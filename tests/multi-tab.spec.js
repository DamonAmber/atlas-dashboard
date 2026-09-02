// 多 Tab 文档浏览
//
// 动机：过去只能同时看一篇文档——打开第二篇会顶掉第一篇。现在每篇文档在自己的
// 常驻 iframe 里，用顶部标签栏切换，切换不重载（滚动位置与页面内部状态都留得住）。
//
// 本 spec 钉住：
//   ① 打开多篇 → 标签栏出现、每篇一枚标签、活动标签正确、每个 Tab 一个常驻帧、
//      只有活动帧可见、活动帧独占 id="preview"（兼容层）
//   ② 已打开的文件再点一次 → 不新建标签，切回原标签
//   ③ 切换标签保留滚动位置（切走再切回，滚动条还在原处）——多 Tab 的核心价值
//   ④ 关闭标签：关非活动的不换视图；关活动的自动切到邻居；关到最后一个回首页
//   ⑤ 键盘：Ctrl+Tab 前后切、⌘数字 跳转
//   ⑥ 持久化：刷新页面后标签与活动项都恢复
//   ⑦ 全程无 JS 报错
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

const longBody = '<p>填充行，让文档足够长以出现滚动条。lorem ipsum 内容 数据。</p>\n'.repeat(200);
function htmlDoc(title) {
  return `<!doctype html><html><head><title>${title}</title></head><body>`
    + `<h1>${title}</h1>${longBody}</body></html>`;
}

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-multitab-',
    files: {
      'proj/alpha.html': htmlDoc('Alpha'),
      'proj/bravo.html': htmlDoc('Bravo'),
      'proj/charlie.html': htmlDoc('Charlie'),
      'proj/delta.md': '# Delta\n\n正文。\n',
    },
    // 读取 iframe 内滚动位置需要同源；HTML 默认沙箱，这里显式信任（沙箱本身另有 spec 覆盖）
    config: { trustAllHtml: true },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  const openFile = async (suffix) => {
    await page.click(`.file[data-path$="${suffix}"] .file-name`);
    await page.waitForTimeout(1000);
  };
  const tabState = () => page.evaluate(() => {
    const bar = document.getElementById('tab-bar');
    const tabs = [...bar.querySelectorAll('.tab')];
    const frames = [...document.querySelectorAll('.preview .preview-frame')];
    const activeFrame = document.getElementById('preview');
    return {
      barHidden: bar.classList.contains('hidden'),
      tabCount: tabs.length,
      names: tabs.map(t => t.querySelector('.tab-name').textContent),
      activeName: (bar.querySelector('.tab.active .tab-name') || {}).textContent || null,
      frameCount: frames.length,
      visibleFrames: frames.filter(f => !f.classList.contains('hidden')).length,
      // 活动帧独占 id="preview"，且它就是那个可见的帧
      activeFrameIsVisible: !!activeFrame && !activeFrame.classList.contains('hidden'),
      idPreviewCount: document.querySelectorAll('.preview-frame#preview, iframe#preview').length,
      emptyHidden: document.getElementById('empty-state').classList.contains('hidden'),
    };
  });

  // ================================================================
  console.log('\n[打开多篇] 标签栏出现，每篇一枚标签');
  check('初始首页态：标签栏隐藏', (await tabState()).barHidden, true);
  await openFile('alpha.html');
  await openFile('bravo.html');
  await openFile('charlie.html');
  let s = await tabState();
  check('标签栏出现', s.barHidden, false);
  check('三枚标签', s.tabCount, 3);
  check('标签名依打开顺序', s.names, ['alpha.html', 'bravo.html', 'charlie.html']);
  check('活动标签是最后打开的 charlie', s.activeName, 'charlie.html');
  check('每个 Tab 一个常驻帧（3 个）', s.frameCount, 3);
  check('只有活动帧可见', s.visibleFrames, 1);
  check('活动帧可见且独占 id=preview', s.activeFrameIsVisible, true);
  check('id=preview 全局唯一', s.idPreviewCount, 1);
  check('首页已隐藏', s.emptyHidden, true);

  // ================================================================
  console.log('\n[去重] 已打开的文件再点一次不新建标签');
  await openFile('alpha.html');
  s = await tabState();
  check('仍是三枚标签', s.tabCount, 3);
  check('切回 alpha', s.activeName, 'alpha.html');

  // ================================================================
  console.log('\n[切换保留滚动] 切走再切回，滚动位置还在');
  // 在 alpha 帧里滚动
  await page.evaluate(() => {
    const w = document.getElementById('preview').contentWindow;
    w.scrollTo(0, 800);
  });
  await page.waitForTimeout(200);
  const alphaScroll = await page.evaluate(() => document.getElementById('preview').contentWindow.scrollY);
  check('alpha 已滚动到约 800', alphaScroll > 400, true);
  // 切到 bravo 再切回 alpha
  await page.click('.tab:nth-child(2)');   // bravo
  await page.waitForTimeout(400);
  await page.click('.tab:nth-child(1)');   // alpha
  await page.waitForTimeout(400);
  const alphaScrollBack = await page.evaluate(() => document.getElementById('preview').contentWindow.scrollY);
  check('切回 alpha 后滚动位置保留（未重载归零）', Math.abs(alphaScrollBack - alphaScroll) < 30, true);

  // ================================================================
  console.log('\n[键盘] Ctrl+Tab 切换、⌘数字跳转');
  await page.keyboard.press('Control+Tab');   // alpha(0) → bravo(1)
  await page.waitForTimeout(300);
  check('Ctrl+Tab 切到后一个 bravo', (await tabState()).activeName, 'bravo.html');
  await page.keyboard.press('Control+Shift+Tab');   // 回到 alpha
  await page.waitForTimeout(300);
  check('Ctrl+Shift+Tab 切回前一个 alpha', (await tabState()).activeName, 'alpha.html');
  await page.keyboard.press('Meta+3');   // 跳到第 3 个 charlie
  await page.waitForTimeout(300);
  check('⌘3 跳到第三个 charlie', (await tabState()).activeName, 'charlie.html');

  // ================================================================
  console.log('\n[关闭] 关非活动的不换视图；关活动的切到邻居');
  // 当前活动 charlie(idx2)。关闭 alpha(idx0，非活动)
  await page.click('.tab:nth-child(1) .tab-close');
  await page.waitForTimeout(400);
  s = await tabState();
  check('关掉一枚后剩两枚', s.tabCount, 2);
  check('剩下 bravo / charlie', s.names, ['bravo.html', 'charlie.html']);
  check('活动项不变（仍是 charlie）', s.activeName, 'charlie.html');
  check('帧也回收到 2 个', s.frameCount, 2);
  // 关闭活动的 charlie（现在 idx1）→ 应切到邻居 bravo
  await page.click('.tab:nth-child(2) .tab-close');
  await page.waitForTimeout(400);
  s = await tabState();
  check('关活动标签后剩一枚', s.tabCount, 1);
  check('自动切到邻居 bravo', s.activeName, 'bravo.html');

  // ================================================================
  console.log('\n[持久化] 刷新后恢复标签与活动项');
  await openFile('delta.md');   // 再开一篇，凑两枚：bravo + delta，活动 delta
  await page.waitForTimeout(300);
  check('刷新前两枚标签', (await tabState()).tabCount, 2);
  await page.reload();
  await page.waitForSelector('#tab-bar:not(.hidden) .tab');
  await page.waitForTimeout(1200);
  s = await tabState();
  check('刷新后标签恢复（两枚）', s.tabCount, 2);
  check('刷新后标签名恢复', s.names, ['bravo.html', 'delta.md']);
  check('刷新后活动项恢复为 delta', s.activeName, 'delta.md');

  // ================================================================
  console.log('\n[关到最后一个] 回首页');
  await page.click('.tab:nth-child(2) .tab-close');   // 关 delta（活动）→ 切到 bravo
  await page.waitForTimeout(400);
  await page.click('.tab:nth-child(1) .tab-close');   // 关 bravo（最后一枚）→ 回首页
  await page.waitForTimeout(500);
  s = await tabState();
  check('全部关闭后标签栏隐藏', s.barHidden, true);
  check('没有标签了', s.tabCount, 0);
  check('回到首页（empty-state 可见）', s.emptyHidden, false);

  // ================================================================
  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
