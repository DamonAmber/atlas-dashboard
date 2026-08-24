// 弹窗关闭路径
//
// 0.8.0 的回归：为了让屏幕阅读器不去读 emoji/符号本身，✕ 按钮的图标被包进了
// <span aria-hidden="true">，但关闭判断写的是 `e.target.dataset.close !== undefined`
// —— 点在 ✕ 上时 e.target 是那个 span（没有 data-close），判断失效，按钮点了没反应。
// 分享弹窗和设置弹窗都中招。
//
// 本 spec 把每个弹窗的每条关闭路径都钉住：✕ 按钮（含点在图标上）、遮罩、Esc。
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

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-modalclose-',
    scanRootCount: 2,
    files: {
      'proj/page.html': '<!doctype html><html><body><h1>x</h1></body></html>',
      'proj/note.md': '# 标题\n\n正文。\n',
    },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  const openShare = async () => {
    await page.hover('.file[data-path$="page.html"]');
    await page.click('.file[data-path$="page.html"] [data-act="share"]');
    await page.waitForSelector('#share-modal:not(.hidden)');
  };
  const openSettings = async () => {
    await page.click('#btn-settings');
    await page.waitForSelector('#settings-modal:not(.hidden)');
  };

  // ---- 分享弹窗 ----
  console.log('\n[分享弹窗的关闭路径]');

  // 首次分享（这是用户报告的场景）：点 ✕ 上的图标
  await openShare();
  check('首次分享：弹窗打开', await page.isVisible('#share-modal'), true);
  // 精确点在图标本身上（现在是 <svg class="ico">，不再是 <span>），模拟真实点击落点。
  // 这一条守的是 v0.8.1 那个 P0：事件目标落在按钮的子元素上时也必须能关闭。
  await page.click('#share-modal .modal-close .ico');
  await page.waitForTimeout(250);
  check('首次分享：点 ✕ 的图标能关闭', await page.isHidden('#share-modal'), true);

  // 再次打开，点按钮本体（非图标区域）
  await openShare();
  await page.click('#share-modal .modal-close');
  await page.waitForTimeout(250);
  check('点 ✕ 按钮本体能关闭', await page.isHidden('#share-modal'), true);

  // 遮罩
  await openShare();
  await page.click('#share-modal .modal-backdrop', { position: { x: 5, y: 5 } });
  await page.waitForTimeout(250);
  check('点遮罩能关闭', await page.isHidden('#share-modal'), true);

  // Esc
  await openShare();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('按 Esc 能关闭', await page.isHidden('#share-modal'), true);

  // 关闭后能重新打开（状态没被卡住）
  await openShare();
  check('关闭后能再次打开', await page.isVisible('#share-modal'), true);
  await page.click('#share-modal .modal-close .ico');
  await page.waitForTimeout(250);
  check('再次关闭仍然有效', await page.isHidden('#share-modal'), true);

  // 焦点归还（弹窗栈的行为不能因为这次修复被破坏）
  await openShare();
  await page.click('#share-modal .modal-close .ico');
  await page.waitForTimeout(300);
  const focusBack = await page.evaluate(() => {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('.file[data-path$="page.html"]'));
  });
  check('关闭后焦点还给触发它的按钮', focusBack, true);

  // ---- 设置弹窗（同一个 bug，用户没提到但一并钉住）----
  console.log('\n[设置弹窗的关闭路径]');
  await openSettings();
  await page.click('#settings-modal .modal-close .ico');
  await page.waitForTimeout(250);
  check('点 ✕ 的图标能关闭', await page.isHidden('#settings-modal'), true);

  await openSettings();
  await page.click('#settings-modal .modal-close');
  await page.waitForTimeout(250);
  check('点 ✕ 按钮本体能关闭', await page.isHidden('#settings-modal'), true);

  await openSettings();
  await page.click('#settings-modal .modal-backdrop', { position: { x: 5, y: 5 } });
  await page.waitForTimeout(250);
  check('点遮罩能关闭', await page.isHidden('#settings-modal'), true);

  await openSettings();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('按 Esc 能关闭', await page.isHidden('#settings-modal'), true);

  check('关闭后焦点还给设置按钮',
    await page.evaluate(() => document.activeElement.id), 'btn-settings');

  // 弹窗内部的点击不该误关（比如点标题、点 section）
  await openSettings();
  await page.click('#settings-modal .modal-header h2');
  await page.waitForTimeout(200);
  check('点弹窗内的标题不会误关', await page.isVisible('#settings-modal'), true);
  await page.click('#settings-modal .modal-panel .modal-section h3');
  await page.waitForTimeout(200);
  check('点弹窗内的小标题不会误关', await page.isVisible('#settings-modal'), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ---- 快速打开面板 ----
  console.log('\n[⌘K 面板的关闭路径]');
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('#quickopen:not(.hidden)');
  await page.click('#quickopen .modal-backdrop', { position: { x: 5, y: 5 } });
  await page.waitForTimeout(250);
  check('点遮罩能关闭', await page.isHidden('#quickopen'), true);
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('#quickopen:not(.hidden)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('按 Esc 能关闭', await page.isHidden('#quickopen'), true);

  // ---- 应用内确认框 ----
  console.log('\n[确认框的关闭路径]');
  await page.click('#btn-mark-all');
  await page.waitForSelector('.atlas-dialog');
  await page.click('.atlas-dialog .dialog-cancel');
  await page.waitForTimeout(250);
  check('点「取消」能关闭', await page.$('.atlas-dialog'), null);

  await page.click('#btn-mark-all');
  await page.waitForSelector('.atlas-dialog');
  await page.click('.atlas-dialog .modal-backdrop', { position: { x: 5, y: 5 } });
  await page.waitForTimeout(250);
  check('点遮罩能关闭', await page.$('.atlas-dialog'), null);

  await page.click('#btn-mark-all');
  await page.waitForSelector('.atlas-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('按 Esc 能关闭', await page.$('.atlas-dialog'), null);

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
