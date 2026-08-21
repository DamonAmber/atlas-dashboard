// 收藏文档 + 收藏夹 / 文档标签 + 按标签筛选
//
// 覆盖三组回归：
//   ① 收藏 —— 星标点击不被 SortableJS 吞掉、不误触"打开文档"、不启动拖拽；
//      收藏夹是跨文件夹的平铺列表、按收藏时间倒序、可取消、折叠状态持久化；
//      顶栏收藏按钮跟随当前文件；服务端 store 落盘 + 重命名后跟随
//   ② 标签 —— 逗号分隔编辑、去重与大小写合并、超量截断、行上最多显示 2 个 +N、
//      清空即删；标签筛选条按用量倒序、多选为 AND、清除按钮
//   ③ 筛选叠加 —— 标签筛选和「仅未读」/ 搜索必须是 AND 关系，而不是互相覆盖
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
let total = 0;
// 注意 expected 不能用默认参数：显式传 undefined 会触发默认值，
// 于是 check(name, undefined, undefined) 会变成拿 undefined 和 true 比。
// 要断言"某个 key 已经不存在"，请传布尔（例如 !(k in obj)）。
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`
    + (ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`));
}

// showPrompt 是应用内对话框：填输入框 + 点确定
async function fillPrompt(page, value) {
  await page.waitForSelector('.atlas-dialog .dialog-input', { timeout: 4000 });
  await page.fill('.atlas-dialog .dialog-input', value);
  await page.click('.atlas-dialog .dialog-confirm');
  await page.waitForSelector('.atlas-dialog', { state: 'detached', timeout: 4000 });
}

const fileRow = (name) => `.tree .file[data-path$="${name}"]`;

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-fav-',
    files: {
      'alpha/one.html': '<!doctype html><html><body><h1>alpha one</h1></body></html>',
      'alpha/two.html': '<!doctype html><html><body><h1>alpha two</h1></body></html>',
      'beta/three.md': '# beta three\n\n正文里有个关键词 配网。\n',
      'beta/four.md': '# beta four\n',
    },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(atlas.base);
  await page.waitForSelector('.tree .file');
  // 分组默认展开，四个文件都应该在树里
  await page.waitForFunction(() => document.querySelectorAll('.tree .file').length === 4);

  // ============ ① 收藏 ============
  console.log('\n[收藏：星标按钮]');
  const star1 = `${fileRow('one.html')} .fav-btn`;
  check('文件行有星标按钮', await page.locator(star1).count(), 1);
  check('初始 aria-pressed=false', await page.getAttribute(star1, 'aria-pressed'), 'false');
  check('初始行上没有 .favorite', await page.locator(`${fileRow('one.html')}.favorite`).count(), 0);
  check('收藏夹初始隐藏', await page.locator('#fav-bar.hidden').count(), 1);

  // 关键回归：点星标不能顺带打开文档（.file 行是 pointerdown/pointerup 触发 openFile 的）
  await page.click(star1);
  await page.waitForTimeout(500);
  check('点星标后 aria-pressed=true', await page.getAttribute(star1, 'aria-pressed'), 'true');
  check('行上加了 .favorite', await page.locator(`${fileRow('one.html')}.favorite`).count(), 1);
  check('点星标没有打开文档（预览仍是空态）',
    await page.locator('#empty-state.hidden').count(), 0);
  check('点星标没有把这一行标 active',
    await page.locator(`${fileRow('one.html')}.active`).count(), 0);

  console.log('\n[收藏夹]');
  check('收藏夹显示出来了', await page.locator('#fav-bar.hidden').count(), 0);
  check('收藏夹有 1 条', await page.locator('#fav-list .fav-item').count(), 1);
  check('收藏夹条目名去掉了扩展名',
    (await page.textContent('#fav-list .fav-item .fav-name')).trim(), 'one');
  check('收藏夹条目带所属项目',
    (await page.textContent('#fav-list .fav-item .fav-project')).trim(), 'alpha');

  // 跨文件夹 + 顺序：再收藏 beta 分组里的一个，它应该排在最前（最近收藏在前）
  await page.click(`${fileRow('three.md')} .fav-btn`);
  await page.waitForTimeout(400);
  const favOrder = await page.$$eval('#fav-list .fav-item .fav-name',
    els => els.map(e => e.textContent.trim()));
  check('收藏夹跨文件夹聚合 2 条', favOrder.length, 2);
  check('按收藏时间倒序（最近收藏在最前）', favOrder, ['three', 'one']);

  // 收藏夹条目点击能打开文档（点 one，它此刻排在第二条）
  await page.click('#fav-list .fav-item:last-child');
  await page.waitForTimeout(700);
  check('点收藏夹条目打开了文档', await page.locator('#empty-state.hidden').count(), 1);
  check('打开的正是被点的那一条（one）',
    (await page.textContent('#crumbs')).includes('one.html'), true);
  check('树里对应行标了 active',
    await page.locator(`${fileRow('one.html')}.active`).count(), 1);
  check('收藏夹里对应条目也标了 active',
    await page.locator('#fav-list .fav-item.active .fav-name').count(), 1);

  console.log('\n[顶栏收藏按钮]');
  check('当前文件已收藏 → 顶栏按钮亮起', await page.locator('#btn-favorite.on').count(), 1);
  check('顶栏按钮 aria-pressed=true', await page.getAttribute('#btn-favorite', 'aria-pressed'), 'true');
  // 顶栏按钮取消收藏
  await page.click('#btn-favorite');
  await page.waitForTimeout(400);
  check('顶栏点一下取消收藏', await page.locator('#btn-favorite.on').count(), 0);
  check('树里的星标同步变灰', await page.getAttribute(star1, 'aria-pressed'), 'false');
  check('收藏夹只剩 1 条', await page.locator('#fav-list .fav-item').count(), 1);
  // 再收回来，供后面用
  await page.click('#btn-favorite');
  await page.waitForTimeout(400);
  check('再点一下又收藏回来', await page.locator('#btn-favorite.on').count(), 1);

  console.log('\n[收藏夹里取消收藏]');
  // 不假设顺序：取消收藏会把条目从列表里摘掉、重新收藏又会插回最前，
  // 所以先读出最后一条到底是哪个文件，再据此断言
  const lastFav = await page.getAttribute('#fav-list .fav-item:last-child', 'data-path');
  const lastName = lastFav.split('/').pop();
  await page.hover('#fav-list .fav-item:last-child');
  await page.click('#fav-list .fav-item:last-child .fav-remove');
  await page.waitForTimeout(400);
  check('✕ 取消后收藏夹剩 1 条', await page.locator('#fav-list .fav-item').count(), 1);
  check(`对应文件行（${lastName}）的 .favorite 也去掉了`,
    await page.locator(`${fileRow(lastName)}.favorite`).count(), 0);
  // 清空最后一条 → 整个收藏夹隐藏
  await page.hover('#fav-list .fav-item');
  await page.click('#fav-list .fav-item .fav-remove');
  await page.waitForTimeout(400);
  check('收藏清空后收藏夹整块隐藏', await page.locator('#fav-bar.hidden').count(), 1);

  console.log('\n[星标不被当成拖拽把手]');
  // 星标是常驻按钮、位置就在 SortableJS 的拖拽把手区里。如果没加进 Sortable 的
  // filter，在星标上按下并移动就会开始拖这一行——拖完 onEnd 还会把排序模式
  // 强行切到「自定义」，用户完全没想拖动却发现排序变了。
  await page.click('.seg-btn[data-sort="name"]');
  const orderBefore = await page.$$eval('.tree .file', els => els.map(e => e.dataset.path));
  const starBox = await page.locator(`${fileRow('two.html')} .fav-btn`).boundingBox();
  await page.mouse.move(starBox.x + starBox.width / 2, starBox.y + starBox.height / 2);
  await page.mouse.down();
  // 移动远超 touchStartThreshold(5px)，足够让未被 filter 排除的元素启动拖拽
  await page.mouse.move(starBox.x + starBox.width / 2, starBox.y + 70, { steps: 12 });
  await page.waitForTimeout(200);
  check('在星标上拖动不会产生拖拽 ghost',
    await page.locator('.dragging-ghost').count(), 0);
  await page.mouse.up();
  await page.waitForTimeout(400);
  check('排序模式没被拖拽切到「自定义」',
    await page.getAttribute('.seg-btn[data-sort="name"]', 'aria-checked'), 'true');
  check('树的顺序没变',
    await page.$$eval('.tree .file', els => els.map(e => e.dataset.path)), orderBefore);
  // 但按下-抬起落在同一点时，它仍然是个正常按钮
  check('星标本身仍可点（two 被收藏）',
    await page.locator(`${fileRow('two.html')}.favorite`).count(), 0);
  await page.click(`${fileRow('two.html')} .fav-btn`);
  await page.waitForTimeout(400);
  check('点一下确实收藏成功', await page.locator(`${fileRow('two.html')}.favorite`).count(), 1);
  await page.click(`${fileRow('two.html')} .fav-btn`);   // 收回，避免影响后续断言
  await page.waitForTimeout(400);

  console.log('\n[服务端持久化]');
  await page.click(star1);
  await page.waitForTimeout(500);
  const storeFav = atlas.readStore().favorites || {};
  const oneAbs = atlas.filePath('alpha/one.html');
  check('store.json 里落盘了 favorites', Object.keys(storeFav), [oneAbs]);
  check('存的是收藏时间戳而不是 true', typeof storeFav[oneAbs], 'number');

  // 折叠状态持久化
  await page.click('#fav-toggle');
  await page.waitForTimeout(200);
  check('点标题栏按钮收起收藏夹', await page.locator('#fav-bar.collapsed').count(), 1);
  check('收起状态写入 localStorage',
    await page.evaluate(() => localStorage.getItem('atlas:favCollapsed')), '1');
  await page.reload();
  // 收起态下 .fav-list 是 display:none，所以只能等"挂上 DOM"而不是"可见"
  await page.waitForSelector('#fav-list .fav-item', { state: 'attached' });
  check('刷新后仍是收起态', await page.locator('#fav-bar.collapsed').count(), 1);
  check('刷新后收藏仍在（服务端来的）', await page.locator('#fav-list .fav-item').count(), 1);
  await page.click('#fav-toggle');   // 展开回来
  await page.waitForTimeout(200);

  // ============ ② 标签 ============
  console.log('\n[标签：编辑]');
  await page.hover(fileRow('one.html'));
  await page.click(`${fileRow('one.html')} [data-act="tags"]`);
  // 故意塞入重复、大小写不同、空白项，验证服务端规范化
  await fillPrompt(page, '周报, AI , ai, 周报, , 待评审');
  await page.waitForTimeout(500);
  const tagsOnRow = await page.$$eval(`${fileRow('one.html')} .file-tag`,
    els => els.map(e => e.textContent.trim()));
  check('去重 + 大小写合并（AI/ai 只留一个，保留首次写法）',
    atlas.readStore().tags[oneAbs], ['周报', 'AI', '待评审']);
  check('行上最多显示 2 个标签 + “+N”', tagsOnRow, ['周报', 'AI', '+1']);
  check('完整标签列表进了 title 提示',
    /🏷 周报 · AI · 待评审/.test(await page.getAttribute(fileRow('one.html'), 'title')), true);

  // 「取消」和「清空后确定」都会让 showPrompt 返回 null，实现里必须区分这两者，
  // 否则要么点取消把标签清了，要么永远清不掉标签
  await page.hover(fileRow('one.html'));
  await page.click(`${fileRow('one.html')} [data-act="tags"]`);
  await page.waitForSelector('.atlas-dialog .dialog-input');
  check('输入框预填了当前标签',
    await page.inputValue('.atlas-dialog .dialog-input'), '周报, AI, 待评审');
  await page.click('.atlas-dialog .dialog-cancel');
  await page.waitForSelector('.atlas-dialog', { state: 'detached' });
  await page.waitForTimeout(300);
  check('点「取消」不会清掉已有标签',
    atlas.readStore().tags[oneAbs], ['周报', 'AI', '待评审']);

  console.log('\n[标签筛选条]');
  check('筛选条显示出来了', await page.locator('#tag-bar.hidden').count(), 0);
  const chipNames = await page.$$eval('#tag-bar .tag-chip .tag-chip-name',
    els => els.map(e => e.textContent.trim()));
  check('三个标签都成了 chip', chipNames.sort(), ['AI', '周报', '待评审']);
  check('chip 上带用量计数',
    (await page.textContent('#tag-bar .tag-chip .tag-chip-count')).trim(), '1');

  // 给另一个文件也打上「周报」，让计数变 2 并可验证筛选
  await page.hover(fileRow('three.md'));
  await page.click(`${fileRow('three.md')} [data-act="tags"]`);
  await fillPrompt(page, '周报');
  await page.waitForTimeout(500);
  const weekly = await page.locator('#tag-bar .tag-chip', { hasText: '周报' }).first();
  check('「周报」计数变成 2',
    (await weekly.locator('.tag-chip-count').textContent()).trim(), '2');
  check('筛选条按用量倒序（周报排第一）',
    (await page.textContent('#tag-bar .tag-chip:first-child .tag-chip-name')).trim(), '周报');

  console.log('\n[按标签筛选]');
  await weekly.click();
  await page.waitForTimeout(300);
  let visible = await page.$$eval('.tree .file', els => els.map(e => e.dataset.path.split('/').pop()));
  check('点 chip 后只剩带该标签的文档', visible.sort(), ['one.html', 'three.md']);
  check('chip 进入选中态', await page.locator('#tag-bar .tag-chip.on').count(), 1);
  check('aria-pressed=true', await weekly.getAttribute('aria-pressed'), 'true');
  check('出现「清除」按钮', await page.locator('#tag-bar-clear.hidden').count(), 0);
  check('不带标签的分组被整个剪掉',
    await page.locator('.tree .folder').count(), 2);

  // 多标签 = AND（同时具备），不是 OR
  const aiChip = page.locator('#tag-bar .tag-chip', { hasText: 'AI' }).first();
  await aiChip.click();
  await page.waitForTimeout(300);
  visible = await page.$$eval('.tree .file', els => els.map(e => e.dataset.path.split('/').pop()));
  check('多选标签是 AND（只剩同时有「周报」和「AI」的）', visible, ['one.html']);
  check('两个 chip 都是选中态', await page.locator('#tag-bar .tag-chip.on').count(), 2);

  await page.click('#tag-bar-clear');
  await page.waitForTimeout(300);
  check('清除后所有文档回来', await page.locator('.tree .file').count(), 4);
  check('清除后没有选中的 chip', await page.locator('#tag-bar .tag-chip.on').count(), 0);
  check('「清除」按钮自己隐藏', await page.locator('#tag-bar-clear.hidden').count(), 1);

  console.log('\n[筛选叠加]');
  // 标签筛选 + 搜索：必须 AND
  await weekly.click();
  await page.fill('#search', 'three');
  await page.waitForTimeout(700);
  visible = await page.$$eval('.tree .file', els => els.map(e => e.dataset.path.split('/').pop()));
  check('标签 + 搜索 = AND', visible, ['three.md']);
  await page.fill('#search', '');
  await page.waitForTimeout(500);

  // 标签筛选 + 仅未读：给从没打开过的 two.html 也打上「周报」，
  // 再把 three.md 点开变已读 —— 勾上「仅未读」后应该只剩 two.html
  // （one.html 前面点收藏夹时已经打开过，也是已读）
  await page.click('#tag-bar-clear');
  await page.hover(fileRow('two.html'));
  await page.click(`${fileRow('two.html')} [data-act="tags"]`);
  await fillPrompt(page, '周报');
  await page.waitForTimeout(500);
  await page.click(fileRow('three.md'));
  await page.waitForTimeout(700);
  await page.locator('#tag-bar .tag-chip', { hasText: '周报' }).first().click();
  await page.waitForTimeout(300);
  visible = await page.$$eval('.tree .file', els => els.map(e => e.dataset.path.split('/').pop()));
  check('三个文档都带「周报」', visible.sort(), ['one.html', 'three.md', 'two.html']);
  await page.check('#only-unread');
  await page.waitForTimeout(300);
  visible = await page.$$eval('.tree .file', els => els.map(e => e.dataset.path.split('/').pop()));
  check('标签 + 仅未读 = AND（已读的两个被滤掉）', visible, ['two.html']);
  await page.uncheck('#only-unread');
  await page.click('#tag-bar-clear');
  await page.waitForTimeout(300);
  // 把 two.html 的标签清掉，恢复到进入本节前的状态
  await page.hover(fileRow('two.html'));
  await page.click(`${fileRow('two.html')} [data-act="tags"]`);
  await fillPrompt(page, '');
  await page.waitForTimeout(400);

  console.log('\n[标签：清空与超量]');
  await page.hover(fileRow('three.md'));
  await page.click(`${fileRow('three.md')} [data-act="tags"]`);
  await fillPrompt(page, '');   // 清空
  await page.waitForTimeout(500);
  check('清空后行上不再有标签',
    await page.locator(`${fileRow('three.md')} .file-tag`).count(), 0);
  check('清空即从 store 删 key（不留空数组）',
    atlas.filePath('beta/three.md') in (atlas.readStore().tags || {}), false);
  check('「周报」计数回到 1',
    (await page.locator('#tag-bar .tag-chip', { hasText: '周报' }).first()
      .locator('.tag-chip-count').textContent()).trim(), '1');

  await page.hover(fileRow('two.html'));
  await page.click(`${fileRow('two.html')} [data-act="tags"]`);
  await fillPrompt(page, [...Array(20)].map((_, i) => 't' + i).join(', '));
  await page.waitForTimeout(500);
  check('标签数量上限截断到 12（不报错）',
    (atlas.readStore().tags[atlas.filePath('alpha/two.html')] || []).length, 12);

  // 清空全部标签 → 筛选条整块隐藏
  for (const [name, rel] of [['one.html', 'alpha/one.html'], ['two.html', 'alpha/two.html']]) {
    await page.hover(fileRow(name));
    await page.click(`${fileRow(name)} [data-act="tags"]`);
    await fillPrompt(page, '');
    await page.waitForTimeout(400);
    void rel;
  }
  check('所有标签清空后筛选条隐藏', await page.locator('#tag-bar.hidden').count(), 1);

  // ============ ③ 重命名后收藏 / 标签跟随 ============
  console.log('\n[重命名后元数据跟随]');
  await page.hover(fileRow('one.html'));
  await page.click(`${fileRow('one.html')} [data-act="tags"]`);
  await fillPrompt(page, '归档');
  await page.waitForTimeout(400);
  const renamed = await page.evaluate(async (p) => {
    const r = await fetch('/api/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p, name: 'one-renamed.html' }),
    });
    return { status: r.status, body: await r.json() };
  }, oneAbs);
  check('重命名成功', renamed.status, 200);
  const st = atlas.readStore();
  const newAbs = atlas.filePath('alpha/one-renamed.html');
  check('收藏跟着新路径走', !!(st.favorites || {})[newAbs], true);
  check('标签跟着新路径走', (st.tags || {})[newAbs], ['归档']);
  check('旧路径的收藏被清掉', oneAbs in (st.favorites || {}), false);
  check('旧路径的标签被清掉', oneAbs in (st.tags || {}), false);

  // ============ ④ 筛选时命中分组必须可见 ============
  // 日常使用里分组大多是折叠着的。如果筛选不忽略折叠状态，命中的文件虽然进了 DOM
  // 却全在折叠的分组里 —— 屏幕上一个结果都看不到，表现为"筛选了但什么都没出来"、
  // "清除筛选后文档也没回来"。这个毛病搜索与「仅未读」从 0.2.0 起就有，
  // 标签筛选继承了它，0.10.1 一起修掉。
  console.log('\n[折叠状态下筛选：命中结果必须可见]');
  await page.evaluate(() => {
    const ids = [...document.querySelectorAll('.tree .folder')].map(f => f.dataset.folderId);
    localStorage.setItem('atlas:collapsed', JSON.stringify(ids));
  });
  await page.reload();
  await page.waitForSelector('.tree .file', { state: 'attached' });
  await page.waitForTimeout(900);

  const vis = () => page.evaluate(() => ({
    visible: [...document.querySelectorAll('.tree .file')].filter(e => e.offsetParent !== null).length,
    collapsed: document.querySelectorAll('.tree .folder.collapsed').length,
    lsCollapsed: JSON.parse(localStorage.getItem('atlas:collapsed') || '[]').length,
  }));

  const base = await vis();
  check('前置：全部分组折叠，屏幕上看不到任何文档', base.visible, 0);
  check('前置：localStorage 记下了折叠偏好', base.lsCollapsed > 0, true);

  // 标签筛选
  await page.locator('#tag-bar .tag-chip', { hasText: '归档' }).first().click();
  await page.waitForTimeout(400);
  let v = await vis();
  check('标签筛选后命中结果可见（修复前是 0）', v.visible, 1);
  check('命中分组被自动展开', v.collapsed, 0);
  await page.click('#tag-bar-clear');
  await page.waitForTimeout(500);
  v = await vis();
  check('清除筛选后折叠状态原样恢复', v.collapsed, base.collapsed);
  check('折叠偏好没被筛选改写', v.lsCollapsed, base.lsCollapsed);

  // 搜索
  await page.fill('#search', 'three');
  await page.waitForTimeout(800);
  v = await vis();
  check('搜索命中结果同样可见', v.visible > 0, true);
  check('搜索时命中分组自动展开', v.collapsed, 0);
  await page.fill('#search', '');
  await page.waitForTimeout(800);
  check('清空搜索后折叠状态恢复', (await vis()).collapsed, base.collapsed);

  // 仅未读
  await page.check('#only-unread');
  await page.waitForTimeout(400);
  v = await vis();
  check('「仅未读」命中结果同样可见', v.visible > 0, true);
  check('「仅未读」时命中分组自动展开', v.collapsed, 0);
  await page.uncheck('#only-unread');
  await page.waitForTimeout(400);
  check('取消「仅未读」后折叠状态恢复', (await vis()).collapsed, base.collapsed);

  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();

  console.log('\n========================');
  console.log(`总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('spec 自身出错:', e);
  process.exit(1);
});
