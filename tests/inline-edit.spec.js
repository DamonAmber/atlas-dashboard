// 端到端验证 inline edit 修复：粘贴格式 / 超长省略号 / folder rename
// 直接 node tests/inline-edit.spec.js 运行

const { chromium } = require('playwright');

const BASE = 'http://localhost:4321';

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  const icon = ok ? '✓' : '✗';
  console.log(`  ${icon} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on('pageerror', err => console.error('[pageerror]', err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') console.error('[console.error]', msg.text());
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.file', { timeout: 10000 });

  // ========================================
  // 准备：找一个目标文件
  // ========================================
  const targetPath = await page.evaluate(() => {
    const f = document.querySelector('.file');
    return f && f.dataset.path;
  });
  if (!targetPath) {
    console.error('找不到 .file 节点，无法测试');
    process.exit(1);
  }
  console.log('\n目标文件：' + targetPath);

  // 先把 alias 清掉，回到原始状态
  await page.evaluate(async (p) => {
    await fetch('/api/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, alias: '' }),
    });
  }, targetPath);
  await page.evaluate(() => fetchState && fetchState());
  await page.waitForTimeout(200);

  // ========================================
  // 测试 1：粘贴富文本（带 H1/strong）→ 应只保留纯文本，无富文本样式
  // ========================================
  console.log('\n[测试 1] 粘贴大标题应保留纯文本');

  await clickEditAlias(page, targetPath);

  // 模拟粘贴：用 ClipboardEvent 注入 text/html + text/plain
  await page.evaluate(() => {
    const nameEl = document.querySelector('.file.active .file-name')
      || document.querySelector('.file[contenteditable] .file-name')
      || document.activeElement;
    const dt = new DataTransfer();
    dt.items.add('<h1 style="font-size:48px;font-weight:900;color:red">巨大标题文本</h1>', 'text/html');
    dt.items.add('巨大标题文本', 'text/plain');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    nameEl.dispatchEvent(ev);
  });
  await page.waitForTimeout(50);

  // 检查 DOM 是否还有富文本节点
  const afterPaste = await page.evaluate(() => {
    const el = document.querySelector('.file-name[contenteditable="true"]');
    if (!el) return { error: '找不到 contenteditable 元素' };
    const cs = getComputedStyle(el);
    return {
      text: el.textContent,
      hasChildElement: !!el.querySelector('*'),
      childTags: [...el.querySelectorAll('*')].map(c => c.tagName),
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
    };
  });
  check('粘贴后 textContent 是纯文本', afterPaste.text === '巨大标题文本',
    `实际: "${afterPaste.text}"`);
  check('粘贴后 DOM 中没有子元素（无 H1/strong）', !afterPaste.hasChildElement,
    afterPaste.hasChildElement ? `仍有: ${afterPaste.childTags.join(',')}` : '');
  check('字号未被粘贴源覆盖（应为 12px）', afterPaste.fontSize === '12px',
    `实际: ${afterPaste.fontSize}`);
  check('字重未被粘贴源覆盖（应为 600 而非 900）', /^[1-7]00$/.test(afterPaste.fontWeight) && parseInt(afterPaste.fontWeight) <= 700,
    `实际: ${afterPaste.fontWeight}`);

  // 提交并验证保存值
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const aliasAfterPaste = await page.evaluate(async (p) => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return d.files[p].alias;
  }, targetPath);
  check('保存的 alias 是纯文本', aliasAfterPaste === '巨大标题文本',
    `实际: "${aliasAfterPaste}"`);

  // ========================================
  // 测试 2：超长 alias，再次编辑应显示完整文本，无省略号
  // ========================================
  console.log('\n[测试 2] 超长备注名编辑时应完整可见');

  const longAlias = '这是一个非常非常非常非常非常长的备注名用来测试 ellipsis 是否被正确解除-' + 'X'.repeat(80);
  await page.evaluate(async ({ p, a }) => {
    await fetch('/api/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, alias: a }),
    });
    await fetchState();
  }, { p: targetPath, a: longAlias });
  await page.waitForTimeout(300);

  await clickEditAlias(page, targetPath);

  const afterEnterEdit = await page.evaluate(() => {
    const el = document.querySelector('.file-name[contenteditable="true"]');
    if (!el) return { error: '找不到 contenteditable 元素' };
    const cs = getComputedStyle(el);
    return {
      text: el.textContent,
      whiteSpace: cs.whiteSpace,
      overflow: cs.overflow,
      textOverflow: cs.textOverflow,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      visibleSameAsContent: el.scrollWidth <= el.clientWidth + 2,
    };
  });
  check('编辑态 textContent 等于完整 alias', afterEnterEdit.text === longAlias,
    `长度: ${afterEnterEdit.text.length} vs ${longAlias.length}`);
  check('编辑态 white-space 允许换行（不是 nowrap）', afterEnterEdit.whiteSpace !== 'nowrap',
    `实际: ${afterEnterEdit.whiteSpace}`);
  check('编辑态 text-overflow 不再省略（应为 clip）', afterEnterEdit.textOverflow === 'clip',
    `实际: ${afterEnterEdit.textOverflow}`);
  check('编辑态内容完整可见（scrollWidth ≈ clientWidth）', afterEnterEdit.visibleSameAsContent,
    `scrollWidth=${afterEnterEdit.scrollWidth}, clientWidth=${afterEnterEdit.clientWidth}`);

  // 关键 bug 2 反向验证：textContent 不能含省略号
  check('编辑态 textContent 不含省略号字符', !/…|\.\.\./.test(afterEnterEdit.text),
    `实际: "${afterEnterEdit.text.slice(-20)}"`);

  // Esc 取消，避免污染
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ========================================
  // 测试 3：粘贴多行文本应合并为单行
  // ========================================
  console.log('\n[测试 3] 粘贴多行/多空白应规整成单行');

  await page.evaluate(async (p) => {
    await fetch('/api/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, alias: '' }),
    });
    await fetchState();
  }, targetPath);
  await page.waitForTimeout(200);

  await clickEditAlias(page, targetPath);
  await page.evaluate(() => {
    const el = document.querySelector('.file-name[contenteditable="true"]');
    const dt = new DataTransfer();
    dt.items.add('第一行\n第二行\t\t第三行   多空格', 'text/plain');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
  });
  await page.waitForTimeout(50);

  const multiline = await page.evaluate(() => {
    const el = document.querySelector('.file-name[contenteditable="true"]');
    return el && el.textContent;
  });
  check('多行/多空白合并为单行单空格', multiline === '第一行 第二行 第三行 多空格',
    `实际: "${multiline}"`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ========================================
  // 测试 4：folder 重命名同样防富文本
  // ========================================
  console.log('\n[测试 4] folder 重命名同样防富文本格式');

  // 找一个 folder
  const folderId = await page.evaluate(() => {
    const f = document.querySelector('.folder');
    return f && f.dataset.folderId;
  });
  const originalName = await page.evaluate((id) => {
    const f = document.querySelector(`.folder[data-folder-id="${id}"] .folder-name`);
    return f && f.textContent;
  }, folderId);

  await page.evaluate((id) => {
    const btn = document.querySelector(`.folder[data-folder-id="${id}"] [data-act="rename"]`);
    btn.click();
  }, folderId);
  await page.waitForTimeout(100);

  await page.evaluate((id) => {
    const el = document.querySelector(`.folder[data-folder-id="${id}"] .folder-name[contenteditable="true"]`);
    const dt = new DataTransfer();
    dt.items.add('<strong style="font-size:32px">新分组</strong>', 'text/html');
    dt.items.add('新分组', 'text/plain');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
  }, folderId);
  await page.waitForTimeout(50);

  const folderAfter = await page.evaluate((id) => {
    const el = document.querySelector(`.folder[data-folder-id="${id}"] .folder-name[contenteditable="true"]`);
    if (!el) return { error: 'no editable folder' };
    return {
      text: el.textContent,
      hasChild: !!el.querySelector('*'),
      fontSize: getComputedStyle(el).fontSize,
    };
  }, folderId);
  check('folder 粘贴后 textContent 是纯文本', folderAfter.text === '新分组',
    `实际: "${folderAfter.text}"`);
  check('folder 粘贴后无富文本子元素', !folderAfter.hasChild);
  check('folder 字号未被粘贴源覆盖（12px）', folderAfter.fontSize === '12px',
    `实际: ${folderAfter.fontSize}`);

  // Esc 撤销，恢复原名
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const folderRestored = await page.evaluate((id) => {
    const el = document.querySelector(`.folder[data-folder-id="${id}"] .folder-name`);
    return el && el.textContent;
  }, folderId);
  check('Esc 取消后 folder 名恢复原值', folderRestored === originalName,
    `期望: "${originalName}", 实际: "${folderRestored}"`);

  // ========================================
  // 测试 5：清空 alias = 删除备注（恢复原文件名显示）
  // ========================================
  console.log('\n[测试 5] alias 改回原文件名 = 删除备注');

  // 先设一个 alias
  await page.evaluate(async (p) => {
    await fetch('/api/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, alias: '某个备注名' }),
    });
    await fetchState();
  }, targetPath);
  await page.waitForTimeout(300);

  let s = await page.evaluate(async (p) => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return d.files[p].alias;
  }, targetPath);
  check('预置 alias 成功', s === '某个备注名', `当前 alias: "${s}"`);

  await clickEditAlias(page, targetPath);

  // 全选删除，输入与原文件名相同的字符串
  const baseName = await page.evaluate(async (p) => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return d.files[p].name.replace(/\.html$/i, '');
  }, targetPath);

  await page.evaluate((n) => {
    const el = document.querySelector('.file-name[contenteditable="true"]');
    el.textContent = n;
    // 触发 input 事件让 normalize 跑
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, baseName);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);

  s = await page.evaluate(async (p) => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return d.files[p].alias;
  }, targetPath);
  check('改成原文件名 = alias 被清空', !s, `当前 alias: ${s ?? '(null)'}`);

  // 清场
  await browser.close();

  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    console.log('\n失败列表：');
    failed.forEach(f => console.log(' - ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();

async function clickEditAlias(page, filePath) {
  // 先 hover 让 .file-actions 显示，再点击 ✎
  const fileSel = `.file[data-path="${cssEsc(filePath)}"]`;
  await page.locator(fileSel).hover();
  await page.locator(`${fileSel} [data-act="alias"]`).click({ force: true });
  await page.waitForSelector('.file-name[contenteditable="true"]');
}
function cssEsc(s) { return s.replace(/(["\\])/g, '\\$1'); }
