//
// 回归：一级（顶层）文件夹重命名后，刷新页面名字就丢了 —— 但有时又能存住。
//
// 两个缺陷叠加，各占一半：
//
//   ① 服务端把「名字」当成了分组的身份。自动生成的顶层分组对应扫描根下的一个
//      一级目录（file.projectName），两者之间唯一的联系就是"名字恰好相同"。
//      于是用户一改名，reconcile 就认不出它了：
//        · 新文件进来时按名字找不到 → 又 push 一个自动名的新分组
//        · 分组一旦临时变空（AI 覆盖写会先 unlink 再 add、扫描根短暂不可达）
//          就被 pruneEmptyFolders 删掉，下一轮按 projectName 用自动名重建
//      现在分组带一个稳定的 autoFor 键，改名后照样认得。
//
//   ② 前端的 lost update。scheduleSaveTree 是 250ms 防抖，而请求体原来是在
//      定时器触发那一刻才现取 state.tree —— 这 250ms 里任何一次 fetchState
//      返回都会把 state.tree 整体换成服务端的版本（上面还是旧名字，因为改动
//      还没发出去），于是自己的保存请求把自己的改动覆盖掉了，界面上却显示
//      "已保存"。这解释了"偶发"：取决于扫描 / SSE / 60s 轮询什么时候回来。
//
// 顺带覆盖同源的两个相邻缺陷：
//   · 手工新建的空分组会在下一次 /api/state 被当成空壳清掉（"新建分组立刻消失"）
//   · 改过名的顶层分组归档不掉（/api/archive 也是按 name 过滤的）
//
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

const topFolders = (tree) => tree.filter(n => n.type === 'folder').map(n => n.name);
const findTop = (tree, name) => tree.find(n => n.type === 'folder' && n.name === name);

// 动过磁盘之后必须等一下：chokidar 配了 awaitWriteFinish（300ms 稳定期），
// 文件索引不是同步更新的。不等就会拿到旧的扫描结果，断言全是假失败。
const settle = (ms = 900) => new Promise(r => setTimeout(r, ms));

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-folder-rename-',
    files: {
      'alpha/a1.html': '<!doctype html><html><body><h1>a1</h1></body></html>',
      'alpha/a2.html': '<!doctype html><html><body><h1>a2</h1></body></html>',
      'beta/b1.md': '# b1\n',
    },
  });

  // ================================================================
  console.log('\n[① 服务端：改名后 reconcile 还认得这个分组]');

  let state = await api(atlas.base, 'GET', '/api/state');
  check('初始有 alpha / beta 两个顶层分组', topFolders(state.tree).sort(), ['alpha', 'beta']);

  const alpha = findTop(state.tree, 'alpha');
  check('自动生成的分组带 autoFor 身份键', alpha.autoFor, 'alpha');

  // 模拟用户重命名：改 name，autoFor 保持不变，整树 PUT（前端就是这么做的）
  alpha.name = '我的项目';
  let put = await api(atlas.base, 'PUT', '/api/tree', { tree: state.tree });
  check('改名后的树能通过校验', put.ok, true);

  state = await api(atlas.base, 'GET', '/api/state');
  check('刷新后名字保住了', topFolders(state.tree).sort(), ['beta', '我的项目']);
  check('没有冒出一个自动名的新分组', topFolders(state.tree).includes('alpha'), false);
  check('autoFor 仍指向原项目目录', findTop(state.tree, '我的项目').autoFor, 'alpha');

  // ================================================================
  console.log('\n[② 新文件要归进改名后的分组，而不是新建一个]');

  fs.writeFileSync(atlas.filePath('alpha/a3.html'),
    '<!doctype html><html><body><h1>a3</h1></body></html>');
  await settle();
  state = await api(atlas.base, 'GET', '/api/state');
  check('仍然只有两个顶层分组', topFolders(state.tree).sort(), ['beta', '我的项目']);
  const renamed = findTop(state.tree, '我的项目');
  check('新文件进了改名后的分组', renamed.children.filter(c => c.type === 'file').length, 3);

  // ================================================================
  console.log('\n[③ 分组临时变空也不能把名字弄丢]');
  // AI 覆盖写文件时 chokidar 会先收到 unlink 再收到 add，中间那一瞬分组是空的。
  // 原来这一瞬会被 pruneEmptyFolders 删掉，名字随之永久丢失。
  for (const f of ['alpha/a1.html', 'alpha/a2.html', 'alpha/a3.html']) {
    fs.unlinkSync(atlas.filePath(f));
  }
  await settle();
  state = await api(atlas.base, 'GET', '/api/state');
  check('文件全没了，改过名的分组仍在', topFolders(state.tree).includes('我的项目'), true);
  check('此时它是个空分组', findTop(state.tree, '我的项目').children.length, 0);

  // 文件回来后应该还是归进这个分组
  fs.writeFileSync(atlas.filePath('alpha/a1.html'),
    '<!doctype html><html><body><h1>a1 回来了</h1></body></html>');
  await settle();
  state = await api(atlas.base, 'GET', '/api/state');
  check('文件回来后仍归进原分组', topFolders(state.tree).sort(), ['beta', '我的项目']);
  check('没有重建自动名分组', topFolders(state.tree).includes('alpha'), false);

  // ================================================================
  console.log('\n[④ 未改名的自动空壳该照旧回收]');
  // 这是 pruneEmptyFolders 原本的职责，不能因为上面的例外而失效
  fs.unlinkSync(atlas.filePath('beta/b1.md'));
  await settle();
  state = await api(atlas.base, 'GET', '/api/state');
  check('没改过名的分组，空了就回收', topFolders(state.tree).includes('beta'), false);

  // ================================================================
  console.log('\n[⑤ 手工新建的空分组不该被当成空壳清掉]');
  const created = await api(atlas.base, 'POST', '/api/folders/new', { name: '待归类' });
  check('新建成功', created.name, '待归类');
  check('手工建的分组没有 autoFor', created.autoFor, undefined);
  state = await api(atlas.base, 'GET', '/api/state');
  check('刷新后新建的空分组还在', topFolders(state.tree).includes('待归类'), true);

  // ================================================================
  console.log('\n[⑥ 改过名的分组也要能归档]');
  // /api/archive 原来按 n.name === name 过滤顶层分组，改过名的分组归档不掉
  await api(atlas.base, 'POST', '/api/archive', { name: 'alpha' });
  state = await api(atlas.base, 'GET', '/api/state');
  check('归档后改过名的分组从树里消失', topFolders(state.tree).includes('我的项目'), false);
  await api(atlas.base, 'POST', '/api/archive/restore', { name: 'alpha' });
  state = await api(atlas.base, 'GET', '/api/state');
  check('取消归档后带着原名字回来', findTop(state.tree, '我的项目').autoFor, 'alpha');

  // ================================================================
  console.log('\n[⑦ 前端：改名后紧接着一次 fetchState，不能把改动冲掉]');
  // 这是 lost update 那一半。在浏览器里跑：双击改名 → 立刻手动触发 fetchState
  //（等价于 SSE / 60s 轮询 / 切回标签页恰好在 250ms 防抖窗口里返回），
  // 然后等保存落盘，读 store.json 看真正写进磁盘的是哪个名字。
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(atlas.base);
  await page.waitForSelector('.folder-name');

  const target = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.folder-name')]
      .find(e => e.textContent.trim() === '我的项目');
    return el ? el.textContent.trim() : null;
  });
  check('页面上能看到改过名的分组', target, '我的项目');

  await page.evaluate(async () => {
    const el = [...document.querySelectorAll('.folder-name')]
      .find(e => e.textContent.trim() === '我的项目');
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForSelector('.folder-name[contenteditable="true"]');
  await page.evaluate(() => {
    const el = document.querySelector('.folder-name[contenteditable="true"]');
    el.textContent = '二次改名';
  });
  // 提交（Enter → blur → finish → onCommit → scheduleSaveTree 排程）
  await page.keyboard.press('Enter');
  // 立刻插一次 fetchState：服务端此刻返回的树上还是「我的项目」。
  // 修复前这一下会把内存里的新名字冲掉，随后那次 PUT 就把旧名字写回磁盘。
  await page.evaluate(() => window.fetchState && window.fetchState());
  await page.waitForTimeout(1200);

  const store = atlas.readStore();
  const persisted = (store.tree || [])
    .filter(n => n.type === 'folder')
    .map(n => n.name);
  check('磁盘上存的是新名字', persisted.includes('二次改名'), true);
  check('旧名字没有被写回', persisted.includes('我的项目'), false);

  // 再确认一次：重新加载页面后看到的还是新名字
  await page.reload();
  await page.waitForSelector('.folder-name');
  const afterReload = await page.evaluate(() =>
    [...document.querySelectorAll('.folder-name')].map(e => e.textContent.trim()));
  check('重新加载后页面上仍是新名字', afterReload.includes('二次改名'), true);

  // ================================================================
  console.log('\n[⑧ 前端：编辑进行中不能被 render() 打断]');
  // fetchState → render() 第一件事是 innerHTML=''，会把正在输入的
  // contenteditable 节点摘掉；浏览器移除聚焦元素不触发 blur，提交回调不执行，
  // 敲进去的字就静默丢了。
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.folder-name')]
      .find(e => e.textContent.trim() === '二次改名');
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForSelector('.folder-name[contenteditable="true"]');
  await page.evaluate(() => {
    const el = document.querySelector('.folder-name[contenteditable="true"]');
    el.textContent = '编辑中改名';
  });
  // 编辑还没提交，此时来一次全量刷新
  await page.evaluate(() => window.fetchState && window.fetchState());
  await page.waitForTimeout(300);
  const stillEditing = await page.evaluate(() =>
    !!document.querySelector('.folder-name[contenteditable="true"]'));
  check('刷新没有打断正在进行的编辑', stillEditing, true);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const store2 = atlas.readStore();
  const persisted2 = (store2.tree || [])
    .filter(n => n.type === 'folder').map(n => n.name);
  check('被刷新打断过的编辑仍然存住了', persisted2.includes('编辑中改名'), true);

  await browser.close();
  await atlas.stop();
  console.log(`\n总计 ${total} 项，${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
