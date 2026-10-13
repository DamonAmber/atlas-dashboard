// 时间河流（design §3d「可测性」Playwright 段）：首页 #home-river 的 168 根柱、键盘刷选与时间段筛选、
// 预设与「清除」、首页「该时段改动的文档」、开放区间接住新文件、Atlas 自写 / 重命名不改总数也不轻闪，
// 以及三处总数（#home-river-meta / 读数「近 7 天改动」/ #home-river-sum）是同一个数。
// fixture 的 mtime 用 fs.utimesSync 散布到 7 天里（实例起来后再改：watcher 把每次 utimes 记成一条 c 事件）。
const fs = require('fs');
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const HOUR = 3_600_000;
const N = 12;
const FILES = {};
const RELS = [];
for (let i = 0; i < N; i++) {
  const rel = `p${(i % 3) + 1}/doc-${String(i).padStart(2, '0')}.md`;
  RELS.push(rel);
  FILES[rel] = `# 文档 ${i}\n\n正文。\n`;
}

(async () => {
  const atlas = await startAtlas({ prefix: 'atlas-time-river-', files: FILES });
  await sleep(600);   // 等 watcher 盘点完成，之后的 utimes 都按 change 记
  // 每篇落在不同的小时里：i 篇在 (11i + 1) 小时 10 分钟前（1.2h … 122.2h）
  const now0 = Date.now();
  const mtimes = {};
  RELS.forEach((rel, i) => {
    const t = now0 - (11 * i + 1) * HOUR - 10 * 60_000;
    fs.utimesSync(atlas.filePath(rel), new Date(t), new Date(t));
    mtimes[atlas.filePath(rel)] = Math.floor(t / 1000) * 1000;
  });
  await sleep(1500);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(atlas.base);
  await page.waitForSelector('#tree .file');
  await page.waitForFunction(() => riverState.log !== undefined && !riverState.loading);
  await page.waitForTimeout(200);

  const read = () => page.evaluate(() => {
    const metaText = document.getElementById('home-river-meta').textContent;
    const sumText = document.getElementById('home-river-sum').textContent;
    const cell = document.querySelector('#home-readouts .home-readout.is-signal');
    const tc = document.getElementById('tree-count').textContent.trim();
    return {
      bars: document.querySelectorAll('#home-river rect.bar').length,
      barsWithCount: document.querySelectorAll('#home-river rect.bar:not([data-c="0"])').length,
      meta: Number((metaText.match(/^(\d+) 次改动/) || [])[1] || (metaText.includes('没有改动') ? 0 : NaN)),
      metaText,
      readout: cell ? Number(cell.querySelector('.home-readout-v').textContent.replace(/,/g, '')) : null,
      readoutK: cell ? cell.querySelector('.home-readout-k').textContent : null,
      sum: Number((sumText.match(/共 (\d+) 次改动/) || [])[1] || (sumText.includes('没有改动') ? 0 : NaN)),
      treeRows: document.querySelectorAll('#tree .file').length,
      treeCount: tc,
      chipVisible: !document.getElementById('time-filter-chip').classList.contains('hidden'),
      chipText: document.getElementById('time-filter-chip').textContent.trim(),
      feedTitle: document.getElementById('home-feed-title').textContent.trim(),
      feedAllVisible: !document.getElementById('home-feed-all').classList.contains('hidden'),
      gridCards: document.querySelectorAll('#home-grid .cover-card').length,
      note: document.getElementById('tree-filter-note').classList.contains('hidden') ? null : document.getElementById('tree-filter-note').textContent.trim(),
      active: filterSnapshot().active,
      snap: filterSnapshot().size,
      range: state.timeRange,
    };
  });
  const assertTotals = (r, label) => {
    check(`${label}：#home-river-meta 的 N == 读数「近 7 天改动」== #home-river-sum 的总数`, [r.meta, r.readout, r.sum], [r.meta, r.meta, r.meta]);
  };

  console.log('\n[初始渲染]');
  let r = await read();
  check('168 根柱', r.bars, 168);
  check(`有计数的柱 = ${N}（每篇一个不同的小时）`, r.barsWithCount, N);
  check(`河流总数 = ${N}`, r.meta, N);
  assertTotals(r, '初始');
  check('读数「近 7 天改动」没有「仅修改时间」标签（日志可用）', r.readoutK.includes('仅修改时间'), false);
  check('河流头统计文案「N 次改动 · 最忙 M/D HH:00（m 次）」', /^\d+ 次改动 · 最忙 \d{1,2}\/\d{1,2} \d{2}:00（\d+ 次）$/.test(r.metaText), true);
  check('#home-river 是 role=group，aria-describedby 指向摘要', await page.evaluate(() => {
    const el = document.getElementById('home-river');
    return [el.getAttribute('role'), el.getAttribute('aria-label'), el.getAttribute('aria-describedby')];
  }), ['group', '过去 7 天的改动时间轴', 'home-river-sum']);
  check('每根柱带 <title>「M 月 D 日 HH:00–HH:00 · n 次改动 · m 篇」', await page.evaluate(() => {
    const t = document.querySelector('#home-river rect.bar:not([data-c="0"]) title');
    return !!t && /^\d{1,2} 月 \d{1,2} 日 \d{2}:00–\d{2}:00 · 1 次改动 · 1 篇/.test(t.textContent);
  }), true);
  check('无时间筛选：#home-grid 标题仍是「待看」、没有「在侧栏中列出全部」', [r.feedTitle, r.feedAllVisible], ['待看', false]);
  check('#time-filter-chip 隐藏', r.chipVisible, false);
  check('#home-pulse 已删除', await page.$('#home-pulse'), null);

  // ---------- 键盘刷选 ----------
  console.log('\n[键盘刷选]');
  const expectIn = (a, b) => page.evaluate(({ a, b, mtimes }) => {
    const ws = AtlasRiver.windowStart(Date.now());
    const from = ws + a * 3_600_000;
    const to = b >= 168 ? Infinity : ws + b * 3_600_000;
    return Object.values(mtimes).filter(t => t >= from && t < to).length;
  }, { a, b, mtimes });
  await page.focus('#river-start');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');   // 起点 → 120（近 48 小时）
  await page.waitForTimeout(150);
  r = await read();
  let want = await expectIn(120, 168);
  check('起点手柄 aria-valuenow = 120', await page.getAttribute('#river-start', 'aria-valuenow'), '120');
  check('aria-valuetext 形如「10月3日 周四 14:00」', /^\d{1,2}月\d{1,2}日 周[日一二三四五六] \d{2}:00$/.test(await page.getAttribute('#river-start', 'aria-valuetext')), true);
  check('右手柄在 168 → to === null（开放到现在）', r.range && r.range.to, null);
  check(`#tree .file 数 == 区间内文档数（${want}）`, r.treeRows, want);
  check('#time-filter-chip 可见、写明时段', [r.chipVisible, /^⏱ \d+\/\d+ \d{2}:00–现在 ✕$/.test(r.chipText)], [true, true]);
  check('#tree-count 显示「命中 / 总数」', r.treeCount, `${want}/${N}`);
  check('树顶提示列出时间段', /时间段 \d+\/\d+ \d{2}:00–现在/.test(r.note || ''), true);
  await page.focus('#river-end');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');            // 终点 → 165
  await page.waitForTimeout(150);
  r = await read();
  want = await expectIn(120, 165);
  check('终点手柄 aria-valuenow = 165、to 为数字', [await page.getAttribute('#river-end', 'aria-valuenow'), typeof (r.range && r.range.to)], ['165', 'number']);
  check(`#tree .file 数 == 区间内文档数（${want}）`, r.treeRows, want);
  check(`#home-grid 标题「M/D HH:00 – M/D HH:00 改动了 ${want} 篇」`,
    new RegExp(`^\\d+/\\d+ \\d{2}:00 – \\d+/\\d+ \\d{2}:00 改动了 ${want} 篇$`).test(r.feedTitle), true);
  check('「在侧栏中列出全部」按钮出现、封面 = 命中数（≤8）', [r.feedAllVisible, r.gridCards], [true, Math.min(8, want)]);
  check('首页封面按区间内最后一次事件倒序', await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#home-grid .cover-card')].map(c => state.timeRangeLatest.get(c.dataset.path));
    return ps.every((t, i) => i === 0 || ps[i - 1] >= t);
  }), true);
  check('选区可见、区间外的柱淡化', await page.evaluate(() => [
    !document.getElementById('river-sel').classList.contains('hidden'),
    document.querySelectorAll('#home-river rect.bar.dim').length,
  ]), [true, 168 - 45]);
  check('时间段筛选下总数不变（河流统计全量）', (await read()).meta, N);

  // ---------- 清除 ----------
  console.log('\n[清除]');
  await page.click('[data-river-preset="clear"]');
  await page.waitForTimeout(150);
  r = await read();
  check('「清除」后：无筛选、chip 隐藏、#tree-count 回到总数', [r.active, r.chipVisible, r.treeCount, r.range], [false, false, String(N), null]);
  check('「清除」后 #home-grid 回到「待看」', [r.feedTitle, r.feedAllVisible], ['待看', false]);
  // Esc：首页、有时间筛选 → 清除
  await page.focus('#river-start');
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(100);
  check('Shift+→ 一天：起点 = 24', await page.getAttribute('#river-start', 'aria-valuenow'), '24');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('首页按 Esc 清除时间筛选', (await read()).range, null);
  // 双击清除
  await page.click('[data-river-preset="72"]');
  await page.waitForTimeout(100);
  check('「3 天」预设 = 当前整点 - 71h、开放到现在、按下态', await page.evaluate(() => [
    state.timeRange.from === AtlasRiver.floorHour(Date.now()) - 71 * 3_600_000, state.timeRange.to,
    document.querySelector('[data-river-preset="72"]').getAttribute('aria-pressed'),
  ]), [true, null, 'true']);
  await page.dblclick('#home-river', { position: { x: 300, y: 60 } });
  await page.waitForTimeout(150);
  check('双击河流清除', (await read()).range, null);
  // 单击一根柱选中这一小时
  const box = await page.locator('#home-river').boundingBox();
  await page.mouse.click(box.x + box.width * (166.5 / 168), box.y + box.height / 2);
  await page.waitForTimeout(150);
  check('单击一根柱 = 选中这一小时（[166, 167)）', await page.evaluate(() => AtlasRiver.handlesFromRange(state.timeRange, AtlasRiver.windowStart(Date.now()))), [166, 167]);
  // 拖动吸附整点
  await page.mouse.move(box.x + box.width * (100.3 / 168), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (130.6 / 168), box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  check('拖动选出一段（吸附到整点）', await page.evaluate(() => AtlasRiver.handlesFromRange(state.timeRange, AtlasRiver.windowStart(Date.now()))), [100, 131]);
  await page.click('[data-river-preset="clear"]');

  // ---------- 「24 小时」预设接住新文件 ----------
  console.log('\n[「24 小时」预设 + 新文件]');
  await page.click('[data-river-preset="24"]');
  await page.waitForTimeout(150);
  r = await read();
  want = await expectIn(144, 168);   // 「24 小时」= 当前整点 - 23h = 手柄 144
  check(`「24 小时」预设后 #tree 只剩近 24 小时的（${want}）`, r.treeRows, want);
  const newPath = atlas.filePath('p1/fresh-new.md');
  fs.writeFileSync(newPath, '# 新文档\n');
  await page.waitForFunction((p) => !!document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`), newPath, { timeout: 8000 }).catch(() => {});
  r = await read();
  check('to === null：新写的文件出现在 #tree', await page.evaluate((p) => !!document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`), newPath), true);
  check('…且计入河流总数', r.meta, N + 1);
  assertTotals(r, '新文件后');
  await page.click('#time-filter-chip');
  await page.waitForTimeout(150);
  check('点 #time-filter-chip 清除', (await read()).range, null);

  // ---------- Atlas 自写：总数不变、不轻闪 ----------
  console.log('\n[/api/save-md 自写]');
  const before = await read();
  const target = atlas.filePath(RELS[3]);
  const saved = await page.evaluate(async (p) => {
    const res = await fetch('/api/save-md', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p, content: '# 改过\n\n用户在 Atlas 里保存。\n' }) });
    return res.status;
  }, target);
  check('/api/save-md 成功', saved, 200);
  await page.waitForFunction((p) => state.files[p] && state.files[p].mtime > Date.now() - 60_000, target, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  r = await read();
  check('保存后河流总数与「近 7 天改动」都不变', [r.meta, r.readout], [before.meta, before.readout]);
  check('该行没有 .just-changed', await page.evaluate((p) => {
    const el = document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`);
    return !!el && !el.classList.contains('just-changed');
  }, target), true);
  await page.evaluate(async () => { lastStateSig = null; await fetchState(); await loadActivity(); });
  await page.waitForTimeout(200);
  r = await read();
  check('强制 fetchState() + 重拉 /api/activity 后仍不变（兜底被 kind 2 标记压住）', [r.meta, r.readout], [before.meta, before.readout]);
  assertTotals(r, '自写后');

  // ---------- 重命名：不轻闪 ----------
  console.log('\n[重命名]');
  const oldP = atlas.filePath(RELS[5]);
  const newP = atlas.filePath(RELS[5].replace('.md', '-renamed.md'));
  const ren = await page.evaluate(async ({ p, name }) => {
    const res = await fetch('/api/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p, name }) });
    return res.status;
  }, { p: oldP, name: RELS[5].split('/')[1].replace('.md', '-renamed.md') });
  check('/api/rename 成功', ren, 200);
  await page.waitForFunction((p) => !!document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`), newP, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  check('重命名后的行与封面没有 .just-changed', await page.evaluate((p) => {
    const sel = `[data-path="${CSS.escape(p)}"]`;
    const row = document.querySelector('#tree .file' + sel);
    const cover = document.querySelector('.cover-card' + sel);
    return [!!row, !!row && row.classList.contains('just-changed'), !!cover && cover.classList.contains('just-changed')];
  }, newP), [true, false, false]);
  r = await read();
  check('重命名后总数不变（旧路径的事件由新路径的 a 接替）', r.meta, before.meta);
  assertTotals(r, '重命名后');

  // ---------- 日志不可用：退化为只用修改时间 ----------
  console.log('\n[活动日志不可用]');
  await page.route('**/api/activity*', route => route.fulfill({ status: 500, body: '{}' }));
  await page.evaluate(async () => { riverState.log = undefined; riverState.ver++; await loadActivity(); });
  await page.waitForTimeout(150);
  r = await read();
  check('失败 → 三处按修改时间兜底，仍是同一个数', [r.meta, r.readout, r.sum], [N + 1, N + 1, N + 1]);
  check('读数格带「仅修改时间」标签、河流显示一行说明', [r.readoutK.includes('仅修改时间'),
    await page.evaluate(() => !document.getElementById('home-river-note').classList.contains('hidden'))], [true, true]);
  await page.unroute('**/api/activity*');

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
