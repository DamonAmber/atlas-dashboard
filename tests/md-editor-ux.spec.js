// Markdown 编辑器交互
//
// 覆盖：
//   ① 全局快捷键不再抢输入框 —— `/` 能正常打进源码框与设置里的路径输入框
//      （原来 isContentEditable 判断漏了 input/textarea，扫描根路径根本输不进去）
//   ② 编辑器快捷键 —— ⌘B/⌘I/⌘K/⌘E 作用于源码而不是去收侧边栏；⌘S 保存而不是
//      触发浏览器"保存网页"
//   ③ 回车自动续列表 / Tab 多行缩进
//   ④ 格式工具条
//   ⑤ 分栏可拖拽 + 比例持久化
//   ⑥ 大纲：生成、点击跳转、状态记忆
//   ⑦ 草稿：崩溃式关闭后能恢复
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

// 正文足够长，保证预览面板真的能滚动（大纲跳转要验证 scrollTop）
const FILLER = Array.from({ length: 30 }, (_, i) => `填充段落 ${i + 1}，用来把文档撑高。`).join('\n\n');
const MD = [
  '# 一级标题',
  '',
  '普通段落。',
  '',
  '- 第一项',
  '',
  '## 二级标题甲',
  '',
  FILLER,
  '',
  '## 二级标题乙',
  '',
  '内容乙。',
].join('\n');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

// 把源码框重置成给定内容——测试之间不互相污染。
// 走 input 事件而不是依赖 ⌘Z：撤销栈的行为不该成为断言的前提。
async function resetSource(page, text) {
  await page.evaluate((t) => {
    const ta = document.getElementById('md-source');
    ta.value = t;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(0, 0);
  }, text);
  await page.waitForTimeout(120);
}

// 选中源码里第一次出现的某段文字
async function selectInSource(page, needle) {
  await page.evaluate((s) => {
    const ta = document.getElementById('md-source');
    ta.focus();
    const i = ta.value.indexOf(s);
    ta.setSelectionRange(i, i + s.length);
  }, needle);
}

// 进编辑模式；draft 指定遇到草稿对话框时怎么选
async function openEditor(page, draft = null) {
  await page.click('.file[data-doctype="md"] .file-name');
  await page.waitForTimeout(900);
  await page.click('#btn-edit');
  const dialog = await page.waitForSelector('.atlas-dialog', { timeout: 1200 }).catch(() => null);
  if (dialog) {
    const title = await page.evaluate(() => document.querySelector('.atlas-dialog h2').textContent);
    if (draft === 'restore') await page.click('.atlas-dialog .dialog-confirm');
    else await page.click('.atlas-dialog .dialog-cancel');
    await page.waitForTimeout(250);
    return title;
  }
  await page.waitForSelector('#md-editor:not(.hidden)');
  return null;
}

// 离开编辑模式（有未保存改动时确认放弃）
async function leaveEditor(page) {
  await page.evaluate(() => document.getElementById('btn-edit-cancel').click());
  await page.waitForTimeout(200);
  if (await page.$('.atlas-dialog')) {
    await page.click('.atlas-dialog .dialog-confirm');
    await page.waitForTimeout(250);
  }
}

(async () => {
  const atlas = await startAtlas({ prefix: 'atlas-mdux-', files: { 'proj/note.md': MD } });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(atlas.base);
  await page.waitForSelector('.file');
  await openEditor(page);
  await page.waitForSelector('#md-editor:not(.hidden)');

  // ---- ① `/` 不再被抢走 ----
  console.log('\n[全局快捷键不再抢输入框]');
  await resetSource(page, MD);
  await page.keyboard.type('a/b');
  check('源码框里能正常输入 /', (await page.inputValue('#md-source')).startsWith('a/b'), true);
  check('焦点仍在源码框', await page.evaluate(() => document.activeElement.id), 'md-source');

  // ---- ② 编辑器快捷键 ----
  console.log('\n[编辑器快捷键]');
  await resetSource(page, MD);
  const sidebarBefore = await page.evaluate(() => document.body.classList.contains('sidebar-collapsed'));
  await selectInSource(page, '普通段落');
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(150);
  check('⌘B 给选中文字加粗', /\*\*普通段落\*\*/.test(await page.inputValue('#md-source')), true);
  check('⌘B 没有顺手收起侧边栏',
    await page.evaluate(() => document.body.classList.contains('sidebar-collapsed')), sidebarBefore);
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(150);
  check('再按 ⌘B 取消加粗', /\*\*普通段落\*\*/.test(await page.inputValue('#md-source')), false);

  await resetSource(page, MD);
  await selectInSource(page, '内容乙');
  await page.keyboard.press('Meta+i');
  await page.waitForTimeout(150);
  check('⌘I 加斜体', /\*内容乙\*/.test(await page.inputValue('#md-source')), true);

  await resetSource(page, MD);
  await selectInSource(page, '内容乙');
  await page.keyboard.press('Meta+e');
  await page.waitForTimeout(150);
  check('⌘E 加行内代码', /`内容乙`/.test(await page.inputValue('#md-source')), true);

  await resetSource(page, MD);
  await selectInSource(page, '内容乙');
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(150);
  check('⌘K 插入链接骨架', /\[内容乙\]\(https:\/\/\)/.test(await page.inputValue('#md-source')), true);
  check('⌘K 后光标选中 url 段，可直接输入',
    await page.evaluate(() => {
      const ta = document.getElementById('md-source');
      return ta.value.slice(ta.selectionStart, ta.selectionEnd);
    }), 'https://');

  const savePrevented = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('⌘S 被应用接管（不再触发浏览器保存网页）', savePrevented, true);
  await page.waitForTimeout(800);   // 等保存 + 退出编辑

  // ---- ③ 回车续列表 / Tab ----
  console.log('\n[回车续列表 / Tab 缩进]');
  await openEditor(page, 'discard');
  await page.waitForSelector('#md-editor:not(.hidden)');
  await resetSource(page, MD);
  await page.evaluate(() => {
    const ta = document.getElementById('md-source');
    ta.focus();
    const i = ta.value.indexOf('- 第一项') + '- 第一项'.length;
    ta.setSelectionRange(i, i);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('第二项');
  await page.waitForTimeout(150);
  check('回车自动补出 `- ` 前缀', /- 第一项\n- 第二项/.test(await page.inputValue('#md-source')), true);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('在空列表项上回车结束列表', /- 第二项\n\n/.test(await page.inputValue('#md-source')), true);

  await resetSource(page, '3. 甲');
  await page.evaluate(() => {
    const ta = document.getElementById('md-source');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('有序列表序号自增到 4', await page.inputValue('#md-source'), '3. 甲\n4. ');

  await resetSource(page, '- [x] 已完成');
  await page.evaluate(() => {
    const ta = document.getElementById('md-source');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('任务列表续行给出未勾选框', await page.inputValue('#md-source'), '- [x] 已完成\n- [ ] ');

  await resetSource(page, 'aaa\nbbb');
  await page.evaluate(() => {
    const ta = document.getElementById('md-source');
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
  });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  check('Tab 缩进多行选区', await page.inputValue('#md-source'), '  aaa\n  bbb');
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(150);
  check('Shift+Tab 反缩进', await page.inputValue('#md-source'), 'aaa\nbbb');

  // ---- ④ 工具条 ----
  console.log('\n[格式工具条]');
  await resetSource(page, MD);
  await selectInSource(page, '内容乙');
  await page.click('.md-toolbar button[data-md-cmd="quote"]');
  await page.waitForTimeout(150);
  check('工具条「引用」加上 > 前缀', /^> 内容乙。$/m.test(await page.inputValue('#md-source')), true);
  await page.click('.md-toolbar button[data-md-cmd="quote"]');
  await page.waitForTimeout(150);
  check('再点一次取消引用', /^内容乙。$/m.test(await page.inputValue('#md-source')), true);

  await resetSource(page, MD);
  await selectInSource(page, '内容乙');
  await page.click('.md-toolbar button[data-md-cmd="task"]');
  await page.waitForTimeout(150);
  check('工具条「待办」加上任务前缀', /^- \[ \] 内容乙。$/m.test(await page.inputValue('#md-source')), true);

  await resetSource(page, MD);
  await selectInSource(page, '内容乙');
  await page.click('.md-toolbar button[data-md-cmd="h2"]');
  await page.waitForTimeout(150);
  check('工具条「H2」加上 ## 前缀', /^## 内容乙。$/m.test(await page.inputValue('#md-source')), true);

  await resetSource(page, MD);
  await selectInSource(page, '内容乙');
  await page.click('.md-toolbar button[data-md-cmd="bold"]');
  await page.waitForTimeout(150);
  check('工具条「B」在点击后仍作用于原选区', /\*\*内容乙\*\*/.test(await page.inputValue('#md-source')), true);

  // ---- ⑤ 分栏拖拽 ----
  console.log('\n[分栏拖拽]');
  await resetSource(page, MD);
  const beforeSplit = await page.evaluate(() =>
    document.querySelector('.md-editor-pane').getBoundingClientRect().width);
  const box = await page.locator('#md-editor-split').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 260, box.y + 300, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterSplit = await page.evaluate(() =>
    document.querySelector('.md-editor-pane').getBoundingClientRect().width);
  check('拖拽后源码栏变窄', afterSplit < beforeSplit - 150, true);
  check('拖拽结束后没有残留 md-splitting 状态',
    await page.evaluate(() => document.body.classList.contains('md-splitting')), false);
  const storedSplit = await page.evaluate(() => localStorage.getItem('atlas:mdSplit'));
  check('分栏比例已持久化', storedSplit !== null && Number(storedSplit) < 45, true);
  await page.dblclick('#md-editor-split');
  await page.waitForTimeout(200);
  check('双击复位到 50', await page.evaluate(() => localStorage.getItem('atlas:mdSplit')), '50');
  await page.focus('#md-editor-split');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  check('分栏条支持方向键微调', await page.evaluate(() => localStorage.getItem('atlas:mdSplit')), '48');

  // ---- ⑥ 大纲 ----
  console.log('\n[编辑器大纲]');
  await resetSource(page, MD);
  check('大纲默认隐藏', await page.isHidden('#md-outline'), true);
  await page.click('#md-outline-toggle');
  await page.waitForTimeout(400);
  check('点「大纲」后显示', await page.isVisible('#md-outline'), true);
  const outlineItems = await page.evaluate(() =>
    [...document.querySelectorAll('.md-outline-item')].map(b => ({ t: b.textContent, lv: b.dataset.level })));
  check('大纲列出全部标题', outlineItems.map(o => o.t), ['一级标题', '二级标题甲', '二级标题乙']);
  check('大纲带层级', outlineItems.map(o => o.lv), ['1', '2', '2']);
  await page.evaluate(() => {
    [...document.querySelectorAll('.md-outline-item')].find(b => b.textContent === '二级标题乙').click();
  });
  await page.waitForTimeout(700);
  const scrolled = await page.evaluate(() => document.getElementById('md-preview').scrollTop);
  check('点大纲项滚动了预览区', scrolled > 0, true);
  check('被点的项标为 active',
    await page.evaluate(() => document.querySelector('.md-outline-item.active').textContent), '二级标题乙');
  check('大纲显示状态已持久化', await page.evaluate(() => localStorage.getItem('atlas:mdOutline')), '1');
  // 大纲随源码变化更新
  await resetSource(page, '# 新标题\n\n正文');
  await page.waitForTimeout(500);
  check('改源码后大纲同步更新', await page.evaluate(() =>
    [...document.querySelectorAll('.md-outline-item')].map(b => b.textContent)), ['新标题']);
  await page.click('#md-outline-toggle');
  await page.waitForTimeout(200);
  check('再点一次隐藏大纲', await page.isHidden('#md-outline'), true);

  // ---- ⑦ 草稿恢复 ----
  console.log('\n[草稿恢复]');
  await resetSource(page, MD);
  await page.evaluate(() => {
    const ta = document.getElementById('md-source');
    ta.focus();
    ta.setSelectionRange(0, 0);
  });
  await page.keyboard.type('草稿标记');
  await page.waitForTimeout(1100);   // 等草稿落盘（防抖 700ms）
  check('编辑内容已写入本地草稿', await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('atlas:mdDrafts') || '{}');
    const k = Object.keys(all)[0];
    return k ? all[k].content.slice(0, 4) : null;
  }), '草稿标记');

  // 模拟"浏览器崩溃"：直接重载，不走取消 / 保存流程
  await page.reload();
  await page.waitForSelector('.file');
  const title = await openEditor(page, 'restore');
  check('重新进入编辑时提示恢复草稿', title, '发现未保存的草稿');
  check('选择恢复后内容回来了', (await page.inputValue('#md-source')).startsWith('草稿标记'), true);

  // 丢弃草稿路径
  await page.reload();
  await page.waitForSelector('.file');
  await openEditor(page, 'discard');
  check('选择丢弃后用磁盘内容', (await page.inputValue('#md-source')).startsWith('# 一级标题'), true);
  check('丢弃后草稿被清掉', await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('atlas:mdDrafts') || '{}');
    return Object.keys(all).length;
  }), 0);

  // ---- 设置面板里的路径输入框 ----
  console.log('\n[设置里手输绝对路径]');
  await leaveEditor(page);
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal:not(.hidden)');
  await page.click('#root-input');
  await page.keyboard.type('/Users/demo/docs');
  check('扫描根输入框能完整输入绝对路径', await page.inputValue('#root-input'), '/Users/demo/docs');

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
