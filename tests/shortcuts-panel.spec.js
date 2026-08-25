// 快捷键速查表（? 唤出）
//
// 动机：功能全藏在按钮的 title 提示和 README 里，用户不知道"还能这样用"。
// 首页底部那行提示只在没打开文档时可见；Markdown 编辑器那一整套键
// （⌘B/⌘I/⌘E/⌘K、Tab 缩进、回车续列表）在应用内完全没有出口。
//
// 本 spec 钉住：
//   ① 三个入口都能开：? 键、侧栏底部按钮、首页「全部快捷键」按钮
//   ② 打开文档后仍可查（原来的痛点），焦点在预览 iframe 正文里也能按 ?
//   ③ 清单覆盖各个场景分组，且键位与代码里真实注册的一致（抽查几条）
//   ④ 该让位的让位：在输入框里打 ? 是输入字符，不是开面板
//   ⑤ 弹窗规矩照旧：Esc 关闭、? 再按一次收起、焦点归还触发按钮
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
    prefix: 'atlas-shortcuts-',
    files: {
      'proj/page.html': '<!doctype html><html><body><h1>报告</h1>'
        + '<p>正文段落，用来承载点击落点。</p>'.repeat(20) + '</body></html>',
      'proj/note.md': '# 笔记\n\n正文。\n',
    },
    // "在 iframe 正文里按 ? 也能唤出" 依赖注入到预览文档里的快捷键桥，
    // 而桥需要同源。HTML 预览默认走沙箱，所以这里显式信任
    // （沙箱本身由 rich-and-sandbox.spec 覆盖）
    config: { trustAllHtml: true },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  const isOpen = () => page.evaluate(() =>
    !document.getElementById('shortcuts-modal').classList.contains('hidden'));
  const closeIfOpen = async () => {
    if (await isOpen()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  };

  // ================================================================
  console.log('\n[入口 1] ? 键');
  check('默认隐藏', await isOpen(), false);
  await page.keyboard.press('?');
  await page.waitForTimeout(400);
  check('? 打开面板', await isOpen(), true);
  await page.keyboard.press('?');
  await page.waitForTimeout(400);
  check('? 再按一次收起', await isOpen(), false);

  // ================================================================
  console.log('\n[入口 2] 侧栏底部按钮');
  await page.click('#btn-shortcuts');
  await page.waitForTimeout(400);
  check('点底栏按钮打开', await isOpen(), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  check('Esc 关闭', await isOpen(), false);
  check('关闭后焦点还给触发按钮',
    await page.evaluate(() => document.activeElement.id), 'btn-shortcuts');

  // ================================================================
  console.log('\n[入口 3] 首页「全部快捷键」按钮');
  check('首页入口存在', await page.evaluate(() =>
    !!document.querySelector('[data-open-shortcuts]')), true);
  await page.click('[data-open-shortcuts]');
  await page.waitForTimeout(400);
  check('点首页入口打开', await isOpen(), true);

  // ================================================================
  console.log('\n[内容] 覆盖各场景，且键位和代码里注册的一致');
  const content = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sc-row')].map(r => ({
      keys: [...r.querySelectorAll('kbd')].map(k => k.textContent),
      desc: r.querySelector('dd').textContent,
    }));
    return {
      groups: [...document.querySelectorAll('.sc-group h3')].map(e => e.textContent),
      rows,
    };
  });
  for (const g of ['全局', '快速打开面板', '侧栏与目录树', '正文命中导航',
                   'Markdown 编辑器', '编辑器分栏条', '重命名与备注']) {
    check(`有「${g}」分组`, content.groups.includes(g), true);
  }
  const hasCombo = (keys) => content.rows.some(r =>
    r.keys.length === keys.length && r.keys.every((k, i) => k === keys[i]));
  // 抽查几条真实注册过的键（app.js 的全局 keydown / mdSource keydown）
  const MOD = '⌘';   // 测试跑在 mac 上；MOD 由 navigator.platform 决定
  check('列了 ⌘K', hasCombo([MOD, 'K']), true);
  check('列了 ⌘B', hasCombo([MOD, 'B']), true);
  check('列了 ⌘S', hasCombo([MOD, 'S']), true);
  check('列了 ⌘I（Markdown 斜体，原来应用内完全没出口）', hasCombo([MOD, 'I']), true);
  check('列了 ⌘E（行内代码）', hasCombo([MOD, 'E']), true);
  check('列了 /', hasCombo(['/']), true);
  check('列了 ?', hasCombo(['?']), true);
  check('列了 Shift+Tab（反缩进）', hasCombo(['Shift', 'Tab']), true);
  check('条目数量合理（> 25 条）', content.rows.length > 25, true);
  check('每条都有说明文字', content.rows.every(r => r.desc.trim().length > 0), true);
  await closeIfOpen();

  // ================================================================
  console.log('\n[打开文档后仍可查] 这是原来的痛点：提示只在首页可见');
  await page.click('.file[data-path$="page.html"] .file-name');
  await page.waitForTimeout(1600);
  check('首页已隐藏（提示行不可见了）', await page.evaluate(() =>
    document.getElementById('empty-state').classList.contains('hidden')), true);
  await page.keyboard.press('?');
  await page.waitForTimeout(400);
  check('打开文档后 ? 仍能唤出', await isOpen(), true);
  await closeIfOpen();
  check('底栏入口也还在', await page.isVisible('#btn-shortcuts'), true);

  // ================================================================
  console.log('\n[焦点在预览正文里] ? 经快捷键桥转发');
  const frame = page.frames().find(f => f !== page.mainFrame());
  await frame.click('h1');
  await page.waitForTimeout(200);
  check('焦点确实落在 iframe 上', await page.evaluate(() =>
    document.activeElement.id), 'preview');
  await page.keyboard.press('?');
  await page.waitForTimeout(450);
  check('iframe 内按 ? 也能唤出', await isOpen(), true);
  await closeIfOpen();

  // ================================================================
  console.log('\n[让位] 在输入框里 ? 是输入字符，不是开面板');
  await page.click('#search');
  await page.keyboard.press('?');
  await page.waitForTimeout(350);
  check('搜索框里打 ? 不开面板', await isOpen(), false);
  check('? 被正常输入到搜索框', await page.inputValue('#search'), '?');
  // 清干净，避免影响后续
  await page.fill('#search', '');
  await page.waitForTimeout(400);

  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
