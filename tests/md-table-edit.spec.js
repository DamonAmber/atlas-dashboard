// Markdown 编辑：在右侧预览区直接编辑表格（改单元格 + 拖动整行重排），同步回左侧源码
//
// 钉住的行为：
//   ① 编辑态每行出现拖拽抓手（.md-row-grip），表头也有对齐占位；抓手不写进源码
//   ② 直接改单元格文字 → 源码同步更新，表格其余部分（表头 / 列数）保持
//   ③ 单元格里输入的竖线 | 被转义成 \|（否则会凭空多切一列、整表错位）
//   ④ 拖动整行到别处 → 源码里数据行顺序随之改变，表头与对齐行不动
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

const MD = [
  '# 表格编辑',
  '',
  '| 名称 | 值 |',
  '|------|----|',
  '| 甲 | 1 |',
  '| 乙 | 2 |',
  '| 丙 | 3 |',
  '',
  '正文段落。',
  '',
].join('\n');

// 模拟在某个单元格里改写文字（走真实的 beforeinput/input 事件链）
async function editCell(page, rowSel, newText) {
  await page.evaluate(({ rowSel, newText }) => {
    const pv = document.getElementById('md-preview');
    const cell = pv.querySelector(rowSel);
    const r = document.createRange(); r.selectNodeContents(cell);
    const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
    pv.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));
    cell.textContent = newText;
    pv.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, { rowSel, newText });
  await page.waitForTimeout(250);   // 等 rAF 反解析
}

(async () => {
  const atlas = await startAtlas({ prefix: 'atlas-tbledit-', files: { 'proj/t.md': MD } });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(atlas.base);
  await page.waitForSelector('.file');
  await page.click('.file[data-doctype="md"] .file-name');
  await page.waitForTimeout(1200);
  await page.click('#btn-edit');
  await page.waitForSelector('#md-editor:not(.hidden)');
  await page.waitForTimeout(300);

  // ① 抓手就位
  console.log('\n[拖拽抓手]');
  const grips = await page.evaluate(() => {
    const pv = document.getElementById('md-preview');
    const table = pv.querySelector('table');
    return {
      bodyGrips: table.querySelectorAll('tbody tr .md-row-grip').length,
      headGrip: table.querySelectorAll('thead tr .md-row-grip-head').length,
      gripNotEditable: [...table.querySelectorAll('.md-row-grip')].every(g => g.getAttribute('contenteditable') === 'false'),
    };
  });
  check('每个数据行都有拖拽抓手', grips.bodyGrips, 3);
  check('表头有对齐占位抓手', grips.headGrip, 1);
  check('抓手本身不可编辑', grips.gripNotEditable, true);

  // ② 改单元格文字 → 源码同步
  console.log('\n[改单元格]');
  await editCell(page, 'tbody tr:nth-child(1) td:not(.md-row-grip)', '甲改');
  let src = await page.inputValue('#md-source');
  check('单元格改动同步到源码', /\|\s*甲改\s*\|\s*1\s*\|/.test(src), true);
  check('表头保留', /\|\s*名称\s*\|\s*值\s*\|/.test(src), true);
  check('抓手没有被写进源码（无 svg / 空首列）', !/md-row-grip|<svg|\|\s*\|\s*名称/.test(src) && !/^\|\s*\|/m.test(src), true);
  check('列数没变（每数据行两列）', (src.match(/^\| .* \| .* \|$/gm) || []).length >= 4, true);

  // ③ 单元格里的竖线被转义
  console.log('\n[竖线转义]');
  await editCell(page, 'tbody tr:nth-child(2) td:not(.md-row-grip)', 'x|y');
  src = await page.inputValue('#md-source');
  check('单元格里的 | 被转义成 \\|', src.includes('x\\|y'), true);
  check('表格没有因为这个 | 多切出一列错位', !/x\s*\|\s*y/.test(src.replace('x\\|y', '')), true);

  // ④ 拖动整行重排
  console.log('\n[拖行重排]');
  // 先把改过的还原成可辨识的行内容，聚焦顺序
  const gripBox = async (n) => page.locator(`#md-preview tbody tr:nth-child(${n}) .md-row-grip`).boundingBox();
  const g3 = await gripBox(3);   // 第 3 行（丙）
  const g1 = await gripBox(1);   // 第 1 行
  // 把第 3 行拖到第 1 行上方
  await page.mouse.move(g3.x + g3.width / 2, g3.y + g3.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.move(g1.x + g1.width / 2, g1.y - 4, { steps: 20 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(300);
  src = await page.inputValue('#md-source');
  // 丙行现在应排在甲改行之前
  const dataLines = src.split('\n').filter(l => /^\|/.test(l) && !/---/.test(l) && !/名称/.test(l));
  check('拖动后「丙」行排到了最前', /丙/.test(dataLines[0]), true);
  check('表头与对齐行仍在表格顶部',
    (() => { const ls = src.split('\n').filter(l => /^\|/.test(l)); return /名称/.test(ls[0]) && /---/.test(ls[1]); })(), true);

  check('全程无 JS 报错', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
