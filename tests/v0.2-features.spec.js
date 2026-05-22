// 验证 0.2 三个新功能：键盘导航、最近打开、全文搜索
const { chromium } = require('playwright');
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // 备份用于还原
  const backup = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return d.tree;
  });

  // ========== 键盘导航 ==========
  console.log('\n[1] 键盘导航');
  // 确保所有 folder 展开（避免折叠 folder 内的 file 不可达）
  await page.evaluate(() => {
    document.querySelectorAll('.folder.collapsed').forEach(f => {
      f.querySelector(':scope > .folder-header').click();
    });
  });
  await page.waitForTimeout(200);

  await page.locator('#search').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(60);
  let kbd = await page.evaluate(() => document.querySelector('.file.kbd-focus')?.dataset.path);
  check('搜索框按 ↓ → 第一个 file 获得 kbd-focus', !!kbd);
  const firstPath = kbd;

  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(50);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(50);
  let kbd2 = await page.evaluate(() => document.querySelector('.file.kbd-focus')?.dataset.path);
  check('连按 ↓↓ 移动到下下个 file', kbd2 && kbd2 !== firstPath);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const afterEnter = await page.evaluate(() => ({
    activePath: document.querySelector('.file.active')?.dataset.path,
    iframeNotEmpty: !document.getElementById('preview').classList.contains('hidden'),
  }));
  check('Enter 打开当前 kbd-focus 的文件', afterEnter.activePath === kbd2);

  // Esc 回搜索框
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(50);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  const afterEsc = await page.evaluate(() => ({
    focused: document.activeElement.id,
    hasKbd: !!document.querySelector('.file.kbd-focus'),
  }));
  check('Esc 回搜索框 + 清除 kbd-focus',
    afterEsc.focused === 'search' && !afterEsc.hasKbd);

  // ========== 最近打开 ==========
  console.log('\n[2] 最近打开');
  // 之前 Enter 打开了 kbd2 所指文件，所以 recent 应该至少有它
  await page.evaluate(() => fetchState());
  await page.waitForTimeout(300);
  const recentInit = await page.evaluate(() => ({
    barVisible: !document.getElementById('recent-bar').classList.contains('hidden'),
    items: [...document.querySelectorAll('.recent-item')].map(i => i.dataset.path),
  }));
  console.log('  ', recentInit);
  check('recent-bar 已显示', recentInit.barVisible);
  check('recent 至少含一个最近打开的文件', recentInit.items.length >= 1);

  // 再点一个文件看是否进 recent 顶部
  const otherPath = await page.evaluate(() => {
    const all = [...document.querySelectorAll('#tree .file')].map(f => f.dataset.path);
    return all.find(p => p !== window.state?.activeFilePath) || all[0];
  });
  await page.locator(`.file[data-path="${otherPath.replace(/(["\\])/g, '\\$1')}"]`).first().click();
  await page.waitForTimeout(400);
  const recentAfterClick = await page.evaluate(() => {
    return [...document.querySelectorAll('.recent-item')].map(i => i.dataset.path);
  });
  check('点击新文件后，新文件出现在 recent 顶部', recentAfterClick[0] === otherPath);

  // 点击 recent 中的项可以打开
  await page.locator(`.recent-item[data-path="${otherPath.replace(/(["\\])/g, '\\$1')}"]`).click();
  await page.waitForTimeout(300);
  const fromRecent = await page.evaluate(() => document.querySelector('.file.active')?.dataset.path);
  check('点击 recent 项能打开对应文件', fromRecent === otherPath);

  // 折叠/展开
  await page.locator('#recent-toggle').click();
  await page.waitForTimeout(150);
  const collapsedRecent = await page.evaluate(() =>
    document.getElementById('recent-bar').classList.contains('collapsed')
  );
  check('recent 折叠按钮可用', collapsedRecent);
  await page.locator('#recent-toggle').click();
  await page.waitForTimeout(150);

  // ========== 全文搜索 ==========
  console.log('\n[3] 全文搜索');

  // 直接调 API 看后端
  const apiSearch = await page.evaluate(async () => {
    const r = await fetch('/api/search?q=' + encodeURIComponent('数据'));
    return await r.json();
  });
  check('GET /api/search 返回 matches', apiSearch.matches && apiSearch.matches.length > 0,
    `count=${apiSearch.matches?.length}`);
  if (apiSearch.matches?.length) {
    check('match 含 snippet', !!apiSearch.matches[0].snippet);
  }

  // 前端：找一个搜索词使其内容匹配但文件名/备注/路径都不含
  // 先取一个内容里独特的词（取每个文件 snippet 里前几个字试一下）
  const probe = await page.evaluate(async () => {
    // 试探几个常见技术词，找一个"内容匹配但文件名不匹配"的
    for (const q of ['echarts', 'svg', 'rgb', 'flex', 'chart']) {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q));
      const d = await r.json();
      // 获取所有 file 的元数据
      const stateRes = await fetch('/api/state');
      const stateData = await stateRes.json();
      // 找一个：内容匹配 + 文件名/路径/alias 都不含 q
      for (const m of (d.matches || [])) {
        const file = stateData.files[m.path];
        if (!file) continue;
        const inName = file.name.toLowerCase().includes(q)
          || file.relPath.toLowerCase().includes(q)
          || (file.alias && file.alias.toLowerCase().includes(q));
        if (!inName) return { q, path: m.path };
      }
    }
    return null;
  });
  console.log('  探测到内容匹配样本:', probe);
  if (probe) {
    await page.fill('#search', probe.q);
    // 等异步搜索 + 二次 render：debounce 80 + API + render，最多 2s 兜底
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#tree .file.content-match')].length > 0,
      { timeout: 2500 }
    ).catch(() => {});
    const filteredCount = await page.evaluate(() =>
      [...document.querySelectorAll('#tree .file')].filter(el => !el.closest('.folder.collapsed')).length
    );
    check('搜内容关键词后，含内容匹配的 file 被过滤显示',
      filteredCount > 0);
    const hasContentMatchClass = await page.evaluate(() =>
      [...document.querySelectorAll('#tree .file.content-match')].length > 0
    );
    check('内容匹配（非文件名匹配）的 file 加 .content-match class',
      hasContentMatchClass);
  } else {
    console.log('  (没有找到内容匹配但文件名不匹配的样本，跳过部分断言)');
  }

  await page.fill('#search', '');
  await page.waitForTimeout(200);

  // 还原
  await page.evaluate(async (tree) => {
    await fetch('/api/tree', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree }),
    });
  }, backup);

  await browser.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
