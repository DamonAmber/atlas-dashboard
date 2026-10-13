// 筛选口径统一（design §13.1）：标签 / 仅未读 / 搜索单独或组合生效时，各处数字出自同一次
// fileMatches() 结果（filterSnapshot()），且彼此一致：
//   · 首页筛选条 #tag-strip-hits 的「命中 n 篇」 == 目录树 #tree-count 的「命中」 == filterSnapshot().size
//   · 首页待看 #home-feed-count == 命中 ∩ 未读
//   · #tree-count 的「/总数」 == 底栏 #stats 的「N 篇文档」（#stats 保持全量文案）
// 另外用 fixture 的已知答案核对命中数本身，避免"几处一起算错也相等"。
// 星图：HUD 命中数 / 筛选状态条命中数 / 星表里全部星团的 .sm-star 总数 == filterSnapshot 大小。
// 时间河流时间段：单项与「时间段 + 标签」组合下，上面各处数字与首页「该时段改动了 N 篇」的 N、
// 星图 HUD / 星表同样一致（p1 的 4 篇 mtime 被挪到 30 小时前，「24 小时」预设命中其余 8 篇）。
const { chromium } = require('playwright');
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

// 3 个项目 × 4 篇 = 12 篇。标签与已读按下表布置，期望值都能手算：
//   alpha：p1/a1 p1/a2 p2/b1 p3/c1（4 篇）      beta：p1/a1 p2/b1 p2/b2（3 篇）
//   已读：p1/a1 p2/b2 p3/c1 p3/c2 → 未读 8 篇
//   搜索 "p2" 只命中 p2 下的 4 篇（相对路径含 p2；正文里没有这个词）
const FILES = {};
for (const [proj, k] of [['p1', 'a'], ['p2', 'b'], ['p3', 'c']]) {
  for (let i = 1; i <= 4; i++) FILES[`${proj}/${k}${i}.md`] = `# 文档 ${k}${i}\n\n普通正文。\n`;
}
const TAGS = {
  'p1/a1.md': ['alpha', 'beta'],
  'p1/a2.md': ['alpha'],
  'p2/b1.md': ['alpha', 'beta'],
  'p2/b2.md': ['beta'],
  'p3/c1.md': ['alpha'],
};
const SEEN = ['p1/a1.md', 'p2/b2.md', 'p3/c1.md', 'p3/c2.md'];
const fs = require('fs');

(async () => {
  const atlas = await startAtlas({ prefix: 'atlas-filter-consistency-', files: FILES });
  // 时间段用例的布置：p1 的 4 篇挪到 30 小时前（watcher 记成 c 事件；已读稍后再标，不受影响）
  await new Promise(r => setTimeout(r, 600));
  const old = new Date(Date.now() - 30 * 3_600_000);
  for (let i = 1; i <= 4; i++) fs.utimesSync(atlas.filePath(`p1/a${i}.md`), old, old);
  await new Promise(r => setTimeout(r, 1200));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(atlas.base);
  await page.waitForSelector('.tree .file');

  await page.evaluate(async ({ tags, seen }) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const [p, t] of Object.entries(tags)) await post('/api/tags', { path: p, tags: t });
    for (const p of seen) await post('/api/seen', { path: p });
  }, {
    tags: Object.fromEntries(Object.entries(TAGS).map(([rel, t]) => [atlas.filePath(rel), t])),
    seen: SEEN.map(rel => atlas.filePath(rel)),
  });
  await page.evaluate(() => fetchState());
  await page.waitForFunction(() => document.querySelectorAll('#tag-bar .tag-chip').length === 2);
  await page.waitForTimeout(300);

  // 读一遍各处的数字
  const read = () => page.evaluate(() => {
    const snap = filterSnapshot();
    const tc = document.getElementById('tree-count').textContent.trim();
    const [tcHit, tcTotal] = tc.includes('/') ? tc.split('/').map(Number) : [Number(tc), Number(tc)];
    const hitsEl = document.getElementById('tag-strip-hits');
    const statsN = Number((document.getElementById('stats').textContent.match(/(\d+)\s*篇文档/) || [])[1]);
    const feedText = document.getElementById('home-feed-count').textContent.trim();
    const feedTitle = document.getElementById('home-feed-title').textContent.trim();
    return {
      feedTitle,
      feedTitleN: Number((feedTitle.match(/改动了 (\d+) 篇$/) || [])[1]),
      chip: !document.getElementById('time-filter-chip').classList.contains('hidden'),
      active: snap.active,
      snap: snap.size,
      snapUnread: [...snap.hits].filter(p => state.files[p] && state.files[p].unread).length,
      treeHit: tcHit,
      treeTotal: tcTotal,
      treeHasSlash: tc.includes('/'),
      treeRows: document.querySelectorAll('#tree .file').length,
      stripHits: hitsEl.dataset.hits === undefined ? null : Number(hitsEl.dataset.hits),
      stripText: hitsEl.textContent.trim(),
      feed: feedText === '' ? 0 : parseInt(feedText, 10),
      feedText,
      statsN,
      note: document.getElementById('tree-filter-note').classList.contains('hidden')
        ? null : document.getElementById('tree-filter-note').textContent.trim(),
    };
  });
  // 一组筛选下的一致性断言
  const assertConsistent = async (label, { hits, unread }) => {
    const r = await read();
    console.log(`\n[${label}]`);
    check('筛选快照处于生效态', r.active, true);
    check(`命中数 = ${hits}（fixture 期望值）`, r.snap, hits);
    check('#tag-strip-hits 的 n == filterSnapshot 大小', r.stripHits, r.snap);
    check('#tree-count 的命中 == filterSnapshot 大小', r.treeHit, r.snap);
    check('#tree-count 显示「命中 / 总数」', r.treeHasSlash, true);
    check('目录树里实际渲染的文件行 == 命中数', r.treeRows, r.snap);
    check(`待看 #home-feed-count == 命中 ∩ 未读（${unread}）`, [r.feed, r.snapUnread], [unread, unread]);
    check('#tree-count 的总数 == #stats 的 N', r.treeTotal, r.statsN);
    check('#stats 的 N 是全量 12', r.statsN, 12);
    return r;
  };

  const chip = (name) => page.locator('#tag-bar .tag-chip', { hasText: name }).first();
  const openMenu = async () => {
    if (await page.getAttribute('#btn-sort', 'aria-expanded') !== 'true') await page.click('#btn-sort');
    await page.waitForSelector('#sort-menu:not(.hidden)');
  };
  const closeMenu = async () => {
    if (await page.getAttribute('#btn-sort', 'aria-expanded') === 'true') await page.keyboard.press('Escape');
  };
  const setUnreadOnly = async (on) => {
    await openMenu();
    if (on) await page.check('#only-unread'); else await page.uncheck('#only-unread');
    await closeMenu();
    await page.waitForTimeout(200);
  };
  const search = async (q) => {
    await page.fill('#search', q);
    await page.waitForTimeout(700);   // 80ms 防抖 + 正文搜索往返
  };

  console.log('\n[无筛选]');
  let r = await read();
  check('快照未生效', r.active, false);
  check('#tree-count 只显示总数（无斜杠）', r.treeHasSlash, false);
  check('#tree-count == #stats 的 N == 12', [r.treeTotal, r.statsN], [12, 12]);
  check('首页筛选条没有命中数', r.stripHits, null);
  check('待看 = 全部未读 8', r.feed, 8);
  check('树顶无筛选提示', r.note, null);

  // ---------- 单项 ----------
  await chip('alpha').click();
  await page.waitForTimeout(200);
  r = await assertConsistent('单项：标签 alpha', { hits: 4, unread: 2 });
  check('待看计数注明按标签筛选', /已按标签「alpha」筛选/.test(r.feedText), true);
  check('树顶提示写明标签', /已按标签筛选：alpha/.test(r.note || ''), true);
  await page.click('#tag-bar-clear');
  await page.waitForTimeout(200);

  await setUnreadOnly(true);
  r = await assertConsistent('单项：仅未读', { hits: 8, unread: 8 });
  check('树顶提示「仅看未读」', /仅看未读/.test(r.note || ''), true);
  await setUnreadOnly(false);

  await search('p2');
  r = await assertConsistent('单项：搜索 p2', { hits: 4, unread: 3 });
  check('待看计数注明按搜索筛选', /已按搜索「p2」筛选/.test(r.feedText), true);
  await search('');

  // ---------- 组合 ----------
  await chip('alpha').click();
  await setUnreadOnly(true);
  r = await assertConsistent('组合：标签 alpha + 仅未读', { hits: 2, unread: 2 });
  check('树顶提示两项用「 · 」连接', /已按标签筛选：alpha · 仅看未读/.test(r.note || ''), true);
  await setUnreadOnly(false);
  await page.click('#tag-bar-clear');
  await page.waitForTimeout(200);

  await chip('alpha').click();
  await search('p2');
  await assertConsistent('组合：标签 alpha + 搜索 p2', { hits: 1, unread: 1 });
  await search('');
  await page.click('#tag-bar-clear');
  await page.waitForTimeout(200);

  // 多标签 AND：alpha ∩ beta = a1、b1，其中只有 b1 未读
  await chip('alpha').click();
  await chip('beta').click();
  await page.waitForTimeout(200);
  await assertConsistent('组合：标签 alpha + beta（AND）', { hits: 2, unread: 1 });

  // 侧栏菜单里改筛选：同一份状态，数字同样一致
  await openMenu();
  await page.locator('#sort-menu-tags .tag-chip', { hasText: 'beta' }).first().click();
  await page.waitForTimeout(200);
  await closeMenu();
  await assertConsistent('侧栏菜单取消 beta → 只剩 alpha', { hits: 4, unread: 2 });

  // 树顶提示的「清除」：标签与仅未读一起撤掉，所有数字回到全量
  await setUnreadOnly(true);
  await page.click('#tree-filter-note [data-act="clear-filter"]');
  await page.waitForTimeout(300);
  console.log('\n[树顶「清除」后]');
  r = await read();
  check('快照回到未生效', r.active, false);
  check('#tree-count 回到总数 12', [r.treeHasSlash, r.treeTotal], [false, 12]);
  check('首页筛选条无命中数', r.stripHits, null);
  check('没有选中的 chip', await page.locator('#tag-bar .tag-chip.on, #sort-menu-tags .tag-chip.on').count(), 0);
  check('仅未读已取消勾选', await page.isChecked('#only-unread'), false);
  check('待看回到全部未读 8', r.feed, 8);
  check('树顶提示隐藏', r.note, null);

  // ---------- 时间段（时间河流）----------
  const assertTime = async (label, { hits }) => {
    const r = await read();
    console.log(`\n[${label}]`);
    check('筛选快照处于生效态', r.active, true);
    check(`命中数 = ${hits}（fixture 期望值）`, r.snap, hits);
    check('#tag-strip-hits 的 n == filterSnapshot 大小', r.stripHits, r.snap);
    check('#tree-count 的命中 == filterSnapshot 大小', r.treeHit, r.snap);
    check('目录树里实际渲染的文件行 == 命中数', r.treeRows, r.snap);
    check('首页「… 改动了 N 篇」的 N == filterSnapshot 大小', r.feedTitleN, r.snap);
    check('#tree-count 的总数 == #stats 的 N == 12', [r.treeTotal, r.statsN], [12, 12]);
    check('#time-filter-chip 可见、树顶提示写明时间段', [r.chip, /时间段/.test(r.note || '')], [true, true]);
    return r;
  };
  await page.click('[data-river-preset="24"]');
  await page.waitForTimeout(200);
  await assertTime('单项：时间段「24 小时」', { hits: 8 });
  await chip('alpha').click();
  await page.waitForTimeout(200);
  r = await assertTime('组合：时间段 + 标签 alpha', { hits: 2 });
  check('标题行旁注明按标签筛选', /已按标签「alpha」筛选/.test(r.feedText), true);
  await setUnreadOnly(true);
  await assertTime('组合：时间段 + 标签 alpha + 仅未读', { hits: 1 });
  // 树顶「清除」一次撤掉标签、仅未读与时间段
  await page.click('#tree-filter-note [data-act="clear-filter"]');
  await page.waitForTimeout(300);
  r = await read();
  console.log('\n[时间段：树顶「清除」后]');
  check('快照回到未生效、时间段清除、chip 隐藏', [r.active, await page.evaluate(() => state.timeRange), r.chip], [false, null, false]);
  check('首页回到「待看」全部未读 8', [r.feedTitle, r.feed], ['待看', 8]);

  // ---------- 星图：HUD 与星表 ----------
  // 星表一次只展开一个星团，逐个激活后把 .sm-star 数加起来
  const readStarmap = () => page.evaluate(async () => {
    const body = document.getElementById('starmap-catalog-body');
    const names = [...body.querySelectorAll('.sm-cluster')].map(b => b.dataset.project);
    let stars = 0;
    for (const name of names) {
      body.querySelector(`.sm-cluster[data-project="${CSS.escape(name)}"]`).click();
      stars += body.querySelectorAll('.sm-star').length;
      body.querySelector('.cat-back').click();
    }
    const fsEl = document.getElementById('starmap-filter-status');
    return {
      snap: filterSnapshot().size,
      active: filterSnapshot().active,
      hud: Number(document.getElementById('starmap-readout').dataset.hits),
      hudTotal: Number(document.getElementById('starmap-readout').dataset.total),
      status: fsEl.classList.contains('hidden') ? null : Number(fsEl.dataset.hits),
      stars,
    };
  });
  const assertStarmap = async (label, hits) => {
    const r = await readStarmap();
    console.log(`\n[星图：${label}]`);
    check(`命中数 = ${hits}`, r.snap, hits);
    check('HUD 命中数 == filterSnapshot 大小', r.hud, r.snap);
    check('HUD 总数 == 12', r.hudTotal, 12);
    check('星表 .sm-star 总数 == filterSnapshot 大小', r.stars, r.snap);
    check('筛选状态条命中数 == filterSnapshot 大小（无筛选时隐藏）', r.status, r.active ? r.snap : null);
  };
  await page.evaluate(() => selectView('map'));
  await page.waitForTimeout(300);
  await assertStarmap('无筛选', 12);
  await page.evaluate(() => { state.tagFilter = new Set(['alpha']); applyFilterChange(); });
  await page.waitForTimeout(200);
  await assertStarmap('标签 alpha', 4);
  await page.evaluate(() => { state.onlyUnread = true; els.onlyUnread.checked = true; applyFilterChange(); });
  await page.waitForTimeout(200);
  await assertStarmap('标签 alpha + 仅未读', 2);
  await page.evaluate(() => { state.tagFilter = new Set(); applyFilterChange(); });
  await page.waitForTimeout(200);
  await assertStarmap('仅未读', 8);
  await page.evaluate(() => { state.onlyUnread = false; els.onlyUnread.checked = false; applyFilterChange(); });
  await page.fill('#search', 'p2').catch(async () => {
    await page.evaluate(() => { els.search.value = 'p2'; els.search.dispatchEvent(new Event('input', { bubbles: true })); });
  });
  await page.waitForTimeout(700);
  await assertStarmap('搜索 p2', 4);
  await page.evaluate(() => { els.search.value = ''; els.search.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(500);
  await assertStarmap('清除后', 12);
  await page.evaluate(() => setTimeRange(AtlasRiver.presetRange(24, Date.now())));
  await page.waitForTimeout(200);
  await assertStarmap('时间段「24 小时」', 8);
  await page.evaluate(() => { state.tagFilter = new Set(['alpha']); applyFilterChange(); });
  await page.waitForTimeout(200);
  await assertStarmap('时间段 + 标签 alpha', 2);
  check('星图筛选状态条列出时间段', await page.evaluate(() => /⏱ \d+\/\d+ \d{2}:00–现在/.test(document.getElementById('starmap-filter-status').textContent)), true);
  await page.evaluate(() => { state.tagFilter = new Set(); setTimeRange(null, { render: false }); applyFilterChange(); });
  await page.waitForTimeout(200);
  await assertStarmap('时间段清除后', 12);

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
