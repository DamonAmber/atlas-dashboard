// v0.2 三项功能：键盘导航、最近打开、HTML 全文搜索
//
// 自起隔离 Atlas 实例：本测试会点开文件，从而写入 store 的"最近打开"列表；
// 早先版本直连用户本机 :4321，会把测试文档塞进用户真实的 recent 里。

const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');

// fixture 要满足几个用例前提：
//   · 至少 4 个文档（键盘导航要连按 ↓ 多次、recent 要点开两个不同文件）
//   · 内容含"数据"（后端 /api/search 用例）
//   · 内容含 echarts / svg / chart / flex 等词，且文件名与路径都不含这些词
//     （前端用例要找"内容匹配但文件名不匹配"的样本来验证 .content-match）
const FIXTURE_FILES = {
  'proj-a/alpha.html': '<!doctype html><html><body><h1>甲</h1><p>这里有数据，用 echarts 绘制。</p></body></html>',
  'proj-a/beta.html': '<!doctype html><html><body><h1>乙</h1><p>数据可视化用到 svg 与 rgb 配色。</p></body></html>',
  'proj-b/gamma.html': '<!doctype html><html><body><h1>丙</h1><p>chart 布局用 flex 排版。</p></body></html>',
  'proj-b/delta.md': '# 丁\n\n这份文档也包含数据两个字。\n',
};

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const atlas = await startAtlas({ prefix: 'atlas-v02-spec-', files: FIXTURE_FILES });
  console.log('实例:', atlas.base);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto(atlas.base, { waitUntil: 'load' });
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
    kbdFocusCount: document.querySelectorAll('.file.kbd-focus').length,
    iframeNotEmpty: !document.getElementById('preview').classList.contains('hidden'),
  }));
  check('Enter 打开当前 kbd-focus 的文件', afterEnter.activePath === kbd2);
  check('Enter 后 kbd-focus 自动清除（避免与 active 视觉冲突）', afterEnter.kbdFocusCount === 0);

  // 模拟混合操作：键盘 ↓ 后用鼠标点击其他文件，kbd-focus 应被清除
  await page.locator('#search').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(60);
  // 鼠标点击别的文件
  const otherFile = await page.evaluate(() => {
    const files = [...document.querySelectorAll('#tree .file')].filter(el => !el.closest('.folder.collapsed'));
    return files[2]?.dataset.path;
  });
  if (otherFile) {
    await page.locator(`#tree .file[data-path="${otherFile.replace(/(["\\])/g, '\\$1')}"]`).first().click();
    await page.waitForTimeout(200);
    const afterMixedClick = await page.evaluate(() => ({
      activeCount: document.querySelectorAll('.file.active').length,
      kbdFocusCount: document.querySelectorAll('.file.kbd-focus').length,
    }));
    check('键盘 ↓ 后鼠标点击其他文件，kbd-focus 被清除（不再"两个被选中"）',
      afterMixedClick.kbdFocusCount === 0);
  }

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
  // 0.31 起侧栏的「最近」块（#recent-bar / .recent-item / #recent-toggle）随 design §11.B1 移除，
  // 最近打开改由 ⌘K 空状态的「最近打开」段（.quickopen-item[data-section="recent"]）与首页轨道提供。
  // 断言意图不变：列表出现、新打开的排到最前、点条目能打开；原「折叠 / 展开」随块一起移除，
  // 换成段头「清除」（#recent-clear，行为同原清除最近）。
  console.log('\n[2] 最近打开（⌘K 空状态）');
  // 之前 Enter 打开了 kbd2 所指文件，所以 recent 应该至少有它
  await page.evaluate(() => fetchState());
  await page.waitForTimeout(300);
  const openQo = async () => {
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#quickopen:not(.hidden) .quickopen-item');
  };
  const closeQo = async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('#quickopen.hidden', { state: 'attached' });
  };
  const readRecent = () => page.evaluate(() => ({
    head: !!document.querySelector('#quickopen-list .qo-section[data-section="recent"]'),
    clearBtn: !!document.querySelector('#quickopen-list .qo-section[data-section="recent"] #recent-clear'),
    items: [...document.querySelectorAll('#quickopen-list .quickopen-item[data-section="recent"]')]
      .map(i => i.dataset.path),
  }));
  await openQo();
  const recentInit = await readRecent();
  await closeQo();
  console.log('  ', recentInit);
  check('⌘K 空状态出现「最近打开」段', recentInit.head);
  check('段头右侧有「清除」#recent-clear', recentInit.clearBtn);
  check('recent 至少含一个最近打开的文件', recentInit.items.length >= 1);

  // 再点一个文件看是否进 recent 顶部
  const otherPath = await page.evaluate(() => {
    const all = [...document.querySelectorAll('#tree .file')].map(f => f.dataset.path);
    return all.find(p => p !== window.state?.activeFilePath) || all[0];
  });
  await page.locator(`.file[data-path="${otherPath.replace(/(["\\])/g, '\\$1')}"]`).first().click();
  await page.waitForTimeout(400);
  await openQo();
  const recentAfterClick = (await readRecent()).items;
  check('点击新文件后，新文件出现在 recent 顶部', recentAfterClick[0] === otherPath);

  // 点击 recent 中的项可以打开：点第二条（不是当前文档的那一条），确实切过去了
  const target = recentAfterClick[1] || recentAfterClick[0];
  await page.locator(`#quickopen-list .quickopen-item[data-section="recent"][data-path="${target.replace(/(["\\])/g, '\\$1')}"]`).click();
  await page.waitForTimeout(400);
  const fromRecent = await page.evaluate(() => document.querySelector('.file.active')?.dataset.path);
  check('点击 recent 项能打开对应文件', fromRecent === target);
  check('点开后 ⌘K 自动关闭', await page.locator('#quickopen.hidden').count() === 1);

  // 清除最近：段头「清除」→ 确认 → 段消失，首页轨道的「清除」也随之隐藏
  await openQo();
  await page.click('#recent-clear');
  await page.waitForSelector('.atlas-dialog .dialog-confirm');
  await page.click('.atlas-dialog .dialog-confirm');
  await page.waitForSelector('.atlas-dialog', { state: 'detached' });
  await page.waitForTimeout(300);
  const afterClear = await readRecent();
  check('清除后 ⌘K 里不再有「最近打开」段', !afterClear.head && afterClear.items.length === 0);
  check('清除后焦点回到 ⌘K 输入框', await page.evaluate(() => document.activeElement?.id) === 'quickopen-input');
  await closeQo();
  check('清除后首页轨道的「清除」按钮隐藏',
    await page.locator('#home-recent-clear.hidden').count() === 1);
  check('服务端 recent 已清空',
    (await page.evaluate(async () => (await (await fetch('/api/state')).json()).recent.length)) === 0);
  // 再打开一篇：记录重新开始（下面的隔离性用例也依赖 store.recent 非空）
  await page.locator(`.file[data-path="${otherPath.replace(/(["\\])/g, '\\$1')}"]`).first().click();
  await page.waitForTimeout(400);
  await openQo();
  check('清除后再打开文档，⌘K「最近打开」重新出现', (await readRecent()).items[0] === otherPath);
  await closeQo();

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

  // ========== 隔离性 ==========
  console.log('\n[4] 隔离性');
  const store = atlas.readStore() || {};
  const recent = store.recent || [];
  check('store.recent 非空（用例确实点开过文件）', recent.length >= 1, `count=${recent.length}`);
  check('store.recent 的路径都在实例临时目录内',
    recent.every(p => p.startsWith(atlas.tmpDir)),
    JSON.stringify(recent.slice(0, 2)));

  await browser.close();
  await atlas.stop();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
