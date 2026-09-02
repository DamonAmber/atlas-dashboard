// 文档内查找 & 就地退出搜索
//
// 覆盖两件事：
//   A. ⌘K 正文命中打开文档后，高亮/命中条能"就地退出"——顶栏命中条的 ✕、
//      以及 Esc（先清文档内高亮、不离开文档，再按一次才回首页）。
//      这是"⌘K 搜索一旦搜索就退不出"的修复。
//   B. ⌘F 文档内查找栏：输入即高亮、显示 n/m、Enter/↑↓ 跳转、Esc 关闭并清高亮。
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

// 文件名不含 widget，正文含多处 widget —— 保证 ⌘K 命中走"正文命中"而非文件名
const body = '<p>the widget report. widget here. another widget line.</p>'.repeat(6);

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-find-',
    files: {
      'proj/quarterly.html': `<!doctype html><html><head><title>Quarterly</title></head><body><h1>Quarterly</h1>${body}</body></html>`,
      'proj/other.md': '# 其它\n\n无关正文。\n',
    },
    config: { trustAllHtml: true },   // 同源才能读 iframe 里的高亮 mark
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  const marks = () => page.evaluate(() => {
    const d = document.getElementById('preview') && document.getElementById('preview').contentDocument;
    return d ? d.querySelectorAll('mark[data-atlas-hl]').length : -1;
  });
  const badgeHidden = () => page.evaluate(() => document.getElementById('match-badge').classList.contains('hidden'));
  const findHidden = () => page.evaluate(() => document.getElementById('find-bar').classList.contains('hidden'));
  const findCount = () => page.evaluate(() => document.getElementById('find-count').textContent);
  const activePath = () => page.evaluate(() => window.__ap || null);
  const emptyHidden = () => page.evaluate(() => document.getElementById('empty-state').classList.contains('hidden'));
  // 暴露 activeFilePath 供断言（避免依赖内部变量名，读 crumbs 里的文件名更稳）
  const crumbName = () => page.evaluate(() => {
    const el = document.querySelector('#crumbs .crumb-name, #crumbs .crumb-alias');
    return el ? el.textContent : null;
  });

  // ================================================================
  console.log('\n[A. ⌘K 正文命中后 → 命中条 ✕ 就地清除]');
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('#quickopen:not(.hidden)');
  await page.fill('#quickopen-input', 'widget');
  await page.waitForTimeout(700);            // 等正文搜索
  await page.keyboard.press('Enter');        // 打开第一条（正文命中 quarterly）
  await page.waitForTimeout(1600);
  check('打开的是 quarterly', await crumbName(), 'quarterly.html');
  check('预览里出现高亮', (await marks()) >= 2, true);
  check('顶栏命中条出现', await badgeHidden(), false);
  // 点 ✕ 就地清除
  await page.click('#match-close');
  await page.waitForTimeout(300);
  check('✕ 后高亮清空', await marks(), 0);
  check('✕ 后命中条隐藏', await badgeHidden(), true);
  check('✕ 后仍停在 quarterly（没被弹回首页）', await crumbName(), 'quarterly.html');
  check('✕ 后仍在文档态（首页隐藏）', await emptyHidden(), true);

  // ================================================================
  console.log('\n[A2. Esc 先清高亮、再回首页（两级）]');
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('#quickopen:not(.hidden)');
  await page.fill('#quickopen-input', 'widget');
  await page.waitForTimeout(700);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1600);
  check('再次出现高亮', (await marks()) >= 2, true);
  await page.keyboard.press('Escape');       // 第一次 Esc：清高亮，不离开
  await page.waitForTimeout(300);
  check('Esc①清掉高亮', await marks(), 0);
  check('Esc①仍停在文档', await emptyHidden(), true);
  await page.keyboard.press('Escape');       // 第二次 Esc：回首页
  await page.waitForTimeout(400);
  check('Esc②回到首页', await emptyHidden(), false);

  // ================================================================
  console.log('\n[B. ⌘F 文档内查找栏]');
  await page.click('.file[data-path$="quarterly.html"] .file-name');
  await page.waitForTimeout(1400);
  check('查找栏初始隐藏', await findHidden(), true);
  await page.keyboard.press('Meta+f');
  await page.waitForTimeout(250);
  check('⌘F 打开查找栏', await findHidden(), false);
  check('焦点落在查找输入框', await page.evaluate(() => document.activeElement.id), 'find-input');
  await page.fill('#find-input', 'widget');
  await page.waitForTimeout(400);
  check('查找命中并高亮', (await marks()) >= 2, true);
  check('查找栏显示 1/N', /^1\/\d+$/.test(await findCount()), true);
  check('查找打开时顶栏命中条让位（隐藏）', await badgeHidden(), true);
  // Enter 跳到下一处
  await page.focus('#find-input');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  check('Enter 跳到第 2 处', /^2\/\d+$/.test(await findCount()), true);
  // Esc 关闭并清高亮
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc 关闭查找栏', await findHidden(), true);
  check('关闭后高亮清空', await marks(), 0);
  check('关闭后仍停在文档', await emptyHidden(), true);

  // ================================================================
  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
