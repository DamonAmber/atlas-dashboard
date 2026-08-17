// 源码 ↔ 预览 的对应区域高亮
//
// 编辑 Markdown 时，光标 / 选区落在一边，另一边要同步标出对应内容。
// 映射靠渲染时写在每个顶层块上的 data-md-line / data-md-endline（1 基闭区间）。
//
// 本 spec 检查：
//   ① 行号映射本身正确（含 front matter 造成的整体偏移）
//   ② 源码 → 预览：光标所在块标 active；跨块选区把覆盖到的块全标 selected
//   ③ 预览 → 源码：点/选预览块时，源码侧画出对应行的色带，位置与该行对齐
//   ④ 色带随源码滚动一起移动
//   ⑤ 编辑内容后映射跟着更新；退出编辑后标记清干净
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');
const markdown = require(path.join(ROOT, 'public/vendor/markdown.js'));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

// 行号可预测的 fixture。注意故意让 ## 小节 紧跟正文（无空行）
const LINES = [
  '---',            // 1
  'title: T',       // 2
  '---',            // 3
  '',               // 4
  '# 一级标题',      // 5
  '',               // 6
  '段落甲。',        // 7
  '',               // 8
  '- 列表一',        // 9
  '- 列表二',        // 10
  '',               // 11
  '## 小节',         // 12
  '段落乙紧跟标题。', // 13
  '',               // 14
  '最后一段。',      // 15
];
const MD = LINES.join('\n');

(async () => {
  // ---- ① 行号映射（纯函数）----
  console.log('\n[行号映射]');
  const html = markdown.renderBody(MD, { annotateRaw: true });
  const map = [];
  const re = /data-md-line="(\d+)" data-md-endline="(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) map.push([+m[1], +m[2]]);
  check('块的行范围逐一正确', map, [[1, 3], [5, 5], [7, 7], [9, 10], [12, 12], [13, 13], [15, 15]]);
  check('front matter 偏移已计入（正文首块从第 5 行起）', map[1][0], 5);

  const noFm = markdown.renderBody('# T\n\n正文\n', { annotateRaw: true });
  const map2 = [...noFm.matchAll(/data-md-line="(\d+)" data-md-endline="(\d+)"/g)]
    .map(x => [+x[1], +x[2]]);
  check('没有 front matter 时行号从 1 开始', map2, [[1, 1], [3, 3]]);

  // ---- 起实例做交互 ----
  const atlas = await startAtlas({ prefix: 'atlas-mdsync-', files: { 'proj/note.md': MD } });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(atlas.base);
  await page.waitForSelector('.file');
  await page.click('.file[data-doctype="md"] .file-name');
  await page.waitForTimeout(900);
  await page.click('#btn-edit');
  await page.waitForSelector('#md-editor:not(.hidden)');

  // 把光标放到某一行（1 基），可选选到另一行末
  const putCaret = (startLine, endLine) => page.evaluate(({ s, e }) => {
    const ta = document.getElementById('md-source');
    const starts = [0];
    for (let i = 0; i < ta.value.length; i++) if (ta.value.charCodeAt(i) === 10) starts.push(i + 1);
    const so = starts[s - 1];
    let eo;
    if (e == null) eo = so;
    else eo = (e < starts.length) ? starts[e] - 1 : ta.value.length;
    ta.focus();
    ta.setSelectionRange(so, eo);
    document.dispatchEvent(new Event('selectionchange'));
  }, { s: startLine, e: endLine });

  const marked = () => page.evaluate(() => ({
    active: [...document.querySelectorAll('#md-preview > .md-sync-active')]
      .map(el => el.getAttribute('data-md-line') + '..' + el.getAttribute('data-md-endline')),
    selected: [...document.querySelectorAll('#md-preview > .md-sync-selected')]
      .map(el => el.getAttribute('data-md-line') + '..' + el.getAttribute('data-md-endline')),
  }));

  // ---- ② 源码 → 预览 ----
  console.log('\n[源码 → 预览]');
  await putCaret(7);
  await page.waitForTimeout(200);
  check('光标在第 7 行 → 只标该段落为 active', await marked(), { active: ['7..7'], selected: [] });

  await putCaret(10);
  await page.waitForTimeout(200);
  check('光标在列表第二项（第 10 行）→ 标整个列表块（9..10）',
    await marked(), { active: ['9..10'], selected: [] });

  await putCaret(2);
  await page.waitForTimeout(200);
  check('光标在 front matter 里 → 标 front matter 块',
    await marked(), { active: ['1..3'], selected: [] });

  await putCaret(12);
  await page.waitForTimeout(200);
  check('光标在 ## 小节（第 12 行）→ 只标标题，不误标紧跟的段落',
    await marked(), { active: ['12..12'], selected: [] });

  await putCaret(9, 13);
  await page.waitForTimeout(200);
  const sel = await marked();
  check('跨块选区（9~13 行）→ 覆盖到的块全标 selected',
    sel.selected, ['9..10', '12..12', '13..13']);
  check('跨块选区时不再有 active 标记', sel.active, []);

  await putCaret(5, 15);
  await page.waitForTimeout(200);
  check('全选式选区 → 除 front matter 外全部标上',
    (await marked()).selected, ['5..5', '7..7', '9..10', '12..12', '13..13', '15..15']);

  // ---- ③ 预览 → 源码 ----
  console.log('\n[预览 → 源码]');
  const clickPreviewBlock = (line) => page.evaluate((l) => {
    const el = document.querySelector(`#md-preview > [data-md-line="${l}"]`);
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    el.focus();
    document.dispatchEvent(new Event('selectionchange'));
  }, line);

  await clickPreviewBlock(7);
  await page.waitForTimeout(250);
  const bands = await page.evaluate(() => [...document.querySelectorAll('.md-source-band')]
    .map(b => ({ top: parseFloat(b.style.top), height: parseFloat(b.style.height), active: b.classList.contains('active') })));
  check('源码侧画出了 1 条色带', bands.length, 1);
  check('色带是 active 强度（光标而非选区）', bands[0] && bands[0].active, true);
  check('预览侧对应块也标了 active', (await marked()).active, ['7..7']);

  // 色带位置应与第 7 行对齐：拿 textarea 的行高推算期望 top
  const geom = await page.evaluate(() => {
    const ta = document.getElementById('md-source');
    const cs = getComputedStyle(ta);
    return {
      lineHeight: parseFloat(cs.lineHeight),
      padTop: parseFloat(cs.paddingTop),
      band: parseFloat(document.querySelector('.md-source-band').style.top),
      bandH: parseFloat(document.querySelector('.md-source-band').style.height),
    };
  });
  const expectedTop = geom.padTop + geom.lineHeight * 6;   // 第 7 行 → 前面 6 行
  const drift = Math.abs(geom.band - expectedTop);
  check(`色带与第 7 行对齐（偏差 ${drift.toFixed(1)}px ≤ 2px）`, drift <= 2, true);
  check('色带高度约等于一行', Math.abs(geom.bandH - geom.lineHeight) <= 2, true);

  // 选中预览里的两个块 → 源码侧应画出覆盖这些行的色带
  await page.evaluate(() => {
    const a = document.querySelector('#md-preview > [data-md-line="9"]');
    const b = document.querySelector('#md-preview > [data-md-line="12"]');
    const r = document.createRange();
    r.setStartBefore(a);
    r.setEndAfter(b);
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForTimeout(250);
  const rangeBands = await page.evaluate(() => [...document.querySelectorAll('.md-source-band')]
    .map(b => ({ top: parseFloat(b.style.top), h: parseFloat(b.style.height), active: b.classList.contains('active') })));
  check('跨块选区在源码侧也画出色带', rangeBands.length > 0, true);
  check('跨块选区用 selected 强度（非 active）', rangeBands.every(b => !b.active), true);
  const totalH = rangeBands.reduce((a, b) => a + b.h, 0);
  check('色带总高覆盖 9~12 共 4 行',
    Math.abs(totalH - geom.lineHeight * 4) <= 3, true);
  check('预览侧对应块标 selected',
    (await marked()).selected, ['9..10', '12..12']);

  // ---- ④ 色带随滚动移动 ----
  console.log('\n[色带跟随滚动]');
  await page.evaluate(() => {
    const ta = document.getElementById('md-source');
    ta.value = ta.value + '\n' + Array.from({ length: 120 }, (_, i) => '填充行 ' + i).join('\n');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(350);
  await clickPreviewBlock(7);
  await page.waitForTimeout(250);
  const before = await page.evaluate(() =>
    document.querySelector('.md-source-hl-inner').style.transform);
  await page.evaluate(() => { document.getElementById('md-source').scrollTop = 300; });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() =>
    document.querySelector('.md-source-hl-inner').style.transform);
  check('滚动前 transform 是 0', /translateY\(0px\)|translateY\(-0px\)/.test(before), true);
  check('滚动后色带整体上移 300px', after, 'translateY(-300px)');

  // ---- ⑤ 内容变化后映射更新 ----
  console.log('\n[编辑后映射更新]');
  await page.evaluate(() => {
    const ta = document.getElementById('md-source');
    ta.value = '# 新标题\n\n新正文。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(350);
  await putCaret(3);
  await page.waitForTimeout(250);
  check('改完内容后光标在第 3 行 → 标新正文块',
    await marked(), { active: ['3..3'], selected: [] });

  // ---- 退出编辑后清干净 ----
  await page.evaluate(() => document.getElementById('btn-edit-cancel').click());
  await page.waitForTimeout(300);
  if (await page.$('.atlas-dialog')) {
    await page.click('.atlas-dialog .dialog-confirm');
    await page.waitForTimeout(400);
  }
  check('退出编辑后预览侧标记已清',
    await page.evaluate(() => document.querySelectorAll('.md-sync-active, .md-sync-selected').length), 0);
  check('退出编辑后源码色带已清',
    await page.evaluate(() => document.querySelectorAll('.md-source-band').length), 0);

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
