// ⌘K 快速打开 · 弹窗可访问性 · 磁盘文件重命名
//
// 覆盖：
//   ① ⌘K 快速打开：模糊匹配、键盘选择、Enter 打开、Esc 关闭、⌘K 再按收起
//   ② 弹窗可访问性：Esc 关闭、role=dialog/aria-modal、Tab 焦点锁在面板内、
//      关闭后焦点还给触发按钮（原来这些一个都没有）
//   ③ 重命名磁盘文件：改名成功 + store 状态迁移 + 非法输入被拒
const path = require('path');
const fs = require('fs');
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
    prefix: 'atlas-qo-',
    // 两个扫描根：这样"移除扫描根"才会走确认框（只剩一个时是直接报错的）
    scanRootCount: 2,
    files: {
      'alpha/api-report.html': '<!doctype html><html><body><h1>api report</h1></body></html>',
      'alpha/changelog.md': '# changelog\n\n内容。\n',
      'beta/deploy-notes.md': '# deploy\n\n内容。\n',
      'beta/index.html': '<!doctype html><html><body><h1>beta</h1></body></html>',
    },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  // ---- ① 快速打开 ----
  console.log('\n[⌘K 快速打开]');
  check('默认隐藏', await page.isHidden('#quickopen'), true);
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('#quickopen:not(.hidden)');
  check('⌘K 打开面板', await page.isVisible('#quickopen'), true);
  check('焦点自动落在输入框', await page.evaluate(() => document.activeElement.id), 'quickopen-input');
  const initialCount = await page.evaluate(() => document.querySelectorAll('.quickopen-item').length);
  check('空查询时列出全部文档', initialCount, 4);

  // 子序列模糊匹配：aprt → api-report
  await page.keyboard.type('aprt');
  await page.waitForTimeout(200);
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.quickopen-item .qo-name')].map(e => e.textContent));
  check('模糊匹配 aprt 命中 api-report', names[0], 'api-report');
  const marks = await page.evaluate(() =>
    document.querySelectorAll('.quickopen-item .qo-name mark').length);
  check('命中字符被高亮', marks >= 4, true);

  // 键盘上下选择
  await page.evaluate(() => { document.getElementById('quickopen-input').value = ''; document.getElementById('quickopen-input').dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(150);
  check('第一项默认选中', await page.evaluate(() =>
    document.querySelector('.quickopen-item.active').dataset.idx), '0');
  await page.keyboard.press('ArrowDown');
  check('↓ 移到第二项', await page.evaluate(() =>
    document.querySelector('.quickopen-item.active').dataset.idx), '1');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  check('↑ 从头部循环到末项', await page.evaluate(() =>
    document.querySelector('.quickopen-item.active').dataset.idx), '3');

  // Enter 打开
  await page.evaluate(() => {
    const inp = document.getElementById('quickopen-input');
    inp.value = 'deploy';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  check('Enter 后面板关闭', await page.isHidden('#quickopen'), true);
  check('Enter 打开了选中的文档', await page.evaluate(() => {
    const c = document.querySelector('#crumbs .crumb-name, #crumbs .crumb-alias');
    return c && c.textContent;
  }), 'deploy-notes.md');

  // Esc 关闭 + ⌘K 再按收起
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('#quickopen:not(.hidden)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc 关闭快速打开', await page.isHidden('#quickopen'), true);
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(200);
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(200);
  check('⌘K 再按一次收起', await page.isHidden('#quickopen'), true);

  // ---- ② 弹窗可访问性 ----
  console.log('\n[弹窗可访问性]');
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal:not(.hidden)');
  const a11y = await page.evaluate(() => {
    const p = document.querySelector('#settings-modal .modal-panel');
    return { role: p.getAttribute('role'), modal: p.getAttribute('aria-modal') };
  });
  check('设置弹窗有 role=dialog', a11y.role, 'dialog');
  check('设置弹窗有 aria-modal', a11y.modal, 'true');
  // Tab 焦点不应跑到弹窗外
  const escaped = await page.evaluate(async () => {
    const panel = document.querySelector('#settings-modal .modal-panel');
    for (let i = 0; i < 60; i++) {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      await new Promise(r => setTimeout(r, 0));
      if (document.activeElement !== document.body && !panel.contains(document.activeElement)) return true;
    }
    return false;
  });
  check('Tab 焦点被锁在弹窗内', escaped, false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('Esc 关闭设置弹窗', await page.isHidden('#settings-modal'), true);
  check('关闭后焦点还给触发按钮',
    await page.evaluate(() => document.activeElement.id), 'btn-settings');

  // 嵌套：确认框叠在设置弹窗之上时，Esc 只关最上层
  // 用弹窗内部的按钮触发（弹窗外的按钮被 backdrop 挡住，本来就点不到）
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal:not(.hidden)');
  await page.click('#root-list li:first-child [data-remove]');   // 会弹"移除扫描根？"确认框
  await page.waitForSelector('.atlas-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('Esc 先关最上层的确认框', await page.$('.atlas-dialog'), null);
  check('底下的设置弹窗仍然打开', await page.isVisible('#settings-modal'), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  // ---- ③ 重命名磁盘文件 ----
  console.log('\n[重命名磁盘文件]');
  // 先给它起个备注名 + 标已读，验证 store 状态会跟着迁移
  await page.evaluate(async () => {
    const p = [...document.querySelectorAll('.file')].find(e => e.dataset.path.endsWith('changelog.md')).dataset.path;
    await fetch('/api/alias', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, alias: '变更记录' }),
    });
    await fetch('/api/seen', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
  });
  await page.evaluate(() => document.getElementById('btn-refresh').click());
  await page.waitForTimeout(700);

  const oldPath = atlas.filePath('alpha/changelog.md');
  const target = [...(await page.$$('.file'))];
  void target;
  await page.hover('.file[data-path$="changelog.md"]');
  await page.click('.file[data-path$="changelog.md"] [data-act="rename-file"]');
  await page.waitForSelector('.atlas-dialog');
  check('重命名对话框预填当前文件名',
    await page.inputValue('.atlas-dialog .dialog-input'), 'changelog.md');
  await page.fill('.atlas-dialog .dialog-input', 'CHANGELOG-2026.md');
  await page.click('.atlas-dialog .dialog-confirm');
  await page.waitForTimeout(900);

  check('磁盘上旧文件已不存在', fs.existsSync(oldPath), false);
  check('磁盘上新文件已存在', fs.existsSync(atlas.filePath('alpha/CHANGELOG-2026.md')), true);
  const store = atlas.readStore();
  const newPath = atlas.filePath('alpha/CHANGELOG-2026.md');
  check('备注名迁移到新路径', store.aliases[newPath], '变更记录');
  check('旧路径的备注名已清除', store.aliases[oldPath], undefined);
  check('已读时间迁移到新路径', typeof store.seen[newPath], 'number');
  check('目录树节点指向新路径', JSON.stringify(store.tree).includes('CHANGELOG-2026.md'), true);
  check('目录树里不再有旧路径', JSON.stringify(store.tree).includes('alpha/changelog.md'), false);

  // 非法输入
  console.log('\n[重命名的输入校验]');
  const badCases = [
    ['../escape.md', '文件名不能包含路径分隔符'],
    ['sub/note.md', '文件名不能包含路径分隔符'],
    ['note.txt', '扩展名'],
    ['bad:name.md', '非法字符'],
    ['   ', '不能为空'],
  ];
  for (const [name, expectFragment] of badCases) {
    const r = await page.evaluate(async ({ n }) => {
      const p = [...document.querySelectorAll('.file')].find(e => e.dataset.path.endsWith('CHANGELOG-2026.md')).dataset.path;
      const resp = await fetch('/api/rename', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p, name: n }),
      });
      return { status: resp.status, body: await resp.json().catch(() => ({})) };
    }, { n: name });
    const rejected = r.status >= 400 && String(r.body.error || '').includes(expectFragment);
    check(`拒绝非法文件名 ${JSON.stringify(name)}`, rejected, true);
  }
  // 同名冲突必须是同目录才成立，单独验证一次
  const conflict = await page.evaluate(async () => {
    const p = [...document.querySelectorAll('.file')].find(e => e.dataset.path.endsWith('beta/index.html')).dataset.path;
    const resp = await fetch('/api/rename', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, name: 'deploy-notes.md' }),
    });
    return { status: resp.status, body: await resp.json().catch(() => ({})) };
  });
  check('同目录重名被拒（409）', conflict.status, 409);

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
