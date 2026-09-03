// 归档口径一致性 + 全部折叠
//
// 两组回归：
//   ① 归档只在 reconcile 里被过滤过，/api/state 的 fileMap 却用的是全量扫描结果，
//      于是底栏「N 篇文档 · M 未读」把已归档的文档也算进去了 —— 而"全部标为已读"
//      走的是已过滤的 store.tree，怎么点都清不掉那几篇。现在树 / 统计 / 未读 /
//      正文搜索共用同一个可见集合。
//      顺带覆盖：mtime 落在未来的文件也必须能被标为已读（seen 写 max(now, mtime)）。
//   ② 全部文档标题栏的「全部折叠 / 全部展开」按钮：分组多时逐个点开点关最费手。
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
let total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`
    + (ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`));
}

const api = async (base, method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-archive-',
    files: {
      'keep-a/one.html': '<!doctype html><html><body><h1>keep a one</h1><p>关键词 桃子</p></body></html>',
      'keep-a/two.html': '<!doctype html><html><body><h1>keep a two</h1></body></html>',
      'keep-b/three.md': '# keep b three\n',
      'gone/x.html': '<!doctype html><html><body><h1>gone x</h1><p>关键词 桃子</p></body></html>',
      'gone/y.html': '<!doctype html><html><body><h1>gone y</h1></body></html>',
      'gone/z.md': '# gone z\n\n关键词 桃子\n',
    },
  });

  // 把一个文件的 mtime 推到 1 小时后：模拟时钟漂移 / 网络盘 / 被 touch 到未来。
  // 未读判定是 seen < mtime，如果"标为已读"只写 Date.now()，这一篇永远清不掉红点。
  const future = new Date(Date.now() + 3600 * 1000);
  fs.utimesSync(atlas.filePath('keep-b/three.md'), future, future);

  console.log('\n[①-1 归档前：全部可见]');
  let st = await api(atlas.base, 'GET', '/api/state');
  check('files 含全部 6 篇', Object.keys(st.files).length, 6);
  check('未读 6 篇（从没打开过）', Object.values(st.files).filter(f => f.unread).length, 6);

  console.log('\n[①-2 归档 gone 分组]');
  await api(atlas.base, 'POST', '/api/archive', { name: 'gone' });
  st = await api(atlas.base, 'GET', '/api/state');
  const visiblePaths = Object.keys(st.files);
  check('files 只剩 3 篇（归档的不再出现在统计口径里）', visiblePaths.length, 3);
  check('files 里没有 gone/ 下的文档', visiblePaths.filter(p => p.includes(`${path.sep}gone${path.sep}`)), []);
  check('tree 里也没有 gone 分组',
    (st.tree || []).filter(n => n.type === 'folder').map(n => n.name).sort(), ['keep-a', 'keep-b']);
  check('scannedCount 与 files 口径一致', st.scannedCount, 3);

  console.log('\n[①-3 全部标为已读]');
  await api(atlas.base, 'POST', '/api/seen/all');
  st = await api(atlas.base, 'GET', '/api/state');
  const stillUnread = Object.values(st.files).filter(f => f.unread).map(f => f.name);
  check('可见文档一篇未读都不剩', stillUnread, []);
  // 单独点出来：这一篇 mtime 在未来，是 markSeenAt 的 max 逻辑在起作用
  check('mtime 在未来的文档也标成了已读', st.files[atlas.filePath('keep-b/three.md')].unread, false);

  console.log('\n[①-4 正文搜索不该捞出归档文档]');
  const found = await api(atlas.base, 'GET', '/api/search?q=' + encodeURIComponent('桃子'));
  check('「桃子」在 3 个文件里，但只命中未归档的那 1 个',
    (found.matches || []).map(m => path.basename(m.path)), ['one.html']);

  console.log('\n[①-5 取消归档后原样回来]');
  await api(atlas.base, 'POST', '/api/archive/restore', { name: 'gone' });
  st = await api(atlas.base, 'GET', '/api/state');
  check('files 回到 6 篇', Object.keys(st.files).length, 6);
  // 归档期间没被标过已读，回来时仍是未读 —— 符合"归档只是隐藏"的语义
  check('恢复出来的 3 篇仍是未读',
    Object.values(st.files).filter(f => f.unread).map(f => f.name).sort(),
    ['x.html', 'y.html', 'z.md']);

  // ============ ② UI ============
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // 重新归档，验证前端底栏统计（这是用户实际看到的那行字）
  await api(atlas.base, 'POST', '/api/archive', { name: 'gone' });
  await api(atlas.base, 'POST', '/api/seen/all');
  await page.goto(atlas.base);
  await page.waitForSelector('.tree .file');
  await page.waitForFunction(() => document.querySelectorAll('.tree .file').length === 3);

  console.log('\n[①-6 底栏统计与首页待看]');
  check('底栏显示「3 篇文档 · 全部已读」', (await page.textContent('#stats')).trim(), '3 篇文档 · 全部已读');
  check('底栏没有未读徽标', await page.locator('#stats .stat-unread').count(), 0);
  check('首页「待看」为空态（收件箱清空的庆祝态）', (await page.textContent('#home-grid')).includes('收件箱清空了'), true);

  console.log('\n[②-1 全部折叠按钮]');
  const btn = '#btn-collapse-all';
  const useHref = () => page.getAttribute('#collapse-all-ico', 'href');
  const collapsedCount = () => page.locator('.tree .folder.collapsed').count();
  const folderCount = () => page.locator('.tree .folder').count();

  check('按钮存在', await page.locator(btn).count(), 1);
  check('初始 aria-label=全部折叠', await page.getAttribute(btn, 'aria-label'), '全部折叠');
  check('初始图标是 collapse-all', await useHref(), '#i-collapse-all');
  check('初始没有折叠的分组', await collapsedCount(), 0);

  const folders = await folderCount();
  check('树里有 2 个分组', folders, 2);

  await page.click(btn);
  await page.waitForTimeout(200);
  check('点一下：所有分组都折叠了', await collapsedCount(), folders);
  check('按钮翻转成「全部展开」', await page.getAttribute(btn, 'aria-label'), '全部展开');
  check('图标翻转成 expand-all', await useHref(), '#i-expand-all');
  check('折叠状态写进了 localStorage',
    await page.evaluate(() => JSON.parse(localStorage.getItem('atlas:collapsed') || '[]').length), folders);
  check('折叠后文件行不可见', await page.locator('.tree .file').first().isVisible(), false);

  console.log('\n[②-2 再点一下全部展开]');
  await page.click(btn);
  await page.waitForTimeout(200);
  check('所有分组都展开了', await collapsedCount(), 0);
  check('按钮回到「全部折叠」', await page.getAttribute(btn, 'aria-label'), '全部折叠');
  check('localStorage 已清空',
    await page.evaluate(() => JSON.parse(localStorage.getItem('atlas:collapsed') || '[]')), []);
  check('文件行重新可见', await page.locator('.tree .file').first().isVisible(), true);

  console.log('\n[②-3 折叠状态刷新后保持]');
  await page.click(btn);
  await page.waitForTimeout(200);
  await page.reload();
  await page.waitForSelector('.tree .folder');
  await page.waitForTimeout(400);
  check('刷新后仍是全部折叠', await collapsedCount(), folders);
  check('刷新后按钮仍显示「全部展开」', await page.getAttribute(btn, 'aria-label'), '全部展开');

  console.log('\n[②-4 筛选生效时禁用（树被强制展开，折叠不会有视觉变化）]');
  await page.click(btn);   // 先全部展开，回到干净状态
  await page.waitForTimeout(200);
  await page.fill('#search', 'one');
  await page.waitForTimeout(500);
  check('搜索中按钮 disabled', await page.isDisabled(btn), true);
  check('title 说明了原因', await page.getAttribute(btn, 'title'), '筛选中：分组已强制展开');
  await page.fill('#search', '');
  await page.waitForTimeout(500);
  check('清空搜索后按钮恢复可用', await page.isDisabled(btn), false);

  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();

  console.log('\n========================');
  console.log(failures === 0 ? `总计 ${total} 项，全部通过` : `总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
